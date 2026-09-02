-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828022323; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ============================================================================
-- spin_cron_schedule_pg_cron
--
-- WHY
-- ---
-- The Spin maintenance functions were being driven from outside the database
-- by a scheduler called "Open Claw", named in the header of the spin-sweep
-- endpoint. It has no entry in vercel.json. The audit reported it as dead
-- since 21 Aug; the truth is slightly different and slightly worse, and it
-- is worth writing down:
--
--   public.cron_health_log row 'spin-sweep' shows last_run_at
--   2026-08-28 02:00:04 UTC with last_status = 'error' and error_message =
--   'http_500', duration 1518 ms.
--
-- So something IS still poking the endpoint every hour, and the endpoint has
-- been answering 500. It is not a scheduler that stopped; it is a scheduler
-- whose target is broken, which is why nothing looked obviously dead. Either
-- way the database-side work -- fn_spin_sweep_unbooked and
-- fn_spin_repair_missing_multiplier -- has not been running.
--
-- pg_cron IS installed on this project and is carrying 40+ live jobs, so
-- there is no reason for Spin maintenance to depend on an HTTP hop through a
-- scheduler nobody owns. These three jobs run the functions in-database.
--
-- COORDINATION
-- ------------
-- Another agent owns tournament scheduling. Every job here is prefixed
-- 'spin_' and touches only the three Spin functions. Nothing else is
-- scheduled, unscheduled or altered by this migration.
--
-- Each command takes a pg_try_advisory_lock first, matching the house style
-- used by reconcile-tournament-denormals and friends: pg_cron will happily
-- start a second copy of a job whose previous run is still going.
--
-- NOT SCHEDULED, DELIBERATELY: public.fn_spin_reap_stale_boards. It refunds
-- real player money (by delegation) and ships with p_dry_run defaulting to
-- TRUE. Scheduling it is a human decision, and the human who makes it has to
-- pass p_dry_run => false explicitly.
-- ============================================================================

-- fn_spin_sweep_unbooked: the forward conservation net -- games that ran but
-- never booked against the reserve. Lookback 60 minutes at a 5-minute cadence
-- gives 12x redundancy, so a few missed ticks cost nothing. As of now there
-- are 0 unbooked Spins in the last 3 hours, so the first runs are no-ops.
SELECT cron.schedule(
  'spin_sweep_unbooked',
  '*/5 * * * *',
  $cron$
    SELECT CASE
             WHEN pg_try_advisory_lock(hashtext('spin_sweep_unbooked'))
               THEN (SELECT public.fn_spin_sweep_unbooked(60)::text)
             ELSE 'skipped: previous run still holding the lock'
           END;
  $cron$);

-- fn_spin_repair_missing_multiplier: rebuilds a Spin's multiplier from the
-- prize actually paid when the draw never landed. The sweep already calls it
-- with its own lookback; this runs it on a wider 4-hour window so a Spin that
-- was missed for longer than the sweep's horizon still gets seen. It only
-- reconstructs a multiplier that matches a known tier and alerts instead of
-- inventing one otherwise, so a wider window is safe.
SELECT cron.schedule(
  'spin_repair_missing_multiplier',
  '*/15 * * * *',
  $cron$
    SELECT CASE
             WHEN pg_try_advisory_lock(hashtext('spin_repair_missing_multiplier'))
               THEN (SELECT public.fn_spin_repair_missing_multiplier(240)::text)
             ELSE 'skipped: previous run still holding the lock'
           END;
  $cron$);

-- fn_spin_unpaid_check: the reverse conservation net added in
-- spin_unpaid_settlement_detection -- prize drawn from the reserve, nobody
-- credited. Hourly at :50 on a 7-day window. Alerts are deduped per
-- tournament while unresolved, so a standing unfixed offender does not spam.
-- This one moves no money under any circumstances.
SELECT cron.schedule(
  'spin_unpaid_check',
  '50 * * * *',
  $cron$
    SELECT CASE
             WHEN pg_try_advisory_lock(hashtext('spin_unpaid_check'))
               THEN (SELECT public.fn_spin_unpaid_check(7)::text)
             ELSE 'skipped: previous run still holding the lock'
           END;
  $cron$);

