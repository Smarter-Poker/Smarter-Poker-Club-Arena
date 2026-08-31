-- Applied to production 2026-08-31 ~19:02 UTC via mgmt API.
-- Heavy TRANSACTIONAL RPCs whose max runtimes sat against the 8s per-role
-- cliff (fn_aggregate_gto_street_next 7.9s, process_tournament_rebuy 7.4s,
-- bbj_record_contribution 7.0s, ...). A kill at 8s rolls back and the caller
-- retries: work redone, load doubled, player-visible action failed for
-- nothing. Per Supabase's documented function-level timeout pattern, exactly
-- these get 30s headroom. Read paths deliberately NOT exempted.
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'fn_aggregate_gto_street_next','process_tournament_rebuy',
         'bbj_record_contribution','fn_spin_settle_game',
         'fn_settle_tournament_rake','atomic_seat_cashout_locked',
         'atomic_distribute_rake','fn_credit_and_log',
         'fn_seat_horse_in_seat_first_game')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET statement_timeout = %L', fn.sig, '30s');
  END LOOP;
END $$;
