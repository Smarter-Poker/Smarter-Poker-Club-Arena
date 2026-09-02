-- ============================================================================
-- THE SIT-OUT CLOCK HAS TO SURVIVE A RESTART, OR IT NEVER RUNS OUT.
--
-- Dan 2026-08-28: "IT WAS SUPPOSED TO BE FIXED THAT A USER CAN ONLY SIT OUT
-- FOR 5 MINUTES, BEFORE GETTING BOOTED IN A CASH GAME ... BUT FOR SOME REASON
-- THIS NEVER KICKS THE USER OFF THE CASH GAME AFTER THE 5 MIN."
--
-- THE ROOT CAUSE, and it is this file's whole reason to exist:
--
--   DisconnectEngine.SITOUT_MAX_MS is five minutes and the comparison against
--   it is correct. But the value it compares to, `sitOutSince`, is a field on
--   an in-memory Map inside the engine process. `table_seats.is_sitting_out`
--   is persisted; the CLOCK behind it never was.
--
--   So on every engine restart -- a deploy, a lease change, killForRestart,
--   the watchdog -- ServerTableEngineBase.restoreSitOutsFromSeats() reads the
--   boolean back, calls sitOut(), and sitOut() stamps `sitOutSince = Date.now()`.
--   THE FIVE MINUTES START AGAIN FROM ZERO. An engine that recycles more often
--   than every five minutes can never evict anybody, and a player noticed that
--   long before we did: the seat is held forever.
--
-- THE FIX: give the clock a column. `sit_out_at` is stamped by a TRIGGER on the
-- transition into sitting out and cleared on the way out, so it is correct no
-- matter which of the eleven writers of `is_sitting_out` did the writing --
-- the engine, a waitlist promotion, a late-reg seat, a spin lifecycle RPC. A
-- rule enforced in one trigger cannot drift the way a rule copied into eleven
-- callers does, and this column exists precisely because the in-memory copy
-- drifted.
--
-- WHAT THIS DOES NOT CHANGE: tournaments. Dan, same message: sitting out is
-- allowed "AS LONG AS THEY WANT IN A MTT, SPIN OR HEADS UP (BUT THEY WILL BE
-- BLINDED OFF)". The eviction sweep already returns early on a tournament
-- table and still does. This column is stamped on tournament seats too -- it
-- is an observation, not a sentence -- so the "SITTING OUT" tag and any future
-- report can read it. Nothing evicts on it outside cash.
-- ============================================================================

-- ── 1. The column ──────────────────────────────────────────────────────────
ALTER TABLE public.table_seats
  ADD COLUMN IF NOT EXISTS sit_out_at timestamptz;

COMMENT ON COLUMN public.table_seats.sit_out_at IS
  'When this seat entered the sitting-out state. Stamped and cleared by '
  'trg_stamp_sit_out_at; never written by hand. NULL whenever is_sitting_out '
  'is false. The cash-game 5-minute eviction clock reads THIS, not process '
  'memory, so that it survives an engine restart (2026-08-28).';

-- ── 2. Stamp / clear it on the transition ──────────────────────────────────
-- BEFORE INSERT OR UPDATE, so it is impossible to write the pair inconsistently.
CREATE OR REPLACE FUNCTION public.fn_stamp_sit_out_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- trg_new_seat_clear_sitout already forces is_sitting_out=false on insert.
    -- Mirror it rather than depend on trigger firing order (both are BEFORE
    -- INSERT and alphabetical order is not a contract worth relying on).
    NEW.sit_out_at := CASE WHEN COALESCE(NEW.is_sitting_out, false)
                           THEN COALESCE(NEW.sit_out_at, now())
                           ELSE NULL END;
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.is_sitting_out, false) AND NOT COALESCE(OLD.is_sitting_out, false) THEN
    -- Entering sit-out: start the clock.
    NEW.sit_out_at := now();
  ELSIF NOT COALESCE(NEW.is_sitting_out, false) THEN
    -- Not sitting out, by any route (sat back in, seat turned over, evicted).
    NEW.sit_out_at := NULL;
  ELSE
    -- Still sitting out. HOLD THE ORIGINAL STAMP. This branch is the point of
    -- the whole migration: an unrelated UPDATE to the row (a stack change, a
    -- time-bank decrement, a status write) must NOT restart the five minutes.
    NEW.sit_out_at := COALESCE(OLD.sit_out_at, NEW.sit_out_at, now());
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_stamp_sit_out_at ON public.table_seats;
CREATE TRIGGER trg_stamp_sit_out_at
  BEFORE INSERT OR UPDATE ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.fn_stamp_sit_out_at();

-- ── 3. Teach the existing sit-out-clearing trigger about the new column ────
-- fn_clear_sitout_on_turnover nulls is_sitting_out when a seat is vacated or
-- reused. trg_stamp_sit_out_at runs on the same row and will null sit_out_at
-- to match, but only if it fires AFTER this one. Rather than bet on firing
-- order, clear both here too -- doing it twice is free, doing it never is a
-- seat that reads as "sitting out since last Tuesday".
CREATE OR REPLACE FUNCTION public.fn_clear_sitout_on_turnover()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF NEW.left_at IS NOT NULL AND OLD.left_at IS NULL THEN
    NEW.is_sitting_out := false;
    NEW.sit_out_at := NULL;
  ELSIF NEW.left_at IS NULL AND OLD.left_at IS NOT NULL
        AND NEW.is_sitting_out IS NOT DISTINCT FROM OLD.is_sitting_out THEN
    NEW.is_sitting_out := false;
    NEW.sit_out_at := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_new_seat_clear_sitout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  NEW.is_sitting_out := false;
  NEW.sit_out_at := NULL;
  RETURN NEW;
END;
$function$;

-- ── 4. Backfill live sit-outs ──────────────────────────────────────────────
-- Seats already sitting out when this lands have no honest stamp -- the only
-- record of when they sat out was in a process that has since restarted. Give
-- them now(). That grants each one a fresh five minutes exactly once, which is
-- the generous reading, and is what the buggy code was accidentally doing on
-- every restart anyway.
UPDATE public.table_seats
   SET sit_out_at = now()
 WHERE left_at IS NULL
   AND COALESCE(is_sitting_out, false) = true
   AND sit_out_at IS NULL;

-- ── 5. Assertions. A migration that cannot prove its own premise is a guess. ─
DO $$
DECLARE
  v_seat_id  uuid;
  v_table_id uuid;
  v_stamp1   timestamptz;
  v_stamp2   timestamptz;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='table_seats' AND column_name='sit_out_at'
  ) THEN
    RAISE EXCEPTION 'sit_out_at was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='trg_stamp_sit_out_at' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'trg_stamp_sit_out_at was not created';
  END IF;

  -- Any row left inconsistent by the backfill is a bug in this file.
  IF EXISTS (
    SELECT 1 FROM public.table_seats
     WHERE left_at IS NULL
       AND COALESCE(is_sitting_out, false) = true
       AND sit_out_at IS NULL
  ) THEN
    RAISE EXCEPTION 'a live sitting-out seat still has a null sit_out_at';
  END IF;

  -- Behavioural proof, rolled back with the DO block's own subtransaction:
  -- an unrelated UPDATE must NOT move the stamp. That is the exact defect
  -- this migration exists to prevent, so it is the one thing worth proving
  -- rather than asserting.
  --
  -- Deliberately probed on a DEPARTED seat (left_at IS NOT NULL), never a live
  -- one. CLAUDE.md 11.5 -- do not touch a real seat to test a rule. Every other
  -- trigger on this table short-circuits on a departed row
  -- (fn_enforce_four_table_limit and fn_guard_one_live_tournament_seat both
  -- `RETURN NEW` immediately when left_at IS NOT NULL, fn_log_seat_stack_exit
  -- only fires on a left_at transition), so the probe cannot refuse a seat, log
  -- a phantom stack exit, or move a chip. The subtransaction is rolled back
  -- regardless.
  SELECT id, table_id INTO v_seat_id, v_table_id
    FROM public.table_seats
   WHERE left_at IS NOT NULL
   ORDER BY left_at DESC
   LIMIT 1;

  IF v_seat_id IS NOT NULL THEN
    BEGIN
      UPDATE public.table_seats SET is_sitting_out = true WHERE id = v_seat_id;
      SELECT sit_out_at INTO v_stamp1 FROM public.table_seats WHERE id = v_seat_id;
      IF v_stamp1 IS NULL THEN
        RAISE EXCEPTION 'entering sit-out did not stamp sit_out_at';
      END IF;

      PERFORM pg_sleep(0.05);
      UPDATE public.table_seats SET status = status WHERE id = v_seat_id;
      SELECT sit_out_at INTO v_stamp2 FROM public.table_seats WHERE id = v_seat_id;
      IF v_stamp2 IS DISTINCT FROM v_stamp1 THEN
        RAISE EXCEPTION
          'an unrelated UPDATE restarted the sit-out clock (% -> %)', v_stamp1, v_stamp2;
      END IF;

      UPDATE public.table_seats SET is_sitting_out = false WHERE id = v_seat_id;
      SELECT sit_out_at INTO v_stamp2 FROM public.table_seats WHERE id = v_seat_id;
      IF v_stamp2 IS NOT NULL THEN
        RAISE EXCEPTION 'sitting back in did not clear sit_out_at';
      END IF;

      -- Undo the probe. CLAUDE.md 11.5: never leave a money/seat path altered.
      RAISE EXCEPTION 'rollback_probe';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'rollback_probe' THEN
        RAISE;
      END IF;
    END;
  END IF;
END $$;

-- ROLLBACK (Tier 3 requires this pasted, per .agent/workflows/migration-safety.md):
--   DROP TRIGGER IF EXISTS trg_stamp_sit_out_at ON public.table_seats;
--   DROP FUNCTION IF EXISTS public.fn_stamp_sit_out_at();
--   ALTER TABLE public.table_seats DROP COLUMN IF EXISTS sit_out_at;
--   -- then restore fn_clear_sitout_on_turnover / fn_new_seat_clear_sitout from
--   -- 20260821b_clear_sitout_on_seat_turnover.sql and
--   -- 20260826100000_fix_seat_sitout_and_waitlist_badges.sql respectively.
