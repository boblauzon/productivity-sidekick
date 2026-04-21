/**
 * Productivity Sidekick — Zero-Knowledge Crypto Module
 * 
 * Architecture:
 *   password + email(salt)
 *     → PBKDF2 (600k iterations, SHA-256) → masterKey (256-bit)
 *       → HKDF("auth")  → authKey   (sent to server, hashed again server-side)
 *       → HKDF("enc")   → encKey    (never leaves client, encrypts vault)
 * 
 * All cryptographic operations use the Web Crypto API (SubtleCrypto).
 * No third-party dependencies. No polyfills.
 */

const CryptoModule = (() => {
    'use strict';

    const PBKDF2_ITERATIONS = 600_000;
    const AES_KEY_BITS = 256;
    const IV_BYTES = 12; // 96-bit IV for AES-GCM (NIST recommended)
    const SALT_INFO_AUTH = 'ps-auth-key';
    const SALT_INFO_ENC = 'ps-enc-key';
    const SALT_INFO_RECOVERY = 'ps-recovery-wrap';

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // --- Helpers ---

    /** Convert ArrayBuffer to hex string */
    function bufToHex(buf) {
        return Array.from(new Uint8Array(buf))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    /** Convert hex string to Uint8Array */
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

    /** Convert ArrayBuffer to URL-safe Base64 */
    function bufToBase64(buf) {
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    }

    /** Convert URL-safe Base64 to Uint8Array */
    function base64ToBuf(b64) {
        const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
        const pad = (4 - (padded.length % 4)) % 4;
        const binary = atob(padded + '='.repeat(pad));
        const arr = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            arr[i] = binary.charCodeAt(i);
        }
        return arr;
    }

    /** Format 128-bit key as human-readable recovery code: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX */
    function formatRecoveryKey(buf) {
        const hex = bufToHex(buf);
        return hex.match(/.{4}/g).join('-').toUpperCase();
    }

    /** Parse formatted recovery key back to Uint8Array */
    function parseRecoveryKey(formatted) {
        const hex = formatted.replace(/-/g, '').toLowerCase();
        if (hex.length !== 32) throw new Error('Recovery key must be 32 hex characters (128 bits)');
        return hexToBuf(hex);
    }

    // --- Core Derivation ---

    /**
     * Derive the master key from password + email using PBKDF2.
     * Returns a CryptoKey suitable for HKDF derivation.
     */
    async function deriveMasterKey(password, email) {
        const salt = encoder.encode(email.toLowerCase().trim());
        const passwordKey = await crypto.subtle.importKey(
            'raw',
            encoder.encode(password),
            'PBKDF2',
            false,
            ['deriveBits']
        );
        const masterBits = await crypto.subtle.deriveBits(
            {
                name: 'PBKDF2',
                salt: salt,
                iterations: PBKDF2_ITERATIONS,
                hash: 'SHA-256',
            },
            passwordKey,
            AES_KEY_BITS
        );
        // Import as HKDF key material for subsequent derivation
        return crypto.subtle.importKey(
            'raw',
            masterBits,
            'HKDF',
            false,
            ['deriveBits', 'deriveKey']
        );
    }

    /**
     * Use HKDF to derive a purpose-specific key from the master key.
     * info string differentiates auth vs encryption keys.
     */
    async function hkdfDeriveKey(masterKey, info, usage) {
        return crypto.subtle.deriveKey(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: new Uint8Array(32), // Fixed zero salt — the entropy is in the master key
                info: encoder.encode(info),
            },
            masterKey,
            { name: 'AES-GCM', length: AES_KEY_BITS },
            true, // extractable — needed to export authKey for transmission
            usage
        );
    }

    /**
     * Derive both auth and encryption keys from password + email.
     * Returns { authKey: CryptoKey, encKey: CryptoKey, authKeyHex: string }
     */
    async function deriveKeys(password, email) {
        const masterKey = await deriveMasterKey(password, email);

        const authKey = await hkdfDeriveKey(masterKey, SALT_INFO_AUTH, ['encrypt', 'decrypt']);
        const encKey = await hkdfDeriveKey(masterKey, SALT_INFO_ENC, ['encrypt', 'decrypt']);

        // Export authKey as hex for server transmission
        const authKeyRaw = await crypto.subtle.exportKey('raw', authKey);
        const authKeyHex = bufToHex(authKeyRaw);

        return { authKey, encKey, authKeyHex };
    }

    // --- AES-256-GCM Encryption ---

    /**
     * Encrypt plaintext JSON data with AES-256-GCM.
     * Returns { ciphertext: base64, iv: base64 }
     */
    async function encrypt(encKey, plaintext) {
        const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
        const encoded = encoder.encode(
            typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext)
        );
        const cipherBuf = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv },
            encKey,
            encoded
        );
        return {
            ciphertext: bufToBase64(cipherBuf),
            iv: bufToBase64(iv),
        };
    }

    /**
     * Decrypt AES-256-GCM ciphertext.
     * Returns the decrypted string (caller can JSON.parse if needed).
     */
    async function decrypt(encKey, ciphertext, iv) {
        const cipherBuf = base64ToBuf(ciphertext);
        const ivBuf = base64ToBuf(iv);
        const plainBuf = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: ivBuf },
            encKey,
            cipherBuf
        );
        return decoder.decode(plainBuf);
    }

    // --- Recovery Key ---

    /**
     * Generate a random 128-bit recovery key and encrypt the encKey with it.
     * Returns { recoveryKey: formatted string, recoveryBlob: { ciphertext, iv } }
     */
    async function generateRecoveryKit(encKey) {
        // Generate 128 bits of randomness
        const recoveryRandom = crypto.getRandomValues(new Uint8Array(16));
        const recoveryKey = formatRecoveryKey(recoveryRandom);

        // Derive a wrapping key from the recovery random using HKDF
        const recoveryHkdfKey = await crypto.subtle.importKey(
            'raw',
            recoveryRandom,
            'HKDF',
            false,
            ['deriveKey']
        );
        const wrapKey = await crypto.subtle.deriveKey(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: new Uint8Array(32),
                info: encoder.encode(SALT_INFO_RECOVERY),
            },
            recoveryHkdfKey,
            { name: 'AES-GCM', length: AES_KEY_BITS },
            false,
            ['encrypt']
        );

        // Encrypt the encKey with the recovery-derived wrapping key
        const encKeyRaw = await crypto.subtle.exportKey('raw', encKey);
        const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
        const cipherBuf = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv },
            wrapKey,
            encKeyRaw
        );

        return {
            recoveryKey,
            recoveryBlob: {
                ciphertext: bufToBase64(cipherBuf),
                iv: bufToBase64(iv),
            },
        };
    }

    /**
     * Recover the encKey using the formatted recovery key and the stored recovery blob.
     * Returns a CryptoKey for AES-GCM decrypt.
     */
    async function recoverEncKey(recoveryKeyFormatted, recoveryBlob) {
        const recoveryRandom = parseRecoveryKey(recoveryKeyFormatted);

        const recoveryHkdfKey = await crypto.subtle.importKey(
            'raw',
            recoveryRandom,
            'HKDF',
            false,
            ['deriveKey']
        );
        const unwrapKey = await crypto.subtle.deriveKey(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: new Uint8Array(32),
                info: encoder.encode(SALT_INFO_RECOVERY),
            },
            recoveryHkdfKey,
            { name: 'AES-GCM', length: AES_KEY_BITS },
            false,
            ['decrypt']
        );

        const cipherBuf = base64ToBuf(recoveryBlob.ciphertext);
        const ivBuf = base64ToBuf(recoveryBlob.iv);
        const encKeyRaw = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: ivBuf },
            unwrapKey,
            cipherBuf
        );

        return crypto.subtle.importKey(
            'raw',
            encKeyRaw,
            { name: 'AES-GCM', length: AES_KEY_BITS },
            true, // extractable for re-wrapping on password change
            ['encrypt', 'decrypt']
        );
    }

    /**
     * Hash the authKey on the server side (simulated here for local testing).
     * In production, this runs in the Worker — NOT the client.
     * SHA-256 of the raw authKey hex.
     */
    async function hashAuthKey(authKeyHex) {
        const buf = encoder.encode(authKeyHex);
        const hash = await crypto.subtle.digest('SHA-256', buf);
        return bufToHex(hash);
    }

    // --- Vault Serialization ---

    /**
     * Encrypt the entire app state into a vault blob.
     */
    async function encryptVault(encKey, appState) {
        return encrypt(encKey, JSON.stringify(appState));
    }

    /**
     * Decrypt a vault blob back into app state.
     */
    async function decryptVault(encKey, vaultBlob) {
        const json = await decrypt(encKey, vaultBlob.ciphertext, vaultBlob.iv);
        return JSON.parse(json);
    }

    // --- Public API ---
    return {
        deriveKeys,
        encrypt,
        decrypt,
        generateRecoveryKit,
        recoverEncKey,
        hashAuthKey,
        encryptVault,
        decryptVault,
        bufToHex,
        hexToBuf,
        bufToBase64,
        base64ToBuf,
        formatRecoveryKey,
        parseRecoveryKey,
    };
})();
