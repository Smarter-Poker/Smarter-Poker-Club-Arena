"""Native original/candidate fleet aggregate and attention consumer.

Original full attention functions execute. The fleet aggregate is
extracted from the exact metrics producer; unrelated metrics are not executed.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parents[2]
PG=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'))
OUT=Path(os.environ.get('REPORTING_TEST_OUTPUT',ROOT/'artifacts/digest-oct27-reporting'));OUT.mkdir(parents=True,exist_ok=True)
cluster=Path(tempfile.mkdtemp(prefix='dor-'));sock=cluster/'s';sock.mkdir()
owner=['runuser','-u','postgres','--']if os.geteuid()==0 else[]
if owner:shutil.chown(cluster,'postgres');shutil.chown(sock,'postgres')
env={k:v for k,v in os.environ.items()if not k.startswith('PG')}
psql=[PG/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h',sock,'-p','55841','-U','postgres','-d','postgres']
checks=[]
def cmd(args,sql=None,ok=True):
 p=subprocess.run(list(map(str,args)),input=sql,text=True,capture_output=True,env=env,timeout=60)
 if ok and p.returncode:raise RuntimeError(p.stderr)
 return p
def run(sql):return cmd(psql,sql).stdout.strip()
def check(name,value):
 checks.append({'name':name,'passed':bool(value)})
 assert value,name
def aggregate(definition):
 start=definition.index("'horse_fleet', (SELECT jsonb_build_object")
 end=definition.index(' FROM hb)',start)+len(' FROM hb)')
 return json.loads(run("WITH hb AS(SELECT * FROM ca_horse_fleet_heartbeat)SELECT jsonb_build_object('play',jsonb_build_object("+definition[start:end]+"))"))
def title(metrics):
 text=json.dumps(metrics).replace("'","''")
 return run("SELECT x->>'title' FROM jsonb_array_elements(fn_sp_digest_attention(current_date-2,'"+text+"'::jsonb))x WHERE x->>'rule'='horse_fleet_degraded'")
try:
 cmd(owner+[PG/'initdb','-D',cluster/'d','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 cmd(owner+[PG/'pg_ctl','-D',cluster/'d','-l',cluster/'log','-o',f"-k {sock} -p 55841 -c listen_addresses='' -c shared_buffers=16MB",'-w','start'])
 run('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;')
 run("""CREATE TABLE sp_daily_metrics(day date,metrics jsonb);
 CREATE TABLE operational_alert_events(alertname text,received_at timestamptz,severity text,payload jsonb,investigation_status text,status text);
 CREATE TABLE ca_drift_incidents(resolved_at timestamptz,deadline_at timestamptz);
 CREATE TABLE tournaments(id uuid,name text,tournament_type text,status text,started_at timestamptz);
 CREATE TABLE cashout_requests(completed_at timestamptz,cancelled_at timestamptz,status text,created_at timestamptz);
 CREATE TABLE settlement_invoices(invoice_type text,created_at timestamptz,message_sent boolean);
 CREATE TABLE wheel_configs(enabled boolean,exposure_allowance_chips numeric);
 CREATE TABLE diamond_game_configs(enabled boolean,exposure_allowance_chips numeric);
 CREATE TABLE sp_daily_digest_runs(day date,status text);
 CREATE TABLE ca_horse_fleet_heartbeat(degraded boolean,horses_stuck integer,horses_seated integer);
 CREATE FUNCTION fn_sp_setting(text,numeric)RETURNS numeric LANGUAGE sql AS $$SELECT $2$$;
 CREATE FUNCTION fn_diamond_spins_allowance_floor()RETURNS numeric LANGUAGE sql AS $$SELECT 2500$$;
 INSERT INTO ca_horse_fleet_heartbeat VALUES(true,NULL,100);
 """)
 defs=json.loads((ROOT/'scripts/ci/fixtures/digest-oct27-reporting-preimages.json').read_text())
 for d in defs:run(d['definition']+';')
 metrics=next(x['definition']for x in defs if x['proname']=='fn_sp_daily_metrics_compute')
 oldmetrics=aggregate(metrics);check('baseline-labels-unknown-as-zero',oldmetrics['play']['horse_fleet']['max_stuck']==0 and '0 horses stuck'in title(oldmetrics))
 migration=next((ROOT/'supabase/migrations').glob('*_fleet_reporting_preserves_unknown_stuck_counts.sql')).read_text()
 run(migration)
 newdefs=json.loads((ROOT/'scripts/ci/fixtures/digest-oct27-reporting-postimages.json').read_text())
 for d in newdefs:
  sig=d['proname']+('(date,jsonb)'if d['proname']=='fn_sp_digest_attention'else'(date)')
  check('installed-producer-consumer-'+d['proname'],run("SELECT pg_get_functiondef('public."+sig+"'::regprocedure)")==d['definition'].strip())
 installed=run("SELECT pg_get_functiondef('public.fn_sp_daily_metrics_compute(date)'::regprocedure)")
 newmetrics=aggregate(installed)
 check('producer-preserves-unknown',newmetrics['play']['horse_fleet']['max_stuck']is None and newmetrics['play']['horse_fleet']['unknown_stuck_beats']==1)
 check('consumer-discloses-unknown','count unavailable'in title(newmetrics))
 check('legacy-snapshot-discloses-unknown','count unavailable'in title(oldmetrics))
 run('UPDATE ca_horse_fleet_heartbeat SET horses_stuck=0;')
 known=aggregate(next(x['definition']for x in newdefs if x['proname']=='fn_sp_daily_metrics_compute'))
 check('known-zero-stays-zero','0 horses stuck'in title(known))
 check('migration-replay-refused',cmd(psql,migration,False).returncode!=0)
 hashes={d['proname']:run("SELECT md5(pg_get_functiondef('public."+d['proname']+('(date,jsonb)'if d['proname']=='fn_sp_digest_attention'else'(date)')+"'::regprocedure))")for d in defs}
 print(json.dumps({'checks':checks,'postimage_hashes':hashes,'production_mutations':False}))
finally:
 (OUT/'RESULTS.json').write_text(json.dumps({'checks':checks,'production_mutations':False},indent=2))
 cmd(owner+[PG/'pg_ctl','-D',cluster/'d','-m','immediate','-w','stop'],ok=False);shutil.rmtree(cluster)
