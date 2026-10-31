"""Run exact original/candidate snapshot functions on native PostgreSQL.

Actual captured fixture/cert classifiers and full snapshot writer execute.
The external arena meter and incident consumers are explicit fixture boundaries.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parents[2]
PG=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'))
OUT=Path(os.environ.get('DIAMOND_TEST_OUTPUT',ROOT/'artifacts/diamond-snapshot-holder-set'))
OUT.mkdir(parents=True,exist_ok=True)
cluster=Path(tempfile.mkdtemp(prefix='dsh-'));sock=cluster/'s';sock.mkdir()
owner=['runuser','-u','postgres','--']if os.geteuid()==0 else[]
if owner:
 shutil.chown(cluster,'postgres');shutil.chown(sock,'postgres')
env={k:v for k,v in os.environ.items()if not k.startswith('PG')}
psql=[PG/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h',sock,'-p','55839','-U','postgres','-d','postgres']
checks=[]
def cmd(args,sql=None,ok=True):
 r=subprocess.run(list(map(str,args)),input=sql,text=True,capture_output=True,env=env,timeout=60)
 if ok and r.returncode:raise RuntimeError(r.stderr)
 return r
def run(sql):return cmd(psql,sql).stdout.strip()
def check(name,value):
 checks.append({'name':name,'passed':bool(value)})
 assert value,name
def scenario():
 run('TRUNCATE ca_diamond_snapshots,observations; SELECT fn_ca_diamond_snapshot(); SELECT fn_ca_diamond_snapshot();')
 # Real movement explained by the register, then unexplained movement.
 run("INSERT INTO poker_diamond_custody VALUES(md5('1')::uuid,3); INSERT INTO ca_mint_ledger(holder_id,asset,holder_type,action,amount) VALUES(md5('1')::uuid,'diamonds','player','mint',3); SELECT fn_ca_diamond_snapshot();")
 run("INSERT INTO poker_diamond_custody VALUES(md5('1')::uuid,80); SELECT fn_ca_diamond_snapshot();")
 data=json.loads(run("SELECT jsonb_agg(to_jsonb(s)-'id'-'taken_at' ORDER BY taken_at) FROM ca_diamond_snapshots s"))
 observations=json.loads(run("SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY kind,detail::text),'[]') FROM observations o"))
 run("DELETE FROM poker_diamond_custody WHERE user_id=md5('1')::uuid AND balance IN(3,80); DELETE FROM ca_mint_ledger WHERE holder_id=md5('1')::uuid AND amount=3;")
 return data,observations
try:
 cmd(owner+[PG/'initdb','-D',cluster/'d','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 cmd(owner+[PG/'pg_ctl','-D',cluster/'d','-l',cluster/'log','-o',f"-k {sock} -p 55839 -c listen_addresses='' -c shared_buffers=16MB",'-w','start'])
 run((ROOT/'scripts/ci/fixtures/diamond-snapshot-holder-world.sql').read_text())
 # Execute the actual declaration owner against isolated registry tables.
 run("CREATE TABLE ca_guard_def_history(proname text,def_hash text,def_text text,UNIQUE(proname,def_hash)); CREATE TABLE ca_guard_defs(proname text PRIMARY KEY,def_hash text,declared_ref text,declared_at timestamptz,updated_at timestamptz); CREATE FUNCTION fn_ca_guard_watchlist() RETURNS text[] LANGUAGE sql AS $$ SELECT ARRAY['fn_ca_diamond_snapshot']::text[] $$;")
 declaration=(ROOT/'supabase/migrations/20260910143032_a_declared_guard_change_is_recorded_not_raised.sql').read_text()
 declaration=declaration[declaration.index('CREATE OR REPLACE FUNCTION public.fn_ca_declare_guard_redefinition('):]
 run(declaration[:declaration.index('$function$;')+len('$function$;')])
 defs=json.loads((ROOT/'scripts/ci/fixtures/diamond-snapshot-holder-preimages.json').read_text())
 for d in defs:run(d['definition']+';')
 run('REVOKE ALL ON FUNCTION fn_ca_diamond_snapshot() FROM PUBLIC; GRANT EXECUTE ON FUNCTION fn_ca_diamond_snapshot() TO service_role;')
 for d in defs:check('captured-'+d['proname'],run("SELECT md5(pg_get_functiondef('public.%s(%s)'::regprocedure))"%(d['proname'],''if d['proname']=='fn_ca_diamond_snapshot'else'uuid'))==d['hash'])
 old=scenario()
 plan_query="SELECT holder_id,sum(CASE WHEN action='mint' THEN amount ELSE -amount END) FROM ca_mint_ledger WHERE asset='diamonds' AND holder_type='player' GROUP BY holder_id"
 old_plan=run('EXPLAIN (FORMAT JSON) '+plan_query)
 meta=run("SELECT oid::text||':'||proacl::text||':'||proconfig::text FROM pg_proc WHERE oid='fn_ca_diamond_snapshot()'::regprocedure")
 migration=next((ROOT/'supabase/migrations').glob('*_diamond_snapshot_classifies_its_holder_set_once.sql')).read_text()
 run(migration)
 check('declared-guard-baseline-matches-installed-definition',run("SELECT def_hash=md5(pg_get_functiondef('fn_ca_diamond_snapshot()'::regprocedure)) AND declared_ref='migration 20261028151339_diamond_snapshot_classifies_its_holder_set_once' FROM ca_guard_defs WHERE proname='fn_ca_diamond_snapshot'")=='t')
 run('VACUUM ANALYZE ca_mint_ledger;')
 new_plan=run('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+plan_query)
 (OUT/'before-plan.json').write_text(old_plan)
 (OUT/'after-plan.json').write_text(new_plan)
 def nodes(plan):
  yield plan
  for child in plan.get('Plans',[]):yield from nodes(child)
 scans=[n for n in nodes(json.loads(new_plan)[0]['Plan'])if n.get('Node Type')=='Index Only Scan']
 # The 50,000 unchanged bulk rows must not require heap reads. The small
 # original seed and scenario insert/delete tail can still have nonvisible
 # pages after VACUUM, as an append-only production ledger does during play.
 check('cover-removes-historical-heap-scan', 'Index Only Scan' not in old_plan and len(scans)==1 and scans[0]['Heap Fetches']<=20 and scans[0]['Actual Rows']>=50000)
 check('same-function-identity-acl-settings',meta==run("SELECT oid::text||':'||proacl::text||':'||proconfig::text FROM pg_proc WHERE oid='fn_ca_diamond_snapshot()'::regprocedure"))
 new=scenario()
 check('all-stored-snapshot-fields-identical',old[0]==new[0])
 check('same-drift-consumer-result',old[1]==new[1] and any(x['kind']=='ledger_imbalance'for x in new[1]))
 check('steady-and-explained-deltas-zero',new[0][1]['unexplained']==0 and new[0][2]['unexplained']==0)
 check('real-unexplained-movement-still-pages',new[0][3]['unexplained']==80)
 check('migration-replay-refused',cmd(psql,migration,False).returncode!=0)
 result={'checks':checks,'production_mutations':False,'postimage_md5':run("SELECT md5(pg_get_functiondef('fn_ca_diamond_snapshot()'::regprocedure))")}
 print(json.dumps(result))
finally:
 (OUT/'RESULTS.json').write_text(json.dumps({'checks':checks,'production_mutations':False},indent=2))
 cmd(owner+[PG/'pg_ctl','-D',cluster/'d','-m','immediate','-w','stop'],ok=False)
 shutil.rmtree(cluster)
