#!/usr/bin/env python3
"""Actual PG17 fixed-width cover proof; production financial bodies never run."""
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
cluster=Path(tempfile.mkdtemp(prefix='ca-history-cover-',dir=args.scratch));data=cluster/'data';sock=Path(tempfile.mkdtemp(prefix='ca-hc-'));started=False;reader=builder=None
capture=json.loads((FIXTURE/'coverage-history-preimage.json').read_text());audit=(FIXTURE/'coverage-audit-before.sql').read_text();prune=capture['retention']['definition']
assert hashlib.md5(audit.encode()).hexdigest()=='dbaa8f091599d0ecd9bdb2e56b85536f'
assert hashlib.md5(prune.encode()).hexdigest()=='f75b94afaf46ff91db120bc34e1dc2ae'
paths=list((ROOT/'supabase/migrations').glob('*_settlement_coverage_reads_recent_hand_identities_without_heap_scan.sql'));assert len(paths)==1;migration=paths[0].read_text()
build=(FIXTURE/'build-coverage-history-index.sql').read_text();recover=(FIXTURE/'recover-coverage-history-index.sql').read_text();index='public.idx_hand_history_time_identity'
def run(argv,sql=None,error=None,timeout=90):
    r=subprocess.run([str(v) for v in argv],input=sql,text=True,capture_output=True,env=env,timeout=timeout)
    if error:assert r.returncode and error in r.stderr,r.stderr+r.stdout
    elif r.returncode:raise RuntimeError(r.stderr+r.stdout)
    return r.stdout.strip()
def cmd():return [pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-U','fixture_admin','-d','postgres']
def q(sql,error=None,role='postgres'):return run(cmd(),('SET ROLE '+role+';\n' if role else '')+sql,error)
def projection():return q("SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY id),'[]'::jsonb) FROM (SELECT id,table_id,hand_number,created_at FROM hand_history WHERE created_at>now()-interval '24 hours')h;")
def cat():return q("SELECT jsonb_build_object('table',(SELECT jsonb_build_object('oid',oid,'owner',relowner,'acl',relacl,'options',reloptions,'rls',relrowsecurity,'force',relforcerowsecurity) FROM pg_class WHERE oid='hand_history'::regclass),'functions',(SELECT jsonb_agg(jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'source',md5(pg_get_functiondef(oid))) ORDER BY oid) FROM pg_proc WHERE oid IN('fn_ca_settlement_correctness_check()'::regprocedure,'sp_prune_hand_history(integer)'::regprocedure)),'constraints',(SELECT jsonb_agg(jsonb_build_object('oid',oid,'definition',pg_get_constraintdef(oid)) ORDER BY oid) FROM pg_constraint WHERE conrelid='hand_history'::regclass OR confrelid='hand_history'::regclass));")
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
    q(audit+';\n'+prune+';\nREVOKE ALL ON FUNCTION fn_ca_settlement_correctness_check() FROM PUBLIC; GRANT EXECUTE ON FUNCTION fn_ca_settlement_correctness_check() TO service_role;')
    q('''CREATE TABLE hand_history(id uuid PRIMARY KEY,table_id uuid,hand_number integer,created_at timestamptz,has_human boolean,payload jsonb);
      ALTER TABLE hand_history ENABLE ROW LEVEL SECURITY;
      GRANT SELECT,REFERENCES,TRIGGER ON hand_history TO anon,authenticated; GRANT ALL ON hand_history TO service_role;
      CREATE TABLE history_child(hand_id uuid REFERENCES hand_history(id) ON DELETE CASCADE);
      CREATE INDEX idx_hand_history_created ON hand_history(created_at DESC);
      CREATE UNIQUE INDEX uq_hand_history_global_hand_number ON hand_history(hand_number) WHERE hand_number>=1000000;''')
    before=cat();assert projection()=='[]';q(migration,'HAND_COVERAGE_INDEX_MISSING_BUILD_ONLINE')
    q('ALTER TABLE hand_history ALTER table_id SET NOT NULL;');q(migration,'HAND_COVERAGE_INDEX_TABLE_CHANGED');q('ALTER TABLE hand_history ALTER table_id DROP NOT NULL;')
    q("ALTER FUNCTION fn_ca_settlement_correctness_check() SET statement_timeout='1s';");q(migration,'HAND_COVERAGE_INDEX_SOURCE_CHANGED');q(audit)
    assert cat()==before
    q('''INSERT INTO hand_history SELECT md5(n::text)::uuid,md5('table')::uuid,n,now()-interval '90 days',false,jsonb_build_object('payload',repeat(md5(n::text),50)) FROM generate_series(1,200000)n;
      INSERT INTO hand_history SELECT md5('recent'||n)::uuid,md5('table')::uuid,1000000+n,now()-interval '30 minutes',(ARRAY[true,false,NULL])[1+n%3],jsonb_build_object('payload',repeat(md5(n::text),50)) FROM generate_series(1,1000)n;
      INSERT INTO history_child VALUES(md5('recent1')::uuid); ANALYZE hand_history;''')
    original=projection();assert len(json.loads(original))==1000
    oldplan=json.loads(q("EXPLAIN(FORMAT JSON) SELECT id,table_id,hand_number,created_at FROM hand_history WHERE created_at>now()-interval '24 hours';"))[0]['Plan']
    assert not any(n.get('Node Type')=='Index Only Scan' for n in nodes(oldplan))
    reader=subprocess.Popen([str(v) for v in cmd()],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,bufsize=1)
    reader.stdin.write('SET ROLE postgres; BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT count(*) FROM hand_history;\n');reader.stdin.flush();assert reader.stdout.readline().strip()=='201000'
    builder=subprocess.Popen([str(v) for v in cmd()],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
    builder.stdin.write('SET ROLE postgres;\n'+build.replace("statement_timeout='6min'","statement_timeout='3s'"));builder.stdin.close()
    deadline=time.monotonic()+2.6;saw=False
    while time.monotonic()<deadline:
        if q("SELECT phase FROM pg_stat_progress_create_index WHERE relid='hand_history'::regclass;",role=None)=='waiting for old snapshots':saw=True;break
        time.sleep(.03)
    assert saw,'Concurrent build did not reach old-snapshot boundary'
    q("INSERT INTO hand_history VALUES(md5('writer')::uuid,NULL,NULL,now(),NULL,'{}');")
    assert builder.wait(timeout=8)!=0 and 'statement timeout' in builder.stderr.read()
    assert q("SELECT NOT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid='"+index+"'::regclass;")=='t'
    q(migration,'HAND_COVERAGE_INDEX_CONTRACT_CHANGED');reader.stdin.write('COMMIT;\n');reader.stdin.close();assert reader.wait(timeout=5)==0
    q(recover);q(migration);q(migration);assert cat()==before
    rows=json.loads(projection());assert len(rows)==1001 and all(row in rows for row in json.loads(original))
    assert q("SELECT count(*) FROM pg_class WHERE relname LIKE 'idx_hand_history_time_identity%';")=='1'
    q('BEGIN;\n'+build,'cannot run inside a transaction block')
    q(migration.replace('COMMIT;',"DO $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$; COMMIT;"),'fixture rollback');assert cat()==before
    result=q('''BEGIN; INSERT INTO hand_history(id,table_id,hand_number,created_at) VALUES
      (md5('edge24')::uuid,NULL,NULL,now()-interval '24 hours'),
      (md5('after24')::uuid,NULL,NULL,now()-interval '24 hours'+interval '1 microsecond'),
      (md5('edge1')::uuid,NULL,NULL,now()-interval '60 minutes'),
      (md5('after1')::uuid,NULL,NULL,now()-interval '60 minutes'+interval '1 microsecond'),
      (md5('future')::uuid,NULL,NULL,now()+interval '1 day'),(md5('nulltime')::uuid,NULL,NULL,NULL);
      SELECT json_build_array(count(*) FILTER(WHERE created_at>now()-interval '24 hours'),count(*) FILTER(WHERE created_at>now()-interval '60 minutes')) FROM hand_history WHERE id IN (md5('edge24')::uuid,md5('after24')::uuid,md5('edge1')::uuid,md5('after1')::uuid,md5('future')::uuid,md5('nulltime')::uuid); ROLLBACK;''');assert result=='[4, 2]',result
    q("INSERT INTO hand_history VALUES(md5('wide')::uuid,NULL,NULL,now(),false,jsonb_build_object('payload',repeat(md5('large'),100000))); UPDATE hand_history SET table_id=md5('changed')::uuid,hand_number=900000 WHERE id=md5('writer')::uuid;")
    q('VACUUM ANALYZE hand_history;')
    plan=json.loads(q("EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT id,table_id,hand_number,created_at FROM hand_history WHERE created_at>now()-interval '24 hours';"))[0]
    assert any(n.get('Index Name')=='idx_hand_history_time_identity' and n.get('Node Type')=='Index Only Scan' for n in nodes(plan['Plan'])),plan
    assert q('SELECT count(*) FROM history_child;')=='1'
    q('DROP INDEX '+index+'; CREATE INDEX idx_hand_history_time_identity ON hand_history(created_at) INCLUDE(id,table_id,hand_number) WHERE has_human;');q(migration,'HAND_COVERAGE_INDEX_CONTRACT_CHANGED')
    q('DROP INDEX '+index+'; CREATE INDEX idx_hand_history_time_identity ON hand_history(created_at) INCLUDE(id,table_id);');q(migration,'HAND_COVERAGE_INDEX_CONTRACT_CHANGED')
    q('DROP INDEX '+index+';');q(build);q(migration);assert cat()==before
    for role in ['anon','authenticated']:assert q("SELECT has_function_privilege(current_user,'fn_ca_settlement_correctness_check()','EXECUTE');",role=role)=='f'
    print(json.dumps({'localProjectionMs':plan['Execution Time'],'rows':len(json.loads(projection())),'productionMoneyExecuted':False}))
    print('coverage-history-index-native-acceptance-passed')
finally:
    for child in [builder,reader]:
        if child and child.poll() is None:child.terminate();child.wait(timeout=5)
    if started and (data/'postmaster.pid').exists():run([pg/'pg_ctl','-D',data,'-m','fast','-w','stop'])
    shutil.rmtree(cluster);shutil.rmtree(sock)
