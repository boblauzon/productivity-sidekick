// ─── Focus Theatre (Active Focus Engine) ──────────────────────────────────────
// Three phases: preflight → running/paused → done.
// Pre-flight: confirm/adjust duration before the timer starts.
// Running: distraction-free countdown with distractor logging.
// Done: flow-state checkbox + task-complete options.

import { useCallback, useEffect, useState } from 'react';
import type { Task } from '../lib/types';
import { useBridge } from '../hooks/useCryptoBridge';
import { Icon } from './Icon';

const ENERGY = {
  high:   { icon: 'zap',         color: 'text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-500/25', glow: 'bg-emerald-500', label: 'High'   },
  medium: { icon: 'battery',     color: 'text-amber-300',   bg: 'bg-amber-500/10',   border: 'border-amber-500/25',   glow: 'bg-amber-500',   label: 'Medium' },
  low:    { icon: 'battery-low', color: 'text-sky-300',     bg: 'bg-sky-500/10',     border: 'border-sky-500/25',     glow: 'bg-sky-500',     label: 'Low'    },
} as const;

const PRESETS = [15, 25, 45, 60, 90];

type Phase = 'preflight' | 'running' | 'paused' | 'done';

interface Distractor { type: string; note: string; timestamp: number }

interface FocusTheatreProps {
  task: Task | null;
  focusDuration: number;
  distractorOptions: string[];
  onExit: () => void;
}

export function FocusTheatre({ task, focusDuration, distractorOptions, onExit }: FocusTheatreProps) {
  const bridge = useBridge();
  const [phase, setPhase] = useState<Phase>('preflight');
  const [duration, setDuration] = useState(focusDuration);
  const [secondsLeft, setSecondsLeft] = useState(focusDuration * 60);
  const [distractors, setDistractors] = useState<Distractor[]>([]);
  const [showDistractorMenu, setShowDistractorMenu] = useState(false);
  const [flowAchieved, setFlowAchieved] = useState(false);

  // Countdown tick
  useEffect(() => {
    if (phase !== 'running') return;
    const id = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) { clearInterval(id); setPhase('done'); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [phase]);

  // Esc exits pre-flight/done/paused
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (phase === 'preflight' || phase === 'done' || phase === 'paused')) onExit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, onExit]);

  const adjustDuration = useCallback((min: number) => {
    const v = Math.max(1, Math.min(180, min));
    setDuration(v);
    if (phase === 'preflight') setSecondsLeft(v * 60);
  }, [phase]);

  const startSession = () => { setSecondsLeft(duration * 60); setPhase('running'); };
  const pauseSession  = () => setPhase('paused');
  const resumeSession = () => setPhase('running');

  const logDistractor = (type: string, note: string) => {
    setDistractors((d) => [...d, { type, note: note || type, timestamp: Date.now() }]);
    setShowDistractorMenu(false);
  };

  const completeSession = (taskCompleted: boolean) => {
    if (taskCompleted && task) {
      bridge.request({ kind: 'task.update', id: task.id, patch: { status: 'completed' } }).catch(() => {});
    }
    onExit();
  };

  const abandonSession = () => {
    if (distractors.length > 0 || elapsedSec > 60) {
      if (!confirm('Exit this focus session?')) return;
    }
    onExit();
  };

  const totalSec   = duration * 60;
  const elapsedSec = totalSec - secondsLeft;
  const pct        = totalSec ? (elapsedSec / totalSec) * 100 : 0;
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const ss = String(secondsLeft % 60).padStart(2, '0');

  if (!task) {
    return (
      <div className="flex-1 flex items-center justify-center bg-zinc-950">
        <div className="text-center">
          <div className="w-14 h-14 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mx-auto mb-4">
            <Icon name="alert-circle" className="w-6 h-6 text-zinc-500" />
          </div>
          <h2 className="text-zinc-300 text-lg mb-4">Task not found</h2>
          <button type="button" onClick={onExit}
            className="inline-flex items-center gap-2 h-11 px-4 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-100 text-sm transition-colors">
            <Icon name="arrow-left" className="w-4 h-4" />
            Back to Focus
          </button>
        </div>
      </div>
    );
  }

  const energy = ENERGY[task.energyLevel];

  // ── Pre-flight ─────────────────────────────────────────────────────────────
  if (phase === 'preflight') {
    return (
      <div className="flex-1 overflow-y-auto bg-zinc-950">
        <div className="max-w-2xl mx-auto px-8 py-12">
          <button type="button" onClick={onExit}
            className="text-xs text-zinc-500 hover:text-zinc-200 inline-flex items-center gap-1.5 transition-colors">
            <Icon name="arrow-left" className="w-3.5 h-3.5" />
            Back to Focus
          </button>

          <div className="mt-6 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-violet-300">
            <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
            Pre-flight check · timer paused
          </div>

          <h1 className="mt-3 text-zinc-50 text-[34px] leading-[1.1] tracking-tight">
            Ready to focus on this?
          </h1>

          {/* Task summary card */}
          <div className="mt-6 bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
            <div className="flex items-start gap-3">
              <span className={`mt-1 w-8 h-8 rounded-md flex items-center justify-center ${energy.bg} ${energy.border} border shrink-0`}>
                <Icon name={energy.icon} className={`w-4 h-4 ${energy.color}`} />
              </span>
              <div className="flex-1 min-w-0">
                <h2 className="text-zinc-100 text-[18px] leading-snug">{task.title}</h2>
                {task.description && (
                  <p className="mt-1 text-sm text-zinc-400 leading-relaxed line-clamp-2">{task.description}</p>
                )}
                <div className="mt-3 flex items-center gap-2 flex-wrap">
                  <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full ${energy.bg} ${energy.color} border ${energy.border}`}>
                    <Icon name={energy.icon} className="w-3 h-3" />
                    {energy.label} energy
                  </span>
                  {task.bucket && (
                    <span className="inline-flex items-center text-[11px] px-2 py-1 rounded-full bg-zinc-800 text-zinc-300 border border-zinc-700/60">
                      {task.bucket}
                    </span>
                  )}
                  {task.subTasks.length > 0 && (
                    <span className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full bg-zinc-800/60 text-zinc-400 border border-zinc-800">
                      <Icon name="list-checks" className="w-3 h-3" />
                      {task.subTasks.filter((s) => s.completed).length}/{task.subTasks.length} sub-tasks
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Duration picker */}
          <section className="mt-8">
            <div className="flex items-baseline justify-between mb-3">
              <h3 className="text-zinc-200 text-sm font-medium">Session duration</h3>
              <span className="text-[11px] text-zinc-500">Confirm or adjust before starting</span>
            </div>
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
              <div className="flex items-end justify-center gap-2 select-none">
                <button type="button" onClick={() => adjustDuration(duration - 5)} disabled={duration <= 5}
                  className="w-11 h-11 rounded-full bg-zinc-800 hover:bg-zinc-700 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed text-zinc-200 inline-flex items-center justify-center transition-all mb-3">
                  <Icon name="minus" className="w-4 h-4" />
                </button>
                <input
                  type="number" min="1" max="180" value={duration}
                  onChange={(e) => adjustDuration(parseInt(e.target.value) || 1)}
                  className="w-[180px] bg-transparent text-center text-zinc-50 text-[80px] leading-none tabular-nums tracking-tight outline-none focus:text-violet-200 transition-colors font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                <span className="text-zinc-500 text-2xl mb-4">min</span>
                <button type="button" onClick={() => adjustDuration(duration + 5)} disabled={duration >= 180}
                  className="w-11 h-11 rounded-full bg-zinc-800 hover:bg-zinc-700 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed text-zinc-200 inline-flex items-center justify-center transition-all mb-3">
                  <Icon name="plus" className="w-4 h-4" />
                </button>
              </div>
              <div className="mt-5 flex items-center justify-center gap-2 flex-wrap">
                {PRESETS.map((m) => (
                  <button key={m} type="button" onClick={() => adjustDuration(m)}
                    className={`h-9 px-3.5 rounded-lg text-xs transition-all active:scale-95 border ${
                      duration === m
                        ? 'bg-violet-600 border-violet-500 text-white shadow-lg shadow-violet-900/30'
                        : 'bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-900'
                    }`}>
                    {m}m
                  </button>
                ))}
              </div>
            </div>
          </section>

          <div className="mt-8 flex items-center gap-3">
            <button type="button" onClick={startSession}
              className="inline-flex items-center gap-2.5 min-h-[56px] px-5 py-2.5 text-sm rounded-xl bg-violet-600 hover:bg-violet-500 active:bg-violet-700 text-white shadow-lg shadow-violet-900/30 transition-all active:scale-[0.97]">
              <Icon name="play" className="w-[18px] h-[18px]" />
              Start Focus · {duration}m
            </button>
            <button type="button" onClick={onExit}
              className="inline-flex items-center gap-2 min-h-[56px] px-5 py-2.5 text-sm rounded-xl text-zinc-300 hover:text-zinc-100 hover:bg-zinc-900 transition-all">
              Cancel
            </button>
            <div className="flex-1" />
            <span className="text-[11px] text-zinc-500 inline-flex items-center gap-1.5">
              <kbd className="px-1.5 py-0.5 rounded border border-zinc-800 bg-zinc-900 text-[10px] text-zinc-400">Esc</kbd>
              to back out
            </span>
          </div>

          <p className="mt-4 text-[12px] text-zinc-500 leading-relaxed">
            Tip — short sessions (15–25m) work best for low-energy admin tasks.
            Longer sessions (45–90m) suit deep, high-energy work.
          </p>
        </div>
      </div>
    );
  }

  // ── Running / paused / done ─────────────────────────────────────────────────
  const isRunning = phase === 'running';
  const isDone    = phase === 'done';

  return (
    <div className="flex-1 overflow-hidden bg-zinc-950 relative">
      {/* Ambient glow */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className={`absolute -top-40 left-1/2 -translate-x-1/2 w-[800px] h-[800px] rounded-full blur-3xl opacity-[0.14] ${energy.glow}`} />
      </div>

      <div className="relative h-full flex flex-col items-center justify-center px-8">
        {/* Status label */}
        <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-4 inline-flex items-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full ${
            isDone ? 'bg-emerald-400' : isRunning ? 'bg-violet-400 animate-pulse' : 'bg-amber-400'
          }`} />
          {isDone ? 'Session complete' : isRunning ? 'In focus' : 'Paused'}
        </p>

        <h2 className="text-zinc-100 text-2xl text-center tracking-tight max-w-2xl leading-snug">
          {task.title}
        </h2>

        {/* Big clock */}
        <div className="mt-12 text-zinc-50 text-[140px] leading-none font-light tabular-nums tracking-tighter font-mono">
          {mm}<span className="text-zinc-700">:</span>{ss}
        </div>

        {/* Progress bar */}
        <div className="w-[420px] max-w-full h-1 rounded-full bg-zinc-800 overflow-hidden mt-6">
          <div
            className={`h-full rounded-full transition-all duration-1000 ${isDone ? 'bg-emerald-400' : 'bg-gradient-to-r from-violet-500 to-violet-400'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between w-[420px] max-w-full text-[11px] text-zinc-500 tabular-nums">
          <span>{Math.floor(elapsedSec / 60)}m elapsed</span>
          <span>{duration}m total</span>
        </div>

        {/* Controls */}
        {!isDone && (
          <div className="mt-10 flex items-center gap-3">
            {isRunning ? (
              <button type="button" onClick={pauseSession}
                className="inline-flex items-center gap-2 min-h-[56px] px-5 py-2.5 text-sm rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/60 text-zinc-100 transition-all active:scale-[0.97]">
                <Icon name="pause" className="w-[18px] h-[18px]" />
                Pause
              </button>
            ) : (
              <button type="button" onClick={resumeSession}
                className="inline-flex items-center gap-2 min-h-[56px] px-5 py-2.5 text-sm rounded-xl bg-violet-600 hover:bg-violet-500 text-white shadow-lg shadow-violet-900/30 transition-all active:scale-[0.97]">
                <Icon name="play" className="w-[18px] h-[18px]" />
                Resume
              </button>
            )}

            {/* Distractor log */}
            <div className="relative">
              <button type="button" onClick={() => setShowDistractorMenu((v) => !v)}
                className="inline-flex items-center gap-2 min-h-[56px] px-5 py-2.5 text-sm rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/60 text-zinc-100 transition-all active:scale-[0.97]">
                <Icon name="alert-circle" className="w-[18px] h-[18px]" />
                Log distractor
                {distractors.length > 0 && (
                  <span className="ml-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] tabular-nums">
                    {distractors.length}
                  </span>
                )}
              </button>
              {showDistractorMenu && (
                <div className="absolute bottom-full mb-2 left-0 w-56 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl shadow-black/50 p-1.5 z-10 animate-fade">
                  <p className="text-[10px] uppercase tracking-wider text-zinc-500 px-2 py-1.5">What pulled you away?</p>
                  {distractorOptions.length > 0 ? (
                    distractorOptions.map((opt) => (
                      <button key={opt} type="button" onClick={() => logDistractor('external', opt)}
                        className="w-full text-left text-sm text-zinc-200 hover:bg-zinc-800 rounded-md px-2 py-1.5 transition-colors">
                        {opt}
                      </button>
                    ))
                  ) : (
                    <p className="text-xs text-zinc-600 px-2 py-1">
                      Add options in Settings → Workspace → Distractors
                    </p>
                  )}
                  <div className="border-t border-zinc-800 mt-1 pt-1">
                    <button type="button" onClick={() => logDistractor('internal', 'Mind wandered')}
                      className="w-full text-left text-sm text-zinc-300 hover:bg-zinc-800 rounded-md px-2 py-1.5 transition-colors inline-flex items-center gap-2">
                      <Icon name="brain" className="w-3.5 h-3.5 text-zinc-500" />
                      Internal drift
                    </button>
                  </div>
                </div>
              )}
            </div>

            <button type="button" onClick={abandonSession}
              className="inline-flex items-center gap-2 min-h-[56px] px-5 py-2.5 text-sm rounded-xl text-zinc-300 hover:text-zinc-100 hover:bg-zinc-900 transition-all">
              <Icon name="x" className="w-[18px] h-[18px]" />
              End session
            </button>
          </div>
        )}

        {/* Done — flow check + complete */}
        {isDone && (
          <div className="mt-12 w-full max-w-md">
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
              <p className="text-[11px] uppercase tracking-wider text-zinc-500 mb-3">How did it go?</p>
              <label className="flex items-center gap-3 cursor-pointer group">
                <span className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${
                  flowAchieved ? 'bg-emerald-500 border-emerald-500' : 'border-zinc-600 group-hover:border-emerald-400'
                }`}>
                  {flowAchieved && <Icon name="check" className="w-3 h-3 text-white" />}
                </span>
                <span className="text-zinc-200 text-sm flex-1">I reached flow state</span>
                <span className="text-[11px] text-zinc-500">
                  {distractors.length} distractor{distractors.length !== 1 ? 's' : ''}
                </span>
                <input type="checkbox" checked={flowAchieved} onChange={(e) => setFlowAchieved(e.target.checked)} className="sr-only" />
              </label>

              <div className="mt-5 space-y-1.5">
                <button type="button" onClick={() => completeSession(true)}
                  className="w-full inline-flex items-center justify-center gap-2 h-11 px-4 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-sm shadow-lg shadow-violet-900/30 transition-all active:scale-[0.97]">
                  <Icon name="check-check" className="w-4 h-4" />
                  Mark task complete
                </button>
                <button type="button" onClick={() => completeSession(false)}
                  className="w-full inline-flex items-center justify-center gap-2 h-11 px-4 rounded-xl text-zinc-300 hover:text-zinc-100 hover:bg-zinc-900 text-sm transition-all">
                  Save session, keep task open
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
