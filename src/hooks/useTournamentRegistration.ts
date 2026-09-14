import { useState, useCallback, useEffect, useRef } from 'react';
/* Dan 2026-08-28: the two "seat not confirmed yet" fallbacks below navigate to
   /tournaments/:id up to 3.6s AFTER the tap, from a hook instance that may live
   inside the in-tab lobby. useAppNavigate keeps that landing in the tab instead
   of unmounting the container. See InTabLobbyContext.tsx. */
import { useAppNavigate } from '../context/InTabLobbyContext';
import { useUserStore } from '../stores/useUserStore';
import { tournamentService, type TournamentEntryTicket } from '../services/TournamentService';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { signUpDialog } from '../components/tournament/signUpDialog';
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

/**
 * Has this tournament already started, i.e. is entering it a LATE registration?
 *
 * One definition, used by every register button, because five hand-rolled
 * copies of `status === 'RUNNING'` all missed `LATE_REG` (2026-08-25 audit).
 */
export function isLateStatus(status?: string | null): boolean {
  const s = String(status ?? '').toUpperCase();
  return s === 'RUNNING' || s === 'LATE_REG' || s === 'LATE_REGISTRATION';
}

export interface RegisterTournamentParams {
  id: string;
  name: string;
  buy_in_amount: number;
  buy_in_fee?: number;
  /* Dan 2026-08-25: the confirmation is now the full Sign Up card rather than a
     one-line "this will debit N" prompt, so it can show the rest of what a
     player is buying. All optional — a caller that only has the two money
     fields still gets a correct dialog, just a shorter one. */
  bounty_amount?: number | null;
  is_pko?: boolean;
  is_mystery_bounty?: boolean;
  start_time?: string | null;
  /**
   * The tournament's status, so the hook can work out for itself whether this
   * is a late registration.
   *
   * 2026-08-25, second audit: every caller was computing
   * `is_late_registration: status === 'RUNNING'` by hand, and every one of them
   * missed `LATE_REG` — a real status in `TournamentStatus`. A LATE_REG entry
   * therefore got the pre-start "Sign Up" treatment, which is false for an
   * event that has already started. One caller (ClubHomePage) passed nothing
   * at all. Deriving it here means no surface can get it wrong, and no new
   * surface has to remember.
   */
  status?: string | null;
  /** Explicit override. Leave unset and let `status` decide. */
  is_late_registration?: boolean;
  /**
   * Which club's chips pay for this seat.
   *
   * 2026-08-25 audit: without it the Sign Up card read the balance of whatever
   * club the player last looked at (`getPlayerBalance` defaults to the ambient
   * `currentClubId`), so a buy-in made from the GLOBAL lobby, an XMTT or a
   * union game could show the wrong wallet — and, worse, DISABLE Confirm for a
   * player who was funded in the club that would actually be charged.
   */
  club_id?: string | null;
}

export function useTournamentRegistration() {
  const [isRegistering, setIsRegistering] = useState(false);
  const navigate = useAppNavigate();
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

      // Every human registration surface funnels through this hook. Resolve
      // an exact entry-only ticket before showing the confirmation so a failed
      // selector can never be mistaken for "no ticket" and fall through to a
      // wallet charge.
      let entryTicket: TournamentEntryTicket | null;
      try {
        entryTicket = await tournamentService.findTournamentEntryTicket(t.id);
      } catch (e) {
        reportError(e, 'useTournamentRegistration.findTournamentEntryTicket', {
          tournamentId: t.id,
        });
        toast.error(
          e instanceof Error
            ? e.message
            : 'Could Not Check For A Tournament Ticket. No Chips Were Charged.'
        );
        registeringRef.current = false;
        return;
      }

      /**
       * ONE CONFIRMATION, AND THIS IS IT (Dan 2026-08-25, binding).
       *
       * "You don't need a secondary confirmation for buy ins. That's not
       *  needed."
       *
       * This used to be a generic `confirmDialog` — "Register for X? This will
       * debit 50 from your wallet." — and TournamentDetails had ALREADY shown
       * its own, far better Sign Up card before calling here, so registering
       * from the details page asked the same question twice. The other four
       * callers (ClubHomePage, TournamentPage, XMTTPage, UnionGamesPage) had no
       * card of their own, so simply deleting this would have left them taking
       * money with nothing asked at all.
       *
       * So the good card was promoted, not the terse one deleted: every path
       * through this hook now shows the SAME Sign Up dialog, exactly once, with
       * entry fee, bounty, start time and wallet balance on it. The details
       * page no longer renders a local copy — see TournamentDetails
       * `handleRegister`.
       */
      const confirmed = await signUpDialog({
        name: t.name,
        buyInAmount: t.buy_in_amount,
        buyInFee: t.buy_in_fee ?? 0,
        bountyAmount: t.bounty_amount ?? 0,
        isPko: t.is_pko,
        isMysteryBounty: t.is_mystery_bounty,
        startTime: t.start_time ?? null,
        userId: currentUserId,
        clubId: t.club_id ?? null,
        isLateRegistration: t.is_late_registration ?? isLateStatus(t.status),
        tournamentTicketId: entryTicket?.id ?? null,
      });
      if (!confirmed) {
        registeringRef.current = false;
        return;
      }

      setIsRegistering(true);
      try {
        const registration = await tournamentService.registerPlayer(
          t.id,
          currentUserId,
          username,
          entryTicket?.id ?? null
        );
        toast.success(`You Are Registered For ${t.name}`);

        /* 2026-08-25, second audit: chips just left this player's wallet and
           nothing said so. TournamentPage's old inline register path emitted
           BALANCE_UPDATED; routing every surface through this hook dropped it,
           so the wallet widget, the cashier and the lobby header all kept
           showing the pre-buy-in figure until something else happened to
           refresh them. Emitted HERE rather than in six onSuccess callbacks,
           for the same reason the dialog lives here. */
        if (!entryTicket) {
          masterBus.emit('BALANCE_UPDATED', {
            source: 'tournament_buy_in',
            userId: currentUserId,
            tournamentId: t.id,
          });
        }

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
          /* A read that FAILED is not "no seat yet" - and it is not a pending
             seat either. Three distinct outcomes, three distinct things said
             to the player (#795). */
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

        /* The retries can take 3.6s. If the player left the lobby in that
           window, navigating would yank them out of whatever page they had
           moved on to, and setIsRegistering would fire on a dead component. */
        if (aliveRef.current) {
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
