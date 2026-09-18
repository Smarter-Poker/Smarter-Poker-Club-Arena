-- 20260918091617_a_cash_cutover_cannot_split_an_open_union_week.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A CASH ACCRUAL CUTOVER CANNOT SPLIT AN OPEN UNION WEEK.
--
-- WHAT WENT WRONG (measured on production 2026-09-18)
--
-- accounting_cash_accrual_cutover.starts_at was armed at 2026-09-17
-- 18:24:04.643251+00, one and eight tenths of a second after the tournament fee
-- cutover and in the same operation. The union accounting week runs Monday to
-- Monday in America/Los_Angeles, so the open week had started at 2026-09-14
-- 07:00:00+00, three and a half days earlier. The cutover landed in the middle
-- of it.
--
-- fn_accounting_union_earned_plan refuses any period that begins before the
-- cutover:
--
--   IF NOT EXISTS(SELECT 1 FROM accounting_cash_accrual_cutover
--                  WHERE singleton AND starts_at <= p_start)
--   THEN RAISE EXCEPTION 'union_earning_source_historical_week_uncertified';
--
-- The hourly union-integrity-sweep asks it for the OPEN week, which now starts
-- before the cutover, so from 18:35:01 that evening both of the sweep's money
-- controls failed and kept failing:
--
--   fn_union_rake_basis_refresh  union_earning_source_historical_week_uncertified
--   fn_union_enforce_stop_loss   invalid_closed_pnl_evidence_period
--
-- Fifteen consecutive hourly failures over fourteen hours, one union, and for
-- all of that time the union stop-loss was not being enforced. It repairs
-- itself at 2026-09-21 07:00:00+00 when the next week begins after the cutover,
-- which is luck rather than design: nothing would have stopped it lasting a
-- week, and nothing stops the next cutover doing it again.
--
-- THIS IS THE SAME DISEASE AS 20260918064540
--
-- That migration stopped the tournament fee cutover being armed at an instant
-- that would strand a live game. This is the identical failure one table over:
-- a cutover armed over a period that was already open breaks the period that
-- straddles it. The fee cutover froze 649 tournaments; the cash cutover
-- silenced a stop-loss. Both rows were armed by the same operation, seconds
-- apart, and neither table checked the instant before accepting it.
--
-- WHAT THIS CHANGES
--
-- The cash accrual cutover may only be armed on a union week boundary. Then no
-- week can straddle it, every week either begins at or after the cutover and is
-- certifiable, or ended before it and is history. The refusal names the week it
-- would have split and how many hours of it would have been orphaned.
--
-- WHY THE HOLE WAS EXACTLY HERE
--
-- The row is defended in every direction but one, exactly like its sibling.
-- accounting_cash_cutover_immutable refuses UPDATE and DELETE,
-- accounting_cash_cutover_no_truncate refuses TRUNCATE, and PRIMARY KEY
-- (singleton) with CHECK (singleton) allows one row. So the instant can never
-- move once chosen, and nothing checked it when it was chosen. INSERT was the
-- whole unguarded surface, and INSERT is how this happened.
--
-- It does not repair the open week. That row is immutable and correctly so, and
-- fn_accounting_union_earned_plan has no definition in supabase/migrations, so
-- teaching it to clamp a straddling period to the cutover would mean making a
-- transcription the source of record for money code that has none. The week
-- clears on 2026-09-21 by itself.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, ~28s on this database.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS. The table is the one this reviewed, its existing defences
--    are the ones this completes, and the two functions the invariant is
--    derived from are the bodies it was derived from.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_cols text;
  v_trgs text;
  v_md5  text;
BEGIN
  SELECT string_agg(column_name, ',' ORDER BY ordinal_position) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'accounting_cash_accrual_cutover';
  IF v_cols IS DISTINCT FROM 'singleton,starts_at' THEN
    RAISE EXCEPTION 'precondition: accounting_cash_accrual_cutover is not (singleton, starts_at) but (%)', v_cols;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton) THEN
    RAISE EXCEPTION 'precondition: the cash accrual cutover singleton row is missing';
  END IF;

  SELECT string_agg(t.tgname, ',' ORDER BY t.tgname) INTO v_trgs
    FROM pg_catalog.pg_trigger t
   WHERE NOT t.tgisinternal
     AND t.tgrelid = 'public.accounting_cash_accrual_cutover'::regclass;
  IF v_trgs IS DISTINCT FROM 'accounting_cash_cutover_immutable,accounting_cash_cutover_no_truncate' THEN
    RAISE EXCEPTION 'precondition: the cutover row carries triggers (%), not the immutable/no_truncate pair this guard was sized against', v_trgs;
  END IF;

  -- The week definition the invariant is stated in.
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_md5 FROM pg_proc p
   WHERE p.oid = 'public.fn_union_week_start(timestamptz)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '103f192a228084dad0e4268c36c82c4b' THEN
    RAISE EXCEPTION 'precondition: fn_union_week_start is md5 %, not the week definition this invariant is stated in', v_md5;
  END IF;

  -- The refuser whose rule this encodes. If it stops refusing uncertified
  -- historical weeks, week alignment is no longer the thing that matters.
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_md5 FROM pg_proc p
   WHERE p.oid = 'public.fn_accounting_union_earned_plan(uuid,timestamptz,timestamptz)'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'c4e909aebc4228ff1d93695ed92f0368' THEN
    RAISE EXCEPTION 'precondition: fn_accounting_union_earned_plan is md5 %, not the body whose certification rule this guard exists to satisfy', v_md5;
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. WOULD THIS INSTANT SPLIT A UNION WEEK?
--
--    STABLE rather than IMMUTABLE. fn_union_week_start is marked IMMUTABLE and
--    the arithmetic here is a pure function of its argument, but it resolves
--    America/Los_Angeles, and a timezone database update can move a boundary.
--    A guard that the planner is free to constant-fold across such a change is
--    a guard that can answer from a cache older than the rule it enforces.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_cash_cutover_week_split_by(p_starts_at timestamptz)
RETURNS TABLE(splits boolean, week_start timestamptz, week_end timestamptz, orphaned_hours numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $split$
  SELECT p_starts_at IS DISTINCT FROM w.s,
         w.s,
         ((w.s AT TIME ZONE 'America/Los_Angeles') + interval '7 days') AT TIME ZONE 'America/Los_Angeles',
         round((extract(epoch FROM (p_starts_at - w.s)) / 3600)::numeric, 2)
    FROM (SELECT public.fn_union_week_start(p_starts_at) AS s) w;
$split$;

REVOKE ALL ON FUNCTION public.fn_ca_cash_cutover_week_split_by(timestamptz) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fn_ca_cash_cutover_week_split_by(timestamptz) IS
  'Whether a cash accrual cutover armed at this instant would split a union accounting week, and which week. A split week begins before the cutover, so fn_accounting_union_earned_plan refuses it as uncertified and every union control that reads the open week fails until the next week begins. Read by ca_cash_cutover_is_week_aligned before the cutover may be armed.';

-- ---------------------------------------------------------------------------
-- 2. THE GUARD, ON THE ONE OPERATION THE ROW DID NOT ALREADY REFUSE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_guard_cash_cutover_week_aligned()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $guard$
DECLARE
  v record;
BEGIN
  IF NEW.starts_at IS NULL OR NOT isfinite(NEW.starts_at) THEN
    RAISE EXCEPTION 'the accounting cash accrual cutover needs a finite instant' USING ERRCODE = '22007';
  END IF;

  SELECT * INTO v FROM public.fn_ca_cash_cutover_week_split_by(NEW.starts_at);

  IF v.splits THEN
    RAISE EXCEPTION
      'cash accrual cutover % would split the union week beginning %, orphaning its first % hour(s). Arm it at % instead.',
      NEW.starts_at, v.week_start, v.orphaned_hours, v.week_end
      USING ERRCODE = '55000',
            HINT = 'A week that begins before the cutover is refused as uncertified by fn_accounting_union_earned_plan, so the union stop-loss and rake basis stop running until the next week begins.';
  END IF;

  RETURN NEW;
END
$guard$;

REVOKE ALL ON FUNCTION public.fn_ca_guard_cash_cutover_week_aligned() FROM PUBLIC, anon, authenticated;

-- INSERT only. accounting_cash_cutover_immutable already refuses UPDATE and
-- DELETE and accounting_cash_cutover_no_truncate refuses TRUNCATE, so arming
-- the row is the whole remaining surface. A BEFORE ROW trigger runs before the
-- primary key is checked, which is what lets this refusal be the one an
-- operator sees rather than a duplicate key error.
CREATE TRIGGER ca_cash_cutover_is_week_aligned
  BEFORE INSERT ON public.accounting_cash_accrual_cutover
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_guard_cash_cutover_week_aligned();

COMMENT ON TRIGGER ca_cash_cutover_is_week_aligned ON public.accounting_cash_accrual_cutover IS
  'The cash accrual cutover may only be armed on a union week boundary. On 2026-09-17 it was armed three and a half days into an open week, and the union stop-loss went unenforced for fourteen hours until the week rolled.';

-- ---------------------------------------------------------------------------
-- 3. POSTCONDITIONS. The guard exists, it refuses the instant that caused the
--    outage, and it is not merely refusing everything.
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  v_now      timestamptz := (SELECT starts_at FROM public.accounting_cash_accrual_cutover WHERE singleton);
  v          record;
  v_msg      text;
  v_refused  boolean := false;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
     WHERE NOT t.tgisinternal
       AND t.tgrelid = 'public.accounting_cash_accrual_cutover'::regclass
       AND t.tgname = 'ca_cash_cutover_is_week_aligned'
       AND t.tgenabled IN ('O', 'A')
  ) THEN
    RAISE EXCEPTION 'postcondition: ca_cash_cutover_is_week_aligned is not installed and enabled';
  END IF;

  -- The observer agrees with the outage this was written from: the instant
  -- actually installed does split its week.
  SELECT * INTO v FROM public.fn_ca_cash_cutover_week_split_by(v_now);
  IF NOT v.splits THEN
    RAISE EXCEPTION 'postcondition: the observer reports the installed cutover % aligns with week %, which contradicts the fourteen hours of failures this migration was written from', v_now, v.week_start;
  END IF;

  -- Arming a split instant is refused, and refused by THIS guard: the message
  -- is the one it raises, not a primary key violation.
  BEGIN
    INSERT INTO public.accounting_cash_accrual_cutover(singleton, starts_at)
    VALUES (true, public.fn_union_week_start(now()) + interval '3 days');
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_refused := true;
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'postcondition: the guard allowed a cutover to be armed mid-week';
  END IF;
  IF v_msg NOT LIKE '%would split the union week%' THEN
    RAISE EXCEPTION 'postcondition: the insert was refused by something other than this guard: %', v_msg;
  END IF;

  -- ...and it is not merely refusing everything. A real week boundary splits
  -- nothing, which is the instant the guard is telling operators to use.
  SELECT * INTO v FROM public.fn_ca_cash_cutover_week_split_by(public.fn_union_week_start(now()));
  IF v.splits OR v.orphaned_hours <> 0 THEN
    RAISE EXCEPTION 'postcondition: the observer reports a union week boundary splits a week, so it refuses every instant';
  END IF;

  IF (SELECT starts_at FROM public.accounting_cash_accrual_cutover WHERE singleton) IS DISTINCT FROM v_now THEN
    RAISE EXCEPTION 'postcondition: the cutover instant moved during verification';
  END IF;
END
$post$;

COMMIT;
