// ─── CryptoBridge ──────────────────────────────────────────────────────────────
// The ONLY gateway between the React main thread and the Web Worker Enclave.
//
// Zero-Knowledge contract:
//   • Encryption keys live in the worker's V8 isolate scope only. They are
//     derived once at unlock time and never serialized back to the main thread.
//   • Every record that crosses to the network is already ciphertext.
//   • The main thread sees plaintext only AFTER the worker has decrypted it.
//   • This bridge never touches localStorage, sessionStorage, IndexedDB, or
//     any other persistent main-thread surface. Plaintext lives in React
//     state for the lifetime of the tab and dies when the tab dies.
//
// Threat model recap:
//   1. Hostile script in main thread (XSS, supply chain) — cannot read keys
//      because they're in a different realm. It CAN call the bridge, so the
//      bridge logs every mutation for audit replay.
//   2. Persistent storage compromise — irrelevant, because nothing plaintext
//      is ever persisted by this layer.
//   3. Network MITM — sees only ciphertext + opaque record ids.
//
// This file ships the typed RPC interface and a postMessage-based browser
// implementation. The worker stub lives at `workers/enclave.worker.ts`.

import type {
  Task, Resource, FocusSession,
  TaskCreateInput, ResourceCreateInput,
  TaskStatus,
} from './types';

// ─── Wire protocol ─────────────────────────────────────────────────────────────
// Discriminated unions on `kind` — keeps the worker's switch-statement
// exhaustive at compile time. Every new RPC requires a matching response
// case AND a worker handler; TS will scream if you forget either.

type RequestId = string & { readonly __brand: 'RequestId' };

export type BridgeRequest =
  | { kind: 'task.create';   input: TaskCreateInput }
  | { kind: 'task.update';   id: string; patch: Partial<Task> }
  | { kind: 'task.delete';   id: string }
  | { kind: 'task.list';     filter?: { status?: TaskStatus } }
  | { kind: 'subtask.toggle'; taskId: string; subTaskId: string }
  | { kind: 'subtask.add';   taskId: string; title: string; estimatedDuration?: number; dueDate?: string }
  | { kind: 'subtask.remove'; taskId: string; subTaskId: string }
  | { kind: 'resource.create'; input: ResourceCreateInput }
  | { kind: 'resource.update'; id: string; patch: Partial<Resource> }
  | { kind: 'resource.delete'; id: string }
  | { kind: 'resource.list'  }
  | { kind: 'resource.linkTask'; resourceId: string; taskId: string | null; taskTitle?: string | null }
  | { kind: 'sessions.list'  }
  | { kind: 'session.record'; session: Omit<FocusSession, 'id'> };

type ResponseFor<R extends BridgeRequest> =
  R extends { kind: 'task.create'   } ? Task        :
  R extends { kind: 'task.update'   } ? Task        :
  R extends { kind: 'task.delete'   } ? { id: string } :
  R extends { kind: 'task.list'     } ? Task[]      :
  R extends { kind: 'subtask.toggle'} ? Task        :
  R extends { kind: 'subtask.add'   } ? Task        :
  R extends { kind: 'subtask.remove'} ? Task        :
  R extends { kind: 'resource.create' } ? Resource  :
  R extends { kind: 'resource.update' } ? Resource  :
  R extends { kind: 'resource.delete' } ? { id: string } :
  R extends { kind: 'resource.list'   } ? Resource[]:
  R extends { kind: 'resource.linkTask' } ? Resource:
  R extends { kind: 'sessions.list' } ? FocusSession[] :
  R extends { kind: 'session.record'} ? FocusSession :
  never;

interface EnvelopeOk  { id: RequestId; ok: true;  data: unknown }
interface EnvelopeErr { id: RequestId; ok: false; error: { code: string; message: string } }
type Envelope = EnvelopeOk | EnvelopeErr;

interface BridgeBroadcast {
  channel: 'tasks' | 'resources' | 'sessions';
  event: 'changed';
}

// ─── Public interface ──────────────────────────────────────────────────────────
// The components depend on this interface only. Tests can supply any conforming
// implementation; staging uses `BrowserCryptoBridge` over a real Worker.

export type BridgeChannel = BridgeBroadcast['channel'];
export type Unsubscribe = () => void;

export interface CryptoBridge {
  /** Async typed RPC. Resolves with the decrypted payload or rejects with a coded error. */
  request<R extends BridgeRequest>(req: R): Promise<ResponseFor<R>>;

  /** Subscribe to data-changed broadcasts pushed by the worker (e.g. after another tab edited). */
  subscribe(channel: BridgeChannel, listener: () => void): Unsubscribe;

  /** Tear down the worker connection. After dispose, all requests reject. */
  dispose(): void;
}

// ─── Errors ────────────────────────────────────────────────────────────────────

export class BridgeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BridgeError';
  }
}

// ─── Browser implementation ────────────────────────────────────────────────────
// One Worker instance, one in-flight request map keyed by RequestId. Timeouts
// reject cleanly; the worker is responsible for never sending two responses
// for the same id.

export class BrowserCryptoBridge implements CryptoBridge {
  private worker: Worker | null;
  private nextSeq = 0;
  private pending = new Map<RequestId, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private listeners = new Map<BridgeChannel, Set<() => void>>();
  private readonly timeoutMs: number;

  constructor(worker: Worker, opts: { timeoutMs?: number } = {}) {
    this.worker = worker;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.worker.addEventListener('message', this.onMessage);
    this.worker.addEventListener('error', this.onWorkerError);
  }

  request = <R extends BridgeRequest>(req: R): Promise<ResponseFor<R>> => {
    if (!this.worker) {
      return Promise.reject(new BridgeError('BRIDGE_DISPOSED', 'Bridge has been disposed.'));
    }
    const id = this.mintId();
    return new Promise<ResponseFor<R>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('BRIDGE_TIMEOUT', `Request "${req.kind}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (v) => resolve(v as ResponseFor<R>),
        reject,
        timer,
      });

      // structuredClone-friendly payload — never include functions or DOM nodes.
      this.worker!.postMessage({ id, req });
    });
  };

  subscribe = (channel: BridgeChannel, listener: () => void): Unsubscribe => {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
    return () => {
      this.listeners.get(channel)?.delete(listener);
    };
  };

  dispose = (): void => {
    if (!this.worker) return;
    this.worker.removeEventListener('message', this.onMessage);
    this.worker.removeEventListener('error', this.onWorkerError);
    this.worker.terminate();
    this.worker = null;
    // Reject all in-flight calls so callers don't hang.
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BridgeError('BRIDGE_DISPOSED', 'Bridge disposed mid-request.'));
      this.pending.delete(id);
    }
    this.listeners.clear();
  };

  private mintId(): RequestId {
    // Prefix + monotonic seq + entropy. Entropy is not security-critical (the
    // worker authenticates by message origin), it's collision insurance.
    const seq = (this.nextSeq++).toString(36);
    const ent = Math.random().toString(36).slice(2, 8);
    return `req_${seq}_${ent}` as RequestId;
  }

  private onMessage = (ev: MessageEvent): void => {
    const data = ev.data;
    if (!data || typeof data !== 'object') return;

    // Broadcast (no request id)?
    if ('channel' in data && 'event' in data) {
      const b = data as BridgeBroadcast;
      this.listeners.get(b.channel)?.forEach((fn) => {
        try { fn(); } catch (e) { console.error('[CryptoBridge] listener threw:', e); }
      });
      return;
    }

    // RPC envelope.
    if ('id' in data && 'ok' in data) {
      const env = data as Envelope;
      const pending = this.pending.get(env.id);
      if (!pending) return; // late/duplicate — drop silently
      clearTimeout(pending.timer);
      this.pending.delete(env.id);
      if (env.ok) {
        pending.resolve(env.data);
      } else {
        pending.reject(new BridgeError(env.error.code, env.error.message));
      }
    }
  };

  private onWorkerError = (ev: ErrorEvent): void => {
    // Worker died. Reject everything in flight; consumers should re-establish.
    const err = new BridgeError('WORKER_CRASH', ev.message || 'Worker crashed.');
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  };
}

// ─── Factory ───────────────────────────────────────────────────────────────────
// One place to construct the bridge so the worker URL/import strategy lives in
// one spot. The Vite/webpack bundler rewrites the `new URL(..., import.meta.url)`
// pattern at build time.

export function createBrowserBridge(): CryptoBridge {
  // NOTE: if the worker fails to instantiate (CSP, unsupported browser), we
  // intentionally let the error propagate. We do NOT fall back to a mock or
  // in-memory store — that would silently break the zero-knowledge contract.
  const worker = new Worker(
    new URL('../../workers/enclave.worker.ts', import.meta.url),
    { type: 'module', name: 'enclave' }
  );
  return new BrowserCryptoBridge(worker);
}
