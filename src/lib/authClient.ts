// ─── Auth API Client ───────────────────────────────────────────────────────────
// Typed wrapper around /api/auth/* and /api/vault endpoints.
// Crypto operations run on the main thread for the staging build; the
// production worker migration will move key material inside the enclave.

import { deriveKeys, generateRecoveryKit, recoverEncKey } from './crypto';
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

  const data = (await resp.json()) as Record<string, unknown>;
  if (!resp.ok) throw new Error((data.error as string | undefined) ?? `Request failed (${resp.status})`);
  return data;
}

// ─── Auth operations ──────────────────────────────────────────────────────────

export async function login(email: string, password: string): Promise<AuthSession> {
  const emailClean = email.toLowerCase().trim();
  const { encKey, authKeyHex } = await deriveKeys(password, emailClean);

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

  let encKey: CryptoKey;
  try {
    encKey = await recoverEncKey(recoveryKeyFormatted, blobResult.recoveryBlob as RecoveryBlob);
  } catch {
    throw new Error('Invalid recovery key');
  }

  const { authKeyHex: newAuthKeyHex } = await deriveKeys(newPassword, emailClean);
  const { recoveryKey: newRecoveryKey, recoveryBlob: newRecoveryBlob } =
    await generateRecoveryKit(encKey);

  const updateResult = await apiFetch('/auth/update', {
    method: 'POST',
    body: { email: emailClean, newAuthKeyHex, newRecoveryBlob },
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
