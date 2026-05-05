// ─── useCryptoBridge ───────────────────────────────────────────────────────────
// React adapters around the CryptoBridge interface:
//   • <BridgeProvider>     — supplies a single bridge instance via context
//   • useBridge()          — direct access to the bridge for imperative calls
//   • useBridgeQuery()     — declarative read with re-fetch on change broadcast
//
// The bridge itself is pure TS with no React dependency, which keeps it
// testable with plain unit tests and reusable from non-React surfaces.

import {
  createContext, createElement, useCallback, useContext, useEffect,
  useRef, useState, type ReactNode,
} from 'react';
import type { BridgeChannel, BridgeRequest, CryptoBridge } from '../lib/cryptoBridge';

const BridgeCtx = createContext<CryptoBridge | null>(null);

export interface BridgeProviderProps {
  bridge: CryptoBridge;
  children: ReactNode;
}

export function BridgeProvider({ bridge, children }: BridgeProviderProps) {
  return createElement(BridgeCtx.Provider, { value: bridge }, children);
}

export function useBridge(): CryptoBridge {
  const b = useContext(BridgeCtx);
  if (!b) {
    throw new Error('useBridge() called outside <BridgeProvider>. ' +
                    'Mount the provider at the App root before any consumer.');
  }
  return b;
}

// ─── useBridgeQuery ────────────────────────────────────────────────────────────
// Declarative wrapper: feed it a request factory + a channel to watch, get
// back { data, error, loading } with automatic re-fetch on broadcast.
//
// Notes:
//   • The request factory MUST be stable across renders (wrap in useCallback
//     in the caller). We re-fetch when (a) the channel publishes, (b) the
//     factory's identity changes.
//   • Initial state is `data: null`. Components must render an empty state
//     until the first resolution lands — never assume data is present.

export interface QueryState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refetch: () => void;
}

export function useBridgeQuery<R extends BridgeRequest, T>(
  channel: BridgeChannel,
  build: () => R,
): QueryState<T> {
  const bridge = useBridge();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  // Track the latest in-flight request so stale resolutions are dropped.
  const tokenRef = useRef(0);

  const fetchOnce = useCallback(() => {
    const token = ++tokenRef.current;
    setLoading(true);
    bridge.request(build())
      .then((res) => {
        if (token !== tokenRef.current) return;
        setData(res as unknown as T);
        setError(null);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (token !== tokenRef.current) return;
        setError(err);
        setLoading(false);
      });
  }, [bridge, build]);

  useEffect(() => {
    fetchOnce();
    return bridge.subscribe(channel, fetchOnce);
  }, [bridge, channel, fetchOnce]);

  return { data, error, loading, refetch: fetchOnce };
}
