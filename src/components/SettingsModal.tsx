// ─── Settings Modal (tabbed) ──────────────────────────────────────────────────
// Centered full-screen modal matching the design spec:
//   Sidebar nav → content pane. Tabs: Appearance, Workspace, Account, Data.

import { useRef, useState } from 'react';
import { loadVault, saveVault, type AuthSession } from '../lib/authClient';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useBridge } from '../hooks/useCryptoBridge';
import { buildExportPayload, downloadVaultBackup, parseImportFile, mergeVaults, type ImportSummary } from '../lib/exportVault';
import { Icon } from './Icon';

export interface SettingsModalProps {
  session: AuthSession;
  onClose: () => void;
  onLogout: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  workspaceProfile: 'simplistic' | 'power';
  onSetWorkspaceProfile: (v: 'simplistic' | 'power') => void;
  focusDuration: number;
  onSetFocusDuration: (v: number) => void;
  toolbarPosition: 'left' | 'right';
  onSetToolbarPosition: (v: 'left' | 'right') => void;
}

type Tab = 'appearance' | 'workspace' | 'account' | 'data';

const TAB_DEFS: { id: Tab; icon: string; label: string; desc: string }[] = [
  { id: 'appearance', icon: 'palette',         label: 'Appearance', desc: 'Theme and visual presentation' },
  { id: 'workspace',  icon: 'layout-dashboard', label: 'Workspace',  desc: 'Layout density and focus session length' },
  { id: 'account',    icon: 'user',             label: 'Account',    desc: 'Your profile and session' },
  { id: 'data',       icon: 'database',         label: 'Data',       desc: 'Export, import, and reset' },
];

export function SettingsModal({
  session, onClose, onLogout,
  theme, onToggleTheme,
  workspaceProfile, onSetWorkspaceProfile,
  focusDuration, onSetFocusDuration,
  toolbarPosition, onSetToolbarPosition,
}: SettingsModalProps) {
  const [tab, setTab] = useState<Tab>('appearance');
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef, { active: true, onEscape: onClose });

  // Close on backdrop click handled by onClick on the backdrop div
  const currentTab = TAB_DEFS.find((t) => t.id === tab)!;

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center p-4">
      <div onClick={onClose} className="absolute inset-0 bg-black/55 backdrop-blur-sm" />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        className="relative w-full max-w-[860px] max-h-[88vh] bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl shadow-black/40 overflow-hidden flex focus:outline-none animate-fade"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Sidebar ── */}
        <aside className="w-52 shrink-0 bg-zinc-950/40 border-r border-zinc-800 p-3 flex flex-col">
          <div className="flex items-center gap-2 px-2 py-2 mb-2">
            <div className="w-7 h-7 rounded-lg bg-zinc-800 border border-zinc-700/60 flex items-center justify-center">
              <Icon name="settings" className="w-3.5 h-3.5 text-violet-300" />
            </div>
            <div>
              <div className="text-zinc-100 text-xs font-medium">Settings</div>
              <div className="text-[10px] text-zinc-500 leading-none">Personalize</div>
            </div>
          </div>
          <nav className="space-y-0.5 flex-1">
            {TAB_DEFS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs transition-all duration-150 ${
                  tab === t.id
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
                }`}
              >
                <Icon name={t.icon} className="w-4 h-4" />
                {t.label}
              </button>
            ))}
          </nav>
          <button
            type="button"
            onClick={onClose}
            className="w-full flex items-center justify-center gap-2 h-9 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition-colors mt-2"
          >
            <Icon name="x" className="w-3.5 h-3.5" />
            Close
          </button>
        </aside>

        {/* ── Content ── */}
        <div className="flex-1 flex flex-col min-w-0">
          <header className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between shrink-0">
            <div>
              <h3 className="text-zinc-100 text-sm font-medium capitalize">{currentTab.label}</h3>
              <p className="text-[11px] text-zinc-500 mt-0.5">{currentTab.desc}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
            >
              <Icon name="x" className="w-4 h-4" />
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-6 py-5">
            {tab === 'appearance' && (
              <AppearancePane theme={theme} onToggleTheme={onToggleTheme} />
            )}
            {tab === 'workspace' && (
              <WorkspacePane
                workspaceProfile={workspaceProfile}
                onSetWorkspaceProfile={onSetWorkspaceProfile}
                focusDuration={focusDuration}
                onSetFocusDuration={onSetFocusDuration}
                toolbarPosition={toolbarPosition}
                onSetToolbarPosition={onSetToolbarPosition}
              />
            )}
            {tab === 'account' && (
              <AccountPane session={session} onLogout={onLogout} onClose={onClose} />
            )}
            {tab === 'data' && <DataPane session={session} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Shared primitives ────────────────────────────────────────────────────────

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 py-4 border-b border-zinc-800 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="text-zinc-200 text-sm">{label}</div>
        {hint && <div className="text-zinc-500 text-[12px] mt-0.5 leading-relaxed">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function SegmentedControl<T extends string>({
  value, onChange, options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string; icon?: string }[];
}) {
  return (
    <div className="inline-flex bg-zinc-950/60 border border-zinc-800 rounded-xl p-1 gap-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs transition-all duration-150 ${
            value === o.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200'
          }`}
        >
          {o.icon && <Icon name={o.icon} className="w-3.5 h-3.5" />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─── Panes ────────────────────────────────────────────────────────────────────

function AppearancePane({ theme, onToggleTheme }: { theme: 'dark' | 'light'; onToggleTheme: () => void }) {
  return (
    <div>
      <SettingRow label="Color theme" hint="Applies immediately across all views.">
        <SegmentedControl
          value={theme}
          onChange={(v) => { if (v !== theme) onToggleTheme(); }}
          options={[
            { id: 'dark'  as const, label: 'Dark',  icon: 'moon' },
            { id: 'light' as const, label: 'Light', icon: 'sun'  },
          ]}
        />
      </SettingRow>
    </div>
  );
}

function WorkspacePane({
  workspaceProfile, onSetWorkspaceProfile,
  focusDuration, onSetFocusDuration,
  toolbarPosition, onSetToolbarPosition,
}: {
  workspaceProfile: 'simplistic' | 'power';
  onSetWorkspaceProfile: (v: 'simplistic' | 'power') => void;
  focusDuration: number;
  onSetFocusDuration: (v: number) => void;
  toolbarPosition: 'left' | 'right';
  onSetToolbarPosition: (v: 'left' | 'right') => void;
}) {
  return (
    <div>
      <SettingRow label="Dashboard layout" hint="Simplistic shows a linear list. Power shows a dense Kanban grid.">
        <SegmentedControl
          value={workspaceProfile}
          onChange={onSetWorkspaceProfile}
          options={[
            { id: 'simplistic' as const, label: 'Simplistic', icon: 'list' },
            { id: 'power'      as const, label: 'Kanban',     icon: 'layout-grid' },
          ]}
        />
      </SettingRow>
      <SettingRow label="Focus session duration" hint="Default timer length when you press Start Focus.">
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={5}
            max={120}
            step={5}
            value={focusDuration}
            onChange={(e) => onSetFocusDuration(Math.max(5, Math.min(120, Number(e.target.value))))}
            className="w-20 h-9 bg-zinc-950 border border-zinc-800 focus:border-violet-500/50 rounded-lg px-3 text-sm text-zinc-200 text-center outline-none font-mono transition-colors"
          />
          <span className="text-sm text-zinc-500">min</span>
        </div>
      </SettingRow>
      <SettingRow label="Icon rail position" hint="Restart not required — takes effect immediately.">
        <SegmentedControl
          value={toolbarPosition}
          onChange={onSetToolbarPosition}
          options={[
            { id: 'left'  as const, label: 'Left'  },
            { id: 'right' as const, label: 'Right' },
          ]}
        />
      </SettingRow>
    </div>
  );
}

function AccountPane({
  session, onLogout, onClose,
}: { session: AuthSession; onLogout: () => void; onClose: () => void }) {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-4 bg-zinc-800/30 border border-zinc-800 rounded-xl p-4">
        <div className="w-11 h-11 rounded-full bg-gradient-to-br from-violet-600 to-violet-800 flex items-center justify-center shrink-0 shadow-lg shadow-violet-900/40">
          <span className="text-white text-sm font-bold">
            {session.email[0].toUpperCase()}
          </span>
        </div>
        <div className="min-w-0">
          <div className="text-zinc-100 text-sm font-medium truncate">{session.email}</div>
          <div className="text-zinc-500 text-[12px] mt-0.5">Beta access · Zero-knowledge vault</div>
        </div>
      </div>

      <button
        type="button"
        onClick={() => { onLogout(); onClose(); }}
        className="w-full h-10 flex items-center justify-center gap-2 rounded-xl border border-zinc-800 hover:border-rose-500/40 text-zinc-400 hover:text-rose-300 text-sm transition-all duration-200"
      >
        <Icon name="log-out" className="w-4 h-4" />
        Sign out
      </button>
    </div>
  );
}

function DataPane({ session }: { session: AuthSession }) {
  const bridge = useBridge();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Export state
  const [exportState, setExportState] = useState<'idle' | 'exporting' | 'downloaded' | 'error'>('idle');
  const [exportError, setExportError] = useState<string | null>(null);
  const [downloadedFilename, setDownloadedFilename] = useState<string | null>(null);

  // Import state
  const [importState, setImportState] = useState<'idle' | 'ready' | 'restoring' | 'done' | 'error'>('idle');
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importMode, setImportMode] = useState<'replace' | 'merge' | null>(null);

  const handleExport = async () => {
    setExportState('exporting');
    setExportError(null);
    try {
      const [tasks, resources] = await Promise.all([
        bridge.request({ kind: 'task.list' }),
        bridge.request({ kind: 'resource.list' }),
      ]);
      const payload = buildExportPayload(tasks, resources, session.email);
      const filename = downloadVaultBackup(payload);
      setDownloadedFilename(filename);
      setExportState('downloaded');
      setTimeout(() => { setExportState('idle'); setDownloadedFilename(null); }, 2500);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed');
      setExportState('error');
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      const summary = await parseImportFile(file);
      setImportSummary(summary);
      setImportError(null);
      setImportState('ready');
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Could not parse backup file.');
      setImportState('error');
    }
  };

  const handleImport = async (mode: 'replace' | 'merge') => {
    if (!importSummary) return;
    setImportMode(mode);
    setImportState('restoring');
    try {
      const { data: currentData, version } = await loadVault(session);
      let vaultToSave = importSummary.payload.vault;
      if (mode === 'merge' && currentData) {
        const cv = currentData as Record<string, unknown>;
        if (cv.format === 'v2') {
          vaultToSave = mergeVaults(currentData as typeof vaultToSave, importSummary.payload.vault);
        }
      }
      await saveVault(session, vaultToSave, version);
      setImportState('done');
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed.');
      setImportState('error');
    }
  };

  const resetImport = () => { setImportState('idle'); setImportSummary(null); setImportError(null); setImportMode(null); };

  return (
    <div className="space-y-4">
      {/* ── Export backup ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between p-4 rounded-xl border border-zinc-800 bg-zinc-800/20">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <Icon name="download" className="w-4 h-4 mt-0.5 text-zinc-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-zinc-200">Export backup</div>
            <div className="text-zinc-500 text-[12px] mt-0.5 leading-relaxed">
              Downloads a plaintext JSON file containing all your tasks and resources.
              Treat this file like a password — anyone with it can read your data.
            </div>
            {exportState === 'error' && exportError && (
              <div className="mt-2 text-[12px] text-rose-300 inline-flex items-start gap-1.5">
                <Icon name="alert-triangle" className="w-3 h-3 mt-0.5 shrink-0" />
                <span>{exportError}</span>
              </div>
            )}
            {exportState === 'downloaded' && downloadedFilename && (
              <div className="mt-2 text-[12px] text-emerald-300 inline-flex items-start gap-1.5">
                <Icon name="check" className="w-3 h-3 mt-0.5 shrink-0" />
                <span>Saved as <span className="font-mono text-emerald-200">{downloadedFilename}</span></span>
              </div>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={handleExport}
          disabled={exportState === 'exporting'}
          className={`shrink-0 ml-4 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-xs font-medium transition-all duration-150 active:scale-95 ${
            exportState === 'downloaded'
              ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
              : exportState === 'exporting'
              ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
              : 'bg-violet-600 hover:bg-violet-500 text-white shadow-lg shadow-violet-900/30'
          }`}
        >
          {exportState === 'exporting' && (<><span className="w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />Preparing…</>)}
          {exportState === 'downloaded' && (<><Icon name="check" className="w-3.5 h-3.5" />Downloaded</>)}
          {(exportState === 'idle' || exportState === 'error') && (<><Icon name="download" className="w-3.5 h-3.5" />Download backup</>)}
        </button>
      </div>

      {/* ── Import backup ─────────────────────────────────────────────── */}
      <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-800/20">
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={handleFileSelect}
        />
        <div className="flex items-center justify-between">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <Icon name="upload" className="w-4 h-4 mt-0.5 text-zinc-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-zinc-200">Import backup</div>
              <div className="text-zinc-500 text-[12px] mt-0.5 leading-relaxed">
                Restore from a previously exported backup file. Overwrites your current vault.
              </div>
            </div>
          </div>
          <div className="shrink-0 ml-4 flex items-center gap-2">
            {(importState === 'idle' || importState === 'error') && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100 transition-all duration-150 active:scale-95"
              >
                <Icon name="upload" className="w-3.5 h-3.5" />
                Choose file
              </button>
            )}
            {importState === 'ready' && (
              <>
                <button
                  type="button"
                  onClick={resetImport}
                  className="inline-flex items-center h-9 px-3 rounded-lg text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => handleImport('merge')}
                  className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-xs font-medium bg-zinc-700 hover:bg-zinc-600 text-zinc-100 transition-all duration-150 active:scale-95"
                >
                  <Icon name="git-merge" className="w-3.5 h-3.5" />
                  Merge
                </button>
                <button
                  type="button"
                  onClick={() => handleImport('replace')}
                  className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-xs font-medium bg-amber-600 hover:bg-amber-500 text-white transition-all duration-150 active:scale-95"
                >
                  <Icon name="upload" className="w-3.5 h-3.5" />
                  Replace
                </button>
              </>
            )}
            {importState === 'restoring' && (
              <button type="button" disabled className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-500 cursor-not-allowed">
                <span className="w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                Restoring…
              </button>
            )}
            {importState === 'done' && (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white transition-all duration-150 active:scale-95"
              >
                <Icon name="refresh-cw" className="w-3.5 h-3.5" />
                Reload page
              </button>
            )}
          </div>
        </div>
        {importState === 'ready' && importSummary && (
          <div className="mt-3 ml-7 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/25 text-[12px] text-amber-200 leading-relaxed">
            <span className="font-medium">
              {importSummary.taskCount} task{importSummary.taskCount !== 1 ? 's' : ''} and{' '}
              {importSummary.resourceCount} resource{importSummary.resourceCount !== 1 ? 's' : ''}
            </span>{' '}
            from {new Date(importSummary.payload.exportedAt).toLocaleString()}.{' '}
            <span className="text-amber-300/80">
              Merge adds these to your vault (newer edit wins on conflict).
              Replace overwrites your vault entirely.
            </span>
          </div>
        )}
        {importState === 'error' && importError && (
          <div className="mt-3 ml-7 text-[12px] text-rose-300 inline-flex items-start gap-1.5">
            <Icon name="alert-triangle" className="w-3 h-3 mt-0.5 shrink-0" />
            <span>{importError}</span>
          </div>
        )}
        {importState === 'done' && (
          <div className="mt-3 ml-7 text-[12px] text-emerald-300 inline-flex items-start gap-1.5">
            <Icon name="check" className="w-3 h-3 mt-0.5 shrink-0" />
            <span>Vault {importMode === 'merge' ? 'merged' : 'replaced'} successfully. Reload to see your data.</span>
          </div>
        )}
      </div>

      {/* ── Delete account — stub ─────────────────────────────────────── */}
      <div className="flex items-center justify-between p-4 rounded-xl border border-rose-500/20 bg-rose-500/5">
        <div className="flex items-start gap-3">
          <Icon name="trash-2" className="w-4 h-4 mt-0.5 text-rose-400" />
          <div>
            <div className="text-sm font-medium text-rose-300">Delete account</div>
            <div className="text-zinc-500 text-[12px] mt-0.5">Permanently remove your account and all data.</div>
          </div>
        </div>
        <span className="text-[10px] text-zinc-600 border border-zinc-700 rounded px-1.5 py-0.5 ml-4 shrink-0">v1.4.0</span>
      </div>
    </div>
  );
}

