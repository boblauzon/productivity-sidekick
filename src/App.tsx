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
// PR-1.5 changes:
//   • Vault decrypt failure no longer silently falls through to an empty
//     bridge. Instead, we surface a friendly error screen with Retry / Sign
//     out so the user understands why they don't see their data.
//   • Vault SAVE failures now propagate to a non-dismissible banner via the
//     onSaveError / onSaveRecovered callbacks on MainThreadCryptoBridge.
//   • Dashboard's `visible` array is memoized — previously it was rebuilt
//     on every render, defeating the downstream useMemo chain and forcing
//     all TaskCard memos to re-render on every keystroke.

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import type { CryptoBridge } from './lib/cryptoBridge';
import type { Task, Resource, UiPrefs } from './lib/types';
import type { AuthSession } from './lib/authClient';
import { loadVault, saveVault } from './lib/authClient';
import { mapVault } from './lib/vaultMapper';
import { MainThreadCryptoBridge } from './lib/mainThreadBridge';
import { BridgeProvider, useBridge, useBridgeQuery } from './hooks/useCryptoBridge';
import { AuthScreen } from './components/AuthScreen';
import { SettingsModal } from './components/SettingsModal';
import { FocusTheatre } from './components/FocusTheatre';
import { TaskCard } from './components/TaskCard';
import { TaskExpansionDrawer } from './components/TaskExpansionDrawer';
import { EnhancedBookmarkHub } from './components/EnhancedBookmarkHub';
import { Icon } from './components/Icon';

type View = 'dashboard' | 'focus' | 'theatre' | 'success' | 'bookmarks';

export default function App() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [bridge, setBridge] = useState<CryptoBridge | null>(null);
  const [loadingVault, setLoadingVault] = useState(false);
  const [vaultLoadError, setVaultLoadError] = useState<Error | null>(null);
  const [saveError, setSaveError] = useState<Error | null>(null);
  const vaultVersionRef = useRef(0);

  const handleLogout = useCallback(() => {
    bridge?.dispose();
    setBridge(null);
    setSession(null);
    setVaultLoadError(null);
    setSaveError(null);
    vaultVersionRef.current = 0;
  }, [bridge]);

  const handleAuthenticated = useCallback(async (s: AuthSession) => {
    setSession(s);
    setLoadingVault(true);
    setVaultLoadError(null);
    setSaveError(null);
    try {
      const { data, version } = await loadVault(s);
      vaultVersionRef.current = version;
      const { tasks, resources } = data ? mapVault(data) : { tasks: [], resources: [] };

      const saveFn = async (vaultData: unknown) => {
        const result = await saveVault(s, vaultData, vaultVersionRef.current);
        vaultVersionRef.current = result.version;
      };

      // Wire the bridge's save-failure callbacks to React state so the user
      // can SEE when something goes wrong with persistence. Without this,
      // session expiry / network failures / OCC conflicts are silently
      // swallowed and the user only finds out by reloading and discovering
      // missing work.
      setBridge(new MainThreadCryptoBridge(tasks, resources, saveFn, {
        onSaveError: setSaveError,
        onSaveRecovered: () => setSaveError(null),
      }));
    } catch (err) {
      // Critical: do NOT silently fall through to an empty bridge. That path
      // means the user works against a phantom vault, edits get rejected
      // silently by OCC on save, and trust is broken when they refresh.
      // Show a clear error screen instead.
      setVaultLoadError(err instanceof Error ? err : new Error(String(err)));
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
          <span className="text-sm">Loading your work…</span>
        </div>
      </div>
    );
  }

  if (vaultLoadError) {
    return (
      <VaultLoadErrorScreen
        error={vaultLoadError}
        onRetry={() => session && handleAuthenticated(session)}
        onSignOut={handleLogout}
      />
    );
  }

  if (!bridge) return null;

  return (
    <BridgeProvider bridge={bridge}>
      <Shell session={session} onLogout={handleLogout} saveError={saveError} />
    </BridgeProvider>
  );
}

// ─── Vault Load Error Screen ───────────────────────────────────────────────────
// Shown when loadVault() throws during the post-login flow. Friendly copy
// per the PR-1.5 product requirement — no jargon visible by default, with
// technical details collapsed for debugging.

function VaultLoadErrorScreen({
  error, onRetry, onSignOut,
}: { error: Error; onRetry: () => void; onSignOut: () => void }) {
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="w-12 h-12 rounded-full bg-rose-500/15 border border-rose-500/30 flex items-center justify-center mx-auto mb-5">
          <Icon name="alert-triangle" className="w-5 h-5 text-rose-300" />
        </div>
        <h1 className="text-zinc-100 text-xl mb-3 font-medium tracking-tight">
          We couldn't open your work
        </h1>
        <p className="text-sm text-zinc-400 leading-relaxed mb-7">
          Don't worry — your data is still safe and nothing has been changed.
          This usually fixes itself with a quick retry.
        </p>
        <div className="flex gap-2 justify-center">
          <button
            type="button"
            onClick={onRetry}
            className="h-10 px-5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium transition-colors active:scale-[0.98]"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={onSignOut}
            className="h-10 px-5 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-200 text-sm transition-colors active:scale-[0.98]"
          >
            Sign out
          </button>
        </div>
        <details className="mt-8 text-left">
          <summary className="text-[11px] text-zinc-600 cursor-pointer hover:text-zinc-400 select-none">
            Technical details
          </summary>
          <pre className="mt-2 text-[11px] text-zinc-500 bg-zinc-900 border border-zinc-800 rounded-lg p-3 overflow-auto whitespace-pre-wrap">
            {error.message}
          </pre>
        </details>
      </div>
    </div>
  );
}

// ─── Save Error Banner ─────────────────────────────────────────────────────────
// Persistent (non-dismissible) banner shown when the bridge has reported a
// save failure. Auto-clears via onSaveRecovered when the next save succeeds.
//
// Copy is generic on purpose — we don't want to display error.message to
// the user (it's full of jargon like "Version conflict" or HTTP status
// codes) but we DO want to give them clear next steps.

function SaveErrorBanner() {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="bg-rose-500/15 border-b border-rose-500/30 px-6 py-3 flex items-start gap-3 text-sm text-rose-200 shrink-0"
    >
      <Icon name="alert-triangle" className="w-4 h-4 shrink-0 mt-0.5" />
      <div className="flex-1 leading-relaxed">
        <div className="font-medium text-rose-100">
          Your recent changes might not be saved
        </div>
        <div className="text-[13px] text-rose-200/90 mt-0.5">
          To keep your work safe, please download a backup from Settings → Data → Download backup, then sign out and sign back in.
        </div>
      </div>
    </div>
  );
}

// ─── Shell ─────────────────────────────────────────────────────────────────────

function Shell({
  session, onLogout, saveError,
}: {
  session: AuthSession;
  onLogout: () => void;
  saveError: Error | null;
}) {
  const [view, setView] = useState<View>('focus');
  const [drawerTaskId, setDrawerTaskId] = useState<string | null>(null);
  const [theatreTaskId, setTheatreTaskId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Live data via the MainThreadCryptoBridge — re-fetches on every broadcast.
  const tasksQuery = useBridgeQuery<{ kind: 'task.list' }, Task[]>(
    'tasks', useCallback(() => ({ kind: 'task.list' }), []),
  );
  const resourcesQuery = useBridgeQuery<{ kind: 'resource.list' }, Resource[]>(
    'resources', useCallback(() => ({ kind: 'resource.list' }), []),
  );
  const tasks     = tasksQuery.data     ?? [];
  const resources = resourcesQuery.data ?? [];

  const [ui, setUi] = useState<UiPrefs>({
    theme: 'dark',
    workspaceProfile: 'simplistic',
    brightness: 50,
    toolbarPosition: 'left',
    focusDuration: 25,
    distractorOptions: ['Slack message', 'Email', 'Meeting ping', 'Phone call', 'Colleague interrupt'],
  });

  const toggleTheme = useCallback(() => {
    setUi((p) => ({ ...p, theme: p.theme === 'dark' ? 'light' : 'dark' }));
  }, []);

  // Reactively apply/remove the dark class — the CSS overrides in index.css do the rest.
  useEffect(() => {
    document.documentElement.classList.toggle('dark', ui.theme === 'dark');
  }, [ui.theme]);

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

  const theatreTask = useMemo(
    () => (theatreTaskId ? tasks.find((t) => t.id === theatreTaskId) ?? null : null),
    [theatreTaskId, tasks],
  );

  const activeTasks = useMemo(() => tasks.filter((t) => t.status === 'active'), [tasks]);
  const resourceBuckets = useMemo(() => {
    // Until bucket settings ship via the bridge, derive from existing records.
    const set = new Set(resources.map((r) => r.bucket));
    return Array.from(set);
  }, [resources]);

  return (
    <div className="w-screen h-screen overflow-hidden flex flex-col bg-zinc-950 text-zinc-200">
      {saveError && <SaveErrorBanner />}
      <div className="flex-1 flex overflow-hidden">
        {ui.toolbarPosition !== 'right' && (
          <IconRail
            view={view}
            onView={setView}
            theme={ui.theme}
            onToggleTheme={toggleTheme}
            onShowSettings={() => setSettingsOpen(true)}
          />
        )}

        <main className="flex-1 flex flex-col min-w-0">
          {view !== 'theatre' && <TopBar view={view} />}

          {view === 'dashboard' && (
            <Dashboard
              activeTasks={activeTasks}
              loading={tasksQuery.loading}
              error={tasksQuery.error}
              workspaceProfile={ui.workspaceProfile}
              onOpenTask={onOpenTask}
              onStartFocus={onStartFocus}
              onSetProfile={(workspaceProfile) => setUi((p) => ({ ...p, workspaceProfile }))}
            />
          )}

          {view === 'focus' && (
            <FocusOverview
              activeTasks={activeTasks}
              loading={tasksQuery.loading}
              onOpenTask={onOpenTask}
              onStartFocus={onStartFocus}
              focusDuration={ui.focusDuration}
            />
          )}

          {view === 'theatre' && (
            <FocusTheatre
              task={theatreTask}
              focusDuration={ui.focusDuration}
              distractorOptions={ui.distractorOptions}
              onExit={() => { setTheatreTaskId(null); setView('focus'); }}
            />
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

        {ui.toolbarPosition === 'right' && (
          <IconRail
            view={view}
            onView={setView}
            theme={ui.theme}
            onToggleTheme={toggleTheme}
            onShowSettings={() => setSettingsOpen(true)}
            side="right"
          />
        )}
      </div>

      <TaskExpansionDrawer
        task={drawerTask}
        allTasks={tasks}
        onClose={closeDrawer}
      />

      {settingsOpen && (
        <SettingsModal
          session={session}
          onClose={() => setSettingsOpen(false)}
          onLogout={onLogout}
          theme={ui.theme}
          onToggleTheme={toggleTheme}
          workspaceProfile={ui.workspaceProfile}
          onSetWorkspaceProfile={(v) => setUi((p) => ({ ...p, workspaceProfile: v }))}
          focusDuration={ui.focusDuration}
          onSetFocusDuration={(v) => setUi((p) => ({ ...p, focusDuration: v }))}
          toolbarPosition={ui.toolbarPosition}
          onSetToolbarPosition={(v) => setUi((p) => ({ ...p, toolbarPosition: v }))}
        />
      )}
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
  view, onView, theme, onToggleTheme, onShowSettings, side = 'left',
}: {
  view: View;
  onView: (v: View) => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onShowSettings: () => void;
  side?: 'left' | 'right';
}) {
  const items: { id: View; icon: string; label: string }[] = [
    { id: 'dashboard', icon: 'layout-grid', label: 'Dashboard' },
    { id: 'focus',     icon: 'target',      label: 'Focus' },
    { id: 'success',   icon: 'trophy',      label: 'Success' },
    { id: 'bookmarks', icon: 'library',     label: 'Resource Manager' },
  ];
  const borderClass = side === 'right' ? 'border-l border-zinc-800' : 'border-r border-zinc-800';
  return (
    <aside className={`w-14 shrink-0 h-full ${borderClass} bg-zinc-950 flex flex-col items-center py-4 gap-1`}>
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
        onClick={onToggleTheme}
        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        aria-label={`Toggle theme — currently ${theme}`}
        className="w-10 h-10 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 transition-all duration-200 active:scale-95"
      >
        <Icon name={theme === 'dark' ? 'moon' : 'sun'} className="w-[18px] h-[18px]" />
      </button>
      <button
        type="button"
        onClick={onShowSettings}
        title="Settings"
        aria-label="Open settings"
        className="w-10 h-10 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 transition-all duration-200 active:scale-95 mt-0.5"
      >
        <Icon name="settings" className="w-[18px] h-[18px]" />
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

  // PR-1.5 fix: previously this was rebuilt on every render, which meant
  // byBucket's useMemo dependency was a fresh array reference every time
  // and the entire memo chain was defeated. Wrapping in useMemo here lets
  // the downstream TaskCard.memo comparator actually skip work.
  const visible = useMemo(
    () => filter === 'all' ? activeTasks : activeTasks.filter((t) => t.energyLevel === filter),
    [activeTasks, filter],
  );

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

// ─── Focus Overview Hub ────────────────────────────────────────────────────────
// Massive elevated NBA card per design spec — ambient energy glow, score-ranked
// next best action, sub-task checklist, Today's History grid/list toggle.

const ENERGY_META = {
  high:   { icon: 'zap',         color: 'text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-500/25', glow: 'bg-emerald-500', label: 'High'   },
  medium: { icon: 'battery',     color: 'text-amber-300',   bg: 'bg-amber-500/10',   border: 'border-amber-500/25',   glow: 'bg-amber-500',   label: 'Medium' },
  low:    { icon: 'battery-low', color: 'text-sky-300',     bg: 'bg-sky-500/10',     border: 'border-sky-500/25',     glow: 'bg-sky-500',     label: 'Low'    },
} as const;

function formatDuration(min: number): string {
  if (!min || min <= 0) return '';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function formatDateRel(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return `In ${diff}d`;
  if (diff < -1 && diff > -7) return `${-diff}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function rollupTime(task: Task): number {
  if (task.subTasks.length) return task.subTasks.reduce((s, st) => s + (st.estimatedDuration ?? 0), 0);
  return task.metadata?.estimatedDuration ?? 0;
}

function FocusOverview({
  activeTasks, loading, onOpenTask, onStartFocus, focusDuration,
}: {
  activeTasks: Task[];
  loading: boolean;
  onOpenTask: (id: string) => void;
  onStartFocus: (id: string) => void;
  focusDuration: number;
}) {
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [sessionViewMode, setSessionViewMode] = useState<'grid' | 'list'>('grid');

  const candidates = useMemo(() => {
    const eligible = activeTasks.filter((t) => t.blockers.length === 0);
    const score = (t: Task) =>
      (t.energyLevel === 'high' ? 30 : t.energyLevel === 'medium' ? 15 : 5) +
      (t.dueDate ? Math.max(0, 14 - (new Date(t.dueDate).getTime() - Date.now()) / 86_400_000) : 0) +
      (t.subTasks.length ? 5 : 0);
    return [...eligible].sort((a, b) => score(b) - score(a));
  }, [activeTasks]);

  const next = candidates[0] ?? null;

  if (loading) return <div className="flex-1 grid place-items-center text-sm text-zinc-500">Loading…</div>;

  if (!next) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center max-w-md">
          <div className="w-14 h-14 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mx-auto mb-4">
            <Icon name="target" className="w-6 h-6 text-zinc-500" />
          </div>
          <h2 className="text-zinc-300 text-lg mb-1.5">No active tasks</h2>
          <p className="text-sm text-zinc-500 leading-relaxed">
            Create a task on the Dashboard to surface a Next Best Action.
          </p>
        </div>
      </div>
    );
  }

  const energy = ENERGY_META[next.energyLevel];
  const rollup = rollupTime(next);
  const subDone = next.subTasks.filter((s) => s.completed).length;
  const subTot  = next.subTasks.length;
  const pct     = subTot ? Math.round((subDone / subTot) * 100) : 0;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-8 py-8 space-y-10">

        {/* ── Massive elevated Next Best Action card ── */}
        <section className="relative">
          {/* Ambient energy glow */}
          <div className="absolute inset-0 -z-10 overflow-hidden rounded-[28px] pointer-events-none">
            <div className={`absolute -top-32 left-1/2 -translate-x-1/2 w-[640px] h-[640px] rounded-full blur-3xl opacity-[0.15] ${energy.glow}`} />
          </div>

          <div className="relative bg-zinc-900 border border-zinc-800 rounded-[28px] shadow-2xl shadow-black/40 overflow-hidden">
            {/* Overline */}
            <div className="px-9 pt-7 pb-1 flex items-center justify-between">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
                Next Best Action
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[11px] uppercase tracking-wider text-zinc-600">Score-ranked</span>
                {candidates.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setShowAlternatives((v) => !v)}
                    className="text-[11px] text-zinc-400 hover:text-violet-300 flex items-center gap-1 transition-colors"
                  >
                    {showAlternatives ? 'Hide' : 'See'} alternatives
                    <Icon name={showAlternatives ? 'chevron-up' : 'chevron-down'} className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>

            <div className="px-9 pt-3 pb-8">
              {/* Title */}
              <h2 className="text-zinc-50 text-[36px] leading-[1.1] tracking-tight max-w-3xl">
                {next.title}
              </h2>
              {next.description && (
                <p className="text-zinc-400 mt-2.5 max-w-2xl text-[15px] leading-relaxed line-clamp-2">
                  {next.description}
                </p>
              )}

              {/* Metadata pills */}
              <div className="flex items-center gap-2 mt-5 flex-wrap">
                <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs ${energy.bg} ${energy.color} border ${energy.border}`}>
                  <Icon name={energy.icon} className="w-3.5 h-3.5" />
                  {energy.label} energy
                </span>
                {next.bucket && (
                  <span className="inline-flex items-center px-3 py-1.5 rounded-full text-xs bg-zinc-800 text-zinc-300 border border-zinc-700/70">
                    {next.bucket}
                  </span>
                )}
                {rollup > 0 && (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs bg-violet-500/10 text-violet-300 border border-violet-500/30">
                    <Icon name="clock" className="w-3.5 h-3.5" />
                    ~{formatDuration(rollup)}
                  </span>
                )}
                {next.dueDate && (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs bg-zinc-800 text-zinc-300 border border-zinc-700/70">
                    <Icon name="calendar" className="w-3.5 h-3.5" />
                    Due {formatDateRel(next.dueDate)}
                  </span>
                )}
              </div>

              {/* Sub-task progress strip + checklist */}
              {subTot > 0 && (
                <div className="mt-7">
                  <div className="flex items-baseline justify-between mb-2">
                    <span className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">
                      Sub-tasks · {subDone} of {subTot}
                    </span>
                    <span className="text-[11px] text-zinc-400 tabular-nums">{pct}%</span>
                  </div>
                  <div className="h-[3px] rounded-full bg-zinc-800 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-violet-500 to-violet-400 transition-all duration-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-x-8 gap-y-2.5 mt-5">
                    {next.subTasks.slice(0, 6).map((st) => (
                      <div key={st.id} className="flex items-start gap-2.5 text-[14px]">
                        <span className={`mt-[3px] w-[18px] h-[18px] rounded-md border-2 flex items-center justify-center shrink-0 ${
                          st.completed ? 'bg-violet-500 border-violet-500' : 'border-zinc-600'
                        }`}>
                          {st.completed && <Icon name="check" className="w-3 h-3 text-white" />}
                        </span>
                        <span className={`flex-1 min-w-0 leading-snug break-words [overflow-wrap:anywhere] ${
                          st.completed ? 'line-through text-zinc-600' : 'text-zinc-300'
                        }`}>{st.title}</span>
                      </div>
                    ))}
                    {subTot > 6 && (
                      <span className="text-xs text-zinc-600 col-span-2">+{subTot - 6} more</span>
                    )}
                  </div>
                </div>
              )}

              {/* Action row */}
              <div className="mt-8 flex items-center gap-3 flex-wrap">
                <button
                  type="button"
                  onClick={() => onStartFocus(next.id)}
                  className="inline-flex items-center gap-2.5 bg-violet-600 hover:bg-violet-500 active:bg-violet-700 text-white text-[15px] px-7 py-3.5 rounded-xl shadow-lg shadow-violet-900/40 transition-all duration-200 active:scale-[0.97]"
                >
                  <Icon name="play" className="w-4 h-4" />
                  Start Focus
                  <span className="text-violet-100 text-xs ml-1 px-2 py-0.5 rounded-md bg-violet-700/60 tabular-nums font-mono">
                    {focusDuration}m
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onOpenTask(next.id)}
                  className="inline-flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm px-4 py-3 rounded-xl border border-zinc-700/60 transition-all duration-200 active:scale-[0.97]"
                >
                  <Icon name="square-pen" className="w-4 h-4" />
                  Open details
                </button>
                <div className="flex-1" />
                <button
                  type="button"
                  className="inline-flex items-center gap-2 text-zinc-400 hover:text-zinc-100 text-sm px-3 py-2 transition-colors"
                >
                  <Icon name="clock" className="w-4 h-4" />
                  Defer
                </button>
              </div>
            </div>

            {/* Alternatives drawer */}
            {showAlternatives && (
              <div className="border-t border-zinc-800 bg-zinc-950/40">
                <div className="px-8 py-5">
                  <p className="text-[11px] uppercase tracking-wider text-zinc-500 mb-3">Other strong candidates</p>
                  <div className="space-y-1.5">
                    {candidates.slice(1, 5).map((c) => {
                      const e = ENERGY_META[c.energyLevel];
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => onOpenTask(c.id)}
                          className="w-full text-left flex items-center gap-3 p-2.5 rounded-lg hover:bg-zinc-900 transition-colors"
                        >
                          <span className={`w-6 h-6 rounded-md flex items-center justify-center ${e.bg} ${e.border} border`}>
                            <Icon name={e.icon} className={`w-3 h-3 ${e.color}`} />
                          </span>
                          <span className="text-sm text-zinc-300 flex-1 truncate">{c.title}</span>
                          {c.bucket && <span className="text-xs text-zinc-500">{c.bucket}</span>}
                          <Icon name="chevron-right" className="w-3.5 h-3.5 text-zinc-600" />
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ── Today's History ── */}
        <section>
          <div className="flex items-end justify-between mb-5">
            <div>
              <h3 className="text-zinc-100 text-lg tracking-tight">Today's History</h3>
              <p className="text-xs text-zinc-500 mt-1">Focus sessions completed today</p>
            </div>
            <div className="inline-flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5">
              {(['grid', 'list'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setSessionViewMode(m)}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors ${
                    sessionViewMode === m ? 'bg-zinc-800 text-violet-300' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  <Icon name={m === 'grid' ? 'layout-grid' : 'list'} className="w-3.5 h-3.5" />
                  {m === 'grid' ? 'Grid' : 'List'}
                </button>
              ))}
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-10 text-center">
            <Icon name="clock" className="w-8 h-8 text-zinc-700 mx-auto mb-2" />
            <p className="text-sm text-zinc-500">No focus sessions yet today</p>
            <p className="text-xs text-zinc-600 mt-1">
              Press <span className="text-violet-300">Start Focus</span> to log your first.
            </p>
          </div>
        </section>

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
