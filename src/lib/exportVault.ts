// ─── Export Vault ──────────────────────────────────────────────────────────────
// PR-1: The Parachute.
//
// User clicks "Download backup" in Settings → Data. We assemble a plaintext
// JSON envelope containing every task and every resource in the live vault,
// wrap it with metadata, and trigger a browser download.
//
// Why this is the parachute:
//   The worker enclave migration (PR-4) is the highest-risk change in the
//   PR sequence. If it ships with a subtle byte-incompatibility, every
//   existing user's vault stops decrypting. A local plaintext backup is the
//   deterministic rollback path: import (PR-8) can rebuild the vault from
//   this file even if the encrypted vault on the server is unrecoverable.
//
// Format envelope (`ps-export-v1`) is intentionally separate from the
// internal vault format (`v2` from vaultMapper.ts) so the two can evolve
// independently. If we ever ship encrypted-export-with-passphrase, that
// becomes `ps-export-v2` while the vault block stays the same shape.
//
// What's included: tasks + resources. That's everything currently persisted
// to the vault. UI preferences and focus session history live in React
// state and the bridge's in-memory cache respectively — neither crosses
// to the encrypted store today, so neither can be in the backup.
// Persisting those is a separate PR.
//
// What's NOT included: nothing encrypted, nothing keyed. This file is
// plaintext by design — that's what makes it a parachute. The download
// description in the UI tells the user to treat it like a password.

import type { Task, Resource } from './types';
import { serializeVault, type VaultV2 } from './vaultMapper';

export const EXPORT_FORMAT_VERSION = 'ps-export-v1' as const;

export interface ExportPayload {
  format: typeof EXPORT_FORMAT_VERSION;
  exportedAt: string;       // ISO 8601 UTC
  exportedBy: string;       // email; helps the user identify which account
  appVersion: string;       // e.g. "1.3.0+ac2ca53" — pinpoints which build wrote this
  vault: VaultV2;
}

/**
 * Pure builder. Easy to unit test, no side effects, deterministic given
 * the same inputs (modulo the timestamp).
 */
export function buildExportPayload(
  tasks: Task[],
  resources: Resource[],
  email: string,
): ExportPayload {
  return {
    format: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: email,
    appVersion: __APP_VERSION__,
    vault: serializeVault(tasks, resources),
  };
}

/**
 * Filename stamp: YYYY-MM-DD-HHMM in local time. Local rather than UTC so
 * "I exported this at 4pm" matches the filename a user sees in their
 * Downloads folder. Multiple exports in the same minute are extremely
 * rare for a manual user action — if it happens, the second download
 * lands with the same name and the browser appends " (1)" itself.
 */
function timestampForFilename(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/**
 * Triggers a browser download of the payload as pretty-printed JSON.
 * Returns the filename that was downloaded (useful for confirmation UI).
 *
 * Caller is responsible for catching errors. JSON.stringify is synchronous
 * and blocks the main thread; on a several-thousand-task vault this might
 * be a noticeable hitch but is fine for beta scale.
 */
export function downloadVaultBackup(payload: ExportPayload): string {
  const filename = `productivity-sidekick-backup-${timestampForFilename()}.json`;
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    // Some browsers require the anchor to be in the DOM for the click to fire.
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    // Always release the object URL — leaving it around leaks memory until
    // tab close. Wrapped in finally so we release even on a thrown error.
    URL.revokeObjectURL(url);
  }
  return filename;
}

// ─── Import ───────────────────────────────────────────────────────────────────

export interface ImportSummary {
  payload: ExportPayload;
  taskCount: number;
  resourceCount: number;
}

/**
 * Reads and validates a ps-export-v1 JSON file selected by the user.
 * Throws a user-readable Error if the file is malformed or the wrong format.
 */
export async function parseImportFile(file: File): Promise<ImportSummary> {
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('File is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid backup file.');
  const obj = parsed as Record<string, unknown>;
  if (obj.format !== EXPORT_FORMAT_VERSION) {
    throw new Error(`Unrecognised format "${String(obj.format ?? 'unknown')}". Expected "${EXPORT_FORMAT_VERSION}".`);
  }
  if (typeof obj.vault !== 'object' || obj.vault === null) throw new Error('Backup file is missing vault data.');
  const vault = obj.vault as Record<string, unknown>;
  if (vault.format !== 'v2') throw new Error('Vault data format not recognised.');
  return {
    payload: parsed as ExportPayload,
    taskCount: Array.isArray(vault.tasks) ? vault.tasks.length : 0,
    resourceCount: Array.isArray(vault.resources) ? vault.resources.length : 0,
  };
}

/**
 * Merges an imported vault into the current vault.
 * - Tasks:     newer updatedAt wins on ID conflict.
 * - Resources: imported wins on ID conflict (Resource has no updatedAt).
 * Items present in only one vault are always included.
 */
export function mergeVaults(existing: VaultV2, imported: VaultV2): VaultV2 {
  const taskMap = new Map<string, Task>();
  for (const t of existing.tasks) taskMap.set(t.id, t);
  for (const t of imported.tasks) {
    const ex = taskMap.get(t.id);
    if (!ex || t.updatedAt >= ex.updatedAt) taskMap.set(t.id, t);
  }

  const resourceMap = new Map<string, Resource>();
  for (const r of existing.resources) resourceMap.set(r.id, r);
  for (const r of imported.resources) resourceMap.set(r.id, r);

  return {
    format: 'v2',
    tasks: Array.from(taskMap.values()),
    resources: Array.from(resourceMap.values()),
  };
}
