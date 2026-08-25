import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUserStore } from '../stores/useUserStore';
import { tournamentService } from '../services/TournamentService';
import { supabase } from '../lib/supabase';
import { fmtChips } from '../utils/format';
import confirmDialog from '../components/common/confirmDialog';
import { useToast } from '../components/common/Toast';
import { reportError } from '../utils/errorReporter';

/**
 * How hard we look for the seat the server was meant to give us.
 *
 * Sized against the engine's 5-second elimination/seating sweep: 3 retries at
 * 1.2s covers a seat that had to wait for a new table to spawn, without
 * holding the button spinner long enough to feel broken.
 */
const SEAT_LOOKUP_RETRIES = 3;
const SEAT_LOOKUP_RETRY_MS = 1200;

export interface RegisterTournamentParams {
  id: string;
  name: string;
  buy_in_amount: number;
  buy_in_fee?: number;
}

export function useTournamentRegistration() {
  const [isRegistering, setIsRegistering] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();
  const currentUserId = useUserStore((s: any) => s.user?.id);
  const username = useUserStore((s: any) => s.user?.username) || 'Player';

  const register = useCallback(
    async (t: RegisterTournamentParams, onSuccess?: () => void) => {
      if (!currentUserId) {
        toast.error('Sign In To Register');
        return;
      }
      if (isRegistering) return;

      const totalCost = t.buy_in_amount + (t.buy_in_fee || 0);
      const confirmed = await confirmDialog({
        title: 'Confirm Buy In',
        message: `Register for ${t.name}? This will debit ${fmtChips(totalCost)} from your wallet.`,
        confirmText: 'Confirm Buy In',
      });
      if (!confirmed) return;

      setIsRegistering(true);
      try {
        const registration = await tournamentService.registerPlayer(t.id, currentUserId, username);
        toast.success(`You Are Registered For ${t.name}`);

        if (onSuccess) {
          onSuccess();
        }

        /**
         * ═══════════════════════════════════════════════════════════════════
         *  A PAID ENTRANT GOES TO HIS OWN SEAT OR NOWHERE (2026-08-23)
         * ═══════════════════════════════════════════════════════════════════
         *
         * Dan, after late-registering: "IT TOOK ME TO THE PAGE, BUT DIDN'T SIT
         * ME, GIVE ME CHIPS OR ANYTHING."
         *
         * This block is why. The seat lookup was right; the FALLBACK was the
         * bug. `table_id` was always null for a late registration, because
         * fn_register_for_tournament only ever wrote a 'registered' row and
         * left seating to a start() that had already happened. So every late
         * entrant fell into the else-branch, which picked an arbitrary table
         * of the tournament and navigated there — as a SPECTATOR, under a
         * footer reading "Spectating, Tap An Open Seat To Join", at a table
         * where every seat is deliberately non-interactive.
         *
         * The server now seats a late entrant inside the registration
         * transaction (fn_seat_late_registrant), so the first read normally
         * finds the seat. The retry covers the one honest miss: every table
         * was full at that instant, so the engine must spawn one and seat them
         * on its next sweep.
         *
         * If there is still no seat we send them to THEIR TOURNAMENT, never to
         * a stranger's felt. Landing on the right page beats being stranded on
         * the wrong one.
         *
         * ───────────────────────────────────────────────────────────────────
         *  DEFECT D6a — A LOOKUP THAT FOUND NOTHING REPORTED SUCCESS
         * ───────────────────────────────────────────────────────────────────
         *
         * The old fallback fired `toast.success('You Are Registered - Your
         * Seat Is Being Assigned')` for EVERY path that did not produce a
         * table id, and the lookup below dropped its `{ error }` on the floor.
         * So a PostgREST failure, an RLS denial and a genuinely-pending seat
         * all rendered as the same green tick. A player told "your seat is
         * being assigned" by a query that never completed has been told
         * something nobody checked.
         *
         * The seat lookup now reports WHICH of three things it learned:
         *
         *   'seated'   the roster row carries a table id. Verified. Go there.
         *   'pending'  the roster row EXISTS and its table_id is null. This is
         *              a real state the engine resolves: before start, seating
         *              happens in start(); during a running event,
         *              fn_seat_late_registrant ran but every table was full,
         *              so the next seating sweep places him.
         *   'unknown'  the query errored, or returned no roster row at all.
         *              Nothing about the seat was confirmed, so nothing about
         *              the seat is claimed.
         *
         * Only 'pending' may say the seat is coming, and it says it as
         * information rather than as a success. 'unknown' says plainly that we
         * could not confirm it. The registration itself is still reported as
         * succeeded above, because that one WAS verified:
         * `registerPlayer` throws unless the server RPC returned ok and the
         * created roster row was read back.
         */
        type SeatLookup =
          | { state: 'seated'; tableId: string }
          | { state: 'pending' }
          | { state: 'unknown' };

        const findMySeat = async (): Promise<SeatLookup> => {
          const { data: tp, error } = await supabase
            .from('tournament_players')
            .select('table_id')
            .eq('tournament_id', t.id)
            .eq('user_id', currentUserId)
            .maybeSingle();
          if (error) {
            reportError(error, 'useTournamentRegistration.findMySeat', { tournamentId: t.id });
            return { state: 'unknown' };
          }
          if (!tp) return { state: 'unknown' };
          const tableId = (tp.table_id as string | undefined) || null;
          return tableId ? { state: 'seated', tableId } : { state: 'pending' };
        };

        // The registration read-back is itself an authoritative roster read, so
        // start from it rather than paying for a round trip that asks the same
        // question a millisecond later.
        let lookup: SeatLookup = registration?.table_id
          ? { state: 'seated', tableId: registration.table_id }
          : await findMySeat();

        for (
          let attempt = 0;
          lookup.state !== 'seated' && attempt < SEAT_LOOKUP_RETRIES;
          attempt++
        ) {
          await new Promise((r) => setTimeout(r, SEAT_LOOKUP_RETRY_MS));
          lookup = await findMySeat();
        }

        if (lookup.state === 'seated') {
          const seatTableId = lookup.tableId;
          navigate(`/table/${seatTableId}`);
        } else if (lookup.state === 'pending') {
          toast.info('You Are Registered. Your Seat Is Being Assigned.');
          navigate(`/tournaments/${t.id}`);
        } else {
          toast.warning('You Are Registered. We Could Not Confirm Your Seat Yet.');
          navigate(`/tournaments/${t.id}`);
        }
      } catch (e) {
        reportError(e, 'useTournamentRegistration.register', { tournamentId: t.id });
        toast.error(e instanceof Error ? e.message : 'Registration Failed, Please Try Again');
      } finally {
        setIsRegistering(false);
      }
    },
    [currentUserId, username, isRegistering, navigate, toast]
  );

  return { register, isRegistering };
}
