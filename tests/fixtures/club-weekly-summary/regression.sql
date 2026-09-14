SELECT assert_true((SELECT count(*)=1 FROM accounting_invoice_deliveries WHERE delivery_mode='weekly_detail'),'old issuer copies stay in audit storage but leave the club message feed');
SELECT assert_true((SELECT count(*)=1 FROM notifications WHERE type='accounting_invoice_detail' AND read AND is_read),'old issuer notifications are archived without deleting the receipt');
SELECT assert_true((SELECT count(*)=1 FROM accounting_invoice_deliveries WHERE recipient_id='10000000-0000-0000-0000-000000000002' AND delivery_mode='immediate'),'recipient invoice stays visible');
INSERT INTO profiles(id,username) VALUES(u(7),'Super Agent'),(u(8),'Sub Agent');
INSERT INTO agents(id,user_id,club_id,role) VALUES(u(70),u(7),'20000000-0000-0000-0000-000000000001','super_agent'),(u(80),u(8),'20000000-0000-0000-0000-000000000001','sub_agent');
INSERT INTO settlement_periods VALUES(u(100),'20000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000003','2026-09-07 07:00Z','2026-09-14 07:00Z','settled');
INSERT INTO union_clubs VALUES('20000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000001');
INSERT INTO ca_settlements VALUES(u(101),'union_rakeback_close','20000000-0000-0000-0000-000000000003','final','20000000-0000-0000-0000-000000000003:2026-09-07T07:00:00Z..2026-09-14T07:00:00Z','{"basis_by_club":{"20000000-0000-0000-0000-000000000001":100},"payout_by_club":{"20000000-0000-0000-0000-000000000001":90}}');
INSERT INTO chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,settlement_id,created_at)
 VALUES(u(102),'union_wallet','20000000-0000-0000-0000-000000000003','club_treasury','20000000-0000-0000-0000-000000000001',90,'rakeback','20000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000003',u(101),'2026-09-14 07:05:00.123456Z');
INSERT INTO chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,metadata,created_at)
 SELECT u(n),'club_treasury','20000000-0000-0000-0000-000000000001','player_wallet',payee,amount,category,'20000000-0000-0000-0000-000000000001','{"period_start":"2026-09-07T07:00:00Z","period_end":"2026-09-14T07:00:00Z"}','2026-09-14 07:05:00.123456Z'
 FROM (VALUES(103,u(7),10,'commission'),(104,'10000000-0000-0000-0000-000000000002'::uuid,20,'commission'),(105,u(8),5,'commission'),(106,'10000000-0000-0000-0000-000000000004'::uuid,5,'rakeback')) t(n,payee,amount,category);
SELECT assert_true((SELECT count(*)=4 FROM accounting_invoice_deliveries d JOIN settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id IN(u(103),u(104),u(105),u(106))),'new club payouts notify only their individual payees');
INSERT INTO chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,metadata,created_at)
 VALUES(u(107),'player_wallet','10000000-0000-0000-0000-000000000002','player_wallet','10000000-0000-0000-0000-000000000004',8,'rakeback','20000000-0000-0000-0000-000000000001','{"period_start":"2026-09-07T07:00:00Z","period_end":"2026-09-14T07:00:00Z"}','2026-09-14 07:05:00.123456Z');
SELECT assert_true(fn_club_weekly_accounting_summary(u(100)) @> '{"rake_earned":100,"rake_received":90,"paid_super_agents":10,"paid_agents":20,"paid_sub_agents":5,"paid_players":5,"total_paid_by_club":40,"retained_by_club":50,"downstream_redistributed":8,"unclassified_role_count":0,"missing_period_count":0}','summary keeps exact cents, tiers and downstream redistribution separate');
SELECT assert_true(fn_club_weekly_accounting_summary(u(100))->>'status'='needs_reconciliation','a posted partial close is not called complete');
SELECT set_config('test.engine','false',false),set_config('test.uid','10000000-0000-0000-0000-000000000004',false);
SELECT assert_true(refuses($$SELECT fn_club_weekly_accounting_summary(u(100))$$,'42501'),'ordinary player cannot read the club total');
SELECT set_config('test.uid','10000000-0000-0000-0000-000000000001',false);
SELECT assert_true(fn_club_weekly_accounting_summary(u(100))->>'rake_received'='90','club owner can read its total');
SELECT set_config('test.uid','10000000-0000-0000-0000-000000000003',false);
SELECT assert_true(refuses($$SELECT fn_club_weekly_accounting_summary(u(100))$$,'42501'),'another club owner cannot read the statement');
SELECT set_config('test.engine','true',false);
SELECT assert_true(refuses($$SELECT fn_issue_club_weekly_accounting('20000000-0000-0000-0000-000000000003','2026-09-07 07:00Z','2026-09-14 07:00Z')$$,'23514'),'publication requires the validated cascade');
SELECT set_config('app.union_accounting_validated_period','20000000-0000-0000-0000-000000000003:'||'2026-09-07 07:00Z'::timestamptz::text||':'||'2026-09-14 07:00Z'::timestamptz::text,false);
CREATE FUNCTION fixture_fail_weekly_note() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF current_setting('test.fail_weekly',true)='true' AND NEW.title LIKE 'Weekly Club Statement%' THEN RAISE EXCEPTION 'injected weekly delivery failure';END IF;RETURN NEW;END$$;
CREATE TRIGGER fixture_fail_weekly_note BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION fixture_fail_weekly_note();
SELECT set_config('test.fail_weekly','true',false);
SELECT assert_true(refuses($$SELECT fn_issue_club_weekly_accounting('20000000-0000-0000-0000-000000000003','2026-09-07 07:00Z','2026-09-14 07:00Z')$$,'P0001'),'weekly notification failure rolls back the invoice');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM settlement_invoices WHERE invoice_type='club_weekly_accounting'),'failed delivery leaves no weekly invoice');
SELECT set_config('test.fail_weekly','false',false);
SELECT fn_issue_club_weekly_accounting('20000000-0000-0000-0000-000000000003','2026-09-07 07:00Z','2026-09-14 07:00Z');
SELECT fn_issue_club_weekly_accounting('20000000-0000-0000-0000-000000000003','2026-09-07 07:00Z','2026-09-14 07:00Z');
SELECT assert_true((SELECT count(*)=1 FROM settlement_invoices WHERE invoice_type='club_weekly_accounting') AND (SELECT count(*)=1 FROM notifications WHERE title LIKE 'Weekly Club Statement%'),'replay issues one weekly statement and one notification');
SELECT assert_true((SELECT bool_and(content LIKE '%Rake Earned: 100.00%' AND content LIKE '%Paid Super Agents: 10.00%' AND content LIKE '%Total Paid By Club: 40.00%') FROM social_messages WHERE media_metadata->>'invoice_type'='club_weekly_accounting'),'weekly message contains consolidated figures');
SELECT assert_true(refuses($$UPDATE settlement_invoices SET net_amount=5 WHERE invoice_type='club_weekly_accounting'$$,'23514'),'issued weekly figures remain immutable');
SELECT assert_true((SELECT count(*)=7 FROM chip_ledger),'weekly invoicing never moves the chips a second time');
INSERT INTO union_wallets VALUES(u(200),'20000000-0000-0000-0000-000000000003');
INSERT INTO chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id)
 VALUES(u(201),'union_wallet',u(200),'player_wallet','10000000-0000-0000-0000-000000000004',1.23,'wheel_prize','20000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000003');
SELECT assert_true((SELECT from_entity_id='20000000-0000-0000-0000-000000000003' FROM settlement_invoices WHERE source_ledger_id=u(201)),'preserves the concurrent game payout issuer repair');
-- Invoice provenance and same-timestamp pagination run in real PostgreSQL.
CREATE TEMP TABLE summary_thread AS SELECT m.conversation_id FROM social_messages m WHERE m.media_metadata->>'invoice_type'='club_weekly_accounting';
SELECT assert_true((SELECT count(*)=1 FROM fn_messenger_message_page('10000000-0000-0000-0000-000000000001',(SELECT conversation_id FROM summary_thread))),'club message page hides the archived individual sender copy');
INSERT INTO social_messages(id,conversation_id,sender_id,content,message_type,media_metadata,created_at)
 SELECT u(600+n),(SELECT conversation_id FROM summary_thread),'10000000-0000-0000-0000-000000000001','Discussion '||n,'text','{}','2030-01-01 00:00:00.123456Z' FROM generate_series(1,7) n;
CREATE TEMP TABLE page_one AS SELECT * FROM fn_messenger_message_page('10000000-0000-0000-0000-000000000001',(SELECT conversation_id FROM summary_thread),NULL,NULL,3);
CREATE TEMP TABLE page_two AS SELECT * FROM fn_messenger_message_page('10000000-0000-0000-0000-000000000001',(SELECT conversation_id FROM summary_thread),'2030-01-01 00:00:00.123456Z',(SELECT min(id::text)::uuid FROM page_one),3);
SELECT assert_true((SELECT count(*)=3 FROM page_one) AND (SELECT count(*)=3 FROM page_two) AND NOT EXISTS(SELECT id FROM page_one INTERSECT SELECT id FROM page_two),'equal-time message pages neither skip nor duplicate records');
SELECT assert_true((SELECT min(id::text)::uuid=u(602) FROM page_two),'microseconds and the ID cursor preserve the next three messages');
INSERT INTO social_messages(id,conversation_id,sender_id,content,message_type,media_metadata,created_at)
 VALUES(u(610),(SELECT conversation_id FROM summary_thread),'10000000-0000-0000-0000-000000000001','A forged invoice','invoice','{"kind":"accounting_invoice","accounting_verified":true,"status":"paid"}','2030-01-02 00:00Z');
SELECT assert_true((SELECT message_type='text' AND media_metadata->>'accounting_verified'='false' FROM fn_messenger_message_page('10000000-0000-0000-0000-000000000001',(SELECT conversation_id FROM summary_thread),NULL,NULL,1)),'unlinked messages cannot forge a verified invoice');
SELECT assert_true((SELECT bool_and(media_metadata->>'accounting_verified'='true') FROM fn_messenger_message_page('10000000-0000-0000-0000-000000000001',(SELECT conversation_id FROM summary_thread)) WHERE message_type='invoice'),'linked invoices retain verified provenance');
SELECT assert_true((SELECT last_discussion_at IS NOT NULL FROM accounting_conversations WHERE conversation_id=(SELECT conversation_id FROM summary_thread)),'human invoice discussion is tracked in its accounting conversation');
SELECT set_config('test.engine','false',false),set_config('test.uid','10000000-0000-0000-0000-000000000004',false);
SELECT assert_true(refuses($$SELECT * FROM fn_messenger_message_page('10000000-0000-0000-0000-000000000001',(SELECT conversation_id FROM summary_thread))$$,'42501'),'an authenticated caller cannot substitute another actor');
SELECT assert_true(refuses($$SELECT * FROM fn_messenger_message_page('10000000-0000-0000-0000-000000000004',(SELECT conversation_id FROM summary_thread))$$,'42501'),'a nonparticipant cannot read the club conversation');
SELECT assert_true(NOT has_function_privilege('anon','fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer)','EXECUTE'),'anonymous callers cannot read the message function');
