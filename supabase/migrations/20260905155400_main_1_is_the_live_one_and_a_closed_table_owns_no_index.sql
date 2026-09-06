-- BACKFILLED 2026-09-05 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905155400; the .sql file was never committed at the
-- time. Content is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. This file is the one sanctioned exception, and
-- the exception is what makes it safe: 20260905155400 IS ALREADY IN
-- supabase_migrations.schema_migrations, recorded under the name
-- `main_1_is_the_live_one_and_a_closed_table_owns_no_index`. Reserving a fresh
-- version would create a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the
-- ledger already holds, or it is not a mirror of anything.
--
-- WHAT IT DOES, AND WHAT PRODUCTION HAS TODAY (read 2026-09-05)
--
-- Two BEFORE triggers on public.tables, both live and both ENABLED ('O'):
--
--   fn_closed_cluster_main_releases_index()  ->  trg_tables_closed_main_releases_index
--       BEFORE INSERT OR UPDATE OF lifecycle, is_deleted
--       nulls main_index when a cluster main is closed or soft-deleted.
--
--   fn_cluster_table_ceiling()               ->  trg_tables_cluster_table_ceiling
--       BEFORE INSERT
--       refuses (RETURN NULL) a table that would take a cluster past
--       cap_mains + 1 + optional second feeder + 2, and logs
--       'table_refused_at_ceiling' into cash_cluster_events.
--
-- pg_get_functiondef and pg_get_triggerdef on production return exactly the
-- bodies below, so the mirror is faithful.
--
-- WHAT THE MIRROR DOES NOT CLAIM
--
-- The original DO $assert$ block below is reproduced because it ran, not
-- because it still holds. The invariant it asserted was true at 15:54 UTC and
-- is not true now: 2,935 closed cluster mains hold a main_index again, every
-- one of them stamped updated_at = 2026-09-05 15:57:38.603261+00 - a single
-- bulk write about three minutes after this migration, which set main_index on
-- rows that were ALREADY closed. `UPDATE OF lifecycle, is_deleted` does not
-- fire for an update that touches neither column, so the trigger never saw it.
-- That is a live defect in whatever performs the renumber pass, it is not a
-- defect in this mirror, and it is recorded here rather than repaired here
-- because this file is repo-only bookkeeping.
--
-- The mirror's own assertion is therefore about the OBJECTS, at the bottom of
-- this file, outside the transaction. It is true today and it fails loudly if
-- the mirror has drifted from the catalogue.
--
-- DO NOT APPLY THIS FILE BY HAND. Re-running it would null main_index on those
-- 2,935 rows, which is a live data change nobody asked this bookkeeping branch
-- to make.
-- ===========================================================================

BEGIN;

-- A. A CLOSED OR DELETED CLUSTER MAIN RELEASES ITS INDEX
-- The renumber pass in fn_cash_cluster_tick walks v_census, and
-- fn_cash_cluster_census EXCLUDES closed tables, so an index survives the
-- table that held it. R3 then reads that corpse (ORDER BY created_at LIMIT 1,
-- no preference for a live row), sees lifecycle='closed', and opens a
-- replacement which the renumber immediately pushes to the end of the list.
-- 2,994 tables in 2.5 hours on NLH 0.05/0.10 Classic, 2026-09-05.
CREATE OR REPLACE FUNCTION public.fn_closed_cluster_main_releases_index()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF NEW.cluster_id IS NOT NULL
     AND NEW.main_index IS NOT NULL
     AND (NEW.lifecycle = 'closed' OR coalesce(NEW.is_deleted, false) = true)
  THEN
    NEW.main_index := NULL;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_tables_closed_main_releases_index ON public.tables;
CREATE TRIGGER trg_tables_closed_main_releases_index
  BEFORE INSERT OR UPDATE OF lifecycle, is_deleted ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.fn_closed_cluster_main_releases_index();

-- B. A CLUSTER MAY NOT EXCEED ITS OWN DECLARED CEILING.
-- R3 sits above the OPEN rule's v_live_tables < v_table_cap check, so the cap
-- never applied to it. Here the cap binds every path that can insert a table.
-- Returns NULL (skip the insert) rather than raising: a raise inside
-- fn_cash_cluster_tick would abort a transaction that also carries seat moves
-- and roster writes, and a refused table must never cost a player a seat.
CREATE OR REPLACE FUNCTION public.fn_cluster_table_ceiling()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_live integer;
  v_ceiling integer;
BEGIN
  IF NEW.cluster_id IS NULL THEN RETURN NEW; END IF;

  SELECT coalesce(g.cap_mains, 8) + 1 + CASE WHEN g.allow_second_feeder THEN 1 ELSE 0 END + 2
    INTO v_ceiling
    FROM public.cash_games g WHERE g.id = NEW.cluster_id;
  IF v_ceiling IS NULL THEN RETURN NEW; END IF;

  SELECT count(*) INTO v_live FROM public.tables t
   WHERE t.cluster_id = NEW.cluster_id
     AND coalesce(t.is_deleted, false) = false
     AND t.lifecycle <> 'closed';

  IF v_live >= v_ceiling THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
    VALUES (NEW.cluster_id, 'table_refused_at_ceiling',
            jsonb_build_object('live', v_live, 'ceiling', v_ceiling,
                               'role', NEW.role, 'main_index', NEW.main_index));
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_tables_cluster_table_ceiling ON public.tables;
CREATE TRIGGER trg_tables_cluster_table_ceiling
  BEFORE INSERT ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.fn_cluster_table_ceiling();

-- THE INDEXES THE CORPSES ARE HOLDING RIGHT NOW, every cluster.
UPDATE public.tables SET main_index = NULL, updated_at = now()
 WHERE cluster_id IS NOT NULL AND role = 'main' AND main_index IS NOT NULL
   AND (lifecycle = 'closed' OR coalesce(is_deleted, false) = true);

DO $assert$
DECLARE v_dupes integer; v_corpses integer;
BEGIN
  SELECT count(*) INTO v_corpses FROM public.tables
   WHERE cluster_id IS NOT NULL AND role = 'main' AND main_index IS NOT NULL
     AND (lifecycle = 'closed' OR coalesce(is_deleted, false) = true);
  IF v_corpses > 0 THEN
    RAISE EXCEPTION 'ABORT: % closed cluster main(s) still hold an index', v_corpses;
  END IF;

  SELECT count(*) INTO v_dupes FROM (
    SELECT cluster_id FROM public.tables
     WHERE cluster_id IS NOT NULL AND role = 'main' AND main_index IS NOT NULL
       AND coalesce(is_deleted, false) = false AND lifecycle <> 'closed'
     GROUP BY cluster_id, main_index HAVING count(*) > 1
  ) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'ABORT: % cluster/index pair(s) still answered by two live tables', v_dupes;
  END IF;
END $assert$;

COMMIT;

-- ===========================================================================
--  THE MIRROR'S OWN ASSERTION (added by the backfill, not part of what ran).
--  Every object 20260905155400 created must be in the catalogue. If any is
--  missing, this file is describing a database that does not exist and the
--  reader must go and find out why before trusting it.
-- ===========================================================================
DO $mirror$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regprocedure('public.fn_closed_cluster_main_releases_index()') IS NULL THEN
    v_missing := v_missing || 'function fn_closed_cluster_main_releases_index()';
  END IF;
  IF to_regprocedure('public.fn_cluster_table_ceiling()') IS NULL THEN
    v_missing := v_missing || 'function fn_cluster_table_ceiling()';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tables'::regclass
       AND tgname = 'trg_tables_closed_main_releases_index'
       AND NOT tgisinternal
  ) THEN
    v_missing := v_missing || 'trigger trg_tables_closed_main_releases_index';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tables'::regclass
       AND tgname = 'trg_tables_cluster_table_ceiling'
       AND NOT tgisinternal
  ) THEN
    v_missing := v_missing || 'trigger trg_tables_cluster_table_ceiling';
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION
      'MIRROR IS WRONG: 20260905155400 is recorded as applied but % is absent: %',
      array_length(v_missing, 1), array_to_string(v_missing, ', ');
  END IF;
END $mirror$;
