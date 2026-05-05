// ─── Auth API Client ───────────────────────────────────────────────────────────
// Typed wrapper around /api/auth/* and /api/vault endpoints.
// Crypto operations run on the main thread for the staging build; the
// production worker migration will move key material inside the enclave.

import { deriveKeys, generateRecoveryKit, recoverEncKey, decryptVault, encryptVault } from './crypto';
import type { RecoveryBlob } from './crypto';

export interface AuthSession {
  email: string;
  encKey: CryptoKey;
  token: string;
  userId: string;
}

const API_BASE = '/api';

async function apiFetch(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

  const resp = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  let data: Record<string, unknown>;
  try {
    data = (await resp.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON body — likely a 404 HTML page or empty response from a misconfigured route.
    throw new Error(`Server error (${resp.status} ${resp.statusText || 'No response'}). Check that the API function is deployed.`);
  }
  if (!resp.ok) throw new Error((data.error as string | undefined) ?? `Request failed (${resp.status})`);
  return data;
}

// ─── Auth operations ──────────────────────────────────────────────────────────

export async function login(email: string, password: string): Promise<AuthSession> {
  const emailClean = email.toLowerCase().trim();
  const { encKey, authKeyHex } = await deriveKeys(password, emailClean);
  // JS strings are GC-managed and can't be zeroed; clearing the local ref
  // minimises the window during which the password is reachable on the stack.
  password = '';

  const result = await apiFetch('/auth/login', {
    method: 'POST',
    body: { email: emailClean, authKeyHex },
  });

  return {
    email: emailClean,
    encKey,
    token: result.token as string,
    userId: result.userId as string,
  };
}

export async function register(
  email: string,
  password: string,
  betaCode: string,
): Promise<{ session: AuthSession; recoveryKey: string }> {
  const emailClean = email.toLowerCase().trim();
  const { encKey, authKeyHex } = await deriveKeys(password, emailClean);
  password = '';
  const { recoveryKey, recoveryBlob } = await generateRecoveryKit(encKey);

  const result = await apiFetch('/auth/register', {
    method: 'POST',
    body: { email: emailClean, authKeyHex, recoveryBlob, betaCode },
  });

  return {
    session: {
      email: emailClean,
      encKey,
      token: result.token as string,
      userId: result.userId as string,
    },
    recoveryKey,
  };
}

export async function loadVault(
  session: AuthSession,
): Promise<{ data: unknown | null; version: number }> {
  const result = await apiFetch('/vault', { token: session.token });
  const version = (result.version as number) ?? 0;
  if (!result.vault) return { data: null, version };
  const data = await decryptVault(session.encKey, result.vault as { ciphertext: string; iv: string });
  return { data, version };
}

export async function saveVaultBlob(
  token: string,
  vault: { ciphertext: string; iv: string },
  expectedVersion: number,
): Promise<{ version: number }> {
  const result = await apiFetch('/vault', {
    method: 'PUT',
    token,
    body: { vault, expectedVersion },
  });
  return { version: (result.version as number) ?? expectedVersion + 1 };
}

export async function saveVault(
  session: AuthSession,
  data: unknown,
  expectedVersion: number,
): Promise<{ version: number }> {
  const vault = await encryptVault(session.encKey, data);
  return saveVaultBlob(session.token, vault, expectedVersion);
}

export async function recoverAccount(
  email: string,
  recoveryKeyFormatted: string,
  newPassword: string,
): Promise<{ session: AuthSession; newRecoveryKey: string }> {
  const emailClean = email.toLowerCase().trim();

  const blobResult = await apiFetch('/auth/recover', {
    method: 'POST',
    body: { email: emailClean },
  });

  // Server returns null blob + null token for non-existent accounts to prevent
  // email enumeration. Treat it the same as an invalid recovery key.
  if (!blobResult.recoveryBlob || !blobResult.recoveryToken) {
    throw new Error('Invalid recovery key');
  }

  let encKey: CryptoKey;
  try {
    encKey = await recoverEncKey(recoveryKeyFormatted, blobResult.recoveryBlob as RecoveryBlob);
  } catch {
    throw new Error('Invalid recovery key');
  }

  const { authKeyHex: newAuthKeyHex } = await deriveKeys(newPassword, emailClean);
  newPassword = '';
  const { recoveryKey: newRecoveryKey, recoveryBlob: newRecoveryBlob } =
    await generateRecoveryKit(encKey);

  // Pass the server-issued recovery token — proves we went through /api/auth/recover.
  const updateResult = await apiFetch('/auth/update', {
    method: 'POST',
    body: { email: emailClean, newAuthKeyHex, newRecoveryBlob, recoveryToken: blobResult.recoveryToken },
  });

  return {
    session: {
      email: emailClean,
      encKey,
      token: updateResult.token as string,
      userId: updateResult.userId as string,
    },
    newRecoveryKey,
  };
}
