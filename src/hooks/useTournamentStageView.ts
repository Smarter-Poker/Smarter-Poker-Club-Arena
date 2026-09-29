/**
 * The multi-day stage view for one event, read only when the multi-day
 * capability is available. Every multi-day surface uses this pair of gates:
 * the capability says the platform runs multi-day events at all, and the view
 * says THIS event has a sealed plan. Either one missing, nothing is shown.
 *
 * `refreshKey` re-reads the view when something the caller already watches
 * changes (the tournament status moving RUNNING -> BAGGED -> RUNNING); there is
 * no polling here.
 */
import { useCallback, useEffect, useState } from 'react';
import { usePlatformCapability } from './usePlatformCapability';
import { MULTI_DAY_CAPABILITY } from '../utils/multiDaySchedule';
import {
  readTournamentStageView,
  type TournamentStageView,
} from '../services/TournamentStageService';

export interface StageViewState {
  /** Present only when the capability is available and the event has a plan. */
  view: TournamentStageView | null;
  loading: boolean;
  reload: () => void;
}

export function useTournamentStageView(
  tournamentId: string | null | undefined,
  refreshKey: unknown = null
): StageViewState {
  const gate = usePlatformCapability(MULTI_DAY_CAPABILITY);
  const [view, setView] = useState<TournamentStageView | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (gate !== 'available' || !tournamentId) {
      setView(null);
      setLoading(gate === 'loading');
      return;
    }
    let live = true;
    setLoading(true);
    void readTournamentStageView(tournamentId).then((read) => {
      if (!live) return;
      setView(read.status === 'ok' && read.view.plan ? read.view : null);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [gate, tournamentId, refreshKey, nonce]);

  return { view, loading, reload };
}

/**
 * The same two gates for a handful of events at once (the lobby's bagged
 * cards). Only the ids given are read; a lobby passes just its BAGGED rows.
 */
export function useTournamentStageViews(
  ids: readonly string[]
): Record<string, TournamentStageView> {
  const gate = usePlatformCapability(MULTI_DAY_CAPABILITY);
  const [views, setViews] = useState<Record<string, TournamentStageView>>({});
  const key = [...ids].sort().join(',');

  useEffect(() => {
    if (gate !== 'available' || key === '') {
      setViews({});
      return;
    }
    let live = true;
    void Promise.all(key.split(',').map((id) => readTournamentStageView(id))).then((reads) => {
      if (!live) return;
      const next: Record<string, TournamentStageView> = {};
      for (const read of reads) {
        if (read.status === 'ok' && read.view.plan) next[read.view.tournamentId] = read.view;
      }
      setViews(next);
    });
    return () => {
      live = false;
    };
  }, [gate, key]);

  return views;
}
