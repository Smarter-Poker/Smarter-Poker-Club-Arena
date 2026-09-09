-- ACCEPTED HANDS HAVE ONE SERVICE-EXECUTABLE DATABASE DOOR.
--
-- The 12-argument protocol-2 transaction commits stacks, hand history, bomb
-- award units, lease evidence, post-commit obligations, and the projection
-- outbox together. Historical rolling overloads and their stack/history cores
-- must not remain callable by service_role after the cutover.

DO $accepted_hand_one_service_door$
DECLARE
  v_signature text;
  v_oid oid;
BEGIN
  IF to_regprocedure(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)') IS NOT NULL
     OR to_regprocedure(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL a rolling accepted-hand overload still exists';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
    'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
    'public.fn_ca_insert_hand_with_awards(jsonb,jsonb)',
    'public.fn_ca_open_tournament_hand_seat_exit_authority(uuid,uuid,uuid[])',
    'public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)',
    'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'
  ] LOOP
    v_oid := to_regprocedure(v_signature);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'FAIL accepted-hand implementation core % is missing',v_signature;
    END IF;
    IF has_function_privilege('service_role',v_oid,'EXECUTE')
       OR has_function_privilege('authenticated',v_oid,'EXECUTE')
       OR has_function_privilege('anon',v_oid,'EXECUTE') THEN
      RAISE EXCEPTION
        'FAIL accepted-hand implementation core % is externally executable',
        v_signature;
    END IF;
  END LOOP;

  IF to_regprocedure(
       'public.fn_sync_tournament_live_seat_chips(uuid)') IS NOT NULL
     OR to_regprocedure(
       'public.fn_sync_tournament_chips(uuid,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION
      'FAIL a stale tournament chip snapshot writer survived accepted-hand cutover';
  END IF;

  v_oid := to_regprocedure(
    'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)');
  IF v_oid IS NULL
     OR NOT has_function_privilege('service_role',v_oid,'EXECUTE')
     OR has_function_privilege('authenticated',v_oid,'EXECUTE')
     OR has_function_privilege('anon',v_oid,'EXECUTE')
     OR (SELECT count(*) FROM pg_proc p
          JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public'
           AND p.proname='fn_ca_commit_hand_settlement'
           AND has_function_privilege('service_role',p.oid,'EXECUTE')) <> 1 THEN
    RAISE EXCEPTION
      'FAIL protocol-2 accepted-hand transaction is not the one service door';
  END IF;

  RAISE EXCEPTION
    'AUDIT_TEST_PASS: accepted hands expose exactly one lease-fenced service door; rolling overloads are absent and every stack/history implementation core is owner-only';
END;
$accepted_hand_one_service_door$;
