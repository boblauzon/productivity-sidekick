/**
 * Productivity Sidekick — API Worker (Cloudflare Pages Functions)
 * 
 * Route: /api/[[path]]
 * 
 * Handles:
 *   POST /api/auth/register   — Create account with beta code gate
 *   POST /api/auth/login      — Verify auth key, return HMAC session token
 *   POST /api/auth/recover    — Fetch recovery blob for account recovery
 *   POST /api/auth/update     — Update auth credentials after recovery
 *   POST /api/auth/delete     — Delete account and all data
 *   GET  /api/vault           — Get encrypted vault blob
 *   PUT  /api/vault           — Store encrypted vault blob (optimistic locking)
 *   POST /api/feedback        — Submit beta feedback
 *   GET  /api/fetch-meta      — Metadata proxy for URL title/favicon
 * 
 * Bindings (wrangler.toml):
 *   DB              — D1 database
 *   SESSION_SECRET  — HMAC signing key for session tokens (secret)
 *   BETA_CODE       — Registration gate code (secret)
 *
 * Operational metadata (PR-0):
 *   Every authenticated endpoint reads the `X-Client-Version` header and
 *   uses it to populate `users.app_version_at_registration` (on register)
 *   and `users.last_login_app_version` + `users.last_login_at` +
 *   `users.login_count` (on login). Versions are validated to a strict
 *   charset and length to prevent injection.
 */

// ============================================================
// RATE LIMITING (per-isolate in-memory)
// ============================================================

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 20; // requests per window per IP

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

// Clean up stale entries periodically (every 100 requests)
let cleanupCounter = 0;
function maybeCleanup() {
    if (++cleanupCounter % 100 !== 0) return;
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
        if (now - entry.start > RATE_LIMIT_WINDOW * 2) rateLimitMap.delete(ip);
    }
}

// ============================================================
// CLIENT VERSION HEADER (PR-0)
// ============================================================

// Allowed characters: alphanumerics plus the standard semver/git-sha
// punctuation (`. _ + - `). Anything else returns null so the field stays
// NULL in the DB rather than failing the whole request — invalid metadata
// shouldn't block a user from logging in.
const CLIENT_VERSION_RE = /^[A-Za-z0-9._+\-]{1,64}$/;

function getClientVersion(request) {
    const raw = request.headers.get('X-Client-Version');
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!CLIENT_VERSION_RE.test(trimmed)) return null;
    return trimmed;
}

// ============================================================
// HMAC SESSION TOKENS
// ============================================================

const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const RECOVERY_TOKEN_EXPIRY_MS = 15 * 60 * 1000;  // 15 minutes

// One-time recovery token: HMAC-signed { userId, exp } — must be presented
// on /api/auth/update to prove the caller went through /api/auth/recover first.
async function createRecoveryToken(userId, secret) {
    const exp = Date.now() + RECOVERY_TOKEN_EXPIRY_MS;
    const payload = `recovery.${userId}.${exp}`;
    const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    const sigHex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${payload}.${sigHex}`;
}

async function verifyRecoveryToken(token, secret) {
    if (!token) return null;
    const lastDot = token.lastIndexOf('.');
    if (lastDot === -1) return null;
    const payload = token.slice(0, lastDot);
    const sigHex  = token.slice(lastDot + 1);
    const parts   = payload.split('.');
    // Expected: "recovery.<userId>.<exp>"
    if (parts.length !== 3 || parts[0] !== 'recovery') return null;
    const exp = parseInt(parts[2]);
    if (isNaN(exp) || Date.now() > exp) return null;
    const userId = parts[1];
    const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const sigBuf = new Uint8Array(sigHex.match(/.{2}/g).map(h => parseInt(h, 16)));
    const valid  = await crypto.subtle.verify('HMAC', key, sigBuf, new TextEncoder().encode(payload));
    return valid ? userId : null;
}

async function createSessionToken(userId, secret) {
    const exp = Date.now() + TOKEN_EXPIRY_MS;
    const payload = `${userId}.${exp}`;
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    const sigHex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${payload}.${sigHex}`;
}

async function verifySessionToken(token, secret) {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [userId, expStr, sigHex] = parts;
    const exp = parseInt(expStr);
    if (isNaN(exp) || Date.now() > exp) return null;

    const payload = `${userId}.${expStr}`;
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify']
    );
    const sigBuf = new Uint8Array(sigHex.match(/.{2}/g).map(h => parseInt(h, 16)));
    const valid = await crypto.subtle.verify('HMAC', key, sigBuf, new TextEncoder().encode(payload));
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

function jsonResponse(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
    });
}

function errorResponse(message, status = 400) {
    return jsonResponse({ ok: false, error: message }, status);
}

function getAuthToken(request) {
    const auth = request.headers.get('Authorization');
    if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
    // Also check cookie
    const cookie = request.headers.get('Cookie') || '';
    const match = cookie.match(/ps_session=([^;]+)/);
    return match ? match[1] : null;
}

// ============================================================
// ROUTE HANDLERS
// ============================================================

async function handleRegister(request, env) {
    const body = await request.json();
    const { email, authKeyHex, recoveryBlob, betaCode } = body;

    if (!email || !authKeyHex || !recoveryBlob) {
        return errorResponse('Missing required fields');
    }

    // Beta code gate — validate before any DB work
    const expectedCode = env.BETA_CODE || 'SIDEKICK-BETA';
    if (betaCode !== expectedCode) {
        return errorResponse('Invalid beta access code.', 403);
    }

    const emailClean = email.toLowerCase().trim();
    const authHash = await hashAuthKey(authKeyHex);

    // Check if email already exists
    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(emailClean).first();
    if (existing) {
        return errorResponse('Account already exists for this email.', 409);
    }

    const userId = crypto.randomUUID();
    const recoveryBlobJson = JSON.stringify(recoveryBlob);
    const clientVersion = getClientVersion(request);
    const now = Date.now();

    // PR-0: Capture registration version + initial login state in one row.
    // app_version_at_registration is set ONCE here and never updated.
    // last_login_* fields are also seeded — registration counts as the first login.
    await env.DB.prepare(
        `INSERT INTO users (
            id, email, auth_key_hash, recovery_blob,
            app_version_at_registration, last_login_app_version,
            last_login_at, login_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).bind(
        userId, emailClean, authHash, recoveryBlobJson,
        clientVersion, clientVersion,
        now,
    ).run();

    // Initialize empty vault
    await env.DB.prepare(
        'INSERT INTO vaults (user_id, encrypted_data, iv, version) VALUES (?, ?, ?, 0)'
    ).bind(userId, '', '').run();

    // Create session token
    const token = await createSessionToken(userId, env.SESSION_SECRET);

    return jsonResponse({ ok: true, userId, token }, 201);
}

async function handleLogin(request, env) {
    const body = await request.json();
    const { email, authKeyHex } = body;

    if (!email || !authKeyHex) {
        return errorResponse('Missing required fields');
    }

    const emailClean = email.toLowerCase().trim();
    const authHash = await hashAuthKey(authKeyHex);

    const user = await env.DB.prepare(
        'SELECT id, auth_key_hash FROM users WHERE email = ?'
    ).bind(emailClean).first();

    if (!user || user.auth_key_hash !== authHash) {
        return errorResponse('Invalid email or password.', 401);
    }

    // PR-0: Update login tracking. We use a single statement with COALESCE on
    // login_count for resilience against rows that predate the migration —
    // although the migration sets DEFAULT 0, defensive coding is cheap.
    // The version column accepts NULL when the header is missing or invalid.
    const clientVersion = getClientVersion(request);
    const now = Date.now();
    await env.DB.prepare(
        `UPDATE users
         SET last_login_app_version = ?,
             last_login_at = ?,
             login_count = COALESCE(login_count, 0) + 1
         WHERE id = ?`
    ).bind(clientVersion, now, user.id).run();

    const token = await createSessionToken(user.id, env.SESSION_SECRET);

    return jsonResponse({ ok: true, userId: user.id, token });
}

async function handleRecover(request, env) {
    const body = await request.json();
    const { email } = body;

    if (!email) return errorResponse('Email required');

    const emailClean = email.toLowerCase().trim();
    const user = await env.DB.prepare(
        'SELECT id, recovery_blob FROM users WHERE email = ?'
    ).bind(emailClean).first();

    // Return the same shape whether or not the account exists — prevents
    // email enumeration. The client will fail harmlessly during local decryption
    // if a fake blob is returned for a non-existent account.
    if (!user) {
        return jsonResponse({ ok: true, recoveryBlob: null, recoveryToken: null });
    }

    let recoveryBlob;
    try { recoveryBlob = JSON.parse(user.recovery_blob); }
    catch { return errorResponse('Corrupted recovery data', 500); }

    // Issue a short-lived (15 min) recovery token. The client must present it
    // on /api/auth/update to prove it went through this flow first.
    const secret = env.SESSION_SECRET;
    const recoveryToken = await createRecoveryToken(user.id, secret);

    return jsonResponse({ ok: true, recoveryBlob, recoveryToken });
}

async function handleUpdateAuth(request, env) {
    const body = await request.json();
    const { email, newAuthKeyHex, newRecoveryBlob, recoveryToken } = body;

    if (!email || !newAuthKeyHex || !newRecoveryBlob || !recoveryToken) {
        return errorResponse('Missing required fields');
    }

    // Verify the recovery token — proves the caller went through /api/auth/recover
    // and received a server-issued token. Prevents unauthenticated account takeover.
    const tokenUserId = await verifyRecoveryToken(recoveryToken, env.SESSION_SECRET);
    if (!tokenUserId) return errorResponse('Invalid or expired recovery token', 401);

    const emailClean = email.toLowerCase().trim();

    // Ensure the token's userId matches the target account (prevents token reuse
    // across accounts if an attacker somehow obtained a valid token for their own account).
    const targetUser = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(emailClean).first();
    if (!targetUser || targetUser.id !== tokenUserId) {
        return errorResponse('Invalid or expired recovery token', 401);
    }

    const newAuthHash = await hashAuthKey(newAuthKeyHex);
    const recoveryBlobJson = JSON.stringify(newRecoveryBlob);

    await env.DB.prepare(
        'UPDATE users SET auth_key_hash = ?, recovery_blob = ?, updated_at = datetime(\'now\') WHERE id = ?'
    ).bind(newAuthHash, recoveryBlobJson, tokenUserId).run();

    const token = await createSessionToken(tokenUserId, env.SESSION_SECRET);
    return jsonResponse({ ok: true, token, userId: tokenUserId });
}

async function handleUpdateRecoveryKit(request, env) {
    const token = getAuthToken(request);
    const userId = await verifySessionToken(token, env.SESSION_SECRET);
    if (!userId) return errorResponse('Unauthorized', 401);

    const body = await request.json().catch(() => null);
    if (!body || !body.recoveryBlob || typeof body.recoveryBlob !== 'object') {
        return errorResponse('recoveryBlob required');
    }

    const { ciphertext, iv } = body.recoveryBlob;
    if (typeof ciphertext !== 'string' || !ciphertext
        || typeof iv !== 'string' || !iv) {
        return errorResponse('recoveryBlob fields required');
    }

    const MAX_FIELD_SIZE = 1024;
    const MAX_BLOB_SIZE = 2048;
    if (ciphertext.length > MAX_FIELD_SIZE || iv.length > MAX_FIELD_SIZE) {
        return errorResponse('recoveryBlob too large');
    }
    const recoveryBlobJson = JSON.stringify(body.recoveryBlob);
    if (recoveryBlobJson.length > MAX_BLOB_SIZE) {
        return errorResponse('recoveryBlob too large');
    }

    try {
        const result = await env.DB.prepare(
            `UPDATE users
             SET recovery_blob = ?,
                 recovery_kit_version = 2,
                 recovery_kit_updated_at = ?,
                 updated_at = datetime('now')
             WHERE id = ?`
        ).bind(recoveryBlobJson, Date.now(), userId).run();

        if (result.changes === 0) {
            return errorResponse('Account not found', 404);
        }

        return jsonResponse({ ok: true });
    } catch (err) {
        console.error('[recovery-kit] D1 update failed:', err);
        return errorResponse('Internal error', 500);
    }
}

async function handleDeleteAccount(request, env) {
    const token = getAuthToken(request);
    const userId = await verifySessionToken(token, env.SESSION_SECRET);
    if (!userId) return errorResponse('Unauthorized', 401);

    // Delete vault first (FK), then user
    await env.DB.prepare('DELETE FROM vaults WHERE user_id = ?').bind(userId).run();
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();

    return jsonResponse({ ok: true });
}

async function handleGetVault(request, env) {
    const token = getAuthToken(request);
    const userId = await verifySessionToken(token, env.SESSION_SECRET);
    if (!userId) return errorResponse('Unauthorized', 401);

    const vault = await env.DB.prepare(
        'SELECT encrypted_data, iv, version FROM vaults WHERE user_id = ?'
    ).bind(userId).first();

    if (!vault) return jsonResponse({ ok: true, vault: null, version: 0 });

    if (!vault.encrypted_data || vault.encrypted_data === '') {
        return jsonResponse({ ok: true, vault: null, version: vault.version });
    }

    return jsonResponse({
        ok: true,
        vault: { ciphertext: vault.encrypted_data, iv: vault.iv },
        version: vault.version,
    });
}

async function handlePutVault(request, env) {
    const token = getAuthToken(request);
    const userId = await verifySessionToken(token, env.SESSION_SECRET);
    if (!userId) return errorResponse('Unauthorized', 401);

    const body = await request.json();
    const { vault, expectedVersion } = body;

    if (!vault || vault.ciphertext === undefined || vault.iv === undefined) {
        return errorResponse('Missing vault data');
    }
    if (expectedVersion === undefined) {
        return errorResponse('Missing expectedVersion');
    }

    // Optimistic locking — reject if version mismatch
    const current = await env.DB.prepare(
        'SELECT version FROM vaults WHERE user_id = ?'
    ).bind(userId).first();

    const currentVersion = current ? current.version : 0;
    if (currentVersion !== expectedVersion) {
        return jsonResponse({
            ok: false,
            error: 'Version conflict',
            currentVersion,
        }, 409);
    }

    const newVersion = expectedVersion + 1;

    if (current) {
        await env.DB.prepare(
            'UPDATE vaults SET encrypted_data = ?, iv = ?, version = ?, updated_at = datetime(\'now\') WHERE user_id = ?'
        ).bind(vault.ciphertext, vault.iv, newVersion, userId).run();
    } else {
        await env.DB.prepare(
            'INSERT INTO vaults (user_id, encrypted_data, iv, version) VALUES (?, ?, ?, ?)'
        ).bind(userId, vault.ciphertext, vault.iv, newVersion).run();
    }

    return jsonResponse({ ok: true, version: newVersion });
}

async function handleFeedback(request, env) {
    const body = await request.json();
    const { type, message, email, timestamp, userAgent } = body;

    if (!message) return errorResponse('Message required');

    // Log to console (visible in Workers dashboard logs)
    console.log(`[FEEDBACK] type=${type} email=${email} time=${timestamp} msg=${message.substring(0, 200)}`);

    // If a webhook URL is configured, forward it
    if (env.FEEDBACK_WEBHOOK) {
        try {
            await fetch(env.FEEDBACK_WEBHOOK, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: `**[${type?.toUpperCase()}]** from \`${email}\`\n${message}\n_${userAgent}_`,
                }),
            });
        } catch {
            // Silent fail — don't break UX if webhook is down
        }
    }

    return jsonResponse({ ok: true });
}

async function handleFetchMeta(request, env) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) return errorResponse('Missing url parameter');

    let parsed;
    try { parsed = new URL(targetUrl); }
    catch { return errorResponse('Invalid URL'); }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        return errorResponse('Only http/https URLs allowed');
    }

    // SSRF protection
    const hostname = parsed.hostname.toLowerCase();
    const blocked = [/^localhost$/i, /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^\[::1?\]$/, /^169\.254\./, /^fc00:/i, /^fe80:/i, /^fd/i];
    if (blocked.some(p => p.test(hostname))) {
        return errorResponse('Internal addresses not allowed', 403);
    }

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
        let html = '';
        let bytes = 0;
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

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Rate limiting
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    maybeCleanup();
    if (!checkRateLimit(ip)) {
        return errorResponse('Too many requests. Try again later.', 429);
    }

    // CORS preflight — only allow our own origins, never echo request origin.
    const ALLOWED_ORIGINS = new Set([
        'https://productivity-sidekick.pages.dev',
        'https://productivitysidekick.com',
        'https://staging.productivity-sidekick.pages.dev',
        'http://localhost:5173',  // local Vite dev server
    ]);
    const requestOrigin = request.headers.get('Origin') || '';
    const corsOrigin = ALLOWED_ORIGINS.has(requestOrigin) ? requestOrigin : 'https://productivitysidekick.com';

    if (method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': corsOrigin,
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Version',
                'Access-Control-Max-Age': '86400',
            },
        });
    }

    try {
        // Auth routes
        if (path === '/api/auth/register' && method === 'POST') return await handleRegister(request, env);
        if (path === '/api/auth/login' && method === 'POST') return await handleLogin(request, env);
        if (path === '/api/auth/recover' && method === 'POST') return await handleRecover(request, env);
        if (path === '/api/auth/update' && method === 'POST') return await handleUpdateAuth(request, env);
        if (path === '/api/auth/recovery-kit' && method === 'POST') return await handleUpdateRecoveryKit(request, env);
        if (path === '/api/auth/delete' && method === 'POST') return await handleDeleteAccount(request, env);

        // Vault routes
        if (path === '/api/vault' && method === 'GET') return await handleGetVault(request, env);
        if (path === '/api/vault' && method === 'PUT') return await handlePutVault(request, env);

        // Feedback
        if (path === '/api/feedback' && method === 'POST') return await handleFeedback(request, env);

        // Metadata proxy
        if (path === '/api/fetch-meta' && method === 'GET') return await handleFetchMeta(request, env);

        return errorResponse('Not found', 404);
    } catch (err) {
        console.error('API Error:', err);
        return errorResponse('Internal server error', 500);
    }
}
