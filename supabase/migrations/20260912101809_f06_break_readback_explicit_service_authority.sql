SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='15s';
-- Additive proposal only; independent review and root DDL window required.
DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure('public.fn_f06_hand_number_state(uuid,uuid,uuid)') IS NULL OR
     pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.fn_f06_hand_number_state(uuid,uuid,uuid)')) IS DISTINCT FROM $expected$CREATE OR REPLACE FUNCTION public.fn_f06_hand_number_state(p_tournament_id uuid, p_lease_generation uuid, p_table_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE life bigint; used bigint; pending jsonb; blocked text;
BEGIN
 PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,'{}',ARRAY[p_table_id]);
 SELECT tb.f06_lifecycle,CASE WHEN upper(t.status)<>'RUNNING' THEN 'tournament_not_running'
 WHEN lower(tb.status)='closed' OR COALESCE(tb.is_deleted,false) THEN 'table_closed' END INTO life,blocked
 FROM public.tables tb JOIN public.tournaments t ON t.id=tb.tournament_id
 WHERE tb.id=p_table_id AND tb.tournament_id=p_tournament_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','table_not_found'); END IF;
 SELECT GREATEST(0,
 COALESCE((SELECT max(hand_number) FROM smarter_private.f06_hand_permits WHERE table_id=p_table_id),0),
 COALESCE((SELECT max(hand_number) FROM public.hand_atomic_commits WHERE table_id=p_table_id),0),
 COALESCE((SELECT max(hand_number) FROM public.hand_history WHERE table_id=p_table_id),0)) INTO used;
 SELECT jsonb_build_object('permit_id',h.permit_id,'tournament_id',h.tournament_id,'table_id',h.table_id,
 'lifecycle',h.lifecycle::text,'hand_number',h.hand_number::text,'custody_id',h.custody_id,'generation',h.generation,'state',h.state)
 INTO pending FROM smarter_private.f06_hand_permits h WHERE h.table_id=p_table_id AND h.state='reserved';
 IF pending IS NOT NULL THEN blocked:='hand_permit_unresolved';
 ELSIF EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=p_table_id AND state<>'acknowledged') THEN blocked:='source_excluded';
 ELSIF used=9223372036854775807 THEN blocked:='hand_number_exhausted'; END IF;
 RETURN jsonb_build_object('ok',true,'table_id',p_table_id,'lifecycle',life::text,
 'used_hand_number_max',used::text,'next_hand_number_candidate',CASE WHEN blocked IS NULL THEN (used+1)::text ELSE NULL END,
 'can_reserve',blocked IS NULL,'blocked_reason',blocked,'unresolved_permit',pending);
END $function$
$expected$ OR
     NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=pg_catalog.to_regprocedure('public.fn_f06_hand_number_state(uuid,uuid,uuid)') AND pg_catalog.pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION '0085 preimage mismatch: fn_f06_hand_number_state';
  END IF;
  IF pg_catalog.to_regprocedure('public.fn_f06_reconcile_break(uuid,uuid,uuid)') IS NULL OR
     pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.fn_f06_reconcile_break(uuid,uuid,uuid)')) IS DISTINCT FROM $expected$CREATE OR REPLACE FUNCTION public.fn_f06_reconcile_break(p_tournament_id uuid, p_lease_generation uuid, p_break_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
BEGIN
 PERFORM smarter_private.f06_lock_break(p_tournament_id,p_lease_generation,p_break_id);
 -- Winners are bound in the SAME transaction by the original receipt trigger.
 -- A legacy receipt without that provenance cannot be promoted here.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_attempts a JOIN public.tournament_seat_move_receipts r USING(request_id) WHERE a.break_id=p_break_id AND a.state<>'winner') THEN
 RAISE EXCEPTION 'F06_UNBOUND_RECEIPT_CONFLICT' USING ERRCODE='55000'; END IF;
 RETURN smarter_private.f06_state(p_break_id);
END $function$
$expected$ OR
     NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=pg_catalog.to_regprocedure('public.fn_f06_reconcile_break(uuid,uuid,uuid)') AND pg_catalog.pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION '0085 preimage mismatch: fn_f06_reconcile_break';
  END IF;
  IF pg_catalog.to_regprocedure('public.fn_f06_table_state(uuid,uuid,uuid)') IS NULL OR
     pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.fn_f06_table_state(uuid,uuid,uuid)')) IS DISTINCT FROM $expected$CREATE OR REPLACE FUNCTION public.fn_f06_table_state(p_tournament_id uuid, p_lease_generation uuid, p_table_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE v jsonb; recovery jsonb;
BEGIN
 PERFORM smarter_private.f06_authority(p_tournament_id,p_lease_generation);
 recovery:=public.fn_f06_hand_number_state(p_tournament_id,p_lease_generation,p_table_id);
 SELECT jsonb_build_object('ok',true,'table_id',t.id,'lifecycle',t.f06_lifecycle::text,'excluded',o.break_id IS NOT NULL,'break_id',o.break_id) INTO v
 FROM public.tables t LEFT JOIN smarter_private.f06_operations o ON o.source_table_id=t.id AND o.state<>'acknowledged'
 WHERE t.id=p_table_id AND t.tournament_id=p_tournament_id;
 IF v IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','table_not_found'); END IF;
 RETURN v||jsonb_build_object('hand_number_high_water',recovery->'used_hand_number_max',
 'unresolved_permits',CASE WHEN recovery->'unresolved_permit'='null'::jsonb THEN '[]'::jsonb ELSE jsonb_build_array(recovery->'unresolved_permit') END,
 'unresolved_overflow',false,'can_reserve',recovery->'can_reserve','blocked_reason',recovery->'blocked_reason');
END $function$
$expected$ OR
     NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=pg_catalog.to_regprocedure('public.fn_f06_table_state(uuid,uuid,uuid)') AND pg_catalog.pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION '0085 preimage mismatch: fn_f06_table_state';
  END IF;
  IF pg_catalog.to_regprocedure('public.fn_next_hand_number()') IS NULL OR
     pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.fn_next_hand_number()')) IS DISTINCT FROM $expected$CREATE OR REPLACE FUNCTION public.fn_next_hand_number()
 RETURNS bigint
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
 SELECT smarter_private.f06_allocate_number_above(1000000);
$function$
$expected$ OR
     NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=pg_catalog.to_regprocedure('public.fn_next_hand_number()') AND pg_catalog.pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION '0085 preimage mismatch: fn_next_hand_number';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_f06_break_state') THEN
    RAISE EXCEPTION '0085 new-name collision';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.refclassid='pg_catalog.pg_proc'::pg_catalog.regclass AND d.refobjid='public.fn_f06_reconcile_break(uuid,uuid,uuid)'::pg_catalog.regprocedure) OR
     EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.prosrc ILIKE '%fn_f06_reconcile_break%' AND p.oid <> 'public.fn_f06_reconcile_break(uuid,uuid,uuid)'::pg_catalog.regprocedure) THEN
    RAISE EXCEPTION '0085 dependent SQL or routine source requires review';
  END IF;
END;
$preflight$;
REVOKE ALL ON FUNCTION public.fn_f06_hand_number_state(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_hand_number_state(uuid,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_f06_reconcile_break(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_reconcile_break(uuid,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_f06_table_state(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_table_state(uuid,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_next_hand_number() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_next_hand_number() TO service_role;
CREATE FUNCTION public.fn_f06_break_state(p_tournament_id uuid, p_lease_generation uuid, p_break_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
BEGIN
 PERFORM smarter_private.f06_lock_break(p_tournament_id,p_lease_generation,p_break_id);
 -- Winners are bound in the SAME transaction by the original receipt trigger.
 -- A legacy receipt without that provenance cannot be promoted here.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_attempts a JOIN public.tournament_seat_move_receipts r USING(request_id) WHERE a.break_id=p_break_id AND a.state<>'winner') THEN
 RAISE EXCEPTION 'F06_UNBOUND_RECEIPT_CONFLICT' USING ERRCODE='55000'; END IF;
 RETURN smarter_private.f06_state(p_break_id);
END $function$;
ALTER FUNCTION public.fn_f06_break_state(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_f06_break_state(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_break_state(uuid,uuid,uuid) TO service_role;
DO $postflight$
BEGIN
  IF (SELECT p.proacl::text FROM pg_catalog.pg_proc p WHERE p.oid='public.fn_f06_break_state(uuid,uuid,uuid)'::pg_catalog.regprocedure)
      IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION '0085 unexpected replacement ACL';
  END IF;
END;
$postflight$;
DROP FUNCTION public.fn_f06_reconcile_break(uuid,uuid,uuid) RESTRICT;
