/**
 * Productivity Sidekick — "The Brain" (Cloudflare Worker)
 * Epic 31-32: Two-Site, One-Brain Architecture
 *
 * A standalone Cloudflare Worker that serves as the shared API
 * for both Site A (Strategic OS) and Site B (Admin Dashboard).
 *
 * KEY DESIGN: Column Abstraction Layer
 *   The worker checks global_config.schema_version to decide
 *   whether to use legacy column names (v1) or new names (v2).
 *   This allows the admin portal to trigger migration when ready.
 *
 * Environment Bindings (wrangler.toml):
 *   DB              — D1 database (sidekick-db)
 *   SESSION_SECRET  — HMAC signing key for session tokens
 *   BETA_CODE       — Registration gate code
 *   ADMIN_API_KEY   — Bearer token for Admin Dashboard routes
 *   ALLOWED_ORIGINS — Comma-separated allowed origins
 */

// ============================================================
// COLUMN ABSTRACTION LAYER
// ============================================================
// Pre-migration (v1): uses the original snake_case column names
// that the existing [[path]].js and live database use.
// Post-migration (v2): uses the new camelCase column names.
// Migration is triggered via POST /api/admin/migrate.

const COLUMNS = {
    v1: {
        authKeyHash:   'auth_key_hash',
        recoveryBlob:  'recovery_blob',
        ciphertext:    'encrypted_data',
    },
    v2: {
        authKeyHash:   'authKeyHash',
        recoveryBlob:  'recoveryBlob',
        ciphertext:    'ciphertext',
    },
};

// Per-isolate cache — avoids a DB read on every request.
let cachedSchemaVersion = null;

async function getSchemaVersion(env) {
    if (cachedSchemaVersion) return cachedSchemaVersion;
    try {
        const row = await env.DB.prepare(
            "SELECT value_json FROM global_config WHERE key = 'schema_version'"
        ).first();
        cachedSchemaVersion = row ? JSON.parse(row.value_json) : 'v1';
    } catch {
        cachedSchemaVersion = 'v1';
    }
    return cachedSchemaVersion;
}

function col(version) {
    return COLUMNS[version] || COLUMNS.v1;
}

// ============================================================
// RATE LIMITING (per-isolate in-memory)
// ============================================================

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX = 30;

function checkRateLimit(ip) {
    const now = Date.now();
    let entry = rateLimitMap.get(ip);
    if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
        entry = { start: now, count: 1 };
        rateLimitMap.set(ip, entry);
        return true;
    }
    entry.count++;
    return entry.count <= RATE_LIMIT_MAX;
}

let cleanupCounter = 0;
function maybeCleanup() {
    if (++cleanupCounter % 100 !== 0) return;
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
        if (now - entry.start > RATE_LIMIT_WINDOW * 2) rateLimitMap.delete(ip);
    }
}

// ============================================================
// HMAC SESSION TOKENS
// ============================================================

const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const RECOVERY_TOKEN_EXPIRY_MS = 10 * 60 * 1000;

async function hmacSign(payload, secret) {
    const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacVerify(payload, sigHex, secret) {
    const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const sigBuf = new Uint8Array(sigHex.match(/.{2}/g).map(h => parseInt(h, 16)));
    return crypto.subtle.verify('HMAC', key, sigBuf, new TextEncoder().encode(payload));
}

async function createSessionToken(userId, secret) {
    const exp = Date.now() + TOKEN_EXPIRY_MS;
    const payload = `${userId}.${exp}`;
    return `${payload}.${await hmacSign(payload, secret)}`;
}

async function verifySessionToken(token, secret) {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [userId, expStr, sigHex] = parts;
    const exp = parseInt(expStr);
    if (isNaN(exp) || Date.now() > exp) return null;
    const valid = await hmacVerify(`${userId}.${expStr}`, sigHex, secret);
    return valid ? userId : null;
}

async function createRecoveryToken(userId, secret) {
    const exp = Date.now() + RECOVERY_TOKEN_EXPIRY_MS;
    const payload = `recover.${userId}.${exp}`;
    return `${payload}.${await hmacSign(payload, secret)}`;
}

async function verifyRecoveryToken(token, secret) {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 4) return null;
    const [prefix, userId, expStr, sigHex] = parts;
    if (prefix !== 'recover') return null;
    const exp = parseInt(expStr);
    if (isNaN(exp) || Date.now() > exp) return null;
    const valid = await hmacVerify(`recover.${userId}.${expStr}`, sigHex, secret);
    return valid ? userId : null;
}

// ============================================================
// HELPERS
// ============================================================

async function hashAuthKey(authKeyHex) {
    const buf = new TextEncoder().encode(authKeyHex);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status, headers: { 'Content-Type': 'application/json' },
    });
}

function errorResponse(message, status = 400) {
    return jsonResponse({ ok: false, error: message }, status);
}

function getAuthToken(request) {
    const auth = request.headers.get('Authorization');
    if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
    const cookie = request.headers.get('Cookie') || '';
    const match = cookie.match(/ps_session=([^;]+)/);
    return match ? match[1] : null;
}

// ============================================================
// CORS — Multi-Origin Support
// ============================================================

function getAllowedOrigins(env) {
    if (!env.ALLOWED_ORIGINS) return [];
    return env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean);
}

function getCorsHeaders(request, env) {
    const requestOrigin = request.headers.get('Origin') || '';
    const allowed = getAllowedOrigins(env);
    const origin = allowed.includes(requestOrigin) ? requestOrigin : '';
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
    };
}

function handlePreflight(request, env) {
    const corsHeaders = getCorsHeaders(request, env);
    if (!corsHeaders['Access-Control-Allow-Origin']) {
        return new Response('Origin not allowed', { status: 403 });
    }
    return new Response(null, { status: 204, headers: corsHeaders });
}

function withCors(response, request, env) {
    const corsHeaders = getCorsHeaders(request, env);
    const newHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders)) {
        if (value) newHeaders.set(key, value);
    }
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
    });
}

// ============================================================
// ADMIN AUTH GUARD
// ============================================================

function verifyAdminAuth(request, env) {
    const authHeader = request.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) return false;
    const token = authHeader.slice(7);
    if (!env.ADMIN_API_KEY || !token) return false;
    if (token.length !== env.ADMIN_API_KEY.length) return false;
    let mismatch = 0;
    for (let i = 0; i < token.length; i++) {
        mismatch |= token.charCodeAt(i) ^ env.ADMIN_API_KEY.charCodeAt(i);
    }
    return mismatch === 0;
}

// ============================================================
// ADMIN ROUTES (Site B — Protected)
// ============================================================

async function handleAdminGetUsers(env) {
    const { results } = await env.DB.prepare(
        'SELECT id, email, plan_tier, role, created_at FROM users ORDER BY created_at DESC'
    ).all();
    return jsonResponse({ ok: true, users: results || [] });
}

async function handleAdminGetFeedback(env) {
    const { results } = await env.DB.prepare(
        'SELECT id, email, type, message, created_at FROM feedback ORDER BY created_at DESC'
    ).all();
    return jsonResponse({ ok: true, feedback: results || [] });
}

async function handleAdminDeleteUser(request, env) {
    const body = await request.json();
    const { email } = body;
    if (!email) return errorResponse('Email is required');

    const emailClean = email.toLowerCase().trim();
    const user = await env.DB.prepare(
        'SELECT id FROM users WHERE email = ?'
    ).bind(emailClean).first();
    if (!user) return errorResponse('User not found', 404);

    await env.DB.prepare('DELETE FROM vaults WHERE user_id = ?').bind(user.id).run();
    await env.DB.prepare('DELETE FROM feedback WHERE email = ?').bind(emailClean).run();
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();

    return jsonResponse({ ok: true, deleted: emailClean });
}

async function handleAdminPutConfig(request, env) {
    const body = await request.json();
    const { key, value_json } = body;
    if (!key || value_json === undefined) return errorResponse('Both key and value_json are required');
    try { JSON.parse(value_json); } catch { return errorResponse('value_json must be valid JSON'); }

    await env.DB.prepare(`
        INSERT INTO global_config (key, value_json, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = CURRENT_TIMESTAMP
    `).bind(key, value_json).run();

    if (key === 'schema_version') cachedSchemaVersion = null;
    return jsonResponse({ ok: true, key });
}

/**
 * POST /api/admin/migrate
 * Renames legacy columns to new names and flips schema_version to v2.
 * Idempotent — safe to run multiple times.
 *
 * What changes: column NAMES only (auth_key_hash -> authKeyHash, etc.)
 * What does NOT change: data values, encryption keys, row counts
 */
async function handleAdminMigrate(env) {
    const sv = await getSchemaVersion(env);
    if (sv === 'v2') {
        return jsonResponse({ ok: true, message: 'Already migrated to v2', schema_version: 'v2' });
    }

    const results = [];
    const renames = [
        { table: 'users',  from: 'auth_key_hash',  to: 'authKeyHash' },
        { table: 'users',  from: 'recovery_blob',  to: 'recoveryBlob' },
        { table: 'vaults', from: 'encrypted_data',  to: 'ciphertext' },
    ];

    for (const r of renames) {
        try {
            await env.DB.prepare(
                `ALTER TABLE ${r.table} RENAME COLUMN ${r.from} TO ${r.to}`
            ).run();
            results.push(`OK: ${r.table}.${r.from} -> ${r.to}`);
        } catch (err) {
            results.push(`SKIP: ${r.table}.${r.from}: ${err.message}`);
        }
    }

    await env.DB.prepare(`
        INSERT INTO global_config (key, value_json, updated_at)
        VALUES ('schema_version', '"v2"', CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
            value_json = '"v2"',
            updated_at = CURRENT_TIMESTAMP
    `).run();
    results.push('OK: schema_version -> v2');

    cachedSchemaVersion = 'v2';
    return jsonResponse({ ok: true, schema_version: 'v2', steps: results });
}

// ============================================================
// PUBLIC ROUTES (Site A)
// ============================================================

async function handleGetConfig(env) {
    const { results } = await env.DB.prepare(
        'SELECT key, value_json FROM global_config'
    ).all();

    const config = {};
    (results || []).forEach(row => {
        try { config[row.key] = JSON.parse(row.value_json); }
        catch { config[row.key] = row.value_json; }
    });
    return jsonResponse({ ok: true, config });
}

async function handleRegister(request, env, c) {
    const body = await request.json();
    const { email, authKeyHex, recoveryBlob, betaCode } = body;

    if (!email || !authKeyHex || !recoveryBlob) return errorResponse('Missing required fields');

    const expectedCode = env.BETA_CODE || 'SIDEKICK-BETA';
    if (betaCode !== expectedCode) return errorResponse('Invalid beta access code.', 403);

    const emailClean = email.toLowerCase().trim();
    const authHash = await hashAuthKey(authKeyHex);

    const existing = await env.DB.prepare(
        'SELECT id FROM users WHERE email = ?'
    ).bind(emailClean).first();
    if (existing) return errorResponse('Account already exists for this email.', 409);

    const userId = crypto.randomUUID();
    const recoveryBlobJson = JSON.stringify(recoveryBlob);

    // Column names adapt to schema version via the abstraction layer
    await env.DB.prepare(
        `INSERT INTO users (id, email, ${c.authKeyHash}, ${c.recoveryBlob}) VALUES (?, ?, ?, ?)`
    ).bind(userId, emailClean, authHash, recoveryBlobJson).run();

    await env.DB.prepare(
        `INSERT INTO vaults (user_id, ${c.ciphertext}, iv, version) VALUES (?, ?, ?, 0)`
    ).bind(userId, '', '').run();

    const token = await createSessionToken(userId, env.SESSION_SECRET);
    return jsonResponse({ ok: true, userId, token }, 201);
}

async function handleLogin(request, env, c) {
    const body = await request.json();
    const { email, authKeyHex } = body;
    if (!email || !authKeyHex) return errorResponse('Missing required fields');

    const emailClean = email.toLowerCase().trim();
    const authHash = await hashAuthKey(authKeyHex);

    const user = await env.DB.prepare(
        `SELECT id, ${c.authKeyHash} FROM users WHERE email = ?`
    ).bind(emailClean).first();

    if (!user || user[c.authKeyHash] !== authHash) {
        return errorResponse('Invalid email or password.', 401);
    }

    const token = await createSessionToken(user.id, env.SESSION_SECRET);
    return jsonResponse({ ok: true, userId: user.id, token });
}

async function handleRecover(request, env, c) {
    const body = await request.json();
    const { email } = body;
    if (!email) return errorResponse('Email required');

    const emailClean = email.toLowerCase().trim();
    const user = await env.DB.prepare(
        `SELECT id, ${c.recoveryBlob} FROM users WHERE email = ?`
    ).bind(emailClean).first();
    if (!user) return errorResponse('Account not found', 404);

    let recoveryBlob;
    try { recoveryBlob = JSON.parse(user[c.recoveryBlob]); }
    catch { return errorResponse('Corrupted recovery data', 500); }

    const recoveryToken = await createRecoveryToken(user.id, env.SESSION_SECRET);
    return jsonResponse({ ok: true, recoveryBlob, recoveryToken });
}

async function handleUpdateAuth(request, env, c) {
    const body = await request.json();
    const { email, newAuthKeyHex, newRecoveryBlob, recoveryToken } = body;

    if (!email || !newAuthKeyHex || !newRecoveryBlob) return errorResponse('Missing required fields');
    if (!recoveryToken) return errorResponse('Recovery token required', 401);

    const emailClean = email.toLowerCase().trim();
    const tokenUserId = await verifyRecoveryToken(recoveryToken, env.SESSION_SECRET);
    if (!tokenUserId) return errorResponse('Invalid or expired recovery token', 401);

    const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(emailClean).first();
    if (!user || user.id !== tokenUserId) return errorResponse('Token does not match account', 403);

    const newAuthHash = await hashAuthKey(newAuthKeyHex);
    const recoveryBlobJson = JSON.stringify(newRecoveryBlob);

    await env.DB.prepare(
        `UPDATE users SET ${c.authKeyHash} = ?, ${c.recoveryBlob} = ?, updated_at = datetime('now') WHERE email = ?`
    ).bind(newAuthHash, recoveryBlobJson, emailClean).run();

    const token = await createSessionToken(user.id, env.SESSION_SECRET);
    return jsonResponse({ ok: true, token, userId: user.id });
}

async function handleDeleteAccount(request, env) {
    const token = getAuthToken(request);
    const userId = await verifySessionToken(token, env.SESSION_SECRET);
    if (!userId) return errorResponse('Unauthorized', 401);

    await env.DB.prepare('DELETE FROM vaults WHERE user_id = ?').bind(userId).run();
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
    return jsonResponse({ ok: true });
}

async function handleGetVault(request, env, c) {
    const token = getAuthToken(request);
    const userId = await verifySessionToken(token, env.SESSION_SECRET);
    if (!userId) return errorResponse('Unauthorized', 401);

    const vault = await env.DB.prepare(
        `SELECT ${c.ciphertext}, iv, version FROM vaults WHERE user_id = ?`
    ).bind(userId).first();

    if (!vault) return jsonResponse({ ok: true, vault: null, version: 0 });

    const ct = vault[c.ciphertext];
    if (!ct || ct === '') {
        return jsonResponse({ ok: true, vault: null, version: vault.version });
    }

    // API contract always uses "ciphertext" in the JSON response
    return jsonResponse({
        ok: true,
        vault: { ciphertext: ct, iv: vault.iv },
        version: vault.version,
    });
}

async function handlePutVault(request, env, c) {
    const token = getAuthToken(request);
    const userId = await verifySessionToken(token, env.SESSION_SECRET);
    if (!userId) return errorResponse('Unauthorized', 401);

    const body = await request.json();
    const { vault, expectedVersion } = body;
    if (!vault || vault.ciphertext === undefined || vault.iv === undefined) return errorResponse('Missing vault data');
    if (expectedVersion === undefined) return errorResponse('Missing expectedVersion');

    const current = await env.DB.prepare(
        'SELECT version FROM vaults WHERE user_id = ?'
    ).bind(userId).first();

    const currentVersion = current ? current.version : 0;
    if (currentVersion !== expectedVersion) {
        return jsonResponse({ ok: false, error: 'Version conflict', currentVersion }, 409);
    }

    const newVersion = expectedVersion + 1;
    if (current) {
        await env.DB.prepare(
            `UPDATE vaults SET ${c.ciphertext} = ?, iv = ?, version = ?, updated_at = datetime('now') WHERE user_id = ?`
        ).bind(vault.ciphertext, vault.iv, newVersion, userId).run();
    } else {
        await env.DB.prepare(
            `INSERT INTO vaults (user_id, ${c.ciphertext}, iv, version) VALUES (?, ?, ?, ?)`
        ).bind(userId, vault.ciphertext, vault.iv, newVersion).run();
    }
    return jsonResponse({ ok: true, version: newVersion });
}

async function handleFeedback(request, env) {
    const body = await request.json();
    const { type, message, email, timestamp, userAgent } = body;
    if (!message) return errorResponse('Message required');

    const id = crypto.randomUUID();
    await env.DB.prepare(
        'INSERT INTO feedback (id, email, type, message) VALUES (?, ?, ?, ?)'
    ).bind(id, email || 'anonymous', type || 'general', message).run();

    if (env.FEEDBACK_WEBHOOK) {
        try {
            await fetch(env.FEEDBACK_WEBHOOK, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: `**[${type?.toUpperCase()}]** from \`${email}\`\n${message}\n_${userAgent}_`,
                }),
            });
        } catch { /* Silent fail */ }
    }
    return jsonResponse({ ok: true, id });
}

async function handleFetchMeta(request) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) return errorResponse('Missing url parameter');

    let parsed;
    try { parsed = new URL(targetUrl); } catch { return errorResponse('Invalid URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return errorResponse('Only http/https allowed');

    const hostname = parsed.hostname.toLowerCase();
    const blocked = [/^localhost$/i, /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^\[::1?\]$/, /^169\.254\./, /^fc00:/i, /^fe80:/i, /^fd/i];
    if (blocked.some(p => p.test(hostname))) return errorResponse('Internal addresses not allowed', 403);

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(targetUrl, {
            signal: controller.signal,
            headers: { 'User-Agent': 'ProductivitySidekick/1.0', 'Accept': 'text/html' },
            redirect: 'follow',
        });
        clearTimeout(timeout);
        if (!resp.ok) return errorResponse(`Upstream ${resp.status}`, 502);

        const reader = resp.body.getReader();
        let html = '', bytes = 0;
        while (bytes < 65536) {
            const { done, value } = await reader.read();
            if (done) break;
            html += new TextDecoder().decode(value);
            bytes += value.length;
        }
        reader.cancel();

        let title = '';
        const tm = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        if (tm) title = tm[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');

        let favicon = '';
        const im = html.match(/<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']+)["'][^>]*>/i)
            || html.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["'](?:shortcut )?icon["'][^>]*>/i);
        if (im) {
            favicon = im[1];
            if (favicon.startsWith('/')) favicon = `${parsed.protocol}//${parsed.host}${favicon}`;
            else if (!favicon.startsWith('http')) favicon = `${parsed.protocol}//${parsed.host}/${favicon}`;
        } else {
            favicon = `${parsed.protocol}//${parsed.host}/favicon.ico`;
        }
        return jsonResponse({ title, favicon });
    } catch (err) {
        if (err.name === 'AbortError') return errorResponse('Timeout', 504);
        return errorResponse('Failed to fetch metadata', 502);
    }
}

// ============================================================
// ROUTER
// ============================================================

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        maybeCleanup();
        if (!checkRateLimit(ip)) {
            return withCors(errorResponse('Too many requests', 429), request, env);
        }

        if (method === 'OPTIONS') return handlePreflight(request, env);

        try {
            let response;

            // Resolve schema version + column names once per request
            const sv = await getSchemaVersion(env);
            const c = col(sv);

            // ==============================================
            // ADMIN ROUTES — /api/admin/*
            // ==============================================
            if (path.startsWith('/api/admin/')) {
                if (!verifyAdminAuth(request, env)) {
                    return withCors(errorResponse('Unauthorized', 401), request, env);
                }

                if      (path === '/api/admin/users'    && method === 'GET')    response = await handleAdminGetUsers(env);
                else if (path === '/api/admin/users'    && method === 'DELETE') response = await handleAdminDeleteUser(request, env);
                else if (path === '/api/admin/feedback' && method === 'GET')    response = await handleAdminGetFeedback(env);
                else if (path === '/api/admin/config'   && method === 'PUT')    response = await handleAdminPutConfig(request, env);
                else if (path === '/api/admin/migrate'  && method === 'POST')   response = await handleAdminMigrate(env);
                else response = errorResponse('Admin route not found', 404);

                return withCors(response, request, env);
            }

            // ==============================================
            // PUBLIC ROUTES — /api/*
            // ==============================================
            if      (path === '/api/config'         && method === 'GET')  response = await handleGetConfig(env);
            else if (path === '/api/auth/register'  && method === 'POST') response = await handleRegister(request, env, c);
            else if (path === '/api/auth/login'     && method === 'POST') response = await handleLogin(request, env, c);
            else if (path === '/api/auth/recover'   && method === 'POST') response = await handleRecover(request, env, c);
            else if (path === '/api/auth/update'    && method === 'POST') response = await handleUpdateAuth(request, env, c);
            else if (path === '/api/auth/delete'    && method === 'POST') response = await handleDeleteAccount(request, env);
            else if (path === '/api/vault'          && method === 'GET')  response = await handleGetVault(request, env, c);
            else if (path === '/api/vault'          && method === 'PUT')  response = await handlePutVault(request, env, c);
            else if (path === '/api/feedback'       && method === 'POST') response = await handleFeedback(request, env);
            else if (path === '/api/fetch-meta'     && method === 'GET')  response = await handleFetchMeta(request);
            else response = errorResponse('Not found', 404);

            return withCors(response, request, env);

        } catch (err) {
            console.error('Worker error:', err);
            return withCors(errorResponse('Internal server error', 500), request, env);
        }
    },
};
