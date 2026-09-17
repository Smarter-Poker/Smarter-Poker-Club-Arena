-- Apply only with the scoped weekly coordinator activation bundle.
-- Old browser claims cannot pay. Trusted compatibility callers enter the one
-- coordinator, which owns due time, source certification, money and documents.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$
DECLARE expected record;actual text;scope_definition text;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('public.fn_agent_claim_commission(uuid,uuid,integer)','bcb8ff3ffb25d8b6a9e1537845050fdd'),
  ('public.fn_claim_rakeback(uuid)','01e25e9908d76f1bdbc749f57f106f21'),
  ('public.fn_execute_union_rakeback(uuid,timestamptz,timestamptz)','de06da455424cbd5c38d6934a2dfca60'),
  ('public.fn_run_pending_rakeback_settlement(integer)','000eecf4f81d2e24affa3967676b8263'),
  ('public.settle_club_rakeback(uuid)','85cf74f076fd3cc2f834b4b29a01c647'),
  ('public.fn_settle_club_rakeback_batch(uuid,integer,numeric,integer)','8e2f3e6648aaa603acb438fbcfb46b92'),
  ('public.fn_close_settlement_period(uuid)','e129b4ff2ba84faa8f0dee88b494d21f')
 ) AS preimage(signature,digest) LOOP
  SELECT md5(pg_get_functiondef(to_regprocedure(expected.signature))) INTO actual;
  IF actual IS DISTINCT FROM expected.digest THEN
   RAISE EXCEPTION 'automatic accounting legacy door preimage changed: %',expected.signature;
  END IF;
 END LOOP;
 IF to_regprocedure('public.fn_process_weekly_accounting_scope(uuid,uuid)') IS NULL THEN
  RAISE EXCEPTION 'scoped weekly coordinator must be installed with this cutover';END IF;
 SELECT pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure) INTO scope_definition;
 IF has_function_privilege('authenticated','public.fn_process_weekly_accounting_scope(uuid,uuid)','EXECUTE')
  OR has_function_privilege('service_role','public.fn_process_weekly_accounting_scope(uuid,uuid)','EXECUTE')
  OR scope_definition ~ 'public\.(fn_close_settlement_period|fn_settle_club_rakeback_batch)\('
  OR (SELECT regexp_replace(prosrc,'[[:space:]]','','g') FROM pg_proc WHERE oid='public.fn_process_weekly_accounting(uuid)'::regprocedure)
    IS DISTINCT FROM 'SELECTpublic.fn_process_weekly_accounting_scope(p_union_id,NULL::uuid)' THEN
  RAISE EXCEPTION 'weekly coordinator must be private, scoped and independent of legacy payers';END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fn_agent_claim_commission(p_club_id uuid,p_op_id uuid DEFAULT NULL::uuid,p_max_rows integer DEFAULT 1000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE actor uuid:=auth.uid();
BEGIN
 IF actor IS NULL THEN RETURN jsonb_build_object('success',false,'error','Authentication Required','amount',0,'rows_settled',0,'more',false,'op_id',p_op_id);END IF;
 IF p_club_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.club_members m WHERE m.club_id=p_club_id AND m.user_id=actor AND m.status IN('active','approved')) THEN
  RETURN jsonb_build_object('success',false,'error','You Are Not An Active Member Of This Club','amount',0,'rows_settled',0,'more',false,'op_id',p_op_id);END IF;
 -- No balance read, replay receipt, settlement stamp or wallet write. A zero
 -- below is the amount moved by this retired request, not the amount owed.
 RETURN jsonb_build_object('success',false,'code','automatic_weekly_settlement','error','Commission Is Settled Automatically Every Monday At 4:00 AM Central Time. View Invoices For Recorded Transfers.',
  'authority','fn_process_weekly_accounting','schedule','Monday 04:00 America/Chicago','amount',0,'rows_settled',0,'more',false,'op_id',p_op_id,'club_id',p_club_id);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_claim_rakeback(p_club_id uuid DEFAULT NULL::uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $function$
DECLARE actor uuid:=auth.uid();
BEGIN
 IF actor IS NULL THEN RETURN jsonb_build_object('success',false,'error','Authentication Required','periods_claimed',0,'total_payout',0);END IF;
 IF p_club_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.club_members m WHERE m.club_id=p_club_id AND m.user_id=actor AND m.status IN('active','approved')) THEN
  RETURN jsonb_build_object('success',false,'error','You Are Not An Active Member Of This Club','periods_claimed',0,'total_payout',0);END IF;
 RETURN jsonb_build_object('success',false,'code','automatic_weekly_settlement','error','Rakeback Is Settled Automatically Every Monday At 4:00 AM Central Time. View Invoices For Recorded Transfers.',
  'authority','fn_process_weekly_accounting','schedule','Monday 04:00 America/Chicago','periods_claimed',0,'total_payout',0,'club_id',p_club_id);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_settle_club_rakeback_batch(p_club_id uuid,p_max_periods integer DEFAULT 40,p_budget_seconds numeric DEFAULT 4.0,p_max_warm_days integer DEFAULT 2)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE actor uuid:=auth.uid();
BEGIN
 IF p_club_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=p_club_id AND c.is_union IS NOT TRUE) THEN
  RETURN jsonb_build_object('success',false,'error','club_not_found','periods_settled',0,'total_payout',0);END IF;
 IF NOT public.fn_caller_is_engine() THEN
  IF actor IS NULL OR (NOT public.fn_is_platform_admin() AND NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=p_club_id AND c.owner_id=actor)) THEN
   RETURN jsonb_build_object('success',false,'error','not_authorised','periods_settled',0,'total_payout',0);END IF;
  RETURN jsonb_build_object('success',false,'code','automatic_weekly_settlement','error','Rakeback Is Settled Automatically Every Monday At 4:00 AM Central Time.',
   'authority','fn_process_weekly_accounting','club_id',p_club_id,'periods_settled',0,'total_payout',0);
 END IF;
 -- A club compatibility request can process only that club's standalone books.
 -- It cannot widen to all clubs or impersonate a union-wide request.
 RETURN public.fn_process_weekly_accounting_scope(NULL,p_club_id);
END $function$;

CREATE OR REPLACE FUNCTION public.settle_club_rakeback(p_club_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN RETURN public.fn_settle_club_rakeback_batch(p_club_id,40,4.0,2);END $function$;

CREATE OR REPLACE FUNCTION public.fn_execute_union_rakeback(p_union_id uuid,p_period_start timestamptz,p_period_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE actor uuid:=auth.uid();owner uuid;reference_time timestamptz:=clock_timestamp();
BEGIN
 SELECT owner_id INTO owner FROM public.unions WHERE id=p_union_id;
 IF owner IS NULL THEN RETURN jsonb_build_object('success',false,'error','union_not_found','clubs_paid',0,'total_rakeback',0,'union_retained',0);END IF;
 IF NOT public.fn_caller_is_engine() THEN
  IF actor IS NULL OR actor<>owner THEN RETURN jsonb_build_object('success',false,'error','not_authorized','clubs_paid',0,'total_rakeback',0,'union_retained',0);END IF;
  RETURN jsonb_build_object('success',false,'code','automatic_weekly_settlement','error','Union Accounting Is Settled Automatically Every Monday At 4:00 AM Central Time.',
   'authority','fn_process_weekly_accounting','union_id',p_union_id,'clubs_paid',0,'total_rakeback',0,'union_retained',0);
 END IF;
 -- This compatibility signature cannot request an arbitrary historical or
 -- future week. The coordinator alone chooses due weeks and chronological repair.
 IF p_period_start IS DISTINCT FROM public.fn_union_prev_week_start(reference_time)
  OR p_period_end IS DISTINCT FROM public.fn_union_week_start(reference_time) THEN
  RETURN jsonb_build_object('success',false,'error','requested_period_requires_weekly_accounting','union_id',p_union_id,'clubs_paid',0,'total_rakeback',0,'union_retained',0);END IF;
 RETURN public.fn_process_weekly_accounting(p_union_id);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_run_pending_rakeback_settlement(p_max_clubs integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 IF NOT public.fn_caller_is_engine() THEN
  IF auth.uid() IS NULL OR NOT public.fn_is_platform_admin() THEN
   RETURN jsonb_build_object('success',false,'error','not_authorized','clubs_processed',0,'periods_settled',0,'total_payout',0);END IF;
  RETURN jsonb_build_object('success',false,'code','automatic_weekly_settlement','error','Accounting Is Settled Automatically Every Monday At 4:00 AM Central Time.',
   'authority','fn_process_weekly_accounting','clubs_processed',0,'periods_settled',0,'total_payout',0);
 END IF;
 -- The old p_max_clubs knob cannot create a competing per-club payout loop.
 -- The single coordinator owns its bounded due-work budget and durable results.
 RETURN public.fn_process_weekly_accounting(NULL);
END $function$;

REVOKE ALL ON FUNCTION public.fn_agent_claim_commission(uuid,uuid,integer),public.fn_claim_rakeback(uuid),public.settle_club_rakeback(uuid),public.fn_execute_union_rakeback(uuid,timestamptz,timestamptz),public.fn_run_pending_rakeback_settlement(integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_agent_claim_commission(uuid,uuid,integer),public.fn_claim_rakeback(uuid),public.settle_club_rakeback(uuid),public.fn_execute_union_rakeback(uuid,timestamptz,timestamptz),public.fn_run_pending_rakeback_settlement(integer) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_settle_club_rakeback_batch(uuid,integer,numeric,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_club_rakeback_batch(uuid,integer,numeric,integer) TO service_role;
-- Retain the old close body as historical evidence, but nobody can invoke it
-- through the API. Its two former definer callers have been replaced above.
REVOKE ALL ON FUNCTION public.fn_close_settlement_period(uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON FUNCTION public.fn_agent_claim_commission(uuid,uuid,integer) IS 'Retired manual payout: returns an explicit automatic weekly settlement refusal; never mutates balances or settlement records.';
COMMENT ON FUNCTION public.fn_claim_rakeback(uuid) IS 'Retired manual payout: returns an explicit automatic weekly settlement refusal; never calls the legacy period payer.';
COMMIT;
