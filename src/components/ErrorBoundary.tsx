// ─── ErrorBoundary ─────────────────────────────────────────────────────────────
// React class component that catches render-tree throws below it and
// displays a friendly fallback UI instead of letting the entire tree
// unmount.
//
// PR-1.5 wires this in src/main.tsx around <App />. Without it, a single
// render error — say, a corrupt date string in a task, or an undefined
// property dereference — blanks the whole app and forces a hard reload.
// With it, the user sees a clear "something went wrong" screen with a
// reload action and their work remains safe on the server.
//
// What this CAN catch:
//   • Render-time throws (most common)
//   • Lifecycle method throws
//   • Errors in constructors of class components
//
// What this CANNOT catch (these are React's documented limitations):
//   • Errors inside event handlers (handle those with try/catch in-place)
//   • Errors in async code resolved AFTER render (those go to the bridge's
//     save-error path, or to the surrounding try/catch if the caller wrote one)
//   • Errors in server-side rendering
//   • Errors thrown in the boundary itself
//
// Logging policy:
//   We log error.message and the React component stack to the console.
//   These are render-error strings (e.g. "Cannot read properties of
//   undefined") and DOM-tree paths — they do NOT contain plaintext task
//   data, so this is safe under the Zero-Knowledge contract.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Icon } from './Icon';

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] caught:', error.message);
    console.error('[ErrorBoundary] component stack:', info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="w-12 h-12 rounded-full bg-rose-500/15 border border-rose-500/30 flex items-center justify-center mx-auto mb-5">
            <Icon name="alert-triangle" className="w-5 h-5 text-rose-300" />
          </div>
          <h1 className="text-zinc-100 text-xl mb-3 font-medium tracking-tight">
            Something went wrong
          </h1>
          <p className="text-sm text-zinc-400 leading-relaxed mb-7">
            The app ran into a problem and needs to reload. Your work is safe — nothing has been deleted or changed.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="h-10 px-5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium transition-colors active:scale-[0.98]"
          >
            Reload
          </button>
          <details className="mt-8 text-left">
            <summary className="text-[11px] text-zinc-600 cursor-pointer hover:text-zinc-400 select-none">
              Technical details
            </summary>
            <pre className="mt-2 text-[11px] text-zinc-500 bg-zinc-900 border border-zinc-800 rounded-lg p-3 overflow-auto whitespace-pre-wrap">
              {this.state.error.message}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
