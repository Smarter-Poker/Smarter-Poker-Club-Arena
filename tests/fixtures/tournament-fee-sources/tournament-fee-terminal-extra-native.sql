BEGIN;
SET CONSTRAINTS accounting_tournament_fee_commit_capture DEFERRED;
SELECT fixture_fee(4700);
INSERT INTO rake_records(id,tournament_id,is_tournament,club_id,rake_amount,source,metadata,created_at)
 VALUES(u(4702),u(4700),true,u(99),-1,'atomic_cancel_tournament',jsonb_build_object('user_id',u(4711),'original_rake_record_id',u(4701)),transaction_timestamp());
INSERT INTO tournament_cancellation_receipts VALUES(u(4700),ARRAY[u(4702)],0,1,1);
SELECT assert_true(fn_record_accounting_tournament_cancellation(u(4700))->>'status'='cancelled','same transaction cancellation captures its original charge before zero recognition');
SELECT assert_true((SELECT count(*)=1 AND bool_and(disposition='refunded') FROM accounting_tournament_recognized_sources WHERE tournament_id=u(4700)) AND NOT EXISTS(SELECT 1 FROM agent_commissions WHERE source_id IN(SELECT id FROM accounting_tournament_fee_sources WHERE tournament_id=u(4700))),'cancelled charge has exact refunded source and no commission');
SELECT assert_true(fn_accounting_tournament_terminal_fee_receipt(u(4700))->>'bank_receipt_kind'='none','cancelled zero fee creates no fictitious bank transfer');
SELECT assert_true((fn_record_accounting_tournament_cancellation(u(4700))->>'replayed')::boolean,'cancellation accounting safely replays its exact source receipt');

SELECT fixture_fee(4800,true,1);
UPDATE tournament_players SET registered_at=transaction_timestamp()-interval '2 hours' WHERE tournament_id=u(4800);
UPDATE tournament_refund_entitlements SET created_at=transaction_timestamp()-interval '2 hours' WHERE tournament_id=u(4800);
UPDATE chip_ledger SET created_at=transaction_timestamp()-interval '2 hours' WHERE to_entity_id=u(4800);
INSERT INTO rake_records(id,tournament_id,is_tournament,club_id,rake_amount,source,metadata,created_at)
 VALUES(u(4803),u(4800),true,u(99),-1,'atomic_cancel_tournament',jsonb_build_object('original_rake_record_id',u(4801)),transaction_timestamp());
INSERT INTO tournament_cancellation_receipts VALUES(u(4800),ARRAY[u(4803)],0,1,1);
SELECT assert_true(fn_record_accounting_tournament_cancellation(u(4800))->>'status'='banked_accrual_deferred','cancelled legacy fee records durable historical gap without guessing earnings');
SELECT assert_true((SELECT net_rake=0 AND recognized_at=transaction_timestamp() FROM accounting_tournament_fee_recognitions WHERE tournament_id=u(4800)) AND NOT EXISTS(SELECT 1 FROM accounting_tournament_recognized_sources WHERE tournament_id=u(4800)),'legacy cancellation gap is assigned only its actual terminal week');

-- Re-entry after a prior full unregister: cancellation names all old raw
-- sources including the earlier negative. Resolve that dependency exactly.
SELECT fixture_fee(4900);
SELECT fn_stamp_accounting_tournament_fee(u(4901));
INSERT INTO rake_records(id,tournament_id,is_tournament,club_id,rake_amount,source,metadata,created_at)
 VALUES(u(4902),u(4900),true,u(99),-1,'fn_unregister_from_tournament',jsonb_build_object('user_id',u(4911),'original_rake_record_ids',jsonb_build_array(u(4901))),transaction_timestamp());
INSERT INTO tournament_unregistration_receipts VALUES(u(4900),u(4911),ARRAY[u(4902)],ARRAY[u(4901)]);
INSERT INTO chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,club_id,category,amount,created_at) VALUES(u(4932),'player_wallet',u(4911),'prize_liability',u(4900),u(21),'rebuy',2,transaction_timestamp());
INSERT INTO tournament_refund_entitlements VALUES(u(4942),u(4900),u(4911),u(21),u(4932),transaction_timestamp(),2,1,'wallet_charge','rebuy',NULL,NULL,NULL);
INSERT INTO rake_records(id,tournament_id,is_tournament,club_id,rake_amount,source,metadata,player_contributions,created_at)
 VALUES(u(4903),u(4900),true,u(99),1,'process_tournament_rebuy',jsonb_build_object('user_id',u(4911),'kind','tournament_reentry_fee'),jsonb_build_object(u(4911),1),transaction_timestamp());
SELECT fn_stamp_accounting_tournament_fee(u(4903));
INSERT INTO rake_records(id,tournament_id,is_tournament,club_id,rake_amount,source,metadata,created_at)
 VALUES(u(4904),u(4900),true,u(99),-1,'atomic_cancel_tournament',jsonb_build_object('user_id',u(4911),'original_rake_record_ids',jsonb_build_array(u(4901),u(4902),u(4903))),transaction_timestamp());
INSERT INTO tournament_cancellation_receipts VALUES(u(4900),ARRAY[u(4904)],0,1,1);
SELECT assert_true((fn_accounting_tournament_fee_net_plan(u(4900))->>'gross_fee')::numeric=2 AND (fn_accounting_tournament_fee_net_plan(u(4900))->>'refunded_fee')::numeric=2,'nested unregister then re-entry cancellation conserves every fee cent');
SELECT fn_record_accounting_tournament_cancellation(u(4900));
SELECT assert_true((SELECT count(*)=2 AND bool_and(disposition='refunded' AND rake_credit=0) FROM accounting_tournament_recognized_sources WHERE tournament_id=u(4900)),'nested reversal settles both original source identities exactly once');

SELECT assert_sql_refuses('UPDATE union_wallet_transactions SET amount=99 WHERE id=u(3090)','recognized_tournament_fee_bank_receipt_is_immutable','actual bank receipt linked to a recognition cannot be rewritten');
SELECT assert_sql_refuses('DELETE FROM accounting_tournament_fee_recognitions WHERE tournament_id=u(4700)','accounting_tournament_fee_receipt_is_immutable','terminal accounting receipt cannot be removed');
SELECT assert_sql_refuses('SELECT fn_attribute_tournament_rake(u(4200))','tournament_fee_sources_require_reconciliation','legacy attribution RPC cannot mark deferred accounting complete');
SELECT assert_true((fn_attribute_tournament_rake(u(4000))->>'already_attributed')::boolean AND (SELECT count(*)=3 FROM agent_commissions WHERE source_id IN(SELECT id FROM accounting_tournament_fee_sources WHERE tournament_id=u(4000))),'old attribution RPC only observes canonical source receipt');
SELECT assert_true((fn_backpay_tournament_rake_attribution()->>'paid')::integer=0 AND (fn_repair_tournament_rake_attribution()->>'repaired')::integer=0 AND (SELECT attributed_at IS NULL FROM tournament_rake_settlements WHERE tournament_id=u(4200)),'old repair doors never stamp deferred liabilities paid or attributed');
SELECT count(*) AS native_assertions FROM assertions;
COMMIT;
