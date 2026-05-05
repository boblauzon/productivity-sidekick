// ─── AuthScreen ────────────────────────────────────────────────────────────────
// Five views managed as local state — no router needed:
//   login → register → recoveryKey → (app)
//   login → recovery → newRecoveryKey → (app)
//
// Crypto operations are async and block the UI; a progress indicator
// shows during derivation (~300ms–2s depending on device at 600k PBKDF2).
// All form validation is client-side before any API call is made.

import React, { useState, useRef, useCallback, type KeyboardEvent } from 'react';
import { login, register, recoverAccount } from '../lib/authClient';
import type { AuthSession } from '../lib/authClient';
import { Icon } from './Icon';

export interface AuthScreenProps {
  onAuthenticated: (session: AuthSession) => void;
}

type AuthView = 'login' | 'register' | 'recoveryKey' | 'recovery' | 'newRecoveryKey';

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [view, setView] = useState<AuthView>('login');
  const [pendingSession, setPendingSession] = useState<AuthSession | null>(null);
  const [pendingRecoveryKey, setPendingRecoveryKey] = useState('');
  const [newRecoveryKey, setNewRecoveryKey] = useState('');

  const handleLoginSuccess = useCallback((session: AuthSession) => {
    onAuthenticated(session);
  }, [onAuthenticated]);

  const handleRegisterSuccess = useCallback((session: AuthSession, recoveryKey: string) => {
    setPendingSession(session);
    setPendingRecoveryKey(recoveryKey);
    setView('recoveryKey');
  }, []);

  const handleRecoverySuccess = useCallback((session: AuthSession, rk: string) => {
    setPendingSession(session);
    setNewRecoveryKey(rk);
    setView('newRecoveryKey');
  }, []);

  const confirmAndEnter = useCallback(() => {
    if (pendingSession) onAuthenticated(pendingSession);
  }, [pendingSession, onAuthenticated]);

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center px-6 py-12"
         style={{
           background: 'radial-gradient(ellipse at 20% 50%, rgba(139,92,246,0.07) 0%, transparent 55%), radial-gradient(ellipse at 80% 20%, rgba(139,92,246,0.04) 0%, transparent 50%), #09090b',
         }}>
      {view === 'login' && (
        <LoginView
          onSuccess={handleLoginSuccess}
          onShowRegister={() => setView('register')}
          onShowRecovery={() => setView('recovery')}
        />
      )}
      {view === 'register' && (
        <RegisterView
          onSuccess={handleRegisterSuccess}
          onShowLogin={() => setView('login')}
        />
      )}
      {view === 'recoveryKey' && (
        <RecoveryKeyDisplay
          recoveryKey={pendingRecoveryKey}
          heading="Save your recovery key"
          subtext="This is the only way to recover your data if you forget your password. It will never be shown again."
          confirmLabel="I've saved my recovery key — Continue"
          onConfirm={confirmAndEnter}
        />
      )}
      {view === 'recovery' && (
        <RecoveryView
          onSuccess={handleRecoverySuccess}
          onBackToLogin={() => setView('login')}
        />
      )}
      {view === 'newRecoveryKey' && (
        <RecoveryKeyDisplay
          recoveryKey={newRecoveryKey}
          heading="New recovery key generated"
          subtext="Your password has been reset. Your old recovery key no longer works — save this new one."
          confirmLabel="I've saved it — Continue"
          onConfirm={confirmAndEnter}
        />
      )}
    </div>
  );
}

// ─── Shared card shell ─────────────────────────────────────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full max-w-[420px] bg-zinc-900 border border-zinc-800 rounded-2xl p-8 shadow-2xl shadow-black/50 relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-[3px] bg-gradient-to-r from-violet-600 to-indigo-500" />
      {children}
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5 mb-7">
      <div className="w-9 h-9 rounded-[10px] bg-gradient-to-br from-violet-600 to-violet-800 flex items-center justify-center shadow-lg shadow-violet-900/40">
        <span className="text-white font-black text-[13px] tracking-tighter">PS</span>
      </div>
      <span className="text-zinc-100 font-bold text-[17px] tracking-tight">Productivity Sidekick</span>
    </div>
  );
}

const AuthInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className = '', ...props }, ref) => (
    <input
      ref={ref}
      {...props}
      className={`w-full h-11 bg-zinc-950 border border-zinc-800 hover:border-zinc-700 focus:border-violet-500/60 focus:ring-2 focus:ring-violet-500/15 rounded-xl px-3.5 text-[14px] text-zinc-200 placeholder:text-zinc-600 outline-none transition-all duration-200 ${className}`}
    />
  ),
);
AuthInput.displayName = 'AuthInput';

function PrimaryBtn({ loading, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) {
  return (
    <button
      type="submit"
      disabled={loading || props.disabled}
      {...props}
      className="w-full h-11 mt-2 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl shadow-lg shadow-violet-900/30 transition-all duration-200 active:scale-[0.98]"
    >
      {loading ? (
        <span className="inline-flex items-center gap-2 justify-center">
          <Spinner /> Processing…
        </span>
      ) : children}
    </button>
  );
}

function SecondaryBtn(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className="w-full h-11 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-200 text-sm font-medium rounded-xl transition-all duration-200 active:scale-[0.98]"
    />
  );
}

function ErrorBanner({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-2 px-3.5 py-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-sm text-rose-300 mb-4">
      <Icon name="alert-triangle" className="w-4 h-4 shrink-0 mt-0.5" />
      <span>{message}</span>
    </div>
  );
}

function ProgressBanner({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="flex items-center gap-2.5 px-3.5 py-3 bg-violet-500/10 border border-violet-500/30 rounded-xl text-sm text-violet-300 mb-4">
      <Spinner className="border-violet-700 border-t-violet-400" />
      <span>{message}</span>
    </div>
  );
}

function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      className={`w-4 h-4 rounded-full border-2 border-zinc-700 border-t-violet-400 animate-spin shrink-0 ${className}`}
    />
  );
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <label className="block text-[11px] font-bold uppercase tracking-[0.04em] text-zinc-500 mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}

function AuthLink({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-violet-400 hover:text-violet-300 font-semibold text-[13px] transition-colors hover:underline"
    >
      {children}
    </button>
  );
}

// ─── Password strength ────────────────────────────────────────────────────────

function passwordStrength(pw: string): number {
  let score = 0;
  if (pw.length >= 10) score += 20;
  if (pw.length >= 14) score += 20;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score += 20;
  if (/[0-9]/.test(pw)) score += 20;
  if (/[^A-Za-z0-9]/.test(pw)) score += 20;
  return score;
}

function StrengthBar({ password }: { password: string }) {
  const pct = passwordStrength(password);
  const color = pct < 40 ? 'bg-rose-500' : pct < 70 ? 'bg-amber-400' : 'bg-emerald-500';
  return (
    <div className="h-[3px] bg-zinc-800 rounded-full mt-2 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-300 ${color}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ─── Login ────────────────────────────────────────────────────────────────────

function LoginView({
  onSuccess,
  onShowRegister,
  onShowRecovery,
}: {
  onSuccess: (s: AuthSession) => void;
  onShowRegister: () => void;
  onShowRecovery: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const pwRef = useRef<HTMLInputElement>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email.trim() || !password) { setError('Email and password are required.'); return; }
    setLoading(true);
    try {
      const session = await login(email.trim(), password);
      onSuccess(session);
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  };

  return (
    <Card>
      <Brand />
      <h2 className="text-zinc-100 text-[22px] font-bold tracking-tight mb-1.5">Welcome back</h2>
      <p className="text-zinc-500 text-[13.5px] mb-6 leading-relaxed">Sign in to access your encrypted workspace.</p>

      <ErrorBanner message={error} />
      {loading && <ProgressBanner message="Deriving encryption keys…" />}

      <form onSubmit={submit}>
        <Field label="Email">
          <AuthInput
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            autoFocus
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') { e.preventDefault(); pwRef.current?.focus(); }
            }}
          />
        </Field>
        <Field label="Master password">
          <AuthInput
            ref={pwRef}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Your master password"
            autoComplete="current-password"
          />
        </Field>
        <PrimaryBtn loading={loading}>Sign In</PrimaryBtn>
      </form>

      <div className="mt-5 text-center text-[13px] text-zinc-500 space-y-1.5">
        <div>Don't have an account?{' '}
          <AuthLink onClick={onShowRegister}>Create one</AuthLink>
        </div>
        <div>
          <AuthLink onClick={onShowRecovery}>Forgot password?</AuthLink>
        </div>
      </div>
    </Card>
  );
}

// ─── Register ─────────────────────────────────────────────────────────────────

function RegisterView({
  onSuccess,
  onShowLogin,
}: {
  onSuccess: (s: AuthSession, recoveryKey: string) => void;
  onShowLogin: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [betaCode, setBetaCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email.trim()) { setError('Email is required.'); return; }
    if (password.length < 10) { setError('Password must be at least 10 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    if (!betaCode.trim()) { setError('A beta access code is required.'); return; }
    setLoading(true);
    try {
      const { session, recoveryKey } = await register(email.trim(), password, betaCode.trim());
      onSuccess(session, recoveryKey);
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  };

  return (
    <Card>
      <Brand />
      <h2 className="text-zinc-100 text-[22px] font-bold tracking-tight mb-1.5">Create your account</h2>
      <p className="text-zinc-500 text-[13.5px] mb-6 leading-relaxed">
        Your data is end-to-end encrypted. We can never see your tasks, bookmarks, or sessions.
      </p>

      <ErrorBanner message={error} />
      {loading && <ProgressBanner message="Generating encryption keys…" />}

      <form onSubmit={submit}>
        <Field label="Email">
          <AuthInput
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            autoFocus
          />
        </Field>
        <Field label="Master password">
          <AuthInput
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Min 10 characters"
            autoComplete="new-password"
          />
          <StrengthBar password={password} />
        </Field>
        <Field label="Confirm password">
          <AuthInput
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Re-enter password"
            autoComplete="new-password"
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
            }}
          />
        </Field>
        <Field label={<>Beta Access Code <span className="text-rose-400">*</span></>}>
          <AuthInput
            type="text"
            value={betaCode}
            onChange={(e) => setBetaCode(e.target.value)}
            placeholder="Enter your invite code"
            autoComplete="off"
            className="font-mono tracking-widest text-center"
          />
        </Field>
        <PrimaryBtn loading={loading}>Create Account</PrimaryBtn>
      </form>

      <div className="mt-5 text-center text-[13px] text-zinc-500">
        Already have an account?{' '}
        <AuthLink onClick={onShowLogin}>Sign in</AuthLink>
      </div>
    </Card>
  );
}

// ─── Recovery key display (used both post-register and post-recovery) ──────────

function RecoveryKeyDisplay({
  recoveryKey,
  heading,
  subtext,
  confirmLabel,
  onConfirm,
}: {
  recoveryKey: string;
  heading: string;
  subtext: string;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(recoveryKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card>
      <Brand />
      <h2 className="text-zinc-100 text-[22px] font-bold tracking-tight mb-1.5">{heading}</h2>
      <p className="text-zinc-500 text-[13.5px] mb-5 leading-relaxed">{subtext}</p>

      <div className="bg-amber-500/10 border-2 border-amber-500/40 rounded-xl p-5 mb-5 text-center">
        <div className="text-[10.5px] font-bold uppercase tracking-wider text-amber-500/80 mb-2">
          Your Recovery Key
        </div>
        <div
          className="font-mono text-[14.5px] font-semibold text-zinc-100 tracking-[0.08em] leading-[1.9] break-all select-all mb-3"
          title="Click to select all"
        >
          {recoveryKey}
        </div>
        <p className="text-[11.5px] text-amber-500/70 font-semibold leading-relaxed">
          Store this somewhere safe. Without it, a forgotten password means permanent data loss.
        </p>
      </div>

      <SecondaryBtn onClick={copy} className="mb-2.5">
        {copied ? (
          <span className="inline-flex items-center gap-2 justify-center w-full">
            <Icon name="check" className="w-4 h-4 text-emerald-400" /> Copied!
          </span>
        ) : (
          <span className="inline-flex items-center gap-2 justify-center w-full">
            <Icon name="clipboard" className="w-4 h-4" /> Copy to Clipboard
          </span>
        )}
      </SecondaryBtn>

      <button
        type="button"
        onClick={onConfirm}
        className="w-full h-11 bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold rounded-xl shadow-lg shadow-violet-900/30 transition-all duration-200 active:scale-[0.98]"
      >
        {confirmLabel}
      </button>
    </Card>
  );
}

// ─── Recovery (forgot password) ───────────────────────────────────────────────

function RecoveryView({
  onSuccess,
  onBackToLogin,
}: {
  onSuccess: (s: AuthSession, newRecoveryKey: string) => void;
  onBackToLogin: () => void;
}) {
  const [email, setEmail] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email.trim() || !recoveryKey.trim() || !newPassword || !confirm) {
      setError('All fields are required.'); return;
    }
    if (newPassword.length < 10) { setError('New password must be at least 10 characters.'); return; }
    if (newPassword !== confirm) { setError('Passwords do not match.'); return; }
    setLoading(true);
    try {
      const { session, newRecoveryKey } = await recoverAccount(
        email.trim(), recoveryKey.trim(), newPassword,
      );
      onSuccess(session, newRecoveryKey);
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  };

  return (
    <Card>
      <Brand />
      <h2 className="text-zinc-100 text-[22px] font-bold tracking-tight mb-1.5">Account recovery</h2>
      <p className="text-zinc-500 text-[13.5px] mb-6 leading-relaxed">
        Enter your recovery key to reset your master password. Your encrypted data will be preserved.
      </p>

      <ErrorBanner message={error} />
      {loading && <ProgressBanner message="Recovering account…" />}

      <form onSubmit={submit}>
        <Field label="Email">
          <AuthInput
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            autoFocus
          />
        </Field>
        <Field label="Recovery key">
          <AuthInput
            type="text"
            value={recoveryKey}
            onChange={(e) => setRecoveryKey(e.target.value)}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            autoComplete="off"
            className="font-mono tracking-[0.06em] text-center text-[12.5px]"
          />
        </Field>
        <Field label="New master password">
          <AuthInput
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Min 10 characters"
            autoComplete="new-password"
          />
          <StrengthBar password={newPassword} />
        </Field>
        <Field label="Confirm new password">
          <AuthInput
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Re-enter new password"
            autoComplete="new-password"
          />
        </Field>
        <PrimaryBtn loading={loading}>Reset Password</PrimaryBtn>
      </form>

      <div className="mt-5 text-center">
        <AuthLink onClick={onBackToLogin}>← Back to sign in</AuthLink>
      </div>
    </Card>
  );
}
