-- ============================================================================
-- THE TREASURY WATCHDOG WAS BLIND BECAUSE NOBODY HAD EVER COUNTED THE TABLES
--
-- Found while chasing the -226.65 BBJ conservation drift. The drift is real,
-- but the far bigger finding is WHY nobody knew about it.
--
-- THE CHAIN
--   1. public.bbj_contributions had NEVER been analysed. last_analyze,
--      last_autoanalyze, last_vacuum and last_autovacuum were all NULL.
--   2. So the planner believed it held 2,600 rows. It holds 648,543 -- a 250x
--      underestimate on a 242 MB table.
--   3. Planned on that fiction, fn_union_treasury_selftest's duplicate-
--      contribution scan chose a catastrophic plan and hit the statement
--      timeout. THE SELF-TEST COULD NOT RUN AT ALL.
--   4. Which is precisely why a -226.65 breach of a 1.00 tolerance sat
--      unreported. The alarm was not ignored; it was unable to ring.
--
-- After a single ANALYZE the self-test completes in normal time and reports
-- the breach it was always supposed to report.
--
-- AND IT IS NOT ONE TABLE. Twelve relations over 20 MB had never been
-- analysed, including money that settlement and rakeback read every day:
--
--   solved_spots_gold        72 GB    estimated at 4,846 rows
--   ca_hand_player_idx      2257 MB   estimated at 111,590
--   data_audit_log          1919 MB   estimated at 19,259
--   rake_records            1004 MB   estimated at 8,932
--   vip_points_ledger        956 MB   estimated at 22,783
--   wallet_transactions      797 MB   estimated at 14,979
--   rakeback_stats_applied   550 MB
--   rake_distribution_legs   429 MB
--   agent_commissions        396 MB
--   club_wallet_transactions 327 MB
--
-- Every query planned against those is planned on a guess. That is the most
-- likely explanation for the slow, IO-bound money queries seen repeatedly on
-- 2026-08-23 -- fn_rakeback_recompute_periods sitting 49 seconds on
-- DataFileRead, and the repeated connection-pool timeouts.
--
-- WHY AUTOANALYZE NEVER FIRED. None of these carry table-level settings; they
-- inherit the defaults. There are only three autovacuum workers, and this
-- database holds a 72 GB table and a 10 GB one. The giants monopolise the
-- workers and everything behind them starves. hand_history is the ONLY table
-- with explicit settings, added the same morning after its unthrottled vacuum
-- saturated disk IO and took /api/health down for eight minutes.
--
-- THE FIX. Give the money-critical tables their own thresholds so they are
-- analysed on a ROW COUNT rather than a percentage of a total the planner does
-- not know, and deliberately keep cost_delay at 2ms -- the same gentle value
-- hand_history was given, because the cure for a starving autovacuum must not
-- be a second IO saturation.
--
-- scale_factor 0 with a flat threshold means "after N changes", which is
-- exactly what you want on a table whose size nothing has ever measured.
--
-- NOT COVERED HERE, DELIBERATELY: solved_spots_gold (72 GB),
-- ca_hand_player_idx and data_audit_log. They are large and not money, and
-- giving three more giants aggressive settings on a three-worker autovacuum is
-- how the starvation happened in the first place. They want their own pass.
-- ============================================================================

ALTER TABLE public.bbj_contributions SET (
  autovacuum_enabled = true,
  autovacuum_analyze_scale_factor = 0.0, autovacuum_analyze_threshold = 2000,
  autovacuum_vacuum_scale_factor = 0.0,  autovacuum_vacuum_threshold = 2000,
  autovacuum_vacuum_cost_delay = 2,      autovacuum_vacuum_cost_limit = 2000);

ALTER TABLE public.rake_records SET (
  autovacuum_enabled = true,
  autovacuum_analyze_scale_factor = 0.0, autovacuum_analyze_threshold = 1000,
  autovacuum_vacuum_scale_factor = 0.0,  autovacuum_vacuum_threshold = 1000,
  autovacuum_vacuum_cost_delay = 2,      autovacuum_vacuum_cost_limit = 2000);

ALTER TABLE public.wallet_transactions SET (
  autovacuum_enabled = true,
  autovacuum_analyze_scale_factor = 0.0, autovacuum_analyze_threshold = 1000,
  autovacuum_vacuum_scale_factor = 0.0,  autovacuum_vacuum_threshold = 1000,
  autovacuum_vacuum_cost_delay = 2,      autovacuum_vacuum_cost_limit = 2000);

ALTER TABLE public.club_wallet_transactions SET (
  autovacuum_enabled = true,
  autovacuum_analyze_scale_factor = 0.0, autovacuum_analyze_threshold = 1000,
  autovacuum_vacuum_scale_factor = 0.0,  autovacuum_vacuum_threshold = 1000,
  autovacuum_vacuum_cost_delay = 2,      autovacuum_vacuum_cost_limit = 2000);

ALTER TABLE public.vip_points_ledger SET (
  autovacuum_enabled = true,
  autovacuum_analyze_scale_factor = 0.0, autovacuum_analyze_threshold = 2000,
  autovacuum_vacuum_scale_factor = 0.0,  autovacuum_vacuum_threshold = 2000,
  autovacuum_vacuum_cost_delay = 2,      autovacuum_vacuum_cost_limit = 2000);

ALTER TABLE public.agent_commissions SET (
  autovacuum_enabled = true,
  autovacuum_analyze_scale_factor = 0.0, autovacuum_analyze_threshold = 1000,
  autovacuum_vacuum_scale_factor = 0.0,  autovacuum_vacuum_threshold = 1000,
  autovacuum_vacuum_cost_delay = 2,      autovacuum_vacuum_cost_limit = 2000);

ALTER TABLE public.rake_distribution_legs SET (
  autovacuum_enabled = true,
  autovacuum_analyze_scale_factor = 0.0, autovacuum_analyze_threshold = 1000,
  autovacuum_vacuum_scale_factor = 0.0,  autovacuum_vacuum_threshold = 1000,
  autovacuum_vacuum_cost_delay = 2,      autovacuum_vacuum_cost_limit = 2000);

ALTER TABLE public.rakeback_stats_applied SET (
  autovacuum_enabled = true,
  autovacuum_analyze_scale_factor = 0.0, autovacuum_analyze_threshold = 1000,
  autovacuum_vacuum_scale_factor = 0.0,  autovacuum_vacuum_threshold = 1000,
  autovacuum_vacuum_cost_delay = 2,      autovacuum_vacuum_cost_limit = 2000);

COMMENT ON TABLE public.bbj_contributions IS
  'BBJ rake contributions. Explicit autoanalyze thresholds added 2026-08-23: this table had NEVER been analysed, the planner believed 2,600 rows against 648,543 real, and fn_union_treasury_selftest therefore timed out - which is why a -226.65 conservation breach went unreported.';

DO $assert$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO v_missing
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('bbj_contributions','rake_records','wallet_transactions',
                       'club_wallet_transactions','vip_points_ledger','agent_commissions',
                       'rake_distribution_legs','rakeback_stats_applied')
     AND (c.reloptions IS NULL
          OR NOT array_to_string(c.reloptions, ',') LIKE '%autovacuum_analyze_threshold%');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'these money tables still have no analyze threshold: %', v_missing;
  END IF;

  -- The cure must not become the disease: an unthrottled vacuum on a big table
  -- saturated disk IO the same morning and took /api/health down.
  SELECT string_agg(c.relname, ', ') INTO v_missing
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND array_to_string(c.reloptions, ',') LIKE '%autovacuum_vacuum_cost_delay=0%';
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'unthrottled autovacuum is back on: %', v_missing;
  END IF;
END $assert$;
