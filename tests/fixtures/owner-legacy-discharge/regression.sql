-- Owner-authorized legacy discharge of a deferred week (20260926140858).
--
-- Runs last on the private native cluster, after every weekly regression, with
-- the rakeback document constraint armed. Two synthetic deferred weeks below a
-- settlement floor and before the cash-accrual cutover are discharged exactly
-- as production's 2026-09-07 (union direct) and 2026-09-14 (legacy cascade)
-- weeks are: expected figures are derived by hand below, independently of the
-- functions under test.
\set ON_ERROR_STOP on
SELECT fixture.assert(inet_server_addr() IS NULL AND current_user='postgres','Owner legacy discharge runs only in the private native cluster');
SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}';

-- The window check reads clock_timestamp(); the fixture pins it to :20 past.
DO $seam$DECLARE d text;BEGIN
 d:=pg_get_functiondef('public.fn_accounting_legacy_pay_week(uuid)'::regprocedure);
 IF (length(d)-length(replace(d,'clock_timestamp()','')))/length('clock_timestamp()')<>2 THEN RAISE EXCEPTION 'pay window seam moved'; END IF;
 EXECUTE replace(d,'clock_timestamp()',$c$COALESCE(NULLIF(current_setting('test.legacy_clock',true),'')::timestamptz,clock_timestamp())$c$);
END$seam$;
SET test.legacy_clock='2026-09-26 12:20Z';

-- ============ BOOK ============
-- Synthetic opening balances are declared, not journalled: the balance
-- journals stand down exactly as the bootstrap's pre-trigger openings do.
SET app.ledger_autoskip_clubs='1'; SET app.ledger_autoskip_club_members='1'; SET app.ledger_autoskip_union_wallets='1';
-- Union U (house club 7201) with member clubs A 7101 and B 7102; standalone S 7103.
INSERT INTO auth.users(id) SELECT fixture.u(x) FROM generate_series(7900,7930) x;
INSERT INTO profiles(id,username,is_horse) SELECT fixture.u(x),'legacy_native_'||x,x BETWEEN 7911 AND 7919 FROM generate_series(7900,7930) x;
INSERT INTO clubs(id,name,owner_id,chip_treasury,asset,is_union,union_id) VALUES
 (fixture.u(7201),'Legacy Union house',fixture.u(7900),0,'chips',true,NULL),
 (fixture.u(7101),'Legacy A',fixture.u(7900),100,'chips',false,NULL),
 (fixture.u(7102),'Legacy B',fixture.u(7900),100,'chips',false,NULL),
 (fixture.u(7103),'Legacy S',fixture.u(7900),50,'chips',false,NULL);
INSERT INTO unions(id,name,slug,owner_id,settings) VALUES(fixture.u(7201),'Legacy Union','legacy-union-native',fixture.u(7900),'{}');
UPDATE clubs SET union_id=fixture.u(7201) WHERE id IN(fixture.u(7201),fixture.u(7101),fixture.u(7102));
INSERT INTO union_clubs(id,union_id,club_id,club_commission_rate) VALUES(fixture.u(7301),fixture.u(7201),fixture.u(7101),0.9),(fixture.u(7302),fixture.u(7201),fixture.u(7102),0.9);
INSERT INTO union_wallets(union_id,chip_balance,rake_wallet) VALUES(fixture.u(7201),0,1000);
-- Agents: A: SA 7921 (super 0.60) <- AG 7922 (agent 0.40, offer 0.30); B: BG 7924 (0.30, offer 0.20);
--         S: SS 7925 (super 0.50) <- SG 7926 (agent 0.35, offer 0.25).
INSERT INTO agents(id,club_id,user_id,role,status,commission_rate,player_rakeback_rate,parent_agent_id) VALUES
 (fixture.u(7421),fixture.u(7101),fixture.u(7921),'super_agent','active',0.60,0.50,NULL),
 (fixture.u(7422),fixture.u(7101),fixture.u(7922),'agent','active',0.40,0.30,fixture.u(7421)),
 (fixture.u(7424),fixture.u(7102),fixture.u(7924),'agent','active',0.30,0.20,NULL),
 (fixture.u(7425),fixture.u(7103),fixture.u(7925),'super_agent','active',0.50,0.40,NULL),
 (fixture.u(7426),fixture.u(7103),fixture.u(7926),'agent','active',0.35,0.25,fixture.u(7425));
INSERT INTO accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms)
SELECT 'agents',a.id::text,a.club_id,a.user_id,'baseline','2026-08-10 12:00Z',
 jsonb_build_object('id',a.id,'club_id',a.club_id,'user_id',a.user_id,'role',a.role,'status',a.status,'commission_rate',a.commission_rate,
  'player_rakeback_rate',a.player_rakeback_rate,'parent_agent_id',a.parent_agent_id)
 FROM agents a WHERE a.club_id IN(fixture.u(7101),fixture.u(7102),fixture.u(7103));
-- Members. p1 7911 (A, agent AG), p2 7912 (A, none), p3 7913 (B, agent BG), p4 7914 (S, agent SG),
-- p5 7915 (S, deal 0.10), p6 7916 (house member), p7 7917 (A+B, no house account), p8 7918 (A only), p9 7919 (S, tournament only).
INSERT INTO club_members(user_id,club_id,chip_balance,role,status,agent_id,player_rakeback_pct,joined_at) VALUES
 (fixture.u(7911),fixture.u(7101),10,'player','active',fixture.u(7922),0,'2026-08-01'),
 (fixture.u(7912),fixture.u(7101),10,'player','active',NULL,0,'2026-08-01'),
 (fixture.u(7913),fixture.u(7102),10,'player','active',fixture.u(7924),0,'2026-08-01'),
 (fixture.u(7914),fixture.u(7103),10,'player','active',fixture.u(7926),0,'2026-08-01'),
 (fixture.u(7915),fixture.u(7103),10,'player','active',NULL,0.10,'2026-08-01'),
 (fixture.u(7916),fixture.u(7201),10,'player','active',NULL,0,'2026-08-01'),
 (fixture.u(7917),fixture.u(7101),10,'player','active',NULL,0,'2026-08-05'),
 (fixture.u(7917),fixture.u(7102),10,'player','active',NULL,0,'2026-08-02'),
 (fixture.u(7918),fixture.u(7101),10,'player','active',NULL,0,'2026-08-01'),
 (fixture.u(7919),fixture.u(7103),10,'player','active',NULL,0,'2026-08-01'),
 (fixture.u(7921),fixture.u(7101),0,'super_agent','active',NULL,0,'2026-08-01'),
 (fixture.u(7922),fixture.u(7101),0,'agent','active',NULL,0,'2026-08-01'),
 (fixture.u(7924),fixture.u(7102),0,'agent','active',NULL,0,'2026-08-01'),
 (fixture.u(7925),fixture.u(7103),0,'super_agent','active',NULL,0,'2026-08-01'),
 (fixture.u(7926),fixture.u(7103),0,'agent','active',NULL,0,'2026-08-01');
INSERT INTO cash_games(id,club_id,union_id,name,template_name,variant,sb,bb,handedness,ruleset_snapshot) VALUES
 (fixture.u(7501),fixture.u(7201),fixture.u(7201),'Legacy union game','classic','nlh',1,2,9,'{}'),
 (fixture.u(7503),fixture.u(7103),NULL,'Legacy standalone game','classic','nlh',1,2,9,'{}');
INSERT INTO tables(id,name,game_type,cluster_id,club_id,union_id,min_buy_in,max_buy_in,is_private,status,max_players) VALUES
 (fixture.u(7601),'Legacy union table','cash',fixture.u(7501),fixture.u(7201),fixture.u(7201),1,1000,false,'waiting',9),
 (fixture.u(7603),'Legacy standalone table','cash',fixture.u(7503),fixture.u(7103),NULL,1,1000,false,'waiting',9);
RESET app.ledger_autoskip_clubs; RESET app.ledger_autoskip_club_members; RESET app.ledger_autoskip_union_wallets;
-- Both weeks lie below the floors and before the cutover (2026-09-04 12:00Z).
-- The floors are set beyond any week this cluster closes, so the weekly
-- coordinator has nothing to do for this book and the later regressions and
-- the 2026-09-28 proof see exactly the book they would without it.
INSERT INTO union_settlement_floor(union_id,earliest_period_start,reason) VALUES(fixture.u(7201),'2026-12-28 08:00Z','Native fixture: legacy weeks precede the floor.')
 ON CONFLICT (union_id) DO UPDATE SET earliest_period_start=EXCLUDED.earliest_period_start;
INSERT INTO club_settlement_floor(club_id,earliest_period_start,reason) VALUES(fixture.u(7103),'2026-12-28 08:00Z','Native fixture: legacy weeks precede the floor.');

-- ============ WEEK 1 (2026-08-17, union direct) ============
INSERT INTO rakeback_periods(id,club_id,user_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_amount,rakeback_earned,total_rake_paid,status) VALUES
 (fixture.u(7701),fixture.u(7201),fixture.u(7916),'2026-08-17','2026-08-23',123.40,0.10,12.34,12.34,123.40,'pending'),
 (fixture.u(7702),fixture.u(7201),fixture.u(7917),'2026-08-17','2026-08-23',50.00,0.10,5.00,5.00,50.00,'pending'),
 (fixture.u(7703),fixture.u(7201),fixture.u(7918),'2026-08-17','2026-08-23',0,0.05,0,0,0,'pending'),
 (fixture.u(7704),fixture.u(7103),fixture.u(7917),'2026-08-17','2026-08-23',79.80,0.05,3.99,3.99,79.80,'pending');
-- p7's play at the union's own table was funded from B that week.
INSERT INTO chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,description,created_at)
VALUES(fixture.u(900),'player_wallet',fixture.u(7917),'table_stack',fixture.u(7601),40,'buyin',fixture.u(7102),'fixture buy-in','2026-08-18 12:00Z');
INSERT INTO accounting_deferred_obligations(scope_kind,scope_id,period_start,period_end,pending_periods,pending_amount,observed_at,reason) VALUES
 ('union',fixture.u(7201),'2026-08-17 07:00Z','2026-08-24 07:00Z',3,17.34,now(),'Native fixture: deferred union week.'),
 ('club',fixture.u(7103),'2026-08-17 07:00Z','2026-08-24 07:00Z',1,3.99,now(),'Native fixture: deferred club row of the same week.');

-- ============ WEEK 2 (2026-08-24, legacy cascade) ============
-- Four cash rake records (weights equal, credits exact):
--  R1 union table 10.00 {p1,p3} -> p1 5.00 (A), p3 5.00 (B)
--  R2 union table  6.00 {p1,p2} -> p1 3.00 (A), p2 3.00 (A)
--  R3 S table      8.00 {p4,p5} -> p4 4.00, p5 4.00
--  R4 S table      2.00 {p4}    -> p4 2.00
INSERT INTO rake_records(id,hand_id,table_id,club_id,rake_amount,bbj_contribution,pot_size,num_players,player_contributions,is_tournament,source,metadata,rake_method,created_at) VALUES
 (fixture.u(7801),fixture.u(7811),fixture.u(7601),fixture.u(7201),10.00,0,100,2,jsonb_build_object(fixture.u(7911)::text,50,fixture.u(7913)::text,50),false,'fixture','{}','WEIGHTED_CONTRIBUTED','2026-08-25 12:00Z'),
 (fixture.u(7802),fixture.u(7812),fixture.u(7601),fixture.u(7201),6.00,0,60,2,jsonb_build_object(fixture.u(7911)::text,30,fixture.u(7912)::text,30),false,'fixture','{}','WEIGHTED_CONTRIBUTED','2026-08-26 12:00Z'),
 (fixture.u(7803),fixture.u(7813),fixture.u(7603),fixture.u(7103),8.00,0,80,2,jsonb_build_object(fixture.u(7914)::text,40,fixture.u(7915)::text,40),false,'fixture','{}','WEIGHTED_CONTRIBUTED','2026-08-27 12:00Z'),
 (fixture.u(7804),fixture.u(7814),fixture.u(7603),fixture.u(7103),2.00,0,20,1,jsonb_build_object(fixture.u(7914)::text,10),false,'fixture','{}','WEIGHTED_CONTRIBUTED','2026-08-28 12:00Z');
INSERT INTO ca_union_rake_attribution(rake_record_id,user_id,union_id,table_id,hand_id,played_at,club_id,rake_share,attempts,attributed_at) VALUES
 (fixture.u(7801),fixture.u(7911),fixture.u(7201),fixture.u(7601),fixture.u(7811),'2026-08-25 12:00Z',fixture.u(7101),5.00,1,now()),
 (fixture.u(7801),fixture.u(7913),fixture.u(7201),fixture.u(7601),fixture.u(7811),'2026-08-25 12:00Z',fixture.u(7102),5.00,1,now()),
 (fixture.u(7802),fixture.u(7911),fixture.u(7201),fixture.u(7601),fixture.u(7812),'2026-08-26 12:00Z',fixture.u(7101),3.00,1,now()),
 (fixture.u(7802),fixture.u(7912),fixture.u(7201),fixture.u(7601),fixture.u(7812),'2026-08-26 12:00Z',fixture.u(7101),3.00,1,now());
-- Recorded legacy rows: A:p1 and S:p4 are restated; H:p3 (house booking) and S:p9 (tournament only) are superseded; B:p3, A:p2, S:p5 are opened.
INSERT INTO rakeback_periods(id,club_id,user_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_amount,rakeback_earned,total_rake_paid,status) VALUES
 (fixture.u(7711),fixture.u(7101),fixture.u(7911),'2026-08-24','2026-08-30',2.00,0.30,0.60,0.60,2.00,'pending'),
 (fixture.u(7712),fixture.u(7103),fixture.u(7914),'2026-08-24','2026-08-30',1.00,0.25,0.25,0.25,1.00,'pending'),
 (fixture.u(7713),fixture.u(7201),fixture.u(7913),'2026-08-24','2026-08-30',1.00,0.20,0.20,0.20,1.00,'pending'),
 (fixture.u(7714),fixture.u(7103),fixture.u(7919),'2026-08-24','2026-08-30',7.00,0.05,0.35,0.35,7.00,'pending');
INSERT INTO accounting_deferred_obligations(scope_kind,scope_id,period_start,period_end,pending_periods,pending_amount,observed_at,reason) VALUES
 ('union',fixture.u(7201),'2026-08-24 07:00Z','2026-08-31 07:00Z',3,3.55,now(),'Native fixture: measured union obligation.'),
 ('club',fixture.u(7103),'2026-08-24 07:00Z','2026-08-31 07:00Z',2,1.90,now(),'Native fixture: measured club obligation.');

-- Hand-derived expectations for week 2:
--  rakeback  A:p1 8.00*0.30=2.40 (agent AG); A:p2 3.00*0.05=0.15 (club A); B:p3 5.00*0.20=1.00 (agent BG);
--            S:p4 6.00*0.25=1.50 (agent SG); S:p5 4.00*0.10=0.40 (club S)            -> 5.45
--  tiers     R1 p1: AG 2.00, SA 1.80 | R1 p3: BG 1.50 | R2 p1: AG 1.20, SA 1.08 | R3 p4: SG 1.40, SS 1.30 | R4 p4: SG 0.70, SS 0.65
--  edges     A: club->SA 6.08, SA->AG 3.20 | B: club->BG 1.50 | S: club->SS 4.05, SS->SG 2.10   commission 11.63
--  round 1   A trunc(11.00*0.9)=9.90, B trunc(5.00*0.9)=4.50
CREATE TEMP TABLE legacy_before AS
SELECT md5(jsonb_build_array(
   (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.chip_ledger x),
   (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.settlement_invoices x),
   (SELECT jsonb_agg(jsonb_build_array(club_id,user_id,chip_balance) ORDER BY club_id,user_id) FROM public.club_members),
   (SELECT jsonb_agg(jsonb_build_array(id,chip_treasury) ORDER BY id) FROM public.clubs),
   (SELECT jsonb_agg(jsonb_build_array(union_id,chip_balance,rake_wallet) ORDER BY union_id) FROM public.union_wallets),
   (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.rakeback_period_payouts x),
   (SELECT jsonb_agg(jsonb_build_array(id,status,rakeback_amount) ORDER BY id) FROM public.rakeback_periods x))::text) AS fingerprint;

-- (1) Refusals before anything is certified: a week that is not recorded, a
--     week with a figure that moved, and a week above the floor.
DO $refuse$
DECLARE m text;
BEGIN
 BEGIN PERFORM fn_accounting_legacy_certify_week(fixture.u(7991),'2026-08-10 07:00Z','union_direct','Dan','Native fixture refusal: not a recorded week','{"periods":0,"amount":0}');
  RAISE EXCEPTION 'unexpected';
 EXCEPTION WHEN OTHERS THEN m:=SQLERRM; END;
 PERFORM fixture.assert(m='legacy_discharge_requires_one_recorded_undischarged_week','An unrecorded week is refused: '||m);
 BEGIN PERFORM fn_accounting_legacy_certify_week(fixture.u(7991),'2026-08-17 07:00Z','union_direct','Dan','Native fixture refusal: a figure that moved','{"periods":4,"amount":21.32}');
  RAISE EXCEPTION 'unexpected';
 EXCEPTION WHEN OTHERS THEN m:=SQLERRM; END;
 PERFORM fixture.assert(m='legacy_discharge_measurement_moved','A moved figure is refused: '||m);
 BEGIN PERFORM fn_accounting_legacy_certify_week(fixture.u(7991),'2026-08-24 07:00Z','legacy_cascade','Dan','Native fixture refusal: a moved expectation',
   '{"basis":26.00,"pairs":5,"payable":5.46,"payable_by_club":{},"commission_total":11.63,"round1":{},"round2_legs":5,"superseded_periods":2}');
  RAISE EXCEPTION 'unexpected';
 EXCEPTION WHEN OTHERS THEN m:=SQLERRM; END;
 PERFORM fixture.assert(m='legacy_discharge_measurement_moved','A moved legacy measurement is refused and leaves nothing: '||m);
 PERFORM fixture.assert(NOT EXISTS(SELECT 1 FROM accounting_owner_legacy_operations),'Refused certifications leave no operation');
END $refuse$;

-- (2) WEEK 1: certify and pay, union direct.
SELECT fn_accounting_legacy_certify_week(fixture.u(7981),'2026-08-17 07:00Z','union_direct','Dan (native fixture)',
 'Owner decision (fixture): the union pays the remaining deferred rakeback of this week directly.','{"periods":4,"amount":21.33}') AS week1_certified;
DO $w1$
BEGIN
 PERFORM fixture.assert((SELECT string_agg(period_id::text||'>'||club_id::text||':'||(measurement->>'destination_rule'),',' ORDER BY period_id) FROM accounting_legacy_rakeback_certificates WHERE operation_id=fixture.u(7981))=
  fixture.u(7701)::text||'>'||fixture.u(7201)::text||':recorded_club_account,'||fixture.u(7702)::text||'>'||fixture.u(7102)::text||':week_union_table_funding_club,'
  ||fixture.u(7703)::text||'>'||fixture.u(7101)::text||':oldest_union_membership,'||fixture.u(7704)::text||'>'||fixture.u(7102)::text||':week_union_table_funding_club',
  'Each payee is paid into an account it holds: the recorded club, else the union-table funding club, else its oldest union membership');
END $w1$;
-- A payer that cannot cover the week refuses the whole operation, and says by how much.
DO $short$
DECLARE m text; d text;
BEGIN
 BEGIN
  PERFORM set_config('app.ledger_autoskip_union_wallets','1',true);
  UPDATE union_wallets SET rake_wallet=20.00 WHERE union_id=fixture.u(7201);
  PERFORM set_config('app.ledger_autoskip_union_wallets','',true);
  PERFORM fn_accounting_legacy_pay_week(fixture.u(7981));
  RAISE EXCEPTION 'unexpected';
 EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS m=MESSAGE_TEXT,d=PG_EXCEPTION_DETAIL; END;
 PERFORM fixture.assert(m='legacy_discharge_payer_shortfall' AND (d::jsonb->0->>'shortfall')::numeric=1.33,'A short union treasury refuses with its exact shortfall: '||m||' '||COALESCE(d,''));
END $short$;
SELECT fixture.assert((SELECT fingerprint FROM legacy_before)=md5(jsonb_build_array(
   (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.chip_ledger x),
   (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.settlement_invoices x),
   (SELECT jsonb_agg(jsonb_build_array(club_id,user_id,chip_balance) ORDER BY club_id,user_id) FROM public.club_members),
   (SELECT jsonb_agg(jsonb_build_array(id,chip_treasury) ORDER BY id) FROM public.clubs),
   (SELECT jsonb_agg(jsonb_build_array(union_id,chip_balance,rake_wallet) ORDER BY union_id) FROM public.union_wallets),
   (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.rakeback_period_payouts x),
   (SELECT jsonb_agg(jsonb_build_array(id,status,rakeback_amount) ORDER BY id) FROM public.rakeback_periods x))::text),
 'The refused payment changed no journal row, document, balance, payout or period');
SELECT fn_accounting_legacy_pay_week(fixture.u(7981)) AS week1_paid;
DO $w1paid$
DECLARE legs int;
BEGIN
 SELECT count(*) INTO legs FROM chip_ledger WHERE idempotency_key LIKE 'owner_legacy:round3:%' AND metadata->>'legacy_operation_id'=fixture.u(7981)::text;
 PERFORM fixture.assert(legs=3,'Three union payments posted (the zero period posts none): '||legs);
 PERFORM fixture.assert((SELECT rake_wallet FROM union_wallets WHERE union_id=fixture.u(7201))=1000-21.33,'The union rake treasury paid exactly 21.33');
 PERFORM fixture.assert((SELECT chip_balance FROM club_members WHERE club_id=fixture.u(7201) AND user_id=fixture.u(7916))=22.34
   AND (SELECT chip_balance FROM club_members WHERE club_id=fixture.u(7102) AND user_id=fixture.u(7917))=18.99
   AND (SELECT chip_balance FROM club_members WHERE club_id=fixture.u(7101) AND user_id=fixture.u(7918))=10,'Each payee wallet moved by exactly its period');
 PERFORM fixture.assert(NOT EXISTS(SELECT 1 FROM chip_ledger l WHERE l.idempotency_key LIKE 'owner_legacy:round3:%' AND l.metadata->>'legacy_operation_id'=fixture.u(7981)::text
   AND (l.from_type<>'union_wallet' OR (SELECT count(*) FROM settlement_invoices i WHERE i.source_ledger_id=l.id AND i.status='paid' AND i.message_sent AND i.chips_transferred)<>1
     OR NOT EXISTS(SELECT 1 FROM settlement_invoices i JOIN accounting_invoice_deliveries d ON d.invoice_id=i.id WHERE i.source_ledger_id=l.id AND d.recipient_id=l.to_entity_id))),
  'Every union payment has exactly one paid receipt, delivered to its payee');
 PERFORM fixture.assert((SELECT count(*) FROM rakeback_periods WHERE id IN(fixture.u(7701),fixture.u(7702),fixture.u(7703),fixture.u(7704)) AND status='paid')=4
   AND (SELECT count(*) FROM rakeback_period_payouts WHERE rakeback_period_id IN(fixture.u(7701),fixture.u(7702),fixture.u(7703),fixture.u(7704)) AND status='paid')=4,
  'All four periods are closed paid with one payout each');
 PERFORM fixture.assert((SELECT count(*) FROM accounting_deferred_obligations WHERE period_start='2026-08-17 07:00Z' AND discharged_operation_id=fixture.u(7981))=2
   AND (SELECT discharged_amount FROM accounting_deferred_obligations WHERE period_start='2026-08-17 07:00Z' AND scope_kind='union')=17.34
   AND (SELECT discharged_amount FROM accounting_deferred_obligations WHERE period_start='2026-08-17 07:00Z' AND scope_kind='club')=3.99,
  'Both recorded obligations are discharged with the operation and exact amounts, and kept');
 PERFORM fixture.assert(EXISTS(SELECT 1 FROM accounting_routed_settlement_runs WHERE union_id=fixture.u(7201) AND period_start='2026-08-17 07:00Z' AND round_no=3 AND result->>'source'='owner_legacy_discharge_v1'),
  'The payment is shown under an explicitly owner-authorized run in the same run table');
END $w1paid$;

-- (3) WEEK 2: certify and pay, legacy cascade.
SELECT fn_accounting_legacy_certify_week(fixture.u(7982),'2026-08-24 07:00Z','legacy_cascade','Dan (native fixture)',
 'Owner decision (fixture): pay the measured week through the cascade on a documented legacy basis.',
 jsonb_build_object('basis',26.00,'pairs',5,'payable',5.45,'payable_by_club',jsonb_build_object(fixture.u(7101),2.55,fixture.u(7102),1.00,fixture.u(7103),1.90),
  'commission_total',11.63,'round1',jsonb_build_object(fixture.u(7101),9.90,fixture.u(7102),4.50),'round2_legs',5,'superseded_periods',2)) AS week2_certified;
-- Replaying the certification of a certified week is refused.
DO $recert$DECLARE m text;BEGIN
 BEGIN PERFORM fn_accounting_legacy_certify_week(fixture.u(7983),'2026-08-24 07:00Z','legacy_cascade','Dan','Native fixture: second operation for one week','{}');
  RAISE EXCEPTION 'unexpected'; EXCEPTION WHEN OTHERS THEN m:=SQLERRM; END;
 PERFORM fixture.assert(m='legacy_discharge_already_recorded','One operation per week: '||m);
END$recert$;
CREATE TEMP TABLE legacy_w2_before AS SELECT club_id,user_id,chip_balance FROM club_members WHERE club_id IN(fixture.u(7101),fixture.u(7102),fixture.u(7103));
CREATE TEMP TABLE legacy_w2_clubs AS SELECT id,chip_treasury FROM clubs WHERE id IN(fixture.u(7101),fixture.u(7102),fixture.u(7103));
SELECT fn_accounting_legacy_pay_week(fixture.u(7982)) AS week2_paid;
DO $w2paid$
DECLARE bad int;
BEGIN
 -- Wallet deltas, derived by hand above.
 SELECT count(*) INTO bad FROM (VALUES
   (7101,7911,2.40),(7101,7912,0.15),(7102,7913,1.00),(7103,7914,1.50),(7103,7915,0.40),
   (7101,7921,6.08-3.20),(7101,7922,3.20-2.40),(7102,7924,1.50-1.00),(7103,7925,4.05-2.10),(7103,7926,2.10-1.50)) e(c,u,d)
  JOIN legacy_w2_before b ON b.club_id=fixture.u(e.c) AND b.user_id=fixture.u(e.u)
  JOIN club_members cm ON cm.club_id=b.club_id AND cm.user_id=b.user_id WHERE cm.chip_balance<>b.chip_balance+e.d;
 PERFORM fixture.assert(bad=0,'Every player and agent wallet moved by exactly its hand-derived amount');
 SELECT count(*) INTO bad FROM (VALUES(7101,9.90-6.08-0.15),(7102,4.50-1.50),(7103,-4.05-0.40)) e(c,d)
  JOIN legacy_w2_clubs b ON b.id=fixture.u(e.c) JOIN clubs c ON c.id=b.id WHERE c.chip_treasury<>b.chip_treasury+e.d;
 PERFORM fixture.assert(bad=0,'Every club treasury moved by exactly its round 1 receipt less its payments');
 PERFORM fixture.assert((SELECT rake_wallet FROM union_wallets WHERE union_id=fixture.u(7201))=1000-21.33-14.40,'The union funded its clubs 14.40 and nothing else');
 PERFORM fixture.assert((SELECT count(*) FROM chip_ledger WHERE metadata->>'legacy_operation_id'=fixture.u(7982)::text)=2+5+5,
  'Two round 1, five round 2 and five round 3 legs, nothing else');
 PERFORM fixture.assert(NOT EXISTS(SELECT 1 FROM chip_ledger l WHERE l.metadata->>'legacy_operation_id'=fixture.u(7982)::text
   AND (SELECT count(*) FROM settlement_invoices i WHERE i.source_ledger_id=l.id AND i.status='paid' AND i.message_sent AND i.chips_transferred AND i.net_amount=l.amount)<>1),
  'Every leg has exactly one paid, delivered receipt');
 PERFORM fixture.assert(NOT EXISTS(SELECT 1 FROM chip_ledger l JOIN settlement_invoices i ON i.source_ledger_id=l.id
   WHERE l.metadata->>'legacy_operation_id' IN(fixture.u(7981)::text,fixture.u(7982)::text)
     AND (NOT EXISTS(SELECT 1 FROM accounting_invoice_deliveries d WHERE d.invoice_id=i.id)
      OR EXISTS(SELECT 1 FROM accounting_invoice_deliveries d WHERE d.invoice_id=i.id AND (d.message_id IS NULL OR d.notification_id IS NULL
        OR NOT EXISTS(SELECT 1 FROM social_messages m WHERE m.id=d.message_id AND m.message_type='invoice')
        OR NOT EXISTS(SELECT 1 FROM notifications n WHERE n.id=d.notification_id AND n.user_id=d.recipient_id)))
      OR (l.category='rakeback' AND l.to_type='player_wallet' AND NOT EXISTS(SELECT 1 FROM accounting_invoice_deliveries d WHERE d.invoice_id=i.id AND d.recipient_id=l.to_entity_id)))),
  'Every receipt is delivered as an invoice-workspace Messenger record with its own notification, and every rakeback receipt reaches its payee');
 PERFORM fixture.assert(NOT EXISTS(SELECT 1 FROM chip_ledger l WHERE l.metadata->>'legacy_operation_id' IN(fixture.u(7981)::text,fixture.u(7982)::text)
   AND (l.from_type='settlement_suspense' OR l.to_type='settlement_suspense')),'No leg touches the clearing account');
 PERFORM fixture.assert((SELECT string_agg(status,',' ORDER BY id) FROM rakeback_periods WHERE id IN(fixture.u(7711),fixture.u(7712),fixture.u(7713),fixture.u(7714)))='paid,paid,closed,closed'
   AND (SELECT rakeback_amount FROM rakeback_periods WHERE id=fixture.u(7711))=2.40 AND (SELECT rakeback_amount FROM rakeback_periods WHERE id=fixture.u(7713))=0.20,
  'Restated rows are paid at their measured figure; superseded rows are closed with their record intact');
 PERFORM fixture.assert((SELECT count(*) FROM rakeback_periods WHERE period_start='2026-08-24' AND status='paid' AND club_id IN(fixture.u(7101),fixture.u(7102),fixture.u(7103)))=5,
  'Five measured periods are closed paid, three of them opened by the operation');
 PERFORM fixture.assert((SELECT discharged_amount FROM accounting_deferred_obligations WHERE period_start='2026-08-24 07:00Z' AND scope_kind='union')=3.55
   AND (SELECT discharged_amount FROM accounting_deferred_obligations WHERE period_start='2026-08-24 07:00Z' AND scope_kind='club')=1.90
   AND (SELECT discharged_periods FROM accounting_deferred_obligations WHERE period_start='2026-08-24 07:00Z' AND scope_kind='union')=3,
  'Both week 2 obligations are discharged at their measured amounts');
 PERFORM fixture.assert((SELECT count(*) FROM accounting_routed_settlement_runs WHERE period_start='2026-08-24 07:00Z' AND result->>'source'='owner_legacy_discharge_v1')=4,
  'Round 2 and 3 runs are recorded for the union scope and the standalone scope');
END $w2paid$;

-- (4) Replay pays nothing.
CREATE TEMP TABLE legacy_after AS SELECT (SELECT count(*) FROM chip_ledger) AS legs,(SELECT sum(chip_balance) FROM club_members) AS members,
 (SELECT sum(chip_treasury) FROM clubs) AS treasuries,(SELECT sum(rake_wallet) FROM union_wallets) AS rake;
SELECT fixture.assert((fn_accounting_legacy_pay_week(fixture.u(7982))->>'duplicate')='true','A paid operation replays as a duplicate');
SELECT fixture.assert((fn_accounting_legacy_pay_week(fixture.u(7981))->>'duplicate')='true','The union-direct operation replays as a duplicate');
SELECT fixture.assert((SELECT legs FROM legacy_after)=(SELECT count(*) FROM chip_ledger) AND (SELECT members FROM legacy_after)=(SELECT sum(chip_balance) FROM club_members)
 AND (SELECT treasuries FROM legacy_after)=(SELECT sum(chip_treasury) FROM clubs) AND (SELECT rake FROM legacy_after)=(SELECT sum(rake_wallet) FROM union_wallets),'Replay moved nothing and wrote nothing');

-- (5) The constraint accepts the legacy kind only with a matching certificate.
DO $forged$
DECLARE m text; p uuid;
BEGIN
 SELECT id INTO p FROM rakeback_period_payouts WHERE rakeback_period_id=fixture.u(7711);
 BEGIN
  SET CONSTRAINTS zz_ca_rakeback_payout_leg_is_documented IMMEDIATE;
  PERFORM set_config('app.ledger_autoskip_club_members','1',true);
  INSERT INTO chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata)
  VALUES(fixture.u(900),'club_treasury',fixture.u(7101),'player_wallet',fixture.u(7911),2.40,'rakeback',fixture.u(7101),fixture.u(7201),'forged','forged:legacy',
   jsonb_build_object('routing_version',3,'accounting_scope_kind','union','accounting_scope_id',fixture.u(7201),'period_id',fixture.u(7711),
    'period_start','2026-08-24 07:00Z','period_end','2026-08-31 07:00Z','certificate_id',1,'certificate_kind','owner_legacy_v1',
    'legacy_operation_id',fixture.u(7981),'payout_id',p,'payee_role_at_transfer','player'));
  RAISE EXCEPTION 'unexpected';
 EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS m=PG_EXCEPTION_DETAIL; END;
 PERFORM fixture.assert(m LIKE '%names no matching owner legacy certificate%','A legacy leg naming another operation''s certificate is refused: '||COALESCE(m,''));
END $forged$;
SET CONSTRAINTS ALL DEFERRED;
SELECT 'OWNER-LEGACY-DISCHARGE-OK' AS step;
