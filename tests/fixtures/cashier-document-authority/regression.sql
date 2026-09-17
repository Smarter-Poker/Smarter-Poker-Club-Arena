\set ON_ERROR_STOP on
-- SOURCE ONLY / UNRUN. Run only through the admitted isolated full-catalog job.
BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='3s';
DO $guard$ BEGIN
 IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL OR current_setting('session_replication_role')<>'origin'
  OR to_regprocedure('public.fn_cashout_request_v2(uuid,numeric,uuid,uuid,text)') IS NULL
 THEN RAISE EXCEPTION 'isolated complete cashier authority required';END IF;
END $guard$;
CREATE FUNCTION pg_temp.cashier_check(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'cashier fixture failed: %',label;END IF;
 RAISE NOTICE 'cashier fixture passed: %',label;
END$$;
CREATE FUNCTION pg_temp.cashier_actor(who uuid,role_name text DEFAULT 'authenticated') RETURNS void LANGUAGE plpgsql AS $$BEGIN
 PERFORM set_config('request.jwt.claim.sub',COALESCE(who::text,''),true);
 PERFORM set_config('request.jwt.claim.role',role_name,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('role',role_name,'sub',who)::text,true);
END$$;
DO $temp$ DECLARE n name;BEGIN
 SELECT nspname INTO STRICT n FROM pg_namespace WHERE oid=pg_my_temp_schema();
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO authenticated,service_role',n);
END $temp$;
-- Full rows and IDs, not only counts or selected balances. Sequence gaps are
-- deliberately not a financial rollback claim: PostgreSQL sequences do not roll back.
CREATE FUNCTION pg_temp.cashier_state() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE relation_name text;rows_json jsonb;result jsonb:='{}';BEGIN
 FOREACH relation_name IN ARRAY ARRAY['clubs','club_members','agents','cashout_requests','chip_escrow','chip_ledger','chip_ledger_idem',
  'chip_transactions','wallet_transactions','club_wallet_transactions','union_wallet_transactions',
  'accounting_cashier_events','settlement_invoices','accounting_invoice_deliveries','accounting_conversations',
  'social_messages','social_conversations','social_conversation_participants','notifications','push_outbox','push_subscriptions',
  'credit_assignments','accounting_agreement_history','messages'] LOOP
  EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM public.%I t',relation_name) INTO rows_json;
  result:=result||jsonb_build_object(relation_name,rows_json);
 END LOOP;
 RETURN result;
END$$;
CREATE FUNCTION pg_temp.cashier_receipt_check(receipt jsonb,kind text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.accounting_cashier_events%ROWTYPE;i public.settlement_invoices%ROWTYPE;d record;payload jsonb;field text;BEGIN
 SELECT * INTO STRICT e FROM public.accounting_cashier_events WHERE id=(receipt->>'event_id')::uuid;
 SELECT * INTO STRICT i FROM public.settlement_invoices WHERE id=e.invoice_id;
 payload:=public.fn_cashier_assert_delivery(e.id);
 PERFORM pg_temp.cashier_check(receipt->'cashier'=payload AND receipt->>'event_kind'=kind,'canonical shared receipt '||kind);
 FOR field IN SELECT jsonb_object_keys(payload) LOOP
  PERFORM pg_temp.cashier_check(receipt->field=payload->field,'top-level exact mirror '||field);
 END LOOP;
 PERFORM pg_temp.cashier_check(i.invoice_type='cashier_cashout' AND i.net_amount=e.amount AND i.source_ledger_id=e.source_ledger_id,
  'one invoice linked to the actual physical ledger');
 PERFORM pg_temp.cashier_check((SELECT count(*)=1 FROM public.chip_ledger WHERE idempotency_key='cashout:'||e.cashout_id||CASE WHEN kind='hold' THEN ':hold' ELSE ':release' END),
  'one keyed custody leg');
 PERFORM pg_temp.cashier_check(i.status=CASE WHEN kind='hold' THEN 'generated' ELSE 'paid' END
   AND i.chips_transferred=(kind<>'hold') AND NOT(payload ? 'wallet_before') AND NOT(payload ? 'wallet_after'),
  'typed hold/terminal semantics and no private wallet balance');
 FOR d IN SELECT a.*,m.content,m.media_metadata,n.data FROM public.accounting_invoice_deliveries a
  JOIN public.social_messages m ON m.id=a.message_id JOIN public.notifications n ON n.id=a.notification_id WHERE a.invoice_id=i.id LOOP
  PERFORM pg_temp.cashier_check(d.media_metadata->'cashier'=payload AND d.data->'cashier'=payload,'same canonical invoice in Messenger and notice');
 END LOOP;
END$$;
REVOKE ALL ON FUNCTION pg_temp.cashier_state(),pg_temp.cashier_receipt_check(jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pg_temp.cashier_check(boolean,text),pg_temp.cashier_actor(uuid,text),pg_temp.cashier_state(),pg_temp.cashier_receipt_check(jsonb,text) TO authenticated,service_role;
CREATE TEMP TABLE cashier_receipts(label text PRIMARY KEY,receipt jsonb NOT NULL);
GRANT SELECT,INSERT,UPDATE ON cashier_receipts TO authenticated,service_role;

-- Replica is restricted to constructing synthetic baseline rows. Actual calls
-- below use origin triggers and real authenticated/service roles and grants.
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) SELECT ('e6470000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(1,8)n;
INSERT INTO public.users(id,username) SELECT ('e6470000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'cashier_receipt_'||n FROM generate_series(1,8)n;
INSERT INTO public.profiles(id,username,display_name) SELECT ('e6470000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'cashier_receipt_'||n,'Cashier Receipt '||n FROM generate_series(1,8)n;
INSERT INTO auth.users(id) VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d') ON CONFLICT(id) DO NOTHING;
INSERT INTO public.users(id,username) VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d','cashier_system_fixture') ON CONFLICT(id) DO NOTHING;
INSERT INTO public.profiles(id,username) VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d','cashier_system_fixture') ON CONFLICT(id) DO NOTHING;
INSERT INTO public.clubs(id,club_id,name,owner_id,chip_treasury,is_union,asset) VALUES
 ('e6470000-0000-4000-8000-000000000101',964701,'Cashier Receipt Club','e6470000-0000-4000-8000-000000000001',0,false,'chips'),
 ('e6470000-0000-4000-8000-000000000102',964702,'Other Cashier Club','e6470000-0000-4000-8000-000000000006',0,false,'chips');
INSERT INTO public.club_members(club_id,user_id,role,status,is_active,membership_lifecycle_status,chip_balance,agent_id)
 SELECT 'e6470000-0000-4000-8000-000000000101',('e6470000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 CASE n WHEN 1 THEN 'owner' WHEN 3 THEN 'agent' WHEN 4 THEN 'admin' WHEN 5 THEN 'admin' ELSE 'player' END,
 'active',true,'active',CASE WHEN n IN(2,7,8) THEN 1000 ELSE 0 END,
 CASE WHEN n IN(2,7,8) THEN 'e6470000-0000-4000-8000-000000000003'::uuid ELSE NULL END FROM generate_series(1,8)n WHERE n<>6;
INSERT INTO public.club_members(club_id,user_id,role,status,is_active,membership_lifecycle_status,chip_balance)
 VALUES('e6470000-0000-4000-8000-000000000102','e6470000-0000-4000-8000-000000000006','owner','active',true,'active',0);
INSERT INTO public.agents(id,club_id,user_id,role,status,commission_rate,player_rakeback_rate,credit_limit,credit_used,is_prepaid,agent_wallet_balance)
 VALUES('e6470000-0000-4000-8000-000000000203','e6470000-0000-4000-8000-000000000101','e6470000-0000-4000-8000-000000000003','agent','active',0,0,0,0,true,0);
-- Two old unsupported liabilities: no invented hold leg, transaction or document.
INSERT INTO public.cashout_requests(id,club_id,player_id,agent_id,amount,status,created_at,updated_at) VALUES
 ('e6470000-0000-4000-8000-000000000501','e6470000-0000-4000-8000-000000000101','e6470000-0000-4000-8000-000000000007','e6470000-0000-4000-8000-000000000003',25,'pending',now()-interval '96 hours',now()-interval '96 hours'),
 ('e6470000-0000-4000-8000-000000000502','e6470000-0000-4000-8000-000000000101','e6470000-0000-4000-8000-000000000008','e6470000-0000-4000-8000-000000000003','NaN','pending',now()-interval '96 hours',now()-interval '96 hours');
INSERT INTO public.chip_escrow(id,cashout_request_id,club_id,player_id,amount,locked_at) VALUES
 ('e6470000-0000-4000-8000-000000000601','e6470000-0000-4000-8000-000000000501','e6470000-0000-4000-8000-000000000101','e6470000-0000-4000-8000-000000000007',25,now()-interval '96 hours'),
 ('e6470000-0000-4000-8000-000000000602','e6470000-0000-4000-8000-000000000502','e6470000-0000-4000-8000-000000000101','e6470000-0000-4000-8000-000000000008','NaN',now()-interval '96 hours');
SET LOCAL session_replication_role=origin;
CREATE TEMP TABLE legacy_cashier_before AS SELECT pg_temp.cashier_state()->'cashout_requests' AS requests,pg_temp.cashier_state()->'chip_escrow' AS escrow;

SELECT pg_temp.cashier_actor('e6470000-0000-4000-8000-000000000002');
SET LOCAL ROLE authenticated;
DO $invalid$ DECLARE amount numeric;before_state jsonb;BEGIN
 FOREACH amount IN ARRAY ARRAY[0::numeric,-1::numeric,'NaN'::numeric,'Infinity'::numeric,1.001::numeric,1000000001::numeric] LOOP
  before_state:=pg_temp.cashier_state();
  BEGIN
   PERFORM public.fn_cashout_request_v2('e6470000-0000-4000-8000-000000000101',amount,auth.uid(),'e6470000-0000-4000-8000-000000000301');
   RAISE EXCEPTION 'invalid amount accepted';
  EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'cashier_invalid_amount' THEN RAISE;END IF;END;
  PERFORM pg_temp.cashier_check(pg_temp.cashier_state()=before_state,'invalid amount leaves all authoritative rows unchanged');
 END LOOP;
 before_state:=pg_temp.cashier_state();
 BEGIN PERFORM public.fn_cashout_request_v2('e6470000-0000-4000-8000-000000000101',10,'e6470000-0000-4000-8000-000000000001','e6470000-0000-4000-8000-000000000301');
  RAISE EXCEPTION 'account-switched intent accepted';
 EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'cashier_account_changed' THEN RAISE;END IF;END;
 BEGIN PERFORM public.fn_cashout_request('e6470000-0000-4000-8000-000000000101',10);
  RAISE EXCEPTION 'legacy writer accepted';
 EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'cashier_v2_intent_required' THEN RAISE;END IF;END;
 PERFORM pg_temp.cashier_check(pg_temp.cashier_state()=before_state,'identity and legacy route refusals leave state unchanged');
 before_state:=pg_temp.cashier_state();
 BEGIN PERFORM public.fn_cashout_approve('e6470000-0000-4000-8000-000000000501','Retired approval probe','e6470000-0000-4000-8000-000000000304');
  RAISE EXCEPTION 'legacy authenticated approve writer accepted';
 EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'cashier_v2_intent_required' THEN RAISE;END IF;END;
 PERFORM pg_temp.cashier_check(pg_temp.cashier_state()=before_state,'legacy authenticated approve refuses without changing any authoritative row');
 before_state:=pg_temp.cashier_state();
 BEGIN PERFORM public.fn_cashout_release('e6470000-0000-4000-8000-000000000501','Retired release probe','e6470000-0000-4000-8000-000000000305');
  RAISE EXCEPTION 'legacy authenticated release writer accepted';
 EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'cashier_v2_intent_required' THEN RAISE;END IF;END;
 PERFORM pg_temp.cashier_check(pg_temp.cashier_state()=before_state,'legacy authenticated release refuses without changing any authoritative row');
END $invalid$;
INSERT INTO cashier_receipts VALUES('hold_approval',public.fn_cashout_request_v2('e6470000-0000-4000-8000-000000000101',10.25,auth.uid(),'e6470000-0000-4000-8000-000000000311',' First hold '));
SELECT pg_temp.cashier_receipt_check(receipt,'hold') FROM cashier_receipts WHERE label='hold_approval';
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.cashier_check((SELECT count(*)=3 FROM public.push_outbox o JOIN public.accounting_invoice_deliveries d ON d.notification_id=o.accounting_notification_id
 WHERE d.invoice_id=(SELECT (receipt->>'invoice_id')::uuid FROM cashier_receipts WHERE label='hold_approval')),'durable deferred outbox for all three actual participants');
SELECT pg_temp.cashier_check(NOT EXISTS(SELECT 1 FROM public.notifications WHERE user_id='e6470000-0000-4000-8000-000000000005'
 AND data->>'invoice_id'=(SELECT receipt->>'invoice_id' FROM cashier_receipts WHERE label='hold_approval')),'unrelated admin gets no cashier invoice');
SET LOCAL ROLE authenticated;
DO $replay$ DECLARE prior jsonb;again jsonb;before_state jsonb;BEGIN
 SELECT receipt INTO prior FROM cashier_receipts WHERE label='hold_approval';before_state:=pg_temp.cashier_state();
 again:=public.fn_cashout_request_v2('e6470000-0000-4000-8000-000000000101',10.25,auth.uid(),'e6470000-0000-4000-8000-000000000311','First hold');
 PERFORM pg_temp.cashier_check(again->>'replayed'='true' AND (again-'replayed')=(prior-'replayed') AND pg_temp.cashier_state()=before_state,
  'exact lost-response replay adds no ledger, document, notification or audit rewrite');
 again:=public.fn_cashout_operation_receipt_v2(auth.uid(),'e6470000-0000-4000-8000-000000000311','hold',
  'e6470000-0000-4000-8000-000000000101',10.25,NULL,' First hold ');
 PERFORM pg_temp.cashier_check(again=jsonb_build_object('contract_version',1,'found',true,'actor_user_id',auth.uid(),
  'op_id','e6470000-0000-4000-8000-000000000311','action','hold','club_id','e6470000-0000-4000-8000-000000000101',
  'amount','10.25','cashout_id',NULL,'accepted_note','First hold','receipt',prior||'{"replayed":true}'::jsonb)
  AND pg_temp.cashier_state()=before_state,'pending hold resolver returns exact original receipt without writes');
 BEGIN PERFORM public.fn_cashout_request_v2('e6470000-0000-4000-8000-000000000101',10.26,auth.uid(),'e6470000-0000-4000-8000-000000000311','First hold');
  RAISE EXCEPTION 'amount replay accepted';EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'cashier_operation_conflict' THEN RAISE;END IF;END;
 PERFORM pg_temp.cashier_check(pg_temp.cashier_state()=before_state,'changed amount replay is atomic refusal');
 BEGIN PERFORM public.fn_cashout_request_v2('e6470000-0000-4000-8000-000000000101',10.25,auth.uid(),'e6470000-0000-4000-8000-000000000311','different note');
  RAISE EXCEPTION 'changed note replay accepted';EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'cashier_operation_conflict' THEN RAISE;END IF;END;
 PERFORM pg_temp.cashier_check(pg_temp.cashier_state()=before_state,'changed note replay is atomic refusal');
END $replay$;
RESET ROLE;
SELECT pg_temp.cashier_actor('e6470000-0000-4000-8000-000000000004');
SET LOCAL ROLE authenticated;
INSERT INTO cashier_receipts SELECT 'approval',public.fn_cashout_approve_v2((receipt->>'cashout_id')::uuid,
 'e6470000-0000-4000-8000-000000000101',10.25,auth.uid(),'e6470000-0000-4000-8000-000000000312','Approved by current admin') FROM cashier_receipts WHERE label='hold_approval';
SELECT pg_temp.cashier_receipt_check(receipt,'approval') FROM cashier_receipts WHERE label='approval';
RESET ROLE;
SELECT pg_temp.cashier_check((SELECT agent_wallet_balance=10.25 AND role='super_agent' FROM public.agents
 WHERE club_id='e6470000-0000-4000-8000-000000000101' AND user_id='e6470000-0000-4000-8000-000000000004')
 AND (SELECT receipt->>'actor_role'='admin' AND receipt->>'assigned_agent_id'='e6470000-0000-4000-8000-000000000003' FROM cashier_receipts WHERE label='approval'),
 'actual admin actor is distinct from assigned agent and helper-created stored wallet role');
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.cashier_actor('e6470000-0000-4000-8000-000000000002');
SET LOCAL ROLE authenticated;
DO $hold_after_terminal$ DECLARE before_state jsonb;r jsonb;BEGIN
 before_state:=pg_temp.cashier_state();
 r:=public.fn_cashout_request_v2('e6470000-0000-4000-8000-000000000101',10.25,auth.uid(),'e6470000-0000-4000-8000-000000000311','First hold');
 PERFORM pg_temp.cashier_check(r->>'request_status'='pending' AND r->>'display_state'='held' AND r->'request'->>'status'='approved'
   AND r->>'replayed'='true' AND pg_temp.cashier_state()=before_state,'immutable hold replay truthfully returns the current terminal request separately');
END $hold_after_terminal$;
INSERT INTO cashier_receipts VALUES('hold_cancel',public.fn_cashout_request_v2('e6470000-0000-4000-8000-000000000101',11.50,auth.uid(),'e6470000-0000-4000-8000-000000000321'));
INSERT INTO cashier_receipts SELECT 'cancellation',public.fn_cashout_release_v2((receipt->>'cashout_id')::uuid,
 'e6470000-0000-4000-8000-000000000101',11.50,auth.uid(),'e6470000-0000-4000-8000-000000000322') FROM cashier_receipts WHERE label='hold_cancel';
SELECT pg_temp.cashier_receipt_check(receipt,'cancellation') FROM cashier_receipts WHERE label='cancellation';
INSERT INTO cashier_receipts VALUES('hold_decline',public.fn_cashout_request_v2('e6470000-0000-4000-8000-000000000101',12.75,auth.uid(),'e6470000-0000-4000-8000-000000000331'));
RESET ROLE;
SELECT pg_temp.cashier_actor('e6470000-0000-4000-8000-000000000004');
SET LOCAL ROLE authenticated;
INSERT INTO cashier_receipts SELECT 'decline',public.fn_cashout_release_v2((receipt->>'cashout_id')::uuid,
 'e6470000-0000-4000-8000-000000000101',12.75,auth.uid(),'e6470000-0000-4000-8000-000000000332','Declined by current admin') FROM cashier_receipts WHERE label='hold_decline';
SELECT pg_temp.cashier_receipt_check(receipt,'decline') FROM cashier_receipts WHERE label='decline';
SELECT pg_temp.cashier_check((SELECT receipt->'actor_wallet_after'='null'::jsonb FROM cashier_receipts WHERE label='decline'),'declining cashier receives no counterparty balance');
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

-- A different session display timezone/DateStyle must not change an issued
-- payload, private-page proof, body or current request DTO on replay.
SELECT pg_temp.cashier_actor('e6470000-0000-4000-8000-000000000002');
SET LOCAL ROLE authenticated;
DO $formatting$ DECLARE before_state jsonb;a jsonb;b jsonb;BEGIN
 before_state:=pg_temp.cashier_state();
 PERFORM set_config('TimeZone','UTC',true);PERFORM set_config('DateStyle','ISO,YMD',true);
 a:=public.fn_cashout_request_v2('e6470000-0000-4000-8000-000000000101',10.25,auth.uid(),'e6470000-0000-4000-8000-000000000311','First hold');
 PERFORM set_config('TimeZone','America/Chicago',true);PERFORM set_config('DateStyle','SQL,DMY',true);
 b:=public.fn_cashout_request_v2('e6470000-0000-4000-8000-000000000101',10.25,auth.uid(),'e6470000-0000-4000-8000-000000000311','First hold');
 PERFORM pg_temp.cashier_check(a=b AND pg_temp.cashier_state()=before_state,'timezone and DateStyle cannot invalidate or rewrite a receipt');
 PERFORM set_config('TimeZone','UTC',true);PERFORM set_config('DateStyle','ISO,YMD',true);
END $formatting$;
INSERT INTO cashier_receipts VALUES('hold_expiry',public.fn_cashout_request_v2('e6470000-0000-4000-8000-000000000101',13.25,auth.uid(),'e6470000-0000-4000-8000-000000000341'));
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
-- Fixture-only past-time construction preserves the complete cross-row hold
-- witnesses. This is not a supported production historical-adoption mechanism.
SET LOCAL session_replication_role=replica;
UPDATE public.accounting_cashier_events SET occurred_at=occurred_at-interval '96 hours'
 WHERE id=(SELECT (receipt->>'event_id')::uuid FROM cashier_receipts WHERE label='hold_expiry');
UPDATE public.cashout_requests r SET created_at=e.occurred_at,updated_at=e.occurred_at FROM public.accounting_cashier_events e
 WHERE e.cashout_id=r.id AND e.id=(SELECT (receipt->>'event_id')::uuid FROM cashier_receipts WHERE label='hold_expiry');
UPDATE public.chip_escrow s SET locked_at=e.occurred_at FROM public.accounting_cashier_events e WHERE e.escrow_id=s.id
 AND e.id=(SELECT (receipt->>'event_id')::uuid FROM cashier_receipts WHERE label='hold_expiry');
UPDATE public.chip_ledger l SET created_at=e.occurred_at FROM public.accounting_cashier_events e WHERE e.source_ledger_id=l.id
 AND e.id=(SELECT (receipt->>'event_id')::uuid FROM cashier_receipts WHERE label='hold_expiry');
UPDATE public.chip_ledger l SET row_hash=encode(extensions.digest('v1'||'|'||l.chain_seq::text||'|'||COALESCE(l.epoch_id::text,'')
 ||'|'||l.amount::text||'|'||l.from_type||':'||COALESCE(l.from_entity_id::text,'')||'|'||l.to_type||':'||COALESCE(l.to_entity_id::text,'')
 ||'|'||l.category||'|'||COALESCE(l.idempotency_key,'')||'|'||COALESCE(l.correlation_id::text,'')||'|'||l.created_at::text,'sha256'),'hex')
 WHERE l.id=(SELECT (receipt->>'source_ledger_id')::uuid FROM cashier_receipts WHERE label='hold_expiry');
UPDATE public.chip_transactions t SET created_at=e.occurred_at FROM public.accounting_cashier_events e WHERE e.source_transaction_id=t.id
 AND e.id=(SELECT (receipt->>'event_id')::uuid FROM cashier_receipts WHERE label='hold_expiry');
UPDATE public.settlement_invoices i SET breakdown=jsonb_set(i.breakdown,'{cashier}',public.fn_cashier_event_payload(e))
 FROM public.accounting_cashier_events e WHERE e.invoice_id=i.id AND e.id=(SELECT (receipt->>'event_id')::uuid FROM cashier_receipts WHERE label='hold_expiry');
UPDATE public.social_messages m SET content=public.fn_cashier_document_body(e.id,i.invoice_number),
 media_metadata=jsonb_set(jsonb_set(m.media_metadata,'{cashier}',public.fn_cashier_event_payload(e)),'{lines,cashier}',public.fn_cashier_event_payload(e))
 FROM public.accounting_cashier_events e JOIN public.settlement_invoices i ON i.id=e.invoice_id
 JOIN public.accounting_invoice_deliveries d ON d.invoice_id=i.id
 WHERE m.id=d.message_id AND e.id=(SELECT (receipt->>'event_id')::uuid FROM cashier_receipts WHERE label='hold_expiry');
UPDATE public.notifications n SET data=m.media_metadata,metadata=m.media_metadata FROM public.accounting_invoice_deliveries d
 JOIN public.social_messages m ON m.id=d.message_id WHERE n.id=d.notification_id
 AND d.invoice_id=(SELECT (receipt->>'invoice_id')::uuid FROM cashier_receipts WHERE label='hold_expiry');
SET LOCAL session_replication_role=origin;
SELECT public.fn_cashier_assert_delivery((receipt->>'event_id')::uuid) FROM cashier_receipts WHERE label='hold_expiry';
SELECT pg_temp.cashier_actor(NULL,'service_role');
SET LOCAL ROLE service_role;
DO $inventory$ DECLARE r jsonb;next_page jsonb;BEGIN
 r:=public.fn_cashier_reconciliation_inventory(NULL,1,72);
 PERFORM pg_temp.cashier_check((r->>'unsupported_count')::int=2 AND r->>'valid_amount_sum'='25.00'
  AND (r->>'invalid_amount_count')::int=1 AND r->>'adoption_supported'='false' AND jsonb_array_length(r->'rows')=1
  AND r->>'next_cursor' IS NOT NULL,'bounded inventory separates valid known amounts from unverified malformed legacy amounts');
 next_page:=public.fn_cashier_reconciliation_inventory((r->>'next_cursor')::uuid,1,72);
 PERFORM pg_temp.cashier_check(next_page->>'next_cursor' IS NULL AND jsonb_array_length(next_page->'rows')=1
  AND r->'rows'->0->>'cashout_id'<>next_page->'rows'->0->>'cashout_id','legacy inventory cursor preserves distinct canonical request IDs');
 PERFORM pg_temp.cashier_check(public.fn_expire_stale_cashouts(72)=1,'real service expiry processes the proven hold despite older unsupported rows');
 PERFORM pg_temp.cashier_check(public.fn_expire_stale_cashouts(72)=0,'expiry repeat produces no duplicate refund');
END $inventory$;
RESET ROLE;
INSERT INTO cashier_receipts SELECT 'expiry_refund',public.fn_cashier_operation_receipt(e.id,true)
 FROM public.accounting_cashier_events e WHERE e.cashout_id=(SELECT (receipt->>'cashout_id')::uuid FROM cashier_receipts WHERE label='hold_expiry') AND e.event_slot='terminal';
SELECT pg_temp.cashier_receipt_check(receipt,'expiry_refund') FROM cashier_receipts WHERE label='expiry_refund';
SELECT pg_temp.cashier_check((SELECT receipt->'actor_user_id'='null'::jsonb AND receipt->>'actor_role'='system'
 AND receipt->'actor_wallet_after'='null'::jsonb FROM cashier_receipts WHERE label='expiry_refund'),'expiry preserves system actor and private balance boundary');
SELECT pg_temp.cashier_check((SELECT jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text) FROM public.cashout_requests r WHERE id IN('e6470000-0000-4000-8000-000000000501','e6470000-0000-4000-8000-000000000502'))=(SELECT requests FROM legacy_cashier_before)
 AND (SELECT jsonb_agg(to_jsonb(s) ORDER BY to_jsonb(s)::text) FROM public.chip_escrow s WHERE id IN('e6470000-0000-4000-8000-000000000601','e6470000-0000-4000-8000-000000000602'))=(SELECT escrow FROM legacy_cashier_before),
 'unsupported historical requests and escrow remain byte-for-byte unchanged');
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

SELECT pg_temp.cashier_actor('e6470000-0000-4000-8000-000000000001');
SET LOCAL ROLE authenticated;
DO $legacy_refusal$ DECLARE before_state jsonb;BEGIN
 before_state:=pg_temp.cashier_state();
 BEGIN PERFORM public.fn_cashout_release_v2('e6470000-0000-4000-8000-000000000501','e6470000-0000-4000-8000-000000000101',25,auth.uid(),'e6470000-0000-4000-8000-000000000351');
  RAISE EXCEPTION 'unverified legacy hold adopted';EXCEPTION WHEN check_violation THEN IF SQLERRM<>'cashier_legacy_hold_unverified' THEN RAISE;END IF;END;
 PERFORM pg_temp.cashier_check(pg_temp.cashier_state()=before_state,'unverified old hold cannot be refunded or rewritten by a manager');
END $legacy_refusal$;
RESET ROLE;
SELECT pg_temp.cashier_actor('e6470000-0000-4000-8000-000000000002');
SET LOCAL ROLE authenticated;
INSERT INTO cashier_receipts VALUES('hold_failure',public.fn_cashout_request_v2('e6470000-0000-4000-8000-000000000101',14.25,auth.uid(),'e6470000-0000-4000-8000-000000000361'));
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
CREATE TEMP TABLE removed_cashier_member AS SELECT * FROM public.club_members WHERE club_id='e6470000-0000-4000-8000-000000000101' AND user_id='e6470000-0000-4000-8000-000000000002';
SET LOCAL session_replication_role=replica;
DELETE FROM public.club_members WHERE club_id='e6470000-0000-4000-8000-000000000101' AND user_id='e6470000-0000-4000-8000-000000000002';
SET LOCAL session_replication_role=origin;
SET LOCAL ROLE authenticated;
DO $missing_wallet$ DECLARE before_state jsonb;r jsonb;BEGIN
 SELECT receipt INTO r FROM cashier_receipts WHERE label='hold_failure';before_state:=pg_temp.cashier_state();
 BEGIN PERFORM public.fn_cashout_release_v2((r->>'cashout_id')::uuid,'e6470000-0000-4000-8000-000000000101',14.25,auth.uid(),'e6470000-0000-4000-8000-000000000362');
  RAISE EXCEPTION 'missing membership recreated';EXCEPTION WHEN foreign_key_violation THEN IF SQLERRM<>'cashier_refund_wallet_missing' THEN RAISE;END IF;END;
 PERFORM pg_temp.cashier_check(pg_temp.cashier_state()=before_state,'missing player wallet preserves pending liability without membership recreation');
END $missing_wallet$;
RESET ROLE;
SET LOCAL session_replication_role=replica;
INSERT INTO public.club_members SELECT * FROM removed_cashier_member;
SET LOCAL session_replication_role=origin;

-- The stored assignee is context, never proof that today's actor can approve.
SET LOCAL session_replication_role=replica;
UPDATE public.club_members SET role='player' WHERE club_id='e6470000-0000-4000-8000-000000000101' AND user_id='e6470000-0000-4000-8000-000000000003';
SET LOCAL session_replication_role=origin;
SELECT pg_temp.cashier_actor('e6470000-0000-4000-8000-000000000003');
SET LOCAL ROLE authenticated;
DO $demoted$ DECLARE before_state jsonb;r jsonb;BEGIN
 SELECT receipt INTO r FROM cashier_receipts WHERE label='hold_failure';before_state:=pg_temp.cashier_state();
 BEGIN PERFORM public.fn_cashout_approve_v2((r->>'cashout_id')::uuid,'e6470000-0000-4000-8000-000000000101',14.25,auth.uid(),'e6470000-0000-4000-8000-000000000363');
  RAISE EXCEPTION 'demoted assignee approved';EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'cashier_current_authority_required' THEN RAISE;END IF;END;
 PERFORM pg_temp.cashier_check(pg_temp.cashier_state()=before_state,'demoted assigned cashier cannot move chips');
END $demoted$;
RESET ROLE;
SET LOCAL session_replication_role=replica;
UPDATE public.club_members SET role='agent' WHERE club_id='e6470000-0000-4000-8000-000000000101' AND user_id='e6470000-0000-4000-8000-000000000003';
SET LOCAL session_replication_role=origin;

-- Failure injection is fixture-only and never a replacement money writer.
-- Both raised errors and silent NULL writes must roll back the whole operation.
CREATE FUNCTION pg_temp.cashier_inject() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stage text:=current_setting('app.fixture_cashier_stage',true);mode text:=current_setting('app.fixture_cashier_mode',true);BEGIN
 IF stage IS DISTINCT FROM TG_TABLE_NAME THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME IN('agents','club_members') AND TG_OP<>'UPDATE' THEN RETURN NEW;END IF;
 IF mode='second_recipient' THEN
  IF TG_TABLE_NAME<>'notifications' THEN RETURN NEW;END IF;
  IF NEW.user_id<>'e6470000-0000-4000-8000-000000000002'::uuid THEN RETURN NEW;END IF;
 END IF;
 IF mode='raise' THEN RAISE EXCEPTION 'fixture_cashier_forced_failure';END IF;
 IF mode='mutate' THEN
  IF TG_TABLE_NAME='push_outbox' THEN NEW.body:='Incorrect altered push body';RETURN NEW;END IF;
  IF TG_TABLE_NAME='notifications' THEN NEW.message:='Incorrect altered notice';RETURN NEW;END IF;
 END IF;
 RETURN NULL;
END$$;
DO $inject$ DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['agents','club_members','cashout_requests','chip_escrow','chip_transactions','accounting_cashier_events',
  'settlement_invoices','social_messages','notifications','accounting_invoice_deliveries','push_outbox'] LOOP
  EXECUTE format('CREATE TRIGGER zz_fixture_cashier_failure BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION pg_temp.cashier_inject()',table_name);
 END LOOP;
END $inject$;
SELECT pg_temp.cashier_actor('e6470000-0000-4000-8000-000000000004');
SET LOCAL ROLE authenticated;
DO $late_terminal$ DECLARE stage text;mode text;before_state jsonb;r jsonb;caught boolean;expected text;BEGIN
 SELECT receipt INTO r FROM cashier_receipts WHERE label='hold_failure';
 FOREACH stage IN ARRAY ARRAY['agents','cashout_requests','chip_escrow','chip_transactions','accounting_cashier_events',
  'settlement_invoices','social_messages','notifications','accounting_invoice_deliveries','push_outbox'] LOOP
  FOREACH mode IN ARRAY ARRAY['null','raise'] LOOP
   PERFORM set_config('app.fixture_cashier_stage',stage,true);PERFORM set_config('app.fixture_cashier_mode',mode,true);
   before_state:=pg_temp.cashier_state();caught:=false;
   expected:=CASE stage WHEN 'agents' THEN 'cashier_wallet_write_missing' WHEN 'cashout_requests' THEN 'cashier_request_write_missing'
    WHEN 'chip_escrow' THEN 'cashier_escrow_write_missing' WHEN 'chip_transactions' THEN 'cashier_transaction_write_missing'
    WHEN 'accounting_cashier_events' THEN 'cashier_event_write_missing' WHEN 'settlement_invoices' THEN 'cashier_invoice_write_missing'
    WHEN 'accounting_invoice_deliveries' THEN 'cashier_document_delivery_missing' WHEN 'push_outbox' THEN 'cashier_push_receipt_missing' END;
   BEGIN
    PERFORM public.fn_cashout_approve_v2((r->>'cashout_id')::uuid,'e6470000-0000-4000-8000-000000000101',14.25,auth.uid(),'e6470000-0000-4000-8000-000000000364','Rollback qualification');
    SET CONSTRAINTS ALL IMMEDIATE;
   EXCEPTION
    WHEN raise_exception THEN IF mode<>'raise' OR SQLERRM<>'fixture_cashier_forced_failure' THEN RAISE;END IF;caught:=true;
    WHEN check_violation THEN IF mode<>'null' OR SQLERRM IS DISTINCT FROM expected THEN RAISE;END IF;caught:=true;
    WHEN not_null_violation THEN
     IF mode<>'null' OR stage NOT IN('social_messages','notifications')
       OR (stage='social_messages' AND position('message_id' in SQLERRM)=0)
       OR (stage='notifications' AND position('notification_id' in SQLERRM)=0) THEN RAISE;END IF;caught:=true;
   END;
   SET CONSTRAINTS ALL DEFERRED;
   PERFORM pg_temp.cashier_check(caught AND pg_temp.cashier_state()=before_state,'terminal '||stage||' '||mode||' leaves all original rows and IDs intact');
   PERFORM set_config('app.fixture_cashier_stage','',true);PERFORM set_config('app.fixture_cashier_mode','',true);
  END LOOP;
 END LOOP;
 FOREACH mode IN ARRAY ARRAY['second_recipient','mutate'] LOOP
  PERFORM set_config('app.fixture_cashier_stage','notifications',true);PERFORM set_config('app.fixture_cashier_mode',mode,true);
  before_state:=pg_temp.cashier_state();caught:=false;
  BEGIN
   PERFORM public.fn_cashout_approve_v2((r->>'cashout_id')::uuid,'e6470000-0000-4000-8000-000000000101',14.25,auth.uid(),'e6470000-0000-4000-8000-000000000364','Rollback qualification');
  EXCEPTION WHEN not_null_violation THEN
    IF mode<>'second_recipient' OR position('notification_id' in SQLERRM)=0 THEN RAISE;END IF;caught:=true;
   WHEN check_violation THEN IF mode<>'mutate' OR SQLERRM<>'cashier_document_delivery_mismatch' THEN RAISE;END IF;caught:=true;
  END;
  PERFORM pg_temp.cashier_check(caught AND pg_temp.cashier_state()=before_state,'second-recipient or mutated notice rolls back earlier recipients too');
 END LOOP;
 PERFORM set_config('app.fixture_cashier_stage','push_outbox',true);PERFORM set_config('app.fixture_cashier_mode','mutate',true);
 before_state:=pg_temp.cashier_state();caught:=false;
 BEGIN
  PERFORM public.fn_cashout_approve_v2((r->>'cashout_id')::uuid,'e6470000-0000-4000-8000-000000000101',14.25,auth.uid(),'e6470000-0000-4000-8000-000000000364','Rollback qualification');
  SET CONSTRAINTS ALL IMMEDIATE;
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'cashier_push_receipt_missing' THEN RAISE;END IF;caught:=true;END;
 SET CONSTRAINTS ALL DEFERRED;
 PERFORM pg_temp.cashier_check(caught AND pg_temp.cashier_state()=before_state,'mutated deferred outbox content aborts the financial transaction');
 PERFORM set_config('app.fixture_cashier_stage','',true);PERFORM set_config('app.fixture_cashier_mode','',true);
END $late_terminal$;
RESET ROLE;
-- Also exercise a current owner without a pre-existing agent wallet.
SELECT pg_temp.cashier_actor('e6470000-0000-4000-8000-000000000001');
SET LOCAL ROLE authenticated;
INSERT INTO cashier_receipts SELECT 'owner_approval',public.fn_cashout_approve_v2((receipt->>'cashout_id')::uuid,
 'e6470000-0000-4000-8000-000000000101',14.25,auth.uid(),'e6470000-0000-4000-8000-000000000365','Owner approval') FROM cashier_receipts WHERE label='hold_failure';
SELECT pg_temp.cashier_receipt_check(receipt,'approval') FROM cashier_receipts WHERE label='owner_approval';
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.cashier_check((SELECT agent_wallet_balance=14.25 FROM public.agents WHERE club_id='e6470000-0000-4000-8000-000000000101'
 AND user_id='e6470000-0000-4000-8000-000000000001'),'owner approval uses the actual owner agent wallet');
SELECT pg_temp.cashier_actor('e6470000-0000-4000-8000-000000000002');
SET LOCAL ROLE authenticated;
DO $late_hold$ DECLARE stage text;before_state jsonb;expected text;caught boolean;BEGIN
 FOREACH stage IN ARRAY ARRAY['club_members','cashout_requests','chip_escrow','chip_transactions','accounting_cashier_events',
  'settlement_invoices','social_messages','notifications','accounting_invoice_deliveries','push_outbox'] LOOP
  PERFORM set_config('app.fixture_cashier_stage',stage,true);PERFORM set_config('app.fixture_cashier_mode','null',true);
  before_state:=pg_temp.cashier_state();caught:=false;
  expected:=CASE stage WHEN 'club_members' THEN 'cashier_wallet_write_missing' WHEN 'cashout_requests' THEN 'cashier_request_write_missing'
   WHEN 'chip_escrow' THEN 'cashier_escrow_write_missing' WHEN 'chip_transactions' THEN 'cashier_transaction_write_missing'
   WHEN 'accounting_cashier_events' THEN 'cashier_event_write_missing' WHEN 'settlement_invoices' THEN 'cashier_invoice_write_missing'
   WHEN 'accounting_invoice_deliveries' THEN 'cashier_document_delivery_missing' WHEN 'push_outbox' THEN 'cashier_push_receipt_missing' END;
  BEGIN
   PERFORM public.fn_cashout_request_v2('e6470000-0000-4000-8000-000000000101',15.25,auth.uid(),'e6470000-0000-4000-8000-000000000371');
   SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION
   WHEN check_violation THEN IF SQLERRM IS DISTINCT FROM expected THEN RAISE;END IF;caught:=true;
   WHEN not_null_violation THEN
    IF stage NOT IN('social_messages','notifications') OR (stage='social_messages' AND position('message_id' in SQLERRM)=0)
      OR (stage='notifications' AND position('notification_id' in SQLERRM)=0) THEN RAISE;END IF;caught:=true;
  END;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.cashier_check(caught AND pg_temp.cashier_state()=before_state,'hold '||stage||' suppression is a complete rollback');
  PERFORM set_config('app.fixture_cashier_stage','',true);PERFORM set_config('app.fixture_cashier_mode','',true);
 END LOOP;
END $late_hold$;
RESET ROLE;

-- A later legitimate wallet credit does not change an earlier operation's
-- immutable balance receipt, create a second document, or repay its amount.
SELECT pg_temp.cashier_actor('e6470000-0000-4000-8000-000000000002');
SET LOCAL ROLE authenticated;
INSERT INTO cashier_receipts VALUES('hold_later',public.fn_cashout_request_v2('e6470000-0000-4000-8000-000000000101',16.00,auth.uid(),'e6470000-0000-4000-8000-000000000381'));
RESET ROLE;
SELECT pg_temp.cashier_actor('e6470000-0000-4000-8000-000000000004');
SET LOCAL ROLE authenticated;
INSERT INTO cashier_receipts SELECT 'later_approval',public.fn_cashout_approve_v2((receipt->>'cashout_id')::uuid,
 'e6470000-0000-4000-8000-000000000101',16,auth.uid(),'e6470000-0000-4000-8000-000000000382') FROM cashier_receipts WHERE label='hold_later';
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE authenticated;
DO $later_replay$ DECLARE before_state jsonb;original jsonb;r jsonb;BEGIN
 SELECT receipt INTO original FROM cashier_receipts WHERE label='approval';before_state:=pg_temp.cashier_state();
 r:=public.fn_cashout_approve_v2((original->>'cashout_id')::uuid,'e6470000-0000-4000-8000-000000000101',10.25,auth.uid(),'e6470000-0000-4000-8000-000000000312','Approved by current admin');
 PERFORM pg_temp.cashier_check((r-'replayed')=(original-'replayed') AND r->>'replayed'='true' AND pg_temp.cashier_state()=before_state,
  'approval replay after later wallet movement returns the original receipt without balance/document rewrites');
 BEGIN PERFORM public.fn_cashout_approve_v2((SELECT (receipt->>'cashout_id')::uuid FROM cashier_receipts WHERE label='hold_later'),
   'e6470000-0000-4000-8000-000000000101',10.25,auth.uid(),'e6470000-0000-4000-8000-000000000312','Approved by current admin');
  RAISE EXCEPTION 'changed request replay accepted';EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'cashier_operation_conflict' THEN RAISE;END IF;END;
 PERFORM pg_temp.cashier_check(pg_temp.cashier_state()=before_state,'same operation with another request is refused atomically');
END $later_replay$;
RESET ROLE;
SELECT pg_temp.cashier_check((SELECT agent_wallet_balance=26.25 FROM public.agents WHERE club_id='e6470000-0000-4000-8000-000000000101'
 AND user_id='e6470000-0000-4000-8000-000000000004'),'earlier replay preserves the later actual wallet balance');
SELECT pg_temp.cashier_actor('e6470000-0000-4000-8000-000000000002');
SET LOCAL ROLE authenticated;
DO $intent_conflicts$ DECLARE before_state jsonb;r jsonb;BEGIN
 SELECT receipt INTO r FROM cashier_receipts WHERE label='hold_approval';before_state:=pg_temp.cashier_state();
 BEGIN PERFORM public.fn_cashout_request_v2('e6470000-0000-4000-8000-000000000102',10.25,auth.uid(),'e6470000-0000-4000-8000-000000000311','First hold');
  RAISE EXCEPTION 'changed club replay accepted';EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'cashier_operation_conflict' THEN RAISE;END IF;END;
 PERFORM pg_temp.cashier_check(pg_temp.cashier_state()=before_state,'same operation in another club is refused atomically');
 BEGIN PERFORM public.fn_cashout_release_v2((r->>'cashout_id')::uuid,'e6470000-0000-4000-8000-000000000101',10.25,auth.uid(),'e6470000-0000-4000-8000-000000000311','First hold');
  RAISE EXCEPTION 'changed action replay accepted';EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'cashier_operation_conflict' THEN RAISE;END IF;END;
 PERFORM pg_temp.cashier_check(pg_temp.cashier_state()=before_state,'same operation with another action is refused atomically');
END $intent_conflicts$;
RESET ROLE;

-- Recovery is a separate authenticated lookup before NEW-money business gates.
-- Every echoed original-intent field is required even for proven not-found.
SET LOCAL ROLE authenticated;
DO $resolver$ DECLARE before_state jsonb;original jsonb;expected jsonb;resolved jsonb;item record;
 action text;request_id uuid;actor uuid;note text;BEGIN
 FOR item IN SELECT label,receipt FROM cashier_receipts WHERE label IN('hold_approval','approval','cancellation','decline') ORDER BY label LOOP
  original:=item.receipt;actor:=(original->>'actor_user_id')::uuid;
  PERFORM pg_temp.cashier_actor(actor);
  action:=CASE original->>'event_kind' WHEN 'hold' THEN 'hold' WHEN 'approval' THEN 'approval' ELSE 'release' END;
  request_id:=CASE WHEN action='hold' THEN NULL ELSE (original->>'cashout_id')::uuid END;
  note:=original->>'accepted_note';expected:=original||'{"replayed":true}'::jsonb;
  IF action='hold' THEN expected:=expected||jsonb_build_object('request',(SELECT receipt->'request' FROM cashier_receipts WHERE label='approval'));END IF;
  before_state:=pg_temp.cashier_state();
  resolved:=public.fn_cashout_operation_receipt_v2(actor,(original->>'op_id')::uuid,action,
    (original->>'club_id')::uuid,(original->>'amount')::numeric,request_id,CASE WHEN note IS NULL THEN ' ' ELSE ' '||note||' ' END);
  PERFORM pg_temp.cashier_check(resolved=jsonb_build_object('contract_version',1,'found',true,'actor_user_id',actor,
   'op_id',original->'op_id','action',action,'club_id',original->'club_id','amount',original->'amount',
   'cashout_id',request_id,'accepted_note',note,'receipt',expected) AND pg_temp.cashier_state()=before_state,
   'exact resolver '||item.label||' preserves all financial/document rows and later wallet balances');
 END LOOP;
 actor:='e6470000-0000-4000-8000-000000000002';PERFORM pg_temp.cashier_actor(actor);
 before_state:=pg_temp.cashier_state();
 resolved:=public.fn_cashout_operation_receipt_v2(actor,'e6470000-0000-4000-8000-000000000391','hold',
  'e6470000-0000-4000-8000-000000000101',10.25,NULL,' ');
 PERFORM pg_temp.cashier_check(resolved=jsonb_build_object('contract_version',1,'found',false,'actor_user_id',actor,
   'op_id','e6470000-0000-4000-8000-000000000391','action','hold','club_id','e6470000-0000-4000-8000-000000000101',
   'amount','10.25','cashout_id',NULL,'accepted_note',NULL,'receipt',NULL) AND pg_temp.cashier_state()=before_state,
   'definite actor-operation absence has exact intent pins and null receipt without any writes');
 -- Another actor's operation UUID must not disclose that actor's receipt.
 actor:='e6470000-0000-4000-8000-000000000005';PERFORM pg_temp.cashier_actor(actor);
 resolved:=public.fn_cashout_operation_receipt_v2(actor,'e6470000-0000-4000-8000-000000000312','approval',
  'e6470000-0000-4000-8000-000000000101',10.25,(SELECT (receipt->>'cashout_id')::uuid FROM cashier_receipts WHERE label='approval'),'Approved by current admin');
 PERFORM pg_temp.cashier_check(resolved->'found'='false'::jsonb AND resolved->'receipt'='null'::jsonb
  AND resolved->>'actor_user_id'=actor::text AND pg_temp.cashier_state()=before_state,'another actor cannot recover the original actor receipt');
END $resolver$;
RESET ROLE;

CREATE FUNCTION pg_temp.cashier_resolver_refusal(expected_actor uuid,op uuid,action text,club uuid,amount numeric,
 request_id uuid,note text,expected_code text,expected_message text,label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE before_state jsonb:=pg_temp.cashier_state();caught boolean:=false;BEGIN
 BEGIN
  PERFORM public.fn_cashout_operation_receipt_v2(expected_actor,op,action,club,amount,request_id,note);
 EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE IS DISTINCT FROM expected_code OR SQLERRM IS DISTINCT FROM expected_message THEN RAISE;END IF;
  caught:=true;
 END;
 PERFORM pg_temp.cashier_check(caught AND pg_temp.cashier_state()=before_state,label);
END$$;
REVOKE ALL ON FUNCTION pg_temp.cashier_resolver_refusal(uuid,uuid,text,uuid,numeric,uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pg_temp.cashier_resolver_refusal(uuid,uuid,text,uuid,numeric,uuid,text,text,text,text) TO authenticated;
SELECT pg_temp.cashier_actor('e6470000-0000-4000-8000-000000000002');
SET LOCAL ROLE authenticated;
DO $resolver_refusals$ DECLARE wrong record;actor uuid:=auth.uid();request_id uuid;BEGIN
 SELECT (receipt->>'cashout_id')::uuid INTO request_id FROM cashier_receipts WHERE label='hold_approval';
 FOR wrong IN SELECT * FROM (VALUES
  ('amount','hold','e6470000-0000-4000-8000-000000000101'::uuid,10.26::numeric,NULL::uuid,'First hold','cashier_operation_conflict'),
  ('note','hold','e6470000-0000-4000-8000-000000000101'::uuid,10.25::numeric,NULL::uuid,'changed','cashier_operation_conflict'),
  ('club','hold','e6470000-0000-4000-8000-000000000102'::uuid,10.25::numeric,NULL::uuid,'First hold','cashier_operation_conflict'),
  ('action','release','e6470000-0000-4000-8000-000000000101'::uuid,10.25::numeric,request_id,'First hold','cashier_operation_conflict'),
  ('hold request identity','hold','e6470000-0000-4000-8000-000000000101'::uuid,10.25::numeric,request_id,'First hold','cashier_intent_incomplete'),
  ('missing terminal request','approval','e6470000-0000-4000-8000-000000000101'::uuid,10.25::numeric,NULL::uuid,'First hold','cashier_intent_incomplete'),
  ('system action','expiry_refund','e6470000-0000-4000-8000-000000000101'::uuid,10.25::numeric,request_id,'First hold','cashier_intent_incomplete'),
  ('fractional amount','hold','e6470000-0000-4000-8000-000000000101'::uuid,10.251::numeric,NULL::uuid,'First hold','cashier_invalid_amount'),
  ('nonfinite amount','hold','e6470000-0000-4000-8000-000000000101'::uuid,'NaN'::numeric,NULL::uuid,'First hold','cashier_invalid_amount')
 ) AS cases(label,action,club,amount,request_id,note,message) LOOP
  PERFORM pg_temp.cashier_resolver_refusal(actor,'e6470000-0000-4000-8000-000000000311',wrong.action,wrong.club,wrong.amount,
    wrong.request_id,wrong.note,'22023',wrong.message,'resolver refuses changed or malformed '||wrong.label||' without writes');
 END LOOP;
 PERFORM pg_temp.cashier_resolver_refusal('e6470000-0000-4000-8000-000000000004','e6470000-0000-4000-8000-000000000312',
  'approval','e6470000-0000-4000-8000-000000000101',10.25,request_id,'Approved by current admin',
  '42501','cashier_account_changed','resolver refuses another expected actor before receipt lookup');
 -- Existing transaction evidence without an actor-owned canonical event is
 -- unconfirmed, even when that actor was the physical counterparty.
 PERFORM pg_temp.cashier_resolver_refusal(actor,'e6470000-0000-4000-8000-000000000312',
  'approval','e6470000-0000-4000-8000-000000000101',10.25,request_id,'Approved by current admin',
  '23514','cashier_legacy_operation_unverified','resolver never translates unconfirmed transaction evidence into not-found');
 PERFORM pg_temp.cashier_actor(NULL);
 PERFORM pg_temp.cashier_resolver_refusal(actor,'e6470000-0000-4000-8000-000000000311',
  'hold','e6470000-0000-4000-8000-000000000101',10.25,NULL,'First hold',
  '42501','cashier_account_changed','resolver refuses a missing authenticated identity');
 PERFORM pg_temp.cashier_actor('e6470000-0000-4000-8000-000000000004');
 PERFORM pg_temp.cashier_resolver_refusal(auth.uid(),'e6470000-0000-4000-8000-000000000312',
  'approval','e6470000-0000-4000-8000-000000000101',10.25,'e6470000-0000-4000-8000-000000000501','Approved by current admin',
  '22023','cashier_operation_conflict','resolver refuses a different terminal request');
END $resolver_refusals$;
RESET ROLE;

-- Isolated adversarial subtransactions restore both rows and function bodies.
-- These fail-closed sentinels are not substituted financial success stubs.
DO $resolver_no_writes$ DECLARE before_state jsonb;original_state jsonb;original jsonb;r jsonb;transition_definition text;delivery_definition text;BEGIN
 SELECT receipt INTO original FROM cashier_receipts WHERE label='approval';
 original_state:=pg_temp.cashier_state();
 transition_definition:=pg_get_functiondef('public.fn_cashier_cashout_transition(text,uuid,uuid,numeric,uuid,uuid,text)'::regprocedure);
 delivery_definition:=pg_get_functiondef('public.fn_deliver_accounting_invoice(uuid)'::regprocedure);
 BEGIN
  EXECUTE $poison$CREATE OR REPLACE FUNCTION public.fn_cashier_cashout_transition(p_action text,p_club_id uuid,p_cashout_id uuid,p_amount numeric,
   p_expected_actor_id uuid,p_op_id uuid,p_note text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $body$
   BEGIN RAISE EXCEPTION 'resolver_called_financial_writer';END $body$$poison$;
  EXECUTE $poison$CREATE OR REPLACE FUNCTION public.fn_deliver_accounting_invoice(p_invoice_id uuid) RETURNS jsonb
   LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $body$BEGIN RAISE EXCEPTION 'resolver_called_delivery_writer';END $body$$poison$;
  -- Authority changes after successful issuance cannot require another payment.
  PERFORM set_config('session_replication_role','replica',true);
  UPDATE public.club_members SET role='player',status='suspended',is_active=false
   WHERE club_id='e6470000-0000-4000-8000-000000000101' AND user_id='e6470000-0000-4000-8000-000000000004';
  UPDATE public.clubs SET owner_id='e6470000-0000-4000-8000-000000000006' WHERE id='e6470000-0000-4000-8000-000000000101';
  PERFORM set_config('session_replication_role','origin',true);
  before_state:=pg_temp.cashier_state();
  EXECUTE 'SET LOCAL ROLE authenticated';
  r:=public.fn_cashout_operation_receipt_v2(auth.uid(),'e6470000-0000-4000-8000-000000000312','approval',
   'e6470000-0000-4000-8000-000000000101',10.25,(original->>'cashout_id')::uuid,'Approved by current admin');
  PERFORM pg_temp.cashier_check(r->'receipt'=(original||'{"replayed":true}'::jsonb) AND pg_temp.cashier_state()=before_state,
   'historical actor recovers exact receipt after demotion and owner change without calling financial or delivery writer');
  EXECUTE 'RESET ROLE';
  RAISE EXCEPTION 'resolver_fixture_subtransaction_complete' USING ERRCODE='ZC647';
 EXCEPTION WHEN SQLSTATE 'ZC647' THEN
  IF SQLERRM<>'resolver_fixture_subtransaction_complete' THEN RAISE;END IF;
 END;
 PERFORM pg_temp.cashier_check(pg_get_functiondef('public.fn_cashier_cashout_transition(text,uuid,uuid,numeric,uuid,uuid,text)'::regprocedure)=transition_definition
  AND pg_get_functiondef('public.fn_deliver_accounting_invoice(uuid)'::regprocedure)=delivery_definition,
  'resolver sentinels leave actual writer definitions intact');
 PERFORM pg_temp.cashier_check(pg_temp.cashier_state()=original_state,'isolated authority-change setup restores all original rows');
END $resolver_no_writes$;
DO $resolver_corruption$ DECLARE before_state jsonb;corrupt_state jsonb;original jsonb;BEGIN
 SELECT receipt INTO original FROM cashier_receipts WHERE label='approval';before_state:=pg_temp.cashier_state();
 BEGIN
  PERFORM set_config('session_replication_role','replica',true);
  DELETE FROM public.accounting_invoice_deliveries WHERE invoice_id=(original->>'invoice_id')::uuid
   AND recipient_id='e6470000-0000-4000-8000-000000000004';
  PERFORM set_config('session_replication_role','origin',true);corrupt_state:=pg_temp.cashier_state();
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM pg_temp.cashier_resolver_refusal(auth.uid(),'e6470000-0000-4000-8000-000000000312','approval',
   'e6470000-0000-4000-8000-000000000101',10.25,(original->>'cashout_id')::uuid,'Approved by current admin',
   '23514','cashier_document_delivery_missing','missing canonical delivery refuses without repair or not-found fallback');
  PERFORM pg_temp.cashier_check(pg_temp.cashier_state()=corrupt_state,'receipt recovery does not redeliver a missing canonical document');
  EXECUTE 'RESET ROLE';RAISE EXCEPTION 'resolver_fixture_subtransaction_complete' USING ERRCODE='ZC647';
 EXCEPTION WHEN SQLSTATE 'ZC647' THEN IF SQLERRM<>'resolver_fixture_subtransaction_complete' THEN RAISE;END IF;END;
 PERFORM pg_temp.cashier_check(pg_temp.cashier_state()=before_state,'isolated missing-delivery setup restores all original rows');
END $resolver_corruption$;

-- Private readers must take their type/IDs/amount only from the linked invoice.
CREATE TEMP TABLE cashier_private_conversation AS SELECT d.invoice_id,m.conversation_id,d.message_id FROM public.accounting_invoice_deliveries d
 JOIN public.social_messages m ON m.id=d.message_id WHERE d.recipient_id='e6470000-0000-4000-8000-000000000002'
 AND d.invoice_id=(SELECT (receipt->>'invoice_id')::uuid FROM cashier_receipts WHERE label='hold_approval');
GRANT SELECT ON cashier_private_conversation TO authenticated;
SELECT pg_temp.cashier_actor('e6470000-0000-4000-8000-000000000002');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cashier_check(EXISTS(SELECT 1 FROM cashier_private_conversation c CROSS JOIN LATERAL
 public.fn_messenger_private_message_page(auth.uid(),c.conversation_id,NULL,NULL,100) m WHERE m.id=c.message_id
 AND m.media_metadata->'accounting_verified'='true'::jsonb AND m.media_metadata->'cashier_verified'='true'::jsonb
 AND m.media_metadata->>'invoice_type'='cashier_cashout' AND m.media_metadata->>'invoice_id'=c.invoice_id::text
 AND jsonb_typeof(m.media_metadata->'amount')='string' AND m.media_metadata->>'amount'='10.25'
 AND m.media_metadata->'cashier'=(SELECT receipt->'cashier' FROM cashier_receipts WHERE label='hold_approval')),
 'existing private reader returns canonical cashier proof and exact decimal text');
RESET ROLE;
SELECT pg_temp.cashier_actor('e6470000-0000-4000-8000-000000000005');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cashier_check(NOT EXISTS(SELECT 1 FROM public.settlement_invoices WHERE invoice_type='cashier_cashout'),
 'unrelated admin cannot read private cashier invoices through broad club accounting RLS');
DO $private$ BEGIN
 BEGIN PERFORM public.fn_messenger_private_message_page(auth.uid(),(SELECT conversation_id FROM cashier_private_conversation),NULL,NULL,100);
  RAISE EXCEPTION 'unrelated private reader accepted';
 EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'message_page_not_authorised' THEN RAISE;END IF;END;
END $private$;
RESET ROLE;

-- A service alias cannot become a second payer, even through a privileged wrapper.
SELECT pg_temp.cashier_actor(NULL,'service_role');
SET LOCAL ROLE service_role;
DO $retired$ DECLARE before_state jsonb;BEGIN
 before_state:=pg_temp.cashier_state();
 BEGIN PERFORM public.fn_request_cashout('e6470000-0000-4000-8000-000000000002','e6470000-0000-4000-8000-000000000101',10);
  RAISE EXCEPTION 'legacy request route accepted';EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'cashier_v2_intent_required' THEN RAISE;END IF;END;
 BEGIN PERFORM public.fn_approve_cashout_atomic('e6470000-0000-4000-8000-000000000501','e6470000-0000-4000-8000-000000000001');
  RAISE EXCEPTION 'legacy approve route accepted';EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'cashier_v2_intent_required' THEN RAISE;END IF;END;
 BEGIN PERFORM public.fn_cancel_cashout_atomic('e6470000-0000-4000-8000-000000000501','e6470000-0000-4000-8000-000000000007');
  RAISE EXCEPTION 'legacy cancel route accepted';EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'cashier_v2_intent_required' THEN RAISE;END IF;END;
 BEGIN PERFORM public.fn_cancel_cashout('e6470000-0000-4000-8000-000000000501','e6470000-0000-4000-8000-000000000007');
  RAISE EXCEPTION 'legacy global-wallet route accepted';EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'cashier_v2_intent_required' THEN RAISE;END IF;END;
 PERFORM pg_temp.cashier_check(pg_temp.cashier_state()=before_state,'all captured legacy aliases refuse without any financial write');
END $retired$;
RESET ROLE;
SELECT pg_temp.cashier_check(NOT EXISTS(SELECT 1 FROM public.notifications WHERE type IN('settlement','cashout_request')
 AND (metadata->>'clubId'='e6470000-0000-4000-8000-000000000101' OR data->>'clubId'='e6470000-0000-4000-8000-000000000101')),
 'canonical cashier invoices do not duplicate legacy settlement or request notices');
SELECT pg_temp.cashier_check(NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.cashout_requests'::regclass AND tgname='tr_notify_agent_on_cashout'),
 'exact legacy request message trigger retired');
DO $acl$ DECLARE role_name text;table_name text;BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  FOREACH table_name IN ARRAY ARRAY['cashout_requests','chip_escrow','accounting_cashier_events'] LOOP
   PERFORM pg_temp.cashier_check(NOT has_table_privilege(role_name,'public.'||table_name,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER'),
    role_name||' cannot bypass cashier authority for '||table_name);
  END LOOP;
 END LOOP;
 PERFORM pg_temp.cashier_check(NOT has_function_privilege('authenticated','public.fn_expire_stale_cashouts(integer)','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.fn_cashier_reconciliation_inventory(uuid,integer,integer)','EXECUTE'),
 'expiry and historical inventory retain service-only authority');
 PERFORM pg_temp.cashier_check(has_function_privilege('authenticated','public.fn_cashout_operation_receipt_v2(uuid,uuid,text,uuid,numeric,uuid,text)','EXECUTE')
  AND NOT has_function_privilege('anon','public.fn_cashout_operation_receipt_v2(uuid,uuid,text,uuid,numeric,uuid,text)','EXECUTE')
  AND NOT has_function_privilege('service_role','public.fn_cashout_operation_receipt_v2(uuid,uuid,text,uuid,numeric,uuid,text)','EXECUTE'),
  'receipt resolver is authenticated-only and cannot become a service actor lookup');
END $acl$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
