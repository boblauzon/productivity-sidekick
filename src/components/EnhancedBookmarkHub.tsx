// ─── EnhancedBookmarkHub ───────────────────────────────────────────────────────
// Resource Manager. Renames `resource-hub.jsx` from the prototype.
//
// Hardening applied vs. prototype:
//   • EVERY URL — saved, opened, or rendered as <a href> — is run through
//     `sanitizeUrl` first. If the URL doesn't pass, the resource is shown
//     but the open action is disabled and the user gets a clear message.
//     The prototype used `window.open(resource.url, '_blank', 'noopener,noreferrer')`
//     directly with an unvalidated URL — that was a `javascript:` injection vector.
//   • The Add Resource modal validates inline and blocks submission of any
//     URL that doesn't sanitize cleanly. Saving a bad URL silently is the
//     bug we're closing here.
//   • Title / description / domain render as React text children only. No
//     dangerouslySetInnerHTML anywhere; the prototype didn't have any either,
//     and we're keeping it that way explicitly.
//   • Component is dumb: receives `resources`, `buckets`, `tasks` as props.
//     No window.S, no global subscriptions inside the component.
//   • Add modal uses the focus-trap hook so Tab can't escape, Escape closes.

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type FormEvent, type ReactNode,
} from 'react';
import type { Resource, ResourceCreateInput, ResourceType, Task } from '../lib/types';
import { sanitizeUrl, sanitizeText, safeDomain } from '../lib/sanitize';
import { useBridge } from '../hooks/useCryptoBridge';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { Icon } from './Icon';

const RESOURCE_TYPES: Record<ResourceType, { icon: string; label: string; tint: string }> = {
  documentation: { icon: 'file-text',  label: 'Documentation', tint: 'text-sky-300'     },
  article:       { icon: 'newspaper',  label: 'Article',       tint: 'text-emerald-300' },
  video:         { icon: 'video',      label: 'Video',         tint: 'text-rose-300'    },
  tool:          { icon: 'wrench',     label: 'Tool',          tint: 'text-amber-300'   },
  design:        { icon: 'palette',    label: 'Design',        tint: 'text-violet-300'  },
  reference:     { icon: 'book-open',  label: 'Reference',     tint: 'text-emerald-300' },
  other:         { icon: 'link',       label: 'Other',         tint: 'text-zinc-400'    },
};

export interface EnhancedBookmarkHubProps {
  resources: Resource[];
  buckets: string[];
  activeTasks: Task[];
  onManageBuckets?: () => void;
}

export function EnhancedBookmarkHub({
  resources, buckets, activeTasks, onManageBuckets,
}: EnhancedBookmarkHubProps) {
  const bridge = useBridge();

  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [groupBy, setGroupBy] = useState<'none' | 'bucket'>('none');
  const [activeBucket, setActiveBucket] = useState<'all' | string>('all');
  const [activeType, setActiveType] = useState<'all' | ResourceType>('all');
  const [search, setSearch] = useState('');
  const [linkedFilter, setLinkedFilter] = useState<'all' | 'linked' | 'unlinked' | string>('all');
  const [addOpen, setAddOpen] = useState(false);

  const bucketCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of resources) c[r.bucket] = (c[r.bucket] ?? 0) + 1;
    return c;
  }, [resources]);

  const typeCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of resources) c[r.type] = (c[r.type] ?? 0) + 1;
    return c;
  }, [resources]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return resources.filter((r) => {
      if (activeBucket !== 'all' && r.bucket !== activeBucket) return false;
      if (activeType !== 'all' && r.type !== activeType) return false;
      if (linkedFilter === 'linked' && !r.linkedTaskId) return false;
      if (linkedFilter === 'unlinked' && r.linkedTaskId) return false;
      if (linkedFilter.startsWith('task:') && r.linkedTaskId !== linkedFilter.slice(5)) return false;
      if (q) {
        const hay = [r.title, r.description, r.domain, r.bucket, r.linkedTaskTitle]
          .filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [resources, activeBucket, activeType, search, linkedFilter]);

  // ── Bridge mutations ────────────────────────────────────────────────────────
  const handleAdd = useCallback((input: ResourceCreateInput) => {
    bridge.request({ kind: 'resource.create', input }).catch(reportError);
  }, [bridge]);

  const handleLink = useCallback((resourceId: string, taskId: string | null, taskTitle?: string | null) => {
    bridge.request({ kind: 'resource.linkTask', resourceId, taskId, taskTitle }).catch(reportError);
  }, [bridge]);

  const handleDelete = useCallback((resourceId: string) => {
    bridge.request({ kind: 'resource.delete', id: resourceId }).catch(reportError);
  }, [bridge]);

  // ── Critical: open uses the SANITIZED URL, never the raw stored value ──────
  // Even though we sanitize on write, we sanitize again on read. Defense in depth:
  // a corrupted record from a bad migration shouldn't be able to fire javascript:.
  const handleOpen = useCallback((resource: Resource) => {
    const safe = sanitizeUrl(resource.url);
    if (!safe) {
      // eslint-disable-next-line no-console
      console.warn('[EnhancedBookmarkHub] refused to open resource with invalid URL:', resource.id);
      return;
    }
    window.open(safe, '_blank', 'noopener,noreferrer');
  }, []);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-8 py-7">
        <Header
          count={resources.length}
          onAdd={() => setAddOpen(true)}
          onManageBuckets={onManageBuckets}
          viewMode={viewMode}
          setViewMode={setViewMode}
        />

        <Filters
          buckets={buckets}
          bucketCounts={bucketCounts}
          activeBucket={activeBucket}
          setActiveBucket={setActiveBucket}
          typeCounts={typeCounts}
          activeType={activeType}
          setActiveType={setActiveType}
          search={search}
          setSearch={setSearch}
          linkedFilter={linkedFilter}
          setLinkedFilter={setLinkedFilter}
          taskOptions={activeTasks}
        />

        <div className="mt-6 flex items-center gap-2 text-[11px] text-zinc-500 flex-wrap">
          <span className="px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-400">
            {filtered.length} {filtered.length === 1 ? 'result' : 'results'}
          </span>
          {(activeBucket !== 'all' || activeType !== 'all' || search || linkedFilter !== 'all') && (
            <button
              type="button"
              onClick={() => { setActiveBucket('all'); setActiveType('all'); setSearch(''); setLinkedFilter('all'); }}
              className="text-zinc-500 hover:text-zinc-300 inline-flex items-center gap-1"
            >
              <Icon name="x" className="w-3 h-3" />
              Clear filters
            </button>
          )}

          <div className="ml-auto inline-flex items-center gap-1.5">
            <span className="uppercase tracking-wider text-zinc-500">Group:</span>
            <div className="inline-flex bg-zinc-900 border border-zinc-800 rounded-lg p-0.5">
              <SegBtn active={groupBy === 'none'}    onClick={() => setGroupBy('none')}    icon="list"   label="None"   />
              <SegBtn active={groupBy === 'bucket'}  onClick={() => setGroupBy('bucket')}  icon="folder" label="Bucket" />
            </div>
          </div>
        </div>

        {filtered.length === 0 ? (
          <EmptyState />
        ) : groupBy === 'bucket' ? (
          <Grouped
            filtered={filtered}
            buckets={buckets}
            viewMode={viewMode}
            allTasks={activeTasks}
            onLink={handleLink}
            onOpen={handleOpen}
            onDelete={handleDelete}
          />
        ) : viewMode === 'grid' ? (
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
            {filtered.map((r) => (
              <Card
                key={r.id}
                resource={r}
                allTasks={activeTasks}
                onLink={handleLink}
                onOpen={handleOpen}
                onDelete={handleDelete}
              />
            ))}
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {filtered.map((r) => (
              <Row
                key={r.id}
                resource={r}
                onOpen={handleOpen}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>

      <AddResourceModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdd={handleAdd}
        buckets={buckets}
      />
    </div>
  );
}

// ─── Header ────────────────────────────────────────────────────────────────────

function Header({
  count, onAdd, onManageBuckets, viewMode, setViewMode,
}: {
  count: number;
  onAdd: () => void;
  onManageBuckets?: () => void;
  viewMode: 'grid' | 'list';
  setViewMode: (v: 'grid' | 'list') => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0">
          <Icon name="library" className="w-5 h-5 text-amber-300" />
        </div>
        <div>
          <h1 className="text-[26px] leading-tight font-semibold text-zinc-100 tracking-tight">Resource Management</h1>
          <p className="text-sm text-zinc-500 mt-0.5">{count} saved {count === 1 ? 'resource' : 'resources'}</p>
        </div>
      </div>

      <div className="flex items-stretch gap-2.5">
        {onManageBuckets && (
          <button
            type="button"
            onClick={onManageBuckets}
            className="min-h-[56px] px-5 inline-flex items-center gap-2 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-100 text-sm transition-colors"
          >
            <Icon name="folder-plus" className="w-4 h-4" />
            Manage Buckets
          </button>
        )}

        <div className="min-h-[56px] p-1 rounded-xl bg-zinc-900 border border-zinc-800 inline-flex items-center gap-0.5 self-stretch">
          <SegBtn active={viewMode === 'grid'} onClick={() => setViewMode('grid')} icon="layout-grid" label="Grid" />
          <SegBtn active={viewMode === 'list'} onClick={() => setViewMode('list')} icon="list"        label="List" />
        </div>

        <button
          type="button"
          onClick={onAdd}
          className="min-h-[56px] px-5 inline-flex items-center gap-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-sm shadow-lg shadow-violet-900/30 transition-colors"
        >
          <Icon name="plus" className="w-4 h-4" />
          Add Resource
        </button>
      </div>
    </div>
  );
}

function SegBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: string; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`h-7 px-2.5 rounded-md text-[11px] inline-flex items-center gap-1 transition-all duration-150 active:scale-95 ${
        active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200'
      }`}
    >
      <Icon name={icon} className="w-3 h-3" />
      {label}
    </button>
  );
}

// ─── Filters ───────────────────────────────────────────────────────────────────

function Filters({
  buckets, bucketCounts, activeBucket, setActiveBucket,
  typeCounts, activeType, setActiveType,
  search, setSearch,
  linkedFilter, setLinkedFilter, taskOptions,
}: {
  buckets: string[];
  bucketCounts: Record<string, number>;
  activeBucket: 'all' | string;
  setActiveBucket: (v: 'all' | string) => void;
  typeCounts: Record<string, number>;
  activeType: 'all' | ResourceType;
  setActiveType: (v: 'all' | ResourceType) => void;
  search: string;
  setSearch: (v: string) => void;
  linkedFilter: string;
  setLinkedFilter: (v: string) => void;
  taskOptions: Task[];
}) {
  return (
    <div className="mt-7 space-y-3">
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-[11px] uppercase tracking-wider text-zinc-500 mr-2">Bucket:</span>
        <BucketPill active={activeBucket === 'all'} onClick={() => setActiveBucket('all')} label="All" />
        {buckets.map((b) => (
          <BucketPill
            key={b}
            active={activeBucket === b}
            onClick={() => setActiveBucket(b)}
            label={b}
            count={bucketCounts[b] ?? 0}
          />
        ))}

        <div className="ml-auto relative">
          <Icon name="search" className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search resources..."
            aria-label="Search resources"
            className="w-64 h-9 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 focus:border-violet-500/40 focus:ring-2 focus:ring-violet-500/15 rounded-lg pl-9 pr-3 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none transition-all duration-200"
          />
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[11px] uppercase tracking-wider text-zinc-500 mr-1 inline-flex items-center gap-1.5">
          <Icon name="filter" className="w-3 h-3" />
          Type:
        </span>
        <TypePill active={activeType === 'all'} onClick={() => setActiveType('all')} label="All" />
        {(Object.entries(RESOURCE_TYPES) as [ResourceType, typeof RESOURCE_TYPES[ResourceType]][])
          .filter(([k]) => k !== 'other')
          .map(([k, meta]) => (
            <TypePill
              key={k}
              active={activeType === k}
              onClick={() => setActiveType(k)}
              label={meta.label}
              icon={meta.icon}
              tint={meta.tint}
              count={typeCounts[k] ?? 0}
            />
          ))}

        <div className="ml-auto inline-flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">Linked:</span>
          <div className="relative">
            <select
              value={linkedFilter}
              onChange={(e) => setLinkedFilter(e.target.value)}
              aria-label="Filter by linked task"
              className="appearance-none h-9 pl-3 pr-9 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-lg text-sm text-zinc-200 outline-none transition-all duration-200 cursor-pointer min-w-[180px]"
            >
              <option value="all">All</option>
              <option value="linked">Linked only</option>
              <option value="unlinked">Unlinked only</option>
              <optgroup label="By task">
                {taskOptions.map((t) => (
                  <option key={t.id} value={`task:${t.id}`}>{t.title}</option>
                ))}
              </optgroup>
            </select>
            <Icon name="chevron-down" className="w-3.5 h-3.5 text-zinc-500 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
        </div>
      </div>
    </div>
  );
}

function BucketPill({ active, onClick, label, count }: {
  active: boolean; onClick: () => void; label: string; count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`group inline-flex items-center gap-1.5 h-7 px-3 rounded-full text-sm transition-all duration-150 active:scale-95 ${
        active ? 'bg-zinc-800/70 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-900/60'
      }`}
    >
      <span>{label}</span>
      {count !== undefined && (
        <span className={`text-[11px] tabular-nums ${active ? 'text-zinc-400' : 'text-zinc-600'}`}>{count}</span>
      )}
    </button>
  );
}

function TypePill({ active, onClick, label, icon, tint, count }: {
  active: boolean; onClick: () => void; label: string; icon?: string; tint?: string; count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`group inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs transition-all duration-150 active:scale-95 ${
        active ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/60'
      }`}
    >
      {icon && <Icon name={icon} className={`w-3.5 h-3.5 ${active ? 'text-zinc-700' : tint || 'text-zinc-400'}`} />}
      <span>{label}</span>
      {count !== undefined && count > 0 && (
        <span className="text-[10px] tabular-nums text-zinc-600">{count}</span>
      )}
    </button>
  );
}

// ─── Cards / Rows ──────────────────────────────────────────────────────────────

function Card({ resource, allTasks, onLink, onOpen, onDelete }: {
  resource: Resource;
  allTasks: Task[];
  onLink: (id: string, taskId: string | null, taskTitle?: string | null) => void;
  onOpen: (r: Resource) => void;
  onDelete: (id: string) => void;
}) {
  const meta = RESOURCE_TYPES[resource.type] ?? RESOURCE_TYPES.other;
  const [linkOpen, setLinkOpen] = useState(false);
  // Validate on render — disables open if the stored URL is somehow corrupt.
  const safeHref = sanitizeUrl(resource.url);

  return (
    <div className="group relative bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-xl p-4 transition-all duration-200 hover:bg-zinc-900/80">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <FaviconChip domain={resource.domain} />
          <span className="text-xs text-zinc-500 truncate">{resource.domain}</span>
        </div>
        <button
          type="button"
          onClick={() => onDelete(resource.id)}
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-zinc-500 hover:text-rose-300 transition-all duration-150"
          aria-label={`Remove resource: ${resource.title}`}
        >
          <Icon name="trash-2" className="w-3.5 h-3.5" />
        </button>
      </div>

      <button
        type="button"
        onClick={() => safeHref && onOpen(resource)}
        disabled={!safeHref}
        className="mt-3 flex items-start gap-2 text-left w-full disabled:cursor-not-allowed"
        title={safeHref ? `Open ${resource.domain}` : 'URL is not safe to open'}
      >
        <Icon name={meta.icon} className={`w-4 h-4 mt-0.5 shrink-0 ${meta.tint}`} />
        <h3 className="text-[15px] font-medium text-zinc-100 leading-snug group-hover:text-white transition-colors break-words [overflow-wrap:anywhere]">
          {resource.title}
        </h3>
      </button>

      {/* Description: React text-child, sanitized for control chars */}
      {resource.description && (
        <p className="mt-2 text-[13px] text-zinc-500 leading-relaxed line-clamp-2">
          {sanitizeText(resource.description, 600)}
        </p>
      )}

      {!safeHref && (
        <p className="mt-2 text-[11px] text-rose-300/80 inline-flex items-center gap-1">
          <Icon name="alert-triangle" className="w-3 h-3" />
          Stored URL failed validation — open is disabled.
        </p>
      )}

      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1 h-6 px-2 rounded-md text-[11px] bg-zinc-800/70 border border-zinc-800 ${meta.tint}`}>
          {meta.label}
        </span>

        {resource.linkedTaskId ? (
          <span className="inline-flex items-center gap-1 h-6 px-2 rounded-md text-[11px] bg-amber-500/10 text-amber-300 border border-amber-500/30 max-w-[180px]">
            <Icon name="link-2" className="w-3 h-3 shrink-0" />
            <span className="truncate">{resource.linkedTaskTitle}</span>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setLinkOpen((v) => !v)}
            className="inline-flex items-center gap-1 h-6 px-2 rounded-md text-[11px] text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60 border border-dashed border-zinc-700 transition-all"
          >
            <Icon name="unlink" className="w-3 h-3" />
            Not linked
          </button>
        )}

        <div className="ml-auto" />

        {!resource.linkedTaskId && (
          <button
            type="button"
            onClick={() => setLinkOpen((v) => !v)}
            aria-expanded={linkOpen}
            className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-violet-300 transition-colors"
          >
            <Icon name="link" className="w-3 h-3" />
            Link task
          </button>
        )}
        {resource.linkedTaskId && (
          <button
            type="button"
            onClick={() => onLink(resource.id, null)}
            className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-rose-300 transition-colors"
            aria-label="Unlink task"
          >
            <Icon name="unlink" className="w-3 h-3" />
          </button>
        )}
      </div>

      {linkOpen && (
        <div className="mt-3 pt-3 border-t border-zinc-800/80 space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Link to task</div>
          {allTasks.length === 0 && <div className="text-xs text-zinc-600 py-2">No active tasks.</div>}
          {allTasks.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => { onLink(resource.id, t.id, t.title); setLinkOpen(false); }}
              className="w-full text-left text-xs text-zinc-300 hover:text-white hover:bg-zinc-800/60 rounded-md px-2 py-1.5 transition-all flex items-center gap-2"
            >
              <Icon name="circle-dot" className="w-3 h-3 text-zinc-600" />
              <span className="truncate">{t.title}</span>
              <span className="ml-auto text-[10px] text-zinc-600">{t.bucket}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ resource, onOpen, onDelete }: {
  resource: Resource;
  onOpen: (r: Resource) => void;
  onDelete: (id: string) => void;
}) {
  const meta = RESOURCE_TYPES[resource.type] ?? RESOURCE_TYPES.other;
  const safeHref = sanitizeUrl(resource.url);
  return (
    <div className="group flex items-center gap-3 px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900/80 transition-all duration-150">
      <FaviconChip domain={resource.domain} />
      <Icon name={meta.icon} className={`w-4 h-4 shrink-0 ${meta.tint}`} />
      <button
        type="button"
        onClick={() => safeHref && onOpen(resource)}
        disabled={!safeHref}
        className="text-left min-w-0 flex-1 disabled:cursor-not-allowed"
      >
        <div className="text-sm text-zinc-100 truncate group-hover:text-white">{resource.title}</div>
        <div className="text-[11px] text-zinc-500 truncate">
          {resource.domain}{resource.description ? ` · ${sanitizeText(resource.description, 200)}` : ''}
        </div>
      </button>
      <span className={`hidden sm:inline-flex items-center h-6 px-2 rounded-md text-[11px] bg-zinc-800/70 ${meta.tint} shrink-0`}>
        {meta.label}
      </span>
      <button
        type="button"
        onClick={() => onDelete(resource.id)}
        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-zinc-500 hover:text-rose-300 transition-all"
        aria-label={`Remove resource: ${resource.title}`}
      >
        <Icon name="trash-2" className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ─── Favicon ───────────────────────────────────────────────────────────────────

function FaviconChip({ domain }: { domain: string }) {
  // PR-1.5b: dropped the https://www.google.com/s2/favicons fetch. Every
  // saved domain was being sent to Google on every render, which contradicts
  // the Zero-Knowledge product positioning. The colored-letter chip below is
  // the fallback that already existed for failed-fetch cases — now it's the
  // only path. Future PR can proxy through /api/fetch-meta if real favicons
  // are ever desired without leaking the user's bookmark list.
  const hue = hashHue(domain || 'x');
  return (
    <div
      className="w-6 h-6 rounded-md flex items-center justify-center text-[11px] font-semibold text-white shrink-0"
      style={{ background: `oklch(0.55 0.12 ${hue})` }}
      aria-hidden="true"
    >
      {(domain || '?')[0].toUpperCase()}
    </div>
  );
}

function hashHue(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

// ─── Grouped view ──────────────────────────────────────────────────────────────

function Grouped({
  filtered, buckets, viewMode, allTasks, onLink, onOpen, onDelete,
}: {
  filtered: Resource[];
  buckets: string[];
  viewMode: 'grid' | 'list';
  allTasks: Task[];
  onLink: (id: string, taskId: string | null, taskTitle?: string | null) => void;
  onOpen: (r: Resource) => void;
  onDelete: (id: string) => void;
}) {
  const byBucket: Record<string, Resource[]> = {};
  for (const r of filtered) {
    const k = r.bucket || 'Inbox';
    (byBucket[k] ??= []).push(r);
  }
  const ordered: string[] = [];
  for (const b of buckets) if (byBucket[b]) ordered.push(b);
  for (const b of Object.keys(byBucket)) if (!ordered.includes(b)) ordered.push(b);

  return (
    <div className="mt-4 space-y-6">
      {ordered.map((bucket) => {
        const items = byBucket[bucket];
        return (
          <section key={bucket}>
            <header className="flex items-center gap-2 mb-2.5 text-zinc-400">
              <Icon name="folder" className="w-3.5 h-3.5 text-zinc-500" />
              <h3 className="text-sm text-zinc-200">{bucket}</h3>
              <span className="px-1.5 rounded bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-500">{items.length}</span>
            </header>
            {viewMode === 'grid' ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {items.map((r) => (
                  <Card key={r.id} resource={r} allTasks={allTasks} onLink={onLink} onOpen={onOpen} onDelete={onDelete} />
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                {items.map((r) => (
                  <Row key={r.id} resource={r} onOpen={onOpen} onDelete={onDelete} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-10 text-center py-16 border border-dashed border-zinc-800 rounded-xl">
      <Icon name="library" className="w-7 h-7 text-zinc-700 mx-auto" />
      <div className="mt-3 text-sm text-zinc-400">No resources match these filters</div>
      <div className="mt-1 text-xs text-zinc-600">Try clearing filters or adding a new resource</div>
    </div>
  );
}

// ─── Add modal (focus-trapped + URL-validated) ─────────────────────────────────

function AddResourceModal({
  open, onClose, onAdd, buckets,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (input: ResourceCreateInput) => void;
  buckets: string[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<ResourceType>('reference');
  const [bucket, setBucket] = useState<string>(buckets[0] ?? 'Inbox');
  const [touched, setTouched] = useState(false);

  // Live validation — sanitize on every keystroke so the Save button gates correctly.
  const safeUrl = useMemo(() => sanitizeUrl(url), [url]);
  const showUrlError = touched && !!url.trim() && !safeUrl;

  // Reset on open/close
  useEffect(() => {
    if (!open) {
      setUrl(''); setTitle(''); setDescription('');
      setType('reference'); setBucket(buckets[0] ?? 'Inbox');
      setTouched(false);
    }
  }, [open, buckets]);

  useFocusTrap(containerRef, { active: open, onEscape: onClose });

  if (!open) return null;

  function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!safeUrl) return;
    // Sanitize and clip free-form text fields before sending.
    onAdd({
      url: safeUrl,
      title: sanitizeText(title.trim() || safeDomain(safeUrl), 280),
      description: sanitizeText(description.trim(), 2000),
      type,
      bucket,
    });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-6">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-resource-title"
        className="relative w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl shadow-black/40 focus:outline-none"
        tabIndex={-1}
      >
        <form onSubmit={submit}>
          <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
            <div className="flex items-center gap-2">
              <Icon name="plus" className="w-4 h-4 text-violet-300" />
              <h2 id="add-resource-title" className="text-sm text-zinc-100 font-medium">Add resource</h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-zinc-500 hover:text-zinc-200"
              aria-label="Close"
            >
              <Icon name="x" className="w-4 h-4" />
            </button>
          </div>

          <div className="p-5 space-y-4">
            <Field
              label="URL"
              required
              error={showUrlError ? 'Enter a valid http(s) URL — javascript:, data:, and other schemes are blocked.' : undefined}
            >
              <input
                autoFocus
                value={url}
                onChange={(e) => { setUrl(e.target.value); setTouched(true); }}
                onBlur={() => setTouched(true)}
                placeholder="https://..."
                inputMode="url"
                spellCheck={false}
                className={`w-full h-10 bg-zinc-950 border rounded-lg px-3 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none ${
                  showUrlError
                    ? 'border-rose-500/50 focus:border-rose-500/70 focus:ring-2 focus:ring-rose-500/20'
                    : 'border-zinc-800 focus:border-violet-500/40 focus:ring-2 focus:ring-violet-500/15'
                }`}
                aria-invalid={showUrlError}
              />
            </Field>
            <Field label="Title">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Auto-pulls from URL if empty"
                maxLength={280}
                className="w-full h-10 bg-zinc-950 border border-zinc-800 focus:border-violet-500/40 focus:ring-2 focus:ring-violet-500/15 rounded-lg px-3 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none"
              />
            </Field>
            <Field label="Description">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                maxLength={2000}
                className="w-full bg-zinc-950 border border-zinc-800 focus:border-violet-500/40 focus:ring-2 focus:ring-violet-500/15 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none resize-none"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type">
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value as ResourceType)}
                  className="w-full h-10 bg-zinc-950 border border-zinc-800 rounded-lg px-3 text-sm text-zinc-200 outline-none"
                >
                  {(Object.entries(RESOURCE_TYPES) as [ResourceType, typeof RESOURCE_TYPES[ResourceType]][]).map(([k, m]) => (
                    <option key={k} value={k}>{m.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Bucket">
                <select
                  value={bucket}
                  onChange={(e) => setBucket(e.target.value)}
                  className="w-full h-10 bg-zinc-950 border border-zinc-800 rounded-lg px-3 text-sm text-zinc-200 outline-none"
                >
                  {buckets.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </Field>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              className="h-10 px-4 rounded-lg text-sm text-zinc-300 hover:bg-zinc-800/60 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!safeUrl}
              className="h-10 px-4 inline-flex items-center gap-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed text-white text-sm shadow-lg shadow-violet-900/30 transition-colors"
            >
              <Icon name="plus" className="w-4 h-4" />
              Add resource
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label, children, required, error,
}: { label: string; children: ReactNode; required?: boolean; error?: string }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1.5">
        {label}{required && <span className="text-rose-400 ml-0.5" aria-hidden="true">*</span>}
      </div>
      {children}
      {error && (
        <div className="text-[11px] text-rose-300 mt-1 flex items-start gap-1">
          <Icon name="alert-triangle" className="w-3 h-3 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </label>
  );
}

function reportError(err: Error): void {
  // eslint-disable-next-line no-console
  console.error('[EnhancedBookmarkHub] bridge error:', err);
}
