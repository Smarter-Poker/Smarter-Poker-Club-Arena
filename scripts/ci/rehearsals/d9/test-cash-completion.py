"""Actual D9 cash completion with enabled guards, native replay and stale preview refusals."""
from pathlib import Path
import json,subprocess,time
b=Path(__file__).resolve().parent;state=json.loads((b/'cluster.json').read_text())
assert state['database']=='d9_legacy_completion' and state['cluster'].startswith('/tmp/ca-e2-owned-')
psql=['/opt/homebrew/opt/postgresql@17/bin/psql','-X','-q','-v','ON_ERROR_STOP=1','-h',state['socket'],'-p',str(state['port']),'-U','postgres','-d',state['database'],'-Atc']
def run(sql,expect_error=None):
 r=subprocess.run(psql+["SET TIMEZONE='UTC'; "+sql],text=True,capture_output=True)
 if expect_error:
  assert r.returncode and expect_error in r.stderr,r.stderr;return r.stderr
 if r.returncode:raise RuntimeError(r.stderr)
 lines=[s for s in r.stdout.splitlines() if s.startswith(('{','['))]
 return json.loads(lines[-1]) if lines else None
def literal(x):return "'"+json.dumps(x,separators=(',',':')).replace("'","''")+"'::jsonb"
names=['tournaments','tournament_players','tables','table_seats','settlement_idempotency_keys','tournament_knockout_candidates','hand_atomic_commits','tournament_escrow','tournament_payouts','tournament_obligations','chip_ledger','wallet_transactions','wallet_credit_idempotency','tournament_refund_entitlements','rake_records','tournament_place_settlement_batches','tournament_terminal_settlements','managed_game_contract_versions','club_members','union_wallets','club_wallets','tournament_finish_receipts','tournament_legacy_finish_evidence','spin_bonus_pools','spin_reserve_ledger']
def rows(t):return run(f"SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]'::jsonb) FROM public.{t} x")
def hashes():return {t:run(f"SELECT jsonb_build_object('rows',count(*),'hash',md5(COALESCE(string_agg(to_jsonb(x)::text,E'\\n' ORDER BY to_jsonb(x)::text),''))) FROM public.{t} x") for t in names}
original={t:rows(t) for t in names};before=hashes()
events=run('SELECT jsonb_agg(fn_ca_legacy_tournament_finish_witness(id) ORDER BY id) FROM tournaments')
eligible=[w for w in events if w['ok'] and w['recorded_winner_chips_match'] and w['financial_mode']!='satellite'];assert len(eligible)==21
refused=[w for w in events if not w['ok'] or not w.get('recorded_winner_chips_match')];assert len(refused)==4
case=next(w for w in eligible if w['tournament_id']=='2aa4cba1-506f-426b-a1ba-d8e22e018533');tid=case['tournament_id'];basis=case['basis_sha256'];src=case['standings'][0]['source_receipt'];where=f"table_id='{src['table_id']}' AND hand_id='{src['hand_id']}'"
negative={}
call=lambda event,sha:f"SELECT fn_ca_complete_legacy_tournament('{event}','{sha}');"
negative['stale_valid_source_byte']=run(f"BEGIN; UPDATE settlement_idempotency_keys SET last_attempt_at=last_attempt_at+interval '1 second' WHERE {where}; "+call(tid,basis)+'COMMIT;','preview changed')
negative['stale_invalid_source']=run(f"BEGIN; UPDATE settlement_idempotency_keys SET error='hostile mutation' WHERE {where}; "+call(tid,basis)+'COMMIT;','preview changed')
negative['wrong_expected_basis']=run(call(tid,'0'*64),'preview changed')
for w in refused:
 negative['refused_'+w['tournament_id']]=run(call(w['tournament_id'],w.get('basis_sha256','0'*64)),'current proof refused')
seal=f"INSERT INTO tournament_legacy_finish_evidence(tournament_id,basis_sha256,witness,source_receipts,tournament_before) SELECT id,'{basis}',fn_ca_legacy_tournament_finish_witness(id),fn_ca_legacy_finish_source_rows(id),to_jsonb(t) FROM tournaments t WHERE id='{tid}';"
negative['standalone_seal_cannot_commit']=run('BEGIN; '+seal+' COMMIT;','must commit with its fully certified ordinary finish')
negative['partial_historical_status_repair_cannot_commit']=run('BEGIN; '+seal+f" UPDATE tournaments SET status='RUNNING' WHERE id='{tid}'; COMMIT;",'must commit with its fully certified ordinary finish')
negative['no_seal_cannot_reopen']=run(f"UPDATE tournaments SET status='RUNNING' WHERE id='{tid}';",'TOURNAMENT_LAUNCH_RECEIPT_REQUIRED')
for w in events:
 if w['ok'] and w['financial_mode']=='satellite':negative['satellite_'+w['tournament_id']]=run(call(w['tournament_id'],w['basis_sha256']),'original economics and entry close are not proven')
negative['forged_caller_rankings']=run('BEGIN; '+seal.replace('fn_ca_legacy_tournament_finish_witness(id)',"jsonb_set(fn_ca_legacy_tournament_finish_witness(id),'{observed_winner_user_id}',to_jsonb('00000000-0000-0000-0000-000000000001'::text))")+' COMMIT;','source seal refused')
assert hashes()==before
# The real authority waits on a competing source writer, then observes the
# committed mutation and refuses the stale preview before any finish/payment.
writer=subprocess.Popen(psql+["SET application_name='d9_source_race_writer'; BEGIN; UPDATE settlement_idempotency_keys SET last_attempt_at=last_attempt_at+interval '1 second' WHERE "+where+"; SELECT pg_sleep(2); COMMIT;"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
for _ in range(100):
 active=run("SELECT jsonb_build_object('waiting',EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='d9_source_race_writer' AND wait_event='PgSleep'))")
 if active['waiting']:break
 time.sleep(.02)
else:raise AssertionError('source race writer did not hold the observed row')
started=time.monotonic();negative['concurrent_source_change_refuses_stale_preview']=run(call(tid,basis),'preview changed');elapsed=time.monotonic()-started
writer.communicate(timeout=5);assert writer.returncode==0 and elapsed>.2,elapsed
run(f"UPDATE settlement_idempotency_keys SET last_attempt_at='{src['last_attempt_at']}' WHERE {where};")
assert hashes()==before
receipts=[];failures=[]
for w in eligible:
 try:
  r=run(call(w['tournament_id'],w['basis_sha256']));assert r['ok'] and r['status']=='COMPLETED';receipts.append(r)
 except Exception as e:failures.append({'tournament_id':w['tournament_id'],'error':str(e)})
(b/'cash-completion-interim.json').write_text(json.dumps({'receipts':receipts,'failures':failures},indent=2)+'\n')
assert not failures,failures
completed=hashes()
for w in eligible:
 replay=run(call(w['tournament_id'],w['basis_sha256']));assert replay==next(r for r in receipts if r['tournament_id']==w['tournament_id'])
assert hashes()==completed
# Historical money/custody facts may receive only the existing terminal marker.
for table in ['chip_ledger','wallet_transactions','tournament_refund_entitlements','rake_records']:
 after={r['id']:r for r in rows(table)}
 for prior in original[table]:
  current=after[prior['id']]
  assert {k:v for k,v in prior.items() if k!='terminal_closed_at'}=={k:v for k,v in current.items() if k!='terminal_closed_at'},(table,prior['id'])
assert original['settlement_idempotency_keys']==rows('settlement_idempotency_keys')
oldplayers={p['id']:p for p in original['tournament_players']}
for p in rows('tournament_players'):
 assert p['elimination_sequence'] is None
 assert p['chips']==oldplayers[p['id']]['chips']
 if oldplayers[p['id']]['status']=='eliminated':assert p['eliminated_at']==oldplayers[p['id']]['eliminated_at']
# Every excluded event remains byte-identical across its scoped lifecycle rows.
excluded={w['tournament_id'] for w in events}- {w['tournament_id'] for w in eligible}
for table,key in [('tournaments','id'),('tournament_players','tournament_id'),('tables','tournament_id')]:
 assert [r for r in original[table] if r[key] in excluded]==[r for r in rows(table) if r[key] in excluded],table
negative['sealed_source_delete']=run(f"BEGIN; DELETE FROM tournament_legacy_finish_evidence WHERE tournament_id='{tid}'; COMMIT;",'append-only')
negative['sealed_source_update']=run(f"BEGIN; UPDATE tournament_legacy_finish_evidence SET basis_sha256=repeat('0',64) WHERE tournament_id='{tid}'; COMMIT;",'append-only')
negative['post_seal_source_mutation_refused']=run(f"BEGIN; UPDATE settlement_idempotency_keys SET last_attempt_at=last_attempt_at+interval '1 second' WHERE {where}; "+call(tid,basis)+'COMMIT;','source or roster changed')
negative['numeric_representation_source_digest_changes']=run(f"BEGIN; UPDATE settlement_idempotency_keys SET result=jsonb_set(result,'{{rake}}','0.00'::jsonb) WHERE {where}; "+call(tid,basis)+'COMMIT;','source or roster changed')
negative['sealed_source_truncate']=run('BEGIN; TRUNCATE tournament_legacy_finish_evidence; COMMIT;','append-only')
assert hashes()==completed
guards=run("SELECT jsonb_object_agg(tgname,tgenabled) FROM pg_trigger WHERE tgrelid='tournaments'::regclass AND tgname IN ('aa_guard_tournament_completing_claim','aaa_guard_atomic_satellite_completion','zzzz_freeze_finalized_tournament_prize_pool','zzzz_tournament_pool_finalization_window_guard','zzzz_tournaments_atomic_place_completion_guard','zzzzz_tournaments_atomic_final_table_deal_completion_guard','zzzzzz_tournaments_financial_certificate')")
assert len(guards)==7 and set(guards.values())=={'O'}
metadata=run("SELECT jsonb_agg(jsonb_build_object('function',p.oid::regprocedure::text,'owner',pg_get_userbyid(proowner),'acl',proacl::text,'config',proconfig,'securityDefiner',prosecdef,'body_md5',md5(prosrc))) FROM pg_proc p WHERE proname LIKE 'fn_ca_%legacy%' OR p.oid IN ('fn_settle_tournament_places(uuid,uuid)'::regprocedure,'fn_ca_verify_terminal_place_batch(uuid,boolean)'::regprocedure,'fn_refuse_new_entries_while_frozen()'::regprocedure)")
for role in ['anon','authenticated','service_role']:
 acl=run(f"SELECT jsonb_build_object('execute',has_function_privilege('{role}','fn_ca_complete_legacy_tournament(uuid,text)','EXECUTE'),'insert',has_table_privilege('{role}','tournament_legacy_finish_evidence','INSERT'))")
 assert not any(acl.values())
receipt={'guards':guards,'functionMetadata':metadata,'sourceRaceWaitSeconds':elapsed,'eligibleCashEvents':21,'completed':len(receipts),'originalCohortCount':28,'satellitesOutstanding':3,'revivalRefusals':3,'chipMismatchRefusals':1,'negativeTests':negative,'receipts':receipts,'beforeHashes':before,'completedHashes':completed,'replayHashes':hashes(),'replayExactlyEqual':True,'sourceRowsAndHistoricalAmountsUnchanged':True,'sequenceWrites':0,'productionWrites':0}
(b/'cash-completion-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'completed':len(receipts),'negativeTests':len(negative),'payoutTotal':sum(r['cash_payout_total'] for r in receipts),'rakeTotal':sum(r['rake']['amount'] for r in receipts),'replayExact':True}))
