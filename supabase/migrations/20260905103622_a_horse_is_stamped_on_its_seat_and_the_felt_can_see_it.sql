-- ═══════════════════════════════════════════════════════════════════════════
--  A HORSE IS STAMPED ON ITS SEAT, AND THE FELT CAN SEE IT (2026-09-05)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Measured on production today: `table_seats.horse_id` is NULL on ALL 416 live
-- seats, and on 339,077 of 339,108 rows ever written. It has never once been
-- populated. Meanwhile it is the flag four separate consumers read:
--
--   src/pages/TablePage.tsx  (x3)  isHorse: !!seat.horse_id   -- the badge
--   src/services/TableService.ts   horse_id off the seat drives felt styling
--   src/pages/admin/AnalyticsDashboard.tsx  .is('horse_id', null) -- "real players"
--   public.trg_auto_cashout_on_table_close  AND ts.horse_id IS NULL
--
-- So every horse on the platform renders as a HUMAN, and the admin dashboard
-- counts all 416 of them as real players. The comment in TableService says
-- exactly why the column exists - `profiles.is_horse` is deliberately not
-- client-readable ("a horse is named only to those entitled"), so the seat row
-- has to carry the flag - and then nothing ever wrote it.
--
-- It is worst precisely where Dan was looking. A pre-start Spin board has no
-- engine snapshot yet (the engine IS the authority once play begins, and it
-- reads profiles server-side with service_role), so the seat-first roster
-- rebuild is the only source, and it reports three horses as three people.
--
-- ── THE TRAP IN POPULATING IT, WHICH IS WHY THIS IS ONE MIGRATION ───────────
--
-- `trg_auto_cashout_on_table_close` cashes out every live seat holding chips
-- when a cash table closes - EXCEPT, it says, seats with a horse_id. Because
-- the column is NULL for everyone, that exclusion has never fired: horses are
-- cashed out today, which is correct and is what CLAUDE.md 10.5 requires
-- ("IS PAID everything a human is paid - prizes, bounties, refunds").
--
-- Stamping the column would have woken that filter and started stranding horse
-- chips on the felt of every closing table. So the filter goes in the SAME
-- transaction. Removing it does not change what the platform does today; it
-- keeps it, and stops it changing under a column that is finally being filled.
--
-- Nothing else wakes. `dynamicPersonaRotation` and `smartSeatSelection`
-- (HorseOrchestrator) read horse_id and have NO callers - dead code. The DB
-- function `schedule_horse_leave` matches on horse_id and has no callers
-- either. `fn_cash_seat_move_execute` / `fn_cash_seat_swap_execute` only carry
-- the value across a move, which is now correct rather than vacuous.
--
-- ── WHY A TRIGGER AND NOT A WRITE IN EACH RPC ───────────────────────────────
--
-- There are at least five ways a seat is created (fn_take_seat_and_buy_in,
-- fn_seat_horse_in_seat_first_game, fn_seat_late_registrant,
-- fn_horse_seat_from_treasury, atomic_table_buyin) plus the engine's own
-- inserts. A rule enforced in six places is a rule that is about to be
-- enforced in five. The trigger covers every path that exists and every path
-- anyone adds later, which is the same reasoning behind zz_seat_stack_exits.
--
-- BACKFILL SCOPE: live seats only (left_at IS NULL). Those are what the badge,
-- the felt styling and the dashboard's live counts read. The 338k historical
-- rows are left alone deliberately - rewriting them would fire twenty triggers
-- per row for a column nothing reads retrospectively, and history is not
-- improved by being restated.
--
-- ── APPLIED IN THREE STAGES, AND HERE IS WHY (2026-09-05) ──────────────────
--
-- The first attempt ran all of this as one transaction and DEADLOCKED:
--
--   40P01: deadlock detected
--   Process A waits for AccessExclusiveLock on table_seats;
--   blocked by process B, which waits for AccessShareLock on a relation A holds.
--
-- `CREATE TRIGGER` takes an AccessExclusiveLock, and table_seats is written
-- continuously by the engine - 123 seats were created during the three minutes
-- it took to verify this migration. Nothing applied (the transaction was
-- atomic), but the lesson is in the file: on THIS table, take the lock
-- politely or become the reason the felt stalls.
--
-- So it is staged, and the `SET LOCAL lock_timeout` below is the whole point.
-- The two CREATE OR REPLACE FUNCTIONs lock nothing and go first; the trigger
-- goes second with a 4s ceiling; the backfill is ordinary DML last. Re-running
-- the whole file is safe - every step is idempotent.
--
-- ROLLBACK: DROP TRIGGER trg_stamp_seat_horse_id ON public.table_seats;
--           and restore the previous trg_auto_cashout_on_table_close body
--           (the one carrying `AND ts.horse_id IS NULL`). Note that doing the
--           second WITHOUT the first re-arms the stranding bug.

BEGIN;

-- ── 1. The cash-out trigger stops excluding horses ─────────────────────────
-- Identical to today's behaviour, because today horse_id is always NULL. It is
-- stated explicitly so filling the column cannot silently change it.
CREATE OR REPLACE FUNCTION public.trg_auto_cashout_on_table_close()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
BEGIN
  IF NEW.tournament_id IS NOT NULL THEN
    RETURN NEW; -- tournament tables settle via prizes, not seat cashout
  END IF;

  FOR r IN
    SELECT ts.user_id, ts.seat_number
    FROM table_seats ts
    WHERE ts.table_id = NEW.id
      AND ts.left_at IS NULL
      /* `AND ts.horse_id IS NULL` was here until 2026-09-05. It read as "do
         not cash out horses", it never fired (the column was never written),
         and the moment the column WAS written it would have stranded every
         horse's chips on every closing table. CLAUDE.md 10.5: a horse is paid
         everything a human is paid. Every seat holding chips is cashed out. */
      AND COALESCE(ts.stack,0) > 0
  LOOP
    BEGIN
      PERFORM public.atomic_table_cashout(r.user_id, NEW.id, r.seat_number);
    EXCEPTION WHEN OTHERS THEN
      -- Never block the close on a single seat's cashout failure; leave that seat
      -- for the reconciliation sweep rather than aborting the whole transaction.
      RAISE WARNING 'auto-cashout failed for user % on table %: %', r.user_id, NEW.id, SQLERRM;
    END;
  END LOOP;

  RETURN NEW;
END;
$function$;

-- ── 2. Every seat learns whether its occupant is a horse ───────────────────
CREATE OR REPLACE FUNCTION public.fn_stamp_seat_horse_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER          -- profiles.is_horse is not readable by `authenticated`
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.user_id IS NULL THEN
    NEW.horse_id := NULL;
    RETURN NEW;
  END IF;

  SELECT CASE WHEN COALESCE(p.is_horse, false) THEN p.id ELSE NULL END
    INTO NEW.horse_id
    FROM public.profiles p
   WHERE p.id = NEW.user_id;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.fn_stamp_seat_horse_id() IS
  'Stamps table_seats.horse_id with the occupant profile id when that profile is a horse, NULL otherwise. The client cannot read profiles.is_horse (a horse is named only to those entitled), so the seat row is how the felt knows. Fires only when user_id is written, so an ordinary stack update costs nothing.';

-- UPDATE OF user_id, not UPDATE: an ordinary stack or sit-out write must not
-- pay for a profiles lookup. Every path that puts a person in a seat writes
-- user_id, including the two that REUSE a vacated row (left_at NOT NULL ->
-- NULL sets user_id in the same statement).
-- See the staging note in the header: this statement is the one that
-- deadlocked. Fail fast rather than queue behind live play.
SET LOCAL lock_timeout = '4s';

DROP TRIGGER IF EXISTS trg_stamp_seat_horse_id ON public.table_seats;
CREATE TRIGGER trg_stamp_seat_horse_id
  BEFORE INSERT OR UPDATE OF user_id ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.fn_stamp_seat_horse_id();

-- ── 3. Backfill the seats that are live right now ──────────────────────────
--
-- ROW BY ROW, AND FORGIVING, because table_seats carries EIGHT other BEFORE
-- UPDATE triggers - the four-table limit, the one-live-seat-per-tournament
-- guard, the finished-game guard, the restriction guard, the freeze guard and
-- more. A single bulk UPDATE asks all of them to approve 416 rows at once, and
-- any ONE refusal (a seat that is legitimately stale, a player restricted
-- since they sat) would abort the whole migration and take the trigger with
-- it. A seat that cannot be stamped is not worth losing the fix for: it is
-- skipped, counted, and reported.
DO $backfill$
DECLARE
  r        RECORD;
  v_done   int := 0;
  v_failed int := 0;
BEGIN
  FOR r IN
    SELECT ts.id
      FROM public.table_seats ts
      JOIN public.profiles p ON p.id = ts.user_id
     WHERE ts.left_at IS NULL
       AND COALESCE(p.is_horse, false)
       AND ts.horse_id IS DISTINCT FROM ts.user_id
  LOOP
    BEGIN
      UPDATE public.table_seats SET user_id = user_id WHERE id = r.id;
      v_done := v_done + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      RAISE WARNING 'horse_id backfill skipped seat % (%): %', r.id, SQLSTATE, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE 'horse_id backfill: % stamped, % skipped', v_done, v_failed;
END
$backfill$;

COMMIT;
