#!/usr/bin/env python3
"""Execute the exact installed unfreeze and guarded incident recovery on PostgreSQL.

Disposable tables represent the observed incident. Full production unfreeze,
exposure and pool-stack functions run unchanged. Full preventive functions are installed through the actual preventive migration;
their departure behavior is additionally qualified by the sibling native test.
No production connection or production write is made.
"""
import argparse, json, os, pathlib, shutil, subprocess, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--migration',type=pathlib.Path)
p.add_argument('--output',type=pathlib.Path,default=ROOT/'artifacts/lightning-void-recovery')
a=p.parse_args(); a.output.mkdir(parents=True,exist_ok=True)
paths=list((ROOT/'supabase/migrations').glob('20261027145103*.sql'))
migration=a.migration or (paths[0] if len(paths)==1 else None)
if migration is None: raise RuntimeError('exact recovery migration required')
pg=pathlib.Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'))
cluster=pathlib.Path(tempfile.mkdtemp(prefix='lvr-')); sock=cluster/'s';sock.mkdir()
owner=['runuser','-u','postgres','--'] if os.geteuid()==0 else []
if owner: shutil.chown(cluster,'postgres');shutil.chown(sock,'postgres')
env=dict(os.environ,LC_ALL='C',LANG='C'); checks=[];started=False
psql=[pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-p','55851','-U','postgres','-d','postgres']
def cmd(args,sql=None,fail=False):
 r=subprocess.run(list(map(str,args)),input=sql,text=True,capture_output=True,env=env,timeout=60)
 if (r.returncode!=0)!=fail: raise RuntimeError(r.stdout+r.stderr)
 return (r.stdout+r.stderr).strip()
def q(sql,fail=False):return cmd(psql,sql,fail)
def check(name,yes):
 checks.append({'name':name,'passed':bool(yes)})
 if not yes:raise AssertionError(name)
G='705270cd-03c2-40d9-8749-038f741a295c';H='6ac38507-6ac1-412b-8b2d-54ab63ef1437';I='e217b11a-98bd-47d4-bc7e-abcecbf23b18';A='b5b9b1e5-2970-440e-a193-0b2e6f473cb8'
U='ec174028-bacb-4d30-b577-fc9243c574f7'; V='00000000-0000-4000-8000-000000000004'; M='00000000-0000-4000-8000-000000000005'; Q='00000000-0000-4000-8000-000000000006';T='00000000-0000-4000-8000-000000000001';S='00000000-0000-4000-8000-000000000002';P='00000000-0000-4000-8000-000000000003'
def reset():
 q(f"""TRUNCATE cash_games,financial_alerts,cash_cluster_events,tables,table_seats,lightning_instance,lightning_hand,hand_history,lightning_pool_session,lightning_pool_slot,cash_cluster_conversion,lightning_hand_player,wallets;
 INSERT INTO cash_games VALUES('{G}','frozen',3,now(),now());
 INSERT INTO financial_alerts(id,resolved,source,context) VALUES('{A}',false,'lightning_settlement','{{"hand_id":"{H}","invariant":"anchor_not_live","cluster_id":"{G}"}}');
 INSERT INTO tables VALUES('{T}','{G}',now(),'lightning',now());
 INSERT INTO table_seats VALUES('{S}','{T}','{V}',NULL,160.52);
 INSERT INTO wallets VALUES('{U}',1234.56);
 INSERT INTO lightning_instance VALUES('{I}','{H}','{G}','abandoned',now()-interval '1 hour',now(),'reaped: the hand is void');
 INSERT INTO lightning_hand VALUES('{H}','{G}','{I}',NULL,NULL,NULL,NULL);
 INSERT INTO lightning_pool_session VALUES('{P}','{G}',3,'{V}','{S}','active',now()-interval '1 hour',NULL,NULL,NULL,now());
 INSERT INTO lightning_pool_session VALUES('{Q}','{G}',3,'{U}','{M}','closed',now()-interval '2 hours',now()-interval '1 hour','stop_playing',160.52,now());
 INSERT INTO lightning_pool_slot VALUES('{P}','{G}',now()-interval '1 hour',NULL,NULL,now());
 INSERT INTO cash_cluster_conversion VALUES('{G}','pending',NULL,NULL);
 INSERT INTO lightning_hand_player VALUES('{H}','{U}',1,160.52,now(),'normal');""")
def money():return q("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM table_seats s),(SELECT jsonb_agg(to_jsonb(w) ORDER BY user_id) FROM wallets w),(SELECT jsonb_agg(to_jsonb(h) ORDER BY hand_id) FROM lightning_hand h),(SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM hand_history h),(SELECT jsonb_agg(to_jsonb(h) ORDER BY hand_id) FROM lightning_hand_player h))")
def authority():return q("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM cash_games g),(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM financial_alerts a),(SELECT count(*) FROM cash_cluster_events),(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM lightning_pool_session p))")
try:
 cmd(owner+[pg/'initdb','-D',cluster/'d','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 cmd(owner+[pg/'pg_ctl','-D',cluster/'d','-l',cluster/'log','-o',f"-k {sock} -p 55851 -c listen_addresses='' -c shared_buffers=16MB",'-w','start']);started=True
 q('''CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; SET check_function_bodies=off; CREATE TABLE cash_games(id uuid PRIMARY KEY,cluster_mode text,cluster_epoch integer,lightning_off_condition_since timestamptz,updated_at timestamptz);
 CREATE TABLE financial_alerts(id uuid PRIMARY KEY,resolved boolean,source text,context jsonb,resolved_at timestamptz,resolved_by uuid,resolution text);
 CREATE TABLE cash_cluster_events(game_id uuid,table_id uuid,kind text,payload jsonb,cluster_epoch integer,at timestamptz DEFAULT clock_timestamp());
 CREATE TABLE tables(id uuid PRIMARY KEY,cluster_id uuid,dealing_halted_at timestamptz,dealing_halted_reason text,dealing_halt_observed_at timestamptz);
 CREATE TABLE table_seats(id uuid PRIMARY KEY,table_id uuid,user_id uuid,left_at timestamptz,stack numeric);
 CREATE TABLE wallets(user_id uuid PRIMARY KEY,balance numeric);
 CREATE TABLE lightning_instance(id uuid PRIMARY KEY,hand_id uuid,cluster_id uuid,state text,started_at timestamptz,completed_at timestamptz,abandon_reason text);
 CREATE TABLE lightning_hand(hand_id uuid PRIMARY KEY,cluster_id uuid,lightning_instance_id uuid,settled_at timestamptz,settle_receipt jsonb,hand_history_id uuid,settle_request_id uuid);
 CREATE TABLE hand_history(id uuid PRIMARY KEY);
 CREATE TABLE lightning_pool_session(id uuid PRIMARY KEY,cluster_id uuid,cluster_epoch integer,player_id uuid,anchor_seat_id uuid,state text,entered_at timestamptz,exited_at timestamptz,exit_reason text,ending_stack numeric,updated_at timestamptz);
 CREATE TABLE lightning_pool_slot(pool_session_id uuid,cluster_id uuid,opened_at timestamptz,closed_at timestamptz,close_reason text,updated_at timestamptz);
 CREATE TABLE cash_cluster_conversion(cluster_id uuid,status text,abort_reason text,closed_at timestamptz);
 CREATE TABLE lightning_hand_player(hand_id uuid,player_id uuid,committed_at_fold numeric,stack_before numeric,folded_at timestamptz,fold_type text);
''')
 for d in json.loads((ROOT/'scripts/ci/fixtures/lightning-unsettled-anchor-preimages.json').read_text()):
  q('SET check_function_bodies=off;'+d['definition'])
 prevention=list((ROOT/'supabase/migrations').glob('*_lightning_retains_the_anchor_until_every_original_hand_is_te*.sql'))
 if len(prevention)!=1:raise RuntimeError('one exact prevention migration required')
 q('SET check_function_bodies=off;'+prevention[0].read_text())
 unfreeze=(ROOT/'scripts/ci/fixtures/lightning-void-recovery-unfreeze.sql').read_text();q(unfreeze)
 check('exact-installed-unfreeze-preimage',q("SELECT md5(pg_get_functiondef('fn_cash_cluster_unfreeze(uuid,uuid,text)'::regprocedure))")=='00dd3144409c27951431893458bab580')
 sql=migration.read_text();reset();before=money();q(sql)
 check('exact-incident-recovers-epoch-three-to-four',q("SELECT cluster_mode='must_move' AND cluster_epoch=4 AND lightning_off_condition_since IS NULL FROM cash_games")=='t')
 check('no-seat-stack-wallet-hand-or-contribution-change',money()==before)
 check('alert-resolution-and-single-recovery-event',q("SELECT (SELECT resolved AND resolution LIKE '%20261027145103%' FROM financial_alerts) AND (SELECT count(*)=1 FROM cash_cluster_events WHERE kind='cluster_unfrozen')")=='t')
 check('old-sessions-slots-conversion-halts-retired',q("SELECT (SELECT bool_and(state='closed' AND exited_at IS NOT NULL) FROM lightning_pool_session) AND (SELECT bool_and(closed_at IS NOT NULL) FROM lightning_pool_slot) AND (SELECT bool_and(status='aborted') FROM cash_cluster_conversion) AND (SELECT bool_and(dealing_halted_at IS NULL AND dealing_halt_observed_at IS NULL) FROM tables)")=='t')
 snapshot=authority();q(sql);check('replay-is-idempotent-without-new-recovery',authority()==snapshot and money()==before)
 for name,change,expected in [
  ('wrong-incident',"UPDATE financial_alerts SET context=context||'{\"invariant\":\"other\"}'",'exact frozen incident changed'),
  ('accepted-hand',f"INSERT INTO hand_history VALUES('{H}')",'uncommitted void'),
  ('settlement-receipt',"UPDATE lightning_hand SET settle_receipt='{}'",'uncommitted void'),
  ('missing-preventive-fix',"DROP FUNCTION fn_lightning_stop_playing(uuid); CREATE FUNCTION fn_lightning_stop_playing(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT true$$",'correction is not installed')]:
  reset();q(change);before=money();snapshot=authority();err=q(sql,True)
  check(name+'-refuses-and-rolls-back',expected in err and money()==before and authority()==snapshot)
 print(json.dumps({'checks':checks,'production_mutations':False},indent=2))
finally:
 (a.output/'RESULTS.json').write_text(json.dumps({'checks':checks,'production_mutations':False},indent=2)+'\n')
 if started:cmd(owner+[pg/'pg_ctl','-D',cluster/'d','-m','immediate','-w','stop'])
 shutil.rmtree(cluster)
