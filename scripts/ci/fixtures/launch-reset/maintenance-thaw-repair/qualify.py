#!/usr/bin/env python3
"""Bounded native TLS checks of the actual maintained migration installer."""
from pathlib import Path
import argparse,hashlib,json,os,re,shutil,socket,subprocess,tempfile,time,sys
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--installer',type=Path,required=True);p.add_argument('--repository',type=Path,required=True)
p.add_argument('--pgbin',default=os.environ.get('PGBIN','/opt/homebrew/bin'))
p.add_argument('--node',default=shutil.which('node'));p.add_argument('--openssl',default=shutil.which('openssl'))
p.add_argument('--scratch',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
a=p.parse_args();pg=Path(a.pgbin);a.scratch.mkdir(parents=True,exist_ok=True)
original=a.installer.read_bytes();source_sha=hashlib.sha256(original).hexdigest()
fixture_pins=json.loads(Path(__file__).with_name('fixture-pins.json').read_text())
assert set(fixture_pins)=={p.name for p in Path(__file__).parent.glob('*.sql')},'Original thaw fixture membership changed'
for name,digest in fixture_pins.items():
 assert hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()==digest,'Original thaw fixture bytes changed: '+name
with tempfile.TemporaryDirectory(prefix='installer-native-',dir=a.scratch) as tmp:
 root=Path(tmp);work=root/'work';ci=work/'scripts/ci';ci.mkdir(parents=True);migrations=work/'supabase/migrations';migrations.mkdir(parents=True)
 copied=set()
 def copy_module(name):
  if name in copied:return
  copied.add(name);src=a.repository/'scripts/ci'/name;text=src.read_text();(ci/name).write_text(text)
  for dep in re.findall(r"(?:from\s+|import\s*)['\"]\./([^'\"]+\.mjs)['\"]",text):copy_module(dep)
 for dep in ['check-migrations-are-live.mjs','migration-concurrent-preamble.mjs','contract-index-recovery.mjs','final-table-cleanup-batches.mjs']:copy_module(dep)
 installer=ci/'apply-recorded-migration.mjs';installer.write_bytes(original)
 # Root imports also belong to the isolated dependency closure.
 for dep in re.findall(r"(?:from\s+|import\s*)['\"]\./([^'\"]+\.mjs)['\"]",original.decode('utf-8')):copy_module(dep)
 copy_module('settlement-lane.mjs')
 copy_module('accounting-migration-admission.mjs')
 (ci/'maintenance-thaw-repair.mjs').write_bytes((a.installer.parent/'maintenance-thaw-repair.mjs').read_bytes())
 copy_module('test_settlement_lane.mjs')
 # A private copy of only the existing locked pg dependency closure. No shared
 # node_modules mutation, package installation, credential access or symlinks.
 modules=work/'node_modules';modules.mkdir();seen=set()
 def copy_package(name):
  if name in seen:return
  seen.add(name);src=a.repository/'node_modules'/name
  if not src.is_dir():raise AssertionError('Locked pg dependency missing: '+name)
  dest=modules/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copytree(src,dest)
  meta=json.loads((src/'package.json').read_text())
  for dep in meta.get('dependencies',{}):copy_package(dep)
 copy_package('pg')
 cert=root/'server.crt';key=root/'server.key'
 def cmd(argv,input=None,env=None,cwd=None,expect=0):
  r=subprocess.run([str(x) for x in argv],input=input,text=True,capture_output=True,env=env,cwd=cwd,timeout=40)
  if expect is not None:assert r.returncode==expect,(r.returncode,r.stdout[-1000:],r.stderr[-1500:])
  return r
 cmd([a.openssl,'req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-addext','basicConstraints=critical,CA:TRUE']);os.chmod(key,0o600)
 listener=socket.socket();listener.bind(('127.0.0.1',0));port=listener.getsockname()[1];listener.close()
 data=root/'pgdata';sock=root/'socket';sock.mkdir()
 cmd([pg/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
 with (data/'postgresql.conf').open('a') as f:f.write(f"\nlisten_addresses='127.0.0.1'\nport={port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='{cert}'\nssl_key_file='{key}'\n")
 with (data/'pg_hba.conf').open('a') as f:f.write('\nhostssl all all 127.0.0.1/32 trust\n')
 # initdb host reject precedes appended trust; put the isolated TLS rule first.
 hba=data/'pg_hba.conf';hba.write_text('hostssl all all 127.0.0.1/32 trust\n'+hba.read_text())
 env=dict(os.environ,PGHOST='127.0.0.1',PGPORT=str(port),PGUSER='postgres',PGDATABASE='postgres',PGSSLMODE='verify-full',PGSSLROOTCERT=str(cert))
 q=[pg/'psql','-X','-At','-v','ON_ERROR_STOP=1']
 def sql(s):return cmd(q,s,env=env).stdout.strip()
 clock=work/'fixture-clock.cjs';clock.write_text("Date.prototype.getUTCMinutes=function(){return Number(process.env.FIXTURE_MINUTE)};\n")
 drop=work/'fixture-drop.cjs';drop.write_text("const pg=require('pg');const old=pg.Client.prototype.query;pg.Client.prototype.query=function(...args){const answer=old.apply(this,args);if(typeof args[0]==='string'&&args[0].includes('DO $ca_atomic_history_guard$'))return answer.then(r=>{this.connection.stream.destroy();return r});return answer};\n")
 child=dict(os.environ,DATABASE_URL=f'postgresql://postgres@localhost:{port}/postgres?sslmode=require',FIXTURE_MINUTE='20')
 def apply(name,minute='20',disconnect=False,ca=cert,lane=False,repair=False,extra=[]):
  options=['--require',clock]+(['--require',drop] if disconnect else [])
  return cmd([a.node,*options,installer,'--migration',name,'--ssl-root-cert',ca,*(['--settlement-lane'] if lane else []),*(['--maintenance-thaw-repair'] if repair else []),*extra],env=dict(child,FIXTURE_MINUTE=minute,APPLY_DDL_ADMISSION_WAIT_MS='1500',APPLY_DDL_ADMISSION_POLL_MS='200'),cwd=work,expect=None)
 # The installer waits out a database DDL refusal (production: 12 min,
 # apply-recorded-migration.mjs); this fixture shortens it so each expected
 # refusal still ends, with nothing sent, inside the 40 s command budget.
 def migration(version,table):
  name=version+'_'+table+'.sql';text=f"BEGIN;\nCREATE TABLE public.{table}(id integer PRIMARY KEY);\nDO $$ BEGIN PERFORM 'Dollar $$ and apostrophe '' remain exact'; END $$;\nCOMMIT;\n"
  # Nested same dollar delimiter would be invalid SQL; exercise independent
  # SQL quoting and the original replacement-dollar regression with a comment.
  text=f"BEGIN;\nCREATE TABLE public.{table}(id integer PRIMARY KEY);\nDO $fixture$ BEGIN PERFORM 'apostrophe '' exact'; END $fixture$;\n-- replacement metacharacters $$ $& $` $' remain byte exact\nCOMMIT;\n"
  (migrations/name).write_text(text);return name,text
 try:
  started=cmd([pg/'pg_ctl','-D',data,'-l',root/'server.log','-w','start'],expect=None)
  assert started.returncode==0,(root/'server.log').read_text()[-2000:]
  fixture=Path(__file__).parent
  sql("CREATE SCHEMA auth; CREATE ROLE service_role; CREATE ROLE migration_actor LOGIN; GRANT postgres TO migration_actor; CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]);")
  sql("CREATE TABLE public.engine_maintenance_break(id boolean PRIMARY KEY,phase text NOT NULL,announced_at timestamptz NOT NULL,break_started_at timestamptz,break_ends_at timestamptz,enforce_freeze boolean NOT NULL,ownership_token uuid NOT NULL); CREATE TABLE public.engine_maintenance_thaws(contract_version integer,release_target_at timestamptz,shifted jsonb); CREATE TABLE public.ca_break_window_migration_overrides(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),txid bigint NOT NULL,reason text NOT NULL,session_role text NOT NULL,application_name text,first_command text NOT NULL,query_snippet text);")
  for fn in ['role','fn_active_maintenance_release_boundary','fn_entry_purchases_frozen','fn_ca_break_window_refuses_migrations','fn_ca_break_window_governs','fn_ca_stage_b_ledger_bootstrap_allowed','fn_ca_break_window_ddl_guard']:
   sql((fixture/(fn+'.sql')).read_text())
  sql("ALTER FUNCTION public.fn_ca_break_window_refuses_migrations(timestamptz) RENAME TO fixture_original_break_window_refusal; CREATE FUNCTION public.fn_ca_break_window_refuses_migrations(timestamptz) RETURNS text LANGUAGE sql AS $$SELECT public.fixture_original_break_window_refusal(date_trunc('hour',$1)+interval '20 minutes')$$;")
  sql((fixture/'operator-tables.sql').read_text())
  sql((fixture/'seven-originals.sql').read_text())
  sql("CREATE EVENT TRIGGER maintenance_ddl ON ddl_command_end EXECUTE FUNCTION public.fn_ca_break_window_ddl_guard();")
  # Actual original guard and helpers retain their bytes. Only isolated time
  # dispatch is scheduled outside the real UTC hourly window; no SQL clock shim.
  sql("INSERT INTO public.engine_maintenance_break VALUES(true,'counting_down',clock_timestamp()-interval '12 minutes',clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '5 minutes',true,'0345bcfa-8b9c-4d70-9d63-5eb20130ed8c');")
  child['DATABASE_URL']=f'postgresql://migration_actor@localhost:{port}/postgres?options=-c%20role%3Dpostgres'
  name='20261013133012_scoped_launch_operator_accepts_authoritative_json_claims.sql'
  source=(a.repository/'supabase/migrations'/name).read_text();(migrations/name).write_text(source)
  old=apply(name);assert old.returncode==1 and 'database would refuse DDL' in old.stderr,(old.stdout,old.stderr)
  assert sql('SELECT count(*) FROM supabase_migrations.schema_migrations;')=='0'
  assert sql('SELECT count(*) FROM public.ca_break_window_migration_overrides;')=='0'
  for extra in [['--dry-run'],['--settlement-lane']]:
   r=apply(name,repair=True,extra=extra);assert r.returncode==1 and 'exact 33012' in r.stderr,(r.stdout,r.stderr)
  (migrations/name).write_text(source+'\n')
  r=apply(name,repair=True);assert r.returncode==1 and 'exact 33012' in r.stderr
  (migrations/name).write_text(source)
  sql("UPDATE engine_maintenance_break SET break_ends_at=clock_timestamp()+interval '1 minute';")
  r=apply(name,repair=True);assert r.returncode==1 and 'expired coherent' in r.stderr,(r.stdout,r.stderr)
  sql("UPDATE engine_maintenance_break SET break_ends_at=clock_timestamp()-interval '5 minutes';")
  badname='20261013133013_wrong_repair.sql';(migrations/badname).write_text(source)
  r=apply(badname,repair=True);assert r.returncode==1 and 'exact 33012' in r.stderr
  configured=child['DATABASE_URL'];child['DATABASE_URL']=f'postgresql://migration_actor@localhost:{port}/postgres'
  r=apply(name,repair=True);assert r.returncode==1 and 'expired coherent' in r.stderr
  child['DATABASE_URL']=configured
  fixed=apply(name,minute='50',repair=True);assert fixed.returncode==1 and 'break window' in fixed.stderr
  sql('ALTER EVENT TRIGGER maintenance_ddl DISABLE;')
  r=apply(name,repair=True);assert r.returncode==1 and 'original audit missing' in r.stderr,(r.stdout,r.stderr)
  assert sql('SELECT count(*) FROM supabase_migrations.schema_migrations;')=='0'
  sql('ALTER EVENT TRIGGER maintenance_ddl ENABLE;')
  passed=apply(name,repair=True);assert passed.returncode==0,(passed.stdout,passed.stderr)
  assert json.loads(sql("SELECT to_json(statements) FROM supabase_migrations.schema_migrations;"))==[source]
  assert sql("SELECT count(*)=1 AND bool_and(session_role='migration_actor' AND application_name='apply-recorded-migration' AND first_command LIKE 'CREATE FUNCTION public.fn_ca_engine_operator_command%') FROM ca_break_window_migration_overrides;")=='t'
  assert sql("SELECT enforce_freeze AND phase='counting_down' FROM engine_maintenance_break;")=='t'
  again=apply(name,repair=True);assert again.returncode==0 and 'ALREADY-APPLIED' in again.stdout
  assert sql('SELECT count(*) FROM public.ca_break_window_migration_overrides;')=='1'
  result={'qualified':True,'installer_sha256':source_sha,'migration_sha256':hashlib.sha256(source.encode()).hexdigest(),'actual_original_event_trigger_audited':True,'old_installer_refuses_before_send':True,'exact_file_history_preserved':True,'freeze_preserved':True,'changed_source_refused':True,'dry_run_and_other_lane_refused':True,'unexpired_freeze_refused':True,'already_applied_no_replay':True,'production_actions':False,'missing_original_audit_rolls_back':True,'wrong_authority_refused':True,'wrong_filename_refused':True,'fixed_hourly_window_refused':True,'original_refusal_body_clock_fixture_only':True,'helper_sha256':hashlib.sha256((a.installer.parent/'maintenance-thaw-repair.mjs').read_bytes()).hexdigest()}
  a.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
 finally:cmd([pg/'pg_ctl','-D',data,'-m','immediate','-w','stop'],expect=None)
