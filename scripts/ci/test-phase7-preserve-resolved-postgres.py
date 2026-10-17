#!/usr/bin/env python3
"""Actual Phase 7 incident calls preserve concurrent and prior resolutions."""
import argparse,json,os,re,shutil,subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--pg-bin',default=os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'));p.add_argument('--scratch',default=os.environ.get('RUNNER_TEMP',tempfile.gettempdir()));a=p.parse_args()
pg=Path(a.pg_bin);root=Path(tempfile.mkdtemp(prefix='pr-',dir=a.scratch));data=root/'d';started=False
psql=[pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',root,'-U','postgres','-d','postgres']
def run(cmd,sql=None,error=None):
 r=subprocess.run([str(x) for x in cmd],input=sql,text=True,capture_output=True,timeout=60)
 if error:assert r.returncode and error in r.stderr,r.stdout+r.stderr
 else:assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def q(sql,error=None):return run(psql,sql,error)
old=next((ROOT/'supabase/migrations').glob('20261015182553*')).read_text();new=next((ROOT/'supabase/migrations').glob('20261015221949*')).read_text()
pattern=r"SELECT public.fn_ca_incident_action\('[\s\S]*?(?=\nUPDATE public.financial_alerts)"
before=re.findall(pattern,old);after=re.findall(pattern,new);assert len(before)==len(after)==4
ids=[re.search(r"action\('([^']+)'",s)[1] for s in before]
seed='TRUNCATE ca_drift_incidents,ca_incident_events,fixture_notifications; INSERT INTO ca_drift_incidents(id,status,severity,classification) VALUES '+','.join("('"+i+"','open','critical','unknown')" for i in ids)+';'
try:
 assert ' 17.' in run([pg/'postgres','--version'])
 run([pg/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 with (data/'postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(root)+"'\n")
 run([pg/'pg_ctl','-D',data,'-l',root/'server.log','-w','start']);started=True
 q("CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$; CREATE TABLE ca_drift_incidents(id uuid PRIMARY KEY,status text,severity text,classification text,root_cause text,correction_ref text,resolution text,resolved_by uuid,resolved_at timestamptz,acknowledged_by uuid,acknowledged_at timestamptz,assigned_to uuid,past_target boolean,escalation_level int,detected_at timestamptz,deadline_at timestamptz); CREATE TABLE ca_incident_events(incident_id uuid,kind text,actor uuid,detail jsonb); CREATE TABLE fixture_notifications(incident_id uuid); CREATE FUNCTION fn_ca_incident_recipient_ids(ca_drift_incidents,boolean) RETURNS uuid[] LANGUAGE sql AS $$SELECT ARRAY[]::uuid[]$$; CREATE FUNCTION fn_ca_incident_notify(uuid,text,text,boolean) RETURNS void LANGUAGE sql AS $$INSERT INTO fixture_notifications VALUES($1)$$;")
 q((ROOT/'scripts/ci/fixtures/phase7-preserve-resolved/action-before.sql').read_text())
 assert q("SELECT md5(pg_get_functiondef('fn_ca_incident_action(uuid,text,text,uuid,text,text)'::regprocedure));")=='1017987e76a8327b7d379d795a317401','actual authority source'
 q(seed+"UPDATE ca_drift_incidents SET status='resolved',resolved_at='2026-10-15 21:34:39.917782Z',root_cause='Existing qualified cause',resolution='Existing qualified explanation' WHERE id='"+ids[0]+"';")
 fingerprint=q("SELECT md5(to_jsonb(c)::text) FROM ca_drift_incidents c WHERE id='"+ids[0]+"';")
 q(before[0]);assert fingerprint!=q("SELECT md5(to_jsonb(c)::text) FROM ca_drift_incidents c WHERE id='"+ids[0]+"';"),'fail-before overwrites resolution'
 q(seed+"UPDATE ca_drift_incidents SET status='resolved',resolved_at='2026-10-15 21:34:39.917782Z',root_cause='Existing qualified cause',resolution='Existing qualified explanation' WHERE id='"+ids[0]+"';")
 q('\n'.join(after));assert fingerprint==q("SELECT md5(to_jsonb(c)::text) FROM ca_drift_incidents c WHERE id='"+ids[0]+"';"),'existing full row preserved'
 assert q("SELECT count(*) FROM ca_incident_events;")=='3' and q('SELECT count(*) FROM fixture_notifications;')=='3','only open incidents emit'
 assert q("SELECT count(*) FROM ca_drift_incidents WHERE status='resolved' AND root_cause IS NOT NULL;")=='4','all open cases close'
 q('\n'.join(after));assert q('SELECT count(*) FROM ca_incident_events;')=='3','duplicate request emits nothing'
 q(seed);q('BEGIN;'+after[1]+"DO $$BEGIN RAISE EXCEPTION 'fixture_abort';END$$;COMMIT;",'fixture_abort');assert q("SELECT count(*) FROM ca_drift_incidents WHERE status='resolved';")=='0' and q('SELECT count(*) FROM ca_incident_events;')=='0','atomic rollback'
 # A second resolver wins after our snapshot but before our row lock.
 other=subprocess.Popen([str(x) for x in psql],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 other.stdin.write("BEGIN;UPDATE ca_drift_incidents SET status='resolved',root_cause='Concurrent qualification',resolution='Concurrent explanation' WHERE id='"+ids[0]+"';SELECT 'locked';SELECT pg_sleep(1);COMMIT;\n");other.stdin.close()
 assert other.stdout.readline().strip()=='locked'
 q(after[0]);assert other.wait(timeout=5)==0,other.stderr.read()
 assert q("SELECT resolution FROM ca_drift_incidents WHERE id='"+ids[0]+"';")=='Concurrent explanation' and q('SELECT count(*) FROM ca_incident_events;')=='0','concurrent resolution preserved after lock recheck'
 guard=next(line for line in new.splitlines() if "THEN RAISE EXCEPTION 'phase7_incident_authority_changed'" in line)
 q('DO $$ BEGIN '+guard+' END $$;')
 # A changed body cannot pass the source guard.
 q((ROOT/'scripts/ci/fixtures/phase7-preserve-resolved/action-before.sql').read_text().replace('DECLARE','DECLARE\n  fixture_drift boolean := false;',1))
 q('DO $$ BEGIN '+guard+' END $$;','phase7_incident_authority_changed')
 # Installed prerequisite compatibility is qualified without changing either body.
 compat=json.loads((ROOT/'scripts/ci/fixtures/phase7-preserve-resolved/installed-prerequisites.json').read_text())
 q("CREATE ROLE service_role;CREATE TYPE ca_operator_floor_hold AS (id boolean);CREATE TYPE ca_engine_operator_commands AS (id uuid);CREATE TYPE ca_launch_operator_scopes AS (id uuid);SET check_function_bodies=false;"+compat['watchdog']+";REVOKE ALL ON FUNCTION fn_ca_operator_floor_hold_watchdog() FROM PUBLIC;GRANT EXECUTE ON FUNCTION fn_ca_operator_floor_hold_watchdog() TO service_role;")
 assert q("SELECT md5(pg_get_functiondef('fn_ca_operator_floor_hold_watchdog()'::regprocedure));")=='a75ce8a90eaf1bbf6f6b28187233628e'
 wd='DO $watchdog$'+new.split('DO $watchdog$')[1].split('END $watchdog$;')[0]+'END $watchdog$;'
 before_wd='DO $watchdog$'+old.split('DO $watchdog$')[1].split('END $watchdog$;')[0]+'END $watchdog$;'
 q(before_wd,'watchdog_preimage_refused')
 q(wd);assert q("SELECT md5(pg_get_functiondef('fn_ca_operator_floor_hold_watchdog()'::regprocedure));")=='a75ce8a90eaf1bbf6f6b28187233628e','new lease watchdog stays byte identical'
 q(compat['watchdog'].replace('DECLARE','-- fixture drift\nDECLARE',1));q(wd,'watchdog_preimage_refused')
 print('PASS installed lease watchdog: legacy guard refuses; new exact source is preserved byte-for-byte; unknown watchdog refused')
 print('PASS: fail-before overwrites; full existing row preserved; open cases resolve; duplicate emits nothing; rollback; concurrent resolution wins')
finally:
 if started:run([pg/'pg_ctl','-D',data,'-m','fast','-w','stop'])
 shutil.rmtree(root)
