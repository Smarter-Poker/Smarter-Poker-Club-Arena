# SOURCE ONLY / UNRUN. PostgreSQL 17 isolationtester input, not a receipt.
# Use a separately admitted empty allocation, never the primary SQL allocation.
# The protected executor supplies qualification.execution_uuid on all connections.
# Expect repair_call to WAIT on claimant, then resume after claim_commit.
# The owner must reject unexpected SQL errors/wait order even if the runner exits0.
# No teardown drops shared objects. The allocation owner must independently close
# every connection, capture receipts and destroy this exact disposable database.

setup
{
  -- The pinned psql setup performed the original empty-catalog admission and
  -- exact component installation before this separately connected native check.
  DO $admission$
  DECLARE v_id text := current_setting('qualification.execution_uuid',true);
  BEGIN
    IF v_id IS NULL OR v_id !~ ('^'||repeat('[0-9a-f]',8)||'-'||repeat('[0-9a-f]',4)||
       '-[1-8]'||repeat('[0-9a-f]',3)||'-[89ab]'||repeat('[0-9a-f]',3)||'-'||repeat('[0-9a-f]',12)||'$')
       OR current_database()<>'qual_spin_'||replace(v_id,'-','')
       OR (inet_server_addr() IS NOT NULL AND inet_server_addr() NOT IN ('127.0.0.1'::inet,'::1'::inet))
       OR current_user<>'postgres' OR session_user<>'postgres'
       OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
       OR (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role'))<>3
       OR md5(pg_get_functiondef('public.fn_spin_repair_missing_multiplier(integer)'::regprocedure))
          IS DISTINCT FROM '8bb6db8c165c5980e2fdb710fd473f0a'
       OR md5(pg_get_functiondef('public.fn_ca_financial_alert_to_incident()'::regprocedure))
          IS DISTINCT FROM '00a43ae03ab12cec9505e2bfed71d937'
       OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.qualification_spin_restore_preimage()')
         AND md5(prosrc)='200971a0d5f8a4b720fc7996baf99f84'
         AND pg_get_userbyid(proowner)='postgres' AND NOT prosecdef
         AND proacl::text=chr(123)||'postgres=X/postgres'||chr(125))
       OR (SELECT count(*)=1 AND bool_and(id='40000000-0000-4000-8000-000000000001'
           AND spin_multiplier IS NULL AND is_premium_spin=false AND prize_pool=3
           AND buy_in_amount=1 AND status='RUNNING') FROM public.tournaments) IS DISTINCT FROM true
       OR EXISTS(SELECT 1 FROM public.qualification_spin_race_results)
       OR EXISTS(SELECT 1 FROM public.financial_alerts)
       OR EXISTS(SELECT 1 FROM public.spin_reserve_ledger) THEN
      RAISE EXCEPTION 'Requires exact prepared disposable Spin native race allocation';
    END IF;
  END $admission$;
}

session "claimant"
setup { SET statement_timeout='15s'; SET lock_timeout='8s'; }
step "claim_begin" { BEGIN; }
step "claim_write" {
  UPDATE public.tournaments SET spin_multiplier=5
   WHERE id='40000000-0000-4000-8000-000000000001'
     AND spin_multiplier IS NULL;
}
step "claim_commit" { COMMIT; }

session "repair"
setup { SET statement_timeout='15s'; SET lock_timeout='8s'; }
step "repair_call" {
  INSERT INTO public.qualification_spin_race_results(result)
  SELECT public.fn_spin_repair_missing_multiplier(60);
}
step "repair_assert" {
  DO $assert$
  BEGIN
    IF (SELECT count(*)=1 AND bool_and(result=jsonb_build_object(
         'ok',true,'repaired',0,'unreconstructable',0,'paid_over_drawn_count',0,
         'repaired_outside_window',0,'lost_the_race',1,'lookback_mins',60))
        FROM public.qualification_spin_race_results) IS DISTINCT FROM true
       OR (SELECT count(*)=1 AND bool_and(spin_multiplier=5 AND is_premium_spin=false
            AND prize_pool=3 AND buy_in_amount=1 AND status='RUNNING')
           FROM public.tournaments) IS DISTINCT FROM true
       OR EXISTS (SELECT 1 FROM public.financial_alerts)
       OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger) THEN
      RAISE EXCEPTION 'CAS race: competing stamp, exact counters or no-alert/no-money invariant failed';
    END IF;
  END;
  $assert$;
  SELECT 'spin-repair-evidence-cas-race' stage,result,
         current_database() allocation,
         current_setting('qualification.execution_uuid') execution_uuid
    FROM public.qualification_spin_race_results;
}
step "restore_preimage" {
  SELECT public.qualification_spin_restore_preimage();

  DO $assert$
  BEGIN
    IF md5(pg_get_functiondef('public.fn_spin_repair_missing_multiplier(integer)'::regprocedure))
        IS DISTINCT FROM '833c06b59dfdd8fd29b74cce0c6be6a2' THEN
      RAISE EXCEPTION 'CAS race: captured target was not restored';
    END IF;
  END;
  $assert$;
}

permutation "claim_begin" "claim_write" "repair_call" "claim_commit" "repair_assert" "restore_preimage"

