#!/usr/bin/env python3
"""Bounded atomic DDL lock exhaustion and inventory-derived local correction."""
import importlib.util,json,os,shutil,subprocess,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('rebuild',Path(__file__).with_name('verify.py'));v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
pg=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'));parent=v.validate_parent(os.environ.get('SCHEMA_TEST_SCRATCH',str(v.ROOT.parent)));plan=v.derive_lock_budget(json.loads((v.BASE/'pokeriq-catalog-reference.json').read_text()));env={k:x for k,x in os.environ.items() if not k.startswith('PG')}
fixture="BEGIN;CREATE SCHEMA lock_probe;DO $ddl$ DECLARE i integer; BEGIN FOR i IN 1..512 LOOP EXECUTE format('CREATE TABLE lock_probe.t_%s(id bigint PRIMARY KEY,payload text)',i); END LOOP; END $ddl$;COMMIT;"
for corrected in [False,True]:
 work=Path(tempfile.mkdtemp(prefix='locks-',dir=parent));sock=work/'s';sock.mkdir();started=False
 def command(args,sql=None):
  r=subprocess.run([str(x) for x in args],input=sql,text=True,capture_output=True,env=env,timeout=60)
  if r.returncode:raise RuntimeError('Native fixture setup refused')
  return r.stdout.strip()
 try:
  command([pg/'initdb','-D',work/'d','-U','fixture_owner','--auth-local=trust','--auth-host=reject','--no-locale'])
  # A smaller backend pool reproduces the same lock-table mechanism with a
  # bounded 512-table fixture, rather than replaying the whole application.
  with (work/'d/postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories="+v.lit(sock)+"\nshared_buffers='16MB'\nmax_connections=10\nmax_worker_processes=0\nmax_wal_senders=0\nmax_locks_per_transaction="+str(plan['maxLocksPerTransaction'] if corrected else 64)+'\n')
  command([pg/'pg_ctl','-D',work/'d','-l',work/'server.log','-w','start']);started=True
  cmd=[pg/'psql','-X','-qAt','-h',sock,'-U','fixture_owner','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
  r=subprocess.run([str(x) for x in cmd],input=fixture,text=True,capture_output=True,env=env,timeout=60)
  if not corrected:
   assert r.returncode,'Default fixture unexpectedly avoided lock-table exhaustion'
   diagnostic=v.failure_diagnostic(r.stderr,'baseline-restore',{'sourceFile':'bounded-lock-fixture'},'psql')
   assert diagnostic['sqlstate']=='53200',diagnostic
   assert diagnostic['message']=='out of shared memory',diagnostic
   assert diagnostic.get('hint')=='You might need to increase "max_locks_per_transaction".',diagnostic
   assert command(cmd,"SELECT count(*) FROM pg_namespace WHERE nspname='lock_probe';")=='0','Failed DDL did not roll back atomically'
   print(json.dumps({'failBefore':diagnostic,'transactionRolledBack':True}))
  else:
   assert r.returncode==0,v.failure_diagnostic(r.stderr,'baseline-restore',{},'psql')
   assert command(cmd,"SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='lock_probe' AND c.relkind='r';")=='512'
 finally:
  if started:subprocess.run([str(pg/'pg_ctl'),'-D',str(work/'d'),'-m','immediate','-w','stop'],capture_output=True,env=env,timeout=30)
  shutil.rmtree(work)
print(json.dumps({'passAfter':True,'derivedIsolatedBudget':plan,'fixtureTables':512,'productionConfigurationChanged':False,'fullSchemaQualified':False}))
