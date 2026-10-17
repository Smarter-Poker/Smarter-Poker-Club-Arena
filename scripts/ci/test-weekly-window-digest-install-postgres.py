#!/usr/bin/env python3
"""PG17 actual two-owner digest migration atomic installation and authority qualification.
Local Unix sockets only. Source/behavior suites run in their separate maintained children.
"""
import argparse,hashlib,json,os,shutil,subprocess,sys,tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--repo',type=Path,default=Path(__file__).resolve().parents[2]);p.add_argument('--fixtures',type=Path);p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--scratch',type=Path,required=True);a=p.parse_args()
if os.environ.get('DATABASE_URL'):raise RuntimeError('remote connection forbidden')
R=a.repo.resolve();S=a.scratch.resolve();pg=a.pg_bin.resolve();F=a.fixtures.resolve() if a.fixtures else R/'scripts/ci/fixtures/weekly-window-digests'
if sys.platform=='darwin' and not str(S).startswith('/Volumes/SmarterWork/agent-work/'):raise RuntimeError('external SSD scratch required')
pins=json.loads((F/'replacement.json').read_text());functions=pins['functions'];assert len(functions)==2
version=pins.get('migration_version','20261016214904');prefix=pins.get('error_prefix','window_digest');migration=next((R/'supabase/migrations').glob(version+'_*')).read_text()
assert migration.count('\nBEGIN;')==1 and migration.count('\nCOMMIT;')==1,'one atomic transaction required'
assert 'CREATE INDEX' not in migration.upper(),'no index preamble belongs to digest correction'
for f in functions:
 f['before']=(F/f['before_file']).read_text();f['after']=(F/f['after_file']).read_text()
 assert hashlib.md5(f['before'].encode()).hexdigest()==f['before_md5']
 assert hashlib.md5(f['after'].encode()).hexdigest()==f['after_md5']
 assert f['before_md5'] in migration and f['after_md5'] in migration
 assert f['before'].count(f['old'])==1 and f['before'].replace(f['old'],f['new'])==f['after']
 assert f['after'].replace(f['new'],f['old'])==f['before']
C=Path(tempfile.mkdtemp(prefix='di-',dir=S));D=C/'d';started=False;holder=None
psql=[pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',C,'-U','postgres','-d','postgres']
def run(cmd,sql=None,error=None):
 r=subprocess.run(list(map(str,cmd)),input=sql,text=True,capture_output=True,timeout=90)
 if error:assert r.returncode and error in r.stderr,r.stdout+r.stderr
 else:assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def q(sql,error=None):return run(psql,sql,error)
signatures=','.join("'"+f['signature']+"'::regprocedure" for f in functions)
metadata="SELECT jsonb_agg(jsonb_build_object('signature',oid::regprocedure::text,'owner',proowner,'definer',prosecdef,'volatility',provolatile,'config',proconfig,'acl',proacl) ORDER BY oid) FROM pg_proc WHERE oid IN ("+signatures+")"
def hashes():return [q("SELECT md5(pg_get_functiondef('"+f['signature']+"'::regprocedure))")for f in functions]
def body_with(inject):return migration.replace('BEGIN;','BEGIN;'+inject,1)
expected_before=[f['before_md5']for f in functions];expected_after=[f['after_md5']for f in functions];tests=[]
try:
 assert ' 17.' in run([pg/'postgres','--version'])
 run([pg/'initdb','-D',D,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 with (D/'postgresql.conf').open('a')as h:h.write("\nlisten_addresses=''\nunix_socket_directories='"+str(C)+"'\ntemp_file_limit='256MB'\n")
 run([pg/'pg_ctl','-D',D,'-l',C/'server.log','-w','start']);started=True
 q("CREATE ROLE service_role;CREATE ROLE fixture_other;CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY);CREATE TABLE fixture_control(frozen boolean,boundary timestamptz,seal boolean);INSERT INTO fixture_control VALUES(false,NULL,true);CREATE SCHEMA smarter_private;CREATE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql AS $$SELECT seal FROM public.fixture_control$$;CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql AS $$SELECT frozen FROM fixture_control$$;CREATE FUNCTION fn_active_maintenance_release_boundary()RETURNS timestamptz LANGUAGE sql AS $$SELECT boundary FROM fixture_control$$;")
 for f in functions:q(f['before']+';REVOKE ALL ON FUNCTION '+f['signature']+' FROM PUBLIC;GRANT EXECUTE ON FUNCTION '+f['signature']+' TO service_role;')
 assert hashes()==expected_before
 authority=q(metadata)
 cases=[("UPDATE fixture_control SET seal=false;",'inventory_seal_required'),("UPDATE fixture_control SET seal=NULL;",'inventory_seal_required'),("UPDATE fixture_control SET frozen=true;",'freeze_or_override_refused'),("UPDATE fixture_control SET boundary=clock_timestamp();",'freeze_or_override_refused'),("SET LOCAL ca.break_window_migration_override='fixture';",'freeze_or_override_refused'),("SET LOCAL request.jwt.claims='{}';",'operator_refused'),("SET LOCAL request.jwt.claim.role='service_role';",'operator_refused'),("SET LOCAL ROLE service_role;",'operator_refused'),("INSERT INTO supabase_migrations.schema_migrations VALUES('"+version+"');",'history_replay')]
 for f in functions:
  sig=f['signature'];drift=f['before'].replace('BEGIN\n','BEGIN\n-- native source drift\n',1)
  assert drift!=f['before']
  cases.extend([(drift+';','preimage_authority_refused'),('GRANT EXECUTE ON FUNCTION '+sig+' TO PUBLIC;','preimage_authority_refused'),('REVOKE EXECUTE ON FUNCTION '+sig+' FROM service_role;','preimage_authority_refused'),('ALTER FUNCTION '+sig+' SECURITY DEFINER;','preimage_authority_refused'),('ALTER FUNCTION '+sig+' IMMUTABLE;','preimage_authority_refused'),('ALTER FUNCTION '+sig+' SET search_path=public,pg_temp;','preimage_authority_refused'),('ALTER FUNCTION '+sig+' OWNER TO fixture_other;','preimage_authority_refused')])
 for inject,error in cases:
  q(body_with(inject),prefix+'_'+error);assert hashes()==expected_before;assert q(metadata)==authority;tests.append(error+': '+inject.split(';')[0][:110])
 # A real second backend owns the original scheduler lock; this is a local finite concurrency fixture.
 holder=subprocess.Popen(list(map(str,psql)),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 holder.stdin.write("SELECT pg_advisory_lock(hashtextextended('union-accounting-scheduler',0));\n\\echo fixture_lock_ready\n");holder.stdin.flush()
 for _ in range(5):
  if holder.stdout.readline().strip()=='fixture_lock_ready':break
 else:raise RuntimeError('native scheduler owner did not acknowledge')
 q(migration,prefix+'_scheduler_owned');assert hashes()==expected_before
 holder.stdin.write("SELECT pg_advisory_unlock(hashtextextended('union-accounting-scheduler',0));\n\\q\n");holder.stdin.flush();holder.communicate(timeout=10);assert holder.returncode==0;holder=None;tests.append('other-backend scheduler ownership refused')
 q(migration.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'fixture_whole_transaction_abort';END$$;COMMIT;",1),'fixture_whole_transaction_abort')
 assert hashes()==expected_before and q(metadata)==authority;tests.append('both complete source replacements rolled back together after successful installation')
 # Fault after first replacement must roll back it and second-owner drift in the same transaction.
 anchor=pins.get('second_install_anchor','DO $install_earned$');assert migration.count(anchor)==1,'unique second installation anchor required'
 drift=functions[1]['before'].replace('BEGIN\n','BEGIN\n-- native second-stage source drift\n',1)
 q(migration.replace(anchor,drift+';\n'+anchor,1),prefix+'_preimage_authority_refused')
 assert hashes()==expected_before and q(metadata)==authority;tests.append('second owner changed after first replacement causes whole transaction rollback')
 q(migration.replace('DO $post$BEGIN','UPDATE fixture_control SET seal=false;DO $post$BEGIN',1),prefix+'_inventory_seal_changed')
 assert hashes()==expected_before and q(metadata)==authority and q('SELECT seal FROM fixture_control')=='t';tests.append('changed post-install seal aborts both replacements and restores original seal')
 q(migration);assert hashes()==expected_after and q(metadata)==authority
 for f in functions:assert q("SELECT pg_get_functiondef('"+f['signature']+"'::regprocedure)")==f['after'].strip()
 tests.append('both exact after definitions and metadata preserved')
 q(migration,prefix+'_preimage_authority_refused');assert hashes()==expected_after and q(metadata)==authority;tests.append('unrecorded after-images cannot be installed again')
 q("INSERT INTO supabase_migrations.schema_migrations VALUES('"+version+"');");q(migration,prefix+'_history_replay');assert hashes()==expected_after;assert q(metadata)==authority;tests.append('recorded exact migration replay refused')
 print(json.dumps({'qualification':'passed','migration_version':version,'migration_sha256':hashlib.sha256(migration.encode()).hexdigest(),'migration_md5':hashlib.md5(migration.encode()).hexdigest(),'migration_bytes':len(migration.encode()),'before_hashes':expected_before,'after_hashes':expected_after,'full_actual_functions_loaded':True,'transactional_ddl_only':True,'tests':tests,'full_financial_close_qualified':False},indent=2))
finally:
 if holder:
  holder.stdin.close();holder.wait(timeout=10)
 if started:run([pg/'pg_ctl','-D',D,'-m','fast','-w','stop'])
 shutil.rmtree(C)
