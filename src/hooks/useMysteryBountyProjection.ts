/**
 * The mystery bounty ladder a pending event will draw, read live (Dan
 * 2026-10-21: "ALL MYSTERY BOUNTY TOURNAMENTS NEED TO HAVE THE 'MYSTERY
 * BOUNTY' AMOUNTS DISPLAYED IN THE REWARDS").
 *
 * Enabled only while the chests have not been sealed. It reads the bounty
 * pool, its split, the activation rule, the payout ladder and the entry count
 * from the tournament, and hands them to `projectMysteryBountyLadder`, which
 * runs the engine's own builders. The pool keeps growing until entry closes,
 * so the existing tournament event feed invalidates the projection.
 */

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import { resolvePayoutStructure } from '../lib/payoutStructure';
import { readTournamentStandings } from '../services/readTournamentStandings';
import { subscribeTournamentStandings } from '../services/tournamentStandingsUpdates';
import {
  projectMysteryBountyLadder,
  type MysteryBountyProjection,
} from '../lib/mysteryBountyProjection';

const COLUMNS =
  'bounty_pool, bounty_pool_paid, mystery_bounty_pool_percent, mystery_bounty_regular_pool_percent, ' +
  'mystery_bounty_top_percent, mystery_bounty_profile, mystery_bounty_activation, ' +
  'mystery_bounty_activation_value, payout_structure, variant, tournament_type, spin_multiplier';

export function useMysteryBountyProjection(
  tournamentId: string | null | undefined,
  enabled: boolean,
  unitCents: number
): MysteryBountyProjection | null {
  const [projection, setProjection] = useState<MysteryBountyProjection | null>(null);

  useEffect(() => {
    // A prior event's ladder is never the next event's loading placeholder.
    setProjection(null);
    if (!enabled || !tournamentId || !(unitCents > 0)) {
      setProjection(null);
      return;
    }
    let alive = true;
    let inFlight = false;
    let queued = false;
    const load = async () => {
      if (!alive) return;
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      try {
        const { data: row, error } = await supabase
          .from('tournaments')
          .select(COLUMNS)
          .eq('id', tournamentId)
          .maybeSingle();
        if (error) throw error;
        if (!alive) return;
        if (!row) {
          setProjection(null);
          return;
        }
        const t = row as unknown as Record<string, unknown>;
        // Every entry the event has taken: one row per player plus each of
        // that row's rebuys and re-entries (totalEntriesFromRows' rule).
        const { data: entries, error: entriesError } = await readTournamentStandings(
          tournamentId,
          'id, rebuys'
        );
        if (entriesError) throw entriesError;
        if (!alive) return;
        let totalEntries = 0;
        for (const e of (entries ?? []) as Array<{ rebuys?: unknown }>) {
          const extra = Math.floor(Number(e.rebuys) || 0);
          totalEntries += 1 + (extra > 0 ? extra : 0);
        }
        const places = resolvePayoutStructure(t as Parameters<typeof resolvePayoutStructure>[0]);
        setProjection(
          projectMysteryBountyLadder({
            bountyPool: t.bounty_pool as number | string | null,
            bountyPoolPaid: t.bounty_pool_paid as number | string | null,
            mysteryPercent: t.mystery_bounty_pool_percent as number | string | null,
            regularPercent: t.mystery_bounty_regular_pool_percent as number | string | null,
            topPercent: t.mystery_bounty_top_percent as number | string | null,
            profile: t.mystery_bounty_profile as string | null,
            activation: t.mystery_bounty_activation as string | null,
            activationValue: t.mystery_bounty_activation_value as number | string | null,
            paidPlaces: places ? places.length : 0,
            totalEntries,
            unitCents,
          })
        );
      } catch (err) {
        if (alive) reportError(err, 'useMysteryBountyProjection.load');
      } finally {
        inFlight = false;
        if (alive && queued) {
          queued = false;
          void load();
        }
      }
    };
    const unsubscribe = subscribeTournamentStandings(tournamentId, () => void load());
    void load();
    return () => {
      alive = false;
      queued = false;
      unsubscribe();
    };
  }, [tournamentId, enabled, unitCents]);

  return projection;
}

export default useMysteryBountyProjection;
