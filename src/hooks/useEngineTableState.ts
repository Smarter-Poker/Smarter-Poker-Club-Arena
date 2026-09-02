/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * useEngineTableState — React binding for EngineStateClient
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Opens a WebSocket to the Hetzner game engine for the given tableId and
 * exposes the authoritative snapshot + seq + connection status as React
 * state. Cleans up on unmount. Re-opens when tableId changes.
 *
 * Protocol contract: see /docs/phase-1.1-server-authoritative-state.md §4.
 */

import { useEffect, useRef, useState } from 'react';
import { getFreshAccessToken } from '../lib/authToken';
import EngineStateClient, {
  type EngineConnectionStatus,
  type EngineSnapshot,
} from '../services/EngineStateClient';

// The engine URL. In production we always point at engine.smarter.poker;
// Vite's import.meta.env lets deploys override for staging.
const GAME_SERVER_URL =
  (import.meta as unknown as { env: Record<string, string | undefined> }).env
    ?.VITE_GAME_SERVER_URL ||
  ((import.meta as unknown as { env: Record<string, string | undefined> }).env?.PROD
    ? 'https://engine.smarter.poker'
    : 'http://localhost:8080');

export interface UseEngineTableStateResult {
  snapshot: EngineSnapshot | null;
  seq: number;
  status: EngineConnectionStatus;
  lastError: { code?: number; reason?: string } | null;
  /** Last transient EVENT payload from the engine (insurance, RIT, timebank, BBJ, etc). */
  lastEvent: Record<string, unknown> | null;
}

export function useEngineTableState(
  tableId: string | null | undefined,
  opts?: { enabled?: boolean }
): UseEngineTableStateResult {
  const enabled = opts?.enabled ?? true;
  const [snapshot, setSnapshot] = useState<EngineSnapshot | null>(null);
  const [seq, setSeq] = useState<number>(0);
  const [status, setStatus] = useState<EngineConnectionStatus>('idle');
  const [lastError, setLastError] = useState<{ code?: number; reason?: string } | null>(null);
  const [lastEvent, setLastEvent] = useState<Record<string, unknown> | null>(null);

  // Keep the client in a ref so effect cleanup can close it without re-render.
  const clientRef = useRef<EngineStateClient | null>(null);

  useEffect(() => {
    if (!tableId || !enabled) return;

    const client = new EngineStateClient({
      baseUrl: GAME_SERVER_URL,
      tableId,
      // 2026-08-24: synchronous in-memory token cache (src/lib/authToken.ts).
      // The join-table path no longer awaits auth-js — the cached JWT resolves
      // in the same microtask; getSession() runs only when a refresh is due.
      getToken: getFreshAccessToken,
      onSnapshot: (snap, s) => {
        setSnapshot(snap);
        setSeq(s);
      },
      onStatus: (s) => setStatus(s),
      onError: (e) => setLastError(e),
      onEvent: (payload) => setLastEvent(payload),
    });

    clientRef.current = client;
    void client.connect();

    return () => {
      client.disconnect();
      clientRef.current = null;
      setSnapshot(null);
      setSeq(0);
      setStatus('idle');
      setLastError(null);
      setLastEvent(null);
    };
  }, [tableId, enabled]);

  return { snapshot, seq, status, lastError, lastEvent };
}

export default useEngineTableState;
