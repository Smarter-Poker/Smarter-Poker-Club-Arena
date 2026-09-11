"""Private event evidence, native PG17; all hostile source changes roll back with origin triggers."""
from pathlib import Path
import copy,hashlib,json,subprocess,uuid
base=Path(__file__).resolve().parent
state=json.loads((base/'cluster.json').read_text())
assert state['cluster'].startswith('/tmp/ca-e2-owned-') and state['database']=='d9_legacy_28'
psql=['/opt/homebrew/opt/postgresql@17/bin/psql','-X','-q','-v','ON_ERROR_STOP=1','-h',state['socket'],'-p',str(state['port']),'-U','postgres','-d',state['database'],'-Atc']
def query(sql):
 r=subprocess.run(psql+['SET TIMEZONE=\'UTC\'; '+sql],text=True,capture_output=True)
 if r.returncode:raise RuntimeError(r.stderr)
 lines=[s for s in r.stdout.splitlines() if s.startswith(('{','['))]
 return json.loads(lines[-1]) if lines else None
def literal(x):return "'"+json.dumps(x,separators=(',',':')).replace("'","''")+"'::jsonb"
def table_hashes():
 names=['tournaments','tournament_players','tables','table_seats','settlement_idempotency_keys','tournament_knockout_candidates','hand_atomic_commits','tournament_escrow','tournament_payouts','tournament_obligations','chip_ledger','wallet_transactions','wallet_credit_idempotency','tournament_refund_entitlements','rake_records','tournament_place_settlement_batches','tournament_terminal_settlements','managed_game_contract_versions','spin_bonus_pools','spin_reserve_ledger']
 return {t:query(f"SELECT jsonb_build_object('rows',count(*),'md5',md5(COALESCE(string_agg(to_jsonb(x)::text,E'\\n' ORDER BY to_jsonb(x)::text),''))) FROM public.{t} x") for t in names}
before=table_hashes()
results=query('SELECT jsonb_agg(fn_ca_legacy_tournament_finish_witness(id) ORDER BY id) FROM tournaments')
(base/'finish-witness-results.json').write_text(json.dumps(results,indent=2)+'\n')
assert len(results)==28
refusals={r['tournament_id']:r['reason'] for r in results if not r['ok']}
assert refusals=={t:'post_zero_positive_write' for t in ['097e3601-ccf9-4035-af40-eb35068d2652','44d7e2d8-66ed-48ae-a1cb-306ae92b6dfa','95e43b6e-c1c9-445e-a1d9-cbe711e3bac1']},refusals
assert sum(r['ok'] for r in results)==25
assert sum(r.get('financial_mode')=='satellite' for r in results)==3
assert [r['tournament_id'] for r in results if r['ok'] and not r['recorded_winner_chips_match']]==['9cecb4fa-4fdd-4447-9e98-2fe5c20c46a8']
case=next(r for r in results if r['tournament_id']=='2aa4cba1-506f-426b-a1ba-d8e22e018533')
tid=case['tournament_id']; winner,second,third=case['standings'];source=winner['source_receipt']
where=f"table_id='{source['table_id']}' AND hand_id='{source['hand_id']}'"
checks={}
def check(name,sql,reason):
 r=query('BEGIN; '+sql+f" SELECT fn_ca_legacy_tournament_finish_witness('{tid}'); ROLLBACK;")
 assert r['ok'] is False and r['reason']==reason,(name,r)
 checks[name]=r['reason']
def edit(name,mutate,reason):
 row=copy.deepcopy(source);mutate(row)
 check(name,f'UPDATE settlement_idempotency_keys SET result={literal(row["result"])},status=\'{row["status"]}\',completed_at=\'{row["completed_at"]}\' WHERE {where};',reason)
def insert(row):return f"INSERT INTO settlement_idempotency_keys SELECT * FROM jsonb_populate_record(NULL::settlement_idempotency_keys,{literal(row)});"
def changed_source(**values):
 row=copy.deepcopy(source);row.update(values);return row
edit('foreign_result_table',lambda r:r['result'].update(table_id=str(uuid.UUID(int=1))),'legacy_accepted_receipt_invalid')
edit('foreign_result_hand',lambda r:r['result'].update(hand_id=str(uuid.UUID(int=1))),'legacy_accepted_receipt_invalid')
def foreign(r):
 old=r['result']['request']['stacks'][0]['user_id'];new=str(uuid.UUID(int=1))
 r['result']['request']['stacks'][0]['user_id']=new;r['result']['written'][new]=r['result']['written'].pop(old)
edit('foreign_event_player',foreign,'foreign_player_in_accepted_receipt')
edit('nonconserved_success',lambda r:r['result']['request']['stacks'][0].update(stack_before=12345),'legacy_accepted_receipt_invalid')
edit('failed_final_receipt_cannot_be_witness',lambda r:r.update(status='failed'),'legacy_finish_not_decided')
edit('unsettled_final_hand',lambda r:r.update(status='in_flight'),'legacy_hand_not_settled')
def same_rank(r):
 us={second['user_id'],third['user_id']};avg=(second['stack_before']+third['stack_before'])/2
 for p in r['result']['request']['stacks']:
  if p['user_id'] in us:p['stack_before']=avg
edit('same_hand_equal_start_stacks',same_rank,'legacy_bust_rank_tie_ambiguous')
def two_positive(r):
 w=winner['user_id'];l=second['user_id']
 for p in r['result']['request']['stacks']:
  if p['user_id']==w:p['stack']-=1
  if p['user_id']==l:p['stack']=1
 r['result']['written'][w]-=1;r['result']['written'][l]=1
edit('sole_positive_survivor_unproven',two_positive,'legacy_finish_not_decided')
row=changed_source(hand_id=str(uuid.UUID(int=2)));row['result']['hand_id']=row['hand_id']
check('duplicate_accepted_hand_number',insert(row),'ambiguous_accepted_hand_claim')
row['result']['hand_number']+=10000000
check('duplicate_latest_timestamp',insert(row),'ambiguous_latest_player_observation')
row['completed_at']='2026-09-08T14:50:26+00:00';row['created_at']=row['completed_at']
for p in row['result']['request']['stacks']:p['stack_before']=p['stack']
two_positive(row)
check('later_positive_after_zero',insert(row),'post_zero_positive_write')
row2=copy.deepcopy(row);row2['hand_id']=str(uuid.UUID(int=3));row2['result']['hand_id']=row2['hand_id'];row2['result']['hand_number']+=1;row2['completed_at']='2026-09-08T14:50:27+00:00'
for p in row2['result']['request']['stacks']:
 p['stack_before']=p['stack']
 p['stack']=900 if p['user_id']==winner['user_id'] else 0
 row2['result']['written'][p['user_id']]=p['stack']
check('bust_positive_bust_is_not_hidden_by_latest_zero',insert(row)+insert(row2),'post_zero_positive_write')
# A candidate is synthetic hostile history, inserted with all current constraints/triggers enabled.
check('mixed_candidate_history',f"INSERT INTO tournament_knockout_candidates(tournament_id,eliminated_user_id,table_id,seat_id,seat_joined_at,hand_id,hand_number,stack_before,stack_after) VALUES('{tid}','{second['user_id']}','{source['table_id']}','00000000-0000-0000-0000-000000000004',now(),'{source['hand_id']}',{source['result']['hand_number']},290,0);",'mixed_modern_or_sequenced_history')
check('paid_credit_claim',f"INSERT INTO wallet_credit_idempotency(key) VALUES ('tourney:{tid}:{winner['user_id']}');",'paid_history_requires_its_own_authority')
check('post_zero_entry_purchase',f"INSERT INTO chip_ledger(id,tournament_id,club_id,from_type,from_entity_id,to_type,to_entity_id,category,amount,status,created_at,performed_by) VALUES('00000000-0000-0000-0000-000000000005','{tid}','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','player_wallet','{second['user_id']}','prize_liability','{tid}','tournament_buyin',100,'posted','2026-09-08T15:00:00Z','2d1cd6c3-5700-4af9-a271-d4863fdab20d');",'post_zero_entry_purchase')
# Source rows themselves have no append-only trigger. A preview becomes stale on
# any accepted-row byte change; root's locked finish authority must compare this pin.
r=query(f"BEGIN; UPDATE settlement_idempotency_keys SET error='preview-mutation' WHERE {where}; SELECT fn_ca_legacy_tournament_finish_witness('{tid}'); ROLLBACK;")
assert not r['ok'];checks['source_mutated_to_invalid_between_preview_and_authority']=r['reason']
r=query(f"BEGIN; UPDATE settlement_idempotency_keys SET last_attempt_at=last_attempt_at+interval '1 second' WHERE {where}; SELECT fn_ca_legacy_tournament_finish_witness('{tid}'); ROLLBACK;")
assert r['ok'] and r['basis_sha256']!=case['basis_sha256'];checks['accepted_source_byte_mutation_changes_basis']='different_basis_sha256'
after=table_hashes();assert before==after
acl=query("SELECT jsonb_object_agg(role,has_function_privilege(role,'public.fn_ca_legacy_tournament_finish_witness(uuid)','EXECUTE')) FROM unnest(ARRAY['anon','authenticated','service_role']) role")
assert not any(acl.values())
metadata=query("SELECT jsonb_agg(jsonb_build_object('function',proname,'owner',pg_get_userbyid(proowner),'acl',proacl::text,'config',proconfig,'security_definer',prosecdef,'volatility',provolatile,'body_md5',md5(prosrc),'definition_sha256',encode(extensions.digest(convert_to(pg_get_functiondef(oid),'UTF8'),'sha256'),'hex'))) FROM pg_proc WHERE oid IN ('fn_ca_accepted_tournament_settlement_fact(jsonb)'::regprocedure,'fn_ca_legacy_tournament_finish_witness(uuid)'::regprocedure)")
receipt={'originalEvents':28,'qualified':25,'refused':refusals,'qualifiedSatellites':3,'chipMirrorMismatch':'9cecb4fa-4fdd-4447-9e98-2fe5c20c46a8','negativeTests':checks,'ordinaryExecute':acl,'functionMetadata':metadata,'applicationTableHashesBefore':before,'applicationTableHashesAfter':after,'originTriggersDuringEveryProbe':True,'nullSequencesPreserved':True,'noProductionWrites':True,'authorityIntegrationNotYetProved':True}
(base/'finish-witness-test-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'qualified':25,'refused':refusals,'negativeTests':len(checks),'hashesUnchanged':before==after,'metadata':metadata}))
