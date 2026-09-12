-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260911230657; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260911230657   (the stamp IS the apply time, UTC: 2026-09-11 23:06:57)
--   name        an_arena_table_is_governed_by_the_diamond_boundary_not_a_cluster
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 1280 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260911230657 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     CONSTRAINT     tables_cash_needs_a_game on public.tables

--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

ALTER TABLE public.tables DROP CONSTRAINT IF EXISTS tables_cash_needs_a_game;

ALTER TABLE public.tables ADD CONSTRAINT tables_cash_needs_a_game CHECK (
  tournament_id IS NOT NULL
  OR cluster_id IS NOT NULL
  OR status = ANY (ARRAY['closed'::text, 'deleted'::text])
  OR COALESCE(is_deleted, false)
  OR club_id IS NULL
  OR game_variant IS NULL
  OR COALESCE(small_blind, 0::numeric) <= 0::numeric
  OR COALESCE(big_blind, 0::numeric) <= COALESCE(small_blind, 0::numeric)
  -- The platform Diamond arena. Governed by the Diamond boundary, run on
  -- demand by ensureCashTableEngine, and never by the cluster controller.
  OR club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid
) NOT VALID;

ALTER TABLE public.tables VALIDATE CONSTRAINT tables_cash_needs_a_game;

COMMENT ON CONSTRAINT tables_cash_needs_a_game ON public.tables IS
  'Gate 7: an open cash table must be owned by a tournament or a cluster, so '
  'the cluster rules cannot stop at it. The platform Diamond arena is exempt '
  'because the Diamond boundary refuses every one of those rules outright and '
  'replaces them with a stricter check applied at load, at every settings '
  'refresh, at admission and at settlement; its tables are a fixed staff ladder '
  'woken on demand by ensureCashTableEngine.';
