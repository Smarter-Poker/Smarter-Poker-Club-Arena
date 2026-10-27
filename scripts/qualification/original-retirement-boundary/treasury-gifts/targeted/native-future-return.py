# Isolated synthetic EXIT for a seat the ACTUAL original producer already funded.
# No historical receipt is fabricated, and the new owner needs no return admission.
future_ledger='bbbbbbbb-0000-0000-0000-000000000001'
sql="""BEGIN;
INSERT INTO union_pnl_inventory_events(event_id,source_name,row_id,observed_at,transaction_id,operation,before_row,after_row)
SELECT nextval('native_event_id'),'table_seats',s.id,clock_timestamp(),pg_current_xact_id(),'UPDATE',to_jsonb(s),to_jsonb(s)||jsonb_build_object('left_at',clock_timestamp()) FROM table_seats s WHERE s.user_id=UID::uuid;
INSERT INTO chip_ledger(id,club_id,table_id,from_type,from_entity_id,to_type,to_entity_id,amount,category,idempotency_key,status,created_at,pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
VALUES(LEDGER::uuid,BENEFIT::uuid,TID::uuid,'table_stack',TID::uuid,'player_wallet',UID::uuid,200,'cashout','native-future-qualified-gift-cashout','posted',clock_timestamp(),200,0,0,200);
SELECT jsonb_build_object('valid',valid,'club',club_id,'user',user_id,'kind',kind,'amount',cashouts) FROM fn_union_pnl_original_flow_evidence(BENEFIT::uuid,now()-interval'1 day',now()+interval'1 day')WHERE ledger_id=LEDGER::uuid;
ROLLBACK;"""
for key,value in [('LEDGER',future_ledger),('BENEFIT',benefit),('TID',tid),('UID',uid)]:sql=sql.replace(key,lit(value))
r=json.loads(q(sql));assert r=={'valid':True,'club':benefit,'user':uid,'kind':'cash_return','amount':200},r
cases.append('actual_future_producer_receipt_exit_returns_to_beneficiary_without_return_admission_or_sponsor_relabel')
