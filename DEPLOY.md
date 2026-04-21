# Productivity Sidekick — v1.3.0 Deployment Guide

**Release:** v1.3.0 — Secure Web Worker Enclave
**Time budget:** ~90 min staging, ~20 min production, 48 hrs monitoring
**Rollback plan:** Revert the GitHub commit and redeploy. Vault data is unaffected.

---

## ⚠️ Why This Release Is Different

v1.3.0 rewrites how encryption keys are handled. Master key now lives in a Web Worker. PBKDF2 iterations jumped 100k → 600k. This means:

- **First login will be slower** — 300ms to 2.5s depending on device
- **If the vault format adapter is wrong, every existing user's vault breaks**
- **Staging is not optional.** Verify a real v1.2.x vault decrypts before production.

Skipping staging is the fastest way to brick every account.

---

## 📋 Pre-Flight Checklist

### Files present

```bash
ls -la public/workers/crypto-worker.js \
       public/lib/crypto-client.js \
       public/lib/storage-persistence.js \
       public/lib/session-lock-modal.js \
       public/lib/toast-notifications.js \
       public/lib/recovery-key-display.js \
       public/lib/security-settings-panel.js \
       public/lib/subtask-reversion.js \
       functions/PATCH-api-path.js \
       brain/migration-recovery-kit-version.sql
```

All must exist. The legacy `public/crypto.js` must ALSO still exist — do not delete it.

### Script load order in index.html

```html
<script src="lib/crypto-client.js"></script>
<script src="crypto.js"></script>
<script src="lib/storage-persistence.js"></script>
<script src="lib/session-lock-modal.js"></script>
<script src="lib/toast-notifications.js"></script>
<script src="lib/recovery-key-display.js"></script>
<script src="lib/security-settings-panel.js"></script>
<script src="lib/subtask-reversion.js"></script>
<script src="auth.js"></script>
```

### CSP headers

```bash
grep "worker-src" public/_headers
```

Must contain `worker-src 'self'`. If missing, add it.

### auth.js patches applied

Verify all 12 patches from `PATCHES.md` are applied. Quick sanity check:

```bash
grep "requireWorkerReady" public/auth.js          # should match
grep "markRecoveryKitAcknowledged" public/auth.js # should match
grep "generateNewRecoveryKitFromSettings" public/auth.js # should match
grep "CryptoClient.deriveFromPassword" public/auth.js # should match
```

All four should return hits.

### Environment variables

```bash
wrangler pages secret list --project-name=productivity-sidekick
```

Confirm `SESSION_SECRET` and `RECOVERY_TOKEN_SECRET` exist.

---

## 🧪 Step 1 — Staging Deployment (MANDATORY)

### 1.1 — Apply D1 schema migration (preview)

```bash
wrangler d1 execute sidekick-db --file=brain/migration-recovery-kit-version.sql --preview
```

Expected: two `✅ Executed successfully` lines. If you see `duplicate column name`, the migration already ran — skip to next step.

Verify:

```bash
wrangler d1 execute sidekick-db --command="PRAGMA table_info(users);" --preview
```

Confirm `recovery_kit_version` and `recovery_kit_updated_at` appear.

### 1.2 — Deploy to staging branch

**Via GitHub integration (recommended):**

```bash
git checkout -b staging
git push origin staging
```

Wait ~90 seconds. Check the preview URL in the Cloudflare dashboard under **Workers & Pages → Deployments**.

**Via wrangler CLI:**

```bash
wrangler pages deploy public --project-name=productivity-sidekick --branch=staging
```

### 1.3 — Verify worker file is served

```bash
curl -I https://staging.productivity-sidekick.pages.dev/workers/crypto-worker.js
```

Expected: `HTTP/2 200` with `content-type: application/javascript`.

If 404, your Pages build is not picking up the `public/workers/` directory. Check your build configuration.

### 1.4 — The 5 Mandatory Smoke Tests

**Do not skip any. Do not move to production until all 5 pass.** Use a private/incognito window for each.

---

#### 🧪 Test 1: Fresh Registration Happy Path

1. Open staging URL in private window
2. Click **Create Account**, use `staging-test-1@example.com` and a **12+ character** password
3. Complete registration

**Expected:**
- First login takes 300ms–2s (600k PBKDF2)
- Recovery key display appears
- Click **📋 Copy** → button shows **✅ Copied**
- Click **I've Saved It — Continue to App** → app loads

**Critical sub-test:** Log out, log back in. The upgrade toast should **NOT** fire. If it does, `markRecoveryKitAcknowledged()` is broken.

---

#### 🧪 Test 2: Fresh Registration with Immediate Dismiss

1. Private window, register `staging-test-2@example.com`
2. When recovery key display appears, **do NOT click Copy/Download/Print**
3. Click **I've Saved It — Continue to App** directly
4. Log out, log back in

**Expected:**
- "Security Upgrade Available" toast appears top-right
- Toast has **Generate Now** and **Remind Me Later** buttons

If the toast does NOT appear, `checkRecoveryKitVersion()` is not being called post-login, or the `AUTH_READY` event isn't wired.

---

#### 🧪 Test 3: Legacy v1.2.x Vault Decryption (MOST IMPORTANT)

This test exists because the vault format adapter stubs in auth.js are the single biggest production risk.

Use a real v1.2.x account — either your own personal test account, or a newly registered production account that also exists in staging's D1.

1. Log in on staging with the v1.2.x credentials
2. Watch the browser console

**Expected:**
- Login succeeds within ~2 seconds
- Board renders with all existing tasks/groups/notes intact
- Upgrade toast appears (vault has no `recoveryKitVersion` yet)
- Opening tasks, scrolling, editing all work normally

**If this fails with "Decryption failed":** the crypto-worker.js parameters don't match `crypto.js`. The worker is supposed to be a byte-compatible mirror, but mirrors can have subtle bugs. **Stop immediately.** Do not touch production. Open `public/crypto.js`, open `public/workers/crypto-worker.js`, and compare in order: (1) PBKDF2 iterations and output length, (2) HKDF salt bytes and info strings, (3) base64 encoder output format. The vault format adapter (`vaultToWire` / `wireToVault`) was audit-confirmed correct against `functions/api/[[path]].js` and is unlikely to be the cause, but verify as a last resort.

---

#### 🧪 Test 4: Legacy Recovery Key Fallback

1. On the v1.2.x account from Test 3, click **Forgot Password?**
2. Enter the original recovery key (generated under v1.2.x)
3. Set a new 12+ character password
4. Click **Recover**

**Expected:**
- Recovery succeeds
- Console shows `Recovery succeeded via legacy v1.2.x fallback path`
- Settings → Security shows **v1.3.0 Secure Format** (auto-upgraded)

If recovery fails, the legacy blob format assumed by `crypto-worker.js` doesn't match `crypto.js`. Check the comments in `handleLoadFromRecoveryKey`.

---

#### 🧪 Test 5: iOS Safari Resume Flow (Session Locked Modal)

Simulate worker termination manually:

1. Log in on any test account
2. Open a task and **start typing in the description** (do not save)
3. Open DevTools → Console, run:
   ```javascript
   await window.CryptoClient.wipe();
   ```
4. Close DevTools, click Save on the task

**Expected:**
- Session Paused modal appears
- Your typed description is still visible behind the overlay
- Re-enter password, click **Resume Session**
- Modal dismisses, save succeeds

**Also test escape hatch:**

1. Log in again, wipe the worker again
2. Trigger a vault op, modal appears
3. Click **Save my work and log out**
4. Acknowledge the confirm dialog — file downloads
5. Checklist screen appears, check the acknowledgment box, click **Log out**
6. **Delete the downloaded recovery file from your Downloads folder**

---

### 1.5 — Document results

Note which tests passed before moving to production. If any failed, fix and re-run ALL FIVE from the beginning.

---

## 🚀 Step 2 — Production Deployment

**Do not proceed unless all 5 smoke tests passed.**

### 2.1 — Apply D1 migration to production

```bash
wrangler d1 execute sidekick-db --file=brain/migration-recovery-kit-version.sql
```

Note the absence of `--preview`.

### 2.2 — Merge staging to main

**GitHub:**

1. Open PR `staging` → `main`
2. Review the diff one more time
3. Merge

**wrangler:**

```bash
git checkout main
git merge staging
git push origin main
wrangler pages deploy public --project-name=productivity-sidekick --branch=main
```

### 2.3 — Verify production

```bash
curl -I https://productivitysidekick.com/workers/crypto-worker.js
```

Expected: `HTTP/2 200`.

Open the production URL in a private window. Log in with your own account. Verify vault loads, upgrade toast appears, click **Generate Now**, walk through regeneration, Settings → Security shows **v1.3.0 Secure Format**.

### 2.4 — Tag the release

```bash
git tag -a v1.3.0 -m "v1.3.0 — Secure Web Worker Enclave"
git push origin v1.3.0
```

---

## 📊 Step 3 — Post-Launch Monitoring (48 Hours)

### 3.1 — Cloudflare Function logs (every 4 hours day 1)

```bash
wrangler pages deployment tail --project-name=productivity-sidekick
```

Watch for:
- **500 errors on `/api/auth/recovery-kit`** — the new endpoint
- **500 errors on `/api/vault`** — D1 strain from acknowledgment writes
- **401 spikes** — session secret misconfigured

### 3.2 — D1 query: legacy user count (daily, first week)

```bash
wrangler d1 execute sidekick-db --command="SELECT recovery_kit_version, COUNT(*) FROM users GROUP BY recovery_kit_version;"
```

Track in a spreadsheet. When legacy count drops below **5% of MAU**, schedule v1.4.0 cleanup to remove `crypto.js` and `loadRawMasterKey`.

### 3.3 — PostHog login-speed watch

Insights → filter by `app_loaded`. Watch for:
- Median login under 1.5s — ideal
- 1.5s to 3s — acceptable
- Over 3s — investigate

### 3.4 — Three failure signatures

**Signature A — "Vault format mismatch":** multiple users reporting "my data is gone". Immediate rollback.

```bash
git revert HEAD
git push origin main
```

**Signature B — "Slow login on old phones":** 1-2 reports of 5-10s login delays. No immediate action; note for v1.3.1.

**Signature C — "Session Paused modal loops":** user enters password, modal reappears. Usually autofill mismatch. Instruct full logout and retry.

### 3.5 — Declaring stable

Mark v1.3.0 stable when:
- ✅ 48 hours no Signature A events
- ✅ `/api/auth/recovery-kit` error rate < 1%
- ✅ ≥10% of MAU have `recovery_kit_version = 2`
- ✅ No critical bugs via feedback widget
- ✅ You've logged in successfully on mobile

---

## 🆘 Emergency Rollback

```bash
git log --oneline -5
git revert <v1.3.0-merge-commit-hash>
git push origin main
```

Cloudflare auto-redeploys in ~90 seconds.

**DO NOT drop the D1 columns.** They're additive and harmless. Users who already regenerated their kit on v1.3.0 **cannot** use their old v1.2.x recovery key after rollback — plan accordingly.

---

Ship well.
