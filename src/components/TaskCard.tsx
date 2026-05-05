// ─── TaskCard ──────────────────────────────────────────────────────────────────
// The single most-rendered surface in the app: in dense Kanban view we can
// have 30+ cards on screen at once, and any prop drift up the tree (filter
// changes, drawer toggles) will re-render all of them without memoization.
//
// Performance contract:
//   • Wrapped in React.memo with a custom comparator that ignores object
//     identity on the `task` prop and instead compares the fields the card
//     actually renders. This is what lets the parent pass `tasks.map(...)`
//     output without forcing every card to re-render on a single edit.
//   • Handlers are received as props and assumed stable (parent must
//     useCallback them). We do not wrap them again here.
//
// Security / correctness:
//   • Everything renders as React text children — escaped automatically.
//   • No dangerouslySetInnerHTML anywhere.
//   • Title / bucket strings are sanitized at the bridge boundary, not here,
//     so the card stays "dumb" per the architecture spec.

import { memo, type KeyboardEvent, type MouseEvent } from 'react';
import type { Task } from '../lib/types';

// These two helpers used to live on `window`; they're pure and now imported.
import { computeRollupTime, formatDuration, formatDateRel } from '../lib/taskMath';

// Energy palette stays a const map — same tokens as the design prototype.
const ENERGY = {
  high:   { icon: 'zap',         color: 'text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-500/25', label: 'High'   },
  medium: { icon: 'battery',     color: 'text-amber-300',   bg: 'bg-amber-500/10',   border: 'border-amber-500/25',   label: 'Medium' },
  low:    { icon: 'battery-low', color: 'text-sky-300',     bg: 'bg-sky-500/10',     border: 'border-sky-500/25',     label: 'Low'    },
} as const;

export interface TaskCardProps {
  task: Task;
  /** Stable: useCallback in the parent. */
  onOpen: (taskId: string) => void;
  /** Stable: useCallback in the parent. */
  onStartFocus: (taskId: string) => void;
}

// Imported lazily where used — avoids pulling in the icon module if a page
// renders no cards.
import { Icon } from './Icon';

function TaskCardImpl({ task, onOpen, onStartFocus }: TaskCardProps) {
  const energy = ENERGY[task.energyLevel];
  const rollup = computeRollupTime(task);
  const subDone = task.subTasks.filter((s) => s.completed).length;
  const subTot  = task.subTasks.length;
  const subPct  = subTot > 0 ? Math.round((subDone / subTot) * 100) : 0;
  const blocked = task.blockers.length > 0;

  const pill      = 'inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-zinc-300 bg-zinc-800/50 whitespace-nowrap';
  const pillEnergy = `${pill} ${energy.color}`;
  const pillBlock = 'inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-rose-200 bg-rose-500/15 border border-rose-500/40 whitespace-nowrap';

  const handleOpen = () => onOpen(task.id);

  const handleEdit = (e: MouseEvent) => {
    e.stopPropagation();
    onOpen(task.id);
  };

  const handleStartFocus = (e: MouseEvent) => {
    e.stopPropagation();
    if (blocked) return;
    onStartFocus(task.id);
  };

  const handleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleOpen();
    }
  };

  return (
    <div
      onClick={handleOpen}
      onKeyDown={handleKey}
      role="button"
      tabIndex={0}
      aria-label={`Open task: ${task.title}`}
      className="group relative w-full text-left bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-xl px-4 pt-3.5 pb-3 cursor-pointer transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40"
    >
      {/* Energy accent stripe */}
      <span
        className={`absolute left-0 top-3 bottom-3 w-[3px] rounded-r ${energy.bg.replace('/10', '/40')}`}
        aria-hidden="true"
      />

      {/* Row 1 — Bucket / due date kicker */}
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[10.5px] uppercase tracking-[0.12em] font-medium text-zinc-400 truncate">
          {task.bucket || 'Inbox'}
        </span>
        {task.dueDate && (
          <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400 whitespace-nowrap">
            <Icon name="calendar" className="w-3 h-3 text-zinc-500" />
            {formatDateRel(task.dueDate)}
          </span>
        )}
      </div>

      {/* Row 2 — Title (2-line clamp keeps card heights even) */}
      <h3
        className="text-zinc-100 font-semibold text-[17px] leading-snug tracking-tight"
        style={{
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          overflowWrap: 'anywhere',
        }}
      >
        {task.title}
      </h3>

      {/* Row 3 — Sub-task progress */}
      {subTot > 0 && (
        <div className="mt-3 flex items-center gap-2.5">
          <div
            className="flex-1 h-1 rounded-full bg-zinc-800 overflow-hidden"
            role="progressbar"
            aria-valuenow={subPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Sub-tasks ${subDone} of ${subTot} complete`}
          >
            <div
              className="h-full bg-indigo-500 rounded-full transition-all duration-300"
              style={{ width: `${subPct}%` }}
            />
          </div>
          <span className="text-[10px] tabular-nums text-zinc-500 shrink-0">{subDone}/{subTot}</span>
        </div>
      )}

      {/* Row 4 — Metadata pills */}
      <div className="flex flex-wrap gap-2 mt-3">
        <span className={pillEnergy} title={`${energy.label} energy`}>
          <Icon name={energy.icon} className="w-3 h-3" />
          {energy.label}
        </span>
        {rollup > 0 && (
          <span className={pill} title="Estimated effort">
            <Icon name="clock" className="w-3 h-3 text-zinc-400" />
            {formatDuration(rollup)}
          </span>
        )}
        {subTot > 0 && (
          <span className={pill}>
            <Icon name="check-square" className="w-3 h-3 text-zinc-400" />
            {subDone}/{subTot} sub-tasks
          </span>
        )}
        {blocked && (
          <span className={pillBlock} title="Resolve blockers first">
            <Icon name="alert-triangle" className="w-3 h-3 text-rose-300" />
            Blocked
          </span>
        )}
      </div>

      {/* Row 5 — Action bar */}
      <div className="mt-3 pt-3 border-t border-zinc-800/80 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={handleEdit}
          className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[11px] text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 transition-all duration-150"
          aria-label="Open task details"
        >
          <Icon name="pencil" className="w-3 h-3" />
          Edit
        </button>
        <button
          type="button"
          onClick={handleStartFocus}
          disabled={blocked}
          aria-label={blocked ? 'Resolve blockers before starting focus' : 'Start a focus session'}
          className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-semibold transition-all duration-200 active:scale-95 whitespace-nowrap ${
            blocked
              ? 'bg-zinc-800/60 text-zinc-600 cursor-not-allowed'
              : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm shadow-indigo-900/40'
          }`}
        >
          <Icon name="play" className="w-3.5 h-3.5" />
          Start Focus
        </button>
      </div>
    </div>
  );
}

// ─── Memo comparator ───────────────────────────────────────────────────────────
// We compare the fields the card actually renders. This means a sibling task
// edit that produces a brand-new array reference will not re-render this
// instance — only an edit to *this* task will. Handler identity is assumed
// stable; if a caller passes inline arrows, they pay the re-render cost
// (correct behaviour: bug in the caller, not this component).

function areEqual(prev: TaskCardProps, next: TaskCardProps): boolean {
  if (prev.onOpen !== next.onOpen || prev.onStartFocus !== next.onStartFocus) return false;
  const a = prev.task, b = next.task;
  if (a === b) return true;
  if (a.id !== b.id) return false;
  if (a.title !== b.title) return false;
  if (a.bucket !== b.bucket) return false;
  if (a.energyLevel !== b.energyLevel) return false;
  if (a.dueDate !== b.dueDate) return false;
  if (a.status !== b.status) return false;
  if (a.subTasks.length !== b.subTasks.length) return false;
  if (a.blockers.length !== b.blockers.length) return false;
  // Sub-task completion + duration drives the progress bar + rollup pill.
  for (let i = 0; i < a.subTasks.length; i++) {
    const sa = a.subTasks[i], sb = b.subTasks[i];
    if (sa.id !== sb.id) return false;
    if (sa.completed !== sb.completed) return false;
    if (sa.estimatedDuration !== sb.estimatedDuration) return false;
  }
  if (a.metadata?.estimatedDuration !== b.metadata?.estimatedDuration) return false;
  return true;
}

export const TaskCard = memo(TaskCardImpl, areEqual);
