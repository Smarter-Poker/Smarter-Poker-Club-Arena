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
migration=next((ROOT/'supabase/migrations').glob('20261016133404_*')).read_text()
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
 # Whole-source rollback must leave the mismatched reader untouched.
 q(migration.replace('COMMIT;','ROLLBACK;'))
 assert q('SELECT smarter_private.original_inventory_proof_sources_match();')=='f'
 q(migration.replace('BEGIN;',"BEGIN;ALTER FUNCTION public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz) VOLATILE;",1),'restored body does not match')
 q(migration.replace('BEGIN;',"BEGIN;ALTER FUNCTION public.fn_union_week_start(timestamptz) VOLATILE;",1),'inventory proof sources still do not match')
 q(migration)
 assert q('SELECT smarter_private.original_inventory_proof_sources_match();')=='t'
 generation=q('SELECT smarter_private.original_inventory_basis_generation();');assert generation.startswith('original-inventory-245-v1:')
 assert q("SELECT md5(pg_get_functiondef('public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)'::regprocedure));")=='7b4a5f4572a45db069b6058899614021'
 assert q("SELECT fn_accounting_close_proof_lifetime()=interval '72 hours';")=='t','other proof pieces retain the longer lifetime'
 q("INSERT INTO accounting_close_certificates VALUES('pnl_clubs','fade0000-0000-0000-0000-000000000001','2026-10-05 07:00Z','2026-10-12 07:00Z',jsonb_build_object('ok',true,'_original_inventory_generation','"+generation+"'),clock_timestamp()-interval '6 hours');")
 call="SELECT smarter_private.inventory_basis_cache_read('%s',false,'pnl_clubs','fade0000-0000-0000-0000-000000000001','2026-10-05 07:00Z','2026-10-12 07:00Z')"
 assert json.loads(q(call%generation))=={'ok':True},'actual fresh sealed certificate cache read'
 assert q((call%'unrelated-generation')+' IS NULL')=='t','different generation refused'
 q("UPDATE accounting_close_certificates SET certified_at=clock_timestamp()-interval '13 hours';")
 assert q((call%generation)+' IS NULL')=='t','sealed reader keeps its 12-hour expiry'
 q(migration)
 assert q('SELECT smarter_private.original_inventory_basis_generation();')==generation,'already-sealed source is a no-op'
 assert q("SELECT md5(pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure));")=='4a98179afccf2d31c127f50ed5ab9270','inventory seal byte-identical'
 assert q("SELECT proacl::text FROM pg_proc WHERE oid='public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)'::regprocedure;")=='{postgres=X/postgres,service_role=X/postgres}','reader ACL preserved'
 print('PASS installed sealed reader: actual 40 sources fail before/pass after; whole-source rollback; unknown reader and other source drift refuse; original seal preserved; actual fresh cache read; different generation and expired certificate refuse; longer other-proof lifetime preserved; already-sealed no-op')

finally:
 if started:run([pg/'pg_ctl','-D',data,'-m','fast','-w','stop'])
 shutil.rmtree(root)
