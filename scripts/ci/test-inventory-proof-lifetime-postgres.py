#!/usr/bin/env python3
"""Qualify the actual finite inventory authority against the installed lifetime."""
import argparse,json,os,shutil,subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--pg-bin',default=os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'));p.add_argument('--scratch',required=True);a=p.parse_args()
pg=Path(a.pg_bin);root=Path(tempfile.mkdtemp(prefix='il-',dir=a.scratch));data=root/'d';started=False
psql=[pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',root,'-U','postgres','-d','postgres']
def run(cmd,sql=None,error=None):
 r=subprocess.run([str(x) for x in cmd],input=sql,text=True,capture_output=True,timeout=60)
 if error:assert r.returncode and error in r.stderr,r.stdout+r.stderr
 else:assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def q(sql,error=None):return run(psql,"SET check_function_bodies=false;SET app.weekly_accounting_chunked='on';SET app.accounting_close_memo='on';"+sql,error)
f=json.loads((ROOT/'scripts/ci/fixtures/inventory-proof-lifetime-sources.json').read_text())
migration=next((ROOT/'supabase/migrations').glob('20261016132741_*')).read_text()
matcher=next(x['definition'] for x in f['prerequisites'] if 'sources_match' in x['signature'])
certificate=next(x['definition'] for x in f['prerequisites'] if x['signature'].startswith('fn_accounting_close_certificate('))
try:
 assert ' 17.' in run([pg/'postgres','--version'])
 run([pg/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 with (data/'postgresql.conf').open('a') as h:h.write("\nlisten_addresses=''\nunix_socket_directories='"+str(root)+"'\n")
 run([pg/'pg_ctl','-D',data,'-l',root/'server.log','-w','start']);started=True
 q("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA smarter_private;SET check_function_bodies=false;"+(ROOT/'scripts/qualification/original-flow-eligibility/maintenance-type-source.sql').read_text())
 for x in f['functions']+f['prerequisites']:
  sig=x['signature'];q(x['definition']+';REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,postgres,anon,authenticated,service_role;')
  for entry in x['acl'].strip('{}').split(','):
   role=entry.split('=')[0] or 'PUBLIC';q('GRANT EXECUTE ON FUNCTION '+sig+' TO '+role+';')

 q("CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text);CREATE TABLE accounting_close_certificates(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,value jsonb,certified_at timestamptz);CREATE TABLE smarter_private.original_inventory_restoration_cases(event_id bigint,source_refs jsonb,family text,original_witness jsonb);CREATE TABLE smarter_private.original_inventory_restoration_certificates(event_id bigint,witness_md5 text,proof_md5 text,boundary timestamptz);INSERT INTO smarter_private.original_inventory_restoration_cases SELECT n,'[]','fixture','{}' FROM generate_series(1,245)n;INSERT INTO smarter_private.original_inventory_restoration_certificates SELECT n,'witness','proof','2026-10-12 07:00Z' FROM generate_series(1,245)n;")
 assert q('SELECT smarter_private.original_inventory_proof_sources_match();')=='f'
 assert q('SELECT smarter_private.original_inventory_basis_generation() IS NULL;')=='t','fail-before disables generation'
 # The actual old certificate/source combination qualifies; the installed lifetime breaks exactly one pin.
 q(certificate.replace('public.fn_accounting_close_proof_lifetime()',"interval '12 hours'"))
 q("CREATE OR REPLACE FUNCTION public.fn_accounting_close_proof_lifetime() RETURNS interval LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path='pg_catalog' AS $$ SELECT interval '72 hours' $$;")
 assert q('SELECT smarter_private.original_inventory_proof_sources_match();')=='t'
 old_generation=q('SELECT smarter_private.original_inventory_basis_generation();');assert old_generation.startswith('original-inventory-245-v1:')
 q(certificate)
 # Restore the exact captured lifetime definition after the deliberately changed helper.
 lifetime=next(x['definition'] for x in f['prerequisites'] if x['signature']=='fn_accounting_close_proof_lifetime()');q(lifetime)
 q(migration.replace('COMMIT;','ROLLBACK;'))
 assert q('SELECT smarter_private.original_inventory_proof_sources_match();')=='f','whole migration rollback'
 for injection,error in [("SET LOCAL request.jwt.claim.role='service_role';",'operator_refused'),("SET LOCAL ca.break_window_migration_override='fixture';",'override_refused'),("INSERT INTO supabase_migrations.schema_migrations VALUES('20261016132741');",'history_replay'),("ALTER FUNCTION public.fn_union_week_start(timestamptz) VOLATILE;",'sources_refused'),("ALTER FUNCTION public.fn_accounting_close_proof_lifetime() VOLATILE;",'preimage_refused')]:
  q(migration.replace('BEGIN;','BEGIN;'+injection,1),error)
 # Every original exclusive writer keeps migration admission out.
 for key,error in [("hashtextextended('union-accounting-scheduler',0)",'reader_owned'),("hashtextextended('original-seven-cash-discharge',0)",'discharge_owned'),('530090,1','settlement_lane_owned')]:
  owner=subprocess.Popen([str(x) for x in psql],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  try:
   owner.stdin.write("BEGIN;SELECT pg_advisory_xact_lock("+key+");SELECT 'held';SELECT pg_sleep(2);ROLLBACK;\n");owner.stdin.close()
   assert owner.stdout.readline().strip()==''
   assert owner.stdout.readline().strip()=='held'
   q(migration,error)
  finally:
   assert owner.wait(timeout=5)==0,owner.stderr.read()
 q(migration.replace('BEGIN;',"BEGIN;GRANT EXECUTE ON FUNCTION smarter_private.original_inventory_proof_sources_match() TO anon;",1),'acl_refused')
 q(migration)
 assert q('SELECT smarter_private.original_inventory_proof_sources_match();')=='t'
 generation=q('SELECT smarter_private.original_inventory_basis_generation();');assert generation.startswith('original-inventory-245-v1:') and generation!=old_generation,'lawful generation invalidation'
 q("SET app.weekly_accounting_chunked='on';SET app.accounting_close_memo='on';INSERT INTO accounting_close_certificates VALUES('pnl_clubs','fade0000-0000-0000-0000-000000000001','2026-10-05 07:00Z','2026-10-12 07:00Z',jsonb_build_object('ok',true,'_original_inventory_generation','"+generation+"'),clock_timestamp()-interval '24 hours');")
 call="SELECT smarter_private.inventory_basis_cache_read('%s',false,'pnl_clubs','fade0000-0000-0000-0000-000000000001','2026-10-05 07:00Z','2026-10-12 07:00Z')"
 assert json.loads(q(call%generation))=={'ok':True},'actual 24-hour certificate cached'
 assert q((call%old_generation)+' IS NULL')=='t','old generation refused'
 q("UPDATE accounting_close_certificates SET certified_at=clock_timestamp()-interval '73 hours';")
 assert q((call%generation)+' IS NULL')=='t','72-hour expiry remains bounded'
 q(migration,'preimage_refused')
 q("BEGIN;ALTER FUNCTION public.fn_accounting_close_proof_lifetime() VOLATILE;DO $$BEGIN IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM false THEN RAISE EXCEPTION 'drift_not_refused';END IF;END$$;ROLLBACK;")
 assert q("SELECT md5(pg_get_functiondef('public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)'::regprocedure));")=='f4d3b9bd8722bb1d8f13f0615ff9537f','reader byte-identical'
 print('PASS inventory lifetime: actual 40 sources fail before; full migration passes; generation changes; actual 24-hour cache read; stale generation and 73-hour proof refuse; drift/operator/history/override refusal; rollback; duplicate refuses; unchanged certificate')
finally:
 if started:run([pg/'pg_ctl','-D',data,'-m','fast','-w','stop'])
 shutil.rmtree(root)
