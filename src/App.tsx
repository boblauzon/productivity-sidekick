// ─── App ──────────────────────────────────────────────────────────────────────
// Root of the staging build. Replaces the prototype's window-globals
// architecture with explicit React composition:
//
//   • <BridgeProvider>          — supplies the typed CryptoBridge to children
//     ↳ Worker enclave instance — keys live there, never on the main thread
//   • View routing              — local React state (no global window.S.ui)
//   • Bridge queries            — useBridgeQuery() drives data into the UI;
//                                  empty arrays until the worker resolves
//   • Drawer / modal overlays   — focus-trapped, keyed by id
//
// Removed vs. prototype:
//   • window.S vault and ui state (now in worker / React state)
//   • window.EventBus (replaced by bridge.request + bridge.subscribe)
//   • window.Icon / window.Button / window.useAppState / window.useEventBus
//   • The Toaster's `window.addEventListener('__bus_log', ...)` — no global bus
//   • The TopBar / IconRail are kept inline here for clarity but could move
//     to their own files in a follow-up; they're trivial dumb components.
//
// Empty-state contract:
//   When the bridge returns [] (e.g. against the staging worker stub), every
//   surface renders its empty state. The UI never shows fabricated tasks
//   or resources. This is the test for "no mock data leaked through."

import {
  useCallback, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';
import { createBrowserBridge } from './lib/cryptoBridge';
import type { Task, Resource, UiPrefs } from './lib/types';
import type { AuthSession } from './lib/authClient';
import { loadVault } from './lib/authClient';
import { mapVault } from './lib/vaultMapper';
import { BridgeProvider, useBridge } from './hooks/useCryptoBridge';
import { AuthScreen } from './components/AuthScreen';
import { SettingsModal } from './components/SettingsModal';
import { TaskCard } from './components/TaskCard';
import { TaskExpansionDrawer } from './components/TaskExpansionDrawer';
import { EnhancedBookmarkHub } from './components/EnhancedBookmarkHub';
import { Icon } from './components/Icon';

type View = 'dashboard' | 'focus' | 'theatre' | 'success' | 'bookmarks';

// Single bridge instance — created once at module scope so it survives Fast Refresh.
const bridge = createBrowserBridge();

export default function App() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [vaultData, setVaultData] = useState<{ tasks: Task[]; resources: Resource[] }>({ tasks: [], resources: [] });
  const [loadingVault, setLoadingVault] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const handleLogout = useCallback(() => {
    setSession(null);
    setVaultData({ tasks: [], resources: [] });
  }, []);

  const handleAuthenticated = useCallback(async (s: AuthSession) => {
    setSession(s);
    setLoadingVault(true);
    try {
      const raw = await loadVault(s);
      setVaultData(raw ? mapVault(raw) : { tasks: [], resources: [] });
    } catch {
      setVaultData({ tasks: [], resources: [] });
    } finally {
      setLoadingVault(false);
    }
  }, []);

  if (!session) {
    return <AuthScreen onAuthenticated={handleAuthenticated} />;
  }

  if (loadingVault) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="flex items-center gap-3 text-zinc-400">
          <span className="w-5 h-5 rounded-full border-2 border-zinc-700 border-t-violet-400 animate-spin" />
          <span className="text-sm">Decrypting vault…</span>
        </div>
      </div>
    );
  }

  return (
    <BridgeProvider bridge={bridge}>
      <Shell
        session={session}
        onLogout={handleLogout}
        tasks={vaultData.tasks}
        resources={vaultData.resources}
        onShowSettings={() => setSettingsOpen(true)}
      />
      {settingsOpen && (
        <SettingsModal
          session={session}
          onClose={() => setSettingsOpen(false)}
          onLogout={handleLogout}
        />
      )}
    </BridgeProvider>
  );
}

// ─── Shell ─────────────────────────────────────────────────────────────────────

function Shell({
  session, onLogout, tasks, resources, onShowSettings,
}: {
  session: AuthSession;
  onLogout: () => void;
  tasks: Task[];
  resources: Resource[];
  onShowSettings: () => void;
}) {
  const [view, setView] = useState<View>('focus');
  const [drawerTaskId, setDrawerTaskId] = useState<string | null>(null);
  const [theatreTaskId, setTheatreTaskId] = useState<string | null>(null);

  const [ui, setUi] = useState<UiPrefs>({
    theme: 'dark',
    workspaceProfile: 'simplistic',
    brightness: 50,
    toolbarPosition: 'left',
    focusDuration: 25,
    distractorOptions: [],
  });

  // Ensure the dark class is set on mount.
  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  // Focus-start event from the drawer or task card. Not a bridge concern —
  // it's pure UI routing into the theatre view.
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ taskId: string }>).detail;
      if (!detail?.taskId) return;
      setTheatreTaskId(detail.taskId);
      setView('theatre');
    };
    window.addEventListener('app:focus-start', handler);
    return () => window.removeEventListener('app:focus-start', handler);
  }, []);

  const onOpenTask = useCallback((id: string) => setDrawerTaskId(id), []);
  const onStartFocus = useCallback((taskId: string) => {
    window.dispatchEvent(new CustomEvent('app:focus-start', { detail: { taskId } }));
  }, []);
  const closeDrawer = useCallback(() => setDrawerTaskId(null), []);

  const drawerTask = useMemo(
    () => (drawerTaskId ? tasks.find((t) => t.id === drawerTaskId) ?? null : null),
    [drawerTaskId, tasks],
  );

  const activeTasks = useMemo(() => tasks.filter((t) => t.status === 'active'), [tasks]);
  const resourceBuckets = useMemo(() => {
    // Until bucket settings ship via the bridge, derive from existing records.
    const set = new Set(resources.map((r) => r.bucket));
    return Array.from(set);
  }, [resources]);

  return (
    <div className="w-screen h-screen overflow-hidden flex bg-zinc-950 text-zinc-200">
      {ui.toolbarPosition === 'left' && (
        <IconRail view={view} onView={setView} email={session.email} onLogout={onLogout} onShowSettings={onShowSettings} />
      )}

      <main className="flex-1 flex flex-col min-w-0">
        {view !== 'theatre' && <TopBar view={view} />}

        {view === 'dashboard' && (
          <Dashboard
            activeTasks={activeTasks}
            loading={false}
            error={null}
            workspaceProfile={ui.workspaceProfile}
            onOpenTask={onOpenTask}
            onStartFocus={onStartFocus}
            onSetProfile={(workspaceProfile) => setUi((p) => ({ ...p, workspaceProfile }))}
          />
        )}

        {view === 'focus' && (
          <FocusOverview
            activeTasks={activeTasks}
            loading={false}
            onOpenTask={onOpenTask}
            onStartFocus={onStartFocus}
          />
        )}

        {view === 'theatre' && (
          <FocusTheatreStub taskId={theatreTaskId} onExit={() => { setTheatreTaskId(null); setView('focus'); }} />
        )}

        {view === 'success' && (
          <StubView icon="trophy" title="Success Analytics" body="Streaks, flow analytics, and weekly wins." />
        )}

        {view === 'bookmarks' && (
          <EnhancedBookmarkHub
            resources={resources}
            buckets={resourceBuckets}
            activeTasks={activeTasks}
          />
        )}
      </main>

      <TaskExpansionDrawer
        task={drawerTask}
        allTasks={tasks}
        onClose={closeDrawer}
      />
    </div>
  );
}

// ─── Top bar / icon rail ───────────────────────────────────────────────────────

function TopBar({ view }: { view: View }) {
  const labels: Record<View, string> = {
    dashboard: 'Today',
    focus:     'Focus',
    theatre:   'Focus',
    success:   'Success',
    bookmarks: 'Resource Manager',
  };
  const subs: Record<View, string> = {
    dashboard: 'Triage and choose what to work on next',
    focus:     'Your post-session springboard',
    theatre:   'Focus session in progress',
    success:   'Streaks and flow analytics',
    bookmarks: 'Saved references for your projects',
  };
  return (
    <header className="h-14 border-b border-zinc-800/80 bg-zinc-950 flex items-center px-6 gap-4 shrink-0">
      <div>
        <h1 className="text-zinc-200 text-[15px] tracking-tight leading-none">{labels[view]}</h1>
        <p className="text-[11px] text-zinc-500 mt-1 leading-none">{subs[view]}</p>
      </div>
      <div className="flex-1" />
    </header>
  );
}

function IconRail({
  view, onView, email, onLogout, onShowSettings,
}: {
  view: View;
  onView: (v: View) => void;
  email: string;
  onLogout: () => void;
  onShowSettings: () => void;
}) {
  const items: { id: View; icon: string; label: string }[] = [
    { id: 'dashboard', icon: 'layout-grid', label: 'Dashboard' },
    { id: 'focus',     icon: 'target',      label: 'Focus' },
    { id: 'success',   icon: 'trophy',      label: 'Success' },
    { id: 'bookmarks', icon: 'library',     label: 'Resource Manager' },
  ];
  return (
    <aside className="w-14 shrink-0 h-full border-r border-zinc-800 bg-zinc-950 flex flex-col items-center py-4 gap-1">
      <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center mb-3 shadow-lg shadow-violet-900/40">
        <Icon name="orbit" className="w-4 h-4 text-white" />
      </div>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          onClick={() => onView(it.id)}
          aria-current={view === it.id ? 'page' : undefined}
          aria-label={it.label}
          title={it.label}
          className={`relative w-10 h-10 rounded-lg flex items-center justify-center transition-all duration-200 active:scale-95 ${
            view === it.id
              ? 'bg-zinc-900 text-violet-300 ring-1 ring-violet-500/30'
              : 'text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800'
          }`}
        >
          {view === it.id && <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-0.5 rounded-r bg-violet-400" aria-hidden="true" />}
          <Icon name={it.icon} className="w-[18px] h-[18px]" />
        </button>
      ))}
      <div className="flex-1" />
      <button
        type="button"
        onClick={onShowSettings}
        title="Settings"
        aria-label="Open settings"
        className="w-10 h-10 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 transition-all duration-200 active:scale-95"
      >
        <Icon name="settings" className="w-[18px] h-[18px]" />
      </button>
      <button
        type="button"
        onClick={onLogout}
        title={`Sign out (${email})`}
        aria-label={`Sign out — signed in as ${email}`}
        className="w-10 h-10 rounded-lg flex items-center justify-center text-zinc-500 hover:text-rose-400 hover:bg-zinc-800 transition-all duration-200 active:scale-95 mt-1"
      >
        <Icon name="log-out" className="w-[18px] h-[18px]" />
      </button>
    </aside>
  );
}

// ─── Dashboard ─────────────────────────────────────────────────────────────────
// Slim dashboard rendering the captured tasks. Quick-capture popover is
// inline + focus-trapped, mirroring the prototype's UX while routing through
// the bridge.

function Dashboard({
  activeTasks, loading, error,
  workspaceProfile, onOpenTask, onStartFocus, onSetProfile,
}: {
  activeTasks: Task[];
  loading: boolean;
  error: Error | null;
  workspaceProfile: 'simplistic' | 'power';
  onOpenTask: (id: string) => void;
  onStartFocus: (id: string) => void;
  onSetProfile: (v: 'simplistic' | 'power') => void;
}) {
  const bridge = useBridge();

  const [filter, setFilter] = useState<'all' | 'high' | 'medium' | 'low'>('all');
  const counts = useMemo(() => ({
    all: activeTasks.length,
    high: activeTasks.filter((t) => t.energyLevel === 'high').length,
    medium: activeTasks.filter((t) => t.energyLevel === 'medium').length,
    low: activeTasks.filter((t) => t.energyLevel === 'low').length,
  }), [activeTasks]);
  const visible = filter === 'all' ? activeTasks : activeTasks.filter((t) => t.energyLevel === filter);

  const byBucket = useMemo(() => {
    const grouped: Record<string, Task[]> = {};
    for (const t of visible) (grouped[t.bucket || 'Inbox'] ??= []).push(t);
    return grouped;
  }, [visible]);

  // Quick capture
  const [capture, setCapture] = useState('');
  const onCapture = (e: React.FormEvent) => {
    e.preventDefault();
    const v = capture.trim();
    if (!v) return;
    bridge.request({
      kind: 'task.create',
      input: { title: v, energyLevel: 'high', bucket: 'Inbox', estimatedTime: 25 },
    }).then(() => setCapture(''))
      .catch((err: Error) => {
        // eslint-disable-next-line no-console
        console.error('[Dashboard] capture failed:', err);
      });
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-8 py-7">
        <form onSubmit={onCapture} className="flex items-stretch gap-2.5">
          <input
            value={capture}
            onChange={(e) => setCapture(e.target.value)}
            placeholder="Quick capture: What needs your attention?"
            aria-label="Quick capture"
            className="flex-1 h-[52px] bg-zinc-900 border border-zinc-800 hover:border-zinc-700 focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/15 rounded-xl px-4 text-[15px] text-zinc-200 placeholder:text-zinc-600 outline-none transition-all duration-200"
          />
          <button
            type="submit"
            disabled={!capture.trim()}
            className="h-[52px] px-5 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-sm rounded-xl flex items-center gap-2 transition-all duration-200 active:scale-95 shadow-lg shadow-violet-900/20 disabled:shadow-none"
          >
            <Icon name="plus" className="w-4 h-4" />
            Capture
          </button>
        </form>

        <div className="mt-7 flex items-center gap-3 flex-wrap">
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">Layout</span>
          <div className="inline-flex bg-zinc-900 border border-zinc-800 rounded-lg p-0.5" role="tablist">
            <ProfileBtn current={workspaceProfile} v="simplistic" onSet={onSetProfile} icon="list"        label="Simplistic" />
            <ProfileBtn current={workspaceProfile} v="power"      onSet={onSetProfile} icon="layout-grid" label="Kanban" />
          </div>
        </div>

        <div className="mt-6 flex items-center gap-2 flex-wrap">
          <span className="text-[11px] uppercase tracking-wider text-zinc-500 mr-1">Energy filter</span>
          <FilterPill active={filter === 'all'}    onClick={() => setFilter('all')}    label="All"          count={counts.all} />
          <FilterPill active={filter === 'high'}   onClick={() => setFilter('high')}   label="High Energy"  count={counts.high}   tint="text-emerald-300" icon="zap"         />
          <FilterPill active={filter === 'medium'} onClick={() => setFilter('medium')} label="Medium Energy" count={counts.medium} tint="text-amber-300"   icon="battery"     />
          <FilterPill active={filter === 'low'}    onClick={() => setFilter('low')}    label="Low Energy"   count={counts.low}    tint="text-sky-300"     icon="battery-low" />
        </div>

        <div className="mt-7 flex items-center gap-3">
          <Icon name="square" className="w-3.5 h-3.5 text-zinc-600" />
          <span className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">
            {workspaceProfile === 'power' ? 'Power user — Kanban view' : 'Focus mode — Linear view'}
          </span>
          <span className="px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-400">
            {visible.length} active
          </span>
        </div>

        {loading && (
          <div className="mt-10 text-center text-sm text-zinc-500">Loading tasks…</div>
        )}
        {error && (
          <div className="mt-10 text-center text-sm text-rose-300/80">
            Couldn't load tasks: {error.message}
          </div>
        )}
        {!loading && !error && visible.length === 0 && (
          <EmptyDashboard />
        )}

        {!loading && !error && visible.length > 0 && (
          <div className={workspaceProfile === 'power'
            ? 'mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 items-start'
            : 'mt-4 space-y-6'}>
            {Object.entries(byBucket).map(([bucket, items]) => (
              <section key={bucket} className={workspaceProfile === 'power' ? 'bg-zinc-900/40 border border-zinc-800 rounded-xl p-3' : ''}>
                <header className="flex items-center gap-2 mb-2.5 px-1">
                  <h3 className="text-sm text-zinc-200">{bucket}</h3>
                  <span className="px-1.5 rounded bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-500">{items.length}</span>
                </header>
                <div className="space-y-2">
                  {items.map((t) => (
                    <TaskCard key={t.id} task={t} onOpen={onOpenTask} onStartFocus={onStartFocus} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProfileBtn({
  current, v, onSet, icon, label,
}: { current: string; v: 'simplistic' | 'power'; onSet: (v: 'simplistic' | 'power') => void; icon: string; label: string }) {
  const active = current === v;
  return (
    <button
      type="button"
      onClick={() => onSet(v)}
      aria-pressed={active}
      className={`h-8 px-3 rounded-md text-xs inline-flex items-center gap-1.5 transition-all duration-200 active:scale-95 ${
        active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200'
      }`}
    >
      <Icon name={icon} className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}

function FilterPill({
  active, onClick, label, count, icon, tint,
}: { active: boolean; onClick: () => void; label: string; count: number; icon?: string; tint?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`group inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs transition-all duration-200 active:scale-95 border ${
        active
          ? 'bg-zinc-100 border-zinc-100 text-zinc-900 shadow'
          : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
      }`}
    >
      {icon && <Icon name={icon} className={`w-3.5 h-3.5 ${active ? 'text-zinc-700' : tint}`} />}
      <span>{label}</span>
      <span className={`px-1.5 py-px rounded text-[10px] ${active ? 'bg-zinc-900/10 text-zinc-700' : 'bg-zinc-800 text-zinc-400'}`}>
        {count}
      </span>
    </button>
  );
}

function EmptyDashboard() {
  return (
    <div className="mt-12 text-center py-16 border border-dashed border-zinc-800 rounded-2xl">
      <div className="w-14 h-14 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mx-auto mb-4">
        <Icon name="inbox" className="w-6 h-6 text-zinc-500" />
      </div>
      <h2 className="text-zinc-300 text-lg mb-1.5">No tasks yet</h2>
      <p className="text-sm text-zinc-500 leading-relaxed max-w-xs mx-auto">
        Capture your first task above to get started. Everything you save is encrypted before it leaves this device.
      </p>
    </div>
  );
}

// ─── Focus overview / theatre / stub ──────────────────────────────────────────

function FocusOverview({
  activeTasks, loading, onOpenTask, onStartFocus,
}: { activeTasks: Task[]; loading: boolean; onOpenTask: (id: string) => void; onStartFocus: (id: string) => void }) {
  if (loading) return <div className="flex-1 grid place-items-center text-sm text-zinc-500">Loading…</div>;
  if (activeTasks.length === 0) {
    return <StubView icon="target" title="No active tasks" body="Capture your first task on the Dashboard to surface a Next Best Action." />;
  }
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-8 py-8 space-y-6">
        <h2 className="text-zinc-300 text-lg">Up next</h2>
        <div className="space-y-2">
          {activeTasks.slice(0, 5).map((t) => (
            <TaskCard key={t.id} task={t} onOpen={onOpenTask} onStartFocus={onStartFocus} />
          ))}
        </div>
      </div>
    </div>
  );
}

function FocusTheatreStub({ taskId, onExit }: { taskId: string | null; onExit: () => void }) {
  return (
    <div className="flex-1 grid place-items-center bg-zinc-950">
      <div className="text-center max-w-md">
        <div className="w-14 h-14 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mx-auto mb-4">
          <Icon name="play" className="w-6 h-6 text-violet-300" />
        </div>
        <h2 className="text-zinc-300 text-lg mb-1.5">Focus session: {taskId ?? '—'}</h2>
        <p className="text-sm text-zinc-500 leading-relaxed mb-4">Theatre view stub — wire to the real timer module.</p>
        <button
          type="button"
          onClick={onExit}
          className="h-10 px-4 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-sm text-zinc-200 transition-colors"
        >
          Exit theatre
        </button>
      </div>
    </div>
  );
}

function StubView({ icon, title, body }: { icon: string; title: string; body: ReactNode }) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center max-w-md">
        <div className="w-14 h-14 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mx-auto mb-4">
          <Icon name={icon} className="w-6 h-6 text-zinc-500" />
        </div>
        <h2 className="text-zinc-300 text-lg mb-1.5">{title}</h2>
        <p className="text-sm text-zinc-500 leading-relaxed">{body}</p>
      </div>
    </div>
  );
}
