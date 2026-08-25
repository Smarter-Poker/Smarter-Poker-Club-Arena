import { useState, useCallback, useEffect, useRef } from 'react';
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
  /** Flips synchronously, so a second activation cannot slip past an await. */
  const registeringRef = useRef(false);
  /** False once unmounted: no navigate, no setState, on a late resolve. */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const currentUserId = useUserStore((s: any) => s.user?.id);
  const username = useUserStore((s: any) => s.user?.username) || 'Player';

  const register = useCallback(
    async (t: RegisterTournamentParams, onSuccess?: () => void) => {
      if (!currentUserId) {
        toast.error('Sign In To Register');
        return;
      }
      /* A REF, NOT THE STATE. `isRegistering` is state, and state does not
         change until React re-renders - but the very next line awaits a
         confirm dialog. Two activations in the same frame (a mobile
         double-tap, or Enter plus a click) BOTH passed this check, and
         confirmDialog QUEUES concurrent calls rather than rejecting them, so
         the second dialog surfaced after the first registration had already
         debited the buy-in and navigated. Confirming it debited a second
         time. The ref flips synchronously, before anything is awaited. */
      if (registeringRef.current) return;
      registeringRef.current = true;

      const totalCost = t.buy_in_amount + (t.buy_in_fee || 0);
      const confirmed = await confirmDialog({
        title: 'Confirm Buy In',
        message: `Register for ${t.name}? This will debit ${fmtChips(totalCost)} from your wallet.`,
        confirmText: 'Confirm Buy In',
      });
      if (!confirmed) {
        registeringRef.current = false;
        return;
      }

      setIsRegistering(true);
      try {
        await tournamentService.registerPlayer(t.id, currentUserId, username);
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
         * a stranger's felt. "You are in, your seat is coming" on the right
         * page beats being stranded on the wrong one.
         */
        const findMySeat = async (): Promise<string | null> => {
          const { data: tp, error } = await supabase
            .from('tournament_players')
            .select('table_id')
            .eq('tournament_id', t.id)
            .eq('user_id', currentUserId)
            .maybeSingle();
          /* A read that FAILED is not "no seat yet". Discarding the error made
             an RLS refusal or a dropped connection burn all three retries and
             then route a correctly seated player to the tournament page
             instead of to their table. */
          if (error)
            reportError(error, 'useTournamentRegistration.findMySeat', { tournamentId: t.id });
          return (tp?.table_id as string | undefined) || null;
        };

        let seatTableId = await findMySeat();
        for (let attempt = 0; !seatTableId && attempt < SEAT_LOOKUP_RETRIES; attempt++) {
          await new Promise((r) => setTimeout(r, SEAT_LOOKUP_RETRY_MS));
          seatTableId = await findMySeat();
        }

        /* The seat lookup can take 3.6s of retries. If the player left the
           lobby in that window, navigating would yank them out of whatever
           page they had moved on to. */
        if (aliveRef.current) {
          if (seatTableId) {
            navigate(`/table/${seatTableId}`);
          } else {
            toast.success('You Are Registered - Your Seat Is Being Assigned');
            navigate(`/tournaments/${t.id}`);
          }
        }
      } catch (e) {
        reportError(e, 'useTournamentRegistration.register', { tournamentId: t.id });
        toast.error(e instanceof Error ? e.message : 'Registration Failed, Please Try Again');
      } finally {
        registeringRef.current = false;
        if (aliveRef.current) setIsRegistering(false);
      }
    },
    [currentUserId, username, navigate, toast]
  );

  return { register, isRegistering };
}
