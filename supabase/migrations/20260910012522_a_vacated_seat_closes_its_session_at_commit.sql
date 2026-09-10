/* A VACATED SEAT CLOSES ITS SESSION AT COMMIT (2026-09-10)

   The earlier migration tonight closed sessions when a TABLE closes. That was
   38 of 40 orphans and not the whole leak. Read from pg_proc: TWELVE functions
   vacate a cash seat, and exactly ONE of them - atomic_seat_cashout_locked -
   closes the player's cash_player_session. Five of the other eleven close the
   table, which the table trigger now covers. The rest vacate a seat on a table
   that stays open - a player BUSTING through fn_ca_settle_hand_stacks_absolute
   or fn_ca_release_broke_seats - and leave the session behind.

   THE FIX goes on the seat itself, so no vacate path can forget: a trigger on
   table_seats for left_at going NULL -> NOT NULL on a cash table.

   WHY IT IS DEFERRED, and this is the whole design. atomic_seat_cashout_locked
   vacates the seat FIRST and calls fn_cash_session_close AFTER, and that close
   is what writes the rejoin-window and VPIP-eviction bars (Dan 2026-09-05:
   booted for low VPIP means barred from that game for two hours). A trigger
   firing at the vacate would close the session before that call ran; the
   call's UPDATE ... WHERE closed_at IS NULL would then find nothing, and THE
   BAR WOULD SILENTLY NEVER BE WRITTEN. So it runs as a DEFERRABLE INITIALLY
   DEFERRED constraint trigger - at commit, after every proper close path in
   the transaction has had its turn:

     - a cashout's own fn_cash_session_close has already closed it: no-op
     - a seat move has re-pointed it to the destination, so nothing is open on
       the vacated table any more: no-op, no flag needed
     - a table close has already closed it via the table trigger: no-op
     - a bust that nobody closed: still open at commit, closed here as
       'seat_vacated' - not a leave, so no bar, correctly

   Measured before this ran: 436 open sessions, 436 live cash seats - the
   invariant holds after tonight's backfill. This is what keeps it holding on
   the paths that would otherwise break it again on the next bust. */
DO $mig$
BEGIN
  IF NOT (current_user IN ('postgres','service_role')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  CREATE OR REPLACE FUNCTION public.trg_fn_close_session_when_seat_vacated()
  RETURNS trigger LANGUAGE plpgsql SET search_path='public' AS $f$
  BEGIN
    /* A VACATED SEAT CLOSES ITS SESSION AT COMMIT (2026-09-10). Deferred: any
       proper close in this transaction has already run. Only a session that
       NOBODY closed is still open here, and that is the one this closes. */
    IF OLD.left_at IS NULL AND NEW.left_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.tables t WHERE t.id = NEW.table_id AND t.tournament_id IS NULL) THEN
      UPDATE public.cash_player_session
         SET closed_at = clock_timestamp(), closed_reason = 'seat_vacated'
       WHERE player_id = NEW.user_id AND scope_type = 'table'
         AND scope_id = NEW.table_id AND closed_at IS NULL;
    END IF;
    RETURN NULL;
  END $f$;

  DROP TRIGGER IF EXISTS zz_close_session_when_seat_vacated ON public.table_seats;
  CREATE CONSTRAINT TRIGGER zz_close_session_when_seat_vacated
    AFTER UPDATE OF left_at ON public.table_seats
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.trg_fn_close_session_when_seat_vacated();

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='zz_close_session_when_seat_vacated'
                    AND tgrelid='public.table_seats'::regclass AND tgdeferrable AND tginitdeferred) THEN
    RAISE EXCEPTION 'post-condition failed: the trigger is not installed as DEFERRABLE INITIALLY DEFERRED. Nothing written.';
  END IF;

  RAISE NOTICE 'deferred seat-vacate close armed on table_seats';
END $mig$;
