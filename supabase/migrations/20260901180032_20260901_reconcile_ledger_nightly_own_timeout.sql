-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901180032; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

BEGIN;

-- reconcile_ledger_nightly() has been failing HTTP 500 on most nights since
-- at least 2026-08-24 (4 of its last 8 scheduled runs: 08-24, 08-27, 08-29,
-- 08-30, 08-31 - durations 8.6s / 11.5s / 8.9s / 13.4s, i.e. the caller's
-- statement timeout, not a logic error). Reproduced by hand 2026-09-01:
--
--   ERROR: 57014 canceling statement due to statement timeout
--   CONTEXT: SQL function "fn_bomb_pot_ledger_gaps" statement 1
--            PL/pgSQL function reconcile_ledger_nightly() line 203
--
-- The bomb-pot ledger-gap scan added to the reconciler now costs more than the
-- service_role statement_timeout that CLAUDE.md section 2 deliberately pins at
-- 8s. That pin is correct and is NOT touched here: the timeout is widened for
-- this one SECURITY DEFINER function only, which is the narrowest change that
-- lets the nightly reconciliation finish. Run by hand at 2026-09-01 17:41 UTC
-- with a 600s timeout it completed in well under a minute and returned
-- total_checked=20, ok=19, warn=0, critical=1.
--
-- Consequence of leaving it broken: the one job that reports chip drift had
-- not produced a reading since 2026-08-28, so nothing was watching the ledger
-- during the 2026-08-31 -> 09-01 cron outage either.
ALTER FUNCTION public.reconcile_ledger_nightly() SET statement_timeout = '300s';

COMMIT;
