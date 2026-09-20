CREATE FUNCTION report() RETURNS jsonb LANGUAGE sql AS $$SELECT fn_union_pnl_evidence_report(u(1),'2026-09-07 07:00Z','2026-09-14 07:00Z')$$;
CREATE FUNCTION payment() RETURNS jsonb LANGUAGE sql AS $$SELECT fn_union_pnl_posted_payment_evidence(u(1),'2026-09-07 07:00Z','2026-09-14 07:00Z')$$;
SELECT ok(fn_pnl_evidence_cents('1.01')=1.01 AND fn_pnl_evidence_cents('"NaN"') IS NULL
 AND fn_pnl_evidence_cents('0.001') IS NULL AND fn_pnl_evidence_cents('null') IS NULL,'cents reject strings, missing values and fractional units');
SELECT ok(report()->>'status'='blocked' AND report()->>'player_pnl' IS NULL
 AND report()->'issues' ? 'exact_opening_snapshot_missing','absence is missing evidence, never a zero baseline');
INSERT INTO union_pnl_settlements VALUES(u(2),u(1),'2026-08-31 07:00Z','2026-09-07 04:47Z','baseline',0,0,0,'[]',NULL,0);
SELECT ok(report()->'issues' ? 'exact_opening_snapshot_missing','nearby stale baseline is never silently selected');
INSERT INTO union_pnl_settlements VALUES(u(3),u(1),'2026-08-31 07:00Z','2026-09-07 07:00Z','baseline',0,0,0,'[]',NULL,0);
SELECT ok(NOT report()->'issues' ? 'exact_opening_snapshot_missing' AND report()->>'basis_certified'='false'
 AND report()->'issues' ? 'boundary_snapshot_provenance_missing','exact boundary timestamp alone does not certify snapshot provenance');
INSERT INTO union_pnl_settlements SELECT u(4),union_id,period_start,period_end,status,total_collected,total_paid,total_unpaid,club_results,settled_at,house_residual FROM union_pnl_settlements WHERE id=u(3);
SELECT ok(report()->'issues' ? 'exact_opening_snapshot_ambiguous','multiple exact snapshots are visible and ambiguous');
DELETE FROM union_pnl_settlements WHERE id=u(4);
SELECT ok(payment()->>'settled_in_chips'='false' AND payment()->>'status'='not_posted','calculated values alone never imply a chip payment');
INSERT INTO union_pnl_settlements VALUES(u(10),u(1),'2026-09-07 07:00Z','2026-09-14 07:00Z','settled',10,10,0,
 jsonb_build_array(jsonb_build_object('club_id',u(11),'net',-10),jsonb_build_object('club_id',u(12),'net',10)),'2026-09-14 07:01Z',0);
SELECT ok(payment()->>'settled_in_chips'='false' AND payment()->>'reason'='final_pnl_posting_receipt_missing_or_ambiguous','settled claim without final posting proves nothing');
INSERT INTO ca_settlements(id,settlement_type,union_id,idempotency_key,state,totals) VALUES(u(20),'union_player_pnl',u(1),
 'pnl:'||u(1)||':'||extract(epoch FROM '2026-09-07 07:00Z'::timestamptz)::bigint,'final','{"collected":10,"paid":10,"unpaid":0}');
SELECT ok(payment()->>'settled_in_chips'='false','final state without actual typed payment legs is unverified');
INSERT INTO chip_ledger(id,club_id,union_id,category,from_type,from_entity_id,to_type,to_entity_id,amount,status,settlement_id,
 pre_from_balance,post_from_balance,pre_to_balance,post_to_balance,created_at) VALUES
 (u(21),u(11),u(1),'pnl_settlement','club_treasury',u(11),'union_wallet',u(1),10,'posted',u(20)::text,100,90,NULL,NULL,'2026-09-14 07:01Z'),
 (u(22),u(12),u(1),'pnl_settlement','union_wallet',u(1),'club_treasury',u(12),10,'posted',u(20)::text,NULL,NULL,100,110,'2026-09-14 07:01Z');
SELECT ok(payment()->>'settled_in_chips'='false','actual chip journals still require coherent delivered payment receipts');
INSERT INTO settlement_invoices VALUES
 (u(31),u(11),u(21),'paid',true,true,'club',u(11)::text,'union',u(1)::text,10,10,0),
 (u(32),u(12),u(22),'paid',true,true,'union',u(1)::text,'club',u(12)::text,10,10,0);
SELECT ok(payment()->>'settled_in_chips'='true' AND payment()->>'status'='verified'
 AND payment()->>'basis_certified'='false','exact journal and invoice evidence proves posting independently of uncertified basis');
SELECT ok(report()->>'status'='blocked' AND report()->'posted_pnl_payment_evidence'->>'settled_in_chips'='true','paid chips cannot certify defective historical profit');
BEGIN; UPDATE chip_ledger SET union_id=u(9) WHERE id=u(22);
SELECT ok(payment()->>'settled_in_chips'='false','wrong recorded union on an actual leg refuses payment proof'); ROLLBACK;
BEGIN; UPDATE chip_ledger SET amount=9.99 WHERE id=u(22);
SELECT ok(payment()->>'settled_in_chips'='false','one cent payment shortfall refuses full settlement label'); ROLLBACK;
BEGIN; UPDATE chip_ledger SET pre_to_balance='NaN' WHERE id=u(22);
SELECT ok(payment()->>'settled_in_chips'='false','nonfinite balance evidence refuses chip settlement'); ROLLBACK;
BEGIN; UPDATE chip_ledger SET post_to_balance=110.01 WHERE id=u(22);
SELECT ok(payment()->>'settled_in_chips'='false','balance delta must equal the actual leg'); ROLLBACK;
BEGIN; UPDATE settlement_invoices SET to_entity_id=u(99)::text WHERE id=u(32);
SELECT ok(payment()->>'settled_in_chips'='false','wrong invoice payee refuses proof'); ROLLBACK;
BEGIN; UPDATE settlement_invoices SET message_sent=false WHERE id=u(32);
SELECT ok(payment()->>'settled_in_chips'='false','missing delivery is visible'); ROLLBACK;
BEGIN; INSERT INTO settlement_invoices SELECT u(33),club_id,source_ledger_id,status,chips_transferred,message_sent,from_entity_type,from_entity_id,to_entity_type,to_entity_id,gross_amount,net_amount,deductions FROM settlement_invoices WHERE id=u(32);
SELECT ok(payment()->>'settled_in_chips'='false','duplicate invoice proof cannot masquerade as a unique payment'); ROLLBACK;
BEGIN; UPDATE union_pnl_settlements SET total_unpaid=.01 WHERE id=u(10);
SELECT ok(payment()->>'reason'='invalid_or_partial_pnl_claim','legacy partial remains explicitly unverified'); ROLLBACK;
BEGIN; UPDATE union_pnl_settlements SET club_results=club_results||jsonb_build_array(club_results->0) WHERE id=u(10);
SELECT ok(payment()->>'reason'='invalid_or_duplicate_club_obligation','duplicate club obligations do not double-count posting proof'); ROLLBACK;
BEGIN; UPDATE ca_settlements SET totals='{"collected":10,"paid":9,"unpaid":0}' WHERE id=u(20);
SELECT ok(payment()->>'settled_in_chips'='false','claim and final totals must reconcile exactly'); ROLLBACK;
BEGIN; INSERT INTO chip_ledger(id,category,settlement_id) VALUES(u(24),'pnl_settlement',u(20)::text);
SELECT ok(payment()->>'settled_in_chips'='false','unexplained extra posting refuses a complete receipt'); ROLLBACK;
BEGIN; UPDATE union_pnl_settlements SET total_paid=0,total_collected=0,club_results=jsonb_build_array(jsonb_build_object('club_id',u(11),'net',0)) WHERE id=u(10);
UPDATE ca_settlements SET totals='{"collected":0,"paid":0,"unpaid":0}' WHERE id=u(20); DELETE FROM chip_ledger; DELETE FROM settlement_invoices;
SELECT ok(payment()->>'status'='verified' AND payment()->>'settled_in_chips'='false' AND payment()->>'no_chip_movement'='true','verified zero obligations are labelled no chip movement'); ROLLBACK;

INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id,stack_result,committed_at) VALUES(u(40),1,u(41),
 jsonb_build_object('success',true,'mode','delta','hand_id',u(42),'tournament_id',NULL,
 'request',jsonb_build_object('rake',0,'bbj',0,'inflow',0,'stacks',jsonb_build_array(
 jsonb_build_object('user_id',u(43),'stack_before',100,'stack',110),jsonb_build_object('user_id',u(44),'stack_before',100,'stack',90)))),'2026-09-08 07:00Z');
INSERT INTO settlement_idempotency_keys SELECT table_id,u(42),'succeeded',stack_result,committed_at FROM hand_atomic_commits;
INSERT INTO ca_settlements(id,settlement_type,state,table_id,hand_id) VALUES(u(45),'hand_stacks','final',u(40),u(42));
INSERT INTO profiles VALUES(u(43),true),(u(44),false);
SELECT ok(fn_pnl_cash_hand_evidence(u(40),1)->>'status'='blocked'
 AND jsonb_array_length(fn_pnl_cash_hand_evidence(u(40),1)->'participants')=2
 AND fn_pnl_cash_hand_evidence(u(40),1)->>'observed_delta_total'='0','zero-rake horses and humans remain in the exact hand delta roster');
INSERT INTO rake_attributions VALUES(u(41),u(43),u(11)),(u(41),u(43),u(12));
SELECT ok(jsonb_array_length(fn_pnl_cash_hand_evidence(u(40),1)->'participants'->0->'corroborating_rake_clubs')=2
 AND fn_pnl_cash_hand_evidence(u(40),1)->'participants'->0->>'earning_club_id' IS NULL,'ambiguous rake attribution is corroboration, never an invented earning club');
CREATE TEMP TABLE before_diagnostic AS SELECT report() r,fn_pnl_cash_hand_evidence(u(40),1) h;
INSERT INTO table_seats VALUES(u(43),u(99),99999,'2026-09-14 08:00Z');
INSERT INTO club_members VALUES(u(43),u(99)); INSERT INTO tournaments VALUES(u(71),'RUNNING');
UPDATE profiles SET is_horse=NOT is_horse;
SELECT ok(report()=(SELECT r FROM before_diagnostic) AND fn_pnl_cash_hand_evidence(u(40),1)=(SELECT h FROM before_diagnostic),
 'new seats, changed membership, horses and live tournament status cannot rewrite historical evidence');
BEGIN; UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,'{request,stacks,0,stack}','110.001');
SELECT ok(fn_pnl_cash_hand_evidence(u(40),1)->>'reason'='invalid_or_duplicate_delta_participant','malformed hand amounts refuse numeric evidence'); ROLLBACK;
BEGIN; UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,'{request,stacks,1,user_id}',to_jsonb(u(43)::text));
SELECT ok(fn_pnl_cash_hand_evidence(u(40),1)->>'reason'='invalid_or_duplicate_delta_participant','duplicate hand players refuse evidence'); ROLLBACK;
BEGIN; UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,'{tournament_id}',to_jsonb(u(71)::text));
SELECT ok(fn_pnl_cash_hand_evidence(u(40),1)->>'reason'='cash_hand_scope_unproven_or_tournament_play_chips','tournament play chips are never cash profit'); ROLLBACK;
BEGIN; DELETE FROM settlement_idempotency_keys;
SELECT ok(fn_pnl_cash_hand_evidence(u(40),1)->'issues' ? 'accepted_stack_receipt_link_missing','orphaned atomic history does not prove accepted stacks'); ROLLBACK;
SELECT ok(fn_pnl_cash_hand_evidence(u(40),99)->>'reason'='atomic_hand_receipt_missing','missing accepted hand stays missing');
BEGIN; UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,'{request,inflow}','null');
SELECT ok(NOT fn_pnl_cash_hand_evidence(u(40),1)->'issues' ? 'hand_conservation_inputs_missing','explicit null inflow retains installed zero-inflow semantics'); ROLLBACK;
BEGIN; UPDATE hand_atomic_commits SET stack_result=stack_result#-'{request,inflow}';
SELECT ok(fn_pnl_cash_hand_evidence(u(40),1)->'issues' ? 'hand_conservation_inputs_missing','missing inflow evidence is distinct from explicit zero'); ROLLBACK;
BEGIN; UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,'{request,rake}','0.01');
SELECT ok(fn_pnl_cash_hand_evidence(u(40),1)->'issues' ? 'hand_delta_conservation_mismatch','one cent hand conservation mismatch is visible'); ROLLBACK;

INSERT INTO chip_ledger(id,club_id,union_id,category,from_type,from_entity_id,to_type,to_entity_id,amount,status,tournament_id,created_at) VALUES
 (u(60),u(11),u(1),'tournament_buyin','player_wallet',u(43),'prize_liability',u(71),10,'posted',u(71),'2026-09-08 08:00Z'),
 (u(61),u(11),u(1),'refund','prize_liability',u(71),'player_wallet',u(43),10,'posted',u(71),'2026-09-09 08:00Z'),
 (u(62),u(12),u(1),'addon','player_wallet',u(44),'prize_liability',u(71),2,'posted',u(71),'2026-09-09 08:01Z'),
 (u(63),u(99),u(1),'prize','prize_liability',u(71),'player_wallet',u(43),5,'posted',u(71),'2026-09-09 08:02Z');
INSERT INTO tournament_refund_entitlements VALUES(u(70),u(71),u(43),'wallet_charge','tournament_buyin',u(11),10,u(60));
INSERT INTO tournament_refund_tranches VALUES(u(72),u(70),u(61),u(71),u(43),u(11),10,8,1,1,'2026-09-09 08:00Z');
SELECT ok(report()->'tournament_refund_evidence'->>'verified_wallet_refunds'='1'
 AND report()->'tournament_refund_evidence'->'first_receipts'->0->>'recorded_funding_club_id'=u(11)::text,
 'refund debit and credit prove the original funding club even after player membership changes');
SELECT ok(EXISTS(SELECT 1 FROM jsonb_array_elements(report()->'observed_journal_flows') x WHERE x->>'club_id'=u(12)::text
 AND x->>'evidence_kind'='tournament_wallet_funding' AND x->>'observed_posted_amount'='2'),
 'addon source is observed explicitly instead of omitted from wallet funding');
SELECT ok(report()->>'player_pnl' IS NULL AND report()->'issues' ? 'tournament_earning_and_open_equity_basis_uncertified',
 'award destination club is observed without inventing original tournament earning ownership');
BEGIN; UPDATE chip_ledger SET club_id=u(99) WHERE id=u(61);
SELECT ok(report()->'tournament_refund_evidence'->>'unverified_count'='1','refund paid to wrong club is an exact source-evidence gap'); ROLLBACK;
BEGIN; UPDATE chip_ledger SET status='failed' WHERE id=u(60);
SELECT ok(report()->'tournament_refund_evidence'->>'unverified_count'='1','unposted original debit cannot prove a funded refund'); ROLLBACK;
BEGIN; UPDATE chip_ledger SET created_at='2026-09-14 07:00Z' WHERE id=u(61); UPDATE tournament_refund_tranches SET created_at='2026-09-14 07:00Z';
SELECT ok(report()->'tournament_refund_evidence'->>'count'='0','exact closing boundary is half-open and excludes next-week refunds'); ROLLBACK;
BEGIN; INSERT INTO tournament_refund_tranches SELECT u(73),entitlement_id,credit_ledger_id,tournament_id,user_id,source_wallet_club_id,amount_paid_now,refund_prize,refund_bounty,refund_fee,created_at FROM tournament_refund_tranches;
SELECT ok(report()->'tournament_refund_evidence'->>'verified_wallet_refunds'='0','one credit cannot prove two refund tranches'); ROLLBACK;
BEGIN; UPDATE chip_ledger SET category='unrecognized_award',club_id=NULL WHERE id=u(63);
SELECT ok((report()->'player_journal_gaps'->>'count')::int>0,'unknown categories and ownership remain visible'); ROLLBACK;

CREATE TEMP TABLE before_read AS SELECT (SELECT md5(jsonb_agg(to_jsonb(t))::text) FROM union_pnl_settlements t) claims,
 (SELECT md5(jsonb_agg(to_jsonb(t))::text) FROM chip_ledger t) ledger,(SELECT md5(jsonb_agg(to_jsonb(t))::text) FROM settlement_invoices t) invoices;
BEGIN READ ONLY; SELECT report()->>'status'; SELECT fn_pnl_cash_hand_evidence(u(40),1)->>'status'; COMMIT;
SELECT ok((SELECT claims=(SELECT md5(jsonb_agg(to_jsonb(t))::text) FROM union_pnl_settlements t)
 AND ledger=(SELECT md5(jsonb_agg(to_jsonb(t))::text) FROM chip_ledger t)
 AND invoices=(SELECT md5(jsonb_agg(to_jsonb(t))::text) FROM settlement_invoices t) FROM before_read),'read-only execution never mutates claims, money or issued invoices');
SELECT ok(NOT has_function_privilege('authenticated','fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)','EXECUTE')
 AND has_function_privilege('service_role','fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)','EXECUTE')
 AND NOT has_function_privilege('service_role','fn_union_pnl_posted_payment_evidence(uuid,timestamptz,timestamptz)','EXECUTE'),
 'financial evidence has service-only entrypoints and private helper authority');
DO $$BEGIN
 BEGIN PERFORM fn_union_pnl_evidence_report(u(1),'2026-09-01','2026-09-07'); RAISE EXCEPTION 'accepted old period';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM fn_union_pnl_evidence_report(u(1),'infinity','infinity'); RAISE EXCEPTION 'accepted infinite period';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM fn_union_pnl_evidence_report(u(1),'2026-09-07',now()+interval '8 days'); RAISE EXCEPTION 'accepted future period';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 PERFORM ok(true,'pre-floor, nonfinite, open and unbounded historical periods refuse'); END$$;
