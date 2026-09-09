\set ON_ERROR_STOP on

-- Read-only post-deploy receipt for the DB-first terminal ACL cutover.
DO $probe$
DECLARE
  v_signature text;
  v_proc regprocedure;
  v_owner oid;
  v_authority_owner oid;
  v_source text;
  v_service_only text[] := ARRAY[
    'public.fn_apply_prize_guarantee(uuid,text)',
    'public.fn_ca_epoch3_preflight()',
    'public.fn_ca_execute_epoch3_reset(text,boolean)',
    'public.fn_collect_bounty(uuid,uuid,uuid,jsonb)',
    'public.fn_complete_tournament_terminal(uuid,uuid,text)',
    'public.fn_final_table_deal(uuid)',
    'public.fn_finalize_bounty_pool(uuid,uuid)',
    'public.fn_mystery_bounty_pay(uuid)',
    'public.fn_mystery_bounty_reserve(uuid,uuid,jsonb,uuid,text,uuid,integer)',
    'public.fn_mystery_bounty_settle(uuid,uuid)',
    'public.fn_prepare_tournament_place_obligations(uuid,text)',
    'public.fn_resolve_satellite_settlement_outcome(uuid,uuid)',
    'public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)',
    'public.fn_settle_final_table_deal_atomic(uuid)',
    'public.fn_settle_satellite_finish_atomic(uuid,text)',
    'public.fn_settle_satellite_tournament(uuid,uuid)',
    'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)',
    'public.fn_settle_tournament_places_atomic(uuid,text)',
    'public.fn_settle_tournament_rake(uuid,text)'
  ];
  v_owner_only text[] := ARRAY[
    'public.fn_apply_prize_guarantee_before_atomic_proof(uuid,text)',
    'public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)',
    'public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)',
    'public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)',
    'public.fn_collect_bounty_unguarded_20260907(uuid,uuid,uuid,jsonb)',
    'public.fn_deliver_satellite_ticket_exact(uuid,uuid,uuid,text,integer,numeric)',
    'public.fn_final_table_deal_unguarded_20260907(uuid)',
    'public.fn_finalize_bounty_pool_unguarded_20260907(uuid,uuid)',
    'public.fn_mystery_bounty_pay_unguarded_20260907(uuid)',
    'public.fn_mystery_bounty_reserve_unguarded_20260907(uuid,uuid,jsonb,uuid,text,uuid,integer)',
    'public.fn_mystery_bounty_settle_unguarded_20260907(uuid,uuid)',
    'public.fn_register_for_tournament_with_ticket_before_terminal_gate(uuid,uuid)',
    'public.fn_settle_satellite_cash_entitlement_exact(uuid,text,integer,uuid,numeric,text)',
    'public.fn_settle_satellite_finish_atomic_before_maintenance_gate(uuid,text)',
    'public.fn_settle_tournament_bubble_protection(uuid,uuid)',
    'public.fn_settle_tournament_final_table_deal(uuid)',
    'public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)',
    'public.fn_settle_tournament_places(uuid,uuid)'
  ];
BEGIN
  SELECT p.proowner INTO v_authority_owner
    FROM pg_proc p
   WHERE p.oid='public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure;

  FOREACH v_signature IN ARRAY v_service_only LOOP
    v_proc := to_regprocedure(v_signature);
    IF v_proc IS NULL THEN
      RAISE EXCEPTION 'FAIL rolling service root % is missing',v_signature;
    END IF;
    SELECT p.proowner INTO v_owner FROM pg_proc p WHERE p.oid=v_proc;
    IF NOT has_function_privilege('service_role',v_proc,'EXECUTE')
       OR has_function_privilege('anon',v_proc,'EXECUTE')
       OR has_function_privilege('authenticated',v_proc,'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(
           COALESCE(p.proacl,acldefault('f',p.proowner))) a
          WHERE p.oid=v_proc AND upper(a.privilege_type)='EXECUTE'
            AND a.grantee<>ALL(ARRAY[v_owner,'service_role'::regrole::oid])
       ) THEN
      RAISE EXCEPTION 'FAIL % is not exact owner + service_role EXECUTE',v_signature;
    END IF;
  END LOOP;

  FOREACH v_signature IN ARRAY v_owner_only LOOP
    v_proc := to_regprocedure(v_signature);
    IF v_proc IS NULL THEN
      RAISE EXCEPTION 'FAIL owner-only leaf % is missing',v_signature;
    END IF;
    SELECT p.proowner INTO v_owner FROM pg_proc p WHERE p.oid=v_proc;
    IF has_function_privilege('service_role',v_proc,'EXECUTE')
       OR has_function_privilege('anon',v_proc,'EXECUTE')
       OR has_function_privilege('authenticated',v_proc,'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(
           COALESCE(p.proacl,acldefault('f',p.proowner))) a
          WHERE p.oid=v_proc AND upper(a.privilege_type)='EXECUTE'
            AND a.grantee<>v_owner
       ) THEN
      RAISE EXCEPTION 'FAIL % is not exact owner-only EXECUTE',v_signature;
    END IF;
  END LOOP;

  v_proc := 'public.fn_register_for_tournament_with_ticket(uuid,uuid)'::regprocedure;
  SELECT p.proowner,p.prosrc INTO v_owner,v_source FROM pg_proc p WHERE p.oid=v_proc;
  IF NOT has_function_privilege('authenticated',v_proc,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_proc,'EXECUTE')
     OR has_function_privilege('anon',v_proc,'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_proc p
       CROSS JOIN LATERAL aclexplode(
         COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE p.oid=v_proc AND upper(a.privilege_type)='EXECUTE'
          AND a.grantee<>ALL(ARRAY[
            v_owner,'authenticated'::regrole::oid,'service_role'::regrole::oid])
     )
     OR position('public.fn_caller_session_is_live()' IN v_source)=0
     OR position('public.fn_caller_session_is_live()' IN v_source)>
        position('public.fn_ca_lock_tournament_seat_acquisition(' IN v_source) THEN
    RAISE EXCEPTION 'FAIL ticket-spend root lost its exact ACL or pre-lock session gate';
  END IF;

  FOREACH v_signature IN ARRAY v_service_only||v_owner_only||ARRAY[
    'public.fn_register_for_tournament_with_ticket(uuid,uuid)'
  ] LOOP
    v_proc := to_regprocedure(v_signature);
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p WHERE p.oid=v_proc AND p.prosecdef
        AND p.proowner=v_authority_owner
        AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[]
    ) THEN
      RAISE EXCEPTION
        'FAIL % lost common authority owner, SECURITY DEFINER or fixed search_path',
        v_signature;
    END IF;
  END LOOP;

  RAISE NOTICE
    'PASS terminal DB-first ACLs, private leaves, fixed search paths and live-session ticket gate';
END;
$probe$;

-- Exercise both negative caller classes without writing a ticket, tournament,
-- lock receipt or profile row.  Reaching the acquisition core would fail with
-- a different SQLSTATE for these deliberately nonexistent ids.
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims =
  '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111","session_id":"22222222-2222-4222-8222-222222222222"}';
DO $revoked_session$
BEGIN
  BEGIN
    PERFORM public.fn_register_for_tournament_with_ticket(
      '33333333-3333-4333-8333-333333333333'::uuid,
      '44444444-4444-4444-8444-444444444444'::uuid);
    RAISE EXCEPTION 'FAIL revoked session reached ticket admission';
  EXCEPTION WHEN SQLSTATE '28000' THEN
    RAISE NOTICE 'PASS revoked authenticated session refused before ticket admission';
  END;
END;
$revoked_session$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SET LOCAL request.jwt.claims = '{"role":"service_role"}';
DO $bare_service$
BEGIN
  BEGIN
    PERFORM public.fn_register_for_tournament_with_ticket(
      '33333333-3333-4333-8333-333333333333'::uuid,
      '44444444-4444-4444-8444-444444444444'::uuid);
    RAISE EXCEPTION 'FAIL bare service token reached ticket admission';
  EXCEPTION WHEN SQLSTATE '28000' THEN
    RAISE NOTICE 'PASS bare service token without auth.uid refused';
  END;
END;
$bare_service$;
ROLLBACK;
