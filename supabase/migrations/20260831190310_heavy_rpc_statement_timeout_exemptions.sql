-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831190310; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Function-level statement_timeout exemptions (2026-08-31).
--
-- The per-role API timeout (authenticated/service via authenticator: 8s) is
-- right: no interactive query should run that long. But pg_stat_statements
-- shows a set of heavy TRANSACTIONAL RPCs whose max runtimes sit against the
-- 8s cliff under load (fn_aggregate_gto_street_next max 7.9s,
-- process_tournament_rebuy 7.4s, bbj_record_contribution 7.0s,
-- fn_spin_settle_game 6.7s, fn_settle_tournament_rake 6.4s,
-- atomic_seat_cashout_locked 6.4s, atomic_distribute_rake 5.4s,
-- fn_credit_and_log 4.6s). When one is killed at 8s the transaction rolls
-- back and the caller retries - the work is redone, the load doubles, and a
-- player-visible action (rebuy, cashout, settle) fails for nothing. 6,268
-- app-query timeout cancellations were logged in 6.5h during today's
-- saturation.
--
-- Per Supabase's documented pattern (function-level timeout for recurring
-- functions needing an exemption), give exactly these functions 30s headroom.
-- All are single-transaction and atomic: a longer limit changes nothing about
-- correctness, only stops the kill-and-retry churn. Read-path functions are
-- deliberately NOT exempted - slow reads should keep failing fast and get
-- optimized instead.
DO $$
DECLARE
  fn record;
  altered int := 0;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'fn_aggregate_gto_street_next',
         'process_tournament_rebuy',
         'bbj_record_contribution',
         'fn_spin_settle_game',
         'fn_settle_tournament_rake',
         'atomic_seat_cashout_locked',
         'atomic_distribute_rake',
         'fn_credit_and_log',
         'fn_seat_horse_in_seat_first_game'
       )
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET statement_timeout = %L', fn.sig, '30s');
    altered := altered + 1;
  END LOOP;
  RAISE NOTICE 'statement_timeout=30s set on % function signature(s)', altered;
END $$;
