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

import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
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
  requestSnapshot: () => void;
  snapshot: EngineSnapshot | null;
  seq: number;
  status: EngineConnectionStatus;
  lastError: { code?: number; reason?: string } | null;
  /** Last transient EVENT payload from the engine (insurance, RIT, timebank, BBJ, etc). */
  lastEvent: Record<string, unknown> | null;
  /**
   * 2026-09-04: last PRIVATE frame for this player (hole cards, the engine's
   * copy of the armed pre-action). A fresh object per frame, so an effect
   * keyed on it runs once per delivery.
   */
  lastUserEvent: Record<string, unknown> | null;
}

export function useEngineTableState(
  tableId: string | null | undefined,
  opts?: {
    enabled?: boolean;
    /**
     * When the engine is expected back from a scheduled restart, as an epoch
     * ms instant, or null when no break is running (Realtime Phase 4 audit,
     * 2026-09-05).
     *
     * WHY THE HOOK NEEDS THIS AT ALL. The engine announces its break on a
     * socket frame, and the transport reads it - but a frame only reaches the
     * sockets that were subscribed when it was sent. A player who sits down at
     * :54, one minute after the announcement and one minute before the engine
     * goes away, receives nothing and their ladder escalates through the
     * restart exactly as it did before Phase 4. That happens every hour.
     *
     * The break is a row in the database and `useMaintenanceBreak` already
     * reads it on mount. This is the wire from that reading into the ladder.
     */
    scheduledRestartUntil?: number | null;
  }
): UseEngineTableStateResult {
  const enabled = opts?.enabled ?? true;
  const scheduledRestartUntil = opts?.scheduledRestartUntil ?? null;
  const [snapshot, setSnapshot] = useState<EngineSnapshot | null>(null);
  const [seq, setSeq] = useState<number>(0);
  const [status, setStatus] = useState<EngineConnectionStatus>('idle');
  const [lastError, setLastError] = useState<{ code?: number; reason?: string } | null>(null);
  const [lastEvent, setLastEvent] = useState<Record<string, unknown> | null>(null);
  const [lastUserEvent, setLastUserEvent] = useState<Record<string, unknown> | null>(null);

  // Keep the client in a ref so effect cleanup can close it without re-render.
  const clientRef = useRef<EngineStateClient | null>(null);
  /* Read inside the connect effect without joining its dependency list: a
     break that starts while a table is open must not tear the socket down and
     rebuild it. The effect below pushes every later value in. */
  const scheduledRestartUntilRef = useRef<number | null>(scheduledRestartUntil);
  scheduledRestartUntilRef.current = scheduledRestartUntil;

  useEffect(() => {
    clientRef.current?.noteScheduledRestart(scheduledRestartUntil);
  }, [scheduledRestartUntil]);

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
      // A timer boundary does not guarantee a React commit. Discrete events
      // must reach consumers before a later event replaces their state slot.
      onEvent: (payload) => {
        if (clientRef.current !== client) return;
        flushSync(() => setLastEvent(payload));
      },
      onUserEvent: (payload) => {
        if (clientRef.current !== client) return;
        flushSync(() => setLastUserEvent(payload));
      },
    });

    clientRef.current = client;
    // Seed the window BEFORE connecting: a client mounting during a break must
    // not spend its first three retries escalating before the effect below
    // gets a turn.
    client.noteScheduledRestart(scheduledRestartUntilRef.current);
    void client.connect();

    return () => {
      client.disconnect();
      clientRef.current = null;
      setSnapshot(null);
      setSeq(0);
      setStatus('idle');
      setLastError(null);
      setLastEvent(null);
      setLastUserEvent(null);
    };
  }, [tableId, enabled]);

  const requestSnapshot = useCallback(() => clientRef.current?.requestSnapshot(), []);
  return { snapshot, seq, status, lastError, lastEvent, lastUserEvent, requestSnapshot };
}

export default useEngineTableState;
