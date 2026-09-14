#!/usr/bin/env python3
"""Isolated PG17 creation/trigger proof. No production URL or credentials accepted.

Uses captured current outer AND governed creators over actual column types.
Authentication, club access, and unrelated financial/management triggers are
explicit fixture boundaries, not a complete provider or game qualification.
"""
from pathlib import Path
import json, os, subprocess, tempfile, shutil, hashlib
repo=Path(__file__).resolve().parents[2]
fixture=repo/'scripts/dev/fixtures/mtt-blind-contract'
baseline=json.loads((fixture/'baseline.json').read_text())
vectors=json.loads((fixture/'vectors.json').read_text())
migration=next((repo/'supabase/migrations').glob('*_tournament_blind_structure_contract.sql'))
configured=os.environ.get('POKER_AUDIT_PG_BIN') or os.environ.get('PGBIN')
pg=Path(configured) if configured else Path(subprocess.check_output(['brew','--prefix','postgresql@17'],text=True).strip())/'bin'
root=Path(tempfile.mkdtemp(prefix='ca-bc-')); cluster=root/'db';sock=root/'s';sock.mkdir()
env=dict(os.environ,PGHOST=str(sock),PGHOSTADDR='',PGPORT=str(35000+os.getpid()%10000),PGUSER='postgres',PGDATABASE='postgres')
club='f4000000-0000-4000-8000-000000000001'; user='f4000000-0000-4000-8000-000000000002'
passed=[]; started=False;results={}
def literal(value):return "'"+str(value).replace("'","''")+"'"
with (root/'results.log').open('w') as log:
 def command(args):subprocess.run(args,stdout=log,stderr=log,check=True,timeout=40)
 def q(sql,error=None):
  result=subprocess.run([str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1'],input=sql,capture_output=True,text=True,timeout=20,env=env)
  log.write(result.stdout+result.stderr);log.flush()
  if error:assert result.returncode!=0 and error in result.stderr,result.stderr
  else:assert result.returncode==0,result.stderr
  return result.stdout.strip()
 def ok(name):passed.append(name);print('PASS '+name,flush=True)
 def call(structure,stack=10000,allowed=True,error=None):
  config=dict(type='mtt',gameVariant='NLH',buyIn=10,maxPlayers=100,minPlayers=3,startingStack=stack,
   blindStructure=structure,payoutStructure=[dict(place=1,percentage=100)],payoutPercent=15)
  return q("SET ROLE authenticated; SET test.uid='%s'; SET test.allowed='%s'; SELECT fn_create_tournament('%s',%s);"%(user,str(allowed).lower(),club,literal(json.dumps(config))),error)
 def snapshot():return q('SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),\'[]\'::jsonb) FROM tournaments t;')
 try:
  assert ' 17.' in subprocess.check_output([str(pg/'postgres'),'--version'],text=True)
  command([str(pg/'initdb'),'-D',str(cluster),'-U','postgres','--auth=trust','--no-locale'])
  command([str(pg/'pg_ctl'),'-D',str(cluster),'-o',f'-k {sock} -p {env["PGPORT"]} -c listen_addresses= -c max_wal_size=128MB','-w','start']);started=True
  columns=','.join('"'+c['name']+'" '+c['type'] for c in baseline['columns'])
  q('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE TABLE tournaments('+columns+');')
  q("ALTER TABLE tournaments ALTER COLUMN id SET DEFAULT gen_random_uuid();ALTER TABLE tournaments ADD PRIMARY KEY(id);ALTER TABLE tournaments ALTER COLUMN is_turbo SET DEFAULT false;ALTER TABLE tournaments ALTER COLUMN blind_speed SET DEFAULT 'standard';")
  q("""CREATE TABLE clubs(id uuid,union_id uuid);CREATE TABLE unions(id uuid);CREATE TABLE union_clubs(club_id uuid,union_id uuid);
   CREATE TABLE ca_declared_money_triggers(table_name text,trigger_name text,note text,PRIMARY KEY(table_name,trigger_name));
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
   CREATE FUNCTION fn_can_create_games(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT current_setting('test.allowed',true)='true'$$;
   CREATE FUNCTION is_club_admin(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
   CREATE FUNCTION fn_is_free_buy_event(numeric,numeric,text,text) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;""")
  q("INSERT INTO clubs(id) VALUES('%s');"%club)
  for f in reversed(baseline['creators']):
   body=f['definition'].split('$function$')[1];assert hashlib.md5(body.encode()).hexdigest()==f['body_md5'];q(f['definition'])
  q('REVOKE ALL ON FUNCTION fn_create_tournament(uuid,jsonb) FROM PUBLIC,anon;GRANT EXECUTE ON FUNCTION fn_create_tournament(uuid,jsonb) TO authenticated,service_role;')
  creator_meta=q("SELECT jsonb_agg(jsonb_build_array(oid::regprocedure::text,md5(prosrc),proacl,proconfig,proowner) ORDER BY proname) FROM pg_proc WHERE proname IN ('fn_create_tournament','fn_create_tournament_governed_legacy');")
  base=dict(level=1,smallBlind=25,bigBlind=50,ante=0,durationMinutes=4)
  for bad in [{**base,'bigBlind':0},{**base,'durationMinutes':'never'},{**base,'isBreak':'false'}]:
   assert json.loads(call([bad]))['success'] is True
  assert q("SELECT count(*) FROM tournaments WHERE blind_speed='standard' AND NOT is_turbo;")=='3'
  old=snapshot();ok('actual current creators reproduce malformed ladder acceptance and incorrect speed')
  q(migration.read_text());q(migration.read_text())
  assert snapshot()==old
  assert q("SELECT jsonb_agg(jsonb_build_array(oid::regprocedure::text,md5(prosrc),proacl,proconfig,proowner) ORDER BY proname) FROM pg_proc WHERE proname IN ('fn_create_tournament','fn_create_tournament_governed_legacy');")==creator_meta
  ok('repeatable installation leaves every historical row and creator body/authority unchanged')
  for vector in vectors:
   structure=literal(json.dumps(vector['structure'])); stack='NULL' if vector['stack'] is None else str(vector['stack'])
   sql='SELECT fn_ca_mtt_blind_contract(%s,%s);'%(structure,stack)
   if vector['valid']:
    result=json.loads(q(sql))
    if 'speed' in vector:assert result==dict(blind_speed=vector['speed'],is_turbo=vector['speed'] in ['turbo','hyper_turbo'])
   else:q(sql,'Invalid tournament blind structure')
  ok(str(len(vectors))+' native validation vectors include clock aliases, breaks, malformed shapes and stack refusal')
  shapes=[]
  for row in baseline['existing_shapes']:
   shapes.append(json.loads(q('SELECT fn_ca_mtt_blind_contract(%s,%s);'%(literal(row['blind_structure']),row['starting_chips']))))
  ok('all 23 distinct live active MTT structure/stack shapes remain valid')
  before=snapshot()
  for bad in [{**base,'bigBlind':0},{**base,'durationMinutes':'never'},{**base,'isBreak':'false'},None]:
   call([bad],error='Invalid tournament blind structure');assert snapshot()==before
  ok('actual two-stage creator refuses bad new ladders with complete row rollback')
  receipt=json.loads(call([base]));event=receipt['tournament_id']
  assert json.loads(q("SELECT jsonb_build_object('speed',blind_speed,'turbo',is_turbo,'depth',payout_percent,'stack',starting_chips,'blinds',blind_structure::jsonb) FROM tournaments WHERE id='%s';"%event))==dict(speed='turbo',turbo=True,depth=15,stack=10000,blinds=[base])
  ok('actual two-stage creator stores precise speed and selected paid depth without changing the ladder')
  before=snapshot();assert json.loads(call([base],allowed=False))['error']=='not_authorised';assert snapshot()==before
  ok('original authorization refusal remains before every insert')
  q('UPDATE tournaments SET current_level=1;');before=snapshot()
  q("UPDATE tournaments SET blind_structure='[{}]' WHERE id='%s';"%event,'Invalid tournament blind structure');assert snapshot()==before
  q("UPDATE tournaments SET starting_chips=0 WHERE id='%s';"%event,'Invalid tournament blind structure');assert snapshot()==before
  ok('unrelated old-event progress remains allowed; changed malformed structure or stack rolls back')
  q("INSERT INTO tournaments(tournament_type,variant,max_players,starting_chips,blind_structure) VALUES('SPIN','spin',3,300,'[]'),('SNG','sng',9,1500,'[]'),('MTT','satellite',2,300,'[]');")
  ok('short-format and heads-up creation remains with its separate existing contract')
  before=snapshot();q("UPDATE tournaments SET tournament_type='MTT',variant='freezeout',max_players=100 WHERE variant='sng';",'Invalid tournament blind structure');assert snapshot()==before
  before=snapshot();q("UPDATE tournaments SET max_players=100 WHERE variant='satellite' AND max_players=2;",'Invalid tournament blind structure');assert snapshot()==before
  ok('changing an exempt format or heads-up capacity cannot bypass new MTT validation')
  q("SET ROLE anon;SELECT fn_ca_mtt_blind_contract('[]',100);",'permission denied')
  assert q("SELECT count(*) FROM ca_declared_money_triggers WHERE table_name='tournaments' AND trigger_name='tournaments_new_mtt_blind_contract';")=='1'
  ok('new internal authority denies anonymous access and declares its money-table trigger')
  results=dict(groups=len(passed),passed=passed,vectors=len(vectors),live_shapes=len(shapes),creators={f['signature']:f['body_md5'] for f in baseline['creators']})
 finally:
  if started:command([str(pg/'pg_ctl'),'-D',str(cluster),'-m','immediate','-w','stop'])
  pid_absent=not (cluster/'postmaster.pid').exists();assert pid_absent
  shutil.rmtree(cluster,ignore_errors=True);shutil.rmtree(sock,ignore_errors=True)
  results.update(cleanup=dict(stopped=True,pid_absent=pid_absent,cluster_removed=not cluster.exists(),socket_removed=not sock.exists()))
  (root/'results.json').write_text(json.dumps(results,indent=2)+'\n')
  print('Evidence: '+str(root/'results.json'),flush=True)
