\set ON_ERROR_STOP on
-- UNRUN. Disposable PostgreSQL 17 complete captured catalog plus reviewed
-- reader preimages and messenger-private-readers-candidate.sql. Synthetic
-- historical records exercise real RLS/readers, not payment or delivery proof.
BEGIN;
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL
   OR to_regprocedure('public.fn_messenger_private_message_page(uuid,uuid,timestamptz,uuid,integer)') IS NULL
 THEN RAISE EXCEPTION 'isolated installed privacy fixture required'; END IF;
END $guard$;
CREATE FUNCTION pg_temp.check_privacy(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'privacy failed: %',label; END IF;
 RAISE NOTICE 'privacy passed: %',label;
END$$;
DO $temp$ DECLARE n name; BEGIN
 SELECT nspname INTO STRICT n FROM pg_namespace WHERE oid=pg_my_temp_schema();
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon,authenticated,service_role',n);
END $temp$;
GRANT EXECUTE ON FUNCTION pg_temp.check_privacy(boolean,text) TO anon,authenticated,service_role;

SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) SELECT ('e6170000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(1,3)n;
INSERT INTO public.users(id,username) SELECT ('e6170000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'invoice_privacy_'||n FROM generate_series(1,3)n;
INSERT INTO public.profiles(id,username,display_name) SELECT ('e6170000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'invoice_privacy_'||n,'Invoice Privacy '||n FROM generate_series(1,3)n;
INSERT INTO public.clubs(id,club_id,name,owner_id,chip_treasury)
 VALUES('e6171000-0000-4000-8000-000000000001',961701,'Invoice Privacy Club','e6170000-0000-4000-8000-000000000001',0);
INSERT INTO public.club_members(club_id,user_id,role,status,is_active,membership_lifecycle_status,chip_balance)
 SELECT 'e6171000-0000-4000-8000-000000000001',('e6170000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  CASE WHEN n=1 THEN 'owner' ELSE 'player' END,'active',true,'active',0 FROM generate_series(1,3)n;
INSERT INTO public.settlement_periods(id,club_id,period_number,year,start_at,end_at,status)
 VALUES('e6172000-0000-4000-8000-000000000001','e6171000-0000-4000-8000-000000000001',36,2026,'2026-08-31 07:00Z','2026-09-07 07:00Z','open');
INSERT INTO public.chip_ledger(id,performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id)
 VALUES('e6173000-0000-4000-8000-000000000001','e6170000-0000-4000-8000-000000000001','club_treasury',
 'e6171000-0000-4000-8000-000000000001','player_wallet','e6170000-0000-4000-8000-000000000002',10.29,'rakeback','e6171000-0000-4000-8000-000000000001');
INSERT INTO public.settlement_invoices(id,club_id,source_ledger_id,invoice_type,invoice_number,from_entity_type,from_entity_id,to_entity_type,to_entity_id,gross_amount,net_amount,deductions,status,breakdown)
 VALUES('e6174000-0000-4000-8000-000000000001','e6171000-0000-4000-8000-000000000001','e6173000-0000-4000-8000-000000000001',
 'transaction_receipt','PRIVATE-PAYEE-TOKEN','club','e6171000-0000-4000-8000-000000000001','player','e6170000-0000-4000-8000-000000000002',10.29,10.29,0,'paid','{"category":"rakeback"}');
INSERT INTO public.settlement_invoices(id,club_id,period_id,invoice_type,invoice_number,from_entity_type,from_entity_id,to_entity_type,to_entity_id,gross_amount,net_amount,deductions,status,breakdown)
 VALUES('e6174000-0000-4000-8000-000000000002','e6171000-0000-4000-8000-000000000001','e6172000-0000-4000-8000-000000000001',
 'club_weekly_accounting','WEEKLY-CLUB-TOKEN','club','e6171000-0000-4000-8000-000000000001','club','e6171000-0000-4000-8000-000000000001',10.29,10.29,0,'paid','{"paid_players":10.29}');
INSERT INTO public.social_conversations(id,is_group,group_name,last_message_preview)
 SELECT ('e6175000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,true,'Club Accounting','Accounting Conversation' FROM generate_series(1,2)n;
INSERT INTO public.social_conversation_participants(conversation_id,user_id)
 SELECT ('e6175000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'e6170000-0000-4000-8000-000000000001' FROM generate_series(1,2)n;
INSERT INTO public.social_conversation_participants(conversation_id,user_id)
 VALUES('e6175000-0000-4000-8000-000000000001','e6170000-0000-4000-8000-000000000002');
-- The owner's weekly statement and archived sender copy share their own
-- issuer/sender/recipient mapping, separate from the individual payee's thread.
INSERT INTO public.accounting_conversations(scope_id,issuer_type,issuer_id,sender_id,recipient_id,conversation_id)
 VALUES('e6171000-0000-4000-8000-000000000001','club','e6171000-0000-4000-8000-000000000001','e6170000-0000-4000-8000-000000000001','e6170000-0000-4000-8000-000000000002','e6175000-0000-4000-8000-000000000001'),
 ('e6171000-0000-4000-8000-000000000001','club','e6171000-0000-4000-8000-000000000001','e6170000-0000-4000-8000-000000000001','e6170000-0000-4000-8000-000000000001','e6175000-0000-4000-8000-000000000002');
INSERT INTO public.social_messages(id,conversation_id,sender_id,content,message_type,media_metadata,created_at)
 VALUES('e6176000-0000-4000-8000-000000000001','e6175000-0000-4000-8000-000000000001','e6170000-0000-4000-8000-000000000001','PRIVATE-PAYEE-TOKEN 10.29 Chips','invoice','{"invoice_id":"e6174000-0000-4000-8000-000000000001","status":"paid"}','2026-09-14 10:00Z'),
 ('e6176000-0000-4000-8000-000000000002','e6175000-0000-4000-8000-000000000002','e6170000-0000-4000-8000-000000000001','PRIVATE-PAYEE-TOKEN archived club copy','invoice','{}','2026-09-14 10:00Z'),
 ('e6176000-0000-4000-8000-000000000003','e6175000-0000-4000-8000-000000000002','e6170000-0000-4000-8000-000000000001','WEEKLY-CLUB-TOKEN aggregate 10.29 Chips','invoice','{}','2026-09-14 10:00Z');
INSERT INTO public.notifications(id,user_id,type,title,message)
 VALUES('e6177000-0000-4000-8000-000000000001','e6170000-0000-4000-8000-000000000002','accounting_invoice','PRIVATE-PAYEE-TOKEN','10.29 Chips'),
 ('e6177000-0000-4000-8000-000000000002','e6170000-0000-4000-8000-000000000001','accounting_invoice_detail','PRIVATE-PAYEE-TOKEN','archived 10.29 Chips'),
 ('e6177000-0000-4000-8000-000000000003','e6170000-0000-4000-8000-000000000001','accounting_invoice','WEEKLY-CLUB-TOKEN','weekly aggregate');
INSERT INTO public.accounting_invoice_deliveries(invoice_id,recipient_id,message_id,notification_id,delivery_mode)
 VALUES('e6174000-0000-4000-8000-000000000001','e6170000-0000-4000-8000-000000000002','e6176000-0000-4000-8000-000000000001','e6177000-0000-4000-8000-000000000001','immediate'),
 ('e6174000-0000-4000-8000-000000000001','e6170000-0000-4000-8000-000000000001','e6176000-0000-4000-8000-000000000002','e6177000-0000-4000-8000-000000000002','weekly_detail'),
 ('e6174000-0000-4000-8000-000000000002','e6170000-0000-4000-8000-000000000001','e6176000-0000-4000-8000-000000000003','e6177000-0000-4000-8000-000000000003','immediate');
SET LOCAL session_replication_role=origin;
SET LOCAL row_security=on;
SET LOCAL request.jwt.claim.role='authenticated';
SET LOCAL request.jwt.claim.sub='e6170000-0000-4000-8000-000000000001';
SET LOCAL request.jwt.claims='{"role":"authenticated","sub":"e6170000-0000-4000-8000-000000000001"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.check_privacy(auth.uid()='e6170000-0000-4000-8000-000000000001' AND NOT public.fn_caller_is_engine(),'actual owner JWT with no engine authority');
SELECT pg_temp.check_privacy(NOT EXISTS(SELECT 1 FROM public.social_messages WHERE id='e6176000-0000-4000-8000-000000000001'),'owner participant cannot read payee message table');
SELECT pg_temp.check_privacy(NOT EXISTS(SELECT 1 FROM public.settlement_invoices WHERE id='e6174000-0000-4000-8000-000000000001'),'club-admin invoice policy cannot expose payee amount');
SELECT pg_temp.check_privacy(NOT EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries WHERE invoice_id='e6174000-0000-4000-8000-000000000001'),'archived owner copy does not expose delivery metadata');
SELECT pg_temp.check_privacy(NOT EXISTS(SELECT 1 FROM public.notifications WHERE id='e6177000-0000-4000-8000-000000000002'),'direct notification query excludes archived detail');
SELECT pg_temp.check_privacy(EXISTS(SELECT 1 FROM public.settlement_invoices WHERE id='e6174000-0000-4000-8000-000000000002'),'owner retains weekly aggregate document');
SELECT pg_temp.check_privacy(NOT EXISTS(SELECT 1 FROM public.fn_messenger_message_page(auth.uid(),'e6175000-0000-4000-8000-000000000001',NULL,NULL,1)),'legacy page cannot bypass private message RLS');
SELECT pg_temp.check_privacy(NOT EXISTS(SELECT 1 FROM public.fn_messenger_private_message_page(auth.uid(),'e6175000-0000-4000-8000-000000000001',NULL,NULL,1)),'new page has same protection');
SELECT pg_temp.check_privacy(NOT EXISTS(SELECT 1 FROM public.fn_messenger_search_messages(auth.uid(),ARRAY['e6175000-0000-4000-8000-000000000001'::uuid],'PRIVATE-PAYEE-TOKEN',1)),'legacy direct search cannot reopen payee invoice');
SELECT pg_temp.check_privacy((SELECT last_message_preview IS NULL FROM public.fn_messenger_private_accounting_threads(auth.uid(),ARRAY['e6175000-0000-4000-8000-000000000001'::uuid])),'issuer preview has no private invoice content before discussion');
RESET ROLE;

-- Recipient reads remain browser-role operations. Direct browser insertion
-- cannot update the conversation through its SECURITY INVOKER trigger.
SET LOCAL request.jwt.claim.sub='e6170000-0000-4000-8000-000000000002';
SET LOCAL request.jwt.claims='{"role":"authenticated","sub":"e6170000-0000-4000-8000-000000000002"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.check_privacy(EXISTS(SELECT 1 FROM public.settlement_invoices WHERE id='e6174000-0000-4000-8000-000000000001' AND net_amount=10.29),'payee retains exact own financial attachment');
SELECT pg_temp.check_privacy((SELECT count(*)=1 FROM public.fn_messenger_private_search_messages(auth.uid(),ARRAY['e6175000-0000-4000-8000-000000000001'::uuid],'PRIVATE-PAYEE-TOKEN',1)),'payee searches own verified receipt');
DO $direct_write_denied$ BEGIN
 BEGIN
  INSERT INTO public.social_messages(id,conversation_id,sender_id,content,message_type,created_at)
   VALUES('e6176000-0000-4000-8000-000000000004','e6175000-0000-4000-8000-000000000001',auth.uid(),'Please explain the weekly calculation.','text','2020-01-01 00:00Z');
  RAISE EXCEPTION 'unsupported direct browser discussion write accepted';
 EXCEPTION WHEN insufficient_privilege THEN
  IF SQLERRM <> 'permission denied for table social_conversations' THEN RAISE; END IF;
 END;
END $direct_write_denied$;
RESET ROLE;
SELECT pg_temp.check_privacy(
 NOT EXISTS(SELECT 1 FROM public.social_messages WHERE id='e6176000-0000-4000-8000-000000000004')
 AND (SELECT last_discussion_at IS NULL FROM public.accounting_conversations WHERE conversation_id='e6175000-0000-4000-8000-000000000001'),
 'rejected direct browser write leaves no message or discussion eligibility');

-- World Hub authenticates the sender and participant, then invokes its sender
-- RPC with the service-role client. Seed that persisted discussion boundary
-- using the same database role, with all real origin triggers active. This
-- deterministic reader fixture does not qualify the HTTP/RPC sender itself.
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claim.sub='';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SET LOCAL ROLE service_role;
SELECT pg_temp.check_privacy(current_user='service_role' AND auth.role()='service_role'
 AND auth.uid() IS NULL AND current_setting('session_replication_role')='origin',
 'discussion fixture setup uses service role and active origin triggers');
INSERT INTO public.social_messages(id,conversation_id,sender_id,content,message_type,created_at)
 VALUES('e6176000-0000-4000-8000-000000000004','e6175000-0000-4000-8000-000000000001','e6170000-0000-4000-8000-000000000002','Please explain the weekly calculation.','text','2020-01-01 00:00Z');
RESET ROLE;
SET LOCAL request.jwt.claim.role='authenticated';
SET LOCAL request.jwt.claim.sub='e6170000-0000-4000-8000-000000000002';
SET LOCAL request.jwt.claims='{"role":"authenticated","sub":"e6170000-0000-4000-8000-000000000002"}';
SELECT pg_temp.check_privacy((SELECT last_discussion_at IS NOT NULL FROM public.accounting_conversations WHERE conversation_id='e6175000-0000-4000-8000-000000000001'),'actual discussion trigger makes reply thread eligible');
UPDATE public.social_conversations SET last_message_preview='PRIVATE-PAYEE-TOKEN 10.29 Chips'
 WHERE id='e6175000-0000-4000-8000-000000000001';
SELECT pg_temp.check_privacy((SELECT last_message_preview='Accounting Conversation' FROM public.social_conversations WHERE id='e6175000-0000-4000-8000-000000000001'),'actual preview guard neutralizes a later invoice writer');
SET LOCAL request.jwt.claim.sub='e6170000-0000-4000-8000-000000000001';
SET LOCAL request.jwt.claims='{"role":"authenticated","sub":"e6170000-0000-4000-8000-000000000001"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.check_privacy((SELECT id='e6176000-0000-4000-8000-000000000004' FROM public.fn_messenger_private_message_page(auth.uid(),'e6175000-0000-4000-8000-000000000001',NULL,NULL,1)),'hidden newer invoice cannot consume discussion page limit');
SELECT pg_temp.check_privacy((SELECT last_message_preview='Please explain the weekly calculation.' FROM public.fn_messenger_private_accounting_threads(auth.uid(),ARRAY['e6175000-0000-4000-8000-000000000001'::uuid])),'issuer preview contains genuine discussion only');
SELECT pg_temp.check_privacy(NOT EXISTS(SELECT 1 FROM public.fn_messenger_private_search_messages(auth.uid(),ARRAY['e6175000-0000-4000-8000-000000000001'::uuid],'PRIVATE-PAYEE-TOKEN',1)),'discussion eligibility never grants financial attachment search');
DO $denied$ BEGIN
 BEGIN
   PERFORM public.fn_messenger_private_message_page('e6170000-0000-4000-8000-000000000002','e6175000-0000-4000-8000-000000000001',NULL,NULL,1);
   RAISE EXCEPTION 'forged reader actor accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $denied$;
RESET ROLE;
SET LOCAL request.jwt.claim.sub='e6170000-0000-4000-8000-000000000003';
SET LOCAL request.jwt.claims='{"role":"authenticated","sub":"e6170000-0000-4000-8000-000000000003"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.check_privacy(NOT EXISTS(SELECT 1 FROM public.social_messages WHERE conversation_id='e6175000-0000-4000-8000-000000000001'),'unrelated member cannot read discussion or private attachment');
RESET ROLE;
SET LOCAL request.jwt.claim.role='anon';
SET LOCAL request.jwt.claim.sub='e6170000-0000-4000-8000-000000000002';
SET LOCAL request.jwt.claims='{"role":"anon","sub":"e6170000-0000-4000-8000-000000000002"}';
SET LOCAL ROLE anon;
SELECT pg_temp.check_privacy(NOT EXISTS(SELECT 1 FROM public.social_messages WHERE conversation_id='e6175000-0000-4000-8000-000000000001'),'anonymous subject-shaped claim cannot read private messages');
SELECT pg_temp.check_privacy(NOT has_function_privilege(current_user,'public.fn_messenger_private_message_page(uuid,uuid,timestamptz,uuid,integer)','EXECUTE'),'anonymous private RPC unavailable');
RESET ROLE;
ROLLBACK;
