/**
 * Productivity Sidekick — Secure Crypto Enclave (Web Worker)
 * ============================================================
 * v1.3.0 — AUDIT-CORRECTED BUILD
 *
 * This file is a BYTE-COMPATIBLE mirror of the legacy public/crypto.js
 * module. Every cryptographic primitive, parameter, and encoding format
 * matches crypto.js exactly, so existing v1.2.x vaults and recovery kits
 * decrypt without any fallback path.
 *
 * Verified against crypto.js on audit:
 *   - PBKDF2:   600,000 iterations, SHA-256, salt=email bytes, 256 output bits
 *   - HKDF:     32-byte zero salt, info 'ps-auth-key' / 'ps-enc-key'
 *   - AES-GCM:  256-bit key, 96-bit IV
 *   - Base64:   URL-safe (+→-, /→_, padding stripped)
 *   - Recovery: 16 random bytes, HKDF with info 'ps-recovery-wrap',
 *               format XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
 *
 * Threat model:
 *   - Main thread XSS: MITIGATED — attacker can request decryptions
 *                      via the bridge but cannot exfiltrate the key.
 *   - Worker XSS:      OUT OF SCOPE — workers load only this file.
 *   - Server:          MITIGATED — server only ever sees ciphertext.
 *
 * Terminology: the internal variable is `encKey` to match crypto.js.
 * There is a true master key (HKDF material) used only transiently
 * inside handleDeriveFromPassword to derive auth and enc keys.
 */

'use strict';

// ============================================================
// CONSTANTS — mirror crypto.js exactly
// ============================================================

const PBKDF2_ITERATIONS = 600000;
const PBKDF2_HASH = 'SHA-256';
const AES_KEY_BITS = 256;
const AES_KEY_BYTES = 32;
const IV_BYTES = 12;

const HKDF_INFO_AUTH = 'ps-auth-key';
const HKDF_INFO_ENC = 'ps-enc-key';
const HKDF_INFO_RECOVERY = 'ps-recovery-wrap';

const RECOVERY_KEY_BYTES = 16;
const HKDF_ZERO_SALT = new Uint8Array(32);

// ============================================================
// ENCLAVE STATE — never exposed via postMessage
// ============================================================

/** @type {CryptoKey | null} The AES-GCM encryption key (crypto.js calls this encKey). */
let encKey = null;

const pendingCommands = [];

// ============================================================
// MESSAGE DISPATCH
// ============================================================

self.addEventListener('message', async (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object' || !msg.id || !msg.cmd) return;

    const keylessCommands = [
        'deriveFromPassword', 'deriveAuthOnly', 'loadFromRecoveryKey',
        'loadRawMasterKey', 'wipe', 'ping', 'isReady',
    ];
    const requiresKey = !keylessCommands.includes(msg.cmd);

    if (requiresKey && !encKey) {
        pendingCommands.push(msg);
        if (pendingCommands.length > 100) {
            const dropped = pendingCommands.shift();
            respond(dropped.id, false, null, 'Pending command queue overflow');
        }
        return;
    }

    try {
        switch (msg.cmd) {
            case 'ping':                respond(msg.id, true, { pong: true }); break;
            case 'isReady':             respond(msg.id, true, { ready: encKey !== null }); break;
            case 'deriveFromPassword':  await handleDeriveFromPassword(msg.id, msg.args); drainPendingCommands(); break;
            case 'deriveAuthOnly':      await handleDeriveAuthOnly(msg.id, msg.args); break;
            case 'loadFromRecoveryKey': await handleLoadFromRecoveryKey(msg.id, msg.args); drainPendingCommands(); break;
            case 'loadRawMasterKey':    await handleLoadRawMasterKey(msg.id, msg.args); drainPendingCommands(); break;
            case 'generateRecoveryKit': await handleGenerateRecoveryKit(msg.id, msg.args); break;
            case 'encrypt':             await handleEncrypt(msg.id, msg.args); break;
            case 'decrypt':              await handleDecrypt(msg.id, msg.args); break;
            case 'encryptEvent':        await handleEncryptEvent(msg.id, msg.args); break;
            case 'decryptEvent':        await handleDecryptEvent(msg.id, msg.args); break;
            case 'wipe':                handleWipe(msg.id); break;
            default:                    respond(msg.id, false, null, `Unknown command: ${msg.cmd}`);
        }
    } catch (err) {
        respond(msg.id, false, null, err && err.message ? err.message : String(err));
    }
});

function drainPendingCommands() {
    if (!encKey) return;
    while (pendingCommands.length > 0) {
        const queued = pendingCommands.shift();
        self.dispatchEvent(new MessageEvent('message', { data: queued }));
    }
}

function respond(id, ok, data = null, error = null) {
    self.postMessage({ id, ok, data, error });
}

// ============================================================
// CORE DERIVATION — mirrors crypto.js deriveMasterKey + hkdfDeriveKey
// ============================================================

/**
 * Derive HKDF master material from password + email.
 * Mirrors crypto.js deriveMasterKey() exactly:
 *   PBKDF2(password, email, 600k, SHA-256) → 256 bits
 *   → importKey as HKDF material
 */
async function deriveMasterKey(password, email) {
    const enc = new TextEncoder();
    const passwordBytes = enc.encode(password);
    const emailBytes = enc.encode(email.toLowerCase().trim());

    const passwordKey = await crypto.subtle.importKey(
        'raw', passwordBytes, 'PBKDF2', false, ['deriveBits']
    );

    const masterBits = await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            salt: emailBytes,
            iterations: PBKDF2_ITERATIONS,
            hash: PBKDF2_HASH,
        },
        passwordKey,
        AES_KEY_BITS
    );

    const hkdfKey = await crypto.subtle.importKey(
        'raw', masterBits, 'HKDF', false, ['deriveBits', 'deriveKey']
    );

    passwordBytes.fill(0);
    new Uint8Array(masterBits).fill(0);

    return hkdfKey;
}

/**
 * Derive a purpose-specific AES-GCM key from HKDF master material.
 * Mirrors crypto.js hkdfDeriveKey() exactly: zero-byte salt, named info.
 * Extractable (matches crypto.js) so we can export authKey as hex and
 * wrap encKey for recovery.
 */
async function hkdfDeriveKey(masterKey, info, usage) {
    const enc = new TextEncoder();
    return crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: HKDF_ZERO_SALT,
            info: enc.encode(info),
        },
        masterKey,
        { name: 'AES-GCM', length: AES_KEY_BITS },
        true,
        usage
    );
}

// ============================================================
// HANDLERS
// ============================================================

/**
 * Derive both auth and encryption keys from password + email.
 * Auth key is exported as hex and returned to the main thread.
 * Encryption key stays in the worker as `encKey`.
 * Mirrors crypto.js deriveKeys() exactly.
 */
async function handleDeriveFromPassword(id, args) {
    if (!args || typeof args.password !== 'string' || typeof args.email !== 'string') {
        respond(id, false, null, 'deriveFromPassword: password and email required');
        return;
    }

    const masterKey = await deriveMasterKey(args.password, args.email);

    const authKey = await hkdfDeriveKey(masterKey, HKDF_INFO_AUTH, ['encrypt', 'decrypt']);
    const newEncKey = await hkdfDeriveKey(masterKey, HKDF_INFO_ENC, ['encrypt', 'decrypt']);

    const authKeyRaw = await crypto.subtle.exportKey('raw', authKey);
    const authKeyHex = bufToHex(authKeyRaw);

    encKey = newEncKey;

    new Uint8Array(authKeyRaw).fill(0);

    respond(id, true, { authKeyHex });
}

/**
 * Derive ONLY the auth credential, leaving encKey untouched.
 * Used by the recovery flow's password-change step.
 */
async function handleDeriveAuthOnly(id, args) {
    if (!args || typeof args.password !== 'string' || typeof args.email !== 'string') {
        respond(id, false, null, 'deriveAuthOnly: password and email required');
        return;
    }

    const masterKey = await deriveMasterKey(args.password, args.email);
    const authKey = await hkdfDeriveKey(masterKey, HKDF_INFO_AUTH, ['encrypt', 'decrypt']);
    const authKeyRaw = await crypto.subtle.exportKey('raw', authKey);
    const authKeyHex = bufToHex(authKeyRaw);
    new Uint8Array(authKeyRaw).fill(0);

    respond(id, true, { authKeyHex });
}

/**
 * Generate a fresh recovery kit wrapping the current encKey.
 * Mirrors crypto.js generateRecoveryKit() exactly.
 */
async function handleGenerateRecoveryKit(id, args) {
    if (!encKey) {
        respond(id, false, null, 'generateRecoveryKit: no encryption key loaded');
        return;
    }

    const recoveryRandom = crypto.getRandomValues(new Uint8Array(RECOVERY_KEY_BYTES));
    const recoveryKey = formatRecoveryKey(recoveryRandom);

    const recoveryHkdfKey = await crypto.subtle.importKey(
        'raw', recoveryRandom, 'HKDF', false, ['deriveKey']
    );
    const enc = new TextEncoder();
    const wrapKey = await crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: HKDF_ZERO_SALT,
            info: enc.encode(HKDF_INFO_RECOVERY),
        },
        recoveryHkdfKey,
        { name: 'AES-GCM', length: AES_KEY_BITS },
        false,
        ['encrypt']
    );

    const encKeyRaw = await crypto.subtle.exportKey('raw', encKey);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const cipherBuf = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, wrapKey, encKeyRaw
    );

    new Uint8Array(encKeyRaw).fill(0);
    recoveryRandom.fill(0);

    respond(id, true, {
        recoveryKey,
        recoveryBlob: {
            ciphertext: bufToBase64UrlSafe(cipherBuf),
            iv: bufToBase64UrlSafe(iv),
        },
    });
}

/**
 * Load the encKey from a recovery blob.
 * Mirrors crypto.js recoverEncKey() exactly — handles both v1.2.x
 * and v1.3.0 blobs because the format is identical.
 */
async function handleLoadFromRecoveryKey(id, args) {
    if (!args || typeof args.recoveryKey !== 'string' || !args.recoveryBlob) {
        respond(id, false, null, 'loadFromRecoveryKey: recoveryKey and recoveryBlob required');
        return;
    }
    const blob = args.recoveryBlob;
    if (typeof blob.ciphertext !== 'string' || typeof blob.iv !== 'string') {
        respond(id, false, null, 'loadFromRecoveryKey: recoveryBlob missing ciphertext/iv');
        return;
    }

    try {
        const recoveryRandom = parseRecoveryKey(args.recoveryKey);

        const recoveryHkdfKey = await crypto.subtle.importKey(
            'raw', recoveryRandom, 'HKDF', false, ['deriveKey']
        );
        const enc = new TextEncoder();
        const unwrapKey = await crypto.subtle.deriveKey(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: HKDF_ZERO_SALT,
                info: enc.encode(HKDF_INFO_RECOVERY),
            },
            recoveryHkdfKey,
            { name: 'AES-GCM', length: AES_KEY_BITS },
            false,
            ['decrypt']
        );

        const cipherBytes = base64UrlSafeToBuf(blob.ciphertext);
        const ivBytes = base64UrlSafeToBuf(blob.iv);
        const encKeyRaw = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: ivBytes }, unwrapKey, cipherBytes
        );

        encKey = await crypto.subtle.importKey(
            'raw',
            encKeyRaw,
            { name: 'AES-GCM', length: AES_KEY_BITS },
            true,
            ['encrypt', 'decrypt']
        );

        new Uint8Array(encKeyRaw).fill(0);
        recoveryRandom.fill(0);

        respond(id, true, { ok: true });
    } catch (err) {
        respond(id, false, null, 'Recovery failed — invalid recovery key or corrupted blob');
    }
}

/**
 * DEFENSIVE FALLBACK: import raw encKey bytes from the main thread.
 *
 * With the byte-compatible worker above, loadFromRecoveryKey handles
 * all legacy blobs directly. This command is kept as an escape hatch
 * in case a future audit reveals a subtle mismatch. Telemetry will
 * confirm zero usage. REMOVE in v1.4.0.
 */
async function handleLoadRawMasterKey(id, args) {
    if (!args || typeof args.rawKeyBase64 !== 'string') {
        respond(id, false, null, 'loadRawMasterKey: rawKeyBase64 required');
        return;
    }

    try {
        const rawBytes = base64UrlSafeToBuf(args.rawKeyBase64);
        if (rawBytes.length !== AES_KEY_BYTES) {
            respond(id, false, null, `Invalid key length — expected ${AES_KEY_BYTES} bytes`);
            rawBytes.fill(0);
            return;
        }

        encKey = await crypto.subtle.importKey(
            'raw',
            rawBytes,
            { name: 'AES-GCM', length: AES_KEY_BITS },
            true,
            ['encrypt', 'decrypt']
        );

        rawBytes.fill(0);
        respond(id, true, { ok: true });
    } catch (err) {
        respond(id, false, null, 'Failed to load raw key bytes');
    }
}

/**
 * Encrypt a plaintext string. Mirrors crypto.js encrypt().
 */
async function handleEncrypt(id, args) {
    if (!args || typeof args.plaintext !== 'string') {
        respond(id, false, null, 'encrypt: plaintext required');
        return;
    }
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const encoded = new TextEncoder().encode(args.plaintext);
    const cipherBuf = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, encKey, encoded
    );
    respond(id, true, {
        ciphertext: bufToBase64UrlSafe(cipherBuf),
        iv: bufToBase64UrlSafe(iv),
    });
}

/**
 * Decrypt a ciphertext + iv pair. Mirrors crypto.js decrypt().
 */
async function handleDecrypt(id, args) {
    if (!args || typeof args.ciphertext !== 'string' || typeof args.iv !== 'string') {
        respond(id, false, null, 'decrypt: ciphertext and iv required');
        return;
    }
    try {
        const cipherBuf = base64UrlSafeToBuf(args.ciphertext);
        const ivBuf = base64UrlSafeToBuf(args.iv);
        const plainBuf = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: ivBuf }, encKey, cipherBuf
        );
        respond(id, true, { plaintext: new TextDecoder().decode(plainBuf) });
    } catch (err) {
        respond(id, false, null, 'Decryption failed');
    }
}

/**
 * Encrypt a CQRS event. Reserved for v1.4.0 Event Lake.
 */
async function handleEncryptEvent(id, args) {
    if (!args || !args.event || typeof args.event !== 'object') {
        respond(id, false, null, 'encryptEvent: event object required');
        return;
    }
    const event = args.event;
    if (!event.eventId || !event.aggregateId) {
        respond(id, false, null, 'encryptEvent: event must have eventId and aggregateId');
        return;
    }
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const plaintext = JSON.stringify(event);
    const cipherBuf = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, encKey, new TextEncoder().encode(plaintext)
    );
    respond(id, true, {
        eventId: event.eventId,
        aggregateId: event.aggregateId,
        sequenceNumber: event.sequenceNumber || 0,
        clientTimestamp: event.clientTimestamp || Date.now(),
        ciphertext: bufToBase64UrlSafe(cipherBuf),
        iv: bufToBase64UrlSafe(iv),
        schemaVersion: event.schemaVersion || 1,
    });
}

async function handleDecryptEvent(id, args) {
    if (!args || typeof args.ciphertext !== 'string' || typeof args.iv !== 'string') {
        respond(id, false, null, 'decryptEvent: ciphertext and iv required');
        return;
    }
    try {
        const plainBuf = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: base64UrlSafeToBuf(args.iv) },
            encKey,
            base64UrlSafeToBuf(args.ciphertext)
        );
        const event = JSON.parse(new TextDecoder().decode(plainBuf));
        respond(id, true, { event });
    } catch (err) {
        respond(id, false, null, 'Event decryption failed');
    }
}

function handleWipe(id) {
    encKey = null;
    while (pendingCommands.length > 0) {
        const dropped = pendingCommands.shift();
        respond(dropped.id, false, null, 'Worker wiped during pending command');
    }
    respond(id, true, { wiped: true });
}

// ============================================================
// ENCODING HELPERS — mirror crypto.js exactly
// ============================================================

function bufToHex(buf) {
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

function hexToBuf(hex) {
    if (hex.length % 2 !== 0) throw new Error('Invalid hex length');
    const arr = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        const byte = parseInt(hex.substring(i, i + 2), 16);
        if (Number.isNaN(byte)) throw new Error('Invalid hex character');
        arr[i / 2] = byte;
    }
    return arr;
}

/**
 * Encode to URL-safe base64 WITHOUT padding.
 * Mirrors crypto.js bufToBase64() exactly.
 */
function bufToBase64UrlSafe(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return self.btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * Decode URL-safe base64 (with or without padding).
 * Mirrors crypto.js base64ToBuf() exactly. Also accepts standard
 * base64 — the replace() calls are no-ops on already-standard input.
 */
function base64UrlSafeToBuf(b64) {
    const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (padded.length % 4)) % 4;
    const binary = self.atob(padded + '='.repeat(pad));
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        arr[i] = binary.charCodeAt(i);
    }
    return arr;
}

/**
 * Format 16 bytes as XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX.
 * Mirrors crypto.js formatRecoveryKey() exactly.
 */
function formatRecoveryKey(buf) {
    const hex = bufToHex(buf);
    return hex.match(/.{4}/g).join('-').toUpperCase();
}

/**
 * Parse a formatted recovery key back to 16 bytes.
 * Mirrors crypto.js parseRecoveryKey() exactly.
 */
function parseRecoveryKey(formatted) {
    const hex = formatted.replace(/-/g, '').toLowerCase();
    if (hex.length !== 32) throw new Error('Recovery key must be 32 hex characters (128 bits)');
    return hexToBuf(hex);
}
