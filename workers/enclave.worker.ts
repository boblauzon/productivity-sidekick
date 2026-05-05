// ─── Web Worker Enclave (stub) ─────────────────────────────────────────────────
// This file documents the protocol contract the worker must satisfy. The
// production worker — which holds the encryption key derived from the user's
// passphrase and talks to Cloudflare D1 over an authenticated channel — is
// out of scope for the staging UI handoff and lives in a separate package.
//
// What this stub guarantees today:
//   • The message protocol is wired end-to-end so the UI can be developed
//     against a worker that *does not yet hold real data*.
//   • Every RPC kind the bridge can send has a matching handler entry, and
//     each entry rejects with a clearly-coded error rather than fabricating
//     fake data.
//   • Importantly, the stub never returns a fake task or resource. If the UI
//     accidentally ships against this stub, the empty state is the only
//     thing the user will see — that is the correct safe default.
//
// What the production worker will add:
//   • Argon2id key derivation from the unlock passphrase
//   • AES-GCM record encryption with per-record nonces
//   • Authenticated upload to D1 via a Cloudflare Worker on the edge
//   • Local IndexedDB cache of *ciphertext only* (never plaintext)
//   • Cross-tab broadcast via BroadcastChannel after writes

/* eslint-disable @typescript-eslint/no-explicit-any */

interface IncomingMessage { id: string; req: { kind: string; [k: string]: any } }

interface OutgoingOk  { id: string; ok: true;  data: unknown }
interface OutgoingErr { id: string; ok: false; error: { code: string; message: string } }

const ctx: DedicatedWorkerGlobalScope = self as any;

function reply(_id: string, payload: OutgoingOk | OutgoingErr): void {
  ctx.postMessage(payload);
}

function notImplemented(id: string, kind: string): void {
  reply(id, {
    id,
    ok: false,
    error: {
      code: 'WORKER_STUB',
      message: `Enclave worker stub: "${kind}" is not implemented in the staging build. ` +
               `Connect the production enclave package before exercising this path.`,
    },
  });
}

ctx.addEventListener('message', (ev: MessageEvent<IncomingMessage>) => {
  const { id, req } = ev.data || ({} as IncomingMessage);
  if (!id || !req || typeof req.kind !== 'string') return;

  switch (req.kind) {
    // List operations resolve with empty arrays — the UI's empty states are
    // the canonical "no data yet" experience and must work without records.
    case 'task.list':      return reply(id, { id, ok: true, data: [] });
    case 'resource.list':  return reply(id, { id, ok: true, data: [] });
    case 'sessions.list':  return reply(id, { id, ok: true, data: [] });

    // Mutations explicitly reject — refusing here surfaces wiring bugs loudly
    // instead of silently fabricating records the UI would then display.
    case 'task.create':
    case 'task.update':
    case 'task.delete':
    case 'subtask.toggle':
    case 'subtask.add':
    case 'subtask.remove':
    case 'resource.create':
    case 'resource.update':
    case 'resource.delete':
    case 'resource.linkTask':
    case 'session.record':
      return notImplemented(id, req.kind);

    default:
      return reply(id, {
        id,
        ok: false,
        error: { code: 'UNKNOWN_KIND', message: `Unknown request kind: ${String(req.kind)}` },
      });
  }
});

export {}; // ensure module scope
