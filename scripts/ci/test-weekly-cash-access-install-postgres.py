#!/usr/bin/env python3
"""PG17 actual weekly cash-access migration installation/authority qualification.
Concurrent index persists across a later transaction rollback, by design.
This does not qualify the complete financial close or duplicate boundary suites.
"""
import argparse,hashlib,json,os,shutil,subprocess,sys,tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--repo',type=Path,default=Path(__file__).resolve().parents[2]);p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--scratch',type=Path,required=True);a=p.parse_args()
if os.environ.get('DATABASE_URL'):raise RuntimeError('remote connection forbidden')
R=a.repo.resolve();S=a.scratch.resolve();pg=a.pg_bin.resolve()
if sys.platform=='darwin' and not str(S).startswith('/Volumes/SmarterWork/agent-work/'):raise RuntimeError('external SSD scratch required')
C=Path(tempfile.mkdtemp(prefix='ci-',dir=S));D=C/'d';started=False
psql=[pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',C,'-U','postgres','-d','postgres']
def run(cmd,sql=None,error=None):
 r=subprocess.run(list(map(str,cmd)),input=sql,text=True,capture_output=True,timeout=90)
 if error:assert r.returncode and error in r.stderr,r.stdout+r.stderr
 else:assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def q(sql,error=None):return run(psql,sql,error)
F=R/'scripts/ci/fixtures/weekly-cash-access';before=(F/'commission-before.sql').read_text();after=(F/'commission-after.sql').read_text()
file=next((R/'supabase/migrations').glob('20261016200904_*'));migration=file.read_text();sig='public.fn_assert_cash_commission_period(uuid,uuid,timestamptz,timestamptz)'
assert hashlib.md5(before.encode()).hexdigest()=='3143ddd4ec0f5eb3312700a1dd2b5b83'
assert hashlib.md5(after.encode()).hexdigest()=='0df1c3e9fe3e1a0e53a043baf57127d7'
# The maintained parser runs from the specified repository, with no second SQL splitter.
r=subprocess.run(['node','--input-type=module','-e',"import{readFileSync}from'node:fs';import{splitConcurrentPreamble}from'./scripts/ci/migration-concurrent-preamble.mjs';process.stdout.write(JSON.stringify(splitConcurrentPreamble(readFileSync(process.argv[1],'utf8'))))",str(file)],cwd=R,text=True,capture_output=True,timeout=20)
assert r.returncode==0,r.stderr;shape=json.loads(r.stdout);assert shape['ok'] and len(shape['indexes'])==1
body=shape['body'];ix=shape['indexes'][0];tests=[]
try:
 assert ' 17.' in run([pg/'postgres','--version'])
 run([pg/'initdb','-D',D,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 with (D/'postgresql.conf').open('a') as h:h.write("\nlisten_addresses=''\nunix_socket_directories='"+str(C)+"'\n")
 run([pg/'pg_ctl','-D',D,'-l',C/'server.log','-w','start']);started=True
 q("CREATE ROLE service_role;CREATE ROLE fixture_other;CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY);CREATE TABLE fixture_control(frozen boolean,boundary timestamptz);INSERT INTO fixture_control VALUES(false,NULL);CREATE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT frozen FROM fixture_control$$;CREATE FUNCTION fn_active_maintenance_release_boundary() RETURNS timestamptz LANGUAGE sql AS $$SELECT boundary FROM fixture_control$$;CREATE TABLE accounting_cash_rake_sources(club_id uuid,coordinator_union_id uuid,earned_at timestamptz);CREATE TABLE rake_records(id uuid PRIMARY KEY,created_at timestamptz,rake_amount numeric,is_tournament boolean,tournament_id uuid);CREATE INDEX rake_records_cash_positive_created ON rake_records(created_at,id) WHERE rake_amount>0 AND is_tournament IS NOT TRUE AND tournament_id IS NULL;"+before+';REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC;GRANT EXECUTE ON FUNCTION '+sig+' TO service_role;')
 metadata="SELECT jsonb_build_object('owner',proowner,'definer',prosecdef,'volatility',provolatile,'config',proconfig,'acl',proacl) FROM pg_proc WHERE oid='"+sig+"'::regprocedure"
 authority=q(metadata)
 q(ix['statement']);tests.append('actual concurrent preamble accepted and executed outside transaction')
 assert q("SELECT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid='"+ix['name']+"'::regclass")=='t'
 cases=[
 ("UPDATE fixture_control SET frozen=true;",'weekly_cash_access_freeze_or_override_refused'),
 ("UPDATE fixture_control SET boundary=clock_timestamp();",'weekly_cash_access_freeze_or_override_refused'),
 ("SET LOCAL ca.break_window_migration_override='fixture';",'weekly_cash_access_freeze_or_override_refused'),
 ("SET LOCAL request.jwt.claims='{}';",'weekly_cash_access_operator_refused'),
 ("SET LOCAL request.jwt.claim.role='service_role';",'weekly_cash_access_operator_refused'),
 ("SET LOCAL ROLE service_role;",'weekly_cash_access_operator_refused'),
 ("INSERT INTO supabase_migrations.schema_migrations VALUES('20261016200904');",'weekly_cash_access_history_replay'),
 ('GRANT EXECUTE ON FUNCTION '+sig+' TO PUBLIC;','weekly_cash_access_preimage_authority_refused'),
 ('REVOKE EXECUTE ON FUNCTION '+sig+' FROM service_role;','weekly_cash_access_preimage_authority_refused'),
 ('ALTER FUNCTION '+sig+' SECURITY INVOKER;','weekly_cash_access_preimage_authority_refused'),
 ('ALTER FUNCTION '+sig+' VOLATILE;','weekly_cash_access_preimage_authority_refused'),
 ('ALTER FUNCTION '+sig+" SET search_path=public,pg_temp;",'weekly_cash_access_preimage_authority_refused'),
 ('ALTER FUNCTION '+sig+' OWNER TO fixture_other;','weekly_cash_access_preimage_authority_refused'),
 ('DROP INDEX '+ix['name']+';','weekly_cash_access_exact_index_required'),
 ('DROP INDEX '+ix['name']+';CREATE INDEX '+ix['name']+' ON accounting_cash_rake_sources(coordinator_union_id,earned_at,club_id);','weekly_cash_access_exact_index_required'),
 ("UPDATE pg_index SET indisvalid=false WHERE indexrelid='"+ix['name']+"'::regclass;",'weekly_cash_access_exact_index_required'),
 ('DROP INDEX rake_records_cash_positive_created;','weekly_cash_access_partial_index_required'),
 ('ALTER TABLE rake_records DROP CONSTRAINT rake_records_pkey;','weekly_cash_access_rake_identity_required'),
 (before.replace("RAISE EXCEPTION 'invalid_cash_commission_scope'","RAISE EXCEPTION 'fixture_source_drift'")+';','weekly_cash_access_preimage_authority_refused')]
 for inject,error in cases:
  q(body.replace('BEGIN;','BEGIN;'+inject,1),error)
  assert q("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))")=='3143ddd4ec0f5eb3312700a1dd2b5b83'
  assert q(metadata)==authority
  tests.append(error+': '+inject.split(';')[0])
 q(body.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'fixture_whole_transaction_abort';END$$;COMMIT;"),'fixture_whole_transaction_abort')
 assert q("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))")=='3143ddd4ec0f5eb3312700a1dd2b5b83';assert q(metadata)==authority
 assert q("SELECT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid='"+ix['name']+"'::regclass")=='t'
 tests.append('forced body rollback restores actual source/authority; previously committed concurrent index correctly remains')
 q(body)
 assert q("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))")=='0df1c3e9fe3e1a0e53a043baf57127d7';assert q(metadata)==authority
 assert q("SELECT pg_get_functiondef('"+sig+"'::regprocedure)")==after.strip()
 tests.append('actual candidate installs exact complete after definition and preserves owner ACL definer volatility search path')
 q("INSERT INTO supabase_migrations.schema_migrations VALUES('20261016200904');")
 q(ix['statement']);q(body,'weekly_cash_access_history_replay')
 assert q("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))")=='0df1c3e9fe3e1a0e53a043baf57127d7'
 tests.append('same concurrent preamble safely reuses valid index; recorded body replay refused')
 print(json.dumps({'qualification':'passed','migration_md5':hashlib.md5(migration.encode()).hexdigest(),'migration_bytes':len(migration.encode()),'before_md5':'3143ddd4ec0f5eb3312700a1dd2b5b83','after_md5':'0df1c3e9fe3e1a0e53a043baf57127d7','full_actual_function_loaded':True,'maintained_concurrent_preamble_parser':True,'tests':tests,'full_financial_close_qualified':False},indent=2))
finally:
 if started:run([pg/'pg_ctl','-D',D,'-m','fast','-w','stop'])
 shutil.rmtree(C)
