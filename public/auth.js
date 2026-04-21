/**
 * Productivity Sidekick — Auth Module (v1.3.0 — Worker Enclave)
 *
 * v1.3.0 changes:
 * - Cryptographic operations route through CryptoClient (Web Worker enclave)
 * - currentSession no longer holds encKey — the worker owns it
 * - requestPersistentStorage() fires immediately on successful auth
 * - requireWorkerReady() guards every vault operation; triggers
 * SessionLockModal if the worker was terminated
 * - AUTH_READY / AUTH_LOGOUT events emitted via EventBus
 * - Legacy v1.2.x recovery blob fallback via CryptoModule + loadRawMasterKey
 *
 * The encryption key never leaves the worker enclave.
 */

const AuthManager = (() => {
    'use strict';

    const API_BASE = '/api';

    // --- HTTP Client ---
    async function api(path, options = {}) {
        const url = `${API_BASE}${path}`;
        const headers = { 'Content-Type': 'application/json', ...options.headers };

        // Attach session token if logged in
        if (currentSession?.token) {
            headers['Authorization'] = `Bearer ${currentSession.token}`;
        }

        const resp = await fetch(url, {
            method: options.method || 'GET',
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined,
        });

        const data = await resp.json();

        if (!resp.ok && !data.ok) {
            throw new Error(data.error || `Request failed (${resp.status})`);
        }

        return data;
    }

    // --- Session State ---
    let currentSession = null; // { email, token, userId, enclaveLoaded }
    let vaultVersionCache = 0;

    function isLoggedIn() {
        return currentSession !== null;
    }

    function getSession() {
        return currentSession;
    }

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

    // --- Registration ---
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

    // --- Login ---
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

    // --- Logout ---
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

    // --- Recovery ---
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

    // --- Vault Operations ---
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

    // --- Account Management ---
    async function deleteAccount() {
        if (!currentSession) throw new Error('Not logged in');
        await api('/auth/delete', { method: 'POST' });

        try { if (window.CryptoClient) window.CryptoClient.wipe(); }
        catch { /* ignored */ }

        currentSession = null;
        vaultVersionCache = 0;
        return { ok: true };
    }

    // --- Default App State ---
    function getDefaultAppState() {
        return {
            schemaVersion: 5,
            categories: ['My Links', 'Backlog'],
            links: [],
            clocks: [{ label: 'My Time', tz: 'Local' }],
            notes: [],
            pomoLogs: [],
            bucketSizes: { 'cat-My Links': { x: 0, y: 0 }, 'cat-Backlog': { x: 340, y: 0 } },
            bucketIcons: { 'cat-Backlog': '📦' },
            sidebarOrder: ['focus_review', 'audio', 'notes', 'clocks', 'cost'],
            ytLinks: [
                { title: 'Lofi Girl (Live)', videoId: 'jfKfPfyJRdk', listId: null },
                { title: 'Chillhop (Live)', videoId: '5yx6BWlEVcY', listId: null },
            ],
            currentYtIndex: 0,
            preferences: {},
            isMaintenanceMode: false,
            dailyCounter: { date: '', count: 0 },
            taxonomy: {
                Reactive: ['Product Defect', 'Customer Escalation', 'Slack Request'],
                Strategic: ['Planned', 'Project', 'Self-Improvement'],
            },
        };
    }

    // --- Public API ---
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
})();