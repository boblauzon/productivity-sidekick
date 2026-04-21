# Backend Spec: POST /api/auth/recovery-kit

**Purpose:** Update a user's encrypted recovery blob WITHOUT changing their password.
**Consumer:** `public/auth.js` → `generateNewRecoveryKitFromSettings()` (v1.3.0+)

## ⚠️ Architecture note

The live backend uses a **monolithic catch-all router** at `functions/api/[[path]].js`. Handlers are functions dispatched by path string in the `onRequest` switch, not standalone files.

**This endpoint is implemented as two insertions into `[[path]].js`, not as a new file.** See `functions/PATCH-api-path.js` in this bundle for the exact code blocks to insert and their line locations.

---

## Request

```
POST /api/auth/recovery-kit HTTP/1.1
Content-Type: application/json
Authorization: Bearer <session-token>

{
  "recoveryBlob": {
    "ciphertext": "<URL-safe base64>",
    "iv":         "<URL-safe base64>"
  }
}
```

### Headers

| Header | Required | Notes |
|---|---|---|
| `Content-Type` | yes | Must be `application/json` |
| `Authorization` | yes | Bearer token from an active session. Validate via existing `verifySessionToken(token, env.SESSION_SECRET)`. |

### Body

- **`recoveryBlob`** (object, required) — opaque encrypted blob produced by the crypto worker. Contains two string fields:
  - `ciphertext` — URL-safe base64-encoded wrapped key material
  - `iv` — URL-safe base64-encoded 12-byte AES-GCM IV

The server MUST NOT attempt to decrypt or parse the blob beyond verifying the two fields are present non-empty strings.

**Blob format note:** This matches the existing v1.2.x recovery blob format stored in `users.recovery_blob` under the same schema. The server already handles this shape for the `/auth/update` endpoint.

### Size limits

- Serialized JSON: reject if > 2 KB. Legitimate blobs are ~100 bytes.
- Individual fields: reject if any string > 1 KB.

---

## Response — Success (200)

```json
{ "ok": true }
```

---

## Response — Errors

| Status | Body | Triggered by |
|---|---|---|
| 400 | `{"ok": false, "error": "recoveryBlob required"}` | Missing/malformed body |
| 400 | `{"ok": false, "error": "recoveryBlob fields required"}` | Missing `ciphertext` or `iv` |
| 400 | `{"ok": false, "error": "recoveryBlob too large"}` | Size limit exceeded |
| 401 | `{"ok": false, "error": "Unauthorized"}` | Missing/invalid Bearer token |
| 404 | `{"ok": false, "error": "Account not found"}` | UPDATE affected 0 rows |
| 500 | `{"ok": false, "error": "Internal error"}` | D1 write failed |

---

## Server behavior

1. **Validate session.** `getAuthToken(request)` then `verifySessionToken(token, env.SESSION_SECRET)`. If either fails, return 401. This matches the pattern in `handlePutVault` and `handleDeleteAccount`.

2. **Parse and validate body.** Confirm `recoveryBlob` is an object with non-empty string `ciphertext` and `iv` fields. Enforce size limits.

3. **Update D1.** Single statement:

   ```sql
   UPDATE users
   SET recovery_blob = ?,
       recovery_kit_version = 2,
       recovery_kit_updated_at = ?,
       updated_at = datetime('now')
   WHERE id = ?;
   ```

   Bind parameters:
   - `JSON.stringify(recoveryBlob)` — the blob as a string
   - `Date.now()` — milliseconds since epoch
   - `userId` — from the validated session token

4. **Return 200** with `{"ok": true}` on success, 500 on D1 failure.

---

## Schema requirements

Two new columns on the `users` table, supplied by `brain/migration-recovery-kit-version.sql`:

```sql
ALTER TABLE users ADD COLUMN recovery_kit_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN recovery_kit_updated_at INTEGER;
```

Apply to staging first, then production.

---

## Security notes

1. **No decryption.** The server never decrypts the blob.
2. **No old-blob verification.** The endpoint does not require the caller to present the old recovery key. The authenticated session is sufficient proof — if an attacker has a live session token, they can already exfiltrate the vault; letting them rotate the recovery kit is strictly less bad.
3. **Atomic write.** D1 provides per-statement atomicity.
4. **No rate limiter** in v1.3.0. The current backend has no per-user rate limiting infrastructure. If v1.3.1 adds one, guard this endpoint with 5 requests/minute per user.

---

## Test cases for QA

| Test | Expected |
|---|---|
| Valid request with valid session | 200, D1 row updated |
| Missing `Authorization` header | 401 |
| Invalid Bearer token | 401 |
| Empty body | 400, `recoveryBlob required` |
| Body missing `iv` | 400, `recoveryBlob fields required` |
| Body with 10 KB `ciphertext` | 400, `recoveryBlob too large` |
| D1 unreachable | 500, `Internal error` |
| Concurrent requests from same user | Both succeed, last write wins |

---

## Deployment order

1. Apply the D1 migration first (`brain/migration-recovery-kit-version.sql`)
2. Deploy the updated `[[path]].js` with the two insertions from `functions/PATCH-api-path.js`
3. Deploy the v1.3.0 frontend

Step 3 must NOT ship before step 2, otherwise the "Generate New Recovery Kit" button will return 404.
