#!/usr/bin/env python3
"""Socket-only PG17 proof of the unchanged audit's timestamp count access path."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[4]
FIXTURE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--pg-bin', default=os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
parser.add_argument('--scratch', default=os.environ.get('RUNNER_TEMP', tempfile.gettempdir()))
args = parser.parse_args()
pg = Path(args.pg_bin).resolve()
env = {'PATH': str(pg)+':/usr/bin:/bin', 'LANG':'C', 'LC_ALL':'C', 'PGCONNECT_TIMEOUT':'5'}
cluster = Path(tempfile.mkdtemp(prefix='ca-settlement-time-', dir=args.scratch))
socket = Path(tempfile.mkdtemp(prefix='ca-st-'))
data = cluster/'data'
started = False
reader = builder = None
capture = json.loads((FIXTURE/'first-attempt-preimage.json').read_text())
function = capture['function']['definition']
assert hashlib.md5(function.encode()).hexdigest() == 'dbaa8f091599d0ecd9bdb2e56b85536f'
paths = list((ROOT/'supabase/migrations').glob('*_settlement_attempt_counts_use_their_original_time_boundary.sql'))
assert len(paths) == 1
migration = paths[0].read_text()
build = (FIXTURE/'build-first-attempt-index.sql').read_text()
recovery = (FIXTURE/'recover-first-attempt-index.sql').read_text()
index = 'public.idx_settlement_idem_first_attempt'
signature = 'public.fn_ca_settlement_correctness_check()'

def run(argv, sql=None, error=None, timeout=60):
    p = subprocess.run([str(v) for v in argv], input=sql, text=True, capture_output=True, env=env, timeout=timeout)
    if error:
        assert p.returncode and error in p.stderr, p.stderr+p.stdout
    elif p.returncode:
        raise RuntimeError(p.stderr+p.stdout)
    return p.stdout.strip()

def command():
    return [pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',socket,'-U','fixture_admin','-d','postgres']

def query(sql, error=None, role='postgres'):
    return run(command(), ('SET ROLE '+role+';\n' if role else '')+sql, error)

def counts():
    return query("SELECT json_build_array((SELECT count(*) FROM public.settlement_idempotency_keys WHERE first_attempt_at > now()-interval '24 hours'),(SELECT count(*) FROM public.settlement_idempotency_keys WHERE first_attempt_at > now()-interval '60 minutes')); ")

def catalog():
    return query("SELECT jsonb_build_object('function',(SELECT jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'definition',md5(pg_get_functiondef(oid))) FROM pg_proc WHERE oid='"+signature+"'::regprocedure),'table',(SELECT jsonb_build_object('oid',oid,'owner',relowner,'acl',relacl,'options',reloptions,'rls',relrowsecurity,'force',relforcerowsecurity) FROM pg_class WHERE oid='public.settlement_idempotency_keys'::regclass));")

def descendants(plan):
    yield plan
    for child in plan.get('Plans', []):
        yield from descendants(child)

try:
    assert ' 17.' in run([pg/'postgres','--version'])
    run([pg/'initdb','-D',data,'-U','fixture_admin','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
    with (data/'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(socket)+"'\nautovacuum=off\n")
    started=True
    run([pg/'pg_ctl','-D',data,'-l',cluster/'server.log','-w','start'])
    query('CREATE ROLE postgres LOGIN NOSUPERUSER BYPASSRLS; CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated; GRANT ALL ON SCHEMA public TO postgres;',role=None)
    assert query("SELECT inet_server_addr() IS NULL AND current_setting('listen_addresses')='' AND NOT rolsuper AND rolbypassrls FROM pg_roles WHERE rolname='postgres';")=='t'
    query(function)
    query('REVOKE ALL ON FUNCTION '+signature+' FROM PUBLIC; GRANT EXECUTE ON FUNCTION '+signature+' TO service_role;')
    query('''CREATE TABLE public.settlement_idempotency_keys (
      table_id uuid NOT NULL,hand_id uuid NOT NULL,status text NOT NULL,result jsonb,error text,
      attempt_count integer NOT NULL DEFAULT 1,first_attempt_at timestamptz NOT NULL,
      last_attempt_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
      PRIMARY KEY(table_id,hand_id));
      ALTER TABLE public.settlement_idempotency_keys ENABLE ROW LEVEL SECURITY;
      GRANT SELECT,REFERENCES,TRIGGER ON public.settlement_idempotency_keys TO anon,authenticated;
      GRANT ALL ON public.settlement_idempotency_keys TO service_role;''')
    for item in capture['indexes']:
        if '_pkey ' not in item['definition']:
            query(item['definition'])
    before=catalog()
    assert counts()=='[0, 0]'
    query(migration,'SETTLEMENT_ATTEMPT_INDEX_MISSING_BUILD_ONLINE')
    query("INSERT INTO settlement_idempotency_keys(table_id,hand_id,status,first_attempt_at) VALUES(md5('null')::uuid,md5('null')::uuid,'failed',NULL);",'violates not-null constraint')
    query('ALTER TABLE settlement_idempotency_keys ALTER first_attempt_at DROP NOT NULL;')
    query(migration,'SETTLEMENT_ATTEMPT_INDEX_TABLE_CHANGED')
    query('ALTER TABLE settlement_idempotency_keys ALTER first_attempt_at SET NOT NULL;')
    query("ALTER FUNCTION "+signature+" SET statement_timeout='1s';")
    query(migration,'SETTLEMENT_ATTEMPT_INDEX_SOURCE_CHANGED')
    query(function)
    assert catalog()==before
    query('GRANT EXECUTE ON FUNCTION '+signature+' TO authenticated;')
    query(migration,'SETTLEMENT_ATTEMPT_INDEX_AUTHORITY_CHANGED')
    query('REVOKE EXECUTE ON FUNCTION '+signature+' FROM authenticated;')
    assert catalog()==before
    query('''INSERT INTO settlement_idempotency_keys(table_id,hand_id,status,first_attempt_at)
      SELECT md5('table')::uuid,md5(n::text)::uuid,
      (ARRAY['failed','in_flight','succeeded'])[1+n%3],now()-interval '90 days'
      FROM generate_series(1,300000)n;
      INSERT INTO settlement_idempotency_keys(table_id,hand_id,status,first_attempt_at)
      SELECT md5('table')::uuid,md5('recent-'||n)::uuid,
      (ARRAY['failed','in_flight','succeeded'])[1+n%3],now()-interval '30 minutes'
      FROM generate_series(1,1000)n; ANALYZE settlement_idempotency_keys;''')
    assert counts()=='[1000, 1000]'
    # A real retained snapshot makes the one concurrent build hit its own
    # deadline. A second writer remains admitted while that operation waits.
    reader=subprocess.Popen([str(v) for v in command()],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,bufsize=1)
    reader.stdin.write('SET ROLE postgres; BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT count(*) FROM settlement_idempotency_keys;\n');reader.stdin.flush()
    assert reader.stdout.readline().strip()=='301000'
    builder=subprocess.Popen([str(v) for v in command()],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
    builder.stdin.write('SET ROLE postgres;\n'+build.replace("statement_timeout='6min'","statement_timeout='3s'"));builder.stdin.close()
    deadline=time.monotonic()+2.5; saw_wait=False
    while time.monotonic()<deadline:
        phase=query("SELECT phase FROM pg_stat_progress_create_index WHERE relid='settlement_idempotency_keys'::regclass;",role=None)
        if phase=='waiting for old snapshots': saw_wait=True;break
        time.sleep(.03)
    assert saw_wait, 'Concurrent build did not reach the held snapshot boundary'
    query("INSERT INTO settlement_idempotency_keys(table_id,hand_id,status,first_attempt_at) VALUES(md5('concurrent')::uuid,md5('concurrent')::uuid,'failed',now());")
    assert builder.wait(timeout=8)!=0 and 'statement timeout' in builder.stderr.read()
    assert query("SELECT NOT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid='"+index+"'::regclass;")=='t'
    query(migration,'SETTLEMENT_ATTEMPT_INDEX_CONTRACT_CHANGED')
    reader.stdin.write('COMMIT;\n');reader.stdin.close();assert reader.wait(timeout=5)==0
    query(recovery)
    query(migration)
    query(migration) # Verification is read-only and safe on the same valid index.
    assert counts()=='[1001, 1001]'
    assert catalog()==before, 'Financial source, authority or table options changed'
    assert query("SELECT count(*) FROM pg_class WHERE relname LIKE 'idx_settlement_idem_first_attempt%';")=='1', 'Concurrent recovery left a transient index'
    query("BEGIN;\n"+build,'cannot run inside a transaction block')
    query(migration.replace('COMMIT;',"DO $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$; COMMIT;"),'fixture rollback')
    assert catalog()==before
    # Independent expected boundaries, in one transaction: strict lower edge,
    # one microsecond after each edge, future timestamps and all statuses.
    result=query('''BEGIN;
      INSERT INTO settlement_idempotency_keys(table_id,hand_id,status,first_attempt_at)
      SELECT md5('edge')::uuid,md5(label)::uuid,status,now()+delta FROM (VALUES
        ('exact24','failed',interval '-24 hours'),
        ('after24','succeeded',interval '-24 hours 1 microsecond'),
        ('exact1','in_flight',interval '-60 minutes'),
        ('after1','failed',interval '-60 minutes 1 microsecond'),
        ('future','succeeded',interval '1 day')) v(label,status,delta);
      SELECT json_build_array(count(*) FILTER(WHERE first_attempt_at>now()-interval '24 hours'),
       count(*) FILTER(WHERE first_attempt_at>now()-interval '60 minutes'))
      FROM settlement_idempotency_keys WHERE table_id=md5('edge')::uuid;
      ROLLBACK;''')
    assert result=='[4, 2]',result
    query('VACUUM ANALYZE settlement_idempotency_keys;')
    for window in ['24 hours','60 minutes']:
        plan=json.loads(query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT count(*) FROM settlement_idempotency_keys WHERE first_attempt_at>now()-interval '"+window+"';"))[0]
        assert any(p.get('Index Name')=='idx_settlement_idem_first_attempt' for p in descendants(plan['Plan'])),plan
        print(json.dumps({'window':window,'localExecutionMs':plan['Execution Time']}))
    query('DROP INDEX '+index+'; CREATE INDEX idx_settlement_idem_first_attempt ON settlement_idempotency_keys(first_attempt_at) WHERE status=\'succeeded\';')
    query(migration,'SETTLEMENT_ATTEMPT_INDEX_CONTRACT_CHANGED')
    query('DROP INDEX '+index+';')
    query(build)
    query(migration)
    assert catalog()==before and counts()=='[1001, 1001]'
    for role in ['anon','authenticated']:
        assert query("SELECT has_function_privilege(current_user,'"+signature+"','EXECUTE');",role=role)=='f'
    assert query("SELECT has_function_privilege(current_user,'"+signature+"','EXECUTE');",role='service_role')=='t'
    print('settlement-first-attempt-index-native-acceptance-passed')
finally:
    for child in [builder,reader]:
        if child and child.poll() is None: child.terminate();child.wait(timeout=5)
    if started and (data/'postmaster.pid').exists():run([pg/'pg_ctl','-D',data,'-m','fast','-w','stop'])
    shutil.rmtree(cluster);shutil.rmtree(socket)
