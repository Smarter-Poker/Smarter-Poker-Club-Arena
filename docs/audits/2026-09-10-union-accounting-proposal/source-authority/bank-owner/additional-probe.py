# Additional native cases reviewed independently by payer and Round2 lanes.
refused('Canonical empty uncalled-return map cannot be replaced by SQL NULL',
 bank(1000010).replace("NULL,'{}'","NULL,NULL"),'conflict')
refused('Actual stored agent policy refuses fractional commission above70%',
 "UPDATE agents SET commission_rate=.85 WHERE id=test_id(101);",'agents_commission_rate_check')
before=state()
booked=json.loads(sql("SELECT fn_admin_update_agent(p_agent_id=>test_id(101),p_commission_rate=>.85);"))
check('Actual booked producer refuses above70% without changing its contract',
 not booked['success'] and '0.70' in booked['error'] and state()==before)
before=state()
whole=json.loads(sql("SELECT fn_admin_update_agent(p_agent_id=>test_id(101),p_commission_rate=>80);"))
check('Actual booked producer refuses whole-percent input; no silent unit conversion',
 not whole['success'] and state()==before)
ledger_changes={
 'from_type':"'player_wallet'",'to_type':"'union_bank'",
 'from_entity_id':'test_id(999)','to_entity_id':'test_id(999)',
 'club_id':'test_id(999)','table_id':'test_id(999)','hand_id':'test_id(999)',
 'amount':'amount+1','category':"'adjustment'",'status':"'reversal'",
 'created_at':"created_at+interval '1 hour'"}
for field,value in ledger_changes.items():
 refused('Linked ledger '+field+' remains immutable under actual maintenance setting',
  "SET app.ledger_maintenance='native-proof-only'; UPDATE chip_ledger SET "+field+'='+value+
  " WHERE id=(SELECT chip_ledger_id FROM ca_cash_bank_receipts WHERE hand_id=test_id(1000010));",'immutable')
for field,value in {'union_id':'test_id(902)','club_id':'test_id(999)','wallet':"'chip_balance'",
 'direction':"'debit'",'tx_type':"'adjustment'",'amount':'amount+1',
 'created_at':"created_at+interval '1 hour'"}.items():
 refused('Linked Union credit '+field+' remains immutable under actual maintenance setting',
  "SET app.ledger_maintenance='native-proof-only'; UPDATE union_wallet_transactions SET "+field+'='+value+
  " WHERE id=(SELECT union_wallet_transaction_id FROM ca_cash_bank_receipts WHERE hand_id=test_id(1000011));",'immutable')
for relation in ['chip_ledger','union_wallet_transactions']:
 refused('Linked '+relation+' cannot be truncated with cascading references',
  "SET app.ledger_maintenance='native-proof-only'; TRUNCATE "+relation+' CASCADE;')
# The rejected credit must leave all support rows and immutable capacities absent.
sql('SELECT test_owner(1000013);')
sql("CREATE FUNCTION test_skip_bank_destination() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END$$; CREATE TRIGGER zz_test_skip_bank_destination BEFORE UPDATE OF chip_treasury ON clubs FOR EACH ROW EXECUTE FUNCTION test_skip_bank_destination();")
refused('Zero-row club destination write cannot be acknowledged as funded',
 bank(1000013),'destination credit did not apply')
sql('DROP TRIGGER zz_test_skip_bank_destination ON clubs;')
sql("CREATE FUNCTION test_corrupt_bank_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.accepted_payload_hash:=repeat('f',64); RETURN NEW; END$$; CREATE TRIGGER zz_test_corrupt_bank_receipt BEFORE INSERT ON ca_cash_bank_receipts FOR EACH ROW EXECUTE FUNCTION test_corrupt_bank_receipt();")
refused('Conflicting final source hash receipt rolls back actual credit and all public rows',
 bank(1000013),'receipt is missing or conflicts')
sql('DROP TRIGGER zz_test_corrupt_bank_receipt ON ca_cash_bank_receipts;')
sql(bank(1000013))
sql('UPDATE tables SET union_id=test_id(901),is_private=false WHERE id=test_id(950); SELECT test_owner(1000014);')
sql('CREATE TRIGGER zz_test_skip_bank_destination BEFORE UPDATE ON union_wallets FOR EACH ROW EXECUTE FUNCTION test_skip_bank_destination();')
refused('Zero-row Union destination write cannot be acknowledged as funded',
 bank(1000014),'destination credit did not apply')
sql('DROP TRIGGER zz_test_skip_bank_destination ON union_wallets;')
# Run the real durable dispatcher, which supplies the canonical accepted map.
for n in [1000001,1000010,1000011,1000012,1000013,1000014]:
 dispatcher=json.loads(sql(f'SELECT fn_ca_process_hand_post_commit_obligations(test_id({n}));'))
 print('Actual ordered dispatcher: '+str(n)+' '+json.dumps(dispatcher),flush=True)
 assert dispatcher.get('ok'),dispatcher
check('Actual durable post-commit dispatcher produces the canonical bank receipt',
 sql('SELECT count(*) FROM ca_cash_bank_receipts WHERE hand_id=test_id(1000014);')=='1')
before=state();sql('SELECT fn_ca_process_hand_post_commit_obligations(test_id(1000014));')
check('Actual durable dispatcher replay leaves every public row unchanged',state()==before)

# Nonzero BBJ retains gross spendable credit separately from club accumulator net.
owner_sql=(p.parent/'owner-composition/exercise.sql').read_text()
owner_sql=owner_sql[owner_sql.index('CREATE FUNCTION public.test_owner('):owner_sql.index("SELECT (test_owner(")]
owner_sql=owner_sql.replace('public.test_owner(', 'public.test_owner_bbj(').replace(",2,0,'native-source:'",",2,1,'native-source:'")
owner_sql=owner_sql.replace('THEN 98 ELSE -100','THEN 97 ELSE -100').replace("'bbj_amount',0","'bbj_amount',1").replace("'amount',198","'amount',197")
owner_sql=owner_sql.replace("'bbj_contribution',NULL","'bbj_contribution',jsonb_build_object('club_id',test_id(900),'amount',1,'big_blind',2)").replace("'bbj',0","'bbj',1")
sql(owner_sql+'SELECT test_owner_bbj(1000015);')
bbj_result=json.loads(sql(bank(1000015).replace(',2,0,200,2,',',2,1,200,2,')))
check('Actual accepted nonzero BBJ banks gross rake and retains separate net accumulator',
 bbj_result['spendable_amount']==2 and bbj_result['club_net_credit']==1 and
 sql('SELECT count(*) FROM ca_cash_bank_receipts WHERE hand_id=test_id(1000015) AND credited_amount=2 AND bbj_contribution=1 AND club_net_credit=1;')=='1')
# Actual cash service batch can accrue in this transaction, but a deferred final
# bank receipt failure must undo that whole batch with the bank and all public rows.
sql('SELECT test_owner(1000016);')
sql("CREATE FUNCTION test_fail_deferred_bank_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected deferred final bank receipt'; END$$; CREATE CONSTRAINT TRIGGER zzz_test_deferred_bank_failure AFTER INSERT ON ca_cash_bank_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_fail_deferred_bank_receipt();")
batch="SELECT fn_credit_agent_commissions_batch(jsonb_build_array(jsonb_build_object('user_id',test_id(201),'club_id',test_id(900),'rake_credit',1,'source_type','rake_settlement','source_id',test_id(1000016)),jsonb_build_object('user_id',test_id(202),'club_id',test_id(900),'rake_credit',1,'source_type','rake_settlement','source_id',test_id(1000016))));"
batch_assert="DO $batchproof$ DECLARE r jsonb; BEGIN r:="+batch.removeprefix('SELECT ').removesuffix(';')+"; IF (r->>'failed')::integer<>0 OR (SELECT count(*) FROM ca_commission_contributor_receipts WHERE source_id=test_id(1000016) AND state='applied')<>2 THEN RAISE EXCEPTION 'Actual batch did not accrue both contributors before deferred failure'; END IF; END $batchproof$;"
refused('Deferred final bank failure rolls back actual commission batch and every public row',
 'BEGIN;'+bank(1000016)+batch_assert+'COMMIT;','injected deferred final')
sql('DROP TRIGGER zzz_test_deferred_bank_failure ON ca_cash_bank_receipts;')
sql(bank(1000016))
batch_receipt=json.loads(sql(batch))
check('Actual cash service batch accrues exactly two immutable captured contributors after bank retry',
 batch_receipt.get('failed')==0 and batch_receipt.get('ok')==2 and
 sql('SELECT count(*) FROM ca_commission_contributor_receipts WHERE source_id=test_id(1000016) AND state=\'applied\';')=='2')
