#!/usr/bin/env python3
"""Validate the exact lease prerequisite gate using rollback-only local catalog faults."""
import json,subprocess
from pathlib import Path
HERE=Path(__file__).resolve().parent
PSQL=['/opt/homebrew/opt/postgresql@17/bin/psql','-X','-qAt','-h','/tmp/codex-satellite-cohort-pg17/socket','-p','55387','-d','satellite_qualification_verified','-v','ON_ERROR_STOP=1']
def execute(sql):
 return subprocess.run(PSQL,input=sql,text=True,capture_output=True,timeout=15)
def query(sql):
 r=execute(sql)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
query("DO $$ BEGIN IF current_database()<>'satellite_qualification_verified' OR current_setting('data_directory') NOT LIKE '/tmp/codex-satellite-cohort-pg17/%' THEN RAISE EXCEPTION 'Local fixture required'; END IF; END $$;")
migration=(HERE.parents[2]/'supabase/migrations/20260910054035_satellites_record_equal_qualifiers_without_fabricated_finish.sql').read_text()
gate='DO $qualification_lease_gate$'+migration.split('DO $qualification_lease_gate$')[1].split('$qualification_lease_gate$;')[0]+'$qualification_lease_gate$;'
signature='public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'
original=query("SELECT pg_get_functiondef('"+signature+"'::regprocedure)")
assert '   FOR UPDATE;' in original
changed=original.replace('   FOR UPDATE;','   FOR NO KEY UPDATE;',1)
catalog_sql="SELECT json_agg(json_build_object('name',oid::regprocedure::text,'owner',proowner::regrole::text,'acl',proacl::text,'body_md5',md5(prosrc)) ORDER BY proname) FROM pg_proc WHERE oid IN ('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure,'public.heartbeat_tournament_leases_v4(text,jsonb,integer)'::regprocedure)"
baseline=query(catalog_sql)
query(gate)
results=[{'case':'Exact current claimant and heartbeat accepted','pass':True}]
query('BEGIN; GRANT EXECUTE ON FUNCTION '+signature+' TO PUBLIC;'+gate+'ROLLBACK;')
assert query(catalog_sql)==baseline
results.append({'case':'Actual autorevoke guard repairs attempted public grant','pass':True,'catalog_fully_restored':True})
for name,fault in [
 ('Missing claimant refused','DROP FUNCTION '+signature+';'),
 ('Weakened takeover lock refused',changed+';'),
 ('Service execute removal refused','REVOKE EXECUTE ON FUNCTION '+signature+' FROM service_role;'),
 ('Owner drift refused','ALTER FUNCTION '+signature+' OWNER TO CURRENT_USER;')
]:
 r=execute('BEGIN;'+fault+gate+'ROLLBACK;')
 assert r.returncode and 'requires the reviewed takeover fence and compatible heartbeat' in r.stderr,(name,r.stderr)
 assert query(catalog_sql)==baseline,name
 results.append({'case':name,'pass':True,'catalog_fully_restored':True})
 print('PASS '+name,flush=True)
(HERE/'lease-prerequisite-gate-results.json').write_text(json.dumps(results,indent=2)+'\n')
