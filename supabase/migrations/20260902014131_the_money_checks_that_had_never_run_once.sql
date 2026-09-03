-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902014131; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- SIX MONEY-INTEGRITY CHECKS, ZERO RUNS BETWEEN THEM
--
-- fn_money_check_health keeps a registry of the checks that guard money, each
-- with an expected cadence, and raises a CRITICAL when one goes stale. It is
-- raising six right now, all saying the same thing: runs = 0, last_run_at =
-- null. Not late. Never run, not once.
--
--   fn_pay_backed_payout_shortfalls   60m   pays what an event still owes
--                                           when the event holds the chips
--   fn_payout_guarantee_check         60m   vacant paid places, unpaid
--                                           earners, retained bounty pools
--   fn_cash_pot_conservation_check    60m   pot = rake + bbj + awarded, on
--                                           every completed cash hand
--   fn_detect_results_without_a_hand 360m   a result no poker produced
--
-- (fn_backpay_unfinalised_bounty_pools and fn_tournament_money_conservation
-- are already on cron - the first because I scheduled it earlier tonight.)
--
-- Every function exists and works. Nobody ever wired them to a schedule. This
-- is the fourth time tonight the same shape has turned up - unscheduled
-- ratchets, an unscheduled rake redrive, an unscheduled bounty backpay - and
-- it is the most expensive one, because fn_payout_guarantee_check is precisely
-- the check that would have caught the six unfunded guarantees, and
-- fn_cash_pot_conservation_check is precisely the one that would have caught
-- the rake being banked twice. Both defects ran for days in front of detectors
-- that were never switched on.
--
-- Cadences are taken from the registry itself rather than invented, and the
-- minutes are staggered so four money sweeps do not start in the same second.
-- ═══════════════════════════════════════════════════════════════════════════

SELECT cron.schedule('ca-payout-guarantee-check-hourly', '18 * * * *',
  $$ SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-payout-guarantee-check'))
       THEN (SELECT count(*)::int FROM public.fn_payout_guarantee_check()) ELSE -1 END; $$);

SELECT cron.schedule('ca-pay-backed-payout-shortfalls-hourly', '26 * * * *',
  $$ SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-pay-backed-payout-shortfalls'))
       THEN (public.fn_pay_backed_payout_shortfalls())::text ELSE 'locked' END; $$);

SELECT cron.schedule('ca-cash-pot-conservation-hourly', '34 * * * *',
  $$ SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-cash-pot-conservation'))
       THEN (SELECT count(*)::int FROM public.fn_cash_pot_conservation_check()) ELSE -1 END; $$);

SELECT cron.schedule('ca-results-without-a-hand-6h', '46 */6 * * *',
  $$ SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-results-without-a-hand'))
       THEN (SELECT count(*)::int FROM public.fn_detect_results_without_a_hand()) ELSE -1 END; $$);

