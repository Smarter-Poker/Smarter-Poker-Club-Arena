#!/usr/bin/env python3
"""PG17 proof of exact G block/identity query; other financial bodies never run.

The incident sink is an explicit fixture adapter. Full captured audit/core/prune
bodies are installed only to qualify source and catalog preservation; the exact
old/new G blocks execute in owner-role wrappers against local synthetic rows.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[4]
FIXTURE = Path(__file__).resolve().parent
p = argparse.ArgumentParser()
p.add_argument('--pg-bin', default=os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
p.add_argument('--scratch', default=os.environ.get('RUNNER_TEMP', tempfile.gettempdir()))
args = p.parse_args()
pg = Path(args.pg_bin).resolve()
env = {'PATH': str(pg)+':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'PGCONNECT_TIMEOUT': '5'}
cluster = Path(tempfile.mkdtemp(prefix='ca-atomic-coverage-', dir=args.scratch))
data = cluster/'data'
sock = Path(tempfile.mkdtemp(prefix='ca-ac-'))
started = False
reader = None
before = (FIXTURE/'coverage-audit-before.sql').read_text()
core = (FIXTURE/'coverage-core-preimage.sql').read_text()
prune = json.loads((FIXTURE/'coverage-history-preimage.json').read_text())['retention']['definition']
assert hashlib.md5(before.encode()).hexdigest() == 'dbaa8f091599d0ecd9bdb2e56b85536f'
assert hashlib.md5(core.encode()).hexdigest() == 'b49192e78f472d7a931bcf20de46a702'
assert hashlib.md5(prune.encode()).hexdigest() == 'f75b94afaf46ff91db120bc34e1dc2ae'
paths = list((ROOT/'supabase/migrations').glob('*_settlement_coverage_counts_every_matching_atomic_hand.sql'))
assert len(paths) == 1
migration = paths[0].read_text()
old, new = [re.search(r'\$'+tag+r'\$(.*?)\$'+tag+r'\$', migration, re.S).group(1) for tag in ['old','new']]
assert before.count(old) == 1
assert old == (FIXTURE/'coverage-old-section.sql').read_text()
assert new == (FIXTURE/'coverage-new-section.sql').read_text()
after = before.replace(old, new)
assert after == (FIXTURE/'coverage-audit-after.sql').read_text()
assert hashlib.md5(after.encode()).hexdigest() == '331dfe59b157b733bc1efc99bbf193d0'
read = (FIXTURE/'coverage-read.sql').read_text().strip().rstrip(';')
embedded_read = new[new.index('WITH recent AS'):new.index('\n;')]
embedded_read = re.sub(r'INTO v_hands_24h,v_claims_24h,v_hands_1h,v_claims_1h\s*', '', embedded_read)
assert re.sub(r'\s+', '', read) == re.sub(r'\s+', '', embedded_read), 'Measured SQL differs from actual G query'
sig = 'public.fn_ca_settlement_correctness_check()'
core_sig = 'public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'

def run(argv, sql=None, error=None, timeout=60):
    r = subprocess.run([str(v) for v in argv], input=sql, text=True, capture_output=True, env=env, timeout=timeout)
    if error:
        assert r.returncode and error in r.stderr, r.stderr+r.stdout
    elif r.returncode:
        raise RuntimeError(r.stderr+r.stdout)
    return r.stdout.strip()

def cmd():
    return [pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-U','fixture_admin','-d','postgres']

def q(sql, error=None, role='postgres'):
    return run(cmd(), ('SET ROLE '+role+';\n' if role else '')+sql, error)

def catalog():
    return q("SELECT jsonb_agg(jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,'volatility',provolatile) ORDER BY oid) FROM pg_proc WHERE oid IN ('"+sig+"'::regprocedure,'"+core_sig+"'::regprocedure,'public.sp_prune_hand_history(integer)'::regprocedure);")

def counts():
    return json.loads(q('SELECT row_to_json(t) FROM ('+read+') t;'))

def seed(total=120, matched=100, recent=20, recent_matched=0, human='true', ordinary=True):
    assert 0 <= recent_matched <= recent <= total and recent_matched <= matched <= total-recent+recent_matched
    q('''TRUNCATE fixture_incidents,hand_atomic_commits,hand_history,settlement_idempotency_keys;
      INSERT INTO hand_history(id,table_id,hand_number,created_at,has_human)
      SELECT md5('hand'||n)::uuid,md5('table'||(n%3))::uuid,n,
        now()-CASE WHEN n>'''+str(total-recent)+''' THEN interval '30 minutes' ELSE interval '2 hours' END,
        '''+human+''' FROM generate_series(1,'''+str(total)+''') n;
      INSERT INTO hand_atomic_commits SELECT id,table_id,hand_number FROM hand_history
      WHERE hand_number<='''+str(matched-recent_matched)+''' OR hand_number>'''+str(total-recent)+''' AND hand_number<='''+str(total-recent+recent_matched)+''';''')
    if ordinary:
        q('INSERT INTO settlement_idempotency_keys SELECT hand_id,h.created_at FROM hand_atomic_commits c JOIN hand_history h ON h.id=c.hand_id;')
    expect = {'hands_24h':total,'commits_24h':matched,'hands_1h':recent,'commits_1h':recent_matched}
    assert counts() == expect, (counts(),expect)

def check(which, expected):
    q('TRUNCATE fixture_incidents;')
    result = q('SELECT fixture_'+which+'();', role='service_role')
    assert result == str(expected), (which,result,expected)
    rows = json.loads(q("SELECT coalesce(jsonb_agg(to_jsonb(i)),'[]') FROM fixture_incidents i;"))
    assert len(rows) == expected
    if expected:
        row = rows[0]
        assert row['source'] == 'fn_ca_settlement_correctness_check:fallback_regression'
        assert row['kind'] == 'settlement_error' and row['severity'] == 'warning'
        assert row['dedupe'].startswith('fallback-regression:') and row['actual'] == counts()['commits_1h']
        assert row['expected'] == counts()['hands_1h']
        if which == 'new':
            assert row['entity'] == 'hand_atomic_commits'
            assert row['metadata'] == {'claims_1h':counts()['commits_1h'],'hands_1h':counts()['hands_1h']}
            assert 'matching atomic hand receipts are missing' in row['message']

try:
    assert ' 17.' in run([pg/'postgres','--version'])
    run([pg/'initdb','-D',data,'-U','fixture_admin','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
    with (data/'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(sock)+"'\nautovacuum=off\n")
    started = True
    run([pg/'pg_ctl','-D',data,'-l',cluster/'server.log','-w','start'])
    q('CREATE ROLE postgres LOGIN NOSUPERUSER BYPASSRLS; CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated; GRANT ALL ON SCHEMA public TO postgres;', role=None)
    assert q("SELECT inet_server_addr() IS NULL AND NOT rolsuper AND rolbypassrls FROM pg_roles WHERE rolname='postgres';") == 't'
    q('''CREATE TABLE hand_history(id uuid PRIMARY KEY,table_id uuid,hand_number integer,created_at timestamptz,has_human boolean);
      ALTER TABLE hand_history ENABLE ROW LEVEL SECURITY;
      CREATE TABLE hand_atomic_commits(hand_id uuid NOT NULL UNIQUE,table_id uuid NOT NULL,hand_number bigint NOT NULL UNIQUE,PRIMARY KEY(table_id,hand_number));
      ALTER TABLE hand_atomic_commits ENABLE ROW LEVEL SECURITY;
      CREATE TABLE settlement_idempotency_keys(id uuid PRIMARY KEY,first_attempt_at timestamptz NOT NULL);
      CREATE INDEX idx_hand_history_time_identity ON hand_history(created_at) INCLUDE(id,table_id,hand_number);
      CREATE INDEX idx_hand_atomic_commit_identity ON hand_atomic_commits(hand_number) INCLUDE(hand_id,table_id);
      CREATE TABLE fixture_incidents(source text,kind text,severity text,dedupe text,expected numeric,actual numeric,entity text,message text,metadata jsonb);
      CREATE FUNCTION fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb) RETURNS uuid LANGUAGE plpgsql AS $f$
      BEGIN INSERT INTO fixture_incidents VALUES($1,$2,$3,$4,$6,$7,$9,$19,$21); RETURN md5($4)::uuid; END $f$;''')
    q(before+';\n'+core+';\n'+prune+';\nREVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC; GRANT EXECUTE ON FUNCTION '+sig+' TO service_role;')
    cat = catalog()
    q('GRANT EXECUTE ON FUNCTION '+sig+' TO authenticated;')
    q(migration,'SETTLEMENT_COVERAGE_AUTHORITY_PREIMAGE_CHANGED')
    q('REVOKE EXECUTE ON FUNCTION '+sig+' FROM authenticated;')
    q('ALTER TABLE hand_atomic_commits ALTER hand_id DROP NOT NULL;')
    q(migration,'SETTLEMENT_COVERAGE_RECEIPT_COLUMNS_CHANGED')
    q('ALTER TABLE hand_atomic_commits ALTER hand_id SET NOT NULL;')
    q('ALTER TABLE hand_atomic_commits DROP CONSTRAINT hand_atomic_commits_hand_id_key; ALTER TABLE hand_atomic_commits ADD CONSTRAINT hand_atomic_commits_hand_id_key UNIQUE(hand_id) DEFERRABLE INITIALLY DEFERRED;')
    q(migration,'SETTLEMENT_COVERAGE_RECEIPT_IDENTITY_CHANGED')
    q('ALTER TABLE hand_atomic_commits DROP CONSTRAINT hand_atomic_commits_hand_id_key; ALTER TABLE hand_atomic_commits ADD UNIQUE(hand_id);')
    q('DROP INDEX idx_hand_history_time_identity; CREATE INDEX idx_hand_history_time_identity ON hand_history(created_at);')
    q(migration,'HAND_COVERAGE_INDEX_CONTRACT_CHANGED')
    q('DROP INDEX idx_hand_history_time_identity; CREATE INDEX idx_hand_history_time_identity ON hand_history(created_at) INCLUDE(id,table_id,hand_number);')
    q('DROP INDEX idx_hand_atomic_commit_identity; CREATE INDEX idx_hand_atomic_commit_identity ON hand_atomic_commits(hand_number);')
    q(migration,'ATOMIC_RECEIPT_INDEX_CONTRACT_CHANGED')
    q('DROP INDEX idx_hand_atomic_commit_identity; CREATE INDEX idx_hand_atomic_commit_identity ON hand_atomic_commits(hand_number) INCLUDE(hand_id,table_id);')
    q('ALTER FUNCTION '+core_sig+" SET statement_timeout='1s';")
    q(migration,'SETTLEMENT_COVERAGE_PRODUCER_OR_RETENTION_CHANGED');q(core)
    q("ALTER FUNCTION public.sp_prune_hand_history(integer) SET statement_timeout='1s';")
    q(migration,'SETTLEMENT_COVERAGE_PRODUCER_OR_RETENTION_CHANGED');q(prune)
    q(migration.replace('COMMIT;',"DO $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$; COMMIT;"),'fixture rollback')
    assert catalog() == cat and q("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure));") == hashlib.md5(before.encode()).hexdigest()
    q(migration);assert catalog() == cat
    assert q("SELECT pg_get_functiondef('"+sig+"'::regprocedure);")+'\n' == after
    q(migration,'SETTLEMENT_COVERAGE_SOURCE_CHANGED')
    for name,body in [('old',old),('new',new)]:
        q('CREATE FUNCTION fixture_'+name+'() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $f$ DECLARE n integer:=0; BEGIN\n'+body+'RETURN n; END $f$; REVOKE ALL ON FUNCTION fixture_'+name+'() FROM PUBLIC; GRANT EXECUTE ON FUNCTION fixture_'+name+'() TO service_role;')
    for role in ['anon','authenticated']:
        q('SELECT fixture_new();','permission denied',role)
        assert q("SELECT has_function_privilege(current_user,'"+sig+"','EXECUTE');",role=role) == 'f'
    seed(0,0,0,0);check('old',0);check('new',0)
    seed();check('old',1);check('new',1)
    seed(human='false');check('old',0);check('new',1) # demonstrated old horse blind spot
    seed(human='NULL');check('new',1)
    seed(human='n%2=0');check('old',0);check('new',1)
    seed(120,120,20,20,ordinary=False);check('old',0);check('new',0) # diamond common receipt
    seed(120,100,20,0,ordinary=False);check('old',0);check('new',1)
    seed();q("INSERT INTO settlement_idempotency_keys SELECT md5('unrelated'||n)::uuid,now() FROM generate_series(1,200)n;");check('old',0);check('new',1)
    for total,matched,recent,rm,expected in [(100,80,20,0,0),(101,81,20,0,1),(120,50,20,0,0),(120,60,20,0,1),(121,60,20,0,1),(120,101,19,0,0),(120,117,20,17,1),(120,118,20,18,0),(121,117,21,17,1),(121,118,21,18,0)]:
        seed(total,matched,recent,rm);check('new',expected)
    seed(120,120,20,20)
    q("UPDATE hand_atomic_commits SET table_id=md5('wrongtable')::uuid WHERE hand_number=120; UPDATE hand_atomic_commits SET hand_number=-119 WHERE hand_number=119; UPDATE hand_atomic_commits SET hand_id=md5('wrongid')::uuid WHERE hand_number=118;")
    assert counts() == {'hands_24h':120,'commits_24h':117,'hands_1h':20,'commits_1h':17};check('new',1)
    # NULL metadata cannot match SQL equality; out-of-order/negative numbers and
    # old/future receipts do not change identity membership. Receipt timestamps
    # are deliberately irrelevant; the hand window defines both populations.
    q("UPDATE hand_history SET table_id=NULL WHERE hand_number=117; UPDATE hand_history SET hand_number=NULL WHERE hand_number=116; UPDATE hand_history SET hand_number=-115 WHERE hand_number=115; UPDATE hand_atomic_commits SET hand_number=-115 WHERE hand_number=115;")
    assert counts()['commits_1h'] == 15
    q("INSERT INTO hand_atomic_commits VALUES(md5('extra')::uuid,md5('extra-table')::uuid,999999999);")
    assert counts()['commits_1h'] == 15
    exact=q('''BEGIN; TRUNCATE hand_history,hand_atomic_commits,settlement_idempotency_keys;
      INSERT INTO hand_history SELECT md5('edge'||n)::uuid,md5('edge-table')::uuid,n,now()+v,true FROM (VALUES(1,-interval '24 hours'),(2,-interval '24 hours'+interval '1 microsecond'),(3,-interval '60 minutes'),(4,-interval '60 minutes'+interval '1 microsecond'),(5,interval '1 day'),(6,NULL::interval))e(n,v);
      INSERT INTO hand_atomic_commits SELECT id,table_id,hand_number FROM hand_history;
      SELECT row_to_json(x) FROM ('''+read+''')x; ROLLBACK;''')
    assert json.loads(exact)=={'hands_24h':4,'commits_24h':4,'hands_1h':2,'commits_1h':2}
    seed(120,120,20,20)
    reader=subprocess.Popen([str(x) for x in cmd()],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,bufsize=1)
    def rd(sql):
        reader.stdin.write(sql+'\n');reader.stdin.flush();return reader.stdout.readline().strip()
    assert json.loads(rd('SET ROLE postgres; BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT row_to_json(t) FROM ('+read+')t;'))['hands_24h']==120
    q("BEGIN; INSERT INTO hand_history VALUES(md5('concurrent')::uuid,md5('concurrent-table')::uuid,900000,now(),false); INSERT INTO hand_atomic_commits SELECT id,table_id,hand_number FROM hand_history WHERE hand_number=900000; COMMIT;")
    assert json.loads(rd('SELECT row_to_json(t) FROM ('+read+')t;'))['hands_24h']==120
    assert json.loads(rd('COMMIT; SELECT row_to_json(t) FROM ('+read+')t;'))=={'hands_24h':121,'commits_24h':121,'hands_1h':21,'commits_1h':21}
    reader.stdin.close();assert reader.wait(timeout=5)==0
    # Independent unbounded EXISTS oracle: verifies materialized min/max pruning
    # and joined counts for all generated mixed, null and wrong-identity rows.
    q('''TRUNCATE hand_history,hand_atomic_commits; INSERT INTO hand_history
      SELECT md5(n::text)::uuid,CASE WHEN n%13=0 THEN NULL ELSE md5((n%7)::text)::uuid END,
        CASE WHEN n%17=0 THEN NULL ELSE n*(-1)^(n%2) END,now()-make_interval(hours=>n%30),CASE WHEN n%3=0 THEN NULL ELSE n%2=0 END FROM generate_series(1,1200)n;
      INSERT INTO hand_atomic_commits SELECT id,CASE WHEN hand_number%19=0 THEN md5('wrong')::uuid ELSE table_id END,hand_number FROM hand_history WHERE hand_number IS NOT NULL AND table_id IS NOT NULL AND hand_number%5<>0;''')
    oracle=q("SELECT jsonb_build_object('hands_24h',count(*),'commits_24h',count(*) FILTER(WHERE EXISTS(SELECT FROM hand_atomic_commits c WHERE c.hand_id=h.id AND c.table_id=h.table_id AND c.hand_number=h.hand_number)),'hands_1h',count(*) FILTER(WHERE created_at>now()-interval '60 minutes'),'commits_1h',count(*) FILTER(WHERE created_at>now()-interval '60 minutes' AND EXISTS(SELECT FROM hand_atomic_commits c WHERE c.hand_id=h.id AND c.table_id=h.table_id AND c.hand_number=h.hand_number))) FROM hand_history h WHERE created_at>now()-interval '24 hours';")
    assert counts()==json.loads(oracle)
    assert catalog()==cat
    assert q("SELECT md5(pg_get_functiondef('"+core_sig+"'::regprocedure));")=='b49192e78f472d7a931bcf20de46a702'
    assert q("SELECT md5(pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure));")=='f75b94afaf46ff91db120bc34e1dc2ae'
    print(json.dumps({'source':'exact old/new G blocks','roles':'NOSUPERUSER BYPASSRLS owner/service/browser denial','otherFinancialBodiesExecuted':False,'incidentSink':'explicit local fixture adapter','identityOracle':counts()}))
    print('atomic-coverage-native-acceptance-passed')
finally:
    if reader and reader.poll() is None:
        reader.terminate();reader.wait(timeout=5)
    if started and (data/'postmaster.pid').exists():
        run([pg/'pg_ctl','-D',data,'-m','fast','-w','stop'])
    shutil.rmtree(cluster);shutil.rmtree(sock)
