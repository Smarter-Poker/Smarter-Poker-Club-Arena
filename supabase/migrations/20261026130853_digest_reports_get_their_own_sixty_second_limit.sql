-- 20261026130853_digest_reports_get_their_own_sixty_second_limit.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The Smarter.Poker Daily Operations Digest for 2026-10-25 was never sent.
-- sp_daily_digest_runs records all three 7 AM Central tries (12:00, 12:20,
-- 12:40 UTC on 2026-10-26) as failed with
--   "fn_sp_daily_digest: canceling statement due to statement timeout".
-- The digest route calls fn_sp_daily_digest and fn_sp_digest_player_totals
-- through PostgREST as service_role, whose statement_timeout is 8s (CLAUDE.md
-- section 2, production DDL policy - deliberately left unchanged here).
--
-- Measured on production 2026-10-26 ~13:05 UTC for day 2026-10-25:
--   first (cold) run of fn_sp_daily_digest: 23,058 ms
--   warm runs: fn_sp_daily_digest 2,859-5,285 ms, fn_sp_digest_player_totals 2,426 ms
--   pg_stat_statements, PostgREST calls of the digest: mean 2,764 ms, max 5,630 ms
-- At 7 AM the pages are cold, and since #2568 (2026-10-26 05:32 UTC) the two
-- functions run in parallel and compete for the same reads, so the cold run
-- crosses 8s and every retry in the hour is cancelled.
--
-- THE FIX: each of the two report functions carries its own
-- statement_timeout of 60s. PostgREST (12.2+) hoists a function's own
-- statement_timeout and applies it to that call's transaction only, so these
-- two RPCs get 60s and every other service_role call keeps 8s. The route's
-- own budget is maxDuration 300s, so 60s per call fits.
--
-- KEEP IT: CREATE OR REPLACE FUNCTION replaces proconfig with only the SET
-- clauses it lists. Any later redefinition of either function must keep
--   SET statement_timeout TO '60s'
-- beside its search_path, or this outage comes back on the next cold morning.
--
-- No data is written. Execute grants are unchanged. No money path is touched.
-- Rollback: ALTER FUNCTION ... RESET statement_timeout on both.
--
-- @live-proof: (SELECT count(*)=2 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('fn_sp_daily_digest','fn_sp_digest_player_totals') AND 'statement_timeout=60s' = ANY(proconfig))
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER FUNCTION public.fn_sp_daily_digest(date, boolean) SET statement_timeout TO '60s';
ALTER FUNCTION public.fn_sp_digest_player_totals(date) SET statement_timeout TO '60s';

COMMIT;
