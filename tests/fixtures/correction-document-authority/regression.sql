\set ON_ERROR_STOP on
-- SOURCE ONLY / UNRUN. Full-catalog isolated PostgreSQL 17 fixture, never production.
BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='3s';
DO $guard$ BEGIN
 IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL OR current_setting('session_replication_role')<>'origin'
  OR to_regclass('public.accounting_correction_documents') IS NULL
 THEN RAISE EXCEPTION 'isolated complete correction authority required';END IF;
END $guard$;
CREATE FUNCTION pg_temp.correction_check(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'correction fixture failed: %',label;END IF;
 RAISE NOTICE 'correction fixture passed: %',label;
END$$;
CREATE FUNCTION pg_temp.correction_actor(who uuid,role_name text DEFAULT 'authenticated') RETURNS void LANGUAGE plpgsql AS $$BEGIN
 PERFORM set_config('request.jwt.claim.sub',COALESCE(who::text,''),true);
 PERFORM set_config('request.jwt.claim.role',role_name,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('role',role_name,'sub',who)::text,true);
END$$;
CREATE FUNCTION pg_temp.correction_id(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
 SELECT ('e6480000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
-- Full authoritative row snapshots, including IDs and prior delivery rows.
-- Sequence increments do not roll back and are expressly outside row equality.
CREATE FUNCTION pg_temp.correction_state() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE relation_name text;rows_json jsonb;result jsonb:='{}';BEGIN
 FOREACH relation_name IN ARRAY ARRAY['clubs','unions','union_wallets','club_members','agents','cashout_requests','chip_escrow',
  'chip_ledger','chip_ledger_idem','chip_transactions','wallet_transactions','club_wallet_transactions','union_wallet_transactions',
  'accounting_cashier_events','accounting_correction_documents','settlement_invoices','accounting_invoice_deliveries','accounting_conversations',
  'social_messages','social_conversations','social_conversation_participants','notifications','push_outbox','push_subscriptions',
  'credit_assignments','accounting_agreement_history','messages','ca_drift_incidents','ca_incident_events','ca_ledger_write_failures',
  'ca_incident_notify_ledger','ca_ledger_day_manifests','ca_ledger_day_manifest_restatements','ca_ledger_mutation_log','ca_mint_ledger',
  'financial_alerts','tournament_escrow','spin_reserve_ledger'] LOOP
  EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM public.%I t',relation_name) INTO rows_json;
  result:=result||jsonb_build_object(relation_name,rows_json);
 END LOOP;RETURN result;
END$$;
CREATE FUNCTION pg_temp.correction_stores() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_object_agg(key,value) FROM jsonb_each(pg_temp.correction_state())
 WHERE key=ANY(ARRAY['clubs','unions','union_wallets','club_members','agents','cashout_requests','chip_escrow','chip_transactions',
 'wallet_transactions','club_wallet_transactions','union_wallet_transactions','ca_mint_ledger','tournament_escrow','spin_reserve_ledger']);
$$;
DO $temp$ DECLARE n name;BEGIN SELECT nspname INTO STRICT n FROM pg_namespace WHERE oid=pg_my_temp_schema();
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO authenticated,service_role',n);END$temp$;
REVOKE ALL ON FUNCTION pg_temp.correction_state(),pg_temp.correction_stores() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pg_temp.correction_check(boolean,text),pg_temp.correction_actor(uuid,text),pg_temp.correction_id(integer),
 pg_temp.correction_state(),pg_temp.correction_stores() TO authenticated,service_role;
CREATE TEMP TABLE correction_receipts(label text PRIMARY KEY,result jsonb,invoice_id uuid,conversation_id uuid,message_id uuid,notification_id uuid);
GRANT SELECT,INSERT,UPDATE ON correction_receipts TO authenticated,service_role;

-- Replica is confined to a synthetic baseline, including intentionally old
-- unqualified documents. All actual writer/reader probes below run origin.
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) SELECT pg_temp.correction_id(n) FROM generate_series(1,8)n;
INSERT INTO public.users(id,username) SELECT pg_temp.correction_id(n),'correction_fixture_'||n FROM generate_series(1,8)n;
INSERT INTO public.profiles(id,username,display_name) SELECT pg_temp.correction_id(n),'correction_fixture_'||n,'Correction Fixture '||n FROM generate_series(1,8)n;
INSERT INTO auth.users(id) VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d') ON CONFLICT(id) DO NOTHING;
INSERT INTO public.users(id,username) VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d','correction_system_fixture') ON CONFLICT(id) DO NOTHING;
INSERT INTO public.profiles(id,username) VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d','correction_system_fixture') ON CONFLICT(id) DO NOTHING;
INSERT INTO public.clubs(id,club_id,name,owner_id,chip_treasury,is_union,asset) VALUES
 (pg_temp.correction_id(101),964801,'Correction Club',pg_temp.correction_id(1),1000,false,'chips'),
 (pg_temp.correction_id(102),964802,'Other Correction Club',pg_temp.correction_id(6),1000,false,'chips');
INSERT INTO public.club_members(club_id,user_id,role,status,is_active,membership_lifecycle_status,chip_balance)
 SELECT pg_temp.correction_id(101),pg_temp.correction_id(n),CASE n WHEN 1 THEN 'owner' WHEN 3 THEN 'co_owner' WHEN 4 THEN 'admin' ELSE 'player' END,
 'active',true,'active',100 FROM generate_series(1,5)n;
-- The physical player route stays a player even if the same user has an agent row.
INSERT INTO public.agents(id,club_id,user_id,role,status,commission_rate,player_rakeback_rate,credit_limit,credit_used,is_prepaid,agent_wallet_balance)
 VALUES(pg_temp.correction_id(202),pg_temp.correction_id(101),pg_temp.correction_id(2),'agent','active',0,0,0,0,true,100);
INSERT INTO public.unions(id,name,owner_id,slug,chip_balance,rake_wallet,bbj_wallet,promo_wallet)
 VALUES(pg_temp.correction_id(110),'Correction Union',pg_temp.correction_id(6),'correction-union-fixture',1000,0,0,0),
 (pg_temp.correction_id(111),'Ambiguous Union',pg_temp.correction_id(7),'ambiguous-union-fixture',1000,0,0,0);
INSERT INTO public.union_wallets(id,union_id,chip_balance) VALUES(pg_temp.correction_id(120),pg_temp.correction_id(110),1000),
 (pg_temp.correction_id(110),pg_temp.correction_id(111),1000);
-- Unscoped incident rows isolate correction linkage from unrelated incident opening alerts.
INSERT INTO public.ca_drift_incidents(id,source,dedupe_key,discrepancy_amount)
 SELECT pg_temp.correction_id(300+n),'correction-fixture','correction-fixture:'||n,1 FROM generate_series(1,30)n;
INSERT INTO public.ca_ledger_write_failures(id,club_id,user_id,delta,sqlstate,message)
 VALUES(9648001,pg_temp.correction_id(101),pg_temp.correction_id(2),1,'XX000','Private write failure diagnostic');
-- An old invoice is synthetic historical evidence, not newly issued by34.
INSERT INTO public.chip_ledger(id,performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,description,idempotency_key,metadata)
 VALUES(pg_temp.correction_id(501),pg_temp.correction_id(1),'club_treasury',pg_temp.correction_id(101),'player_wallet',pg_temp.correction_id(2),77.25,'correction',pg_temp.correction_id(101),
 'LEGACY_PRIVATE_DIAGNOSTIC','correction:inc:'||pg_temp.correction_id(330),jsonb_build_object('incident_id',pg_temp.correction_id(330),'posted_via','fn_ca_post_correction'));
INSERT INTO public.chip_ledger_idem(idempotency_key,leg_id) VALUES('correction:inc:'||pg_temp.correction_id(330),pg_temp.correction_id(501));
INSERT INTO public.settlement_invoices(id,club_id,invoice_type,invoice_number,from_entity_type,from_entity_id,to_entity_type,to_entity_id,gross_amount,net_amount,deductions,breakdown,
 status,chips_transferred,transferred_at,source_ledger_id,message_sent,message_sent_at,notes)
 VALUES(pg_temp.correction_id(601),pg_temp.correction_id(101),'club_to_agent','LEGACY-CORRECTION-001','club',pg_temp.correction_id(101)::text,'agent',pg_temp.correction_id(2)::text,
 77.25,77.25,0,'{"category":"correction","reason":"LEGACY_PRIVATE_DIAGNOSTIC"}','paid',true,now()-interval '2 days',pg_temp.correction_id(501),true,now()-interval '2 days','LEGACY_PRIVATE_DIAGNOSTIC');
-- Reproduce old immediate delivery to payee AND issuer/co-owner/admin. User8
-- is the recorded historical sender; no current owner is substituted for them.
INSERT INTO public.social_conversations(id,is_group,group_name,last_message_preview,last_message_at)
 SELECT pg_temp.correction_id(700+n),true,'Correction Club Accounting','Accounting Conversation',now()-interval '2 days' FROM generate_series(1,4)n;
INSERT INTO public.social_conversation_participants(conversation_id,user_id)
 SELECT DISTINCT pg_temp.correction_id(700+n),u FROM generate_series(1,4)n CROSS JOIN LATERAL unnest(ARRAY[pg_temp.correction_id(8),pg_temp.correction_id(n)])u;
INSERT INTO public.accounting_conversations(scope_id,issuer_type,issuer_id,sender_id,recipient_id,conversation_id)
 SELECT pg_temp.correction_id(101),'club',pg_temp.correction_id(101),pg_temp.correction_id(8),pg_temp.correction_id(n),pg_temp.correction_id(700+n) FROM generate_series(1,4)n;
INSERT INTO public.social_messages(id,conversation_id,sender_id,content,message_type,media_metadata,created_at)
 SELECT pg_temp.correction_id(800+n),pg_temp.correction_id(700+n),pg_temp.correction_id(8),'LEGACY_PRIVATE_DIAGNOSTIC Paid 77.25','invoice',
 jsonb_build_object('kind','accounting_invoice','invoice_id',pg_temp.correction_id(601),'invoice_type','club_to_agent','amount',77.25,'status','paid','reason','LEGACY_PRIVATE_DIAGNOSTIC'),now()-interval '2 days' FROM generate_series(1,4)n;
INSERT INTO public.notifications(id,user_id,type,title,message,data,metadata,read)
 SELECT pg_temp.correction_id(900+n),pg_temp.correction_id(n),'accounting_invoice','Invoice LEGACY-CORRECTION-001','Transfer Recorded: 77.25 Chips',
 jsonb_build_object('invoice_id',pg_temp.correction_id(601),'reason','LEGACY_PRIVATE_DIAGNOSTIC'),jsonb_build_object('invoice_id',pg_temp.correction_id(601)),false FROM generate_series(1,4)n;
INSERT INTO public.accounting_invoice_deliveries(invoice_id,recipient_id,message_id,notification_id,delivery_mode)
 SELECT pg_temp.correction_id(601),pg_temp.correction_id(n),pg_temp.correction_id(800+n),pg_temp.correction_id(900+n),'immediate' FROM generate_series(1,4)n;
SET LOCAL session_replication_role=origin;
CREATE TEMP TABLE correction_baseline AS SELECT pg_temp.correction_stores() AS stores,pg_temp.correction_state() AS rows;
GRANT SELECT ON correction_baseline TO authenticated,service_role;
SELECT pg_temp.correction_actor(NULL,'service_role');
SET LOCAL ROLE service_role;
INSERT INTO correction_receipts(label,result) VALUES('club_player',public.fn_ca_post_correction('club_treasury',pg_temp.correction_id(101),'player_wallet',pg_temp.correction_id(2),10.25,
 repeat('PRIVATE_REASON_DO_NOT_PUBLISH ',50),pg_temp.correction_id(301),NULL,pg_temp.correction_id(101),NULL,
 jsonb_build_object('posted_via','forged-caller-string','incident_id',pg_temp.correction_id(999),'actor','PRIVATE_ACTOR','wallet_after',999)));
INSERT INTO correction_receipts(label,result) VALUES('union_club',public.fn_ca_post_correction('union_wallet',pg_temp.correction_id(120),'club_treasury',pg_temp.correction_id(101),12.50,
 'Recorded union wallet correction for fixture only',pg_temp.correction_id(302),NULL,NULL,pg_temp.correction_id(110)));
INSERT INTO correction_receipts(label,result) VALUES('club_agent',public.fn_ca_post_correction('club_treasury',pg_temp.correction_id(101),'agent_wallet',pg_temp.correction_id(2),13.75,
 'Recorded agent correction for fixture only',NULL,9648001,pg_temp.correction_id(101)));
RESET ROLE;
UPDATE correction_receipts r SET invoice_id=d.invoice_id,conversation_id=m.conversation_id,message_id=a.message_id,notification_id=a.notification_id
 FROM public.accounting_correction_documents d JOIN public.accounting_invoice_deliveries a ON a.invoice_id=d.invoice_id
 JOIN public.social_messages m ON m.id=a.message_id WHERE d.source_ledger_id=(r.result->>'ledger_id')::uuid AND a.recipient_id=CASE WHEN r.label='union_club' THEN pg_temp.correction_id(1) ELSE pg_temp.correction_id(2) END;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.correction_check((SELECT count(*)=3 AND bool_and((result->>'ok'='true' AND result->>'replayed'='false' AND invoice_id IS NOT NULL) IS TRUE) FROM correction_receipts),'real service correction writer creates canonical documents');
SELECT pg_temp.correction_check(pg_temp.correction_stores()=(SELECT stores FROM correction_baseline),'supported correction journal routes change no wallet, treasury, cashout, escrow or issuance store');
SELECT pg_temp.correction_check((SELECT d.payee_type='player' AND length(l.description)=900 AND l.metadata->>'posted_via'='fn_ca_post_correction'
 FROM public.accounting_correction_documents d JOIN public.chip_ledger l ON l.id=d.source_ledger_id WHERE d.invoice_id=(SELECT invoice_id FROM correction_receipts WHERE label='club_player')),'physical player classification and unchanged captured reason/metadata writer semantics');
SELECT pg_temp.correction_check((SELECT d.club_id=pg_temp.correction_id(101) AND d.source_club_id IS NULL AND d.issuer_id=pg_temp.correction_id(110)
 AND d.audience_user_ids=ARRAY[pg_temp.correction_id(1),pg_temp.correction_id(3),pg_temp.correction_id(4),pg_temp.correction_id(6)]
 FROM public.accounting_correction_documents d WHERE d.invoice_id=(SELECT invoice_id FROM correction_receipts WHERE label='union_club')),'exact physical union-wallet ID resolves union party; endpoint proves real club; existing entity authority frozen');
DO $documents$ DECLARE d public.accounting_correction_documents%ROWTYPE;payload jsonb;BEGIN
 FOR d IN SELECT * FROM public.accounting_correction_documents WHERE club_id=pg_temp.correction_id(101) LOOP
  payload:=public.fn_accounting_correction_assert_delivery(d.id);
  PERFORM pg_temp.correction_check(payload=jsonb_build_object('contract_version',1,'document_id',d.id,'invoice_id',d.invoice_id,'source_ledger_id',d.source_ledger_id,
   'event_kind','correction_recorded','display_state','recorded','amount',round(d.amount,2)::text,'club_id',d.club_id,'union_id',d.union_id,
   'recorded_at',d.recorded_at,'issued_at',d.issued_at,'payment_proven',false,'new_chip_movement_claimed',false,'original_payment_invoice_id',NULL),'exact typed record-only public payload');
  PERFORM pg_temp.correction_check((SELECT count(*)=cardinality(d.audience_user_ids) FROM public.push_outbox o JOIN public.accounting_invoice_deliveries a ON a.notification_id=o.accounting_notification_id WHERE a.invoice_id=d.invoice_id),'durable canonical outbox for every intended recipient');
  PERFORM pg_temp.correction_check(NOT EXISTS(SELECT 1 FROM public.social_messages m JOIN public.accounting_invoice_deliveries a ON a.message_id=m.id WHERE a.invoice_id=d.invoice_id AND (m.content LIKE '%PRIVATE_%' OR m.media_metadata::text LIKE '%PRIVATE_%')),'private diagnostic and actor fields never published');
 END LOOP;
END$documents$;
-- Exact document replay survives timezone/DateStyle changes without row rewrites.
DO $replay$ DECLARE before_state jsonb;r record;original jsonb;again jsonb;BEGIN
 before_state:=pg_temp.correction_state();
 FOR r IN SELECT * FROM correction_receipts LOOP
  original:=public.fn_accounting_correction_contract(r.invoice_id);
  PERFORM set_config('TimeZone','America/Chicago',true);PERFORM set_config('DateStyle','SQL,DMY',true);
  PERFORM pg_temp.correction_check(public.fn_invoice_accounting_ledger_transfer((r.result->>'ledger_id')::uuid)=r.invoice_id,'same canonical invoice on replay');
  again:=public.fn_accounting_correction_contract(r.invoice_id);
  PERFORM pg_temp.correction_check(again=original,'canonical UTC dates independent of caller settings');
 END LOOP;
 PERFORM pg_temp.correction_check(pg_temp.correction_state()=before_state,'exact replay preserves all authoritative rows');
END$replay$;
SET LOCAL TimeZone='UTC';SET LOCAL DateStyle='ISO,YMD';
SELECT pg_temp.correction_actor(NULL,'service_role');SET LOCAL ROLE service_role;
DO $writer_boundary$ DECLARE before_state jsonb;r jsonb;BEGIN
 before_state:=pg_temp.correction_state();
 r:=public.fn_ca_post_correction('player_wallet',pg_temp.correction_id(5),'club_treasury',pg_temp.correction_id(101),99,
 'Different historical caller intent cannot be certified',pg_temp.correction_id(301),NULL,pg_temp.correction_id(101));
 PERFORM pg_temp.correction_check(r->>'replayed'='true' AND r->>'ledger_id'=(SELECT result->>'ledger_id' FROM correction_receipts WHERE label='club_player')
 AND pg_temp.correction_state()=before_state,'known unchanged writer replay returns original linkage; document does not certify changed input');
 BEGIN PERFORM public.fn_invoice_accounting_ledger_transfer(pg_temp.correction_id(501));RAISE EXCEPTION 'historical adoption accepted';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'historical_correction_document_unverified' THEN RAISE;END IF;END;
 BEGIN PERFORM public.fn_deliver_accounting_invoice(pg_temp.correction_id(601));RAISE EXCEPTION 'historical redelivery accepted';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'historical_correction_document_unverified' THEN RAISE;END IF;END;
 PERFORM pg_temp.correction_check(pg_temp.correction_state()=before_state,'legacy adoption and redelivery refuse without rewriting history');
END$writer_boundary$;
DO $unsupported$ DECLARE before_state jsonb;BEGIN
 before_state:=pg_temp.correction_state();
 BEGIN PERFORM public.fn_ca_post_correction('union_bank',pg_temp.correction_id(110),'club_treasury',pg_temp.correction_id(101),1,'Ambiguous union physical identity must refuse',pg_temp.correction_id(303),NULL,pg_temp.correction_id(101),pg_temp.correction_id(110));
 RAISE EXCEPTION 'ambiguous physical union accepted';EXCEPTION WHEN check_violation THEN IF SQLERRM<>'correction_document_union_identity_unverified' THEN RAISE;END IF;END;
 PERFORM pg_temp.correction_check(pg_temp.correction_state()=before_state,'ambiguous physical union identity leaves all rows unchanged');
 BEGIN PERFORM public.fn_ca_post_correction('player_wallet',pg_temp.correction_id(2),'agent_wallet',pg_temp.correction_id(5),1,'Unscoped correction cannot invent a club',pg_temp.correction_id(304));
 RAISE EXCEPTION 'unscoped correction accepted';EXCEPTION WHEN check_violation THEN IF SQLERRM<>'correction_document_club_scope_unverified' THEN RAISE;END IF;END;
 PERFORM pg_temp.correction_check(pg_temp.correction_state()=before_state,'unscoped route leaves all rows unchanged');
 BEGIN PERFORM public.fn_ca_post_correction('club_treasury',pg_temp.correction_id(101),'club_treasury',pg_temp.correction_id(102),1,'Conflicting physical club scopes must refuse',pg_temp.correction_id(305),NULL,pg_temp.correction_id(101));
 RAISE EXCEPTION 'conflicting clubs accepted';EXCEPTION WHEN check_violation THEN IF SQLERRM<>'correction_document_club_scope_unverified' THEN RAISE;END IF;END;
 PERFORM pg_temp.correction_check(pg_temp.correction_state()=before_state,'conflicting club route leaves all rows unchanged');
END$unsupported$;
DO $invalid_amount$ DECLARE before_state jsonb;amount numeric;r jsonb;BEGIN
 before_state:=pg_temp.correction_state();
 FOREACH amount IN ARRAY ARRAY[0::numeric,-1::numeric,1.001::numeric] LOOP
  r:=public.fn_ca_post_correction('club_treasury',pg_temp.correction_id(101),'player_wallet',pg_temp.correction_id(2),amount,
   'Invalid caller amount must preserve the existing writer refusal',pg_temp.correction_id(316),NULL,pg_temp.correction_id(101));
  PERFORM pg_temp.correction_check(r=jsonb_build_object('ok',false,'reason','amount_must_be_positive_cents')
   AND pg_temp.correction_state()=before_state,'existing writer amount refusal leaves every authoritative row unchanged');
 END LOOP;
 -- NaN is representable in the captured numeric column. The new document
 -- source gate refuses it; this does not imply all nonfinite values reach it.
 BEGIN PERFORM public.fn_ca_post_correction('club_treasury',pg_temp.correction_id(101),'player_wallet',pg_temp.correction_id(2),'NaN'::numeric,
  'Nonfinite correction document must never be issued',pg_temp.correction_id(316),NULL,pg_temp.correction_id(101));
  RAISE EXCEPTION 'nonfinite document accepted';EXCEPTION WHEN check_violation THEN IF SQLERRM<>'correction_document_source_unverified' THEN RAISE;END IF;END;
 PERFORM pg_temp.correction_check(pg_temp.correction_state()=before_state,'nonfinite document refusal rolls back the attempted journal row');
END$invalid_amount$;
RESET ROLE;
-- Actual authenticated payee: raw legacy records are unavailable; only the
-- exact private identity placeholder may survive. New record-only receipts work.
SELECT pg_temp.correction_actor(pg_temp.correction_id(2));SET LOCAL ROLE authenticated;
DO $payee$ DECLARE page record;expected jsonb;ids uuid[];before_state jsonb;BEGIN
 before_state:=pg_temp.correction_state();
 PERFORM pg_temp.correction_check(NOT EXISTS(SELECT 1 FROM public.settlement_invoices WHERE id=pg_temp.correction_id(601))
  AND NOT EXISTS(SELECT 1 FROM public.social_messages WHERE id=pg_temp.correction_id(802))
  AND NOT EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries WHERE invoice_id=pg_temp.correction_id(601))
  AND NOT EXISTS(SELECT 1 FROM public.notifications WHERE id=pg_temp.correction_id(902)),'payee cannot read old paid facts from raw invoice/message/delivery/notice');
 PERFORM pg_temp.correction_check((SELECT last_message_preview='Accounting Conversation' FROM public.social_conversations WHERE id=pg_temp.correction_id(702)),
  'raw conversation retains predecessor generic preview without old payment text');
 expected:=jsonb_build_object('kind','accounting_invoice','invoice_identity_verified',true,'correction_unverified',true,
  'accounting_verified',false,'correction_verified',false,'invoice_id',pg_temp.correction_id(601),'invoice_type','club_to_agent',
  'source_ledger_id',pg_temp.correction_id(501),'club_id',pg_temp.correction_id(101),'union_id',NULL);
 SELECT * INTO STRICT page FROM public.fn_messenger_message_page(auth.uid(),pg_temp.correction_id(702)) WHERE id=pg_temp.correction_id(802);
 PERFORM pg_temp.correction_check(page.media_metadata=expected AND page.content='Correction receipt unavailable.','private historical page exposes exact identity and nothing financial');
 SELECT * INTO STRICT page FROM public.fn_messenger_search_messages(auth.uid(),ARRAY[pg_temp.correction_id(702)],'receipt unavailable') WHERE id=pg_temp.correction_id(802);
 PERFORM pg_temp.correction_check(page.media_metadata=expected AND page.content='Correction receipt unavailable.','private search uses same sanitized identity');
 SELECT * INTO STRICT page FROM public.fn_messenger_private_message_page(auth.uid(),pg_temp.correction_id(702)) WHERE id=pg_temp.correction_id(802);
 PERFORM pg_temp.correction_check(page.media_metadata=expected AND page.content='Correction receipt unavailable.','publicly named private page wrapper preserves identity-only proof');
 SELECT * INTO STRICT page FROM public.fn_messenger_private_search_messages(auth.uid(),ARRAY[pg_temp.correction_id(702)],'receipt unavailable') WHERE id=pg_temp.correction_id(802);
 PERFORM pg_temp.correction_check(page.media_metadata=expected,'private search wrapper preserves identity-only proof');
 PERFORM pg_temp.correction_check(NOT EXISTS(SELECT 1 FROM public.fn_messenger_search_messages(auth.uid(),ARRAY[pg_temp.correction_id(702)],'LEGACY_PRIVATE_DIAGNOSTIC'))
  AND NOT EXISTS(SELECT 1 FROM public.fn_messenger_search_messages(auth.uid(),ARRAY[pg_temp.correction_id(702)],'77.25')),'legacy search cannot reveal raw reason or amount by matching');
 SELECT * INTO STRICT page FROM public.fn_messenger_accounting_threads(auth.uid(),ARRAY[pg_temp.correction_id(702)]);
 PERFORM pg_temp.correction_check(page.recipient_visible AND page.last_message_preview='Correction receipt unavailable.','private historical thread preview is safe');
 SELECT * INTO STRICT page FROM public.fn_messenger_private_accounting_threads(auth.uid(),ARRAY[pg_temp.correction_id(702)]);
 PERFORM pg_temp.correction_check(page.recipient_visible AND page.last_message_preview='Correction receipt unavailable.','private thread wrapper preserves safe preview');
 SELECT * INTO STRICT page FROM public.fn_messenger_message_page(auth.uid(),(SELECT conversation_id FROM correction_receipts WHERE label='club_player'))
  WHERE id=(SELECT message_id FROM correction_receipts WHERE label='club_player');
 PERFORM pg_temp.correction_check(page.media_metadata->>'accounting_verified'='true' AND page.media_metadata->>'correction_verified'='true'
  AND NOT(page.media_metadata ?| ARRAY['invoice_identity_verified','correction_unverified']) AND page.media_metadata->>'status'='generated'
  AND page.media_metadata->'chips_transferred'='false'::jsonb AND page.media_metadata->'due_at'='null'::jsonb AND page.media_metadata->'transferred_at'='null'::jsonb
  AND page.media_metadata->>'amount'='10.25','new correction page gives authoritative record-only proof and omits legacy flags');
 PERFORM pg_temp.correction_check(pg_temp.correction_state()=before_state,'all authenticated payee reads have no authoritative row mutations');
 BEGIN PERFORM public.fn_messenger_message_page(pg_temp.correction_id(1),pg_temp.correction_id(701));RAISE EXCEPTION 'foreign viewer identity accepted';
 EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'message_page_not_authorised' THEN RAISE;END IF;END;
END$payee$;
RESET ROLE;
-- Owner/co-owner/admin still receive their entity summary/correction where they
-- are the actual entity party. They never receive individual payee detail.
DO $issuer_roles$ DECLARE n int;who uuid;before_state jsonb;page record;new_invoice uuid;old_conv uuid;BEGIN
 before_state:=pg_temp.correction_state();
 FOREACH n IN ARRAY ARRAY[1,3,4] LOOP
  who:=pg_temp.correction_id(n);old_conv:=pg_temp.correction_id(700+n);
  PERFORM pg_temp.correction_actor(who);EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM pg_temp.correction_check(NOT EXISTS(SELECT 1 FROM public.settlement_invoices WHERE id=pg_temp.correction_id(601))
   AND NOT EXISTS(SELECT 1 FROM public.social_messages WHERE id=pg_temp.correction_id(800+n))
   AND NOT EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries WHERE invoice_id=pg_temp.correction_id(601))
   AND NOT EXISTS(SELECT 1 FROM public.notifications WHERE id=pg_temp.correction_id(900+n)), 'legacy raw paid detail hidden from issuer role '||n);
  PERFORM pg_temp.correction_check((SELECT last_message_preview='Accounting Conversation' FROM public.social_conversations WHERE id=old_conv),
   'raw issuer conversation contains only predecessor generic preview '||n);
  PERFORM pg_temp.correction_check(NOT EXISTS(SELECT 1 FROM public.fn_messenger_message_page(who,old_conv) WHERE id=pg_temp.correction_id(800+n))
   AND NOT EXISTS(SELECT 1 FROM public.fn_messenger_search_messages(who,ARRAY[old_conv],'receipt unavailable'))
   AND NOT EXISTS(SELECT 1 FROM public.fn_messenger_search_messages(who,ARRAY[old_conv],'LEGACY_PRIVATE_DIAGNOSTIC')),'legacy private page/search deny issuer placeholder '||n);
  PERFORM pg_temp.correction_check(NOT EXISTS(SELECT 1 FROM public.fn_messenger_private_message_page(who,old_conv))
   AND NOT EXISTS(SELECT 1 FROM public.fn_messenger_private_search_messages(who,ARRAY[old_conv],'receipt unavailable')),'private wrappers also deny legacy issuer placeholder '||n);
  SELECT * INTO STRICT page FROM public.fn_messenger_accounting_threads(who,ARRAY[old_conv]);
  PERFORM pg_temp.correction_check(page.recipient_visible=false AND page.last_message_preview IS NULL AND page.last_message_at IS NULL,'legacy issuer thread gives no financial preview '||n);
  SELECT * INTO STRICT page FROM public.fn_messenger_private_accounting_threads(who,ARRAY[old_conv]);
  PERFORM pg_temp.correction_check(page.recipient_visible=false AND page.last_message_preview IS NULL,'private thread wrapper denies legacy issuer preview '||n);
  SELECT invoice_id INTO new_invoice FROM correction_receipts WHERE label='club_player';
  PERFORM pg_temp.correction_check(NOT EXISTS(SELECT 1 FROM public.settlement_invoices WHERE id=new_invoice)
   AND NOT EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries WHERE invoice_id=new_invoice)
   AND NOT EXISTS(SELECT 1 FROM public.notifications WHERE data->>'invoice_id'=new_invoice::text)
   AND NOT EXISTS(SELECT 1 FROM public.social_messages WHERE id=(SELECT message_id FROM correction_receipts WHERE label='club_player')),'new individual correction remains payee only for role '||n);
  IF n=1 THEN
   PERFORM pg_temp.correction_check(NOT EXISTS(SELECT 1 FROM public.fn_messenger_message_page(who,(SELECT conversation_id FROM correction_receipts WHERE label='club_player')))
    AND NOT EXISTS(SELECT 1 FROM public.fn_messenger_search_messages(who,ARRAY[(SELECT conversation_id FROM correction_receipts WHERE label='club_player')],'Correction Recorded')),'new issuer participant cannot page/search individual receipt');
  END IF;
  PERFORM pg_temp.correction_check(EXISTS(SELECT 1 FROM public.settlement_invoices WHERE id=(SELECT invoice_id FROM correction_receipts WHERE label='union_club')),'existing authorized entity recipient retains union-to-club correction '||n);
  EXECUTE 'RESET ROLE';
 END LOOP;
 PERFORM pg_temp.correction_check(pg_temp.correction_state()=before_state,'issuer role probes preserve authoritative rows');
END$issuer_roles$;
-- Each malformed legacy proof loses its placeholder; no diagnostic is exposed.
DO $malformed_history$ DECLARE original_meta jsonb;before_state jsonb;BEGIN
 SELECT media_metadata INTO original_meta FROM public.social_messages WHERE id=pg_temp.correction_id(802);
 before_state:=pg_temp.correction_state();
 PERFORM set_config('session_replication_role','replica',true);
 UPDATE public.social_messages SET media_metadata=media_metadata||jsonb_build_object('invoice_id',pg_temp.correction_id(699)) WHERE id=pg_temp.correction_id(802);
 PERFORM set_config('session_replication_role','origin',true);PERFORM pg_temp.correction_actor(pg_temp.correction_id(2));EXECUTE 'SET LOCAL ROLE authenticated';
 PERFORM pg_temp.correction_check(NOT EXISTS(SELECT 1 FROM public.fn_messenger_message_page(auth.uid(),pg_temp.correction_id(702))), 'mismatched actual message/invoice join refuses placeholder');
 EXECUTE 'RESET ROLE';PERFORM set_config('session_replication_role','replica',true);
 UPDATE public.social_messages SET media_metadata=original_meta WHERE id=pg_temp.correction_id(802);
 UPDATE public.chip_ledger SET club_id=pg_temp.correction_id(102) WHERE id=pg_temp.correction_id(501);
 PERFORM set_config('session_replication_role','origin',true);EXECUTE 'SET LOCAL ROLE authenticated';
 PERFORM pg_temp.correction_check(NOT EXISTS(SELECT 1 FROM public.fn_messenger_private_message_page(auth.uid(),pg_temp.correction_id(702)))
  AND NOT EXISTS(SELECT 1 FROM public.fn_messenger_private_search_messages(auth.uid(),ARRAY[pg_temp.correction_id(702)],'receipt unavailable')),
  'conflicting recorded source club refuses even identity-only history');
 EXECUTE 'RESET ROLE';PERFORM set_config('session_replication_role','replica',true);
 UPDATE public.chip_ledger SET club_id=pg_temp.correction_id(101) WHERE id=pg_temp.correction_id(501);
 INSERT INTO public.social_conversation_participants(conversation_id,user_id) VALUES(pg_temp.correction_id(702),pg_temp.correction_id(5));
 PERFORM set_config('session_replication_role','origin',true);EXECUTE 'SET LOCAL ROLE authenticated';
 PERFORM pg_temp.correction_check(NOT EXISTS(SELECT 1 FROM public.fn_messenger_message_page(auth.uid(),pg_temp.correction_id(702))), 'extra audience member refuses legacy identity');
 EXECUTE 'RESET ROLE';PERFORM set_config('session_replication_role','replica',true);
 DELETE FROM public.social_conversation_participants WHERE conversation_id=pg_temp.correction_id(702) AND user_id=pg_temp.correction_id(5);
 PERFORM set_config('session_replication_role','origin',true);
 PERFORM pg_temp.correction_check(pg_temp.correction_state()=before_state,'synthetic corruption probes restored exact original rows');
END$malformed_history$;
-- Deliberate failure injection affects only synthetic NEW rows, then compares
-- the full state. The real correction writer and all existing trigger bodies run.
CREATE FUNCTION pg_temp.correction_fail_write() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF current_setting('app.correction_fixture_mode',true)='drop' THEN RETURN NULL;END IF;
 IF current_setting('app.correction_fixture_mode',true)='mutate' THEN
  IF TG_TABLE_NAME='accounting_correction_documents' THEN NEW.issuer_name:='MUTATED PRIVATE NAME';
  ELSIF TG_TABLE_NAME='social_messages' THEN NEW.media_metadata:=NEW.media_metadata||'{"private_diagnostic":"injected"}'::jsonb;
  ELSIF TG_TABLE_NAME='push_outbox' THEN NEW.body:='WRONG PAYMENT CLAIM';END IF;
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'fixture_correction_late_write_failure' USING ERRCODE='23514';
END$$;
CREATE FUNCTION pg_temp.correction_probe_failure(target_table text,trigger_when text,mode text,expected_error text,incident_n int) RETURNS void
LANGUAGE plpgsql AS $$DECLARE before_state jsonb;r jsonb;BEGIN
 EXECUTE format('CREATE TRIGGER zzz_correction_fixture_failure BEFORE INSERT ON public.%I FOR EACH ROW %s EXECUTE FUNCTION pg_temp.correction_fail_write()',target_table,trigger_when);
 PERFORM set_config('app.correction_fixture_mode',mode,true);before_state:=pg_temp.correction_state();
 PERFORM pg_temp.correction_actor(NULL,'service_role');EXECUTE 'SET LOCAL ROLE service_role';
 BEGIN
  r:=public.fn_ca_post_correction('union_wallet',pg_temp.correction_id(120),'club_treasury',pg_temp.correction_id(101),20.50,
    'Failure injection preserves journal and prior recipient deliveries',pg_temp.correction_id(incident_n),NULL,pg_temp.correction_id(101),pg_temp.correction_id(110));
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION 'late write unexpectedly accepted';
 EXCEPTION WHEN check_violation OR not_null_violation OR foreign_key_violation THEN
  IF expected_error IS NOT NULL AND SQLERRM<>expected_error THEN RAISE;END IF;
 END;
 EXECUTE 'RESET ROLE';SET CONSTRAINTS ALL DEFERRED;
 PERFORM pg_temp.correction_check(pg_temp.correction_state()=before_state,'full rollback for '||target_table||' '||mode);
 EXECUTE format('DROP TRIGGER zzz_correction_fixture_failure ON public.%I',target_table);
END$$;
-- The union→club audience is [owner,co-owner,admin,union owner]; failure on the
-- final union owner proves already-created earlier recipient rows roll back.
SELECT pg_temp.correction_probe_failure('accounting_correction_documents','','drop','correction_document_provenance_write_missing',306);
SELECT pg_temp.correction_probe_failure('accounting_correction_documents','','mutate','correction_document_provenance_write_missing',307);
SELECT pg_temp.correction_probe_failure('settlement_invoices','','drop','correction_document_invoice_write_missing',308);
SELECT pg_temp.correction_probe_failure('social_messages','WHEN (NEW.media_metadata->>''invoice_type''=''accounting_correction'')','drop',NULL,309);
SELECT pg_temp.correction_probe_failure('social_messages','WHEN (NEW.media_metadata->>''invoice_type''=''accounting_correction'')','mutate','correction_document_delivery_mismatch',310);
SELECT pg_temp.correction_probe_failure('notifications','WHEN (NEW.user_id=''e6480000-0000-4000-8000-000000000006''::uuid)','throw','fixture_correction_late_write_failure',311);
SELECT pg_temp.correction_probe_failure('notifications','WHEN (NEW.user_id=''e6480000-0000-4000-8000-000000000006''::uuid)','drop',NULL,317);
SELECT pg_temp.correction_probe_failure('accounting_invoice_deliveries','WHEN (NEW.recipient_id=''e6480000-0000-4000-8000-000000000006''::uuid)','drop','correction_document_delivery_missing',312);
SELECT pg_temp.correction_probe_failure('push_outbox','WHEN (NEW.recipient_user_id=''e6480000-0000-4000-8000-000000000006''::uuid)','drop','cashier_push_receipt_missing',313);
SELECT pg_temp.correction_probe_failure('push_outbox','WHEN (NEW.recipient_user_id=''e6480000-0000-4000-8000-000000000006''::uuid)','mutate','cashier_push_receipt_missing',314);
SELECT pg_temp.correction_probe_failure('ca_incident_events','','throw','fixture_correction_late_write_failure',315);
-- Payment claims and correction provenance are immutable even for postgres.
DO $immutable$ DECLARE before_state jsonb;inv uuid;BEGIN
 before_state:=pg_temp.correction_state();SELECT invoice_id INTO inv FROM correction_receipts WHERE label='club_player';
 BEGIN UPDATE public.settlement_invoices SET status='paid',chips_transferred=true,transferred_at=now() WHERE id=inv;
 RAISE EXCEPTION 'payment claim accepted';EXCEPTION WHEN check_violation THEN IF SQLERRM<>'correction_document_payment_claim_is_immutable' THEN RAISE;END IF;END;
 PERFORM pg_temp.correction_check(pg_temp.correction_state()=before_state,'paid-state mutation refuses without changes');
 BEGIN UPDATE public.accounting_correction_documents SET amount=amount+1 WHERE invoice_id=inv;
 RAISE EXCEPTION 'provenance rewrite accepted';EXCEPTION WHEN check_violation THEN IF SQLERRM<>'correction_document_is_immutable' THEN RAISE;END IF;END;
 PERFORM pg_temp.correction_check(pg_temp.correction_state()=before_state,'provenance rewrite refuses without changes');
END$immutable$;
-- Private tables/helpers never become an alternate financial or read authority.
DO $acl$ DECLARE who text;sig text;col text;BEGIN
 FOREACH who IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  PERFORM pg_temp.correction_check(NOT has_table_privilege(who,'public.accounting_correction_documents','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES,MAINTAIN'),'private table ACL '||who);
  FOREACH sig IN ARRAY ARRAY['public.fn_accounting_correction_prepare(uuid)','public.fn_accounting_correction_append_only()',
   'public.fn_accounting_correction_payload(public.accounting_correction_documents)','public.fn_accounting_correction_document_body(uuid,text)',
   'public.fn_accounting_correction_contract(uuid)','public.fn_accounting_correction_assert_delivery(uuid)',
   'public.fn_accounting_correction_is_unverified(uuid)','public.fn_accounting_correction_legacy_identity(uuid,uuid)'] LOOP
   PERFORM pg_temp.correction_check(NOT has_function_privilege(who,sig,'EXECUTE'),'private helper ACL '||who||' '||sig);
  END LOOP;
  FOR col IN SELECT attname FROM pg_attribute WHERE attrelid='public.accounting_correction_documents'::regclass AND attnum>0 AND NOT attisdropped LOOP
   PERFORM pg_temp.correction_check(NOT has_column_privilege(who,'public.accounting_correction_documents',col,'SELECT,INSERT,UPDATE,REFERENCES'),'private column ACL '||who||' '||col);
  END LOOP;
 END LOOP;
END$acl$;
SELECT pg_temp.correction_check(pg_temp.correction_stores()=(SELECT stores FROM correction_baseline),'final stores still match baseline');
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
