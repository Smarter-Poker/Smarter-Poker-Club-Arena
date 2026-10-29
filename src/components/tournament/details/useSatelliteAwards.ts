import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { reportError } from '../../../utils/errorReporter';
import {
  recordedSatelliteAwardKind,
  type SatelliteAwardKind,
  type SatellitePayoutEvidence,
} from './satelliteAwardEvidence';

export interface SatelliteAwardView {
  ready: boolean;
  failed: boolean;
  kindFor: (userId: string, amount: unknown) => SatelliteAwardKind;
}
interface AwardEvent {
  id?: string;
  status?: unknown;
  variant?: unknown;
  tournament_type?: unknown;
  satellite_target_id?: unknown;
  satellite_target?: unknown;
}

/** One page-owned read shared by every results tab. Direct tab mounts can read independently. */
export function useSatelliteAwards(
  tournament: AwardEvent | null | undefined,
  entries: readonly { prize?: unknown }[],
  provided?: SatelliteAwardView,
  viewerId?: string | null
): SatelliteAwardView {
  const id = tournament?.id ?? null;
  const scopeKey = JSON.stringify([id, viewerId ?? null]);
  const target = tournament?.satellite_target_id ?? tournament?.satellite_target;
  const enabled =
    String(tournament?.status).toUpperCase() === 'COMPLETED' &&
    (String(tournament?.variant).toLowerCase() === 'satellite' ||
      String(tournament?.tournament_type).toUpperCase() === 'SATELLITE' ||
      Boolean(target)) &&
    entries.some((e) => Number(e.prize) > 0);
  const [owned, setOwned] = useState<{
    id: string | null;
    scopeKey: string | null;
    rows: SatellitePayoutEvidence[];
    ready: boolean;
    failed: boolean;
  }>({ id: null, scopeKey: null, rows: [], ready: false, failed: false });
  useEffect(() => {
    if (provided !== undefined || !id || !enabled) return;
    let retired = false;
    setOwned({ id, scopeKey, rows: [], ready: false, failed: false });
    void (async () => {
      try {
        const rows: SatellitePayoutEvidence[] = [];
        let cursor: string | null = null;
        let complete = false;
        for (let page = 0; page < 100; page++) {
          if (retired) return;
          let query = supabase
            .from('tournament_payouts')
            .select('id,tournament_id,user_id,source,amount,recorded_by,metadata')
            .eq('tournament_id', id)
            .in('source', ['satellite_seat', 'satellite_ticket', 'satellite_remainder'])
            .order('id', { ascending: true })
            .limit(1000);
          if (cursor !== null) query = query.gt('id', cursor);
          const { data, error } = await query;
          if (retired) return;
          if (error) throw error;
          if (!Array.isArray(data)) throw new Error('Satellite award response is not an array');
          for (const row of data) {
            if (typeof row?.id !== 'string' || !row.id || (cursor !== null && row.id <= cursor))
              throw new Error('Satellite award cursor did not advance');
            cursor = row.id;
            rows.push(row as SatellitePayoutEvidence);
          }
          if (data.length < 1000) {
            complete = true;
            break;
          }
        }
        if (!complete) throw new Error('Satellite award read exceeded the complete-read limit');
        if (!retired) setOwned({ id, scopeKey, rows, ready: true, failed: false });
      } catch (error) {
        if (retired) return;
        reportError(error, 'TournamentDetails.satellite_award_types');
        setOwned({ id, scopeKey, rows: [], ready: true, failed: true });
      }
    })();
    return () => {
      retired = true;
    };
  }, [id, scopeKey, enabled, provided]);
  const byUser = useMemo(() => {
    const map = new Map<string, SatellitePayoutEvidence[]>();
    if (owned.scopeKey === scopeKey)
      for (const row of owned.rows) {
        const list = map.get(row.user_id) ?? [];
        list.push(row);
        map.set(row.user_id, list);
      }
    return map;
  }, [scopeKey, owned]);
  const kindFor = useCallback(
    (userId: string, amount: unknown) =>
      recordedSatelliteAwardKind(byUser.get(userId) ?? [], id ?? '', target, userId, amount),
    [byUser, id, target]
  );
  const view = useMemo(
    () => ({
      ready: owned.scopeKey === scopeKey && owned.ready,
      failed: owned.scopeKey === scopeKey && owned.failed,
      kindFor,
    }),
    [scopeKey, owned, kindFor]
  );
  return provided ?? view;
}

export function satelliteAwardLabel(kind: SatelliteAwardKind, value: string): string {
  return kind === 'ticket'
    ? `1 Ticket (${value})`
    : kind === 'cash'
      ? `Cash ${value}`
      : `Value ${value}`;
}

export function satelliteAwardNotice(
  view: SatelliteAwardView,
  entries: readonly { user_id: string; prize?: unknown }[]
): string | null {
  if (!view.ready) return 'Reading Recorded Award Types';
  if (
    view.failed ||
    entries.some((e) => Number(e.prize) > 0 && view.kindFor(e.user_id, e.prize) === 'unknown')
  )
    return 'Ticket Or Cash Details Are Unavailable In This View. Recorded Values Are Shown.';
  return null;
}

export function satelliteAwardTotalLabel(
  kind: SatelliteAwardKind,
  prize: number,
  bounty: number,
  amount: (n: number) => string
): string {
  if (prize <= 0) return `Cash ${amount(bounty)}`;
  if (kind === 'ticket')
    return (
      satelliteAwardLabel(kind, amount(prize)) + (bounty > 0 ? ` + Cash ${amount(bounty)}` : '')
    );
  return satelliteAwardLabel(kind, amount(prize + bounty));
}
