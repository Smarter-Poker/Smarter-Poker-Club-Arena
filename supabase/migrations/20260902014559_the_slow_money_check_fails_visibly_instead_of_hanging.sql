-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902014559; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- fn_pay_backed_payout_shortfalls times out: it walks
-- fn_tournament_conservation_delta across the whole tournament history, and on
-- 50,000+ events that does not finish. That is very likely why it was never
-- scheduled - and leaving it unscheduled meant nothing ever paid an event's
-- backed shortfall.
--
-- Scheduling it without a bound would replace a silent gap with a job that
-- holds a connection until something kills it. So the cron command carries its
-- own statement_timeout: if the sweep cannot finish in two minutes the run
-- FAILS, fn_ca_cron_failure_watch sees the failure, and somebody gets told -
-- which is strictly better than both the silence it had and the hang it would
-- otherwise have.
--
-- The other three checks scheduled alongside it all complete quickly and each
-- already surfaces one real finding.

SELECT cron.unschedule('ca-pay-backed-payout-shortfalls-hourly');

SELECT cron.schedule('ca-pay-backed-payout-shortfalls-hourly', '26 * * * *',
  $$ SET LOCAL statement_timeout = '120s';
     SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-pay-backed-payout-shortfalls'))
       THEN (public.fn_pay_backed_payout_shortfalls())::text ELSE 'locked' END; $$);

