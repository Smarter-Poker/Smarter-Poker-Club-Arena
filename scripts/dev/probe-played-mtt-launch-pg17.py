#!/usr/bin/env python3
"""Existing launch authorities on a synthetic already-played MTT.

No production URL; real captured proof/begin/complete and receipt immutability.
Synthetic field and tables; maintenance is a fixture boolean and the excluded
paid-Spin proof is explicitly a refusal stand-in. Not full money/gameplay/RLS.
"""
from pathlib import Path
import json, os, shutil, subprocess, tempfile, hashlib
repo=Path(__file__).resolve().parents[2]
capture=json.loads((repo/'scripts/dev/fixtures/played-mtt-launch/installed.json').read_text())
migration=next((repo/'supabase/migrations').glob('*_engine_can_read_played_tournament_launch_proof.sql'))
authority_capture=json.loads((repo/'scripts/dev/fixtures/played-mtt-launch/request-authority.json').read_text())['functions'][0]
authority_migration=next((repo/'supabase/migrations').glob('*_played_launch_proof_allows_authority_lock.sql'))
configured=os.environ.get('POKER_AUDIT_PG_BIN') or os.environ.get('PGBIN')
pg=Path(configured) if configured else Path(subprocess.check_output(['brew','--prefix','postgresql@17'],text=True).strip())/'bin'
root=Path(tempfile.mkdtemp(prefix='ca-pm-'));cluster=root/'db';sock=root/'s';sock.mkdir()
env=dict(os.environ,PGHOST=str(sock),PGHOSTADDR='',PGPORT=str(35000+os.getpid()%10000),PGUSER='postgres',PGDATABASE='postgres')
event='d3000000-0000-4000-8000-000000000001';generation='d6000000-0000-4000-8000-000000000001';launch='d5000000-0000-4000-8000-000000000001'
table='d4000000-0000-4000-8000-000000000001';closed='d4000000-0000-4000-8000-000000000002';first='2026-09-08T14:01:44.798851+00:00'
def user(n):return 'd1000000-0000-4000-8000-'+str(n).zfill(12)
proof=f"SELECT fn_prove_played_launch_recovery('{event}',NULL);"
begin=f"SELECT fn_begin_tournament_launch_atomic('{event}','{launch}','{first}','{generation}');"
complete=f"SELECT fn_complete_tournament_launch_atomic('{event}','{launch}','{generation}');"
preserved="""SELECT md5(jsonb_build_array(
 (SELECT jsonb_agg(to_jsonb(t)-'status'-'started_at' ORDER BY id) FROM tournaments t),
 (SELECT jsonb_agg(t ORDER BY id) FROM tables t),
 (SELECT jsonb_agg(t ORDER BY user_id) FROM tournament_players t),
 (SELECT jsonb_agg(t ORDER BY user_id) FROM table_seats t),
 (SELECT jsonb_agg(t ORDER BY created_at) FROM hand_history t))::text);"""
passed=[];started=False
with (root/'results.log').open('w') as log:
 def run(args):subprocess.run(args,stdout=log,stderr=log,check=True,timeout=40)
 def q(sql,error=None,role=False):
  with tempfile.TemporaryFile(mode='w+') as f:
   f.write(('SET ROLE service_role;' if role else '')+sql+'\n');f.seek(0)
   r=subprocess.run([str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1'],stdin=f,capture_output=True,text=True,env=env,timeout=15)
  log.write(r.stdout+r.stderr);log.flush()
  if error:assert r.returncode and error in r.stderr,r.stderr
  else:assert r.returncode==0,r.stderr
  return r.stdout.strip()
 def check(name):passed.append(name);print('PASS '+name,flush=True)
 def reset():
  q(f"""CHECKPOINT;TRUNCATE tournaments,tournament_players,tables,table_seats,hand_history,tournament_launch_receipts,engine_tournament_leases;
    UPDATE fixture_maintenance SET frozen=false;
    INSERT INTO tournaments(id,status,current_level,level_started_at,starting_chips,max_players,current_players,prize_pool,prize_pool_finalized)
      VALUES('{event}','REGISTERING',21,'2026-09-08T14:53:31.061Z',12000,500,2,153,true);
    INSERT INTO tables(id,tournament_id,status,current_players,max_players,small_blind,big_blind) VALUES
      ('{table}','{event}','running',2,9,200,400),('{closed}','{event}','closed',0,9,100,200);
    INSERT INTO tournament_players(tournament_id,user_id,status,chips,table_id,seat_number) VALUES
      ('{event}','{user(1)}','playing',22000,'{table}',1),('{event}','{user(2)}','playing',14000,'{table}',2),('{event}','{user(3)}','eliminated',0,'{closed}',1);
    INSERT INTO table_seats(table_id,user_id,seat_number,stack) VALUES('{table}','{user(1)}',1,22000),('{table}','{user(2)}',2,14000);
    INSERT INTO hand_history(table_id,tournament_id,created_at) VALUES('{closed}','{event}','{first}'),('{table}','{event}','2026-09-08T14:53:30Z');
    INSERT INTO engine_tournament_leases(tournament_id,lease_generation,protocol_version,heartbeat_at) VALUES('{event}','{generation}',2,clock_timestamp());
  """)
 def obtain():
  anchor=json.loads(q(proof,role=True));assert anchor['ok'] is False and anchor['reason']=='the_receipt_is_not_the_deal_that_happened'
  verified=json.loads(q(f"SELECT fn_prove_played_launch_recovery('{event}','{anchor['first_hand_at']}');",role=True));assert verified['ok'],verified
  return verified
 try:
  assert ' 17.' in subprocess.check_output([str(pg/'postgres'),'--version'],text=True)
  run([str(pg/'initdb'),'-D',str(cluster),'-U','postgres','--auth=trust','--no-locale'])
  run([str(pg/'pg_ctl'),'-D',str(cluster),'-o',f'-k {sock} -p {env["PGPORT"]} -c listen_addresses= -c max_wal_size=64MB -c min_wal_size=32MB','-w','start']);started=True
  q("""CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
    CREATE TABLE tournaments(id uuid PRIMARY KEY,status text,started_at timestamptz,current_level int,level_started_at timestamptz,starting_chips numeric,max_players int,current_players int,prize_pool numeric,prize_pool_finalized boolean,variant text DEFAULT 'freezeout',tournament_type text DEFAULT 'MTT',buy_in_amount numeric DEFAULT 5,spin_multiplier numeric);
    CREATE TABLE tables(id uuid PRIMARY KEY,tournament_id uuid,status text,current_players int,max_players int,small_blind numeric,big_blind numeric);
    CREATE TABLE tournament_players(tournament_id uuid,user_id uuid,status text,chips numeric,table_id uuid,seat_number int);
    CREATE TABLE table_seats(table_id uuid,user_id uuid,seat_number int,stack numeric,left_at timestamptz);
    CREATE TABLE hand_history(table_id uuid,tournament_id uuid,created_at timestamptz);
    CREATE TABLE tournament_launch_receipts(tournament_id uuid PRIMARY KEY,launch_id uuid NOT NULL,started_at timestamptz NOT NULL,claimed_at timestamptz DEFAULT transaction_timestamp(),completed_at timestamptz,lease_generation uuid NOT NULL DEFAULT gen_random_uuid());
    CREATE TABLE engine_tournament_leases(tournament_id uuid PRIMARY KEY,lease_generation uuid,protocol_version int,heartbeat_at timestamptz);
    CREATE TABLE fixture_maintenance(frozen boolean);INSERT INTO fixture_maintenance VALUES(false);
    CREATE FUNCTION fn_entry_purchases_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT frozen FROM fixture_maintenance$$;
    CREATE FUNCTION fn_prove_played_spin_launch_recovery(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT '{"ok":false}'::jsonb$$;
  """)
  for item in capture['functions']:
   if item['proname']=='trg_lock_tournament_start_time_during_launch':continue
   q(item['definition']+';')
  for item in capture['triggers']:q(item['function_definition']+';'+item['definition']+';')
  q("""REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC,anon,authenticated,service_role;
    GRANT EXECUTE ON FUNCTION fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz,uuid),fn_complete_tournament_launch_atomic(uuid,uuid,uuid) TO service_role;
  """)
  reset();q(proof,'permission denied',role=True);q(migration.read_text());q(migration.read_text())
  for role in ['anon','authenticated']:q('SET ROLE '+role+';'+proof,'permission denied')
  check('reviewed read-only proof becomes engine-readable while browser roles remain denied')
  # Reproduce PostgREST's actual transaction mode: STABLE POST is READ ONLY.
  # The captured hook is unchanged; auth.role is an explicit verified-claims
  # fixture. No HTTP provider or JWT verification is substituted as proven.
  q("CREATE SCHEMA auth; CREATE SCHEMA smarter_private; CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT current_setting('request.jwt.claims',true)::jsonb->>'role'$$;")
  assert hashlib.md5(authority_capture['definition'].split('$function$')[1].encode()).hexdigest()==authority_capture['body_md5']
  q(authority_capture['definition']+';')
  q("GRANT USAGE ON SCHEMA smarter_private TO service_role; GRANT EXECUTE ON FUNCTION smarter_private.fn_smarter_data_api_pre_request() TO service_role; GRANT UPDATE ON tournaments TO service_role;")
  def request_prefix(readonly=True,lease=generation,method='POST'):
   headers=json.dumps({'x-smarter-data-actor':'tournament-manager','x-smarter-data-protocol':'2','x-smarter-tournament-id':event,'x-smarter-tournament-lease-generation':lease})
   return ("BEGIN "+('READ ONLY' if readonly else 'READ WRITE')+";SET LOCAL ROLE service_role;SET LOCAL request.jwt.claims='{\"role\":\"service_role\"}';SET LOCAL request.method='"+method+"';SET LOCAL request.path='/rpc/fn_prove_played_launch_recovery';SET LOCAL request.headers='"+headers+"';SELECT smarter_private.fn_smarter_data_api_pre_request();")
  reset();before=q(preserved)
  q(request_prefix()+proof+'COMMIT;','cannot execute SELECT FOR KEY SHARE in a read-only transaction')
  assert q(preserved)==before
  check('unchanged actual request hook reproduces the live STABLE POST read-only lock failure')
  metadata="SELECT jsonb_build_array(proowner,proacl,proconfig,prosecdef,provolatile)::text FROM pg_proc WHERE oid='smarter_private.fn_smarter_data_api_pre_request()'::regprocedure;"
  previous=q(metadata)
  q(authority_migration.read_text());q(authority_migration.read_text());assert q(metadata)==previous
  assert q("SELECT provolatile FROM pg_proc WHERE oid='fn_prove_played_launch_recovery(uuid,timestamptz)'::regprocedure;")=='s'
  anchor=json.loads(q(request_prefix()+proof+'COMMIT;'))
  assert anchor['reason']=='the_receipt_is_not_the_deal_that_happened'
  exact=f"SELECT fn_prove_played_launch_recovery('{event}','{first}');"
  assert json.loads(q(request_prefix()+exact+'COMMIT;'))['ok']
  assert q(preserved)==before
  check('repaired read-only POST retains stable proof snapshot, exact anchor, grants, metadata and input rows')
  q(request_prefix()+"UPDATE tournaments SET current_players=0;COMMIT;",'cannot execute UPDATE in a read-only transaction')
  assert q(preserved)==before
  check('read-only admission cannot become a mutation bypass')
  for readonly in [True,False]:
   q(request_prefix(readonly,launch)+proof+'COMMIT;','TOURNAMENT_MANAGER_FENCED')
  q("UPDATE engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '31 seconds';")
  for readonly in [True,False]:q(request_prefix(readonly)+proof+'COMMIT;','TOURNAMENT_MANAGER_FENCED')
  check('wrong and stale generations remain refused in both access modes')
  reset()
  for method in ['GET','HEAD']:
   assert json.loads(q(request_prefix(True,method=method)+exact+'COMMIT;'))['ok']
  check('existing read-only GET and HEAD authority behavior remains valid')
  held=subprocess.Popen([str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
  try:
   held.stdin.write(request_prefix(False)+"SELECT 'authority_held';SELECT pg_sleep(1);COMMIT;\n");held.stdin.close()
   assert any(held.stdout.readline().strip()=='authority_held' for _ in range(3))
   q("BEGIN;SET LOCAL lock_timeout='100ms';SELECT 1 FROM engine_tournament_leases FOR UPDATE;COMMIT;",'lock timeout')
   q("UPDATE engine_tournament_leases SET heartbeat_at=clock_timestamp();")
   assert held.wait(timeout=5)==0,held.stderr.read()
  finally:
   if held.poll() is None:held.kill();held.wait(timeout=5)
  check('read-write request still blocks generation takeover while allowing heartbeat renewal')
  reset()

  before=q(preserved);verified=obtain();assert verified['playing']==2 and verified['dealt_field']==3
  claim=json.loads(q(begin,role=True));assert claim['ok'] and not claim['completed']
  assert json.loads(q(complete,role=True))['ok'];assert q(preserved)==before
  assert q(f"SELECT status='RUNNING' AND started_at='{first}'::timestamptz FROM tournaments WHERE id='{event}';")=='t'
  check('actual authorities record the original microsecond start and preserve level field stacks blinds pool and history')
  fingerprint=q("SELECT md5(jsonb_agg(r)::text) FROM tournament_launch_receipts r;")
  assert json.loads(q(complete,role=True))['replay'];assert q("SELECT md5(jsonb_agg(r)::text) FROM tournament_launch_receipts r;")==fingerprint
  assert json.loads(q(begin,role=True))['completed'];assert q(preserved)==before
  check('lost completion replies replay the same immutable receipt without resetting the field')
  reset();obtain();first_claim=json.loads(q(begin,role=True));second=json.loads(q(begin,role=True));assert second['replay'] and second['launch_id']==first_claim['launch_id']
  check('a lost begin reply retains one launch identity')
  reset();q(f"UPDATE tournament_players SET status='eliminated',chips=0 WHERE user_id='{user(2)}';UPDATE tournament_players SET chips=36000 WHERE user_id='{user(1)}';UPDATE table_seats SET left_at=clock_timestamp(),stack=0 WHERE user_id='{user(2)}';UPDATE table_seats SET stack=36000 WHERE user_id='{user(1)}';UPDATE tables SET current_players=1 WHERE id='{table}';UPDATE tournaments SET current_players=1;")
  assert obtain()['playing']==1;before=q(preserved);q(begin,role=True);assert json.loads(q(complete,role=True))['ok'];assert q(preserved)==before
  check('one surviving player can resume an already-played field without inventing another entry or winner')
  reset();q('TRUNCATE hand_history;');assert json.loads(q(proof,role=True))['reason']=='no_hand_was_dealt'
  q(begin,role=True);assert json.loads(q(complete,role=True))['reason']=='launch_roster_unproven'
  check('a fresh short field cannot use historical recovery')
  reset();wrong=first.replace('798851','798000');assert json.loads(q(f"SELECT fn_prove_played_launch_recovery('{event}','{wrong}');",role=True))['ok'] is False
  q(begin.replace(first,wrong),role=True);assert json.loads(q(complete,role=True))['ok'] is False
  check('a millisecond-truncated receipt cannot stand for the actual dealt hand')
  reset();obtain();q(begin,role=True);q(f"UPDATE tournament_players SET status='registered' WHERE user_id='{user(2)}';")
  assert json.loads(q(complete,role=True))['ok'] is False;assert q('SELECT status FROM tournaments;')=='REGISTERING'
  check('completion rechecks an entrant changed after the preliminary read proof')
  reset();q(f"UPDATE table_seats SET left_at=clock_timestamp() WHERE user_id='{user(2)}';")
  assert json.loads(q(f"SELECT fn_prove_played_launch_recovery('{event}','{first}');",role=True))['reason']=='the_surviving_field_is_not_seated'
  check('missing surviving seats refuse recovery')
  reset();q('UPDATE engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval \'31 seconds\';')
  assert json.loads(q(begin,role=True))['reason']=='launch_lease_lost'
  check('stale manager cannot claim the historical launch')
  reset();q('UPDATE fixture_maintenance SET frozen=true;');assert json.loads(q(begin,role=True))['reason']=='platform_frozen'
  check('begin refuses maintenance before committing a launch receipt')
  reset();obtain();q(begin,role=True)
  q("CREATE FUNCTION fixture_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture completion failure';END$$;CREATE TRIGGER fixture_fail_receipt BEFORE UPDATE OF completed_at ON tournament_launch_receipts FOR EACH ROW EXECUTE FUNCTION fixture_fail_receipt();")
  before=q(preserved);q(complete,'fixture completion failure',role=True);assert q(preserved)==before
  assert q('SELECT status FROM tournaments;')=='REGISTERING';assert q('SELECT completed_at IS NULL FROM tournament_launch_receipts;')=='t'
  check('a final receipt failure rolls back RUNNING and leaves the original played field intact')
 finally:
  if started:subprocess.run([str(pg/'pg_ctl'),'-D',str(cluster),'-m','fast','-w','stop'],stdout=log,stderr=log,check=True,timeout=30)
  shutil.rmtree(cluster,ignore_errors=True)
(root/'results.json').write_text(json.dumps({'passed':passed,'production_database_used':False,'limits':'Synthetic played field; actual proof and begin/complete authorities, receipt trigger and request hook. Transaction mode is driven as documented by PostgREST; auth.role is a verified-claims stand-in. Maintenance boolean and excluded paid-Spin proof are explicit stand-ins; no money, full trigger graph, HTTP or dealer certification.'},indent=2)+'\n')
print(str(len(passed))+' groups passed; evidence: '+str(root/'results.json'))
