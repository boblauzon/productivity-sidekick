// ─── Shared domain types ───────────────────────────────────────────────────────
// Single source of truth for shapes that cross the CryptoBridge boundary.
// These shapes must stay in sync with the worker's encrypted record schema —
// any drift causes silent decode failures, so changes here require a worker
// release in lockstep.

export type EnergyLevel = 'high' | 'medium' | 'low';
export type TaskStatus = 'active' | 'completed' | 'archived' | 'deferred';

export interface SubTask {
  id: string;
  title: string;
  completed: boolean;
  estimatedDuration?: number; // minutes
  dueDate?: string;           // ISO date (YYYY-MM-DD)
}

export interface ResourceLink {
  id: string;
  url: string;       // already sanitized by the time it lands in state
  title: string;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  intent?: string;
  energyLevel: EnergyLevel;
  bucket: string;
  status: TaskStatus;
  dueDate?: string;
  subTasks: SubTask[];
  blockers: string[];        // task ids
  relatedTasks: string[];    // task ids
  resourceLinks: ResourceLink[];
  metadata?: { estimatedDuration?: number };
  createdAt: number;
  updatedAt: number;
}

export type ResourceType =
  | 'documentation' | 'article' | 'video'
  | 'tool' | 'design' | 'reference' | 'other';

export interface Resource {
  id: string;
  url: string;          // sanitized
  domain: string;       // derived; never trust client to compute
  title: string;
  description?: string;
  type: ResourceType;
  bucket: string;
  linkedTaskId: string | null;
  linkedTaskTitle: string | null;
  createdAt: number;
}

export interface FocusSession {
  id: string;
  taskId: string;
  taskTitle: string;
  taskBucket?: string;
  startTime: number;
  endTime: number;
  durationMinutes: number;
  flowAchieved: boolean;
  energyLevel: EnergyLevel;
  energySustained: number;
  distractorLog: { type: 'external' | 'internal'; note: string; timestamp: number }[];
  taskCompleted: boolean;
}

// ─── Inputs (UI → Bridge) ─────────────────────────────────────────────────────
// Inputs are deliberately narrower than the persisted records; the worker
// fills in id/timestamps/derived fields after encryption.

export interface TaskCreateInput {
  title: string;
  intent?: string;
  energyLevel: EnergyLevel;
  bucket: string;
  estimatedTime?: number;
}

export interface ResourceCreateInput {
  url: string;
  title?: string;
  description?: string;
  type: ResourceType;
  bucket: string;
  linkedTaskId?: string | null;
}

// ─── UI-only state (never crosses bridge) ─────────────────────────────────────
// Lives in React; the bridge has no opinion on these.

export interface UiPrefs {
  theme: 'dark' | 'light';
  workspaceProfile: 'simplistic' | 'power';
  brightness: number;
  toolbarPosition: 'left' | 'right';
  focusDuration: number;
  distractorOptions: string[];
}
