\set ON_ERROR_STOP on
-- UNRUN. Isolated PostgreSQL 17 with the complete actual catalog and candidate.
BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='3s';
DO $guard$ BEGIN
 IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL OR current_setting('session_replication_role')<>'origin'
  OR to_regprocedure('public.fn_review_credit_request(uuid,text,numeric,text,uuid)') IS NULL
 THEN RAISE EXCEPTION 'isolated full credit request authority required';END IF;
END $guard$;
CREATE FUNCTION pg_temp.credit_check(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'credit request failed: %',label;END IF;
 RAISE NOTICE 'credit request passed: %',label;
END$$;
DO $schema$ DECLARE n name;BEGIN
 SELECT nspname INTO STRICT n FROM pg_namespace WHERE oid=pg_my_temp_schema();
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO authenticated',n);
END $schema$;
GRANT EXECUTE ON FUNCTION pg_temp.credit_check(boolean,text) TO authenticated;
-- Fixture-only whole-row snapshots bypass RLS so a caller cannot hide a
-- cross-club rewrite. Include every column/ID, including decision version,
-- plus the actual credit/audit/notification/outbox and accounting dependencies.
CREATE FUNCTION pg_temp.credit_state() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE relation_name text; rows_json jsonb; snapshot jsonb:='{}'::jsonb;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY[
  'agents','club_members','clubs','credit_requests','credit_assignments',
  'accounting_agreement_history','notifications','push_outbox','push_subscriptions',
  'settlement_invoices','accounting_invoice_deliveries','accounting_conversations',
  'social_messages','social_conversations','social_conversation_participants',
  'chip_ledger','wallet_transactions','chip_transactions','club_wallet_transactions',
  'union_wallet_transactions'
 ] LOOP
  EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM public.%I t',relation_name)
   INTO rows_json;
  snapshot:=snapshot||jsonb_build_object(relation_name,rows_json);
 END LOOP;
 RETURN snapshot;
END$$;
REVOKE ALL ON FUNCTION pg_temp.credit_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pg_temp.credit_state() TO authenticated;
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) SELECT ('e6460000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(1,7)n;
INSERT INTO public.users(id,username) SELECT ('e6460000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'credit_review_'||n FROM generate_series(1,7)n;
INSERT INTO public.profiles(id,username,display_name) SELECT ('e6460000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'credit_review_'||n,'Credit Review '||n FROM generate_series(1,7)n;
INSERT INTO public.clubs(id,club_id,name,owner_id,chip_treasury,is_union,asset) VALUES
 ('e6460000-0000-4000-8000-000000000101',964601,'Credit Review Club','e6460000-0000-4000-8000-000000000001',0,false,'chips'),
 ('e6460000-0000-4000-8000-000000000102',964602,'Other Credit Club','e6460000-0000-4000-8000-000000000004',0,false,'chips');
INSERT INTO public.club_members(club_id,user_id,role,status,is_active,membership_lifecycle_status,chip_balance) VALUES
 ('e6460000-0000-4000-8000-000000000101','e6460000-0000-4000-8000-000000000001','owner','active',true,'active',0),
 ('e6460000-0000-4000-8000-000000000101','e6460000-0000-4000-8000-000000000002','agent','active',true,'active',0),
 ('e6460000-0000-4000-8000-000000000101','e6460000-0000-4000-8000-000000000003','admin','suspended',false,'active',0),
 ('e6460000-0000-4000-8000-000000000101','e6460000-0000-4000-8000-000000000005','super_agent','active',true,'active',0),
 ('e6460000-0000-4000-8000-000000000101','e6460000-0000-4000-8000-000000000006','admin','active',true,'active',0),
 ('e6460000-0000-4000-8000-000000000101','e6460000-0000-4000-8000-000000000007','co_owner','approved',true,'active',0),
 ('e6460000-0000-4000-8000-000000000102','e6460000-0000-4000-8000-000000000002','agent','active',true,'active',0);
INSERT INTO public.agents(id,club_id,user_id,role,status,commission_rate,player_rakeback_rate,credit_limit,credit_used,is_prepaid) VALUES
 ('e6460000-0000-4000-8000-000000000201','e6460000-0000-4000-8000-000000000101','e6460000-0000-4000-8000-000000000002','agent','active',0,0,100,25,false),
 ('e6460000-0000-4000-8000-000000000202','e6460000-0000-4000-8000-000000000102','e6460000-0000-4000-8000-000000000002','agent','active',0,0,500,0,false);
INSERT INTO public.credit_requests(id,requester_id,approver_id,club_id,requested_amount,approved_amount,status,reviewed_at,reviewed_by)
 VALUES('e6460000-0000-4000-8000-000000000308','e6460000-0000-4000-8000-000000000002','e6460000-0000-4000-8000-000000000001',
 'e6460000-0000-4000-8000-000000000101',150,150,'approved',transaction_timestamp(),'e6460000-0000-4000-8000-000000000001');
SET LOCAL session_replication_role=origin;
CREATE TEMP TABLE legacy_credit_before AS SELECT to_jsonb(r) AS body FROM public.credit_requests r WHERE id='e6460000-0000-4000-8000-000000000308';
SET LOCAL request.jwt.claim.role='authenticated';
SET LOCAL request.jwt.claim.sub='e6460000-0000-4000-8000-000000000002';
SET LOCAL request.jwt.claims='{"role":"authenticated","sub":"e6460000-0000-4000-8000-000000000002"}';
SET LOCAL ROLE authenticated;
INSERT INTO public.credit_requests(id,requester_id,approver_id,club_id,requested_amount,reason)
 SELECT ('e6460000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 'e6460000-0000-4000-8000-000000000002','e6460000-0000-4000-8000-000000000001',
 'e6460000-0000-4000-8000-000000000101',150,'Synthetic qualification request' FROM generate_series(301,307)n;
SELECT pg_temp.credit_check((SELECT count(*)=8 FROM public.credit_requests WHERE requester_id=auth.uid()),'actual requester creation and own read retained');
RESET ROLE;
SELECT pg_temp.credit_check((SELECT count(*)=7 FROM public.notifications WHERE type='credit_request'
 AND data->>'clubId'='e6460000-0000-4000-8000-000000000101'
 AND user_id='e6460000-0000-4000-8000-000000000001'
 AND link='/credit-admin?club=e6460000-0000-4000-8000-000000000101'),'new requests notify the exact approver through the club manager inbox');
SET LOCAL ROLE authenticated;
DO $forged$ BEGIN
 BEGIN
  INSERT INTO public.credit_requests(requester_id,club_id,requested_amount,status,approved_amount)
   VALUES(auth.uid(),'e6460000-0000-4000-8000-000000000101',150,'approved',150);
  RAISE EXCEPTION 'forged approval insert accepted';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'credit_request_must_start_pending' THEN RAISE;END IF;END;
END $forged$;
DO $creation_guard$ DECLARE amount numeric;before_state jsonb;BEGIN
 before_state:=pg_temp.credit_state();
 FOREACH amount IN ARRAY ARRAY[0::numeric,-1::numeric,'NaN'::numeric,'Infinity'::numeric,150.001::numeric] LOOP
  BEGIN
   INSERT INTO public.credit_requests(requester_id,approver_id,club_id,requested_amount)
    VALUES(auth.uid(),'e6460000-0000-4000-8000-000000000001','e6460000-0000-4000-8000-000000000101',amount);
   RAISE EXCEPTION 'invalid creation amount accepted';
  EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'credit_request_amount_must_be_positive_cents' THEN RAISE;END IF;END;
 END LOOP;
 BEGIN
  INSERT INTO public.credit_requests(requester_id,club_id,requested_amount)
   VALUES(auth.uid(),'e6460000-0000-4000-8000-000000000101',150);
  RAISE EXCEPTION 'creation with no approver accepted';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'credit_request_approver_invalid' THEN RAISE;END IF;END;
 BEGIN
  INSERT INTO public.credit_requests(requester_id,approver_id,club_id,requested_amount)
   VALUES(auth.uid(),'e6460000-0000-4000-8000-000000000003','e6460000-0000-4000-8000-000000000101',150);
  RAISE EXCEPTION 'creation to suspended manager accepted';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'credit_request_approver_invalid' THEN RAISE;END IF;END;
 BEGIN
  INSERT INTO public.credit_requests(requester_id,approver_id,club_id,requested_amount)
   VALUES(auth.uid(),'e6460000-0000-4000-8000-000000000005','e6460000-0000-4000-8000-000000000101',150);
  RAISE EXCEPTION 'creation to non-manager parent accepted';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'credit_request_approver_invalid' THEN RAISE;END IF;END;
 BEGIN
  INSERT INTO public.credit_requests(requester_id,approver_id,club_id,requested_amount,decision_authority_version)
   VALUES(auth.uid(),'e6460000-0000-4000-8000-000000000001','e6460000-0000-4000-8000-000000000101',150,1);
  RAISE EXCEPTION 'creation with fabricated authority accepted';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'credit_request_must_start_pending' THEN RAISE;END IF;END;
 PERFORM pg_temp.credit_check(pg_temp.credit_state()=before_state,'invalid creation intents preserve all request, credit, notice and delivery rows');
END $creation_guard$;
SELECT pg_temp.credit_check(NOT EXISTS(SELECT 1 FROM public.club_members WHERE club_id='e6460000-0000-4000-8000-000000000101'
 AND user_id IN('e6460000-0000-4000-8000-000000000006','e6460000-0000-4000-8000-000000000007')),
 'ordinary requester cannot see non-owner admin or co-owner upline membership through roster RLS');
INSERT INTO public.credit_requests(id,requester_id,approver_id,club_id,requested_amount)
 VALUES('e6460000-0000-4000-8000-000000000311',auth.uid(),'e6460000-0000-4000-8000-000000000006','e6460000-0000-4000-8000-000000000101',150),
 ('e6460000-0000-4000-8000-000000000312',auth.uid(),'e6460000-0000-4000-8000-000000000007','e6460000-0000-4000-8000-000000000101',150);
SELECT pg_temp.credit_check((SELECT count(*)=2 FROM public.credit_requests WHERE id IN('e6460000-0000-4000-8000-000000000311','e6460000-0000-4000-8000-000000000312')),
 'private INSERT validator accepts active non-owner admin and approved co-owner without broadening roster reads');
RESET ROLE;
SELECT pg_temp.credit_check(NOT has_function_privilege('authenticated','public.fn_guard_credit_request_creation()','EXECUTE')
 AND NOT has_function_privilege('service_role','public.fn_guard_credit_request_creation()','EXECUTE')
 AND (SELECT prosecdef AND proconfig=ARRAY['search_path=public']::text[] FROM pg_proc WHERE oid='public.fn_guard_credit_request_creation()'::regprocedure)
 AND NOT (SELECT prosecdef FROM pg_proc WHERE oid='public.fn_guard_credit_request_decision()'::regprocedure),
 'private creation validator retains exact configuration and INVOKER decision authority');
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claim.sub='';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SET LOCAL ROLE service_role;
DO $no_actor$ BEGIN
 BEGIN
  INSERT INTO public.credit_requests(requester_id,approver_id,club_id,requested_amount)
   VALUES('e6460000-0000-4000-8000-000000000002','e6460000-0000-4000-8000-000000000001','e6460000-0000-4000-8000-000000000101',150);
  RAISE EXCEPTION 'service request impersonation with no actor accepted';
 EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'credit_request_requester_identity_required' THEN RAISE;END IF;END;
END $no_actor$;
RESET ROLE;
SET LOCAL request.jwt.claim.role='authenticated';
SET LOCAL request.jwt.claim.sub='e6460000-0000-4000-8000-000000000001';
SET LOCAL request.jwt.claims='{"role":"authenticated","sub":"e6460000-0000-4000-8000-000000000001"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.credit_check(public.fn_review_credit_request('e6460000-0000-4000-8000-000000000301','approved',p_expected_actor_id=>auth.uid())->>'success'='true','canonical club owner approval');
DO $writes$ DECLARE before_state jsonb; BEGIN
 before_state:=pg_temp.credit_state();
 BEGIN
  PERFORM public.fn_review_credit_request('e6460000-0000-4000-8000-000000000308','approved',p_expected_actor_id=>auth.uid());
  RAISE EXCEPTION 'legacy split review certified as replay';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'credit_request_legacy_review_unverified' THEN RAISE;END IF;END;
 PERFORM pg_temp.credit_check(pg_temp.credit_state()=before_state,'legacy review refusal preserves all request, credit, audit and delivery rows');
 BEGIN
  PERFORM public.fn_review_credit_request('e6460000-0000-4000-8000-000000000302','approved',p_expected_actor_id=>'e6460000-0000-4000-8000-000000000004');
  RAISE EXCEPTION 'changed account intent accepted';
 EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'credit_request_actor_changed' THEN RAISE;END IF;END;
 BEGIN
  UPDATE public.credit_requests SET status='approved' WHERE id='e6460000-0000-4000-8000-000000000302';
  RAISE EXCEPTION 'direct decision accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN
  PERFORM public.fn_review_credit_request('e6460000-0000-4000-8000-000000000302','approved',0,p_expected_actor_id=>auth.uid());
  RAISE EXCEPTION 'zero replaced by requested amount';
 EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'credit_request_amount_must_be_positive_cents' THEN RAISE;END IF;END;
 BEGIN
  PERFORM public.fn_review_credit_request('e6460000-0000-4000-8000-000000000302','approved',150.001,p_expected_actor_id=>auth.uid());
  RAISE EXCEPTION 'fractional cent accepted';
 EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'credit_request_amount_must_be_positive_cents' THEN RAISE;END IF;END;
 BEGIN
  PERFORM public.fn_review_credit_request('e6460000-0000-4000-8000-000000000303','approved',20,p_expected_actor_id=>auth.uid());
  RAISE EXCEPTION 'below-drawn credit approved';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'credit_request_credit_authority_refused' THEN RAISE;END IF;END;
END $writes$;
SELECT pg_temp.credit_check(public.fn_admin_update_agent(p_agent_id=>'e6460000-0000-4000-8000-000000000201',p_credit_limit=>175)->>'success'='true','later independent credit limit change');
DO $replay$ DECLARE before_state jsonb;receipt jsonb;BEGIN
 before_state:=pg_temp.credit_state();
 receipt:=public.fn_review_credit_request('e6460000-0000-4000-8000-000000000301','approved',p_expected_actor_id=>auth.uid());
 PERFORM pg_temp.credit_check(receipt->>'replayed'='true','same decision returns original receipt');
 PERFORM pg_temp.credit_check(jsonb_typeof(receipt->'request'->'requested_amount')='string'
  AND jsonb_typeof(receipt->'request'->'approved_amount')='string'
  AND (receipt->'request'->>'requested_amount')::numeric=150
  AND (receipt->'request'->>'approved_amount')::numeric=150,'receipt transports exact stored decimals as strings');
 PERFORM pg_temp.credit_check(pg_temp.credit_state()=before_state,'approval replay preserves every request, credit, audit, notice and delivery row');
END $replay$;
DO $conflict$ DECLARE before_state jsonb;BEGIN
 before_state:=pg_temp.credit_state();
 BEGIN
  PERFORM public.fn_review_credit_request('e6460000-0000-4000-8000-000000000301','approved',175,p_expected_actor_id=>auth.uid());
  RAISE EXCEPTION 'changed decision accepted';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'credit_request_decision_conflict' THEN RAISE;END IF;END;
 PERFORM pg_temp.credit_check(pg_temp.credit_state()=before_state,'different amount refusal preserves every authority row');
 BEGIN
  PERFORM public.fn_review_credit_request('e6460000-0000-4000-8000-000000000301','denied',p_expected_actor_id=>auth.uid());
  RAISE EXCEPTION 'approved request denied later';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'credit_request_decision_conflict' THEN RAISE;END IF;END;
 PERFORM pg_temp.credit_check(pg_temp.credit_state()=before_state,'different decision refusal preserves every authority row');
END $conflict$;
RESET ROLE;
SELECT pg_temp.credit_check((SELECT body FROM legacy_credit_before)=(SELECT to_jsonb(r) FROM public.credit_requests r WHERE id='e6460000-0000-4000-8000-000000000308')
 AND NOT EXISTS(SELECT 1 FROM public.notifications WHERE data->>'creditRequestId'='e6460000-0000-4000-8000-000000000308'),'unverified historical review remains byte-identical with no new notice');
SELECT pg_temp.credit_check((SELECT credit_limit=175 AND credit_used=25 FROM public.agents WHERE id='e6460000-0000-4000-8000-000000000201')
 AND (SELECT credit_limit=500 FROM public.agents WHERE id='e6460000-0000-4000-8000-000000000202'),'retry preserves later limit and other club account');
SELECT pg_temp.credit_check((SELECT count(*)=1 FROM public.notifications WHERE data->>'creditRequestId'='e6460000-0000-4000-8000-000000000301' AND type='credit_approved'),'approval sends one surviving notification');
SELECT pg_temp.credit_check((SELECT status='pending' AND reviewed_at IS NULL FROM public.credit_requests WHERE id='e6460000-0000-4000-8000-000000000303'),'admin refusal preserves pending request');

-- Failed or silently suppressed final notification must undo the credit
-- authority's earlier agent/audit/history updates as well as the decision.
CREATE FUNCTION pg_temp.reject_credit_notification() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.type='credit_approved' AND NEW.data->>'creditRequestId'='e6460000-0000-4000-8000-000000000304' THEN RETURN NULL;END IF;
 IF NEW.type='credit_approved' AND NEW.data->>'creditRequestId'='e6460000-0000-4000-8000-000000000305' THEN RAISE EXCEPTION 'fixture_credit_notice_failure';END IF;
 IF NEW.type='credit_request' AND NEW.data->>'creditRequestId'='e6460000-0000-4000-8000-000000000309' THEN RETURN NULL;END IF;
 IF NEW.type='credit_request' AND NEW.data->>'creditRequestId'='e6460000-0000-4000-8000-000000000310' THEN RAISE EXCEPTION 'fixture_credit_creation_notice_failure';END IF;
 IF NEW.type='credit_cancelled' AND NEW.data->>'creditRequestId'='e6460000-0000-4000-8000-000000000307'
  AND NEW.user_id='e6460000-0000-4000-8000-000000000002' THEN RETURN NULL;END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER fixture_credit_notice_failure BEFORE INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_credit_notification();
SET LOCAL ROLE authenticated;
DO $failure$ DECLARE before_state jsonb;BEGIN
 before_state:=pg_temp.credit_state();
 BEGIN
  PERFORM public.fn_review_credit_request('e6460000-0000-4000-8000-000000000304','approved',200,p_expected_actor_id=>auth.uid());
  RAISE EXCEPTION 'silently missing notification accepted';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'credit_request_notification_missing' THEN RAISE;END IF;END;
 PERFORM pg_temp.credit_check(pg_temp.credit_state()=before_state,'silently suppressed notice rolls back complete request, agent, audit, agreement, notice, outbox and delivery rows');
 before_state:=pg_temp.credit_state();
 BEGIN
  PERFORM public.fn_review_credit_request('e6460000-0000-4000-8000-000000000305','approved',200,p_expected_actor_id=>auth.uid());
  RAISE EXCEPTION 'failed notification accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'fixture_credit_notice_failure' THEN RAISE;END IF;END;
 PERFORM pg_temp.credit_check(pg_temp.credit_state()=before_state,'raised notice error rolls back complete request, agent, audit, agreement, notice, outbox and delivery rows');
END $failure$;
RESET ROLE;
SET LOCAL request.jwt.claim.sub='e6460000-0000-4000-8000-000000000002';
SET LOCAL request.jwt.claims='{"role":"authenticated","sub":"e6460000-0000-4000-8000-000000000002"}';
SET LOCAL ROLE authenticated;
DO $creation_failure$ DECLARE before_state jsonb;BEGIN
 before_state:=pg_temp.credit_state();
 BEGIN
  INSERT INTO public.credit_requests(id,requester_id,approver_id,club_id,requested_amount)
   VALUES('e6460000-0000-4000-8000-000000000309',auth.uid(),'e6460000-0000-4000-8000-000000000001','e6460000-0000-4000-8000-000000000101',200);
  RAISE EXCEPTION 'creation with missing notice accepted';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'credit_request_notification_missing' THEN RAISE;END IF;END;
 PERFORM pg_temp.credit_check(pg_temp.credit_state()=before_state,'missing creation notice rolls back every request, credit, audit and delivery row');
 before_state:=pg_temp.credit_state();
 BEGIN
  INSERT INTO public.credit_requests(id,requester_id,approver_id,club_id,requested_amount)
   VALUES('e6460000-0000-4000-8000-000000000310',auth.uid(),'e6460000-0000-4000-8000-000000000001','e6460000-0000-4000-8000-000000000101',200);
  RAISE EXCEPTION 'creation with failed notice accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'fixture_credit_creation_notice_failure' THEN RAISE;END IF;END;
 PERFORM pg_temp.credit_check(pg_temp.credit_state()=before_state,'raised creation notice failure rolls back every request, credit, audit and delivery row');
 before_state:=pg_temp.credit_state();
 BEGIN
  PERFORM public.fn_review_credit_request('e6460000-0000-4000-8000-000000000307','cancelled',p_expected_actor_id=>auth.uid());
  RAISE EXCEPTION 'cancellation with missing recipient notice accepted';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'credit_request_notification_missing' THEN RAISE;END IF;END;
 PERFORM pg_temp.credit_check(pg_temp.credit_state()=before_state,'missing second cancellation notice rolls back the first notice, request and every authority row');
END $creation_failure$;
RESET ROLE;
DROP TRIGGER fixture_credit_notice_failure ON public.notifications;

-- Actual identities with no current management authority cannot review.
DO $unauthorized$ DECLARE n integer;actor text;BEGIN
 FOREACH n IN ARRAY ARRAY[3,4,5] LOOP
  actor:='e6460000-0000-4000-8000-'||lpad(n::text,12,'0');
  PERFORM set_config('request.jwt.claim.sub',actor,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
   PERFORM public.fn_review_credit_request('e6460000-0000-4000-8000-000000000303','approved',p_expected_actor_id=>auth.uid());
   RAISE EXCEPTION 'unqualified manager accepted';
  EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'credit_request_manager_required' THEN RAISE;END IF;END;
  EXECUTE 'RESET ROLE';
 END LOOP;
END $unauthorized$;
SET LOCAL request.jwt.claim.sub='e6460000-0000-4000-8000-000000000001';
SET LOCAL request.jwt.claims='{"role":"authenticated","sub":"e6460000-0000-4000-8000-000000000001"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.credit_check(public.fn_review_credit_request('e6460000-0000-4000-8000-000000000306','denied',NULL,'Not approved',p_expected_actor_id=>auth.uid())->>'success'='true','denial records one terminal decision');
SELECT pg_temp.credit_check(public.fn_review_credit_request('e6460000-0000-4000-8000-000000000306','denied',NULL,'Not approved',p_expected_actor_id=>auth.uid())->>'replayed'='true','denial replay has no new event');
RESET ROLE;
SET LOCAL request.jwt.claim.sub='e6460000-0000-4000-8000-000000000002';
SET LOCAL request.jwt.claims='{"role":"authenticated","sub":"e6460000-0000-4000-8000-000000000002"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.credit_check(public.fn_review_credit_request('e6460000-0000-4000-8000-000000000307','cancelled',p_expected_actor_id=>auth.uid())->>'success'='true','requester cancels own pending request');
DO $cancel_replay$ DECLARE before_state jsonb;BEGIN
 before_state:=pg_temp.credit_state();
 PERFORM pg_temp.credit_check(public.fn_review_credit_request('e6460000-0000-4000-8000-000000000307','cancelled',p_expected_actor_id=>auth.uid())->>'replayed'='true','cancellation replay is stable');
 PERFORM pg_temp.credit_check(pg_temp.credit_state()=before_state,'cancellation replay preserves all notices and authority rows');
END $cancel_replay$;
RESET ROLE;
SELECT pg_temp.credit_check((SELECT count(*)=1 FROM public.notifications WHERE data->>'creditRequestId'='e6460000-0000-4000-8000-000000000306' AND type='credit_denied')
 AND (SELECT credit_limit=175 FROM public.agents WHERE id='e6460000-0000-4000-8000-000000000201'),'denial and cancellation preserve credit and one notice');
SELECT pg_temp.credit_check((SELECT count(*)=2 AND count(DISTINCT user_id)=2
 FROM public.notifications WHERE data->>'creditRequestId'='e6460000-0000-4000-8000-000000000307' AND type='credit_cancelled')
 AND EXISTS(SELECT 1 FROM public.notifications WHERE data->>'creditRequestId'='e6460000-0000-4000-8000-000000000307'
  AND type='credit_cancelled' AND user_id='e6460000-0000-4000-8000-000000000001' AND link='/credit-admin?club=e6460000-0000-4000-8000-000000000101')
 AND EXISTS(SELECT 1 FROM public.notifications WHERE data->>'creditRequestId'='e6460000-0000-4000-8000-000000000307'
  AND type='credit_cancelled' AND user_id='e6460000-0000-4000-8000-000000000002' AND link='/clubs/e6460000-0000-4000-8000-000000000101/agent-dashboard'),
 'cancellation notifies requester and approver once with club-scoped links');
-- Valid large decimals must remain exact in the receipt and notification;
-- a fixed-width number mask can otherwise display only overflow markers.
SET LOCAL request.jwt.claim.sub='e6460000-0000-4000-8000-000000000001';
SET LOCAL request.jwt.claims='{"role":"authenticated","sub":"e6460000-0000-4000-8000-000000000001"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.credit_check(public.fn_review_credit_request('e6460000-0000-4000-8000-000000000302','approved',1000000000000.25,p_expected_actor_id=>auth.uid())
 ->'request'->>'approved_amount'='1000000000000.25','large exact approved amount is transported without numeric rounding');
RESET ROLE;
SELECT pg_temp.credit_check((SELECT message='Your credit line is now 1000000000000.25 chips' FROM public.notifications
 WHERE data->>'creditRequestId'='e6460000-0000-4000-8000-000000000302' AND type='credit_approved'),'large approval notice contains the exact amount without mask overflow');
ROLLBACK;
