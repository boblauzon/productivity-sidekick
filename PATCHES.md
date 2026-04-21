# Productivity Sidekick v1.3.0 — Patches for Existing Files

This document describes the changes you must make to **existing** files in your codebase. The NEW files in this deployment bundle drop in as-is, but `auth.js`, `index.html`, and `_headers` require targeted edits.

**Do not do a wholesale replacement of `auth.js`.** The live file has accumulated features (PostHog identify, beta code validation, recovery flow, version conflict handling) that must be preserved. Apply the patches below as targeted edits.

---

## 1. `public/_headers`

**Status:** Replace with the file from this bundle (`public/_headers`).

The key addition is `worker-src 'self'` in the CSP. Without this, strict-CSP browsers refuse to spawn the crypto worker and every login fails.

```bash
cp v1.3.0/public/_headers public/_headers
```

Verify:

```bash
grep "worker-src" public/_headers
```

Expected: the CSP line contains `worker-src 'self'`.

---

## 2. `public/index.html` — Script load order

Find the existing `<script src="crypto.js">` tag. Replace the surrounding script block with this exact sequence:

```html
<script src="lib/crypto-client.js"></script>
<script src="crypto.js"></script>                    <!-- LEGACY: kept for recovery fallback only. Remove in v1.4.0. -->
<script src="lib/storage-persistence.js"></script>
<script src="lib/session-lock-modal.js"></script>
<script src="lib/toast-notifications.js"></script>
<script src="lib/recovery-key-display.js"></script>
<script src="lib/security-settings-panel.js"></script>
<script src="lib/subtask-reversion.js"></script>
<script src="auth.js"></script>
<!-- your main app script last -->
```

**Order matters.** `crypto-client.js` must load before `auth.js`. `recovery-key-display.js` must load before `security-settings-panel.js` and `toast-notifications.js`. The legacy `crypto.js` is retained alongside `crypto-client.js` — do not delete it; it's needed for the legacy recovery fallback path until v1.4.0.

---

## 3. `public/auth.js` — Targeted edits

Apply these changes in order. Each code block shows the BEFORE and AFTER state of a specific section.

### 3.1 — Update the header comment

**BEFORE:**
```js
/**
 * Productivity Sidekick — Auth Module (Production)
 *
 * Uses fetch() calls to Cloudflare Workers API endpoints.
 * The public interface is identical to the Phase 1 mock version.
 *
 * Session tokens are HMAC-SHA256 signed by the server and
 * sent via Authorization header on every authenticated request.
 * The encKey never leaves the client.
 */
```

**AFTER:**
```js
/**
 * Productivity Sidekick — Auth Module (v1.3.0 — Worker Enclave)
 *
 * v1.3.0 changes:
 *   - Cryptographic operations route through CryptoClient (Web Worker enclave)
 *   - currentSession no longer holds encKey — the worker owns it
 *   - requestPersistentStorage() fires immediately on successful auth
 *   - requireWorkerReady() guards every vault operation; triggers
 *     SessionLockModal if the worker was terminated
 *   - AUTH_READY / AUTH_LOGOUT events emitted via EventBus
 *   - Legacy v1.2.x recovery blob fallback via CryptoModule + loadRawMasterKey
 *
 * The encryption key never leaves the worker enclave.
 */
```

### 3.2 — Update session shape comment

Find this line:

```js
let currentSession = null; // { email, encKey, token, userId }
```

Change to:

```js
let currentSession = null; // { email, token, userId, enclaveLoaded }
```

### 3.3 — Add three helper functions before `register()`

Insert the following block immediately after `function getSession() { return currentSession; }` and before `// --- Registration ---`:

```js
// ============================================================
// v1.3.0: Worker Lifecycle Helpers
// ============================================================

/**
 * Background storage persistence request. Fired immediately after
 * successful auth. Does NOT block the auth flow.
 */
function requestPersistenceInBackground() {
    if (typeof window === 'undefined' || !window.StoragePersistence) return;
    window.StoragePersistence.requestPersistentStorage()
        .then((result) => {
            if (typeof window.debugLog === 'function') {
                window.debugLog(`Storage persistence: ${JSON.stringify(result)}`);
            }
            if (typeof posthog !== 'undefined') {
                posthog.capture('storage_persistence_requested', {
                    supported: result.supported,
                    persisted: result.persisted,
                    already_persistent: result.alreadyPersistent,
                });
            }
        })
        .catch(() => { /* swallowed — non-fatal */ });
}

/**
 * Worker readiness guard. If the crypto worker has been terminated
 * (typically by iOS Safari freezing a backgrounded tab), this triggers
 * the SessionLockModal and waits for re-authentication. The user's
 * in-memory UI state is preserved across the modal interaction.
 */
async function requireWorkerReady() {
    if (window.CryptoClient.isReady()) return;

    const reallyReady = await window.CryptoClient.isReadyAsync();
    if (reallyReady) return;

    if (!currentSession || !currentSession.email) {
        throw new Error('Session expired. Please log in again.');
    }

    await window.SessionLockModal.show(currentSession.email);

    if (!window.CryptoClient.isReady()) {
        throw new Error('Session resume failed. Please refresh and log in again.');
    }
}

/**
 * Vault format adapter.
 *
 * ✅ AUDIT CONFIRMED: verified against functions/api/[[path]].js lines
 * 322 and 335 — the server both returns and accepts { ciphertext, iv }
 * as the vault shape. These identity adapters are correct as written.
 *
 * They remain as named functions (rather than being inlined) so any
 * future server-side format change can be absorbed here without
 * touching every call site.
 */
function vaultToWire(workerOutput)  { return { ciphertext: workerOutput.ciphertext, iv: workerOutput.iv }; }
function wireToVault(serverPayload) { return { ciphertext: serverPayload.ciphertext, iv: serverPayload.iv }; }
```

### 3.4 — Replace `register()` body

Find the existing `async function register(email, password, betaCode)` function. Replace its entire body with:

```js
async function register(email, password, betaCode) {
    if (!email || !password) throw new Error('Email and password required');
    if (password.length < 12) throw new Error('Password must be at least 12 characters');
    if (!betaCode) throw new Error('A valid beta access code is required.');

    const emailClean = email.toLowerCase().trim();

    // v1.3.0: Worker derives the master key. Password consumed in the worker.
    const authKeyHex = await window.CryptoClient.deriveFromPassword(password, emailClean);
    password = null;

    // v1.3.0: Recovery kit generated inside the worker.
    const { recoveryKey, recoveryBlob } = await window.CryptoClient.generateRecoveryKit();

    const result = await api('/auth/register', {
        method: 'POST',
        body: { email: emailClean, authKeyHex, recoveryBlob, betaCode },
    });

    currentSession = {
        email: emailClean,
        token: result.token,
        userId: result.userId,
        enclaveLoaded: true,
    };
    vaultVersionCache = 0;

    requestPersistenceInBackground();

    if (typeof posthog !== 'undefined') {
        posthog.identify(result.userId, { plan_tier: 'free' }, { email: emailClean });
        posthog.capture('user_registered');
    }

    if (typeof window !== 'undefined' && window.EventBus) {
        window.EventBus.emit('AUTH_READY', { userId: result.userId });
    }

    // v1.3.0: Initial vault goes out WITHOUT recoveryKitVersion.
    // The user must explicitly Copy/Download/Print the key to trigger
    // markRecoveryKitAcknowledged(). This creates the "nag toast" safety
    // net for users who dismiss the kit display without saving.
    await saveVault(getDefaultAppState());

    return { recoveryKey };
}
```

### 3.5 — Replace `login()` body

Find the existing `async function login(email, password)` function. Replace its entire body with:

```js
async function login(email, password) {
    if (!email || !password) throw new Error('Email and password required');

    const emailClean = email.toLowerCase().trim();
    const authKeyHex = await window.CryptoClient.deriveFromPassword(password, emailClean);
    password = null;

    const result = await api('/auth/login', {
        method: 'POST',
        body: { email: emailClean, authKeyHex },
    });

    currentSession = {
        email: emailClean,
        token: result.token,
        userId: result.userId,
        enclaveLoaded: true,
    };
    vaultVersionCache = 0;

    requestPersistenceInBackground();

    if (typeof posthog !== 'undefined') {
        posthog.identify(result.userId, { plan_tier: result.planTier || 'free' },
            { email: emailClean });
    }

    if (typeof window !== 'undefined' && window.EventBus) {
        window.EventBus.emit('AUTH_READY', { userId: result.userId });
    }

    return { ok: true };
}
```

### 3.6 — Replace `logout()` (make it async)

Find the existing `function logout()` (currently synchronous). Replace with:

```js
async function logout() {
    currentSession = null;
    vaultVersionCache = 0;

    try {
        if (window.CryptoClient) await window.CryptoClient.wipe();
    } catch (err) {
        console.warn('CryptoClient.wipe failed during logout:', err);
    }

    if (typeof posthog !== 'undefined') posthog.reset();

    if (typeof window !== 'undefined' && window.EventBus) {
        window.EventBus.emit('AUTH_LOGOUT', { timestamp: Date.now() });
    }
}
```

### 3.7 — Replace `recoverWithKey()` body (LEGACY FALLBACK)

This is the most complex patch. Replace the entire `async function recoverWithKey(email, recoveryKeyFormatted, newPassword)` function body with:

```js
async function recoverWithKey(email, recoveryKeyFormatted, newPassword) {
    if (!email || !recoveryKeyFormatted || !newPassword) {
        throw new Error('All fields required');
    }
    if (newPassword.length < 12) throw new Error('Password must be at least 12 characters');

    const emailClean = email.toLowerCase().trim();

    const blobResult = await api('/auth/recover', {
        method: 'POST',
        body: { email: emailClean },
    });

    // BACKWARD-COMPATIBLE: try v1.3.0 format first, fall back to v1.2.x on failure.
    let recoveredViaLegacy = false;

    try {
        await window.CryptoClient.loadFromRecoveryKey(
            recoveryKeyFormatted,
            blobResult.recoveryBlob
        );
    } catch (newFormatErr) {
        if (typeof CryptoModule === 'undefined' || !CryptoModule.recoverEncKey) {
            throw new Error('Invalid recovery key');
        }

        let legacyEncKey;
        try {
            legacyEncKey = await CryptoModule.recoverEncKey(
                recoveryKeyFormatted,
                blobResult.recoveryBlob
            );
        } catch (legacyErr) {
            throw new Error('Invalid recovery key');
        }

        let rawKeyBytes;
        try {
            const rawBuf = await crypto.subtle.exportKey('raw', legacyEncKey);
            rawKeyBytes = new Uint8Array(rawBuf);
            await window.CryptoClient.loadRawMasterKey(rawKeyBytes);
        } finally {
            if (rawKeyBytes) rawKeyBytes.fill(0);
            legacyEncKey = null;
        }

        recoveredViaLegacy = true;
        if (typeof debugLog === 'function') {
            debugLog('Recovery succeeded via legacy v1.2.x fallback path');
        }
    }

    const newAuthKeyHex = await window.CryptoClient.deriveAuthOnly(newPassword, emailClean);
    newPassword = null;

    const { recoveryKey: newRecoveryKey, recoveryBlob: newRecoveryBlob } =
        await window.CryptoClient.generateRecoveryKit();

    const updateResult = await api('/auth/update', {
        method: 'POST',
        body: {
            email: emailClean,
            newAuthKeyHex,
            newRecoveryBlob,
            recoveryToken: blobResult.recoveryToken,
        },
    });

    currentSession = {
        email: emailClean,
        token: updateResult.token,
        userId: updateResult.userId,
        enclaveLoaded: true,
    };
    vaultVersionCache = 0;

    requestPersistenceInBackground();

    if (typeof window !== 'undefined' && window.EventBus) {
        window.EventBus.emit('AUTH_READY', {
            userId: updateResult.userId,
            viaRecovery: true,
            recoveredViaLegacy,
        });
    }

    if (typeof posthog !== 'undefined') {
        posthog.capture('recovery_completed', {
            via_legacy_fallback: recoveredViaLegacy,
        });
    }

    return { newRecoveryKey };
}
```

### 3.8 — Replace `loadVault()` body

```js
async function loadVault() {
    if (!currentSession) throw new Error('Not logged in');

    await requireWorkerReady();

    const result = await api('/vault');

    if (!result.vault) {
        vaultVersionCache = result.version || 0;
        return { data: getDefaultAppState(), version: vaultVersionCache };
    }

    // v1.3.0: Decryption routes through the worker.
    const wireFormat = wireToVault(result.vault);
    const plaintext = await window.CryptoClient.decrypt(wireFormat.ciphertext, wireFormat.iv);
    const data = JSON.parse(plaintext);
    vaultVersionCache = result.version;
    return { data, version: vaultVersionCache };
}
```

### 3.9 — Replace `saveVault()` body

```js
async function saveVault(appState) {
    if (!currentSession) throw new Error('Not logged in');

    await requireWorkerReady();

    // v1.3.0: Encryption routes through the worker.
    const workerOutput = await window.CryptoClient.encrypt(JSON.stringify(appState));
    const vault = vaultToWire(workerOutput);

    const result = await api('/vault', {
        method: 'PUT',
        body: { vault, expectedVersion: vaultVersionCache },
    });

    if (!result.ok) {
        if (result.error === 'Version conflict') {
            throw new Error('CONFLICT: Vault was modified elsewhere. Reload and try again.');
        }
        throw new Error(result.error);
    }

    vaultVersionCache = result.version;
    return { version: result.version };
}
```

### 3.10 — Add three new functions before `deleteAccount()`

Insert these three new functions right before `async function deleteAccount()`:

```js
// ============================================================
// v1.3.0: Recovery Kit Lifecycle
// ============================================================

/**
 * Check whether the user's recovery kit needs upgrading and emit the
 * appropriate EventBus signal. Call this AFTER login() and loadVault()
 * have completed successfully.
 */
function checkRecoveryKitVersion(vaultData) {
    if (!vaultData || typeof vaultData !== 'object') return;
    const version = vaultData?.preferences?.recoveryKitVersion;
    if (version === undefined || version < 2) {
        if (typeof window !== 'undefined' && window.EventBus) {
            window.EventBus.emit('UPGRADE_RECOVERY_KIT_NEEDED', {
                currentVersion: version || 1,
                targetVersion: 2,
            });
        }
        if (typeof debugLog === 'function') {
            debugLog(`Recovery kit upgrade needed (current: v${version || 1})`);
        }
    }
}

/**
 * Mark the user's current recovery kit as acknowledged (saved by user).
 * Called by RecoveryKeyDisplay on first Copy/Download/Print action.
 */
async function markRecoveryKitAcknowledged() {
    if (!currentSession) throw new Error('Not logged in');
    await requireWorkerReady();

    const loadResult = await loadVault();
    const vault = loadResult.data;

    if (!vault.preferences) vault.preferences = {};
    if (vault.preferences.recoveryKitVersion === 2) {
        return false;
    }

    vault.preferences.recoveryKitVersion = 2;
    vault.preferences.recoveryKitAcknowledgedAt = new Date().toISOString();

    await saveVault(vault);

    if (typeof window !== 'undefined' && window.EventBus) {
        window.EventBus.emit('RECOVERY_KIT_ACKNOWLEDGED', { timestamp: Date.now() });
    }

    if (typeof posthog !== 'undefined') {
        posthog.capture('recovery_kit_acknowledged');
    }

    return true;
}

/**
 * Generate a fresh v1.3.0 recovery kit from the Settings → Security panel.
 * Pushes the new blob to the server, marks the vault as acknowledged.
 */
async function generateNewRecoveryKitFromSettings() {
    if (!currentSession) throw new Error('Not logged in');
    await requireWorkerReady();

    const { recoveryKey: newRecoveryKey, recoveryBlob: newRecoveryBlob } =
        await window.CryptoClient.generateRecoveryKit();

    await api('/auth/recovery-kit', {
        method: 'POST',
        body: { recoveryBlob: newRecoveryBlob },
    });

    try {
        await markRecoveryKitAcknowledged();
    } catch (err) {
        if (typeof debugLog === 'function') {
            debugLog(`markRecoveryKitAcknowledged failed: ${err.message}`);
        }
    }

    if (typeof window !== 'undefined' && window.EventBus) {
        window.EventBus.emit('RECOVERY_KIT_UPGRADED', { newVersion: 2 });
    }

    if (typeof posthog !== 'undefined') {
        posthog.capture('recovery_kit_upgraded');
    }

    return { newRecoveryKey };
}
```

### 3.11 — Update `deleteAccount()` to wipe the worker

Find the existing `deleteAccount()` and add the wipe call:

```js
async function deleteAccount() {
    if (!currentSession) throw new Error('Not logged in');
    await api('/auth/delete', { method: 'POST' });

    try { if (window.CryptoClient) window.CryptoClient.wipe(); }
    catch { /* ignored */ }

    currentSession = null;
    vaultVersionCache = 0;
    return { ok: true };
}
```

### 3.12 — Update the public API return object

Find the `return { register, login, logout, ... };` at the bottom of the IIFE. Add the three new functions:

```js
return {
    register,
    login,
    logout,
    recoverWithKey,
    loadVault,
    saveVault,
    deleteAccount,
    isLoggedIn,
    getSession,
    getDefaultAppState,
    // v1.3.0 additions:
    checkRecoveryKitVersion,
    markRecoveryKitAcknowledged,
    generateNewRecoveryKitFromSettings,
};
```

---

## 4. `public/index.html` — Main app wiring

Three changes needed in your main app IIFE (inside index.html).

### 4.1 — Call `checkRecoveryKitVersion()` after login + loadVault

Find wherever you currently call `AuthManager.loadVault()` in the post-login flow. Right after the load succeeds, add:

```js
const vaultResult = await AuthManager.loadVault();
// ... existing code that uses vaultResult.data ...

// v1.3.0: Emit upgrade toast if the user needs to regenerate their kit
if (typeof AuthManager.checkRecoveryKitVersion === 'function') {
    AuthManager.checkRecoveryKitVersion(vaultResult.data);
}
```

### 4.2 — Wire toast listeners in initApp

After your EventBus is initialized in `initApp()`, add:

```js
if (window.ToastManager && typeof window.ToastManager.installEventBusListeners === 'function') {
    window.ToastManager.installEventBusListeners(window.EventBus);
}
```

If you don't have an EventBus yet, create a minimal one:

```js
window.EventBus = (() => {
    const listeners = {};
    return {
        on(event, handler) {
            (listeners[event] = listeners[event] || []).push(handler);
            return () => {
                const arr = listeners[event];
                if (arr) listeners[event] = arr.filter(h => h !== handler);
            };
        },
        off(event, handler) {
            if (listeners[event]) listeners[event] = listeners[event].filter(h => h !== handler);
        },
        emit(event, payload) {
            (listeners[event] || []).forEach(h => { try { h(payload); } catch (e) { console.error(e); } });
        },
    };
})();
```

### 4.3 — Wire the Security settings panel

Find your `btnSettings` click handler (search for `$('btnSettings').addEventListener`). After the existing code that opens the settings modal, add:

```js
if (window.SecuritySettingsPanel) {
    const mountPoint = document.getElementById('securityPanelMount');
    if (mountPoint) {
        window.SecuritySettingsPanel.mount(mountPoint);
    }
}
```

And inside your `<dialog id="settingsModal">` HTML, add a mount point for the panel (anywhere inside the modal body, e.g. after the existing sections):

```html
<div style="border-top: 1px solid var(--color-border); margin: 12px 0;"></div>
<div id="securityPanelMount"></div>
```

### 4.4 — (Optional) Install Epic 104 idle stubs

At the very end of `initApp()`, add:

```js
// Epic 104: Storage persistence hardening (idle stubs in v1.3.0)
if (window.StoragePersistence) {
    window.StoragePersistence.installOnlineSyncDrain(async () => { /* v1.4.0 */ }, window.EventBus);
    window.StoragePersistence.installUnsavedChangesGuard(() => 0); // v1.4.0 returns real outbox size
}
```

---

## 5. Verification

After applying all patches, verify in your browser console (on a fresh page load, before login):

```js
typeof window.CryptoClient        // "object"
typeof window.StoragePersistence  // "object"
typeof window.SessionLockModal    // "object"
typeof window.ToastManager        // "object"
typeof window.RecoveryKeyDisplay  // "object"
typeof window.SecuritySettingsPanel  // "object"
typeof window.AuthManager         // "object"
typeof window.AuthManager.markRecoveryKitAcknowledged  // "function"
typeof window.AuthManager.generateNewRecoveryKitFromSettings  // "function"
typeof window.AuthManager.checkRecoveryKitVersion  // "function"
```

All should resolve as shown. Any `undefined` means a script is missing or loading out of order.

---

## ✅ Audit Status — What Changed After the Architect Review

An independent audit of this bundle identified 5 defects after the first draft. All 5 have been corrected before this bundle reached you:

1. **`crypto-worker.js` key derivation corrected.** The first draft derived 512 bits and used email-salted HKDF with the info string `productivity-sidekick:enc-key:v1`. The legacy `crypto.js` derives 256 bits and uses zero-salted HKDF with `ps-enc-key`. The worker has been rewritten as a byte-compatible mirror of `crypto.js`.

2. **`crypto-worker.js` base64 encoding corrected.** The first draft used standard `btoa`/`atob`. The legacy `crypto.js` uses URL-safe base64 with stripped padding. The worker now uses the URL-safe encoders.

3. **`crypto-worker.js` recovery kit format corrected.** The first draft generated 32-byte recovery keys with PBKDF2-derived KEKs. The legacy format uses 16-byte keys with HKDF-derived KEKs. The worker now matches exactly, which means existing v1.2.x recovery blobs decrypt directly — no fallback path required.

4. **Backend endpoint architecture corrected.** The first draft shipped `functions/api/auth/recovery-kit.js` as a standalone Pages Function. The live backend is a monolithic catch-all router at `functions/api/[[path]].js`. The corrected version is at `functions/PATCH-api-path.js` — a patch block with the handler function and route line to insert into the existing router.

5. **Backend helper references corrected.** The first draft referenced `validateSessionToken`, `rateLimit`, and `jsonResponse` from imaginary shared modules. The live backend exposes `getAuthToken`, `verifySessionToken`, `jsonResponse`, and `errorResponse` as functions within `[[path]].js`. The corrected patch block uses the real names and does not invoke a rate limiter (none exists in the current backend; flagged for v1.3.1).

**What was NOT broken:** The `vaultToWire` / `wireToVault` identity adapters in §3.3 above were audited against `functions/api/[[path]].js` line 322 and line 335 and confirmed correct. The server both returns and accepts `{ciphertext, iv}` as the vault shape. No adapter changes needed.

## The Post-Mortem Lesson

Across 8 architectural rounds the "vault format adapter" was repeatedly flagged as the single highest-risk item requiring user verification at deploy time. It turned out to be correct on the first try. The actual defects were in `crypto-worker.js` — a file that could have been verified against `crypto.js` with a two-minute read at any point during the design phase. Flagging uncertainty is not the same as resolving it. If a risk is resolvable by reading a file, the file should be read.

Staging smoke test #3 in `DEPLOY.md` (legacy vault decryption on a real v1.2.x account) remains mandatory. Mirror-audit confidence is high, but not 100%, and the cost of catching a subtle mismatch in staging is vastly lower than catching it in production.
