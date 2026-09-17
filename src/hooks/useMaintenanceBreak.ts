/** Maintenance presentation follows the engine's release, never clock expiry. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { serverNow } from '../utils/serverClock';
import { getServerStatus, type MaintenancePresentation } from '../services/GameServerAPI';
import { engineChannelClient } from '../services/EngineStateClient';
import { realtimeChannelService } from '../services/RealtimeChannelService';

export interface MaintenanceBreakState {
  active: boolean;
  phase: MaintenancePresentation['phase'];
  breakEndsAtMs: number | null;
  reason: string;
}
const IDLE: MaintenanceBreakState = {
  active: false,
  phase: 'idle',
  breakEndsAtMs: null,
  reason: '',
};
const MAINTENANCE_WINDOW_MS = 7 * 60 * 1000;
type ReadResult = { data: Record<string, unknown>; authoritative: boolean } | null;
let inFlight: Promise<ReadResult> | null = null;

/** Coalesce simultaneous mounts; never cache a release decision across events. */
async function fetchBreakState(): Promise<ReadResult> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const health = await getServerStatus();
    if (health?.maintenance?.presentation) {
      return { data: { ...health.maintenance.presentation }, authoritative: true };
    }
    try {
      const { data, error } = await supabase.rpc('fn_maintenance_break_state');
      if (error) return null;
      const row = Array.isArray(data) ? data[0] : data;
      // Absence during an outage cannot certify the release of a known break.
      return row
        ? {
            data: {
              ...row,
              active: true,
              break_ends_at:
                row.break_ends_at ??
                (typeof row.remaining_ms === 'number'
                  ? serverNow() + Number(row.remaining_ms ?? 0)
                  : null),
            },
            authoritative: false,
          }
        : null;
    } catch {
      return null;
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
function instant(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function useMaintenanceBreak(tableId?: string) {
  const [state, setState] = useState<MaintenanceBreakState>(IDLE);
  const stateRef = useRef(state);
  const revision = useRef(0);
  const closedBreakId = useRef(0);
  const lastEvent = useRef({ breakId: 0, timestamp: 0 });
  const apply = useCallback((data: Record<string, unknown>, authoritative: boolean) => {
    const breakId = instant(data.break_id ?? data.announced_at) ?? 0;
    const timestamp = instant(data.timestamp) ?? 0;
    const previous = lastEvent.current;
    if (breakId && previous.breakId && breakId < previous.breakId) return;
    if (timestamp && previous.timestamp && timestamp < previous.timestamp) return;
    if (!authoritative && stateRef.current.active) return;
    const active = data.active !== false && data.phase !== 'idle';
    if (active && breakId && breakId <= closedBreakId.current) return;
    if (authoritative && !active && breakId)
      closedBreakId.current = Math.max(closedBreakId.current, breakId);
    if (authoritative) lastEvent.current = { breakId, timestamp };
    const phase = ['last_hand', 'counting_down', 'finalizing', 'resuming'].includes(
      String(data.phase)
    )
      ? (data.phase as MaintenanceBreakState['phase'])
      : 'counting_down';
    const endsAt =
      instant(data.break_ends_at ?? data.breakEndsAt ?? data.resume_expected_at) ??
      (phase === 'last_hand' ? (timestamp || serverNow()) + MAINTENANCE_WINDOW_MS : null);
    const next: MaintenanceBreakState = active
      ? {
          active: true,
          phase:
            ['last_hand', 'counting_down'].includes(phase) && (!endsAt || endsAt <= serverNow())
              ? 'finalizing'
              : phase,
          breakEndsAtMs: endsAt,
          reason:
            typeof data.reason === 'string' && data.reason
              ? data.reason
              : 'Scheduled Engine Maintenance',
        }
      : IDLE;
    stateRef.current = next;
    setState(next);
  }, []);

  const ingestEvent = useCallback(
    (type: string, data: Record<string, unknown>) => {
      if (type !== 'MAINTENANCE_BREAK' && type !== 'MAINTENANCE_BREAK_ENDED') return;
      revision.current++;
      apply(
        type === 'MAINTENANCE_BREAK_ENDED' ? { ...data, active: false, phase: 'idle' } : data,
        true
      );
    },
    [apply]
  );

  // Kept under its existing name for the 4404 caller; health is now primary.
  const refreshFromDb = useCallback(async () => {
    const started = ++revision.current;
    const fetched = await fetchBreakState();
    if (started !== revision.current || !fetched) return;
    apply(fetched.data, fetched.authoritative);
  }, [apply]);

  useEffect(() => {
    void refreshFromDb();
    const refresh = () => {
      void refreshFromDb();
    };
    const visible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', visible);
    const offStatus = engineChannelClient.onStatusChange((status) => {
      if (status === 'connected') refresh();
    });
    const offLobby = realtimeChannelService.subscribeToLobby({
      onMaintenance: (payload) => {
        if (!payload || typeof payload !== 'object') return;
        const data = payload as Record<string, unknown>;
        // Table sockets own each table's resume. Global completion is safe
        // for every table; a fleet wave must not reopen an already ended one.
        if (tableId && data.phase === 'resuming') return;
        ingestEvent(data.active === false ? 'MAINTENANCE_BREAK_ENDED' : 'MAINTENANCE_BREAK', data);
      },
    });
    return () => {
      revision.current++;
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', visible);
      offStatus();
      offLobby();
    };
  }, [refreshFromDb, ingestEvent, tableId]);

  useEffect(() => {
    if (
      !state.active ||
      !state.breakEndsAtMs ||
      !['last_hand', 'counting_down'].includes(state.phase)
    )
      return;
    // One read at the displayed deadline. The clock only changes the copy;
    // release still requires an engine event or a dealer-ready health read.
    const timer = setTimeout(
      () => {
        const next = { ...stateRef.current, phase: 'finalizing' as const, breakEndsAtMs: null };
        stateRef.current = next;
        setState(next);
        void refreshFromDb();
      },
      Math.max(0, state.breakEndsAtMs - serverNow())
    );
    return () => clearTimeout(timer);
  }, [state.active, state.phase, state.breakEndsAtMs, refreshFromDb]);

  return { maintenanceBreak: state, ingestMaintenanceEvent: ingestEvent, refreshFromDb };
}
export default useMaintenanceBreak;
