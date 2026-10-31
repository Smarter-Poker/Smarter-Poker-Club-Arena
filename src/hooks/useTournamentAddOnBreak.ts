import { tournamentAddOnEntryBoundaryPassed } from '../utils/tournamentAddOnBoundary';
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { subscribeTournamentStandings } from '../services/tournamentStandingsUpdates';
import { reportError } from '../utils/errorReporter';
import { serverNow } from '../utils/serverClock';

export interface TournamentAddOnBreak {
  endsAtMs: number;
  cost: number;
  chips: number;
}

/** The public pause notice is independent of the viewer's purchase entitlement.
 * Free Buy's early offer is not a break: its owner replaces that window only
 * after every dealer parks. Read that durable closing minute, never infer it
 * from the early entitlement's approaching deadline.
 */
export function useTournamentAddOnBreak(tournamentId: string | null | undefined) {
  const [shown, setShown] = useState<(TournamentAddOnBreak & { tournamentId: string }) | null>(
    null
  );
  useEffect(() => {
    setShown(null);
    if (!tournamentId) return;
    let active = true;
    let reading = false;
    let pending = false;
    let boundary: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (!active) return;
      if (reading) {
        pending = true;
        return;
      }
      reading = true;
      pending = false;
      try {
        const { data: row, error } = await supabase
          .from('tournaments')
          .select(
            'current_level, late_reg_levels, rebuy_levels, late_reg_mins, started_at, status, add_on_available, addon_from_start, addon_period_triggered, addon_period_started_at, addon_period_ends_at, prize_pool_finalized, addon_cost, addon_chips, buy_in_amount, starting_chips'
          )
          .eq('id', tournamentId)
          .maybeSingle();
        if (!active || pending) return;
        if (boundary) clearTimeout(boundary);
        boundary = undefined;
        if (error) throw error;
        const start = Date.parse(String(row?.addon_period_started_at ?? ''));
        const end = Date.parse(String(row?.addon_period_ends_at ?? ''));
        const cost = Number(row?.addon_cost || row?.buy_in_amount);
        const chips = Number(row?.addon_chips || row?.starting_chips);
        const eligible =
          row?.status === 'RUNNING' &&
          tournamentAddOnEntryBoundaryPassed(row, serverNow()) &&
          row.add_on_available === true &&
          row.addon_period_triggered === true &&
          row.prize_pool_finalized !== true &&
          Number.isFinite(start) &&
          Number.isFinite(end) &&
          end > start &&
          Number.isFinite(cost) &&
          cost > 0 &&
          Number.isFinite(chips) &&
          chips > 0 &&
          !(row.addon_from_start === true && end - start > 60_000);
        const paint = () => {
          if (!active) return;
          const now = serverNow();
          if (!eligible || now >= end) {
            setShown(null);
            return;
          }
          const noticeStarts = Math.max(start, end - 60_000);
          if (now < noticeStarts) {
            setShown(null);
            boundary = setTimeout(paint, noticeStarts - now);
            return;
          }
          setShown({ tournamentId, endsAtMs: end, cost, chips });
          boundary = setTimeout(paint, end - now);
        };
        paint();
      } catch (error) {
        if (active && !pending) {
          if (boundary) clearTimeout(boundary);
          boundary = undefined;
          setShown(null);
          reportError(error, 'useTournamentAddOnBreak.load', { tournamentId });
        }
      } finally {
        reading = false;
        if (active && pending) void load();
      }
    };
    const stop = subscribeTournamentStandings(tournamentId, () => void load());
    void load();
    return () => {
      active = false;
      stop();
      if (boundary) clearTimeout(boundary);
    };
  }, [tournamentId]);
  return shown?.tournamentId === tournamentId ? shown : null;
}
