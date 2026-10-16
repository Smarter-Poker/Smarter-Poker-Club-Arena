"""Invoked by the required native TLS installer driver, in its isolated cluster.

The production source and installer are exact. Only the fixture's maintenance
clock/freeze authority is controlled; no production query or credential is used.
"""

name='20261015182133_a_proving_week_advances_on_its_own_tick.sql'
source=(a.repository/'supabase/migrations'/name).read_text()
(migrations/name).write_text(source)
preimages=json.loads((a.repository/'scripts/ci/fixtures/accounting-migration-admission/preimages.json').read_text())
sql("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;SET check_function_bodies=false;")
for row in preimages:
 assert hashlib.md5(row['definition'].encode()).hexdigest()==row['definition_md5']
 sql('SET check_function_bodies=false;'+row['definition']+'; REVOKE ALL ON FUNCTION public.'+row['signature']+' FROM PUBLIC;'+('GRANT EXECUTE ON FUNCTION public.'+row['signature']+' TO service_role;' if not row['security_definer'] else ''))
 assert sql("SELECT md5(pg_get_functiondef('public."+row['signature']+"'::regprocedure));")==row['definition_md5']
sql("INSERT INTO supabase_migrations.schema_migrations VALUES('20261015173123',NULL,ARRAY['fixture prior install']);CREATE TABLE fixture_accounting_admission(frozen boolean,boundary boolean,refusal text);INSERT INTO fixture_accounting_admission VALUES(false,false,NULL);CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT frozen FROM fixture_accounting_admission$$;CREATE FUNCTION public.fn_active_maintenance_release_boundary() RETURNS jsonb LANGUAGE sql AS $$SELECT CASE WHEN boundary THEN '{}'::jsonb END FROM fixture_accounting_admission$$;CREATE OR REPLACE FUNCTION public.fn_ca_break_window_refuses_migrations(timestamptz) RETURNS text LANGUAGE sql AS $$SELECT CASE WHEN refusal='future_wait' THEN CASE WHEN $1>clock_timestamp()+interval '300 seconds' THEN 'fixture wait runway' END WHEN refusal='future_apply' THEN CASE WHEN $1>clock_timestamp()+interval '30 seconds' THEN 'fixture apply runway' END ELSE refusal END FROM fixture_accounting_admission$$;")
key="hashtextextended('union-accounting-scheduler',0)"
lockwhere="locktype='advisory' AND classid=("+key+">>32)::bit(32)::bigint AND objid=("+key+"&4294967295)::bigint"
def holder(tail):
 h=subprocess.Popen([str(x) for x in q]+['-c',"BEGIN;SELECT pg_advisory_xact_lock("+key+");SELECT pg_sleep(2);"+tail+"COMMIT;"],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 deadline=time.monotonic()+3
 while sql('SELECT EXISTS(SELECT FROM pg_locks WHERE '+lockwhere+' AND granted);')!='t':
  assert time.monotonic()<deadline,'fixture reader did not acquire scheduler lane'
  time.sleep(.03)
 return h
def untouched():
 assert sql("SELECT NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261015182133') AND to_regprocedure('public.fn_accounting_window_advance_due()') IS NULL AND md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))='a497381284a4f68b573cbf08ce1929e3';")=='t'
# Future maintenance refusal must reject before acquiring the scheduler lane.
sql("UPDATE fixture_accounting_admission SET refusal='future_wait';")
r=apply(name);assert r.returncode==1 and 'accounting_install_wait_runway_refused' in r.stderr,(r.stdout,r.stderr);untouched()
assert sql('SELECT NOT EXISTS(SELECT FROM pg_locks WHERE '+lockwhere+');')=='t'
sql('UPDATE fixture_accounting_admission SET refusal=NULL;')
# Reproduce the former queued-reader refusal with the unwrapped exact file.
h=holder('')
try:
 old=cmd(q,source,env=env,expect=None);assert old.returncode!=0 and 'window_advance_reader_owned' in old.stderr,(old.stdout,old.stderr);untouched()
finally:h.communicate(timeout=5);assert h.returncode==0
# Fresh guards must be re-read AFTER the reader releases; no DDL/history may leak.
for change,reason in [("frozen=true",'accounting_install_freeze_refused'),("boundary=true",'accounting_install_freeze_refused'),("refusal='fixture crossed maintenance boundary'",'accounting_install_ddl_refused'),("refusal='future_apply'",'accounting_install_apply_runway_refused')]:
 h=holder('UPDATE fixture_accounting_admission SET '+change+';')
 try:
  began=time.monotonic();r=apply(name);assert r.returncode==1 and reason in r.stderr,(r.stdout,r.stderr);assert time.monotonic()-began>=1;untouched()
 finally:h.communicate(timeout=5);assert h.returncode==0
 sql('UPDATE fixture_accounting_admission SET frozen=false,boundary=false,refusal=NULL;')
# Cancellation of this isolated waiter rolls back and releases its own lock.
h=holder('')
waiter=subprocess.Popen([str(a.node),'--require',str(clock),str(installer),'--migration',name,'--ssl-root-cert',str(cert)],env=child,cwd=work,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
try:
 deadline=time.monotonic()+1.8
 while True:
  pid=sql('SELECT pid FROM pg_locks WHERE '+lockwhere+' AND NOT granted;')
  if pid:break
  assert time.monotonic()<deadline,'fixture installer never waited for its transaction lock'
  time.sleep(.02)
 assert sql('SELECT pg_cancel_backend('+pid+');')=='t'
 out,err=waiter.communicate(timeout=5);assert waiter.returncode==1 and '57014' in err,(out,err);untouched()
finally:
 h.communicate(timeout=5);assert h.returncode==0
 if waiter.poll() is None:waiter.terminate();waiter.communicate(timeout=5)
# A history failure rolls back the actual qualified function replacement too.
sql("CREATE OR REPLACE FUNCTION supabase_migrations.fixture_reject_history() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.version='20261015182133' THEN RAISE EXCEPTION 'fixture accounting history failure' USING ERRCODE='23514';END IF;RETURN NEW;END$$;")
r=apply(name);assert r.returncode==1 and '23514' in r.stderr,(r.stdout,r.stderr);untouched()
sql('DROP TRIGGER fixture_reject ON supabase_migrations.schema_migrations;')
# A corrupt source must be refused before any admission or schema change.
(migrations/name).write_text(source.replace('BEGIN;','-- changed bytes\nBEGIN;',1));r=apply(name);assert r.returncode==1 and 'exact qualified migration bytes' in r.stderr,(r.stdout,r.stderr);untouched();(migrations/name).write_text(source)
# Exact actual CLI waits once, then installs the unchanged migration atomically.
h=holder('')
try:
 began=time.monotonic();r=apply(name);assert r.returncode==0,(r.stdout,r.stderr);assert time.monotonic()-began>=1
finally:h.communicate(timeout=5);assert h.returncode==0
assert json.loads(sql("SELECT to_json(statements) FROM supabase_migrations.schema_migrations WHERE version='20261015182133';"))==[source]
assert sql("SELECT md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))='009938740934b24744b35496477d02a1' AND to_regprocedure('public.fn_accounting_window_advance_due()') IS NOT NULL;")=='t'
assert sql('SELECT NOT EXISTS(SELECT FROM pg_locks WHERE '+lockwhere+');')=='t'
again=apply(name);assert again.returncode==0 and 'ALREADY-APPLIED' in again.stdout
print('PASS accounting admission: actual TLS CLI reader refusal before, bounded in-transaction wait after; concurrent freeze/boundary/clock refusal; exact source/history; postimages; transaction lock released; duplicate no replay')
