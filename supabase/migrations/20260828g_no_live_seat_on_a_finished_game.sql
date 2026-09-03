-- ═══════════════════════════════════════════════════════════════════════════
-- NO LIVE SEAT ON A FINISHED GAME (2026-08-28)
--
-- `trg_clear_seats_on_game_end` (20260823280000) vacates every seat when a
-- tournament flips to COMPLETED/CANCELLED. It is correct and it is not
-- enough, because it fires ONCE, at the transition: any seat WRITTEN AFTER
-- that instant survives it.
--
-- Measured on production today: 26 live seat rows on finished games holding
-- 191,176 chips, every one of them stamped between 0.216s and 2.805s AFTER
-- the tournament's own ended_at. Thirteen were spins. So this is not a
-- missing trigger, it is a race the trigger cannot see — several writers can
-- land a seat in that window (the table-balancer's seat reuse/insert, the
-- late-registration sweep, a final-stack persist), and chasing each one
-- leaves the next one free to do it again.
--
-- The repair is the INVARIANT rather than the race, the same shape as the
-- hero-seat invariant in TablePage: a seat cannot be LIVE on a game that is
-- over, no matter who writes it or when.
--
-- Why the chips matter even though nobody is robbed: prize money is paid
-- from tournament_payouts, not from a seat row, so no player is short. But
-- `table_seats.stack` is one of the two pools fn_club_chip_circulation
-- counts as "on the felt", and a stranded row inflates it forever — the
-- reconciliation surface added on 2026-08-25 exists precisely so that number
-- means something.
--
-- SHAPE: this NEVER refuses a write. A guard that can refuse a seat write is
-- a guard that can strand a player mid-hand (rule 11.5's lesson, and the
-- reason ca_seat_stack_exits reports rather than blocks). It stamps the row
-- as already-departed instead: the write succeeds, the seat is simply not
-- live. On INSERT that means the exit-watch trigger (BEFORE DELETE OR UPDATE
-- OF left_at) never fires for it, which is correct — nothing exited, the
-- seat was never open.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_no_live_seat_on_finished_game()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_status text;
BEGIN
  -- Only a seat that would be LIVE is interesting. A row already carrying
  -- left_at is departed and is left exactly as written.
  IF NEW.left_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT t.status INTO v_status
    FROM public.tables tb
    JOIN public.tournaments t ON t.id = tb.tournament_id
   WHERE tb.id = NEW.table_id;

  -- No row means a cash table (tournament_id NULL) or an unreadable join:
  -- either way this guard has nothing to say and must not interfere.
  IF v_status IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_status IN ('COMPLETED', 'CANCELLED') THEN
    NEW.left_at := now();
    NEW.is_sitting_out := false;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_no_live_seat_on_finished_game ON public.table_seats;
CREATE TRIGGER trg_no_live_seat_on_finished_game
  BEFORE INSERT OR UPDATE ON public.table_seats
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_no_live_seat_on_finished_game();

-- ── Backfill the 26 rows already stranded ───────────────────────────────────
-- Stamped with the game's own ended_at where it is known, so the row reads as
-- having left when its game did rather than when this migration ran.
UPDATE public.table_seats s
   SET left_at = COALESCE(t.ended_at, now()),
       is_sitting_out = false
  FROM public.tables tb
  JOIN public.tournaments t ON t.id = tb.tournament_id
 WHERE s.table_id = tb.id
   AND s.left_at IS NULL
   AND t.status IN ('COMPLETED', 'CANCELLED');

-- ── Post-apply assertions: the invariant holds, and nothing else moved ──────
DO $$
DECLARE
  v_left integer;
BEGIN
  SELECT count(*) INTO v_left
    FROM public.tournaments t
    JOIN public.tables tb ON tb.tournament_id = t.id
    JOIN public.table_seats s ON s.table_id = tb.id AND s.left_at IS NULL
   WHERE t.status IN ('COMPLETED', 'CANCELLED');
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'backfill left % live seat(s) on finished games', v_left;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_no_live_seat_on_finished_game'
       AND tgrelid = 'public.table_seats'::regclass
  ) THEN
    RAISE EXCEPTION 'trigger trg_no_live_seat_on_finished_game did not attach';
  END IF;

  -- A live game must be untouched: this guard may never cost a seated player
  -- their seat. Asserted rather than assumed, because the failure mode of a
  -- wrong predicate here is "every player at every running table stands up".
  IF (SELECT count(*)
        FROM public.tournaments t
        JOIN public.tables tb ON tb.tournament_id = t.id
        JOIN public.table_seats s ON s.table_id = tb.id AND s.left_at IS NULL
       WHERE t.status = 'RUNNING') = 0 THEN
    RAISE EXCEPTION 'no seated players remain on any RUNNING tournament - the predicate is too wide';
  END IF;
END $$;

-- ROLLBACK
--   DROP TRIGGER IF EXISTS trg_no_live_seat_on_finished_game ON public.table_seats;
--   DROP FUNCTION IF EXISTS public.fn_no_live_seat_on_finished_game();
--   (The backfill is not reversed: those seats belong to games that ended.)
