#!/usr/bin/env python3
"""Native D8 probe called only inside an owned, verified D10 fixture cluster."""
from pathlib import Path
import hashlib, json, os, subprocess, sys
runtime=Path(sys.argv[1]);state=json.loads((runtime/'cluster.json').read_text())
assert state['cluster'].startswith('/tmp/ca-e2-owned-') and state['database']=='d10_c1f15c30'
root=Path(__file__).resolve().parents[2]
base=['/opt/homebrew/opt/postgresql@17/bin/psql','-X','-q','-v','ON_ERROR_STOP=1','-h',state['socket'],'-p',str(state['port']),'-U','postgres','-d',state['database']]
env={k:v for k,v in os.environ.items() if not k.startswith('PG') and k!='DATABASE_URL'}
def sql(q):
 r=subprocess.run(base+['-Atc',q],env=env,text=True,capture_output=True)
 if r.returncode:raise RuntimeError(r.stderr[-4000:])
 return r.stdout.strip()
def query(q):return json.loads(sql(q))
tid='c1f15c30-33c4-4a64-85ac-44037519ca5b'
migration=root/'supabase/migrations/20260911164014_audited_house_funded_makegood_authority.sql'
accepted_migration=Path(sys.argv[2]).resolve()
r=subprocess.run(base+['-f',str(accepted_migration)],env=env,text=True,capture_output=True)
assert r.returncode==0,r.stderr
for source in ['fn_collect_bounty.sql','fn_mystery_bounty_pay.sql']:
 r=subprocess.run(base+['-c','SET check_function_bodies=false;','-f',str(root/'tests/accounting/fixtures'/source)],env=env,text=True,capture_output=True)
 assert r.returncode==0,r.stderr
r=subprocess.run(base+['-f',str(migration)],env=env,text=True,capture_output=True)
assert r.returncode==0,r.stderr
before=query(f"SELECT jsonb_build_object('tournament',to_jsonb(t),'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e WHERE tournament_id=t.id),'obligations',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM public.tournament_obligations o WHERE tournament_id=t.id),'payouts',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.tournament_payouts p WHERE tournament_id=t.id),'terminal',(SELECT to_jsonb(r) FROM public.tournament_terminal_settlements r WHERE tournament_id=t.id)) FROM public.tournaments t WHERE id='{tid}'")
proof=query(f"SELECT jsonb_agg(jsonb_build_object('user_id',p.user_id,'receipts',ca_makegood.place_receipts('{tid}',p.user_id))) FROM public.tournament_payouts p WHERE tournament_id='{tid}'")
assert len(proof)==6 and all(len(p['receipts'])==1 and p['receipts'][0]['proof']=='historical_unique_transaction_tuple' for p in proof)
refusals=[]
sample=proof[0];paid=sample['receipts'][0];paid_user=sample['user_id']
# Negative fixture edits exist only in an owner transaction that is rolled back.
# Restore normal trigger execution before calling the actual evidence reader.
for name,edit,reason in [
 ('duplicate_historical_ledger',f"INSERT INTO public.chip_ledger SELECT (jsonb_populate_record(NULL::public.chip_ledger,to_jsonb(l)||jsonb_build_object('id',gen_random_uuid(),'chain_seq',NULL,'row_hash',NULL,'prev_hash',NULL))).* FROM public.chip_ledger l WHERE id='{paid['ledger_id']}'",'historical receiving-wallet leg is absent or ambiguous'),
 ('wrong_historical_direction',f"UPDATE public.chip_ledger SET from_type='club_treasury' WHERE id='{paid['ledger_id']}'",'historical receiving-wallet leg is absent or ambiguous'),
 ('wrong_historical_beneficiary',f"UPDATE public.chip_ledger SET to_entity_id='{proof[1]['user_id']}' WHERE id='{paid['ledger_id']}'",'historical receiving-wallet leg is absent or ambiguous'),
 ('wrong_historical_amount',f"UPDATE public.chip_ledger SET amount=amount+0.01 WHERE id='{paid['ledger_id']}'",'historical receiving-wallet leg is absent or ambiguous'),
 ('unclassified_payout_source',f"UPDATE public.tournament_payouts SET source='bounty' WHERE id='{paid['payout_id']}'",'ordinary place payment class is not exhaustively proven'),
 ('missing_historical_wallet_credit',f"DELETE FROM public.wallet_transactions WHERE id='{paid['wallet_transaction_id']}'",'ordinary place wallet evidence is not exhaustively classified'),
]:
 sql(f"""BEGIN; SET LOCAL session_replication_role=replica; {edit}; SET LOCAL session_replication_role=origin;
 DO $test$ BEGIN
   BEGIN PERFORM ca_makegood.place_receipts('{tid}','{paid_user}'); RAISE EXCEPTION 'unexpected evidence acceptance';
   EXCEPTION WHEN SQLSTATE 'P0404' THEN IF SQLERRM<>'{reason}' THEN RAISE; END IF; END;
 END $test$; ROLLBACK;""")
 refusals.append(name)
club=sql(f"SELECT club_id FROM public.tournaments WHERE id='{tid}'")
# Explicit native fixture allocation, never part of the production migration.
sql(f"BEGIN; SET LOCAL session_replication_role=replica; UPDATE public.clubs SET chip_treasury=1000 WHERE id='{club}'; INSERT INTO public.chip_ledger(id,performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,idempotency_key) VALUES('f1000000-0000-0000-0000-000000000001','2d1cd6c3-5700-4af9-a271-d4863fdab20d','union_bank','f2000000-0000-0000-0000-000000000001','club_treasury','{club}',1000,'union_settlement','{club}','fixture:d10:house-funding'); COMMIT;")
fund=sql("SET ROLE service_role; SELECT public.fn_ca_makegood_register_funding('f1000000-0000-0000-0000-000000000001',repeat('r',80))")
expected={'1c0dee1e-8ab9-4d42-897e-e1dd6da9f4be':42.16,'c6dc3bfa-d9dd-4174-9704-d4a0a285f876':30.35,'00000000-0000-0000-0000-000000000025':21.85,'2d6c5e7a-7352-4d1d-aecf-c5237d626e3d':15.73,'165df98e-f59d-46aa-bc74-a974c0ded83f':11.36}
target=next(iter(expected));winner=before['terminal']['winner_id']
entry=sql(f"SELECT id FROM public.tournament_players WHERE tournament_id='{tid}' AND user_id='{target}'")
baseline=query(f"SELECT ca_makegood.true_place('{entry}')")
new_hand='f3000000-0000-0000-0000-000000000001'
later_positive=f"""INSERT INTO public.settlement_idempotency_keys
 SELECT (jsonb_populate_record(NULL::public.settlement_idempotency_keys,to_jsonb(k)||
   jsonb_build_object('hand_id','{new_hand}','completed_at',k.completed_at+interval '1 second','result',
    k.result||jsonb_build_object('hand_id','{new_hand}','hand_number',999999990,'players',2,
     'request',(k.result->'request')||jsonb_build_object('stacks',jsonb_build_array(
      jsonb_build_object('user_id','{target}','stack_before',0,'stack',1),
      jsonb_build_object('user_id','{winner}','stack_before',10,'stack',9))),
     'written',jsonb_build_object('{target}',1,'{winner}',9))))).* FROM public.settlement_idempotency_keys k
 WHERE k.status='succeeded' ORDER BY k.completed_at DESC LIMIT 1"""
new_rebuy=f"""INSERT INTO public.chip_ledger SELECT (jsonb_populate_record(NULL::public.chip_ledger,to_jsonb(l)||
 jsonb_build_object('id',gen_random_uuid(),'chain_seq',NULL,'row_hash',NULL,'prev_hash',NULL,'idempotency_key',NULL,
 'from_type','player_wallet','from_entity_id','{target}','to_type','prize_liability','to_entity_id','{tid}',
 'amount',1,'category','rebuy','created_at',now()))).* FROM public.chip_ledger l WHERE id='{paid['ledger_id']}'"""
later_second_bust=later_positive.replace(new_hand,'f3000000-0000-0000-0000-000000000002').replace('999999990','999999991')
later_second_bust=later_second_bust.replace("'stack_before',0,'stack',1","'stack_before',1,'stack',0").replace("'stack_before',10,'stack',9","'stack_before',9,'stack',10").replace(f"'{target}',1,'{winner}',9",f"'{target}',0,'{winner}',10")
earlier_winner_zero=later_positive.replace(new_hand,'f3000000-0000-0000-0000-000000000003').replace("k.completed_at+interval '1 second'","k.completed_at-interval '1 second'")
earlier_winner_zero=earlier_winner_zero.replace("'stack_before',0,'stack',1","'stack_before',0,'stack',10").replace("'stack_before',10,'stack',9","'stack_before',10,'stack',0").replace(f"'{target}',1,'{winner}',9",f"'{target}',10,'{winner}',0")
equal_start_stacks="""UPDATE public.settlement_idempotency_keys k SET result=jsonb_set(result,'{request,stacks}',
 (SELECT jsonb_agg(CASE WHEN s->>'user_id' IN ('165df98e-f59d-46aa-bc74-a974c0ded83f','f39893fa-6830-49b6-9f80-b32191328ac0') THEN jsonb_set(s,'{stack_before}','42134')
  WHEN s->>'user_id'='00000000-0000-0000-0000-000000000025' THEN jsonb_set(s,'{stack_before}','104825') ELSE s END)
 FROM jsonb_array_elements(k.result#>'{request,stacks}') s)) WHERE k.result->>'hand_number'='8213440'"""
for name,edit,reason in [
 ('later_positive_accepted_stack',later_positive,'accepted bust is followed by positive play or has ambiguous hand ordering'),
 ('later_final_bust_cannot_hide_unproven_reentry',later_positive+';'+later_second_bust,'accepted bust is followed by positive play or has ambiguous hand ordering'),
 ('winner_revival_requires_generation_lineage',earlier_winner_zero,'accepted bust is followed by positive play or has ambiguous hand ordering'),
 ('equal_starting_stacks_cannot_choose_by_uuid',equal_start_stacks,'same-hand equal starting stacks require an authoritative tie allocation'),
 ('post_zero_entry',f"UPDATE public.tournament_players SET registered_at=now() WHERE id='{entry}'",'accepted final stack is followed by an entry or chip purchase'),
 ('post_zero_rebuy',new_rebuy,'accepted final stack is followed by an entry or chip purchase'),
 ('winner_post_finish_rebuy',new_rebuy.replace(f"'from_entity_id','{target}'",f"'from_entity_id','{winner}'"),'accepted final stack is followed by an entry or chip purchase'),
 ('false_conservation_marker',f"UPDATE public.settlement_idempotency_keys SET result=jsonb_set(result,'{{request,stacks,0,stack_before}}',to_jsonb((result#>>'{{request,stacks,0,stack_before}}')::numeric+1)) WHERE status='succeeded'",'accepted true-order source is malformed, foreign or ambiguous'),
 ('missing_final_survivor_hand',"DELETE FROM public.settlement_idempotency_keys WHERE status='succeeded' AND completed_at=(SELECT max(completed_at) FROM public.settlement_idempotency_keys WHERE status='succeeded')",'accepted true-order roster is incomplete'),
]:
 sql(f"""BEGIN; SET LOCAL session_replication_role=replica; {edit}; SET LOCAL session_replication_role=origin;
 DO $test$ BEGIN
   BEGIN PERFORM ca_makegood.true_place('{entry}'); RAISE EXCEPTION 'unexpected true order acceptance';
   EXCEPTION WHEN SQLSTATE 'P0404' THEN IF SQLERRM<>'{reason}' THEN RAISE; END IF; END;
 END $test$; ROLLBACK;""")
 refusals.append(name)
# A failed attempt containing positive-looking data is not an accepted stack.
sql(f"""BEGIN; SET LOCAL session_replication_role=replica; {later_positive};
 UPDATE public.settlement_idempotency_keys SET status='failed' WHERE hand_id='{new_hand}';
 SET LOCAL session_replication_role=origin;
 DO $test$ BEGIN IF ca_makegood.true_place('{entry}') IS DISTINCT FROM {"'"+json.dumps(baseline).replace("'","''")+"'"}::jsonb THEN RAISE EXCEPTION 'failed attempt influenced true order'; END IF; END $test$;
 ROLLBACK;""")
receipts=[]
for user,amount in expected.items():
 entry=sql(f"SELECT id FROM public.tournament_players WHERE tournament_id='{tid}' AND user_id='{user}'")
 item=query(f"SET ROLE service_role; SELECT public.fn_ca_makegood_propose('true_bust_place','{entry}','{fund}',{amount},repeat('r',80))")
 receipt=query(f"SET ROLE service_role; SELECT public.fn_ca_makegood_pay('{item['item_id']}')")
 assert receipt['amount']==amount and receipt['total_entitlement']==amount and receipt['ordinary_paid']==0
 assert query(f"SET ROLE service_role; SELECT public.fn_ca_makegood_pay('{item['item_id']}')")==receipt
 receipts.append(receipt)
after=query(f"SELECT jsonb_build_object('tournament',to_jsonb(t),'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e WHERE tournament_id=t.id),'obligations',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM public.tournament_obligations o WHERE tournament_id=t.id),'payouts',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.tournament_payouts p WHERE tournament_id=t.id),'terminal',(SELECT to_jsonb(r) FROM public.tournament_terminal_settlements r WHERE tournament_id=t.id)) FROM public.tournaments t WHERE id='{tid}'")
assert before==after,'D8 changed original terminal financial evidence'
assert sql('SELECT sum(amount) FROM ca_makegood.receipts')=='121.45'
assert sql(f"SELECT chip_treasury FROM public.clubs WHERE id='{club}'")=='878.55'
assert sql('SELECT count(*) FROM ca_makegood.authorizations')=='0'
result={'status':'passed','migration_sha256':hashlib.sha256(migration.read_bytes()).hexdigest(),'accepted_settlement_migration_sha256':hashlib.sha256(accepted_migration.read_bytes()).hexdigest(),'evidence_refusals':refusals,'failed_attempt_does_not_change_proof':True,'historical_receipts':proof,'five_true_place_receipts':receipts,'total':'121.45','original_paid':'180.00','original_terminal_financial_state_unchanged':True,'note':'Owned native fixture funding only; no production proposals or payments.'}
(runtime/'makegood-proof.json').write_text(json.dumps(result,indent=2)+'\n')
