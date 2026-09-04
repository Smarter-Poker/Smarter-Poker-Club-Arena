-- 20260904224030_the_horse_data_ledger_is_an_admin_console_allowlisted.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The Telemetry Exposure check ("No unscoped definer answers a browser") went
-- red on every pull request on 2026-09-04 22:30 UTC because
-- public.ca_horse_data_ledger(p_day date) - created by the Horse Data Ledger
-- work (commit c5a96df1f, migration 20260904200000, applied to production
-- ahead of its merge) - is SECURITY DEFINER and executable by anon and
-- authenticated. The check reads production, so it fails for EVERY branch,
-- mine included, until the exposure is decided.
--
-- Read before deciding (10.9 rule 1): the function's first statement is
--   if not fn_is_horse_admin() then raise exception 'admin only';
-- so it DOES look at who is calling - it is the same family as
-- ca_brain_telemetry, ca_horse_daily_audit, ca_horse_review_summary and
-- ca_horse_tag_trends, all of which are read from the horse pages in the
-- browser and are already recorded in ca_browser_definer_allowlist with that
-- reason. Revoking it would break the console the other branch is building;
-- recording the decision is what the checker asks for.
--
-- Data only (one INSERT into the allowlist). No DDL, no schema-cache reload.

BEGIN;

INSERT INTO public.ca_browser_definer_allowlist (proname, reason)
VALUES (
  'ca_horse_data_ledger',
  'Horse data ledger console, read from the horse pages. Gates itself on fn_is_horse_admin() before returning a row, like the other ca_horse_* console functions.'
)
ON CONFLICT (proname) DO NOTHING;

COMMIT;
