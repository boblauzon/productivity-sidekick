/**
 * TEMPORARY DIAGNOSTIC — Delete after debugging
 * 
 * Deploy this file, then visit:
 *   https://staging.productivity-sidekick.pages.dev/api/debug/env-check
 *
 * It will tell you exactly which env vars are available to your
 * Pages Functions at runtime, without exposing their actual values.
 *
 * ⚠️ DELETE THIS FILE before going to production.
 */

export async function onRequest(context) {
    const { env } = context;

    const checks = {
        timestamp: new Date().toISOString(),
        environment: 'unknown',

        // Check 1: Does SESSION_SECRET exist and have length > 0?
        SESSION_SECRET_exists: typeof env.SESSION_SECRET === 'string',
        SESSION_SECRET_length: typeof env.SESSION_SECRET === 'string' ? env.SESSION_SECRET.length : 0,
        SESSION_SECRET_is_placeholder: typeof env.SESSION_SECRET === 'string'
            && env.SESSION_SECRET.includes('PLACEHOLDER'),

        // Check 2: Does the DB binding exist?
        DB_binding_exists: !!env.DB,
        DB_binding_type: typeof env.DB,

        // Check 3: Can we actually use crypto.subtle with the secret?
        crypto_test: 'not_run',

        // Check 4: List all env keys (names only, not values)
        env_keys: Object.keys(env).sort(),
    };

    // Test if we can create an HMAC key from SESSION_SECRET
    if (checks.SESSION_SECRET_exists && checks.SESSION_SECRET_length > 0) {
        try {
            const encoder = new TextEncoder();
            const keyData = encoder.encode(env.SESSION_SECRET);
            const key = await crypto.subtle.importKey(
                'raw',
                keyData,
                { name: 'HMAC', hash: 'SHA-256' },
                false,
                ['sign', 'verify']
            );
            checks.crypto_test = 'PASS — HMAC key created successfully';
        } catch (err) {
            checks.crypto_test = `FAIL — ${err.name}: ${err.message}`;
        }
    } else {
        checks.crypto_test = 'SKIP — SESSION_SECRET is empty or missing';
    }

    return new Response(JSON.stringify(checks, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}
