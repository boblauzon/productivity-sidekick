// ─── Vault Mapper ──────────────────────────────────────────────────────────────
// Maps the v1.40 vault format (links[]) to the new Task[]/Resource[] types.
// Called once after vault decryption; the result is passed to Shell as props.
//
// v1.40 vault shape:
//   { schemaVersion: 5, links: LegacyLink[], categories: string[], ... }
//
// LegacyLink fields we care about:
//   id, name, description, category, priority, isCompleted, isActionable,
//   dueDate, estMinutes, subtasks, resources

import type { Task, Resource, ResourceType } from './types';
import { sanitizeUrl, safeDomain, sanitizeText } from './sanitize';

// ─── Legacy shapes ────────────────────────────────────────────────────────────

interface LegacySubTask {
  id?: string;
  title: string;
  estMinutes?: number;
  isCompleted: boolean;
}

interface LegacyResource {
  title?: string;
  url: string;
}

interface LegacyLink {
  id: string;
  name: string;
  description?: string;
  category?: string;
  priority?: '' | 'high' | 'med' | 'low';
  isCompleted?: boolean;
  isActionable?: boolean;
  dueDate?: string;
  estMinutes?: number;
  subtasks?: LegacySubTask[];
  resources?: LegacyResource[];
}

interface LegacyVault {
  schemaVersion?: number;
  links?: LegacyLink[];
  categories?: string[];
}

// ─── Mapping ──────────────────────────────────────────────────────────────────

const PRIORITY_TO_ENERGY: Record<string, Task['energyLevel']> = {
  high: 'high',
  med: 'medium',
  low: 'low',
  '': 'medium',
};

function mapLinkToTask(link: LegacyLink, now: number): Task {
  const subTasks = (link.subtasks ?? []).map((st, i) => ({
    id: st.id ?? `${link.id}-st-${i}`,
    title: sanitizeText(st.title, 200),
    completed: !!st.isCompleted,
    estimatedDuration: st.estMinutes || undefined,
  }));

  const resourceLinks = (link.resources ?? [])
    .map((r, i) => {
      const safe = sanitizeUrl(r.url);
      if (!safe) return null;
      return { id: `${link.id}-res-${i}`, url: safe, title: sanitizeText(r.title ?? safe, 200) };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  return {
    id: link.id,
    title: sanitizeText(link.name || 'Untitled', 200),
    description: link.description ? sanitizeText(link.description, 4000) : undefined,
    energyLevel: PRIORITY_TO_ENERGY[link.priority ?? ''] ?? 'medium',
    bucket: link.category || 'Inbox',
    status: link.isCompleted ? 'completed' : 'active',
    dueDate: link.dueDate || undefined,
    subTasks,
    blockers: [],
    relatedTasks: [],
    resourceLinks,
    metadata: link.estMinutes ? { estimatedDuration: link.estMinutes } : undefined,
    createdAt: now,
    updatedAt: now,
  };
}

function mapLinkToResource(link: LegacyLink, url: string, now: number): Resource {
  return {
    id: link.id,
    url,
    domain: safeDomain(url),
    title: sanitizeText(link.name || 'Untitled', 200),
    description: link.description ? sanitizeText(link.description, 600) : undefined,
    type: 'other' as ResourceType,
    bucket: link.category || 'Inbox',
    linkedTaskId: null,
    linkedTaskTitle: null,
    createdAt: now,
  };
}

export function mapVault(raw: unknown): { tasks: Task[]; resources: Resource[] } {
  const vault = raw as LegacyVault;
  const links = vault?.links ?? [];
  const tasks: Task[] = [];
  const resources: Resource[] = [];
  const now = Date.now();

  for (const link of links) {
    if (!link?.id) continue;

    // Non-actionable link with a valid first URL → Resource
    if (!link.isActionable && link.resources?.length) {
      const safeUrl = sanitizeUrl(link.resources[0]?.url ?? '');
      if (safeUrl) {
        resources.push(mapLinkToResource(link, safeUrl, now));
        continue;
      }
    }

    // Everything else → Task
    tasks.push(mapLinkToTask(link, now));
  }

  return { tasks, resources };
}
