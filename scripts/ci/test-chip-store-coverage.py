#!/usr/bin/env python3
"""Actual predecessor/candidate coverage reads in an isolated native PG17.

No production connection and no financial producer. Whole function results,
native execution plans, authority, rollback and concurrent snapshot semantics.
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
import time

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'scripts/ci/fixtures/chip-store-coverage'
MIGRATION = ROOT / 'supabase/migrations/20260927162106_chip_store_coverage_aggregates_recent_ledger_once.sql'
parser = argparse.ArgumentParser()
parser.add_argument('--pg-bin', default=os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
parser.add_argument('--baseline', action='store_true', help='Predecessor must fail the one-scan gate.')
args = parser.parse_args()
pg = Path(args.pg_bin)
cluster = Path(tempfile.mkdtemp(prefix='coverage-native-', dir=os.environ.get('RUNNER_TEMP')))
socket = Path(tempfile.mkdtemp(prefix='coverage-socket-'))
data = cluster / 'data'
env = {'PATH': str(pg) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
started = False
children = []
report = {'migrationSHA256': hashlib.sha256(MIGRATION.read_bytes()).hexdigest()}


def run(argv, sql=None, expected=None, timeout=120):
    p = subprocess.run([str(x) for x in argv], input=sql, text=True,
                       capture_output=True, timeout=timeout, env=env)
    if expected:
        assert p.returncode and expected in p.stderr, p.stdout+p.stderr
    elif p.returncode:
        raise RuntimeError(p.stdout+p.stderr)
    return p.stdout.strip()


def q(sql, expected=None, role='fixture_admin'):
    return run([pg/'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket,
                '-U', role, '-d', 'postgres'], sql, expected)


def quote(s):
    return "'"+s.replace("'", "''")+"'"


def state():
    return json.loads(q("SELECT jsonb_build_object('oid',oid,'acl',proacl,'owner',proowner::regrole::text,'config',proconfig,'definer',prosecdef,'volatility',provolatile,'definition',pg_get_functiondef(oid)) FROM pg_proc WHERE oid='public.fn_ca_chip_store_coverage_gaps()'::regprocedure"))


def result_sql():
    return "SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.store,r.gap,r.detail),'[]'::jsonb) FROM fn_ca_chip_store_coverage_gaps() r;"


def outcome(setup='', definition=None):
    source = definition+';' if definition else ''
    return json.loads(q('BEGIN;'+source+setup+'SET ROLE service_role;'+result_sql()+'ROLLBACK;'))


def nodes(node):
    yield node
    for child in node.get('Plans', []):
        yield from nodes(child)


def plan(fragment, setup=''):
    query = fragment.replace('  RETURN QUERY\n', '', 1).strip().rstrip(';')
    return json.loads(q('BEGIN;'+setup+'EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT count(*),jsonb_agg(to_jsonb(r)) FROM ('+query+')r; ROLLBACK;'))[0]


def wait_for(sql):
    until = time.monotonic()+8
    while time.monotonic()<until:
        if q(sql)=='t':
            return
        time.sleep(.025)
    raise AssertionError('Native condition not observed: '+sql)


try:
    assert ' 17.' in run([pg/'postgres', '--version'])
    run([pg/'initdb','-D',data,'-U','fixture_admin','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
    with (data/'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(socket)+"'\nshared_buffers='64MB'\nmax_parallel_workers_per_gather=0\n")
    started = True
    run([pg/'pg_ctl','-D',data,'-l',cluster/'server.log','-w','start'])
    q("""CREATE ROLE postgres NOSUPERUSER BYPASSRLS LOGIN;
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE ROLE authenticator NOINHERIT LOGIN; GRANT anon,authenticated,service_role TO authenticator;
      GRANT USAGE,CREATE ON SCHEMA public TO postgres;
      CREATE TABLE chip_ledger(id bigserial PRIMARY KEY,amount numeric(15,2) NOT NULL,
        category text NOT NULL,metadata jsonb,created_at timestamptz NOT NULL,
        from_type text NOT NULL,to_type text NOT NULL,payload text,
        CONSTRAINT chip_ledger_from_type_check CHECK(from_type IN('settlement_suspense','rakeback_payable','refund_payable','credit_facility','credit_receivable','player_wallet','undeclared_store')),
        CONSTRAINT chip_ledger_to_type_check CHECK(to_type IN('settlement_suspense','rakeback_payable','refund_payable','credit_facility','credit_receivable','player_wallet','undeclared_store')));
      CREATE TABLE ca_chip_store_coverage(store text PRIMARY KEY,treatment text NOT NULL CHECK(treatment IN('counted','noncirculating','uncounted')));
      ALTER TABLE chip_ledger ALTER COLUMN payload SET STORAGE PLAIN;
      ALTER TABLE chip_ledger OWNER TO postgres; ALTER TABLE ca_chip_store_coverage OWNER TO postgres;
      ALTER TABLE chip_ledger ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ca_chip_store_coverage ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON chip_ledger,ca_chip_store_coverage TO authenticated;
      CREATE INDEX chip_ledger_time ON chip_ledger(created_at);
      INSERT INTO ca_chip_store_coverage VALUES
        ('settlement_suspense','uncounted'),('rakeback_payable','uncounted'),
        ('refund_payable','uncounted'),('credit_facility','uncounted'),
        ('credit_receivable','uncounted'),('player_wallet','counted');""")
    baseline = json.loads((FIXTURE/'baseline.json').read_text())['function']
    before = baseline['definition']
    after = (FIXTURE/'function-after.sql').read_text()
    old = (FIXTURE/'read-before.sql').read_text()
    new = (FIXTURE/'read-after.sql').read_text()
    assert before.count(old)==1 and before.replace(old,new)==after
    assert hashlib.md5(before.encode()).hexdigest()==baseline['md5']
    q(before+"; ALTER FUNCTION fn_ca_chip_store_coverage_gaps() OWNER TO postgres; SET ROLE postgres; REVOKE ALL ON FUNCTION fn_ca_chip_store_coverage_gaps() FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION fn_ca_chip_store_coverage_gaps() TO service_role;")
    original = state()
    assert original['owner']=='postgres' and original['acl']==baseline['acl']
    migration = MIGRATION.read_text()
    assert '$old$'+old+'$old$' in migration and '$new$'+new+'$new$' in migration
    proof = re.search(r'^-- @live-proof: (.+)$',migration,re.M).group(1)
    assert q('SELECT '+proof)=='f'

    fixtures = {
      'empty': '',
      'no-uncounted-stores': "UPDATE ca_chip_store_coverage SET treatment='counted';",
      'all-declared': "INSERT INTO ca_chip_store_coverage VALUES('undeclared_store','noncirculating');",
      'boundaries': """INSERT INTO chip_ledger(amount,category,metadata,created_at,from_type,to_type) VALUES
        (10,'transfer',NULL,now()-interval '1 hour','player_wallet','rakeback_payable'),
        (3,'transfer','{}',now(),'rakeback_payable','refund_payable'),
        (-2,'transfer','{}',now(),'player_wallet','rakeback_payable'),
        (5,'transfer','{}',now(),'rakeback_payable','rakeback_payable'),
        (999,'transfer','{}',now()-interval '24 hours','player_wallet','rakeback_payable'),
        (888,'transfer','{}',now()-interval '24 hours 1 microsecond','player_wallet','rakeback_payable'),
        (1,'transfer','{}',now()-interval '24 hours'+interval '1 microsecond','player_wallet','rakeback_payable'),
        (2,'transfer','{}',now()+interval '1 day','player_wallet','rakeback_payable'),
        (777,'correction','{"posted_via":"fn_ca_post_correction"}',now(),'player_wallet','rakeback_payable'),
        (666,'correction',NULL,now(),'player_wallet','rakeback_payable'),
        (555,'correction','{}',now(),'player_wallet','rakeback_payable'),
        (4,'correction','{"posted_via":"other"}',now(),'player_wallet','rakeback_payable');""",
      'zero-self-and-negative': "INSERT INTO chip_ledger(amount,category,created_at,from_type,to_type) VALUES(0,'transfer',now(),'credit_facility','credit_receivable'),(9,'transfer',now(),'refund_payable','refund_payable'),(-7.12,'transfer',now(),'credit_facility','credit_receivable');",
      'nan': "INSERT INTO chip_ledger(amount,category,created_at,from_type,to_type) VALUES('NaN','transfer',now(),'credit_facility','credit_receivable');",
      'duplicate-coverage': "ALTER TABLE ca_chip_store_coverage DROP CONSTRAINT ca_chip_store_coverage_pkey; INSERT INTO ca_chip_store_coverage VALUES('rakeback_payable','uncounted'); INSERT INTO chip_ledger(amount,category,created_at,from_type,to_type) VALUES(4,'transfer',now(),'player_wallet','rakeback_payable');",
      'null-fields': "ALTER TABLE chip_ledger ALTER from_type DROP NOT NULL, ALTER to_type DROP NOT NULL, ALTER amount DROP NOT NULL, ALTER category DROP NOT NULL; INSERT INTO chip_ledger(amount,category,metadata,created_at,from_type,to_type) VALUES(NULL,'transfer',NULL,now(),NULL,'rakeback_payable'),(2,'transfer',NULL,now(),NULL,'rakeback_payable'),(8,NULL,'{}',now(),'player_wallet','rakeback_payable'),(3,NULL,'{\"posted_via\":\"other\"}',now(),'player_wallet','refund_payable');",
    }
    results = {}
    for name,setup in fixtures.items():
        predecessor = outcome(setup)
        candidate = outcome(setup,after)
        assert predecessor==candidate,(name,predecessor,candidate)
        results[name] = candidate
    # Independent arithmetic: 10-3-2+1+2+4=12, self/old/excluded/unknown legs add zero.
    assert next(r for r in results['boundaries'] if r['store']=='rakeback_payable')['detail'].endswith('12.00 in the last 24h, so that movement reads as drift')
    assert next(r for r in results['boundaries'] if r['store']=='refund_payable')['detail'].endswith('3.00 in the last 24h, so that movement reads as drift')
    assert results['all-declared']==[]
    report['wholeResultFixtures'] = list(results)

    # Exact installed authority denies browsers even though tables also have RLS.
    for role in ('anon','authenticated'):
        q('SET ROLE '+role+';'+result_sql(),'permission denied')
    assert q('SET ROLE authenticated; SELECT count(*) FROM chip_ledger;')=='0'
    for mutation in ["GRANT EXECUTE ON FUNCTION fn_ca_chip_store_coverage_gaps() TO authenticated;",
                     "ALTER FUNCTION fn_ca_chip_store_coverage_gaps() SET statement_timeout='1s';",
                     'ALTER FUNCTION fn_ca_chip_store_coverage_gaps() OWNER TO fixture_admin;',
                     before.replace('RETURN QUERY','/* source drift */ RETURN QUERY',1)+';']:
        q(migration.replace('BEGIN;','BEGIN;'+mutation,1),'CHIP_STORE_COVERAGE_SOURCE_OR_AUTHORITY_CHANGED')
        assert state()==original
    q(migration.replace('BEGIN;',"BEGIN; ALTER TABLE chip_ledger ALTER amount TYPE double precision;",1),'CHIP_STORE_COVERAGE_AMOUNT_TYPE_CHANGED')
    assert state()==original
    q(migration.replace('COMMIT;','ROLLBACK;'))
    assert state()==original
    q('SET ROLE postgres;'+migration)
    installed = state()
    assert installed['definition']==after
    assert {k:v for k,v in installed.items() if k!='definition'}=={k:v for k,v in original.items() if k!='definition'}
    assert q('SELECT '+proof)=='t'
    q(migration,'CHIP_STORE_COVERAGE_SOURCE_OR_AUTHORITY_CHANGED')

    # Keep one existing repeatable-read snapshot while another session commits.
    reader = subprocess.Popen([str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(socket),'-U','authenticator','-d','postgres'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
    children.append(reader)
    reader.stdin.write("SET application_name='coverage_snapshot'; SET ROLE service_role; BEGIN ISOLATION LEVEL REPEATABLE READ;"+result_sql()+'\n');reader.stdin.flush()
    wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='coverage_snapshot' AND state='idle in transaction' AND backend_xmin IS NOT NULL)")
    q("INSERT INTO chip_ledger(amount,category,created_at,from_type,to_type) VALUES(17,'transfer',now(),'player_wallet','rakeback_payable');")
    reader.stdin.write(result_sql()+'ROLLBACK;\n');reader.stdin.close()
    assert reader.wait(timeout=10)==0,reader.stderr.read()
    observed=[json.loads(line) for line in reader.stdout.read().splitlines() if line.startswith('[')]
    assert len(observed)==2 and observed[0]==observed[1]==results['empty']
    assert outcome()!=results['empty']
    report['concurrentSnapshotPreserved']=True

    q("TRUNCATE chip_ledger; INSERT INTO chip_ledger(amount,category,metadata,created_at,from_type,to_type,payload) SELECT n%19-9,'transfer','{}',now()-interval '1 hour',CASE WHEN n%2=0 THEN 'player_wallet' ELSE 'refund_payable' END,CASE n%5 WHEN 0 THEN 'rakeback_payable' WHEN 1 THEN 'credit_facility' WHEN 2 THEN 'credit_receivable' WHEN 3 THEN 'settlement_suspense' ELSE 'refund_payable' END,repeat('x',1024) FROM generate_series(1,60000)n; VACUUM ANALYZE chip_ledger; ANALYZE ca_chip_store_coverage;")
    assert outcome(definition=before)==outcome()
    old_plan=plan(old);new_plan=plan(old if args.baseline else new)
    scan_work=lambda p:sum(n['Actual Loops'] for n in nodes(p['Plan']) if n.get('Relation Name')=='chip_ledger')
    empty_plan=plan(new, "UPDATE ca_chip_store_coverage SET treatment='counted'; ANALYZE ca_chip_store_coverage;")
    assert scan_work(empty_plan)==0, 'CHIP_STORE_COVERAGE_NO_REQUIRED_STORE_SCANNED'
    report['before']={'scans':scan_work(old_plan),'buffers':old_plan['Plan']['Shared Hit Blocks']+old_plan['Plan']['Shared Read Blocks'],'ms':old_plan['Execution Time']}
    report['after']={'scans':scan_work(new_plan),'buffers':new_plan['Plan']['Shared Hit Blocks']+new_plan['Plan']['Shared Read Blocks'],'ms':new_plan['Execution Time']}
    print(json.dumps(report,indent=2),flush=True)
    assert report['before']['scans']>=5
    assert report['after']['scans']==1,'CHIP_STORE_COVERAGE_REPEATED_LEDGER_SCAN'
    assert report['after']['buffers']<report['before']['buffers']/2
    print('PASS exact whole coverage, authority, rollback, concurrent snapshot and single ledger scan')
finally:
    for child in children:
        if child.poll() is None:
            child.kill();child.wait(timeout=10)
    if started:
        run([pg/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
    shutil.rmtree(cluster,ignore_errors=True)
    shutil.rmtree(socket,ignore_errors=True)
