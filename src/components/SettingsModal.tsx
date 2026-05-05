// ─── Settings Modal (tabbed) ──────────────────────────────────────────────────
// Centered full-screen modal matching the design spec:
//   Sidebar nav → content pane. Tabs: Appearance, Workspace, Account, Data.

import { useRef, useState } from 'react';
import type { AuthSession } from '../lib/authClient';
import { useFocusTrap } from '../hooks/useFocusTrap';
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
            {tab === 'data' && <DataPane />}
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

function DataPane() {
  return (
    <div className="space-y-4">
      {[
        { icon: 'download', title: 'Export backup', desc: 'Download an encrypted copy of your vault.' },
        { icon: 'upload',   title: 'Import backup', desc: 'Restore from a previously exported vault file.' },
        { icon: 'trash-2',  title: 'Delete account', desc: 'Permanently remove your account and all data.', danger: true },
      ].map((item) => (
        <div
          key={item.title}
          className={`flex items-center justify-between p-4 rounded-xl border ${
            item.danger ? 'border-rose-500/20 bg-rose-500/5' : 'border-zinc-800 bg-zinc-800/20'
          }`}
        >
          <div className="flex items-start gap-3">
            <Icon name={item.icon} className={`w-4 h-4 mt-0.5 ${item.danger ? 'text-rose-400' : 'text-zinc-400'}`} />
            <div>
              <div className={`text-sm font-medium ${item.danger ? 'text-rose-300' : 'text-zinc-200'}`}>{item.title}</div>
              <div className="text-zinc-500 text-[12px] mt-0.5">{item.desc}</div>
            </div>
          </div>
          <span className="text-[10px] text-zinc-600 border border-zinc-700 rounded px-1.5 py-0.5 ml-4 shrink-0">v1.4.0</span>
        </div>
      ))}
    </div>
  );
}

