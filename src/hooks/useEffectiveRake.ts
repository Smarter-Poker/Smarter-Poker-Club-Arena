/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE RAKE THIS TABLE ACTUALLY TAKES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The Game Rules modal must show the number the engine really uses. Once a table
 * or a club can override the published schedule, reading the schedule alone puts
 * a wrong number on screen for exactly the tables whose owner bothered to change
 * it — which is the bug the 2026-08-15 display fix existed to kill.
 *
 * 2026-08-19. This lived inline in TablePage.tsx and was lost when that file was
 * rewritten: the page went back to a plain schedule lookup and stopped selecting
 * the override columns at all. TablePage is a 372 KB file that changes many
 * times a day, so the logic now lives here and is consumed by TableModalsLayer,
 * which already has the tableId. Nothing in TablePage has to be right for the
 * modal to be right.
 *
 * PRECEDENCE — must stay identical to the server, or the screen and the money
 * disagree. See server/src/engine/ServerTableEngineBase.getRakeOverride:
 *
 *     table override  ->  club default  ->  published schedule
 *
 * Note the club's columns are `default_rake_percent` and `rake_cap` (the latter
 * is in BIG BLINDS despite the name). `clubs.rake_percent` / `clubs.rake_cap_bb`
 * are a legacy duplicate pair that the engine does NOT read — reading them here
 * would show a number that is never taken.
 */
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { getRakeConfig } from '../config/RakeConfig';
import { parseBlinds, resolveRakeOverride } from '../lib/rakeOverride';
import { reportError } from '../utils/errorReporter';

export interface EffectiveRake {
  /** undefined while unknown — the modal renders a dash rather than a guess. */
  rakePercent: number | undefined;
  rakeCap: number | undefined;
}

const UNKNOWN: EffectiveRake = { rakePercent: undefined, rakeCap: undefined };

export { parseBlinds, resolveRakeOverride };

/**
 * The rake actually in force at `tableId`.
 *
 * `enabled` exists so the two reads only happen when someone opens the modal —
 * this hook sits in a component that is mounted for the whole session.
 *
 * Never throws and never guesses: any failure leaves both values undefined and
 * the modal shows a dash.
 */
export function useEffectiveRake(
  tableId: string | undefined,
  blinds: string | undefined,
  gameType: string | undefined,
  enabled = true
): EffectiveRake {
  const [rake, setRake] = useState<EffectiveRake>(UNKNOWN);

  useEffect(() => {
    if (!enabled || !tableId) {
      setRake(UNKNOWN);
      return;
    }
    const parsed = parseBlinds(blinds);
    if (!parsed) {
      setRake(UNKNOWN);
      return;
    }

    let alive = true;
    (async () => {
      try {
        const { data: tableRow, error: tErr } = await supabase
          .from('tables')
          .select('rake_percent, rake_cap_bb, club_id')
          .eq('id', tableId)
          .maybeSingle();
        if (tErr) throw tErr;

        let clubRow: { default_rake_percent?: number | null; rake_cap?: number | null } | null =
          null;
        if (tableRow?.club_id) {
          const { data } = await supabase
            .from('clubs')
            .select('default_rake_percent, rake_cap')
            .eq('id', tableRow.club_id)
            .maybeSingle();
          clubRow = data ?? null;
        }
        if (!alive) return;

        const cfg = getRakeConfig(
          parsed.bb,
          gameType || 'nlh',
          parsed.sb,
          resolveRakeOverride(tableRow ?? null, clubRow)
        );
        setRake({ rakePercent: cfg.rakePercent, rakeCap: cfg.rakeCap });
      } catch (e) {
        if (!alive) return;
        reportError(e, 'useEffectiveRake.failed');
        setRake(UNKNOWN);
      }
    })();

    return () => {
      alive = false;
    };
  }, [tableId, blinds, gameType, enabled]);

  return rake;
}
