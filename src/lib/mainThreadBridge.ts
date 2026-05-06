// ─── MainThreadCryptoBridge ────────────────────────────────────────────────────
// A real CryptoBridge implementation that runs on the main thread.
// Holds task/resource state in-memory; persists to the encrypted vault API
// after every mutation. Replaces the stub worker for the current build.
//
// Future: replace this with a production Web Worker enclave that does
// Argon2id + AES-GCM inside the worker isolate (PR-4).

import type { CryptoBridge, BridgeChannel, BridgeRequest, Unsubscribe } from './cryptoBridge';
import { BridgeError } from './cryptoBridge';
import type { Task, Resource, FocusSession, TaskCreateInput, ResourceCreateInput } from './types';
import { sanitizeUrl, safeDomain, sanitizeText } from './sanitize';
import { serializeVault } from './vaultMapper';

type SaveFn = (data: unknown) => Promise<void>;

/**
 * Constructor options for surfacing bridge state up to the React tree.
 *
 * Both callbacks are optional but PR-1.5 wires them in App.tsx so users can
 * SEE when their changes aren't being saved. Without these, save failures
 * (session expiry, network, OCC conflicts) are silently swallowed and the
 * user only finds out when they reload and discover lost work.
 */
export interface MainThreadCryptoBridgeOptions {
  /**
   * Fired when an encrypted vault save fails. Wired in App.tsx to surface
   * a non-dismissible banner.
   */
  onSaveError?: (err: Error) => void;
  /**
   * Fired the first time a save succeeds after a previous failure, so the
   * banner can clear.
   */
  onSaveRecovered?: () => void;
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Conditional type resolution helper — avoids `as any` at every call site.
type ResponseFor<R extends BridgeRequest> =
  R extends { kind: 'task.create'      } ? Task             :
  R extends { kind: 'task.update'      } ? Task             :
  R extends { kind: 'task.delete'      } ? { id: string }   :
  R extends { kind: 'task.list'        } ? Task[]           :
  R extends { kind: 'subtask.toggle'   } ? Task             :
  R extends { kind: 'subtask.add'      } ? Task             :
  R extends { kind: 'subtask.remove'   } ? Task             :
  R extends { kind: 'resource.create'  } ? Resource         :
  R extends { kind: 'resource.update'  } ? Resource         :
  R extends { kind: 'resource.delete'  } ? { id: string }   :
  R extends { kind: 'resource.list'    } ? Resource[]       :
  R extends { kind: 'resource.linkTask'} ? Resource         :
  R extends { kind: 'sessions.list'    } ? FocusSession[]   :
  R extends { kind: 'session.record'   } ? FocusSession     :
  never;

export class MainThreadCryptoBridge implements CryptoBridge {
  private tasks: Task[];
  private resources: Resource[];
  private sessions: FocusSession[] = [];
  private listeners = new Map<BridgeChannel, Set<() => void>>();
  private saveFn: SaveFn;
  private opts: MainThreadCryptoBridgeOptions;
  private inErrorState = false;
  private disposed = false;

  constructor(
    tasks: Task[],
    resources: Resource[],
    saveFn: SaveFn,
    opts: MainThreadCryptoBridgeOptions = {},
  ) {
    this.tasks = [...tasks];
    this.resources = [...resources];
    this.saveFn = saveFn;
    this.opts = opts;
  }

  request = async <R extends BridgeRequest>(req: R): Promise<ResponseFor<R>> => {
    if (this.disposed) {
      return Promise.reject(new BridgeError('BRIDGE_DISPOSED', 'Bridge disposed.'));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.handle(req) as any;
  };

  subscribe = (channel: BridgeChannel, listener: () => void): Unsubscribe => {
    let set = this.listeners.get(channel);
    if (!set) { set = new Set(); this.listeners.set(channel, set); }
    set.add(listener);
    return () => { this.listeners.get(channel)?.delete(listener); };
  };

  dispose = (): void => {
    this.disposed = true;
    this.listeners.clear();
  };

  // ── Handlers ────────────────────────────────────────────────────────────────

  private async handle(req: BridgeRequest): Promise<unknown> {
    switch (req.kind) {

      // ── Task reads ──────────────────────────────────────────────────────────
      case 'task.list': {
        const filter = req.filter;
        return filter?.status
          ? this.tasks.filter((t) => t.status === filter.status)
          : this.tasks;
      }

      // ── Task mutations ──────────────────────────────────────────────────────
      case 'task.create': {
        const input = req.input as TaskCreateInput;
        const task: Task = {
          id: uid(),
          title: sanitizeText(input.title, 200),
          energyLevel: input.energyLevel,
          bucket: input.bucket || 'Inbox',
          status: 'active',
          subTasks: [],
          blockers: [],
          relatedTasks: [],
          resourceLinks: [],
          metadata: input.estimatedTime ? { estimatedDuration: input.estimatedTime } : undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        this.tasks = [...this.tasks, task];
        await this.persist();
        this.broadcast('tasks');
        return task;
      }

      case 'task.update': {
        const patch = req.patch;
        this.tasks = this.tasks.map((t) =>
          t.id === req.id ? { ...t, ...patch, id: t.id, updatedAt: Date.now() } : t,
        );
        const updated = this.tasks.find((t) => t.id === req.id);
        if (!updated) throw new BridgeError('NOT_FOUND', `Task ${req.id} not found`);
        await this.persist();
        this.broadcast('tasks');
        return updated;
      }

      case 'task.delete': {
        this.tasks = this.tasks.filter((t) => t.id !== req.id);
        await this.persist();
        this.broadcast('tasks');
        return { id: req.id };
      }

      // ── Sub-task mutations ──────────────────────────────────────────────────
      case 'subtask.toggle': {
        this.tasks = this.tasks.map((t) =>
          t.id !== req.taskId ? t : {
            ...t,
            updatedAt: Date.now(),
            subTasks: t.subTasks.map((st) =>
              st.id === req.subTaskId ? { ...st, completed: !st.completed } : st,
            ),
          },
        );
        const updated = this.tasks.find((t) => t.id === req.taskId);
        if (!updated) throw new BridgeError('NOT_FOUND', `Task ${req.taskId} not found`);
        await this.persist();
        this.broadcast('tasks');
        return updated;
      }

      case 'subtask.add': {
        this.tasks = this.tasks.map((t) =>
          t.id !== req.taskId ? t : {
            ...t,
            updatedAt: Date.now(),
            subTasks: [...t.subTasks, {
              id: uid(),
              title: sanitizeText(req.title, 200),
              completed: false,
              estimatedDuration: req.estimatedDuration,
              dueDate: req.dueDate,
            }],
          },
        );
        const updated = this.tasks.find((t) => t.id === req.taskId);
        if (!updated) throw new BridgeError('NOT_FOUND', `Task ${req.taskId} not found`);
        await this.persist();
        this.broadcast('tasks');
        return updated;
      }

      case 'subtask.remove': {
        this.tasks = this.tasks.map((t) =>
          t.id !== req.taskId ? t : {
            ...t,
            updatedAt: Date.now(),
            subTasks: t.subTasks.filter((st) => st.id !== req.subTaskId),
          },
        );
        const updated = this.tasks.find((t) => t.id === req.taskId);
        if (!updated) throw new BridgeError('NOT_FOUND', `Task ${req.taskId} not found`);
        await this.persist();
        this.broadcast('tasks');
        return updated;
      }

      // ── Resource reads ──────────────────────────────────────────────────────
      case 'resource.list':
        return this.resources;

      // ── Resource mutations ──────────────────────────────────────────────────
      case 'resource.create': {
        const input = req.input as ResourceCreateInput;
        const safeUrl = sanitizeUrl(input.url);
        if (!safeUrl) throw new BridgeError('INVALID_INPUT', 'URL failed sanitization');
        const resource: Resource = {
          id: uid(),
          url: safeUrl,
          domain: safeDomain(safeUrl),
          title: sanitizeText(input.title ?? safeDomain(safeUrl), 200),
          description: input.description ? sanitizeText(input.description, 600) : undefined,
          type: input.type,
          bucket: input.bucket || 'Inbox',
          linkedTaskId: input.linkedTaskId ?? null,
          linkedTaskTitle: input.linkedTaskId
            ? (this.tasks.find((t) => t.id === input.linkedTaskId)?.title ?? null)
            : null,
          createdAt: Date.now(),
        };
        this.resources = [...this.resources, resource];
        await this.persist();
        this.broadcast('resources');
        return resource;
      }

      case 'resource.update': {
        this.resources = this.resources.map((r) =>
          r.id === req.id ? { ...r, ...req.patch, id: r.id } : r,
        );
        const updated = this.resources.find((r) => r.id === req.id);
        if (!updated) throw new BridgeError('NOT_FOUND', `Resource ${req.id} not found`);
        await this.persist();
        this.broadcast('resources');
        return updated;
      }

      case 'resource.delete': {
        this.resources = this.resources.filter((r) => r.id !== req.id);
        await this.persist();
        this.broadcast('resources');
        return { id: req.id };
      }

      case 'resource.linkTask': {
        const taskTitle = req.taskId
          ? (req.taskTitle ?? this.tasks.find((t) => t.id === req.taskId)?.title ?? null)
          : null;
        this.resources = this.resources.map((r) =>
          r.id !== req.resourceId ? r : {
            ...r,
            linkedTaskId: req.taskId,
            linkedTaskTitle: taskTitle,
          },
        );
        const updated = this.resources.find((r) => r.id === req.resourceId);
        if (!updated) throw new BridgeError('NOT_FOUND', `Resource ${req.resourceId} not found`);
        await this.persist();
        this.broadcast('resources');
        return updated;
      }

      // ── Sessions (read-only for now; PR-1.6 will persist these) ─────────────
      case 'sessions.list':
        return this.sessions;

      case 'session.record': {
        const session: FocusSession = { id: uid(), ...req.session };
        this.sessions = [...this.sessions, session];
        this.broadcast('sessions');
        return session;
      }

      default:
        throw new BridgeError('UNKNOWN_KIND', `Unknown request kind`);
    }
  }

  private broadcast(channel: BridgeChannel): void {
    this.listeners.get(channel)?.forEach((fn) => { try { fn(); } catch { /* ignored */ } });
  }

  /**
   * Persists the in-memory state to the encrypted vault API.
   *
   * Failure modes that callers MUST be told about:
   *   • 401 — session token expired (default 7-day TTL on the backend)
   *   • 409 — OCC version conflict (another tab/device wrote in between)
   *   • Network — offline, DNS failure, Cloudflare down
   *
   * The previous implementation logged to console and dropped the error,
   * which silently lost user data. This version surfaces the failure to
   * the React tree via the onSaveError callback, and clears it via
   * onSaveRecovered when the next save succeeds.
   *
   * Notes on what we DON'T log to the console:
   *   • The vault payload itself — that's plaintext task data
   *   • The error stack — error.message is enough for diagnosis and
   *     doesn't risk leaking surrounding context
   */
  private async persist(): Promise<void> {
    try {
      await this.saveFn(serializeVault(this.tasks, this.resources));
      if (this.inErrorState) {
        this.inErrorState = false;
        this.opts.onSaveRecovered?.();
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('[MainThreadBridge] vault save failed:', error.message);
      this.inErrorState = true;
      this.opts.onSaveError?.(error);
    }
  }
}
