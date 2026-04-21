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
    let currentSession = null; // { email, encKey, token, userId }
    let vaultVersionCache = 0;

    function isLoggedIn() {
        return currentSession !== null;
    }

    function getSession() {
        return currentSession;
    }

    // --- Registration ---
    async function register(email, password, betaCode) {
        if (!email || !password) throw new Error('Email and password required');
        if (password.length < 10) throw new Error('Password must be at least 10 characters');
        if (!betaCode) throw new Error('A valid beta access code is required.');

        const emailClean = email.toLowerCase().trim();

        // Derive keys client-side
        const { encKey, authKeyHex } = await CryptoModule.deriveKeys(password, emailClean);

        // Generate recovery kit client-side
        const { recoveryKey, recoveryBlob } = await CryptoModule.generateRecoveryKit(encKey);

        // Send to server — server hashes authKeyHex and validates beta code
        const result = await api('/auth/register', {
            method: 'POST',
            body: { email: emailClean, authKeyHex, recoveryBlob, betaCode },
        });

        // Auto-login after registration
        currentSession = {
            email: emailClean,
            encKey,
            token: result.token,
            userId: result.userId,
        };
        vaultVersionCache = 0;

        // Initialize empty vault
        await saveVault(getDefaultAppState());

        return { recoveryKey };
    }

    // --- Login ---
    async function login(email, password) {
        if (!email || !password) throw new Error('Email and password required');

        const emailClean = email.toLowerCase().trim();
        const { encKey, authKeyHex } = await CryptoModule.deriveKeys(password, emailClean);

        // Send authKeyHex to server — server hashes and compares
        const result = await api('/auth/login', {
            method: 'POST',
            body: { email: emailClean, authKeyHex },
        });

        currentSession = {
            email: emailClean,
            encKey,
            token: result.token,
            userId: result.userId,
        };
        vaultVersionCache = 0;

        return { ok: true };
    }

    // --- Logout ---
    function logout() {
        currentSession = null;
        vaultVersionCache = 0;
    }

    // --- Recovery ---
    async function recoverWithKey(email, recoveryKeyFormatted, newPassword) {
        if (!email || !recoveryKeyFormatted || !newPassword) {
            throw new Error('All fields required');
        }
        if (newPassword.length < 10) throw new Error('Password must be at least 10 characters');

        const emailClean = email.toLowerCase().trim();

        // Fetch recovery blob from server
        const blobResult = await api('/auth/recover', {
            method: 'POST',
            body: { email: emailClean },
        });

        // Decrypt the encKey using the recovery key (client-side)
        let encKey;
        try {
            encKey = await CryptoModule.recoverEncKey(recoveryKeyFormatted, blobResult.recoveryBlob);
        } catch (e) {
            throw new Error('Invalid recovery key');
        }

        // Derive new auth credentials from the new password
        const { authKeyHex: newAuthKeyHex } = await CryptoModule.deriveKeys(newPassword, emailClean);

        // Generate a new recovery kit (the old one is burned)
        const { recoveryKey: newRecoveryKey, recoveryBlob: newRecoveryBlob } =
            await CryptoModule.generateRecoveryKit(encKey);

        // Update server with new auth credentials — server returns new token
        const updateResult = await api('/auth/update', {
            method: 'POST',
            body: { email: emailClean, newAuthKeyHex, newRecoveryBlob },
        });

        currentSession = {
            email: emailClean,
            encKey,
            token: updateResult.token,
            userId: updateResult.userId,
        };
        vaultVersionCache = 0;

        return { newRecoveryKey };
    }

    // --- Vault Operations ---
    async function loadVault() {
        if (!currentSession) throw new Error('Not logged in');

        const result = await api('/vault');

        if (!result.vault) {
            vaultVersionCache = result.version || 0;
            return { data: getDefaultAppState(), version: vaultVersionCache };
        }

        const data = await CryptoModule.decryptVault(currentSession.encKey, result.vault);
        vaultVersionCache = result.version;
        return { data, version: vaultVersionCache };
    }

    async function saveVault(appState) {
        if (!currentSession) throw new Error('Not logged in');

        const vault = await CryptoModule.encryptVault(currentSession.encKey, appState);

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

    // --- Account Management ---
    async function deleteAccount() {
        if (!currentSession) throw new Error('Not logged in');
        await api('/auth/delete', { method: 'POST' });
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
    };
})();
