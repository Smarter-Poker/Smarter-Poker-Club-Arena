-- @live-proof: (SELECT reloptions @> ARRAY['fillfactor=85','autovacuum_vacuum_scale_factor=0.02','autovacuum_vacuum_threshold=1000'] FROM pg_class WHERE oid='public.tournament_players'::regclass) AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE '%\_rebuilt') AND (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid='public.tournament_players'::regclass AND i.indisvalid AND c.relname IN ('idx_tournament_players_basis','idx_tournament_players_registered_at','idx_tournament_players_chips','idx_tournament_players_club','idx_tournament_players_status','idx_tourn_players_tourn'))=6
-- 20261015103046_tournament_players_stays_lean.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (phase 8 of the tournament hardening):
--
-- tournament_players is updated on every tournament hand (chips, status,
-- table, seat). Read on production 2026-10-15:
--
--   1,938,588 live rows, 351,830 dead (18.1%), heap 508 MB, indexes 1.4 GB
--   66.1 M updates, 51.5% HOT
--   no reloptions: the default autovacuum scale factor 0.2 waits for about
--   390,000 dead rows, and the last pass was three hours old
--
-- Two causes, both fixed at the root here:
--
-- 1. Every page is filled to 100% on insert (default fillfactor), so an update
--    rarely finds room on its own page and half of them cannot be HOT. A
--    non-HOT update writes a new entry into all 15 indexes. fillfactor 85
--    leaves room on every new page for the row's next versions.
-- 2. Vacuum waits for a fifth of the table to be dead before it reclaims any
--    of it. The table now carries the same kind of settings as tournaments
--    and table_seats: vacuum after 2% plus 1,000 dead rows, analyze likewise,
--    with the faster cost settings those tables use.
--
-- And the bloat already built up is reclaimed online. The six largest plain
-- (non-unique, non-constraint) indexes are rebuilt CONCURRENTLY under a
-- temporary _rebuilt name in the preamble, which never blocks a writer, and
-- then swapped in by name inside the one transaction:
--
--   idx_tournament_players_basis          360 MB
--   idx_tournament_players_registered_at  239 MB
--   idx_tournament_players_chips          130 MB
--   idx_tournament_players_club            99 MB
--   idx_tournament_players_status          98 MB
--   idx_tourn_players_tourn                71 MB
--
-- Each new index must be valid and have exactly the old definition (asserted
-- by comparing pg_get_indexdef with the name swapped) before the old one is
-- dropped. The swap takes a short ACCESS EXCLUSIVE lock per drop under a 2 s
-- lock_timeout: it either completes at once or refuses whole and changes
-- nothing. The two unique partial indexes and the two constraint indexes are
-- left as they are. No row is read into or written by this migration.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
-- The preamble is the installer's admitted CREATE INDEX CONCURRENTLY shape
-- (scripts/ci/migration-concurrent-preamble.mjs).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tournament_players_basis_rebuilt ON public.tournament_players USING btree (tournament_id) INCLUDE (club_id, rebuys, add_on);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tournament_players_registered_at_rebuilt ON public.tournament_players USING btree (registered_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tournament_players_chips_rebuilt ON public.tournament_players USING btree (tournament_id, status, chips);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tournament_players_club_rebuilt ON public.tournament_players USING btree (club_id, tournament_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tournament_players_status_rebuilt ON public.tournament_players USING btree (tournament_id, status);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tourn_players_tourn_rebuilt ON public.tournament_players USING btree (tournament_id);
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

DO $swap$
DECLARE
  names constant text[] := ARRAY['idx_tournament_players_basis', 'idx_tournament_players_registered_at',
                                 'idx_tournament_players_chips', 'idx_tournament_players_club',
                                 'idx_tournament_players_status', 'idx_tourn_players_tourn'];
  n text; old_def text; new_def text; valid boolean;
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres'
     OR NULLIF(current_setting('request.jwt.claims', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'tournament_players_lean_operator_refused' USING ERRCODE = '42501';
  END IF;
  IF public.fn_platform_frozen() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'tournament_players_lean_freeze_refused';
  END IF;
  FOREACH n IN ARRAY names LOOP
    old_def := pg_get_indexdef(to_regclass('public.' || n));
    SELECT pg_get_indexdef(c.oid), i.indisvalid AND i.indisready
      INTO new_def, valid
      FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.oid = to_regclass('public.' || n || '_rebuilt')
       AND i.indrelid = 'public.tournament_players'::regclass;
    IF old_def IS NULL OR new_def IS NULL OR valid IS NOT TRUE THEN
      RAISE EXCEPTION 'tournament_players_lean_index_missing_or_invalid: %', n;
    END IF;
    IF replace(new_def, n || '_rebuilt', n) IS DISTINCT FROM old_def THEN
      RAISE EXCEPTION 'tournament_players_lean_definition_differs: % / %', old_def, new_def;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = to_regclass('public.' || n))
       OR EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.' || n) AND i.indisunique) THEN
      RAISE EXCEPTION 'tournament_players_lean_index_is_a_constraint: %', n;
    END IF;
    EXECUTE format('DROP INDEX public.%I', n);
    EXECUTE format('ALTER INDEX public.%I RENAME TO %I', n || '_rebuilt', n);
  END LOOP;
END
$swap$;

ALTER TABLE public.tournament_players SET (
  fillfactor = 85,
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 1000,
  autovacuum_vacuum_cost_delay = 2,
  autovacuum_vacuum_cost_limit = 2000
);

DO $post$
BEGIN
  IF (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE i.indrelid = 'public.tournament_players'::regclass) <> 15 THEN
    RAISE EXCEPTION 'tournament_players_lean_index_count_changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname LIKE '%\_rebuilt') THEN
    RAISE EXCEPTION 'tournament_players_lean_leftover_index';
  END IF;
END
$post$;

COMMIT;
