-- Deterministic calendar only in this disposable Unix-socket PostgreSQL.
-- PostgreSQL has optimized built-in clock OIDs; use an explicit private clock
-- namespace and clock defaults before the original requests. No money body,
-- receipt, amount, bank hash or source timestamp is rewritten after its write.
SELECT fixture.assert(inet_server_addr() IS NULL AND current_user='postgres','Raked week runs only in the private native cluster');
CREATE SCHEMA fixture_clock;
CREATE TABLE fixture.native_clock(at_time timestamptz NOT NULL);
INSERT INTO fixture.native_clock VALUES('2026-09-05 12:00Z');
CREATE FUNCTION fixture_clock.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT at_time FROM fixture.native_clock $$;
CREATE FUNCTION fixture_clock.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT at_time FROM fixture.native_clock $$;
CREATE FUNCTION fixture_clock.transaction_timestamp() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT at_time FROM fixture.native_clock $$;
CREATE FUNCTION fixture_clock.statement_timestamp() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT at_time FROM fixture.native_clock $$;
DO $$ DECLARE r record; expression text; BEGIN
 FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=fixture_clock,public,pg_catalog,pg_temp',r.signature);
 END LOOP;
 FOR r IN SELECT c.oid::regclass AS relation,a.attname,pg_get_expr(d.adbin,d.adrelid) AS expression FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum JOIN pg_class c ON c.oid=d.adrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' LOOP
  expression:=regexp_replace(r.expression,'\m(now|clock_timestamp|transaction_timestamp|statement_timestamp)\(\)','fixture_clock.\1()','g');
  IF expression<>r.expression THEN EXECUTE format('ALTER TABLE %s ALTER COLUMN %I SET DEFAULT %s',r.relation,r.attname,expression); END IF;
 END LOOP;
END $$;
SET search_path=fixture_clock,public,pg_catalog,pg_temp;
SELECT fixture.assert(now()='2026-09-05 12:00Z'::timestamptz AND clock_timestamp()='2026-09-05 12:00Z'::timestamptz,'Private calendar is installed before original monetary writes');
SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}';
UPDATE union_clubs SET rate_cash=0.9 WHERE id=fixture.u(3);
UPDATE club_members SET player_rakeback_pct=0.1 WHERE user_id IN(fixture.u(907),fixture.u(908));
SELECT atomic_table_buyin_before_maintenance_announcement_gate(fixture.u(907),fixture.u(305),1,100,false,fixture.u(104),NULL);
SELECT atomic_table_buyin_before_maintenance_announcement_gate(fixture.u(908),fixture.u(305),2,100,false,fixture.u(203),NULL);
UPDATE fixture.native_clock SET at_time='2026-09-10 12:00Z';
INSERT INTO engine_table_leases(table_id,instance_id,lease_generation,protocol_version,heartbeat_at)
VALUES(fixture.u(305),'weekly-raked-native',fixture.u(602),2,clock_timestamp());
SELECT fn_cash_capture_hand_manifest(fixture.u(305),1000702,
 (SELECT jsonb_agg(jsonb_build_object('user_id',s.user_id,'seat_id',s.id,'occupancy_id',s.occupancy_id,'seat_joined_at',s.joined_at,'stack_before',s.stack,'is_horse',p.is_horse) ORDER BY s.user_id)
  FROM table_seats s JOIN profiles p ON p.id=s.user_id WHERE s.table_id=fixture.u(305) AND s.left_at IS NULL),'weekly-raked-native',fixture.u(602));
DO $$ DECLARE stacks jsonb; result jsonb; BEGIN
 SELECT jsonb_agg(jsonb_build_object('user_id',x->'user_id','seat_id',x->'seat_id','occupancy_id',x->'occupancy_id','seat_joined_at',x->'seat_joined_at',
  'funding_manifest_id',m.id,'stack_before',x->'stack_before','stack',(x->>'stack_before')::numeric+CASE x->>'user_id' WHEN fixture.u(907)::text THEN 8 ELSE -10 END)) INTO stacks
 FROM cash_hand_participant_manifests m CROSS JOIN LATERAL jsonb_array_elements(m.participants) x WHERE m.hand_number=1000702;
 result:=fn_ca_commit_hand_settlement_before_lease_generation(fixture.u(305),1000702,stacks,2,0,NULL,0,jsonb_build_object('table_id',fixture.u(305),'hand_number',1000702,'started_at',clock_timestamp()),'[]');
 PERFORM fixture.assert(result->>'success'='true','Actual accepted raked hand conserves +8 -10 +2 rake');
END $$;
CREATE TEMP TABLE raked_original_bank AS SELECT * FROM atomic_distribute_rake(fixture.u(305),fixture.u(203),
 (SELECT hand_id FROM hand_atomic_commits WHERE table_id=fixture.u(305) AND hand_number=1000702),1000702,2,0,100,2,
 jsonb_build_object(fixture.u(907)::text,50,fixture.u(908)::text,50),NULL,NULL,'WEIGHTED_CONTRIBUTED');
SELECT fixture.assert((SELECT count(*)=1 AND bool_and(applied) FROM raked_original_bank)
 AND (SELECT rake_wallet=2 FROM union_wallets WHERE union_id=fixture.u(203)),'Actual rake owner banks exactly two chips');
DO $$ DECLARE result jsonb; BEGIN
 SELECT fn_process_cash_accounting_source(rake_record_id) INTO result FROM raked_original_bank;
 PERFORM fixture.assert(result->>'status'='accrued','Actual original rake source and commercial contracts accrue: '||result::text);
END $$;
UPDATE fixture.native_clock SET at_time='2026-09-15 12:00Z';
DO $$ DECLARE original text; accepted text; needle text; replacement text; result jsonb; BEGIN
 accepted:=pg_get_functiondef('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure);
 needle:='OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=a.club_id AND c.is_union IS NOT TRUE)';
 replacement:='OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=a.club_id AND (c.is_union IS NOT TRUE
       OR (c.is_union IS TRUE AND EXISTS(SELECT 1 FROM public.accounting_cash_rake_sources hs
         JOIN public.accounting_cash_accrual_batches hb ON hb.rake_record_id=hs.rake_record_id
         WHERE hs.rake_record_id=r.id AND hs.player_id=a.player_id AND hs.club_id=a.club_id
          AND hs.union_id=scope_union AND (c.id=hs.union_id OR c.union_id=hs.union_id)
          AND hs.earned_at=r.created_at AND hs.rake_credit=a.weighted_rake_credit AND hb.status=''accrued''
          AND hs.contract->>''is_union_house''=''true'' AND hs.contract->>''attribution_id''=a.id::text
          AND hs.contract->>''club_id''=a.club_id::text AND hs.contract->>''player_id''=a.player_id::text
          AND hs.contract->>''union_id''=hs.union_id::text))))';
 PERFORM fixture.assert(position(replacement IN accepted)>0,'Retained-house negative control binds the exact changed clause');
 EXECUTE replace(accepted,replacement,needle);
 result:=fn_calculate_cash_rakeback_periods(fixture.u(104),'2026-09-07','2026-09-13');
 PERFORM fixture.assert(result->>'reason'='cash_earning_evidence_incomplete','Original whole-hand guard refuses the actual retained-house hand');
 EXECUTE accepted;
END $$;
-- Fault only the retained source identity inside an isolated rollback.
BEGIN;
ALTER TABLE accounting_cash_rake_sources DISABLE TRIGGER USER;
UPDATE accounting_cash_rake_sources SET contract=jsonb_set(contract,'{attribution_id}',to_jsonb(fixture.u(99999)::text)) WHERE club_id=fixture.u(203);
SELECT fixture.assert(fn_calculate_cash_rakeback_periods(fixture.u(104),'2026-09-07','2026-09-13')->>'reason'='cash_earning_evidence_incomplete','Mismatched retained-house attribution remains refused');
ROLLBACK;
DO $$ DECLARE proof jsonb; basis jsonb; paid jsonb; cascade jsonb; original text; accepted text; fingerprint text; BEGIN
 proof:=fn_union_pnl_evidence_report(fixture.u(203),'2026-09-07 07:00Z','2026-09-14 07:00Z');
 PERFORM fixture.assert(proof->>'status'='ready','Real raked hand qualifies from its unchanged original bank and source receipts: '||(proof->'issues')::text);
 PERFORM fixture.assert((SELECT (x->>'rake_paid')::numeric=1 AND (x->>'rake_earned')::numeric=0.9 AND (x->>'net')::numeric=9
  FROM jsonb_array_elements(proof->'clubs') x WHERE x->>'club_id'=fixture.u(104)::text),'Member club keeps gross one rake, earns0.90 and has exact +9 pre-rake P&L');
 PERFORM fixture.assert((SELECT (x->>'rake_paid')::numeric=1 AND (x->>'rake_earned')::numeric=0 AND (x->>'net')::numeric=-9
  FROM jsonb_array_elements(proof->'clubs') x WHERE x->>'club_id'=fixture.u(203)::text),'Union-house rake remains in gross P&L without inventing a house payout');
 basis:=fn_accounting_union_earned_plan(fixture.u(203),'2026-09-07 07:00Z','2026-09-14 07:00Z');
 PERFORM fixture.assert((basis->>'period_rake')::numeric=2 AND (basis->>'house_rake')::numeric=1,'One validated source plan retains all two banked chips including one Union-house chip');
 paid:=fn_union_settle_player_pnl(fixture.u(203),'2026-09-07 07:00Z','2026-09-14 07:00Z',false);
 PERFORM fixture.assert(paid->>'success'='true' AND (paid->>'total_collected')::numeric=9 AND (paid->>'total_paid')::numeric=9,'Original payer clears the real raked hand exactly');
 cascade:=fn_union_settlement_cascade(fixture.u(203),'2026-09-07 07:00Z','2026-09-14 07:00Z');
 PERFORM fixture.assert(cascade->>'success'='true','Original full cascade closes the nonzero raked week: '||cascade::text);
 PERFORM fixture.assert((SELECT rake_wallet=0 AND chip_balance=1001.1 FROM union_wallets WHERE union_id=fixture.u(203)),'Union retains1.10 after the original0.90 club rake payout');
 PERFORM fixture.assert((SELECT chip_balance=400.1 FROM club_members WHERE club_id=fixture.u(104) AND user_id=fixture.u(907)),'Original downstream player rakeback delivers0.10 once');
 PERFORM fixture.assert((SELECT count(*)>=1 AND bool_and(i.message_sent AND i.chips_transferred) FROM settlement_invoices i JOIN chip_ledger l ON l.id=i.source_ledger_id WHERE l.category='rakeback' AND l.club_id=fixture.u(104)),'Real nonzero rakeback has an invoice with actual Messenger delivery');
 PERFORM fixture.assert((SELECT count(*)>=1 AND count(*)=count(m.id) AND count(*)=count(n.id) FROM accounting_invoice_deliveries d JOIN settlement_invoices i ON i.id=d.invoice_id JOIN chip_ledger l ON l.id=i.source_ledger_id LEFT JOIN social_messages m ON m.id=d.message_id LEFT JOIN notifications n ON n.id=d.notification_id WHERE l.category='rakeback' AND l.club_id=fixture.u(104)),'Actual nonzero player rakeback has Messenger and notification records');
 accepted:=pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure);
 original:=replace(accepted,E'   AND COALESCE((rs.contract->>''is_union_house'')::boolean,false) IS FALSE\n','');
 PERFORM fixture.assert(original<>accepted,'Missing-payable negative control binds the exact retained-house clause');
 EXECUTE original;
 BEGIN
  PERFORM fn_settle_accounting_rakeback_stage('union',fixture.u(203),'2026-09-07 07:00Z','2026-09-14 07:00Z');
  RAISE EXCEPTION 'Original retained-house period requirement unexpectedly accepted';
 EXCEPTION WHEN SQLSTATE '55000' THEN PERFORM fixture.assert(SQLERRM='routed_rakeback_player_period_missing','Original stage wrongly required a retained-house player payable'); END;
 EXECUTE accepted;
 SELECT md5(jsonb_build_array((SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM chip_ledger x),(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM settlement_invoices x),(SELECT jsonb_agg(to_jsonb(x) ORDER BY invoice_id,recipient_id) FROM accounting_invoice_deliveries x))::text) INTO fingerprint;
 cascade:=fn_union_settlement_cascade(fixture.u(203),'2026-09-07 07:00Z','2026-09-14 07:00Z');
 PERFORM fixture.assert(cascade->>'success'='true' AND fingerprint=(SELECT md5(jsonb_build_array((SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM chip_ledger x),(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM settlement_invoices x),(SELECT jsonb_agg(to_jsonb(x) ORDER BY invoice_id,recipient_id) FROM accounting_invoice_deliveries x))::text)),'Real nonzero rake cascade replays without duplicate payment, invoice or delivery');
END $$;

BEGIN;
ALTER TABLE rakeback_periods DISABLE TRIGGER USER;
UPDATE rakeback_periods SET period_start='2099-01-05',period_end='2099-01-11' WHERE club_id=fixture.u(104);
DO $$ BEGIN
 BEGIN
  PERFORM fn_settle_accounting_rakeback_stage('union',fixture.u(203),'2026-09-07 07:00Z','2026-09-14 07:00Z');
  RAISE EXCEPTION 'Ordinary source without its player period was accepted';
 EXCEPTION WHEN SQLSTATE '55000' THEN PERFORM fixture.assert(SQLERRM='routed_rakeback_player_period_missing','Ordinary non-house source still requires its exact player period'); END;
END $$;
ROLLBACK;
