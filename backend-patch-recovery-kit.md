# Backend Patch — `functions/api/[[path]].js`

**Epic:** v1.3.0 — Secure Web Worker Enclave
**Endpoint:** `POST /api/auth/recovery-kit`

## Context

The earlier draft of this bundle shipped the new endpoint as a standalone file under `functions/api/auth/recovery-kit.js`. This was wrong — the live backend uses a **monolithic catch-all router** at `functions/api/[[path]].js`. Pages Functions would either shadow the standalone file entirely or create a routing conflict depending on resolution order.

This document contains **two code fragments** to insert into the existing `[[path]].js` file. Apply both, save, commit.

---

## Fragment 1 — Handler function

**Insert location:** after `handleUpdateAuth` (around line 291), before `handleDeleteAccount`.

```javascript
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

    // Size limits — legitimate blobs are ~100 bytes; anything larger is abusive.
    const MAX_FIELD_SIZE = 1024;   // 1 KB per field
    const MAX_BLOB_SIZE = 2048;    // 2 KB total
    if (ciphertext.length > MAX_FIELD_SIZE || iv.length > MAX_FIELD_SIZE) {
        return errorResponse('recoveryBlob too large');
    }
    const recoveryBlobJson = JSON.stringify(body.recoveryBlob);
    if (recoveryBlobJson.length > MAX_BLOB_SIZE) {
        return errorResponse('recoveryBlob too large');
    }

    // NOTE: no per-user rate limiter exists in the current backend.
    // If v1.3.1 adds one, guard this endpoint with 5 requests/minute.

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
```

**Helper functions referenced** (all exist in the current `[[path]].js`):

| Helper | Current location | Returns |
|---|---|---|
| `getAuthToken(request)` | ~line 68 | `string \| null` (Bearer token) |
| `verifySessionToken(token, secret)` | ~line 75 | `number \| null` (userId on success) |
| `errorResponse(message, status)` | existing helper | `Response` |
| `jsonResponse(data, status)` | ~line 144 | `Response` |

---

## Fragment 2 — Route dispatch line

**Insert location:** inside `onRequest()`, in the auth routes section. The current `[[path]].js` has these lines around 498–502:

```javascript
if (path === '/api/auth/register' && method === 'POST') return await handleRegister(request, env);
if (path === '/api/auth/login' && method === 'POST') return await handleLogin(request, env);
if (path === '/api/auth/recover' && method === 'POST') return await handleRecover(request, env);
if (path === '/api/auth/update' && method === 'POST') return await handleUpdateAuth(request, env);
if (path === '/api/auth/delete' && method === 'POST') return await handleDeleteAccount(request, env);
```

Add this new line immediately after the `/auth/update` line:

```javascript
if (path === '/api/auth/recovery-kit' && method === 'POST') return await handleUpdateRecoveryKit(request, env);
```

---

## Verification steps

After applying both fragments to `functions/api/[[path]].js`:

### 1. Syntax check the modified file

```bash
node --check functions/api/[[path]].js
```

Should print nothing on success.

### 2. Deploy to staging

```bash
wrangler pages deploy public --project-name=productivity-sidekick --branch=staging
```

### 3. Manual smoke test

Get a valid session token (log in on staging via the UI and copy from localStorage, or directly from the login response), then:

```bash
TOKEN="<paste session token here>"
curl -X POST https://staging.productivity-sidekick.pages.dev/api/auth/recovery-kit \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"recoveryBlob":{"ciphertext":"dGVzdA","iv":"dGVzdA"}}'
```

Expected response:

```json
{"ok": true}
```

### 4. Verify D1

```bash
wrangler d1 execute sidekick-db --preview \
  --command="SELECT id, email, recovery_kit_version, recovery_kit_updated_at FROM users WHERE id=<userId>;"
```

Expected output:
- `recovery_kit_version` = `2`
- `recovery_kit_updated_at` = recent epoch millis

### 5. Error-case tests

| Test | Expected |
|---|---|
| `curl` without `Authorization` header | 401, `Unauthorized` |
| `curl` with invalid token | 401, `Unauthorized` |
| `curl` with empty body `{}` | 400, `recoveryBlob required` |
| `curl` with `{"recoveryBlob":{"iv":"x"}}` | 400, `recoveryBlob fields required` |
| `curl` with 10 KB `ciphertext` string | 400, `recoveryBlob too large` |

---

## Deployment dependencies

Before this patch can be applied successfully, the D1 schema migration must be in place:

```bash
wrangler d1 execute sidekick-db --file=brain/migration-recovery-kit-version.sql --preview
```

This adds the `recovery_kit_version` and `recovery_kit_updated_at` columns referenced by the `UPDATE` statement above. If the migration hasn't run, the handler will crash with "no such column" on the first request.

Then the frontend can be deployed. The new `generateNewRecoveryKitFromSettings()` function in `auth.js` will POST to `/api/auth/recovery-kit` only after a successful response from `CryptoClient.generateRecoveryKit()`, so there is no request-path dependency on this endpoint during normal login/vault flows — it's only hit from the Settings → Security panel and the upgrade-nag toast's "Generate Now" action.
