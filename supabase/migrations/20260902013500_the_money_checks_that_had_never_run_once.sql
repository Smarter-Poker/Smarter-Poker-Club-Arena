-- ═══════════════════════════════════════════════════════════════════════════
-- SIX MONEY-INTEGRITY CHECKS, ZERO RUNS BETWEEN THEM
--
-- fn_money_check_health keeps a registry of the checks that guard money, each
-- with an expected cadence, and raises a CRITICAL when one goes stale. It was
-- raising six, all saying the same thing: runs = 0, last_run_at = null. Not
-- late. Never run, not once.
--
--   fn_pay_backed_payout_shortfalls   60m   pays what an event still owes
--                                           when the event holds the chips
--   fn_payout_guarantee_check         60m   vacant paid places, unpaid
--                                           earners, retained bounty pools
--   fn_cash_pot_conservation_check    60m   pot = rake + bbj + awarded, on
--                                           every completed cash hand
--   fn_detect_results_without_a_hand 360m   a result no poker produced
--
-- Every function exists and works. Nobody wired them to a schedule. This is
-- the fourth time in one session the same shape has appeared - unscheduled
-- ratchets, an unscheduled rake redrive, an unscheduled bounty backpay - and
-- it is the most expensive: fn_payout_guarantee_check is exactly the check
-- that would have caught the six unfunded guarantees, and
-- fn_cash_pot_conservation_check is exactly the one that would have caught the
-- rake being banked twice. Both defects ran for days in front of detectors
-- nobody had switched on.
--
-- Cadences come from the registry rather than being invented, and the minutes
-- are staggered so four money sweeps do not start in the same second. Each is
-- advisory-locked so a slow run cannot pile up on itself.
--
-- fn_pay_backed_payout_shortfalls carries its own statement_timeout: it walks
-- fn_tournament_conservation_delta across 50,000+ events and does not finish,
-- which is very likely why it was never scheduled. Bounded, it FAILS visibly
-- and fn_ca_cron_failure_watch reports it - better than the silence it had and
-- better than a hung connection.
--
-- Verified: the other three complete quickly and each surfaces one real
-- finding on the first run.
-- ═══════════════════════════════════════════════════════════════════════════

SELECT cron.schedule('ca-payout-guarantee-check-hourly', '18 * * * *',
  $$ SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-payout-guarantee-check'))
       THEN (SELECT count(*)::int FROM public.fn_payout_guarantee_check()) ELSE -1 END; $$);

SELECT cron.schedule('ca-cash-pot-conservation-hourly', '34 * * * *',
  $$ SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-cash-pot-conservation'))
       THEN (SELECT count(*)::int FROM public.fn_cash_pot_conservation_check()) ELSE -1 END; $$);

SELECT cron.schedule('ca-results-without-a-hand-6h', '46 */6 * * *',
  $$ SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-results-without-a-hand'))
       THEN (SELECT count(*)::int FROM public.fn_detect_results_without_a_hand()) ELSE -1 END; $$);

SELECT cron.schedule('ca-pay-backed-payout-shortfalls-hourly', '26 * * * *',
  $$ SET LOCAL statement_timeout = '120s';
     SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-pay-backed-payout-shortfalls'))
       THEN (public.fn_pay_backed_payout_shortfalls())::text ELSE 'locked' END; $$);
