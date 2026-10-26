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
 copy_module('maintenance-thaw-repair.mjs')
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
 def apply(name,minute='20',disconnect=False,ca=cert,lane=False,wait_ms=None):
  options=['--require',clock]+(['--require',drop] if disconnect else [])
  extra={} if wait_ms is None else {'APPLY_DDL_ADMISSION_WAIT_MS':str(wait_ms),'APPLY_DDL_ADMISSION_POLL_MS':'200'}
  return cmd([a.node,*options,installer,'--migration',name,'--ssl-root-cert',ca,*(['--settlement-lane'] if lane else [])],env=dict(child,FIXTURE_MINUTE=minute,**extra),cwd=work,expect=None)
 def migration(version,table):
  name=version+'_'+table+'.sql';text=f"BEGIN;\nCREATE TABLE public.{table}(id integer PRIMARY KEY);\nDO $$ BEGIN PERFORM 'Dollar $$ and apostrophe '' remain exact'; END $$;\nCOMMIT;\n"
  # Nested same dollar delimiter would be invalid SQL; exercise independent
  # SQL quoting and the original replacement-dollar regression with a comment.
  text=f"BEGIN;\nCREATE TABLE public.{table}(id integer PRIMARY KEY);\nDO $fixture$ BEGIN PERFORM 'apostrophe '' exact'; END $fixture$;\n-- replacement metacharacters $$ $& $` $' remain byte exact\nCOMMIT;\n"
  (migrations/name).write_text(text);return name,text
 try:
  started=cmd([pg/'pg_ctl','-D',data,'-l',root/'server.log','-w','start'],expect=None)
  assert started.returncode==0,(root/'server.log').read_text()[-2000:]
  sql('CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]);')
  sql((Path(__file__).parent/'fixtures'/'launch-reset'/'installer'/'launch_reset_installer_fixture.sql').read_text())
  name,text=migration('20261012010101','atomic_success');r=apply(name);assert r.returncode==0,(r.stdout,r.stderr)
  rows=json.loads(sql("SELECT json_build_object('name',name,'statements',statements) FROM supabase_migrations.schema_migrations WHERE version='20261012010101';"));assert rows=={'name':'atomic_success','statements':[text]};assert sql("SELECT to_regclass('public.atomic_success') IS NOT NULL;")=='t'
  # Exact already-installed operation is read-only and does not re-run DDL.
  again=apply(name);assert again.returncode==0 and 'ALREADY-APPLIED' in again.stdout
  sql("CREATE FUNCTION supabase_migrations.fixture_reject_history() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.name='history_failure' THEN RAISE EXCEPTION 'fixture history failure' USING ERRCODE='23514';END IF;RETURN NEW;END$$;CREATE TRIGGER fixture_reject BEFORE INSERT ON supabase_migrations.schema_migrations FOR EACH ROW EXECUTE FUNCTION supabase_migrations.fixture_reject_history();")
  name,_=migration('20261012010102','history_failure');r=apply(name);assert r.returncode==1,(r.stdout,r.stderr);assert sql("SELECT to_regclass('public.history_failure') IS NULL AND NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261012010102');")=='t'
  name,_=migration('20261012010103','window_refusal');r=apply(name,minute='50');assert r.returncode==1 and 'break window' in r.stderr;assert sql("SELECT to_regclass('public.window_refusal') IS NULL AND NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261012010103');")=='t'
  sql('UPDATE fixture_migration_readiness SET frozen=true;')
  # A refusal is waited out for a bounded time (production: 12 min); the
  # fixture shortens it. Still refused at the end: nothing sent, exit 1.
  name,_=migration('20261012010106','readiness_refusal');r=apply(name,wait_ms=1500);assert r.returncode==1 and 'database would refuse DDL' in r.stderr,(r.stdout,r.stderr);assert 'after waiting' in r.stderr;assert sql("SELECT to_regclass('public.readiness_refusal') IS NULL AND NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261012010106');")=='t'
  # Released during the wait: the same run installs it, once.
  name,text=migration('20261012010108','readiness_released')
  waiting=subprocess.Popen([str(x) for x in [a.node,'--require',clock,installer,'--migration',name,'--ssl-root-cert',cert]],env=dict(child,FIXTURE_MINUTE='20',APPLY_DDL_ADMISSION_WAIT_MS='20000',APPLY_DDL_ADMISSION_POLL_MS='200'),cwd=work,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  try:
   time.sleep(1.5)
   assert waiting.poll() is None,'The installer did not wait while the database refused DDL'
   assert sql("SELECT to_regclass('public.readiness_released') IS NULL;")=='t','DDL was sent while refused'
   sql('UPDATE fixture_migration_readiness SET frozen=false;')
   out,err=waiting.communicate(timeout=30)
  finally:
   if waiting.poll() is None:waiting.kill()
  assert waiting.returncode==0 and 'now admits DDL' in out,(out,err)
  assert sql("SELECT to_regclass('public.readiness_released') IS NOT NULL;")=='t'
  assert json.loads(sql("SELECT json_build_object('name',name,'statements',statements) FROM supabase_migrations.schema_migrations WHERE version='20261012010108';"))=={'name':'readiness_released','statements':[text]}
  name,text=migration('20261012010104','acknowledgment_unknown');r=apply(name,disconnect=True);assert r.returncode==3 and 'UNKNOWN' in r.stderr,(r.stdout,r.stderr);assert sql("SELECT to_regclass('public.acknowledgment_unknown') IS NOT NULL;")=='t';row=json.loads(sql("SELECT json_build_object('name',name,'statements',statements) FROM supabase_migrations.schema_migrations WHERE version='20261012010104';"));assert row=={'name':'acknowledgment_unknown','statements':[text]}
  sql("CREATE OR REPLACE FUNCTION supabase_migrations.fixture_reject_history() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.name='history_failure' THEN RAISE EXCEPTION 'fixture history failure' USING ERRCODE='23514'; ELSIF NEW.name='precommit_unknown' THEN PERFORM pg_terminate_backend(pg_backend_pid());END IF;RETURN NEW;END$$;")
  name,_=migration('20261012010107','precommit_unknown');r=apply(name);assert r.returncode==3 and 'UNKNOWN' in r.stderr,(r.stdout,r.stderr);assert sql("SELECT to_regclass('public.precommit_unknown') IS NULL AND NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261012010107');")=='t'
  # Inspect unknown durable outcome once; never re-dispatch that migration.
  fakeca=root/'wrong-ca.crt';fakekey=root/'wrong-ca.key';cmd([a.openssl,'req','-x509','-newkey','rsa:2048','-nodes','-keyout',fakekey,'-out',fakeca,'-days','1','-subj','/CN=unrelated-ca']);os.chmod(fakekey,0o600)
  name,_=migration('20261012010105','tls_refusal');r=apply(name,ca=fakeca);assert r.returncode==3 and 'could not connect' in r.stderr;assert sql("SELECT to_regclass('public.tls_refusal') IS NULL AND NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261012010105');")=='t'
  # Actual installer optional admission uses the original money lane before
  # any candidate DDL, preserves exact source/history, and releases on refusal.
  cmd([a.node,ci/'test_settlement_lane.mjs'],env=env,cwd=work)
  wrong=apply(name,lane=True);assert wrong.returncode==1 and 'limited to' in wrong.stderr
  lane_name='20261012181905_scoped_club_launch_reset_and_guarded_recovery.sql'
  lane_text='BEGIN;\nCREATE TABLE public.lane_installer_success(id integer);\nCOMMIT;\n'
  (migrations/lane_name).write_text(lane_text)
  holder=subprocess.Popen([str(x) for x in q]+['-c',"BEGIN; SELECT pg_advisory_xact_lock_shared(530090,1); SELECT pg_sleep(7); ROLLBACK;"],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  try:
   deadline=time.monotonic()+3
   while sql("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=530090 AND objid=1 AND granted AND mode='ShareLock');")!='t':
    assert time.monotonic()<deadline,'Original shared lane holder did not start'
    time.sleep(.05)
   blocked=apply(lane_name,lane=True);assert blocked.returncode==1 and '57014' in blocked.stderr,(blocked.stdout,blocked.stderr)
   assert sql("SELECT to_regclass('public.lane_installer_success') IS NULL AND NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261012181905');")=='t'
  finally:
   holder.communicate(timeout=10);assert holder.returncode==0
  (migrations/lane_name).write_text('BEGIN;\nCREATE TABLE public.lane_installer_failed(id integer);\nSELECT 1/0;\nCOMMIT;\n')
  failed=apply(lane_name,lane=True);assert failed.returncode==1 and '22012' in failed.stderr
  assert sql("SELECT to_regclass('public.lane_installer_failed') IS NULL AND NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261012181905');")=='t'
  assert sql('SELECT pg_try_advisory_xact_lock_shared(530090,1);')=='t'
  (migrations/lane_name).write_text(lane_text)
  passed=apply(lane_name,lane=True);assert passed.returncode==0,(passed.stdout,passed.stderr)
  assert json.loads(sql("SELECT to_json(statements) FROM supabase_migrations.schema_migrations WHERE version='20261012181905';"))==[lane_text]
  assert sql('SELECT pg_try_advisory_xact_lock_shared(530090,1);')=='t'
  # The exact CLI must wait inside its original transaction behind accounting.
  import runpy
  runpy.run_path(str(a.repository/'scripts/ci/fixtures/accounting-migration-admission/qualify.py'),init_globals=globals())
  assert a.installer.read_bytes()==original,'Candidate installer changed during qualification'
  result={'qualified':True,'settlement_lane_actual_installer_qualified':True,'accounting_admission_actual_installer_qualified':True,'installer_sha256':source_sha,'native_tls_verified':True,'invalid_ca_refused_before_ddl':True,'atomic_schema_exact_history_commit':True,'history_failure_rolls_back_schema':True,'original_window_refusal_sends_nothing':True,'original_readiness_refusal_sends_nothing':True,'original_break_guard_body_fixture_time_only':True,'already_applied_no_replay':True,'postcommit_socket_loss_returns_unknown':True,'precommit_backend_termination_returns_unknown_without_partial_schema_or_history':True,'unknown_durable_state_inspected_without_retry':True,'production_actions':False,'fixture_clock_only_stubbed_for_utc_window':True}
  a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
 finally:cmd([pg/'pg_ctl','-D',data,'-m','immediate','-w','stop'],expect=None)

# The original retention reader must honor the same installation lane.
subprocess.run([
 sys.executable, str(a.repository/'scripts/ci/fixtures/launch-reset/pruner-lane/qualify.py'),
 '--repository',str(a.repository), '--scratch',str(a.scratch), '--pg-bin',str(pg),
 '--node',str(a.node), '--pg-module',str(a.repository/'node_modules/pg/lib/index.js'),
 '--migration',str(a.repository/'supabase/migrations/20261013115251_hand_history_pruner_respects_the_existing_settlement_install.sql'),
 '--output',str(a.output.with_name('pruner-lane.json'))
],check=True,timeout=120)

# The same original pruner must yield before holding the maintenance thaw lane.
subprocess.run([
 sys.executable, str(a.repository/'scripts/ci/fixtures/launch-reset/pruner-frozen-entry/qualify.py'),
 '--repository',str(a.repository), '--scratch',str(a.scratch), '--pg-bin',str(pg),
 '--node',str(a.node), '--pg-module',str(a.repository/'node_modules/pg/lib/index.js'),
 '--migration',str(a.repository/'supabase/migrations/20261013151435_hand_history_pruning_yields_before_maintenance_thaw.sql'),
 '--output',str(a.output.with_name('pruner-frozen-entry.json'))
],check=True,timeout=120)

# The same installer owns the source-bound expired-thaw exception.
subprocess.run([
 sys.executable, str(a.repository/'scripts/ci/fixtures/launch-reset/maintenance-thaw-repair/qualify.py'),
 '--repository',str(a.repository),'--installer',str(a.installer),'--scratch',str(a.scratch),
 '--pgbin',str(pg),'--node',str(a.node),'--openssl',str(a.openssl),
 '--output',str(a.output.with_name('maintenance-thaw-repair.json'))
],check=True,timeout=120)
