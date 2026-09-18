-- 20260918064540_the_fee_cutover_cannot_strand_a_game_it_did_not_witness.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE FEE CUTOVER CANNOT STRAND A GAME IT DID NOT WITNESS.
--
-- WHAT WENT WRONG (measured on production 2026-09-18)
--
-- The accounting_tournament_fee_cutover row was inserted at 2026-09-17
-- 18:24:02.831517+00 while tournaments were in flight. From that instant every
-- tournament entry fee must carry contributor evidence, and
-- fn_capture_accounting_tournament_fee refuses any contributor charged before
-- it. The 550 tournaments that had already charged their fees could therefore
-- never produce a batch, fn_accounting_tournament_fee_net_plan refused them
-- with tournament_fee_sources_require_reconciliation, fn_settle_tournament_rake
-- turned that refusal fatal because its own net counted the unwitnessed fees,
-- and the events froze: decided by the cards, winners unpaid, 1,901 horse
-- entries seated in games that could not end. Twelve hours later the engine had
-- logged 1,491 finish refusals and raised a critical money alert for each one.
--
-- A cutover is a promise that every fee after it can be witnessed. Arming one
-- over games whose fees were already charged makes that promise about the past,
-- which is the one thing it cannot keep.
--
-- WHY THE HOLE WAS EXACTLY HERE
--
-- The row is already well defended in every direction but one.
-- accounting_tournament_fee_cutover_immutable refuses UPDATE and DELETE,
-- accounting_tournament_fee_cutover_no_truncate refuses TRUNCATE, and
-- PRIMARY KEY (singleton) with CHECK (singleton) allows exactly one row. So the
-- instant can never move once chosen -- and nothing checked it when it was
-- chosen. INSERT was the whole unguarded surface, and INSERT is how this
-- happened.
--
-- WHAT THIS CHANGES
--
-- The cutover may not be armed at an instant that would strand a live game.
-- Draining comes first, in the database, for every agent and every release
-- path. The refusal names the tournament count, the fee count and the oldest
-- offender, so it says what to drain rather than only that something is wrong.
--
-- It does not repair the games already stranded; their fees are attributable
-- and that reconciliation belongs with the functions that own it. This is the
-- reason it can never be needed a second time.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS. The table is the one this migration reviewed, its existing
--    defences are the ones this guard is sized against, and it is not already
--    guarded.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_cols text;
  v_trgs text;
BEGIN
  SELECT string_agg(column_name, ',' ORDER BY ordinal_position) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'accounting_tournament_fee_cutover';
  IF v_cols IS DISTINCT FROM 'singleton,starts_at' THEN
    RAISE EXCEPTION 'precondition: accounting_tournament_fee_cutover is not (singleton, starts_at) but (%)', v_cols;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.accounting_tournament_fee_cutover WHERE singleton) THEN
    RAISE EXCEPTION 'precondition: the cutover singleton row is missing';
  END IF;

  -- The existing defences this guard completes rather than duplicates.
  SELECT string_agg(t.tgname, ',' ORDER BY t.tgname) INTO v_trgs
    FROM pg_catalog.pg_trigger t
   WHERE NOT t.tgisinternal AND t.tgrelid = 'public.accounting_tournament_fee_cutover'::regclass;
  IF v_trgs IS DISTINCT FROM 'accounting_tournament_fee_cutover_immutable,accounting_tournament_fee_cutover_no_truncate' THEN
    RAISE EXCEPTION 'precondition: the cutover row carries triggers (%), not the immutable/no_truncate pair this guard was sized against', v_trgs;
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. WOULD THIS INSTANT STRAND A LIVE GAME?
--
--    A tournament is stranded by instant X when it is still live and holds a
--    positive entry fee charged before X with no captured batch: the capture
--    path refuses a contributor charged before the cutover, so that fee can
--    never be witnessed and the tournament can never settle.
--
--    STABLE, not IMMUTABLE: it reads live rows on purpose. SECURITY DEFINER so
--    the guard answers the same way for every writer, and EXECUTE is granted to
--    nobody - only the trigger below calls it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_fee_cutover_stranded_by(p_starts_at timestamptz)
RETURNS TABLE(stranded_tournaments integer, stranded_fees integer,
              oldest_fee_at timestamptz, oldest_tournament uuid)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $stranded$
  WITH live AS (
    SELECT rr.id, rr.tournament_id, rr.created_at
      FROM public.rake_records rr
      JOIN public.tournaments t ON t.id = rr.tournament_id
      LEFT JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id = rr.id
     WHERE rr.is_tournament
       AND rr.rake_amount > 0
       AND upper(COALESCE(t.status::text, '')) IN ('RUNNING', 'BREAK', 'REGISTERING', 'COMPLETING')
       AND rr.created_at < p_starts_at
       AND b.status IS DISTINCT FROM 'captured'
  )
  SELECT COALESCE(count(DISTINCT tournament_id), 0)::int,
         COALESCE(count(*), 0)::int,
         min(created_at),
         (SELECT l.tournament_id FROM live l ORDER BY l.created_at, l.id LIMIT 1)
    FROM live;
$stranded$;

REVOKE ALL ON FUNCTION public.fn_ca_fee_cutover_stranded_by(timestamptz) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fn_ca_fee_cutover_stranded_by(timestamptz) IS
  'How many live tournaments a fee-evidence cutover armed at this instant would strand: they hold a positive entry fee charged before it with no captured batch, so their fee can never be witnessed and they can never settle. Read by ca_fee_cutover_is_drained before the cutover may be armed.';

-- ---------------------------------------------------------------------------
-- 2. THE GUARD, ON THE ONE OPERATION THE ROW DID NOT ALREADY REFUSE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_guard_fee_cutover_is_drained()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $guard$
DECLARE
  v record;
BEGIN
  IF NEW.starts_at IS NULL OR NOT isfinite(NEW.starts_at) THEN
    RAISE EXCEPTION 'the accounting fee cutover needs a finite instant' USING ERRCODE = '22007';
  END IF;

  SELECT * INTO v FROM public.fn_ca_fee_cutover_stranded_by(NEW.starts_at);

  IF COALESCE(v.stranded_tournaments, 0) > 0 THEN
    RAISE EXCEPTION
      'fee cutover % would strand % live tournament(s) holding % unwitnessed fee(s); oldest is tournament % charged %. Drain or reconcile them first.',
      NEW.starts_at, v.stranded_tournaments, v.stranded_fees, v.oldest_tournament, v.oldest_fee_at
      USING ERRCODE = '55000',
            HINT = 'A cutover promises every fee after it can be witnessed. It cannot make that promise about fees already charged.';
  END IF;

  RETURN NEW;
END
$guard$;

REVOKE ALL ON FUNCTION public.fn_ca_guard_fee_cutover_is_drained() FROM PUBLIC, anon, authenticated;

-- INSERT only. accounting_tournament_fee_cutover_immutable already refuses
-- UPDATE and DELETE and accounting_tournament_fee_cutover_no_truncate refuses
-- TRUNCATE, so arming the row is the whole remaining surface. A BEFORE ROW
-- trigger runs before the primary key is checked, which is what lets this
-- refusal be the one an operator sees.
CREATE TRIGGER ca_fee_cutover_is_drained
  BEFORE INSERT ON public.accounting_tournament_fee_cutover
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_guard_fee_cutover_is_drained();

COMMENT ON TRIGGER ca_fee_cutover_is_drained ON public.accounting_tournament_fee_cutover IS
  'The cutover may not be armed at an instant that would strand a live tournament holding a fee charged before it. On 2026-09-17 arming it over 550 in-flight tournaments froze every one of them with its winner unpaid.';

-- ---------------------------------------------------------------------------
-- 3. POSTCONDITIONS. The guard exists, it refuses the instant that caused the
--    freeze, and it is not merely refusing everything.
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  v_now timestamptz := (SELECT starts_at FROM public.accounting_tournament_fee_cutover WHERE singleton);
  v record;
  v_msg text;
  v_refused boolean := false;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
     WHERE NOT t.tgisinternal
       AND t.tgrelid = 'public.accounting_tournament_fee_cutover'::regclass
       AND t.tgname = 'ca_fee_cutover_is_drained'
       AND t.tgenabled IN ('O', 'A')
  ) THEN
    RAISE EXCEPTION 'postcondition: ca_fee_cutover_is_drained is not installed and enabled';
  END IF;

  -- The observer still sees the backlog this migration was written from.
  SELECT * INTO v FROM public.fn_ca_fee_cutover_stranded_by(v_now);
  IF COALESCE(v.stranded_tournaments, 0) <= 0 THEN
    RAISE EXCEPTION 'postcondition: the observer reports no stranded tournament at the installed cutover, which contradicts the measurement this migration was written from';
  END IF;

  -- Arming today's instant over today's backlog is refused, and refused by
  -- THIS guard: the message is the one it raises, not a key violation.
  BEGIN
    INSERT INTO public.accounting_tournament_fee_cutover(singleton, starts_at) VALUES (true, now());
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_refused := true;
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'postcondition: the guard allowed a cutover to be armed over a live backlog';
  END IF;
  IF v_msg NOT LIKE '%would strand%' THEN
    RAISE EXCEPTION 'postcondition: the insert was refused by something other than this guard: %', v_msg;
  END IF;

  -- ...and it is not merely refusing everything. An instant at or before the
  -- oldest fee on the platform strands nothing, because nothing precedes it.
  SELECT * INTO v FROM public.fn_ca_fee_cutover_stranded_by(
    (SELECT min(rr.created_at) FROM public.rake_records rr
      WHERE rr.is_tournament AND rr.rake_amount > 0));
  IF COALESCE(v.stranded_tournaments, 0) <> 0 THEN
    RAISE EXCEPTION 'postcondition: the observer reports % stranded tournament(s) at an instant nothing precedes, so it refuses every instant', v.stranded_tournaments;
  END IF;

  IF (SELECT starts_at FROM public.accounting_tournament_fee_cutover WHERE singleton) IS DISTINCT FROM v_now THEN
    RAISE EXCEPTION 'postcondition: the cutover instant moved during verification';
  END IF;
END
$post$;

COMMIT;
