// ─── Zero-Knowledge Crypto (TypeScript port of v1.40 crypto.js) ───────────────
// Algorithms must match exactly — changing any constant breaks existing vaults.
//
// Architecture:
//   password + email(salt)
//     → PBKDF2 (600k iter, SHA-256) → masterKey (256-bit)
//       → HKDF("ps-auth-key")  → authKey   (sent to server as hex)
//       → HKDF("ps-enc-key")   → encKey    (never leaves client)
//
// Recovery kit:
//   16 random bytes → formatted as XXXX-XXXX-...-XXXX (8 groups)
//     → HKDF("ps-recovery-wrap") → wrapKey
//       → AES-GCM-wrap(encKey)   → recoveryBlob stored server-side

const PBKDF2_ITERATIONS = 600_000;
const AES_KEY_BITS = 256;
const IV_BYTES = 12;
const SALT_INFO_AUTH = 'ps-auth-key';
const SALT_INFO_ENC = 'ps-enc-key';
const SALT_INFO_RECOVERY = 'ps-recovery-wrap';

const encoder = new TextEncoder();

// enc() produces a new Uint8Array<ArrayBuffer>, avoiding the Uint8Array<ArrayBufferLike>
// issue with TextEncoder.encode() in TypeScript 5.6.
function enc(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(encoder.encode(s));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Accept both ArrayBuffer and Uint8Array to avoid TS5.6 strict buffer typing.
export function bufToHex(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBuf(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex length');
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    arr[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return arr;
}

export function bufToBase64(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64ToBuf(b64: string): Uint8Array<ArrayBuffer> {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + '='.repeat(pad));
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return arr;
}

function formatRecoveryKey(buf: Uint8Array): string {
  return bufToHex(buf).match(/.{4}/g)!.join('-').toUpperCase();
}

function parseRecoveryKey(formatted: string): Uint8Array<ArrayBuffer> {
  const hex = formatted.replace(/-/g, '').toLowerCase();
  if (hex.length !== 32) throw new Error('Recovery key must be 32 hex chars (128 bits)');
  return hexToBuf(hex);
}

// ─── Core derivation ──────────────────────────────────────────────────────────

async function deriveMasterKey(password: string, email: string): Promise<CryptoKey> {
  const salt = enc(email.toLowerCase().trim());
  // We can't zero the password STRING (immutable, GC-managed), but we CAN
  // zero the byte buffer derived from it. Doesn't help if the engine kept
  // an internal copy, but it reduces the immediate heap surface area.
  // Caller in authClient.ts also reassigns the source string to '' to drop
  // its reference — this is a defense-in-depth pair.
  const passwordBytes = enc(password);
  try {
    const passwordKey = await crypto.subtle.importKey(
      'raw', passwordBytes, 'PBKDF2', false, ['deriveBits'],
    );
    const masterBits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      passwordKey,
      AES_KEY_BITS,
    );
    return crypto.subtle.importKey('raw', masterBits, 'HKDF', false, ['deriveBits', 'deriveKey']);
  } finally {
    passwordBytes.fill(0);
  }
}

async function hkdfDeriveKey(masterKey: CryptoKey, info: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc(info) },
    masterKey,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    true,
    usage,
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface DerivedKeys {
  encKey: CryptoKey;
  authKeyHex: string;
}

export async function deriveKeys(password: string, email: string): Promise<DerivedKeys> {
  const masterKey = await deriveMasterKey(password, email);
  const authKey = await hkdfDeriveKey(masterKey, SALT_INFO_AUTH, ['encrypt', 'decrypt']);
  const encKey  = await hkdfDeriveKey(masterKey, SALT_INFO_ENC,  ['encrypt', 'decrypt']);
  const authKeyRaw = await crypto.subtle.exportKey('raw', authKey);
  return { encKey, authKeyHex: bufToHex(authKeyRaw) };
}

export interface RecoveryBlob {
  ciphertext: string;
  iv: string;
}

export interface RecoveryKit {
  recoveryKey: string;
  recoveryBlob: RecoveryBlob;
}

export async function generateRecoveryKit(encKey: CryptoKey): Promise<RecoveryKit> {
  const recoveryRandom = crypto.getRandomValues(new Uint8Array(16));
  const recoveryKey = formatRecoveryKey(recoveryRandom);

  const hkdfKey = await crypto.subtle.importKey('raw', recoveryRandom, 'HKDF', false, ['deriveKey']);
  const wrapKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc(SALT_INFO_RECOVERY) },
    hkdfKey,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    false,
    ['encrypt'],
  );

  const encKeyRaw = await crypto.subtle.exportKey('raw', encKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, encKeyRaw);

  return {
    recoveryKey,
    recoveryBlob: { ciphertext: bufToBase64(cipherBuf), iv: bufToBase64(iv) },
  };
}

export async function encryptVault(
  encKey: CryptoKey,
  data: unknown,
): Promise<{ ciphertext: string; iv: string }> {
  const payload = enc(typeof data === 'string' ? data : JSON.stringify(data));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encKey, payload);
  return { ciphertext: bufToBase64(cipherBuf), iv: bufToBase64(iv) };
}

export async function decryptVault(
  encKey: CryptoKey,
  vaultBlob: { ciphertext: string; iv: string },
): Promise<unknown> {
  const cipherBuf = base64ToBuf(vaultBlob.ciphertext);
  const ivBuf     = base64ToBuf(vaultBlob.iv);
  const plainBuf  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBuf }, encKey, cipherBuf);
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

export async function recoverEncKey(
  recoveryKeyFormatted: string,
  recoveryBlob: RecoveryBlob,
): Promise<CryptoKey> {
  const recoveryRandom = parseRecoveryKey(recoveryKeyFormatted);
  const hkdfKey = await crypto.subtle.importKey('raw', recoveryRandom, 'HKDF', false, ['deriveKey']);
  const unwrapKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc(SALT_INFO_RECOVERY) },
    hkdfKey,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    false,
    ['decrypt'],
  );

  const cipherBuf = base64ToBuf(recoveryBlob.ciphertext);
  const ivBuf     = base64ToBuf(recoveryBlob.iv);
  const encKeyRaw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBuf }, unwrapKey, cipherBuf);

  return crypto.subtle.importKey(
    'raw', encKeyRaw, { name: 'AES-GCM', length: AES_KEY_BITS }, true, ['encrypt', 'decrypt'],
  );
}
