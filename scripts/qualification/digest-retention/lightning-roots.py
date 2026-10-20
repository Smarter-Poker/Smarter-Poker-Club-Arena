"""Actual PostgreSQL function/lock regression; no production fixtures or money."""
import subprocess,time,re,json
from pathlib import Path

def qualify(root,pg,port,sql):
 here=Path(__file__).parent
 sql('''CREATE TABLE lightning_instance(id uuid PRIMARY KEY,state text);
 CREATE TABLE lightning_hand(hand_id uuid PRIMARY KEY,lightning_instance_id uuid,cluster_id uuid,cluster_epoch int);
 CREATE TABLE lightning_hand_player(hand_id uuid,player_id uuid,fold_type text,folded_at timestamptz,stack_before numeric,pool_slot_id uuid,committed_at_fold numeric,PRIMARY KEY(hand_id,player_id));
 CREATE TABLE lightning_reservation(lightning_instance_id uuid,player_id uuid,state text,resolved_at timestamptz,reason text);
 CREATE TABLE lightning_pool_session(id uuid,player_id uuid,cluster_id uuid,state text,disconnected_at timestamptz,exited_at timestamptz,updated_at timestamptz);
 CREATE TABLE cash_games(id uuid,cluster_mode text);
 CREATE TABLE cash_cluster_events(game_id uuid,kind text,payload jsonb,cluster_epoch int,request_id uuid);
 CREATE TABLE financial_alerts(id uuid,source text,context jsonb,resolved boolean);
 CREATE TABLE hand_atomic_commits(hand_id uuid,table_id uuid,hand_number bigint,post_commit_completed_at timestamptz,post_commit_request_hash text,post_commit_payload_hash text,post_commit_result jsonb);
 INSERT INTO lightning_instance VALUES('00000000-0000-0000-0000-000000000001','dealing');
 INSERT INTO lightning_hand VALUES('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003',1);
 INSERT INTO lightning_hand_player SELECT '00000000-0000-0000-0000-000000000002',lpad(i::text,32,'0')::uuid,NULL,NULL,10,NULL,NULL FROM generate_series(11,12)i;
 INSERT INTO lightning_reservation SELECT '00000000-0000-0000-0000-000000000001',player_id,'committed',NULL,NULL FROM lightning_hand_player;''')
 sql((here/'lightning-fold-before.sql').read_text())
 sql((here/'lightning-resolver-before.sql').read_text())
 cmd=[str(pg/'psql'),'-X','-q','-h','127.0.0.1','-p',port,'-d','postgres','-At','-v','ON_ERROR_STOP=1']
 def quiet_sql(statement):
  out=subprocess.run(cmd,input=statement,text=True,capture_output=True)
  if out.returncode:raise RuntimeError(out.stderr)
  return out.stdout.strip()
 sql=quiet_sql
 def fold(player,kind='normal'):
  return f"SELECT fn_lightning_fast_fold('00000000-0000-0000-0000-000000000002',lpad('{player}',32,'0')::uuid,lpad('{player}',32,'0')::uuid,'{kind}',1)"
 def contention(patched):
  sql('UPDATE lightning_hand_player SET folded_at=NULL,fold_type=NULL; UPDATE lightning_reservation SET state=\'committed\'; DELETE FROM cash_cluster_events;')
  blocker=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  blocker.stdin.write("SET application_name='lightning-root-blocker';BEGIN;SELECT player_id FROM lightning_hand_player WHERE player_id=lpad('11',32,'0')::uuid FOR UPDATE;SELECT pg_sleep(2);COMMIT;\n");blocker.stdin.close()
  for _ in range(150):
   if sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='lightning-root-blocker' AND wait_event='PgSleep'")=='1':break
   time.sleep(.01)
  else:raise AssertionError('player-lock fixture not established')
  first=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  first.stdin.write("SET application_name='lightning-root-folder';"+fold(11)+';\n');first.stdin.close()
  for _ in range(100):
   if sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='lightning-root-folder' AND wait_event_type='Lock'")=='1':break
   time.sleep(.01)
  else:raise AssertionError('first folder not awaiting player lock')
  start=time.monotonic()
  try:
   out=json.loads(sql("SET lock_timeout='250ms';"+fold(12)))
   assert patched and out['ok'] is True and out['released'] is True
   assert time.monotonic()-start<1
  except RuntimeError as e:
   assert not patched and 'lock timeout' in str(e),str(e)
  # A state-changing settlement/abandon remains excluded even after the fix.
  try:sql("SET lock_timeout='200ms';UPDATE lightning_instance SET state='completed'")
  except RuntimeError as e:assert 'lock timeout' in str(e)
  else:raise AssertionError('settlement crossed a pending fold')
  blocker.wait(timeout=10);first.wait(timeout=10)
  assert blocker.returncode==0 and first.returncode==0
  assert json.loads(sql(fold(11)))['replay'] is True
  assert json.loads(sql(fold(11,'fast')))['reason']=='already_folded'
  assert sql("SELECT count(*) FROM cash_cluster_events WHERE payload->>'player_id'=lpad('11',32,'0')::uuid::text")=='1'
  print('PASS:', 'independent player released under250ms; settlement excluded; duplicate exact-once' if patched else 'original whole-instance exclusive lock blocks an unrelated folder')
 contention(False)
 sql((root/'supabase/migrations/20261019172257_lightning_folds_share_state_custody_and_completed_envelopes_.sql').read_text())
 contention(True)
 sql("UPDATE lightning_instance SET state='completed'")
 sql("UPDATE lightning_hand_player SET folded_at=NULL,fold_type=NULL WHERE player_id=lpad('12',32,'0')::uuid")
 assert json.loads(sql(fold(12)))['reason']=='instance_not_dealing'
 try:sql((root/'supabase/migrations/20261019172257_lightning_folds_share_state_custody_and_completed_envelopes_.sql').read_text())
 except RuntimeError as e:assert 'preimage changed' in str(e)
 else:raise AssertionError('migration replay accepted')
 # Execute the actual unchanged CLASS3 selector from the installed full body.
 old=(here/'lightning-resolver-before.sql').read_text()
 new=sql("SELECT pg_get_functiondef('fn_resolve_settled_financial_alerts(boolean,integer)'::regprocedure)")
 def selector(body):
  return re.search(r'SELECT a.id\s+FROM public.financial_alerts a\s+JOIN public.hand_atomic_commits c.*?LIMIT p_limit',body,re.S)[0].replace('p_limit','5000')
 sql("""INSERT INTO hand_atomic_commits SELECT lpad('21',32,'0')::uuid,lpad('22',32,'0')::uuid,101,now(),repeat('a',64),repeat('b',64),jsonb_build_object('ok',true,'hand_id',lpad('21',32,'0')::uuid,'hand_number',101);
 INSERT INTO financial_alerts SELECT lpad(i::text,32,'0')::uuid,'LightningHandHost.post_commit_obligations_pending',jsonb_build_object('hand_id',lpad('21',32,'0')::uuid,'table_id',lpad('22',32,'0')::uuid,'hand_number',101),false FROM generate_series(31,34)i;
 UPDATE financial_alerts SET context=jsonb_set(context,'{table_id}',to_jsonb(lpad('23',32,'0')::uuid)) WHERE id=lpad('32',32,'0')::uuid;
 UPDATE financial_alerts SET context=jsonb_set(context,'{hand_number}','102') WHERE id=lpad('33',32,'0')::uuid;
 UPDATE financial_alerts SET context=jsonb_set(context,'{hand_id}',to_jsonb(lpad('24',32,'0')::uuid)) WHERE id=lpad('34',32,'0')::uuid;""")
 assert sql(selector(old))==''
 assert sql(selector(new))=='00000000-0000-0000-0000-000000000031'
 for change in ["post_commit_completed_at=NULL","post_commit_request_hash='bad'","post_commit_result=jsonb_build_object('ok',true,'hand_id',lpad('24',32,'0')::uuid,'hand_number',101)"]:
  assert sql('BEGIN;UPDATE hand_atomic_commits SET '+change+';'+selector(new)+';ROLLBACK;')==''
 print('PASS: actual alert selector sees exact Lightning completion; wrong hand/table/number, incomplete and malformed receipts remain open')
 print(sql("SELECT json_build_object('fold',md5(pg_get_functiondef('fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric)'::regprocedure)),'resolver',md5(pg_get_functiondef('fn_resolve_settled_financial_alerts(boolean,integer)'::regprocedure)))"))
 import runpy
 runpy.run_path(str(here/'keepalive-roots.py'))['qualify'](root,pg,port,sql)
