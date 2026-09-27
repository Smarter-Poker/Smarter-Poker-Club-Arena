#!/usr/bin/env python3
"""Actual PG17 fixed-width receipt identity cover; financial bodies never run."""
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
cluster=Path(tempfile.mkdtemp(prefix='ca-receipt-cover-',dir=args.scratch));data=cluster/'data';sock=Path(tempfile.mkdtemp(prefix='ca-rc-'));started=False;reader=builder=None
capture=json.loads((FIXTURE/'coverage-receipt-preimage.json').read_text())[0]['jsonb_build_object']
audit=(FIXTURE/'coverage-audit-before.sql').read_text();core=(FIXTURE/'coverage-core-preimage.sql').read_text();prune=json.loads((FIXTURE/'coverage-history-preimage.json').read_text())['retention']['definition']
assert hashlib.md5(audit.encode()).hexdigest()=='dbaa8f091599d0ecd9bdb2e56b85536f'
assert hashlib.md5(core.encode()).hexdigest()=='b49192e78f472d7a931bcf20de46a702'
assert hashlib.md5(prune.encode()).hexdigest()=='f75b94afaf46ff91db120bc34e1dc2ae'
assert {c['name']:(c['type'],c['notnull']) for c in capture['columns']}=={'hand_id':('uuid',True),'table_id':('uuid',True),'hand_number':('bigint',True)}
paths=list((ROOT/'supabase/migrations').glob('*_settlement_receipt_identity_scan_uses_a_fixed_width_cover.sql'));assert len(paths)==1;migration=paths[0].read_text()
build=(FIXTURE/'build-coverage-receipt-index.sql').read_text();recover=(FIXTURE/'recover-coverage-receipt-index.sql').read_text();index='public.idx_hand_atomic_commit_identity'
core_sig='public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'
def run(argv,sql=None,error=None,timeout=90):
    r=subprocess.run([str(v) for v in argv],input=sql,text=True,capture_output=True,env=env,timeout=timeout)
    if error:assert r.returncode and error in r.stderr,r.stderr+r.stdout
    elif r.returncode:raise RuntimeError(r.stderr+r.stdout)
    return r.stdout.strip()
def cmd():return [pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-U','fixture_admin','-d','postgres']
def q(sql,error=None,role='postgres'):return run(cmd(),('SET ROLE '+role+';\n' if role else '')+sql,error)
def projection():return q("SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY hand_id),'[]'::jsonb) FROM (SELECT hand_id,table_id,hand_number FROM hand_atomic_commits WHERE hand_number BETWEEN 200001 AND 201000)h;")
def cat():return q("SELECT jsonb_build_object('table',(SELECT jsonb_build_object('oid',oid,'owner',relowner,'acl',relacl,'options',reloptions,'rls',relrowsecurity,'force',relforcerowsecurity) FROM pg_class WHERE oid='hand_atomic_commits'::regclass),'functions',(SELECT jsonb_agg(jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'source',md5(pg_get_functiondef(oid))) ORDER BY oid) FROM pg_proc WHERE oid IN('fn_ca_settlement_correctness_check()'::regprocedure,'sp_prune_hand_history(integer)'::regprocedure,'"+core_sig+"'::regprocedure)),'constraints',(SELECT jsonb_agg(jsonb_build_object('oid',oid,'definition',pg_get_constraintdef(oid)) ORDER BY oid) FROM pg_constraint WHERE conrelid='hand_atomic_commits'::regclass OR confrelid='hand_atomic_commits'::regclass),'existingIndexes',(SELECT jsonb_agg(jsonb_build_object('oid',i.indexrelid,'definition',pg_get_indexdef(i.indexrelid),'valid',indisvalid,'ready',indisready,'live',indislive,'immediate',indimmediate) ORDER BY indexrelid) FROM pg_index i WHERE indrelid='hand_atomic_commits'::regclass AND indexrelid<>coalesce(to_regclass('"+index+"'),0)));")
def nodes(n):
    yield n
    for child in n.get('Plans',[]):yield from nodes(child)
try:
    assert ' 17.' in run([pg/'postgres','--version'])
    run([pg/'initdb','-D',data,'-U','fixture_admin','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
    with (data/'postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(sock)+"'\nautovacuum=off\n")
    started=True;run([pg/'pg_ctl','-D',data,'-l',cluster/'server.log','-w','start'])
    q('CREATE ROLE postgres LOGIN NOSUPERUSER BYPASSRLS; CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated; GRANT ALL ON SCHEMA public TO postgres;',role=None)
    assert q("SELECT inet_server_addr() IS NULL AND NOT rolsuper AND rolbypassrls FROM pg_roles WHERE rolname='postgres';")=='t'
    q('''CREATE TABLE hand_history(id uuid PRIMARY KEY,table_id uuid,hand_number integer,created_at timestamptz);
      CREATE TABLE hand_atomic_commits(hand_id uuid NOT NULL UNIQUE,table_id uuid NOT NULL,hand_number bigint NOT NULL UNIQUE,payload jsonb,PRIMARY KEY(table_id,hand_number));
      ALTER TABLE hand_atomic_commits ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON hand_atomic_commits TO service_role;
      CREATE TABLE receipt_child(hand_id uuid REFERENCES hand_atomic_commits(hand_id));''')
    q(audit+';\n'+core+';\n'+prune+';\nREVOKE ALL ON FUNCTION fn_ca_settlement_correctness_check() FROM PUBLIC; GRANT EXECUTE ON FUNCTION fn_ca_settlement_correctness_check() TO service_role;')
    before=cat();assert projection()=='[]';q(migration,'ATOMIC_RECEIPT_INDEX_MISSING_BUILD_ONLINE')
    q('ALTER TABLE hand_atomic_commits ALTER table_id DROP NOT NULL;','column "table_id" is in a primary key')
    q('ALTER TABLE hand_atomic_commits ALTER hand_id DROP NOT NULL;');q(migration,'ATOMIC_RECEIPT_INDEX_TABLE_CHANGED');q('ALTER TABLE hand_atomic_commits ALTER hand_id SET NOT NULL;')
    q("ALTER FUNCTION fn_ca_settlement_correctness_check() SET statement_timeout='1s';");q(migration,'ATOMIC_RECEIPT_INDEX_SOURCE_CHANGED');q(audit)
    assert cat()==before
    q('''INSERT INTO hand_atomic_commits SELECT md5(n::text)::uuid,md5('table'||(n%3))::uuid,n,jsonb_build_object('payload',repeat(md5(n::text),50)) FROM generate_series(1,201000)n;
      INSERT INTO receipt_child VALUES(md5('200001')::uuid); ANALYZE hand_atomic_commits;''')
    original=projection();assert len(json.loads(original))==1000
    oldplan=json.loads(q('EXPLAIN(FORMAT JSON) SELECT hand_id,table_id,hand_number FROM hand_atomic_commits WHERE hand_number BETWEEN 200001 AND 201000;'))[0]['Plan']
    assert not any(n.get('Node Type')=='Index Only Scan' for n in nodes(oldplan))
    reader=subprocess.Popen([str(v) for v in cmd()],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,bufsize=1)
    reader.stdin.write('SET ROLE postgres; BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT count(*) FROM hand_atomic_commits;\n');reader.stdin.flush();assert reader.stdout.readline().strip()=='201000'
    builder=subprocess.Popen([str(v) for v in cmd()],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
    builder.stdin.write('SET ROLE postgres;\n'+build.replace("statement_timeout='6min'","statement_timeout='3s'"));builder.stdin.close()
    deadline=time.monotonic()+2.8;saw=False
    while time.monotonic()<deadline:
        if q("SELECT phase FROM pg_stat_progress_create_index WHERE relid='hand_atomic_commits'::regclass;",role=None)=='waiting for old snapshots':saw=True;break
        time.sleep(.03)
    assert saw,'Concurrent build did not reach old-snapshot boundary'
    q("INSERT INTO hand_atomic_commits VALUES(md5('writer')::uuid,md5('writer-table')::uuid,300000,'{}');")
    assert builder.wait(timeout=8)!=0 and 'statement timeout' in builder.stderr.read()
    assert q("SELECT NOT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid='"+index+"'::regclass;")=='t'
    q(migration,'ATOMIC_RECEIPT_INDEX_CONTRACT_CHANGED');reader.stdin.write('COMMIT;\n');reader.stdin.close();assert reader.wait(timeout=5)==0
    q(recover);q(migration);q(migration);assert cat()==before and projection()==original
    assert q("SELECT count(*) FROM pg_class WHERE relname LIKE 'idx_hand_atomic_commit_identity%';")=='1'
    q('BEGIN;\n'+build,'cannot run inside a transaction block')
    q(migration.replace('COMMIT;',"DO $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$; COMMIT;"),'fixture rollback');assert cat()==before
    for col in ['hand_id','table_id','hand_number']:
        values={'hand_id':"md5('null')::uuid",'table_id':"md5('null-table')::uuid",'hand_number':'400000'};values[col]='NULL'
        q('INSERT INTO hand_atomic_commits(hand_id,table_id,hand_number) VALUES('+','.join(values.values())+');','violates not-null constraint')
    q("INSERT INTO hand_atomic_commits SELECT md5('dup')::uuid,md5('dup-table')::uuid,hand_number,'{}' FROM hand_atomic_commits WHERE hand_number=200001;",'duplicate key')
    q("DELETE FROM hand_atomic_commits WHERE hand_id=md5('200001')::uuid;",'violates foreign key constraint')
    q("INSERT INTO hand_atomic_commits VALUES(md5('wide')::uuid,md5('wide-table')::uuid,400000,jsonb_build_object('payload',repeat(md5('large'),100000))); UPDATE hand_atomic_commits SET table_id=md5('updated')::uuid WHERE hand_number=300000; VACUUM ANALYZE hand_atomic_commits;")
    plan=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT hand_id,table_id,hand_number FROM hand_atomic_commits WHERE hand_number BETWEEN 200001 AND 201000;'))[0]
    assert any(n.get('Index Name')=='idx_hand_atomic_commit_identity' and n.get('Node Type')=='Index Only Scan' for n in nodes(plan['Plan'])),plan
    assert projection()==original and q('SELECT count(*) FROM receipt_child;')=='1'
    q('DROP INDEX '+index+'; CREATE INDEX idx_hand_atomic_commit_identity ON hand_atomic_commits(hand_number) INCLUDE(hand_id,table_id) WHERE hand_number>0;');q(migration,'ATOMIC_RECEIPT_INDEX_CONTRACT_CHANGED')
    q('DROP INDEX '+index+'; CREATE INDEX idx_hand_atomic_commit_identity ON hand_atomic_commits(hand_number) INCLUDE(hand_id);');q(migration,'ATOMIC_RECEIPT_INDEX_CONTRACT_CHANGED')
    q('DROP INDEX '+index+';');q(build);q(migration);assert cat()==before
    for role in ['anon','authenticated']:q('SELECT * FROM hand_atomic_commits LIMIT 1;','permission denied',role)
    print(json.dumps({'localProjectionMs':plan['Execution Time'],'rows':len(json.loads(projection())),'productionMoneyExecuted':False,'originalUniqueAndForeignKeys':'unchanged'}))
    print('coverage-receipt-index-native-acceptance-passed')
finally:
    for child in [builder,reader]:
        if child and child.poll() is None:child.terminate();child.wait(timeout=5)
    if started and (data/'postmaster.pid').exists():run([pg/'pg_ctl','-D',data,'-m','fast','-w','stop'])
    shutil.rmtree(cluster);shutil.rmtree(sock)
