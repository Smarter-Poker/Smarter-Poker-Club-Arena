#!/usr/bin/env python3
"""PG17 maintenance qualification: real visibility, snapshots and automatic vacuum.

Captured financial bodies are installed for source hashes and never executed.
The isolated cluster alone uses a one-second launcher interval; production
worker/cost/schedule settings are neither copied nor changed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
ROOT=Path(__file__).resolve().parents[4]
FIXTURE=Path(__file__).resolve().parent
p=argparse.ArgumentParser();p.add_argument('--pg-bin',default=os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'));p.add_argument('--scratch',default=os.environ.get('RUNNER_TEMP',tempfile.gettempdir()));args=p.parse_args()
pg=Path(args.pg_bin).resolve();env={'PATH':str(pg)+':/usr/bin:/bin','LANG':'C','LC_ALL':'C','PGCONNECT_TIMEOUT':'5'}
cluster=Path(tempfile.mkdtemp(prefix='ca-receipt-visibility-',dir=args.scratch));data=cluster/'data';sock=Path(tempfile.mkdtemp(prefix='ca-rv-'));started=False;reader=None
paths=list((ROOT/'supabase/migrations').glob('*_atomic_receipt_visibility_follows_the_original_hand_maintena.sql'));assert len(paths)==1;migration=paths[0].read_text()
audit=(FIXTURE/'coverage-audit-before.sql').read_text();core=(FIXTURE/'coverage-core-preimage.sql').read_text();prune=json.loads((FIXTURE/'coverage-history-preimage.json').read_text())['retention']['definition']
core_sig='public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'
functions=[('public.fn_ca_settlement_correctness_check()',audit,'dbaa8f091599d0ecd9bdb2e56b85536f'),(core_sig,core,'b49192e78f472d7a931bcf20de46a702'),('public.sp_prune_hand_history(integer)',prune,'f75b94afaf46ff91db120bc34e1dc2ae')]
for _,definition,digest in functions:assert hashlib.md5(definition.encode()).hexdigest()==digest

def run(argv,sql=None,error=None,timeout=60):
    r=subprocess.run([str(x) for x in argv],input=sql,text=True,capture_output=True,env=env,timeout=timeout)
    if error:assert r.returncode and error in r.stderr,r.stderr+r.stdout
    elif r.returncode:raise RuntimeError(r.stderr+r.stdout)
    return r.stdout.strip()
def cmd():return [pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-U','fixture_admin','-d','postgres']
def q(sql,error=None,role='postgres'):return run(cmd(),('SET ROLE '+role+';\n' if role else '')+sql,error)
def fingerprint():return q("SELECT md5(string_agg(row_to_json(r)::text,',' ORDER BY hand_number)) FROM hand_atomic_commits r;")
def catalog():return q("SELECT jsonb_build_object('table',(SELECT jsonb_build_object('oid',oid,'owner',relowner,'acl',relacl,'rls',relrowsecurity,'force',relforcerowsecurity) FROM pg_class WHERE oid='hand_atomic_commits'::regclass),'functions',(SELECT jsonb_agg(jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,'hash',md5(pg_get_functiondef(oid))) ORDER BY oid) FROM pg_proc WHERE oid IN('fn_ca_settlement_correctness_check()'::regprocedure,'sp_prune_hand_history(integer)'::regprocedure,'"+core_sig+"'::regprocedure)),'indexes',(SELECT jsonb_agg(jsonb_build_object('oid',indexrelid,'definition',pg_get_indexdef(indexrelid),'valid',indisvalid,'ready',indisready,'live',indislive) ORDER BY indexrelid) FROM pg_index WHERE indrelid='hand_atomic_commits'::regclass),'constraints',(SELECT jsonb_agg(jsonb_build_object('oid',oid,'definition',pg_get_constraintdef(oid)) ORDER BY oid) FROM pg_constraint WHERE conrelid='hand_atomic_commits'::regclass OR confrelid='hand_atomic_commits'::regclass));")
def options():return json.loads(q("SELECT jsonb_object_agg(option_name,option_value) FROM pg_options_to_table((SELECT reloptions FROM pg_class WHERE oid='hand_atomic_commits'::regclass));"))
def plan():return json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT hand_id,table_id,hand_number FROM hand_atomic_commits WHERE hand_number BETWEEN 1 AND 200000;'))[0]
def nodes(n):
    yield n
    for child in n.get('Plans',[]):yield from nodes(child)
def index_heap(p):
    scans=[n for n in nodes(p['Plan']) if n.get('Index Name')=='idx_hand_atomic_commit_identity' and n['Node Type']=='Index Only Scan'];assert scans,p
    return sum(n.get('Heap Fetches',0) for n in scans)
try:
    assert ' 17.' in run([pg/'postgres','--version'])
    run([pg/'initdb','-D',data,'-U','fixture_admin','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
    with (data/'postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(sock)+"'\nautovacuum=off\nautovacuum_naptime='1s'\n")
    started=True;run([pg/'pg_ctl','-D',data,'-l',cluster/'server.log','-w','start'])
    q('CREATE ROLE postgres LOGIN NOSUPERUSER BYPASSRLS; CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated; GRANT ALL ON SCHEMA public TO postgres;',role=None)
    assert q("SELECT inet_server_addr() IS NULL AND NOT rolsuper AND rolbypassrls FROM pg_roles WHERE rolname='postgres';")=='t'
    q('''CREATE TABLE hand_history(id uuid PRIMARY KEY,table_id uuid,hand_number integer,created_at timestamptz);
      CREATE TABLE hand_atomic_commits(hand_id uuid NOT NULL UNIQUE,table_id uuid NOT NULL,hand_number bigint NOT NULL UNIQUE,statistics_done boolean NOT NULL,payload jsonb,PRIMARY KEY(table_id,hand_number));
      ALTER TABLE hand_atomic_commits ENABLE ROW LEVEL SECURITY;
      ALTER TABLE hand_atomic_commits SET(autovacuum_vacuum_scale_factor=0.0,autovacuum_vacuum_threshold=250000,autovacuum_vacuum_insert_scale_factor=0.0,autovacuum_vacuum_insert_threshold=100000);
      CREATE INDEX idx_hand_atomic_commit_identity ON hand_atomic_commits(hand_number) INCLUDE(hand_id,table_id);
      CREATE INDEX fixture_pending ON hand_atomic_commits(hand_number) WHERE NOT statistics_done;
      CREATE TABLE receipt_child(hand_id uuid REFERENCES hand_atomic_commits(hand_id));
      GRANT SELECT ON hand_atomic_commits TO service_role;''')
    for _,definition,_ in functions:q(definition)
    q('REVOKE ALL ON FUNCTION fn_ca_settlement_correctness_check() FROM PUBLIC; GRANT EXECUTE ON FUNCTION fn_ca_settlement_correctness_check() TO service_role;')
    q("INSERT INTO hand_atomic_commits SELECT md5(n::text)::uuid,md5('table'||(n%3))::uuid,n,false,jsonb_build_object('payload',repeat(md5(n::text),25)) FROM generate_series(1,200000)n; INSERT INTO receipt_child VALUES(md5('1')::uuid); VACUUM ANALYZE hand_atomic_commits;")
    cat=catalog();original_options=options();original_rows=fingerprint()
    q('ALTER TABLE hand_atomic_commits SET(autovacuum_enabled=false);');q(migration,'ATOMIC_RECEIPT_MAINTENANCE_OPTIONS_CHANGED');q('ALTER TABLE hand_atomic_commits RESET(autovacuum_enabled);')
    q('ALTER TABLE hand_atomic_commits DISABLE ROW LEVEL SECURITY;');q(migration,'ATOMIC_RECEIPT_MAINTENANCE_TABLE_CHANGED');q('ALTER TABLE hand_atomic_commits ENABLE ROW LEVEL SECURITY;')
    for signature,definition,_ in functions:
        q('ALTER FUNCTION '+signature+" SET statement_timeout='1s';");q(migration,'ATOMIC_RECEIPT_MAINTENANCE_SOURCE_CHANGED');q(definition)
    q(migration.replace('COMMIT;',"DO $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$; COMMIT;"),'fixture rollback')
    assert options()==original_options and catalog()==cat and fingerprint()==original_rows
    for role in ['anon','authenticated']:
        q(migration,'must be owner of table hand_atomic_commits',role)
        q('SELECT * FROM hand_atomic_commits LIMIT 1;','permission denied',role)
    # Hold the pre-update snapshot while the current writer changes flags. Its
    # old row versions must survive both the tuning transaction and VACUUM.
    reader=subprocess.Popen([str(x) for x in cmd()],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,bufsize=1)
    def rd(sql):reader.stdin.write(sql+'\n');reader.stdin.flush();return reader.stdout.readline().strip()
    assert rd('SET ROLE postgres; BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT count(*) FROM hand_atomic_commits;')=='200000'
    q("UPDATE hand_atomic_commits SET statistics_done=true WHERE hand_number<=15000; INSERT INTO hand_atomic_commits SELECT md5(n::text)::uuid,md5('table'||(n%3))::uuid,n,true,jsonb_build_object('payload',repeat(md5(n::text),25)) FROM generate_series(200001,210001)n; SELECT pg_stat_force_next_flush();")
    actual_before=plan();heap_before=index_heap(actual_before);assert heap_before>10000,actual_before
    rows=fingerprint();q(migration);assert catalog()==cat and fingerprint()==rows
    assert options()=={**original_options,'autovacuum_vacuum_threshold':'20000','autovacuum_vacuum_insert_threshold':'10000'}
    q(migration,'ATOMIC_RECEIPT_MAINTENANCE_OPTIONS_CHANGED')
    assert rd('SELECT count(*) FILTER(WHERE statistics_done),count(*) FROM hand_atomic_commits;')=='0|200000'
    # Existing read/write transaction remains admitted under the new reloptions.
    q("INSERT INTO hand_atomic_commits VALUES(md5('concurrent')::uuid,md5('writer')::uuid,300000,true,'{}'); SELECT pg_stat_force_next_flush();")
    after_writer=fingerprint()
    q("ALTER SYSTEM SET autovacuum='on'; SELECT pg_reload_conf();",role=None)
    deadline=time.monotonic()+30
    while time.monotonic()<deadline:
        if int(q("SELECT autovacuum_count FROM pg_stat_user_tables WHERE relid='hand_atomic_commits'::regclass;"))>0:break
        time.sleep(.1)
    else:raise AssertionError('Configured native insert trigger did not produce an automatic vacuum')
    assert fingerprint()==after_writer and catalog()==cat
    assert rd('SELECT count(*) FILTER(WHERE statistics_done),count(*) FROM hand_atomic_commits;')=='0|200000'
    assert rd('COMMIT; SELECT count(*) FILTER(WHERE statistics_done),count(*) FROM hand_atomic_commits;')=='25002|210002'
    reader.stdin.close();assert reader.wait(timeout=5)==0
    # One finite ordinary maintenance command after the old snapshot closes.
    # This is neither VACUUM FULL nor a schedule, and never executes in production.
    q('VACUUM(ANALYZE,TRUNCATE FALSE) hand_atomic_commits;')
    after=plan();heap_after=index_heap(after);assert heap_after<100,after
    assert fingerprint()==after_writer and catalog()==cat
    q("DELETE FROM hand_atomic_commits WHERE hand_id=md5('1')::uuid;",'violates foreign key constraint')
    q("INSERT INTO hand_atomic_commits SELECT hand_id,table_id,hand_number,statistics_done,payload FROM hand_atomic_commits LIMIT 1;",'duplicate key')
    assert q('SELECT count(*) FROM receipt_child;')=='1'
    print(json.dumps({'beforeHeapFetches':heap_before,'afterHeapFetches':heap_after,'nativeBeforeMs':actual_before['Execution Time'],'nativeAfterMs':after['Execution Time'],'automaticVacuumObserved':True,'snapshotAndWriterRowsPreserved':True,'financialBodiesExecuted':False,'productionTiming':False}))
    print('receipt-visibility-native-acceptance-passed')
finally:
    if reader and reader.poll() is None:reader.terminate();reader.wait(timeout=5)
    if started and (data/'postmaster.pid').exists():run([pg/'pg_ctl','-D',data,'-m','fast','-w','stop'])
    shutil.rmtree(cluster);shutil.rmtree(sock)
