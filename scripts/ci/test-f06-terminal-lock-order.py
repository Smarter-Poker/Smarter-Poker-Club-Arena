"""Reproduce current hand/terminal lock inversion in an owned PostgreSQL 17."""
import argparse, json, os, pathlib, shutil, subprocess, tempfile, time

repo=pathlib.Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',type=pathlib.Path,default=repo/'artifacts/f06-terminal-lock-order')
out=parser.parse_args().output.resolve()
pg=pathlib.Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
env={k:v for k,v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL']='C'
out.mkdir(parents=True,exist_ok=False)
installer=(repo/'supabase/migrations/20260914000500_hand_terminal_lane_lock_order.sql').read_text()
cluster=pathlib.Path(tempfile.mkdtemp(prefix='codex-f06-terminal-',dir='/tmp'))
sock=cluster/'socket';sock.mkdir(mode=0o700)
cmd=[str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-h',str(sock),'-p','55706','-U','postgres','-d','postgres']
sessions=[];checks=[]
def require(ok,msg):
 if not ok:raise RuntimeError(msg)
def call(args,sql=None):
 return subprocess.run([str(x) for x in args],input=sql,text=True,capture_output=True,timeout=15,env=env)
def sql(text):
 r=call(cmd,text);require(r.returncode==0,r.stderr);return r.stdout.strip()
def check(name,ok):
 checks.append({'name':name,'passed':bool(ok)});require(ok,name)
class Session:
 def __init__(self,name):
  self.name=name;self.log=(out/(name+'.log')).open('w')
  self.p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=self.log,stderr=self.log,text=True,env=dict(env,PGAPPNAME=name));sessions.append(self)
 def send(self,text):
  self.p.stdin.write(text+'\n');self.p.stdin.flush()
 def wait(self,needle):
  end=time.monotonic()+5
  while time.monotonic()<end:
   if needle in (out/(self.name+'.log')).read_text():return
   time.sleep(.02)
  raise RuntimeError(self.name+' missing '+needle+': '+(out/(self.name+'.log')).read_text())
 def close(self):
  if self.p.poll() is None:
   self.send('ROLLBACK;');self.p.stdin.close();self.p.wait(timeout=5)
  self.log.close()
def wait_lock(name,key):
 end=time.monotonic()+5
 query="SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='"+name+"' AND l.locktype='advisory' AND NOT l.granted AND l.classid=((hashtextextended('"+key+"',0)>>32)&4294967295)::oid AND l.objid=(hashtextextended('"+key+"',0)&4294967295)::oid);"
 while time.monotonic()<end:
  if sql(query)=='t':return
  time.sleep(.02)
 raise RuntimeError('Expected lock wait absent: '+name)
share="SELECT public.fn_ca_share_settlement_lane_for_table('00000000-0000-4000-8000-000000000002');"
mirror='UPDATE tournament_players SET chips=101,table_id=table_id,seat_number=seat_number WHERE id=2;'
global_key='ca:tournament-terminal-settlement:v1'
barrier_key='ca:hand-settlement-barrier:v1'
result={'production_mutations':False,'checks':checks,'passed':False}
try:
 require(shutil.disk_usage('/tmp').free>512*1024**2,'Insufficient disk reserve')
 require('PostgreSQL) 17.' in call([pg/'postgres','--version']).stdout,'PostgreSQL 17 required')
 r=call([pg/'initdb','-D',cluster/'data','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale']);require(r.returncode==0,r.stderr)
 r=call([pg/'pg_ctl','-D',cluster/'data','-l',cluster/'server.log','-o',f"-k {sock} -p 55706 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",'-w','start']);require(r.returncode==0,r.stderr)
 sql((repo/'scripts/ci/probes/f06-shared-hand-lane/fixture.sql').read_text())
 sql((repo/'supabase/migrations/20260913202500_f06_preserve_shared_hand_lane.sql').read_text())
 sql((repo/'scripts/ci/probes/f06-terminal-lock-order/global.sql').read_text())
 sql('REVOKE ALL ON FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) FROM PUBLIC,anon,authenticated,service_role; GRANT EXECUTE ON FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) TO service_role;')
 for name,mutation in [
  ('helper-preimage',"ALTER FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) SET search_path=pg_catalog;"),
  ('source-guard-preimage',"ALTER FUNCTION smarter_private.f06_source_guard() SET search_path=pg_catalog;"),
  ('browser-acl',"GRANT EXECUTE ON FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) TO authenticated;")]:
  r=call(cmd,'BEGIN;'+mutation+installer)
  (out/(name+'.log')).write_text(r.stdout+r.stderr)
  check(name+'-drift-refused',r.returncode!=0 and 'P0001:' in r.stderr)

 before=sql('SELECT jsonb_agg(p ORDER BY id) FROM tournament_players p;')
 for label,fixed in [('baseline',False),('candidate',True)]:
  if fixed:
   sql(installer);sql(installer);check('migration-replay',True)
   check('browser-access-stays-closed',sql("SELECT NOT has_function_privilege('anon','public.fn_ca_share_settlement_lane_for_table(uuid)','EXECUTE') AND NOT has_function_privilege('authenticated','public.fn_ca_share_settlement_lane_for_table(uuid)','EXECUTE');")=='t')
  hand=Session(label+'-hand');hand.send('BEGIN;'+share+"SELECT 'HAND_READY';");hand.wait('HAND_READY')
  terminal=Session(label+'-terminal');terminal.send("BEGIN; SELECT public.fn_ca_lock_settlement_lane_global(); SELECT 'TERMINAL_READY';")
  wait_lock(terminal.name,global_key if fixed else barrier_key)
  check(label+'-terminal-excludes-before-financial-writes',True)
  hand.send(mirror+"SELECT 'MIRROR_DONE'; ROLLBACK;")
  if fixed:
   hand.wait('MIRROR_DONE');check('candidate-hand-completes-while-terminal-queues',True)
  else:
   hand.wait('40001: F06_RETRY_CANONICAL_LANE');check('baseline-same-custody-refusal-reproduced',True)
  terminal.wait('TERMINAL_READY');check(label+'-terminal-progresses-after-hand',True)
  hand.close();terminal.close()
  check(label+'-probe-state-rolled-back',sql('SELECT jsonb_agg(p ORDER BY id) FROM tournament_players p;')==before)
 # Terminal first: no hand may reach its row writes until terminal releases.
 terminal=Session('candidate-terminal-first');terminal.send("BEGIN;SELECT public.fn_ca_lock_settlement_lane_global();SELECT 'TERMINAL_READY';");terminal.wait('TERMINAL_READY')
 hand=Session('candidate-hand-second');hand.send('BEGIN;'+share+"SELECT 'HAND_READY';")
 wait_lock(hand.name,global_key);check('candidate-hand-waits-at-entry',True)
 terminal.close();hand.wait('HAND_READY');hand.send(mirror+"SELECT 'MIRROR_DONE';ROLLBACK;");hand.wait('MIRROR_DONE');hand.close()
 check('candidate-terminal-exclusion-and-resume',True)
 # Same-tournament hands stay concurrent, and unrelated rolling work stays independent.
 first=Session('candidate-first-hand');first.send('BEGIN;'+share+"SELECT 'FIRST_READY';");first.wait('FIRST_READY')
 second=Session('candidate-second-hand');second.send('BEGIN;'+share+mirror+"SELECT 'SECOND_READY';ROLLBACK;");second.wait('SECOND_READY');second.close();first.close()
 check('same-tournament-hands-remain-concurrent',True)
 for suffix,same_tournament in [('98',False),('99',True)]:
  lane=global_key+':00000000-0000-4000-8000-0000000000'+suffix
  roller=Session('rolling-'+suffix)
  roller.send("BEGIN;SELECT pg_advisory_xact_lock_shared(hashtextextended('"+global_key+"',0));SELECT pg_advisory_xact_lock(hashtextextended('"+lane+"',0));SELECT 'ROLLING_READY';");roller.wait('ROLLING_READY')
  hand=Session('hand-with-rolling-'+suffix);hand.send('BEGIN;'+share+"SELECT 'HAND_READY';")
  if same_tournament:
   wait_lock(hand.name,lane);check('same-tournament-rolling-authority-still-excludes-hand',True);roller.close()
  hand.wait('HAND_READY');hand.send(mirror+"SELECT 'MIRROR_DONE';ROLLBACK;");hand.wait('MIRROR_DONE');hand.close();roller.close()
  check('rolling-'+suffix+'-preserves-hand-progress',True)
 check('all-probes-rolled-back',sql('SELECT jsonb_agg(p ORDER BY id) FROM tournament_players p;')==before)
 result['passed']=True
finally:
 for s in sessions:
  if not s.log.closed:
   if s.p.poll() is None:
    s.p.terminate();s.p.wait(timeout=5)
   s.log.close()
 if (cluster/'data/postmaster.pid').exists():
  r=call([pg/'pg_ctl','-D',cluster/'data','-m','fast','-w','stop']);require(r.returncode==0,'Owned cluster failed to stop')
 if (cluster/'server.log').exists():shutil.copyfile(cluster/'server.log',out/'server.log')
 shutil.rmtree(cluster);result['owned_cluster_removed']=not cluster.exists()
 (out/'RESULTS.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
