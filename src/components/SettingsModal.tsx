// ─── SettingsModal ─────────────────────────────────────────────────────────────
// Right-panel slide-in showing account info and app settings.
// Staging build: taxonomy and data export stubs shown with v1.4.0 labels.

import { useEffect, useRef, useState } from 'react';
import type { AuthSession } from '../lib/authClient';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { Icon } from './Icon';

export interface SettingsModalProps {
  session: AuthSession;
  onClose: () => void;
  onLogout: () => void;
}

export function SettingsModal({ session, onClose, onLogout }: SettingsModalProps) {
  const containerRef = useRef<HTMLElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const r = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(r);
  }, []);

  const handleClose = () => {
    setMounted(false);
    setTimeout(onClose, 180);
  };

  useFocusTrap(containerRef, { active: mounted, onEscape: handleClose });

  const handleLogout = () => {
    onLogout();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40 pointer-events-none" role="presentation">
      <div
        onClick={handleClose}
        className={`absolute inset-0 bg-black/50 backdrop-blur-[2px] transition-opacity duration-200 pointer-events-auto ${mounted ? 'opacity-100' : 'opacity-0'}`}
      />

      <aside
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        className={`absolute right-0 top-0 bottom-0 w-full sm:w-[380px] bg-zinc-900/95 backdrop-blur-xl border-l border-zinc-800 shadow-2xl flex flex-col pointer-events-auto transition-transform duration-200 focus:outline-none ${mounted ? 'translate-x-0' : 'translate-x-full'}`}
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-5 border-b border-zinc-800 shrink-0 flex items-center justify-between">
          <h2 className="text-zinc-100 font-semibold text-[15px]">Settings</h2>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close settings"
            className="text-zinc-500 hover:text-zinc-200 p-1 rounded-lg hover:bg-zinc-800 transition-colors"
          >
            <Icon name="x" className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Account */}
          <Section label="Account">
            <div className="flex items-center gap-3 bg-zinc-800/50 border border-zinc-800 rounded-xl p-4">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-violet-600 to-violet-800 flex items-center justify-center shrink-0 shadow-lg shadow-violet-900/40">
                <span className="text-white text-sm font-bold">
                  {session.email[0].toUpperCase()}
                </span>
              </div>
              <div className="min-w-0">
                <div className="text-zinc-200 text-sm font-medium truncate">{session.email}</div>
                <div className="text-zinc-500 text-[11.5px] mt-0.5">Beta access</div>
              </div>
            </div>
          </Section>

          {/* Appearance */}
          <Section label="Appearance">
            <StubCard icon="sun-moon" title="Light / Dark theme">
              Full theme support is planned for v1.4.0. The app currently runs in dark mode only.
            </StubCard>
          </Section>

          {/* Taxonomy */}
          <Section label="Taxonomy">
            <StubCard icon="tags" title="Work type tags">
              Reactive and strategic sub-tag management is coming in v1.4.0.
            </StubCard>
          </Section>

          {/* Data */}
          <Section label="Data">
            <StubCard icon="archive" title="Export / Import backup">
              Encrypted vault backup and restore is planned for v1.4.0.
            </StubCard>
          </Section>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-zinc-800 shrink-0">
          <button
            type="button"
            onClick={handleLogout}
            className="w-full h-10 flex items-center justify-center gap-2 rounded-xl border border-zinc-800 hover:border-rose-500/40 text-zinc-400 hover:text-rose-300 text-sm transition-all duration-200"
          >
            <Icon name="log-out" className="w-4 h-4" />
            Sign out
          </button>
        </div>
      </aside>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-[10.5px] font-bold uppercase tracking-wider text-zinc-500 mb-2.5">{label}</h3>
      {children}
    </section>
  );
}

function StubCard({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <div className="bg-zinc-800/20 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1.5">
        <Icon name={icon} className="w-3.5 h-3.5 text-zinc-500" />
        <span className="text-zinc-400 text-sm font-medium">{title}</span>
        <span className="ml-auto text-[10px] text-zinc-600 border border-zinc-700 rounded px-1.5 py-0.5">v1.4.0</span>
      </div>
      <p className="text-zinc-600 text-[12.5px] leading-relaxed">{children}</p>
    </div>
  );
}
