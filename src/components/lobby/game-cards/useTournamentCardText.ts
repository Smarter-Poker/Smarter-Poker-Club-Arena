import { useEffect, useState } from 'react';
import { reportError } from '../../../utils/errorReporter';
import { titleCase } from '../../../utils/titleCase';
import { isRecordedSatelliteTournament } from '../../../utils/tournamentFilters';
import { mttPhaseText, type LobbyTournamentRow } from '../lobbyEntries';
import { useSharedSecondTick } from '../useSharedSecondTick';
import type { ArenaGameCardData } from './arenaGameCardTypes';

// Deduplicate concurrent cards for the same destination, without retaining a
// stale name across later lobby visits. Rejections remain visible and retryable.
const pendingTargets = new Map<string, Promise<string | null>>();
function targetName(id: string): Promise<string | null> {
  const pending = pendingTargets.get(id);
  if (pending) return pending;
  const request = (async () => {
    // Cash and ordinary tournament cards are render-only. Initialize the
    // database client only when a satellite actually needs its target name.
    const { supabase } = await import('../../../lib/supabase');
    const { data, error } = await supabase
      .from('tournaments')
      .select('name')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data?.name ? titleCase(data.name) : null;
  })();
  pendingTargets.set(id, request);
  void request.then(
    () => pendingTargets.delete(id),
    () => pendingTargets.delete(id)
  );
  return request;
}

export function useTournamentCardText(data: ArenaGameCardData) {
  const source = data.source?.kind === 'mtt' ? data.source : undefined;
  const now = useSharedSecondTick(
    Boolean(source && !['closed', 'completed'].includes(source.status))
  );
  const row =
    data.source?.kind !== 'cash' ? (data.source?.raw as LobbyTournamentRow | undefined) : undefined;
  const target = row?.satellite_target_id || row?.satellite_target || '';
  const resolvedDestination = useSatelliteDestination(target);
  const destination =
    resolvedDestination ||
    (row && isRecordedSatelliteTournament({ ...row })
      ? 'Satellite Destination Unavailable'
      : undefined);
  const phase = source ? mttPhaseText(source, now) : data.startsIn;
  return { phase: phase || data.statusLabel, destination };
}

export function useSatelliteDestination(target: string | null | undefined) {
  const [resolved, setResolved] = useState<{ id: string; name: string | null } | null>(null);
  useEffect(() => {
    if (!target) return;
    let active = true;
    void targetName(target).then(
      (name) => {
        if (active) setResolved({ id: target, name });
      },
      (error) => {
        reportError(error, 'TournamentCard.satelliteDestination');
        if (active) setResolved({ id: target, name: null });
      }
    );
    return () => {
      active = false;
    };
  }, [target]);
  return !target
    ? undefined
    : resolved?.id === target
      ? resolved.name
        ? `Wins A Seat Into ${resolved.name}`
        : 'Satellite Destination Unavailable'
      : 'Loading Satellite Destination...';
}
