-- 20260919184835_stakes_follows_its_own_blinds_on_update_not_only_on_insert
--
-- Applied to production as version 20260919184450 (the apply transport stamps
-- its own version; match by name, never by version).
--
-- READ WITH ITS PAIR: 20260919184755, which closes the INSERT path. This one
-- closes UPDATE, and UPDATE is where the drift actually came from.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- Its pair closed a hole in fn_tournament_table_inherits_committed_blinds so
-- that a tournament table whose tournament has no committed blind level still
-- derives stakes from its own blinds instead of trusting the caller.
--
-- It did not fix the live drift, and a BEHAVIOURAL PROBE is what proved that.
-- Every structural assertion in that migration passed. Then an UPDATE was run
-- against a real row from an ended tournament, writing the deliberately wrong
-- value 'PROBE/WRONG', and the value was still 'PROBE/WRONG' afterwards:
--
--   PROBE FAILED: trigger did not normalise; stakes is still PROBE/WRONG
--
-- The reason:
--
--   CREATE TRIGGER tournament_table_inherits_committed_blinds
--     BEFORE INSERT ON public.tables FOR EACH ROW ...
--
-- BEFORE INSERT. Not UPDATE. The authority over this column has only ever run
-- when a row is born. Every later write of small_blind, big_blind or stakes
-- has been unconstrained, which is why 40,998 of 265,022 tournament tables
-- (15.5%) carry a stakes that contradicts their own blinds, and why a cron job
-- running EVERY MINUTE has been the only thing holding the invariant.
--
-- A guard that notices was standing in for a design that cannot break, and the
-- design was half-wired: right function, wrong set of events.
--
-- ===========================================================================
-- WHY A SECOND TRIGGER AND NOT `BEFORE INSERT OR UPDATE` ON THE EXISTING ONE
--
-- The existing function exists to INHERIT A COMMITTED BLIND LEVEL. To do that
-- it reads public.tournaments FOR SHARE. Adding UPDATE to it would take a
-- share lock on the tournament row on every update of small_blind, big_blind
-- or stakes, including the minutely reconciler's own writes and every write
-- made by fn_publish_tournament_blind_level while it is already updating that
-- same tournament. That is new lock traffic on the hottest table in the
-- estate, which 194 live tables are being dealt from, to maintain a display
-- string.
--
-- Keeping the display string true to the row's own blinds does not need the
-- tournament at all. So this is a separate, lock-free trigger with one job,
-- not a widening of a trigger whose job is something else. The two do not
-- overlap: the existing one runs on INSERT, this one on UPDATE.
--
-- It is named to sort after every existing BEFORE UPDATE trigger on this table
-- (the last is zzzzz_table_parent_keys_guard), so it reads whatever blinds the
-- other triggers have settled on rather than a value one of them later changes.
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- On UPDATE OF (small_blind, big_blind, stakes), for tournament tables only,
-- stakes is derived from the row's own blinds. Cash tables are excluded twice,
-- in the WHEN clause and again in the function body, because they use a
-- different format (fn_cash_stakes_label) and 1,090 of them carry a
-- '$0.05/$0.10' form this expression would destroy.
--
-- After this, a stakes that disagrees with its row's blinds is unrepresentable
-- for a tournament table on either INSERT or UPDATE, whatever any of the five
-- writers passes.
--
-- VERIFIED LIVE. The same probe that failed before this migration was re-run
-- after it, independently of the migration transaction, and passed: a row
-- written as 'PROBE/WRONG' came back as its own blinds. Mismatched rows went
-- 40,998 -> 40,996 (the two probe rows corrected themselves on write) and all
-- 1,017 cash rows carrying a '$' form were still intact.
--
-- ONE DIFFERENCE FROM THE APPLIED TEXT, DELIBERATE. The version applied to
-- production raised if it could not find a probe row, because production has
-- 40,998 of them and their absence would have meant the query was wrong. A
-- fresh rebuild has no rows at all, so here the behavioural probes SKIP when
-- there is no data and still fail loudly when data exists and the trigger does
-- not hold. An empty database cannot prove a behaviour; it must not claim to.
--
-- NOT DONE HERE, ON PURPOSE: the 40,996 historical rows are not corrected, and
-- branch 2 of fn_reconcile_tournament_denormals is NOT removed. Phase 3.3 of
-- the standing brief requires observing the compensation find zero work for a
-- full cycle before deleting it. It stays, doing nothing, until then.
--
-- @live-proof: (SELECT position('UPDATE OF small_blind, big_blind, stakes' in pg_get_triggerdef(t.oid)) > 0 FROM pg_trigger t WHERE t.tgrelid = 'public.tables'::regclass AND t.tgname = 'zzzzzz_tables_stakes_follows_its_own_blinds')
-- ===========================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.fn_tables_stakes_follows_its_own_blinds()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Cash tables label themselves through fn_cash_stakes_label and are not
  -- this trigger's business. Excluded here as well as in the WHEN clause so
  -- the body is safe if the trigger is ever recreated without one.
  IF NEW.tournament_id IS NULL THEN RETURN NEW; END IF;

  IF NEW.small_blind IS NOT NULL AND NEW.big_blind IS NOT NULL THEN
    NEW.stakes := trim_scale(NEW.small_blind)::text||'/'||trim_scale(NEW.big_blind)::text;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.fn_tables_stakes_follows_its_own_blinds() IS
  'Keeps public.tables.stakes equal to trim_scale(small_blind)/trim_scale(big_blind) for tournament tables on UPDATE. The INSERT side is fn_tournament_table_inherits_committed_blinds, which was BEFORE INSERT only, which is why a minutely cron UPDATE was maintaining this column. Deliberately does not read public.tournaments: the value is a function of the row itself, and a lookup here would add a FOR SHARE lock to every blind write.';

DROP TRIGGER IF EXISTS zzzzzz_tables_stakes_follows_its_own_blinds ON public.tables;

CREATE TRIGGER zzzzzz_tables_stakes_follows_its_own_blinds
  BEFORE UPDATE OF small_blind, big_blind, stakes ON public.tables
  FOR EACH ROW
  WHEN (
    NEW.tournament_id IS NOT NULL
    AND (OLD.small_blind IS DISTINCT FROM NEW.small_blind
      OR OLD.big_blind   IS DISTINCT FROM NEW.big_blind
      OR OLD.stakes      IS DISTINCT FROM NEW.stakes)
  )
  EXECUTE FUNCTION public.fn_tables_stakes_follows_its_own_blinds();

DO $verify$
DECLARE
  v_id uuid; v_sb numeric; v_bb numeric; v_expect text; v_after text;
  v_cash_id uuid; v_cash_before text; v_cash_after text;
  v_def text;
BEGIN
  ---------------------------------------------------------------------------
  -- POSITIVE, BEHAVIOURAL. The same probe that failed before this migration.
  -- Skipped only when the database has no tournament tables at all.
  ---------------------------------------------------------------------------
  SELECT tb.id, tb.small_blind, tb.big_blind
    INTO v_id, v_sb, v_bb
    FROM public.tables tb
    JOIN public.tournaments t ON t.id = tb.tournament_id
   WHERE t.status IN ('COMPLETED','CANCELLED')
     AND tb.small_blind IS NOT NULL AND tb.big_blind IS NOT NULL
   LIMIT 1;

  IF v_id IS NULL THEN
    RAISE NOTICE 'no tournament table present; behavioural probe skipped (empty rebuild)';
  ELSE
    v_expect := trim_scale(v_sb)::text||'/'||trim_scale(v_bb)::text;
    UPDATE public.tables SET stakes = 'PROBE/WRONG' WHERE id = v_id;
    SELECT stakes INTO v_after FROM public.tables WHERE id = v_id;

    IF v_after <> v_expect THEN
      RAISE EXCEPTION 'failed: UPDATE probe left stakes as %, expected % (row %)', v_after, v_expect, v_id;
    END IF;
  END IF;

  ---------------------------------------------------------------------------
  -- NEGATIVE. Normalising everything would also pass the probe above and
  -- would rewrite 7,685 cash tables. A cash row must be left exactly as
  -- written. Restored before this block ends.
  ---------------------------------------------------------------------------
  SELECT id, stakes INTO v_cash_id, v_cash_before
    FROM public.tables
   WHERE tournament_id IS NULL
     AND small_blind IS NOT NULL AND big_blind IS NOT NULL
   LIMIT 1;

  IF v_cash_id IS NULL THEN
    RAISE NOTICE 'no cash table present; cash probe skipped (empty rebuild)';
  ELSE
    UPDATE public.tables SET stakes = 'CASH/UNTOUCHED' WHERE id = v_cash_id;
    SELECT stakes INTO v_cash_after FROM public.tables WHERE id = v_cash_id;
    IF v_cash_after IS DISTINCT FROM 'CASH/UNTOUCHED' THEN
      RAISE EXCEPTION 'failed: a cash table was rewritten to %, so cash stakes are not safe', v_cash_after;
    END IF;
    UPDATE public.tables SET stakes = v_cash_before WHERE id = v_cash_id;
  END IF;

  ---------------------------------------------------------------------------
  -- STRUCTURAL: the column list and the cash exclusion are actually on the
  -- trigger, not just in the body. These hold on an empty database too.
  ---------------------------------------------------------------------------
  SELECT pg_get_triggerdef(t.oid) INTO v_def
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tables'::regclass
     AND t.tgname = 'zzzzzz_tables_stakes_follows_its_own_blinds';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'failed: the trigger was not created';
  END IF;
  IF position('UPDATE OF small_blind, big_blind, stakes' in v_def) = 0 THEN
    RAISE EXCEPTION 'failed: the trigger is not scoped to the blind columns: %', v_def;
  END IF;
  IF position('tournament_id IS NOT NULL' in v_def) = 0 THEN
    RAISE EXCEPTION 'failed: the cash exclusion is missing from the WHEN clause: %', v_def;
  END IF;

  RAISE NOTICE 'stakes follows its own blinds on UPDATE; cash left as written';
END
$verify$;

COMMIT;
