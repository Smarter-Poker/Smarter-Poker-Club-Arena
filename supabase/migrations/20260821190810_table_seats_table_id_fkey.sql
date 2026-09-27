-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821190810 "table_seats_table_id_fkey"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5790374723ceae63aa3953a11b2c6f1a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  table_seats.table_id -> tables.id
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Found 2026-08-21 by watching the console on a real signed-in load of
-- /hub/club-arena:
--
--   400  /rest/v1/table_seats?select=...,tables:table_id(id,name,...)
--   PGRST200: Searched for a foreign key relationship between 'table_seats'
--             and 'tables' in the schema 'public', but no matches were found.
--
-- table_seats had exactly ONE foreign key, to clubs. The column every seat is
-- keyed by -- table_id -- had none, so PostgREST refused to embed the parent
-- row and every query using that embed returned 400 instead of data.
--
-- Three call sites use it, and one of them is not a corner case:
--
--   components/tournament/TournamentAutoSeat.tsx  mounted in App.tsx, so it
--     runs on EVERY page load. Auto-seating a player into a tournament that
--     has started could therefore never work: the check that finds their seat
--     always failed.
--   components/modals/FindPlayerModal.tsx         "where is this player"
--   components/gameplay/HandReplayViewer.tsx      table name on a replay
--
-- All three are fixed by the constraint rather than by rewriting each query
-- into two round trips, because the relationship is real and simply was not
-- declared: 47,273 seat rows, ZERO of them orphaned, asserted below before the
-- constraint is added.
--
-- ON DELETE CASCADE matches how seats already behave: closing a table is
-- supposed to take its seats with it, and orphaned seats are the exact defect
-- that stranded players earlier in this project.

DO $do$
DECLARE v_orphans bigint;
BEGIN
  SELECT count(*) INTO v_orphans
    FROM public.table_seats s
    LEFT JOIN public.tables t ON t.id = s.table_id
   WHERE t.id IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION
      'ABORT: % table_seats rows reference a table that does not exist. Clean them up before adding this constraint.', v_orphans;
  END IF;
END $do$;

ALTER TABLE public.table_seats
  ADD CONSTRAINT table_seats_table_id_fkey
  FOREIGN KEY (table_id) REFERENCES public.tables(id) ON DELETE CASCADE;

COMMENT ON CONSTRAINT table_seats_table_id_fkey ON public.table_seats IS
  'Declares the seat->table relationship. Also what lets PostgREST embed '
  'tables:table_id(...); without it those selects return PGRST200 / 400.';

-- ═══════════════════════════════════════════════════════════════════════════
--  ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
--   ALTER TABLE public.table_seats DROP CONSTRAINT table_seats_table_id_fkey;
-- Note that dropping it re-breaks the three embeds above.
