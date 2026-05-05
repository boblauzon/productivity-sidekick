// ─── Pure task math helpers ────────────────────────────────────────────────────
// Extracted from window.computeRollupTime / window.formatDuration / window.formatDateRel
// in the prototype. No side effects, no globals — safe to import anywhere.

import type { Task } from './types';

export function computeRollupTime(task: Pick<Task, 'subTasks' | 'metadata'>): number {
  if (task.subTasks?.length) {
    return task.subTasks.reduce((s, st) => s + (st.estimatedDuration ?? 0), 0);
  }
  return task.metadata?.estimatedDuration ?? 0;
}

export function formatDuration(min: number): string {
  if (!min || min <= 0) return '';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function formatDateRel(iso: string): string {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return `In ${diff}d`;
  if (diff < -1 && diff > -7) return `${-diff}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
