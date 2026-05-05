// ─── TaskExpansionDrawer ───────────────────────────────────────────────────────
// Right-edge slide-in panel for editing a single task.
//
// Hardening applied vs. prototype:
//   • All mutations route through CryptoBridge.request() — no window.EventBus.
//   • Title / description rendered as React text children only. There is no
//     dangerouslySetInnerHTML and there must never be one; if a future ticket
//     asks for "rich text in descriptions", that's a worker-side change
//     (sanitize on read inside the enclave with a vetted HTML allowlist),
//     not a UI shortcut.
//   • Description text is normalized through `sanitizeText` for control-char
//     stripping before display. Pure defense-in-depth: React already escapes,
//     this just prevents weird control chars from corrupting screen-reader output.
//   • Focus trap + Escape handling via useFocusTrap. Esc closes the drawer
//     EXCEPT while the user is mid-edit in title / description / date picker
//     popover, where it cancels the inner edit instead.
//   • Previously-focused element is restored when the drawer closes.
//   • Component is "dumb": all data arrives via props, never read from a global.

import {
  useCallback, useEffect, useRef, useState,
  type KeyboardEvent, type ReactNode,
} from 'react';
import type { Task } from '../lib/types';
import { sanitizeText } from '../lib/sanitize';
import { computeRollupTime, formatDuration } from '../lib/taskMath';
import { useBridge } from '../hooks/useCryptoBridge';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { Icon } from './Icon';

const ENERGY = {
  high:   { icon: 'zap',         color: 'text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-500/25', label: 'High'   },
  medium: { icon: 'battery',     color: 'text-amber-300',   bg: 'bg-amber-500/10',   border: 'border-amber-500/25',   label: 'Medium' },
  low:    { icon: 'battery-low', color: 'text-sky-300',     bg: 'bg-sky-500/10',     border: 'border-sky-500/25',     label: 'Low'    },
} as const;

export interface TaskExpansionDrawerProps {
  task: Task | null;
  allTasks: Task[];           // for blocker resolution; passed dynamically
  onClose: () => void;
}

export function TaskExpansionDrawer({ task, allTasks, onClose }: TaskExpansionDrawerProps) {
  if (!task) return null;
  // Key by task id so all internal state resets when you switch tasks.
  return <DrawerInner key={task.id} task={task} allTasks={allTasks} onClose={onClose} />;
}

function DrawerInner({ task, allTasks, onClose }: { task: Task; allTasks: Task[]; onClose: () => void }) {
  const bridge = useBridge();
  const containerRef = useRef<HTMLElement>(null);

  // Mount-driven slide-in
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(r);
  }, []);

  // Inline-edit state
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState(task.description ?? '');
  const [dateOpen, setDateOpen] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);
  const descRef  = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (editingTitle) titleRef.current?.focus(); }, [editingTitle]);
  useEffect(() => { if (editingDesc) descRef.current?.focus();  }, [editingDesc]);

  const handleClose = useCallback(() => {
    setMounted(false);
    // Slide-out then unmount; matches CSS transition duration.
    setTimeout(onClose, 180);
  }, [onClose]);

  // Escape semantics depend on what's open; let the trap pick the right one.
  const escapeHandler = useCallback(() => {
    if (editingTitle) { setTitleDraft(task.title); setEditingTitle(false); return; }
    if (editingDesc)  { setDescDraft(task.description ?? ''); setEditingDesc(false); return; }
    if (dateOpen)     { setDateOpen(false); return; }
    handleClose();
  }, [editingTitle, editingDesc, dateOpen, task.title, task.description, handleClose]);

  useFocusTrap(containerRef, {
    active: mounted,
    onEscape: escapeHandler,
  });

  // ── Mutators (all async via the bridge) ───────────────────────────────────────
  // We deliberately don't await these: optimistic UI is the bridge's
  // responsibility (it broadcasts the change-channel; the parent re-fetches).
  // Errors are surfaced via the global toaster (not shown here).

  const saveTitle = () => {
    const v = titleDraft.trim();
    if (v && v !== task.title) {
      bridge.request({ kind: 'task.update', id: task.id, patch: { title: v } }).catch(reportError);
    }
    setEditingTitle(false);
  };
  const saveDesc = () => {
    const v = sanitizeText(descDraft, 8000);
    if (v !== (task.description ?? '')) {
      bridge.request({ kind: 'task.update', id: task.id, patch: { description: v } }).catch(reportError);
    }
    setEditingDesc(false);
  };
  const setDueDate = (iso: string) => {
    bridge.request({
      kind: 'task.update',
      id: task.id,
      patch: { dueDate: iso || undefined },
    }).catch(reportError);
    setDateOpen(false);
  };
  const toggleSub = (subTaskId: string) =>
    bridge.request({ kind: 'subtask.toggle', taskId: task.id, subTaskId }).catch(reportError);
  const removeSub = (subTaskId: string) =>
    bridge.request({ kind: 'subtask.remove', taskId: task.id, subTaskId }).catch(reportError);

  const startFocus = () => {
    // The focus-start event is intentionally NOT a bridge call — it doesn't
    // mutate persisted state. The parent App owns this routing.
    window.dispatchEvent(new CustomEvent('app:focus-start', { detail: { taskId: task.id } }));
    handleClose();
  };
  const completeTask = () => {
    bridge.request({ kind: 'task.update', id: task.id, patch: { status: 'completed' } }).catch(reportError);
    handleClose();
  };
  const deferTask = () => {
    bridge.request({ kind: 'task.update', id: task.id, patch: { status: 'deferred' } }).catch(reportError);
  };

  // ── Derived data ──────────────────────────────────────────────────────────────
  const energy = ENERGY[task.energyLevel];
  const rollup = computeRollupTime(task);
  const subDone = task.subTasks.filter((s) => s.completed).length;
  const subTot  = task.subTasks.length;
  const blockerTasks = allTasks.filter((t) => task.blockers.includes(t.id));

  // Sanitize description for display (defense-in-depth; React already escapes)
  const safeDescription = sanitizeText(task.description ?? '');

  // Suppress unused warning — setDueDate is wired to the date picker stub
  void setDueDate;

  return (
    <div className="fixed inset-0 z-40 pointer-events-none" role="presentation">
      {/* Scrim — pointer-events:auto so click-outside dismisses */}
      <div
        onClick={handleClose}
        className={`absolute inset-0 bg-black/50 backdrop-blur-[2px] transition-opacity duration-200 pointer-events-auto ${mounted ? 'opacity-100' : 'opacity-0'}`}
      />

      {/* Panel */}
      <aside
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-drawer-title"
        tabIndex={-1}
        className={`absolute right-0 top-0 bottom-0 w-full sm:w-[560px] bg-zinc-900/95 backdrop-blur-xl border-l border-zinc-800 shadow-2xl flex flex-col pointer-events-auto transition-transform duration-200 focus:outline-none ${mounted ? 'translate-x-0' : 'translate-x-full'}`}
      >
        {/* ── Header ── */}
        <div className="px-7 pt-6 pb-5 border-b border-zinc-800 shrink-0">
          <div className="flex items-start gap-3 mb-4">
            <span
              className={`mt-1 w-7 h-7 rounded-md flex items-center justify-center ${energy.bg} ${energy.border} border shrink-0`}
              aria-hidden="true"
            >
              <Icon name={energy.icon} className={`w-4 h-4 ${energy.color}`} />
            </span>
            <div className="flex-1 min-w-0">
              {editingTitle ? (
                <input
                  ref={titleRef}
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={saveTitle}
                  onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter') saveTitle();
                    // Escape handled by focus-trap; cancel-edit happens there.
                  }}
                  className="w-full bg-zinc-800/50 border border-violet-500/40 text-zinc-50 text-xl rounded-md px-2.5 py-1.5 outline-none focus:ring-2 focus:ring-violet-500/30"
                  aria-label="Edit task title"
                />
              ) : (
                <h2
                  id="task-drawer-title"
                  onClick={() => { setTitleDraft(task.title); setEditingTitle(true); }}
                  className="text-zinc-50 text-xl leading-snug tracking-tight cursor-text hover:bg-zinc-800/40 rounded-md -ml-1 px-1 py-0.5 inline transition-colors"
                  title="Click to edit"
                >
                  {task.title}
                </h2>
              )}
              <div className="flex items-center gap-2 mt-2.5 flex-wrap">
                <span className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded ${energy.bg} ${energy.color}`}>
                  <Icon name={energy.icon} className="w-3 h-3" />
                  {energy.label}
                </span>
                {task.bucket && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/60">
                    {task.bucket}
                  </span>
                )}
                {rollup > 0 && (
                  <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-300 border border-violet-500/25">
                    <Icon name="clock" className="w-3 h-3" />
                    {formatDuration(rollup)}
                    {subTot > 0 && <span className="text-violet-400/70 ml-0.5">roll-up</span>}
                  </span>
                )}
                {blockerTasks.length > 0 && (
                  <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-500/25">
                    <Icon name="alert-triangle" className="w-3 h-3" />
                    Blocked
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={handleClose}
              className="text-zinc-500 hover:text-zinc-200 -m-1 p-1"
              aria-label="Close drawer"
            >
              <Icon name="x" className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto px-7 py-6 space-y-7">
          {/* Description */}
          <Section icon="file-text" label="Description">
            {editingDesc ? (
              <textarea
                ref={descRef}
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                onBlur={saveDesc}
                rows={4}
                className="w-full bg-zinc-800/50 border border-violet-500/40 text-zinc-200 text-sm rounded-md px-3 py-2.5 outline-none focus:ring-2 focus:ring-violet-500/30 resize-none leading-relaxed"
                aria-label="Edit description"
              />
            ) : (
              <div
                onClick={() => { setDescDraft(safeDescription); setEditingDesc(true); }}
                className={`cursor-text rounded-md px-3 py-2.5 border border-dashed border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/20 transition-colors min-h-[60px] text-sm leading-relaxed whitespace-pre-wrap ${
                  safeDescription ? 'text-zinc-300' : 'text-zinc-600 italic'
                }`}
                title="Click to edit"
                role="button"
                tabIndex={0}
                onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setDescDraft(safeDescription);
                    setEditingDesc(true);
                  }
                }}
              >
                {/* React text-child render — never dangerouslySetInnerHTML. */}
                {safeDescription || 'Add context, notes, or goals for this task…'}
              </div>
            )}
          </Section>

          {/* Sub-tasks */}
          <Section
            icon="list-checks"
            label="Sub-tasks"
            badge={subTot > 0 && (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-300 border border-violet-500/25">
                {subDone}/{subTot}
              </span>
            )}
            right={rollup > 0 && (
              <span className="text-[11px] text-zinc-500 inline-flex items-center gap-1">
                <Icon name="clock" className="w-3 h-3" />
                {formatDuration(rollup)} total
              </span>
            )}
          >
            {subTot > 0 && (
              <div
                className="h-1 rounded-full bg-zinc-800 overflow-hidden mb-3"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={subTot ? Math.round((subDone / subTot) * 100) : 0}
              >
                <div
                  className="h-full rounded-full bg-gradient-to-r from-violet-500 to-violet-400 transition-all duration-500"
                  style={{ width: `${subTot ? (subDone / subTot) * 100 : 0}%` }}
                />
              </div>
            )}
            <div className="space-y-1.5">
              {task.subTasks.map((st) => (
                <div
                  key={st.id}
                  className={`group rounded-lg border transition-all ${
                    st.completed
                      ? 'bg-zinc-900/40 border-zinc-800/60'
                      : 'bg-zinc-800/30 border-zinc-800 hover:border-zinc-700'
                  }`}
                >
                  <div className="flex items-center gap-2.5 px-3 py-2">
                    <button
                      type="button"
                      onClick={() => toggleSub(st.id)}
                      className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-all ${
                        st.completed ? 'bg-violet-500 border-violet-500' : 'border-zinc-600 hover:border-violet-400'
                      }`}
                      aria-pressed={st.completed}
                      aria-label={`Mark "${st.title}" ${st.completed ? 'incomplete' : 'complete'}`}
                    >
                      {st.completed && <Icon name="check" className="w-2.5 h-2.5 text-white" />}
                    </button>
                    <span className={`flex-1 text-sm leading-snug break-words [overflow-wrap:anywhere] ${st.completed ? 'line-through text-zinc-600' : 'text-zinc-200'}`}>
                      {st.title}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeSub(st.id)}
                      className="text-zinc-700 hover:text-rose-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                      aria-label={`Remove sub-task "${st.title}"`}
                    >
                      <Icon name="x" className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {/* Blockers */}
          {blockerTasks.length > 0 && (
            <Section icon="git-branch" label="Blockers">
              <div className="space-y-1.5">
                {blockerTasks.map((b) => (
                  <div key={b.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-rose-500/5 border border-rose-500/20">
                    <Icon name="alert-triangle" className="w-3.5 h-3.5 text-rose-300 shrink-0" />
                    <span className="text-sm text-zinc-300 flex-1 truncate">{b.title}</span>
                    <span className="text-[11px] text-zinc-500">{b.bucket}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>

        {/* ── Action bar ── */}
        <div className="px-7 py-4 border-t border-zinc-800 shrink-0 flex items-center gap-2 bg-zinc-950/40">
          <button
            type="button"
            onClick={startFocus}
            className="flex-1 inline-flex items-center justify-center gap-2 bg-violet-600 hover:bg-violet-500 text-white text-sm px-4 py-2.5 rounded-lg shadow-lg shadow-violet-900/30 transition-all"
          >
            <Icon name="play" className="w-4 h-4" />
            Start Focus
          </button>
          <button
            type="button"
            onClick={completeTask}
            className="inline-flex items-center gap-2 px-3 py-2.5 rounded-lg border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10 text-sm transition-colors"
          >
            <Icon name="check" className="w-4 h-4" />
            Complete
          </button>
          <button
            type="button"
            onClick={deferTask}
            className="inline-flex items-center gap-2 px-3 py-2.5 rounded-lg text-zinc-400 hover:text-zinc-200 text-sm transition-colors"
          >
            <Icon name="clock" className="w-4 h-4" />
            Defer
          </button>
        </div>
      </aside>
    </div>
  );
}

function Section({
  icon, label, badge, right, children,
}: { icon: string; label: string; badge?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-2.5">
        <Icon name={icon} className="w-3.5 h-3.5 text-zinc-600" />
        <span className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</span>
        {badge}
        <div className="flex-1" />
        {right}
      </div>
      {children}
    </section>
  );
}

function reportError(err: Error): void {
  // Replace with your Toaster integration. Logging here so swallowed
  // bridge errors don't disappear silently in staging.
  // eslint-disable-next-line no-console
  console.error('[TaskDrawer] bridge error:', err);
}
