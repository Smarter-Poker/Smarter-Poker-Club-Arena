-- 20260927224816_the_archive_keeps_no_sentry_cap.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  THE ARCHIVE KEEPS NO SENTRY CAP
-- ===========================================================================
--
-- 20260927212653_the_database_keeps_nothing_of_sentry.sql (#5483) removes
-- every catalog object that named Sentry. One row of DATA still did, and a
-- catalog sweep cannot see a row: ca_archive.autofix_budget, the archived
-- per-loop daily spend caps of the retired autofix pipeline, held three rows
-- read 2026-09-27 22:40 UTC:
--
--   source    daily_cap_usd  notes
--   _global   1.6000         Hard global cap across both loops.
--   sentry    1.0000         Sentry runtime-error autofix.
--   vercel    0.6000         Vercel build-failure autofix.
--
-- The 'sentry' row is the configuration of a provider whose account was
-- deleted on 2026-09-27. It is not a record of anything that happened, so it
-- is deleted rather than kept as history. The table, its _global row and its
-- vercel row stay: the Vercel build-failure loop was never Sentry's. Nothing
-- reads the table (its RPC autofix_budget_exhausted was retired with the
-- autopilot; pg_proc holds no function named autofix, checked the same day),
-- and ca_archive.autofix_projects carries no Sentry row.
--
-- No DDL: nothing here reloads the PostgREST schema cache. It is still one
-- transaction with a lock timeout, and it refuses to run against a table
-- that is not the one that was read. It does not depend on 20260927212653
-- and may be applied before or after it.
--
-- Law: tests/the-database-keeps-nothing-of-sentry.law.test.ts
--
-- @live-proof: NOT EXISTS (SELECT 1 FROM ca_archive.autofix_budget WHERE source ILIKE '%sentry%' OR notes ILIKE '%sentry%')

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regclass('ca_archive.autofix_budget') IS NULL
     OR (SELECT count(*) FROM ca_archive.autofix_budget) <> 3
     OR (SELECT count(*) FROM ca_archive.autofix_budget
          WHERE source = 'sentry' AND daily_cap_usd = 1.0000
            AND notes = 'Sentry runtime-error autofix.') <> 1
     OR (SELECT count(*) FROM ca_archive.autofix_budget
          WHERE source IN ('_global', 'vercel')) <> 2 THEN
    RAISE EXCEPTION 'PREIMAGE: ca_archive.autofix_budget is not the three-row table read 2026-09-27';
  END IF;
END
$pre$;

DELETE FROM ca_archive.autofix_budget WHERE source = 'sentry';

DO $post$
BEGIN
  IF (SELECT count(*) FROM ca_archive.autofix_budget) <> 2
     OR EXISTS (SELECT 1 FROM ca_archive.autofix_budget
                 WHERE source ILIKE '%sentry%' OR notes ILIKE '%sentry%')
     OR EXISTS (SELECT 1 FROM ca_archive.autofix_projects
                 WHERE source ILIKE '%sentry%' OR name ILIKE '%sentry%'
                    OR coalesce(notes, '') ILIKE '%sentry%') THEN
    RAISE EXCEPTION 'POSTIMAGE: the autofix archive still names Sentry';
  END IF;
END
$post$;

COMMIT;
