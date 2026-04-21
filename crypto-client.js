/**
 * Productivity Sidekick — Crypto Worker Bridge (Main Thread)
 * ============================================================
 * Promise-based proxy for workers/crypto-worker.js. Wraps postMessage
 * in an async/await API so callers see normal promise semantics.
 *
 * v1.3.0:
 *   - Lazy worker creation on first use
 *   - Per-request crypto.randomUUID() correlation
 *   - Per-call timeouts (default 10s, PBKDF2 gets 30s)
 *   - Crash recovery: worker death rejects all pending promises
 *   - Wipe terminates the worker entirely (strongest teardown)
 *   - loadRawMasterKey is the ONE command that accepts raw key bytes
 *     across the postMessage boundary — legacy recovery migration only
 */

'use strict';

const WORKER_URL = '/workers/crypto-worker.js';
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const PBKDF2_REQUEST_TIMEOUT_MS = 30000;

const CryptoClient = (function() {

    let worker = null;
    const pending = new Map();
    let workerHasKey = false;
    let fallbackIdCounter = 0;

    function ensureWorker() {
        if (worker) return worker;

        if (typeof Worker === 'undefined') {
            throw new Error('Web Workers are not supported in this browser. '
                + 'Productivity Sidekick requires a modern browser for end-to-end encryption.');
        }
        if (!self.isSecureContext) {
            throw new Error('Productivity Sidekick must be served over HTTPS.');
        }

        worker = new Worker(WORKER_URL);
        worker.addEventListener('message', handleWorkerMessage);
        worker.addEventListener('error', handleWorkerError);
        worker.addEventListener('messageerror', handleWorkerError);
        return worker;
    }

    function handleWorkerMessage(event) {
        const msg = event.data;
        if (!msg || typeof msg !== 'object' || !msg.id) return;
        const entry = pending.get(msg.id);
        if (!entry) return;
        clearTimeout(entry.timeoutId);
        pending.delete(msg.id);
        if (msg.ok) entry.resolve(msg.data);
        else entry.reject(new Error(msg.error || 'Unknown worker error'));
    }

    function handleWorkerError(event) {
        const errMsg = event && event.message
            ? `Crypto worker crashed: ${event.message}`
            : 'Crypto worker crashed';
        for (const [, entry] of pending) {
            clearTimeout(entry.timeoutId);
            entry.reject(new Error(errMsg));
        }
        pending.clear();
        if (worker) {
            try { worker.terminate(); } catch { /* already dead */ }
            worker = null;
        }
        workerHasKey = false;
    }

    function request(cmd, args = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            let w;
            try { w = ensureWorker(); }
            catch (err) { reject(err); return; }

            const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : `req-${Date.now()}-${++fallbackIdCounter}`;

            const timeoutId = setTimeout(() => {
                if (pending.has(id)) {
                    pending.delete(id);
                    reject(new Error(`Crypto worker request "${cmd}" timed out after ${timeoutMs}ms`));
                }
            }, timeoutMs);

            pending.set(id, { resolve, reject, timeoutId });

            try {
                w.postMessage({ id, cmd, args });
            } catch (err) {
                clearTimeout(timeoutId);
                pending.delete(id);
                reject(new Error(`Failed to dispatch "${cmd}" to crypto worker: ${err.message}`));
            }
        });
    }

    async function deriveFromPassword(password, email) {
        if (typeof password !== 'string' || password.length === 0) {
            throw new Error('deriveFromPassword: password is required');
        }
        if (typeof email !== 'string' || email.length === 0) {
            throw new Error('deriveFromPassword: email is required');
        }
        const result = await request('deriveFromPassword',
            { password, email }, PBKDF2_REQUEST_TIMEOUT_MS);
        workerHasKey = true;
        return result.authKeyHex;
    }

    async function deriveAuthOnly(password, email) {
        if (!password || !email) {
            throw new Error('deriveAuthOnly: password and email required');
        }
        const result = await request('deriveAuthOnly',
            { password, email }, PBKDF2_REQUEST_TIMEOUT_MS);
        return result.authKeyHex;
    }

    async function generateRecoveryKit() {
        if (!workerHasKey) {
            throw new Error('Crypto worker has no master key loaded.');
        }
        return request('generateRecoveryKit', {}, 15000);
    }

    async function loadFromRecoveryKey(recoveryKey, recoveryBlob) {
        const result = await request('loadFromRecoveryKey',
            { recoveryKey, recoveryBlob }, 15000);
        workerHasKey = true;
        return result;
    }

    /**
     * LEGACY MIGRATION ONLY. Load raw key bytes into the worker.
     * Called by auth.js when the v1.3.0 recovery path failed and the
     * legacy CryptoModule.recoverEncKey() produced raw bytes instead.
     * REMOVE in v1.4.0.
     */
    async function loadRawMasterKey(rawKeyBytes) {
        if (!(rawKeyBytes instanceof Uint8Array) || rawKeyBytes.length !== 32) {
            throw new Error('loadRawMasterKey: expected Uint8Array of length 32');
        }
        let s = '';
        for (let i = 0; i < rawKeyBytes.length; i++) s += String.fromCharCode(rawKeyBytes[i]);
        const rawKeyBase64 = window.btoa(s);
        const result = await request('loadRawMasterKey', { rawKeyBase64 }, 5000);
        workerHasKey = true;
        return result;
    }

    async function encrypt(plaintext) {
        if (!workerHasKey) {
            throw new Error('Crypto worker has no master key loaded. Call deriveFromPassword first.');
        }
        return request('encrypt', { plaintext });
    }

    async function decrypt(ciphertext, iv) {
        if (!workerHasKey) {
            throw new Error('Crypto worker has no master key loaded.');
        }
        const result = await request('decrypt', { ciphertext, iv });
        return result.plaintext;
    }

    async function encryptEvent(event) {
        if (!workerHasKey) throw new Error('Crypto worker has no master key loaded.');
        return request('encryptEvent', { event });
    }

    async function decryptEvent(ciphertext, iv) {
        if (!workerHasKey) throw new Error('Crypto worker has no master key loaded.');
        const result = await request('decryptEvent', { ciphertext, iv });
        return result.event;
    }

    async function wipe() {
        workerHasKey = false;
        for (const [, entry] of pending) {
            clearTimeout(entry.timeoutId);
            entry.reject(new Error('Crypto worker wiped during pending request (logout)'));
        }
        pending.clear();
        if (worker) {
            try {
                worker.postMessage({ id: 'wipe-final', cmd: 'wipe', args: {} });
            } catch { /* worker may already be dead */ }
            try { worker.terminate(); } catch { /* nothing to do */ }
            worker = null;
        }
    }

    function isReady() {
        return workerHasKey && worker !== null;
    }

    async function isReadyAsync() {
        try {
            const result = await request('isReady', {}, 2000);
            workerHasKey = result.ready;
            return result.ready;
        } catch {
            return false;
        }
    }

    function pendingRequestCount() {
        return pending.size;
    }

    return {
        deriveFromPassword,
        deriveAuthOnly,
        generateRecoveryKit,
        loadFromRecoveryKey,
        loadRawMasterKey,
        encrypt,
        decrypt,
        encryptEvent,
        decryptEvent,
        wipe,
        isReady,
        isReadyAsync,
        pendingRequestCount,
    };
})();

if (typeof window !== 'undefined') {
    window.CryptoClient = CryptoClient;
}
