#!/usr/bin/env python3
"""Qualify the existing BBJ meter read path in an isolated native PG17 cluster.

No production connection or money command. Execute the exact captured function
and exact migration, comparing the whole returned financial row against both
the predecessor and an independently calculated boundary fixture. Measure the
same extracted SELECT before/after on a wide, mixed ledger; custom and generic
plans must use both scoped indexes without scanning unrelated pool tuples.
Labels remain heap reads so valid large text never becomes a B-tree value.
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
CAPTURE = ROOT / 'scripts/ci/fixtures/bbj-audit-reads/baseline.json'
MIGRATION = ROOT / 'supabase/migrations/20260927050742_bbj_meter_reads_only_pool_ledger_legs.sql'
ONLINE = ROOT / 'scripts/ops/build-bbj-audit-indexes-concurrently.sql'
parser = argparse.ArgumentParser()
parser.add_argument('--pg-bin', default=os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
parser.add_argument('--baseline', action='store_true', help='Require bounded pool reads without the new indexes (regression must fail).')
args = parser.parse_args()
pg = Path(args.pg_bin)
cluster = Path(tempfile.mkdtemp(prefix='bbj-audit-', dir=os.environ.get('RUNNER_TEMP')))
socket = Path(tempfile.mkdtemp(prefix='bbj-audit-socket-'))
data = cluster / 'data'
env = {'PATH': str(pg) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
started = False
writer = None
children = []
report = {'captureSHA256': hashlib.sha256(CAPTURE.read_bytes()).hexdigest(),
          'migrationSHA256': hashlib.sha256(MIGRATION.read_bytes()).hexdigest(),
          'onlineSHA256': hashlib.sha256(ONLINE.read_bytes()).hexdigest(), 'plans': []}


def run(argv, sql=None, expected=None, timeout=120):
    result = subprocess.run([str(v) for v in argv], input=sql, text=True,
                            capture_output=True, env=env, timeout=timeout)
    if expected:
        assert result.returncode and expected in result.stderr, result.stdout + result.stderr
    elif result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result.stdout.strip()


def q(sql, expected=None, role='fixture_admin'):
    return run([pg/'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket,
                '-U', role, '-d', 'postgres'], sql, expected)


def uid(n):
    return '00000000-0000-0000-0000-' + str(n).zfill(12)


def quote(s):
    return "'" + str(s).replace("'", "''") + "'"


def state():
    return json.loads(q("SELECT jsonb_build_object('oid',oid,'acl',proacl,'owner',proowner::regrole::text,'config',proconfig,'definer',prosecdef,'definition',pg_get_functiondef(oid)) FROM pg_proc WHERE oid='public.fn_bbj_reconcile(uuid)'::regprocedure"))


def measure(pool):
    # Roll back every observation, including its snapshot row. Sequence gaps
    # are intentionally excluded; all bank/journal/flow/basis fields are compared.
    raw = q("BEGIN; SET ROLE service_role; SELECT to_jsonb(s)-'id'-'taken_at'-'prev_id' FROM public.fn_bbj_reconcile(" + quote(uid(pool)) + ") s; ROLLBACK;")
    return json.loads(raw)


def legs_query(definition):
    source = definition[definition.index('  WITH legs AS ('):definition.index('  SELECT count(*) INTO v_fail')].strip()
    source, count = re.subn(r'\s+INTO v_main,[\s\S]*?v_moves\s+FROM banks', '\n    FROM banks', source)
    assert count == 1
    return source.replace('p_pool_id', '$1').replace('v_prev.taken_at', '$2').replace('v_base.taken_at', '$3').rstrip(';')


def plan(query, pool, mode):
    return json.loads(q("SET plan_cache_mode=" + mode + "; PREPARE bbj_read(uuid,timestamptz,timestamptz) AS " + query + "; EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE bbj_read(" + quote(uid(pool)) + ",'2020-01-02Z','2020-01-01Z');"))[0]


def nodes(node):
    yield node
    for child in node.get('Plans', []):
        yield from nodes(child)


def wait_for(sql):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if q(sql) == 't':
            return
        time.sleep(.025)
    raise AssertionError('Native condition not observed: ' + sql)


def session(sql):
    proc = subprocess.Popen([str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1',
        '-h',str(socket),'-U','fixture_admin','-d','postgres'],stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
    children.append(proc)
    proc.stdin.write(sql+'\n'); proc.stdin.flush()
    return proc


def snapshot():
    proc = session("SET application_name='bbj_fixture_snapshot'; BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT id FROM chip_ledger LIMIT 1;")
    wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='bbj_fixture_snapshot' AND state='idle in transaction' AND backend_xmin IS NOT NULL)")
    return proc


def release(proc):
    proc.stdin.write('ROLLBACK;\n'); proc.stdin.close()
    assert proc.wait(timeout=10)==0,proc.stderr.read()


try:
    assert ' 17.' in run([pg/'postgres', '--version'])
    run([pg/'initdb', '-D', data, '-U', 'fixture_admin', '--auth-local=trust', '--auth-host=reject', '--no-locale', '-E', 'UTF8'])
    with (data/'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\nshared_buffers='64MB'\nmax_parallel_workers_per_gather=0\n")
    started = True
    run([pg/'pg_ctl', '-D', data, '-l', cluster/'server.log', '-w', 'start'])
    q("""CREATE ROLE postgres NOSUPERUSER BYPASSRLS LOGIN;
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE ROLE authenticator NOINHERIT LOGIN; GRANT anon,authenticated,service_role TO authenticator;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO postgres,anon,authenticated,service_role;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.role',true),'')$$;
      CREATE TABLE bbj_pools(id uuid PRIMARY KEY,main_balance numeric,backup_balance numeric,promo_balance numeric);
      CREATE TABLE chip_ledger(id bigserial PRIMARY KEY,category text NOT NULL,amount numeric(15,2) NOT NULL,
        from_type text NOT NULL,to_type text NOT NULL,from_entity_id uuid,to_entity_id uuid,
        from_label text,to_label text,created_at timestamptz NOT NULL,payload text);
      ALTER TABLE chip_ledger ALTER COLUMN payload SET STORAGE PLAIN;
      CREATE INDEX idx_chip_ledger_created_at ON chip_ledger(created_at);
      CREATE INDEX idx_chip_ledger_to_entity_created ON chip_ledger(to_entity_id,created_at DESC);
      CREATE INDEX idx_chip_ledger_from_entity_created ON chip_ledger(from_entity_id,created_at DESC);
      CREATE TABLE ca_bbj_pool_snapshots(id bigserial PRIMARY KEY,pool_id uuid NOT NULL,taken_at timestamptz NOT NULL,
        is_baseline boolean NOT NULL DEFAULT false,prev_id bigint,main numeric NOT NULL,backup numeric NOT NULL,promo numeric NOT NULL,
        journal_main numeric NOT NULL DEFAULT 0,journal_backup numeric NOT NULL DEFAULT 0,journal_promo numeric NOT NULL DEFAULT 0,
        drops_since numeric NOT NULL DEFAULT 0,payouts_since numeric NOT NULL DEFAULT 0,sweeps_since numeric NOT NULL DEFAULT 0,
        funding_since numeric NOT NULL DEFAULT 0,moves_since numeric NOT NULL DEFAULT 0,write_failures integer NOT NULL DEFAULT 0,
        unexplained_main numeric NOT NULL DEFAULT 0,unexplained_backup numeric NOT NULL DEFAULT 0,unexplained_promo numeric NOT NULL DEFAULT 0,
        note text,basis_version text,UNIQUE(pool_id,taken_at));
      CREATE INDEX ca_bbj_pool_snapshots_pool_idx ON ca_bbj_pool_snapshots(pool_id,taken_at DESC);
      CREATE TABLE ca_ledger_write_failures(id bigserial PRIMARY KEY,occurred_at timestamptz NOT NULL,message text);
      ALTER TABLE bbj_pools OWNER TO postgres; ALTER TABLE chip_ledger OWNER TO postgres;
      ALTER TABLE ca_bbj_pool_snapshots OWNER TO postgres; ALTER TABLE ca_ledger_write_failures OWNER TO postgres;
      GRANT USAGE,CREATE ON SCHEMA public TO postgres;""")
    capture = json.loads(CAPTURE.read_text())
    q(capture['definition'] + "; ALTER FUNCTION fn_bbj_reconcile(uuid) OWNER TO postgres;")
    q("SET ROLE postgres; REVOKE ALL ON FUNCTION fn_bbj_reconcile(uuid) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION fn_bbj_reconcile(uuid) TO service_role;")
    before = state()
    assert hashlib.md5(before['definition'].encode()).hexdigest() == capture['md5']
    assert before['owner'] == 'postgres' and before['acl'] == ['postgres=X/postgres', 'service_role=X/postgres']
    for pool in (1, 2, 3, 4):
        q("INSERT INTO bbj_pools VALUES(" + quote(uid(pool)) + ",100,10,5); INSERT INTO ca_bbj_pool_snapshots(pool_id,taken_at,is_baseline,main,backup,promo,basis_version) VALUES(" + quote(uid(pool)) + ",'2020-01-01Z',true,100,10,5,'cumulative-since-open-v1'),(" + quote(uid(pool)) + ",'2020-01-02Z',false,100,10,5,'cumulative-since-open-v1');")

    def leg(amount, bank='main_balance', side='in', date='2020-01-03Z', category='adjustment', source=None, target=None, from_type=None, to_type=None, other_label=None):
        fields = [category, amount, from_type or ('club_treasury' if side=='in' else 'bbj_pool'),
                  to_type or ('bbj_pool' if side=='in' else 'player_wallet'),
                  uid(1) if source is None and side=='out' else (uid(source) if source else None),
                  uid(1) if target is None and side=='in' else (uid(target) if target else None),
                  'bbj_pools.'+bank if side=='out' else other_label,
                  'bbj_pools.'+bank if side=='in' else other_label, date]
        q('INSERT INTO chip_ledger(category,amount,from_type,to_type,from_entity_id,to_entity_id,from_label,to_label,created_at) VALUES(' + ','.join('NULL' if x is None else quote(x) for x in fields) + ')')

    leg(10,date='2020-01-01 12:00Z',category='bbj_contribution')
    leg(7.25,category='bbj_contribution')
    leg(5,side='out',category='bbj_payout')
    leg(3,bank='promo_balance',side='out',category='promo')
    leg(4,bank='backup_balance',category='transfer')
    leg(2,side='out',target=1,to_type='bbj_pool')
    leg(2,bank='backup_balance',source=1,from_type='bbj_pool')
    leg(1,other_label='bbj_pools.promo_balance')
    leg(6,bank='backup_balance',source=1,target=2,from_type='bbj_pool',other_label='bbj_pools.main_balance',category='transfer')
    leg(1.5,side='out',target=0)
    leg(.5,side='out',target=1,to_type='player_wallet')
    leg(1.25,bank='promo_balance',side='out',target=0,to_type='bbj_pool',category='promo')
    leg(99,date='2019-12-31Z')
    leg(88,date='2020-01-01Z')
    leg(1,date='2020-01-02Z',category='bbj_contribution')
    leg(2,date='2099-01-01Z',category='bbj_contribution')
    leg(9,bank='unknown_bank',category='bbj_contribution')
    leg(999,from_type='player_wallet',to_type='player_wallet')
    leg(19,target=2,category='bbj_contribution')
    # Labels have no database length constraint. A read optimization must not
    # impose a new B-tree tuple-size limit on an otherwise valid money leg.
    long_label = ''.join(hashlib.sha256(str(n).encode()).hexdigest() for n in range(128))
    leg(.11,other_label=long_label)
    leg(.12,side='out',other_label=long_label)
    q("INSERT INTO chip_ledger(category,amount,from_type,to_type,to_entity_id,to_label,created_at) VALUES('bbj_contribution',999,'club_treasury','bbj_pool',"+quote(uid(1))+",'someone_else.main_balance','2020-01-03Z');")
    q("UPDATE bbj_pools SET main_balance=112.24,backup_balance=22,promo_balance=.75 WHERE id="+quote(uid(1))+"; INSERT INTO ca_ledger_write_failures(occurred_at,message) VALUES ('2020-01-03Z','bbj_pools.main_balance failure'),('2020-01-02Z','bbj_pools.promo_balance boundary'),('2099-01-01Z','bbj_pools.main_balance future'),('2020-01-03Z','other table failure');")
    old_rows = [measure(n) for n in (1,2,3,4)]
    expected = {'main':112.24,'backup':22,'promo':.75,'journal_main':12.24,'journal_backup':12,
                'journal_promo':-4.25,'drops_since':18.25,'payouts_since':5,'sweeps_since':4.25,
                'funding_since':10,'moves_since':5.63,'write_failures':1,
                'unexplained_main':0,'unexplained_backup':0,'unexplained_promo':0,
                'basis_version':'cumulative-since-open-v1','is_baseline':False,'note':None,'pool_id':uid(1)}
    # moves includes every qualifying both-bbj-type leg / 2, including the
    # NULL-destination outgoing 1.25 leg. This is the predecessor's exact rule.
    assert old_rows[0] == expected, (old_rows[0], expected)
    assert old_rows[2]['journal_main'] == 0 and old_rows[2]['unexplained_main'] == 0
    q("SELECT fn_bbj_reconcile("+quote(uid(99))+")", 'has no opening balance')
    q("BEGIN; DELETE FROM ca_bbj_pool_snapshots WHERE pool_id="+quote(uid(4))+" AND is_baseline; SELECT fn_bbj_reconcile("+quote(uid(4))+"); ROLLBACK;", 'has no opening balance row')
    q("BEGIN; DELETE FROM bbj_pools WHERE id="+quote(uid(4))+"; SELECT fn_bbj_reconcile("+quote(uid(4))+"); ROLLBACK;", 'not found')

    migration = MIGRATION.read_text()
    split = json.loads(run([shutil.which('node'), '--input-type=module', '-e',
        "import{readFileSync}from'node:fs';import{splitConcurrentPreamble}from'"+(ROOT/'scripts/ci/migration-concurrent-preamble.mjs').as_uri()+"';console.log(JSON.stringify(splitConcurrentPreamble(readFileSync(process.argv[1],'utf8')+String.fromCharCode(10)+'BEGIN;'+String.fromCharCode(10)+'COMMIT;')));", ONLINE]))
    assert split['ok'] and len(split['indexes']) == 2, split
    body = migration
    live_proof = re.search(r"^-- @live-proof: (.+)$", migration, re.M).group(1)
    assert q("SELECT "+live_proof)=='f'
    assert not re.search(r'^\s*(?:CREATE\s+INDEX|REINDEX)', body, re.I|re.M)
    q(body, 'BBJ_METER_READ_INDEX_NOT_QUALIFIED')
    assert state() == before
    # A same-name existing index is not proof of a usable equivalent index.
    q('CREATE INDEX chip_ledger_bbj_to_pool_meter ON chip_ledger(to_entity_id);')
    q(body, 'BBJ_METER_READ_INDEX_NOT_QUALIFIED')
    q('DROP INDEX chip_ledger_bbj_to_pool_meter;')
    # A real failed concurrent UNIQUE build leaves a genuine invalid index.
    # It is deliberately local; production never creates an index as a probe.
    q('CREATE UNIQUE INDEX CONCURRENTLY chip_ledger_bbj_to_pool_meter ON chip_ledger(to_entity_id);', 'could not create unique index')
    assert q("SELECT NOT indisvalid FROM pg_index WHERE indexrelid='chip_ledger_bbj_to_pool_meter'::regclass") == 't'
    q(body, 'BBJ_METER_READ_INDEX_NOT_QUALIFIED')
    q('DROP INDEX chip_ledger_bbj_to_pool_meter;')
    assert state() == before
    for role in ('anon','authenticated'):
        q("SET ROLE "+role+"; SELECT fn_bbj_reconcile("+quote(uid(1))+")", 'permission denied', role='authenticator')

    # Read-only performance workload: 600k interleaved 512-byte unrelated and
    # BBJ rows, two large pools and one small. No real-world data or secrets.
    q("INSERT INTO chip_ledger(category,amount,from_type,to_type,from_entity_id,to_entity_id,from_label,to_label,created_at,payload) SELECT 'bbj_contribution',.01,'club_treasury',CASE WHEN g%10<2 OR g%10000=3 THEN 'bbj_pool' ELSE 'player_wallet' END,NULL,CASE WHEN g%10=0 THEN "+quote(uid(1))+"::uuid WHEN g%10=1 THEN "+quote(uid(2))+"::uuid WHEN g%10000=3 THEN "+quote(uid(3))+"::uuid ELSE "+quote(uid(4))+"::uuid END,NULL,CASE WHEN g%10<2 OR g%10000=3 THEN 'bbj_pools.main_balance' ELSE 'club_members.chip_balance' END,'2020-01-03Z'::timestamptz+g*interval '1 millisecond',repeat(md5(g::text),16) FROM generate_series(1,600000) g;")
    q('VACUUM (ANALYZE) chip_ledger;')
    old_query = legs_query(capture['definition'])
    old_plans = {(n, mode): plan(old_query,n,mode) for n in (1,2,3) for mode in ('force_custom_plan','force_generic_plan')}
    performance_rows = [measure(n) for n in (1,2,3,4)]

    if not args.baseline:
        for number,index in enumerate(split['indexes']):
            q(index['statement'])
            if number==0:
                q(body,'BBJ_METER_READ_INDEX_NOT_QUALIFIED')
                assert q("SELECT "+live_proof)=='f'
    report['indexBytes'] = json.loads(q("SELECT coalesce(jsonb_object_agg(relname,pg_relation_size(oid)),'{}'::jsonb) FROM pg_class WHERE relname IN ('chip_ledger_bbj_to_pool_meter','chip_ledger_bbj_from_pool_meter')"))
    q('VACUUM (ANALYZE) chip_ledger;')
    if not args.baseline:
        q(body.replace('COMMIT;', 'ROLLBACK;'))
        assert state() == before, 'rolled-back installation changed the function'
        q('GRANT EXECUTE ON FUNCTION fn_bbj_reconcile(uuid) TO anon;')
        q(body, 'BBJ_METER_READ_PREIMAGE_DRIFT')
        q('REVOKE EXECUTE ON FUNCTION fn_bbj_reconcile(uuid) FROM anon;')
        q(body)
        q(body)  # Verification-only body is idempotent; no money/function write.
        assert q("SELECT "+live_proof)=='t'
    after = state()
    assert after == before, 'index installation must not change any financial function byte or authority'
    assert [measure(n) for n in (1,2,3,4)] == performance_rows
    new_query = legs_query(after['definition'])
    for n in (1,2,3):
        for mode in ('force_generic_plan','force_custom_plan'):
            actual = plan(new_query,n,mode)
            scans = [x for x in nodes(actual['Plan']) if x.get('Relation Name')=='chip_ledger']
            inspected = sum((x['Actual Rows']+x.get('Rows Removed by Filter',0))*x['Actual Loops'] for x in scans)
            assert inspected < (75000 if n in (1,2) else 100), ('BBJ_METER_READ_PLAN_NOT_SCOPED',n,mode,inspected)
            indexes = [x for x in nodes(actual['Plan']) if x.get('Index Name','').startswith('chip_ledger_bbj_')]
            assert {x['Index Name'] for x in indexes} == {x['name'] for x in split['indexes']}
            assert all('entity_id =' in x['Index Cond'] and 'created_at >' in x['Index Cond'] for x in indexes)
            assert all(x['Node Type'] in ('Index Scan','Bitmap Heap Scan') for x in scans)
            previous = old_plans[(n,mode)]
            old_blocks = sum(previous['Plan'].get(k,0) for k in ('Shared Hit Blocks','Shared Read Blocks'))
            new_blocks = sum(actual['Plan'].get(k,0) for k in ('Shared Hit Blocks','Shared Read Blocks'))
            # Heap reads are retained deliberately. No arbitrary millisecond
            # speed claim is a gate; the bound is on the actual tuple work.
            if n==1 and mode=='force_generic_plan':
                assert any(x.get('Rows Removed by Filter',0)>500000 for x in nodes(previous['Plan'])), 'baseline did not reproduce the broad generic scan'
            report['plans'].append({'pool':n,'mode':mode,'before':previous,'after':actual,'beforeBlocks':old_blocks,'afterBlocks':new_blocks})
            print('PASS pool',n,mode,'blocks',old_blocks,'->',new_blocks,'ms',previous['Execution Time'],'->',actual['Execution Time'],flush=True)

    q("DELETE FROM chip_ledger WHERE payload IS NOT NULL;")
    assert [measure(n) for n in (1,2,3,4)] == old_rows
    leg(.01,other_label=long_label+'after-install')
    leg(.01,side='out',other_label=long_label+'after-install')
    assert measure(1)==old_rows[0], 'new valid oversized-label writes must remain legal after installation'
    # A pending bank+ledger commit becomes visible as one atomic snapshot.
    # The old and new reads already use one SELECT; real sessions prove that
    # uncommitted changes are excluded and the committed pair both appears.
    writer = subprocess.Popen([str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(socket),'-U','fixture_admin','-d','postgres'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
    writer.stdin.write("BEGIN; UPDATE bbj_pools SET main_balance=main_balance+3 WHERE id="+quote(uid(1))+"; INSERT INTO chip_ledger(category,amount,from_type,to_type,to_entity_id,to_label,created_at) VALUES('bbj_contribution',3,'club_treasury','bbj_pool',"+quote(uid(1))+",'bbj_pools.main_balance','2020-01-03Z'); SELECT 'bank-and-leg-pending';\n")
    writer.stdin.flush()
    assert writer.stdout.readline().strip()=='bank-and-leg-pending'
    assert measure(1) == old_rows[0]
    writer.stdin.write('COMMIT;\n\\q\n'); writer.stdin.flush()
    out,err=writer.communicate(timeout=10)
    assert writer.returncode==0,(out,err)
    committed = measure(1)
    assert committed['main']==old_rows[0]['main']+3 and committed['journal_main']==old_rows[0]['journal_main']+3 and committed['unexplained_main']==0
    # Match a real interrupted online build: readiness alone is insufficient.
    # This local old-snapshot wait exceeds the failed production 15s cap while
    # ordinary ledger writes continue. The original invalid index is recovered
    # with one explicit REINDEX, never a retry loop or production experiment.
    idx = split['indexes'][0]
    name = idx['name']
    q('DROP INDEX CONCURRENTLY public.'+name)
    reader = snapshot()
    q("SET lock_timeout='500ms';\n"+idx['statement'],'lock timeout')
    release(reader)
    assert q("SELECT NOT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid="+quote('public.'+name)+"::regclass")=='t'
    q(body,'BBJ_METER_READ_INDEX_NOT_QUALIFIED')
    assert q("SELECT "+live_proof)=='f'
    invalid_oid=q("SELECT "+quote('public.'+name)+"::regclass::oid")
    reader=snapshot()
    recovery=session("SET statement_timeout='6min'; SET lock_timeout='180s'; REINDEX INDEX CONCURRENTLY public."+name+";")
    recovery.stdin.close()
    wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_progress_create_index WHERE relid='chip_ledger'::regclass AND phase='waiting for old snapshots')")
    q("SET statement_timeout='2s'; INSERT INTO chip_ledger(category,amount,from_type,to_type,created_at) VALUES('adjustment',1,'player_wallet','player_wallet',now());")
    held_at=time.monotonic()
    time.sleep(16)
    assert recovery.poll() is None
    release(reader)
    assert recovery.wait(timeout=60)==0,recovery.stderr.read()
    q(body)
    assert q("SELECT "+live_proof)=='t'
    recovered_oid=q("SELECT "+quote('public.'+name)+"::regclass::oid")
    assert invalid_oid!=recovered_oid
    for flag in ('indisvalid','indisready','indislive'):
        q("UPDATE pg_index SET "+flag+"=false WHERE indexrelid="+quote('public.'+name)+"::regclass")
        q(body,'BBJ_METER_READ_INDEX_NOT_QUALIFIED')
        assert q("SELECT "+live_proof)=='f'
        q("UPDATE pg_index SET "+flag+"=true WHERE indexrelid="+quote('public.'+name)+"::regclass")
    assert state()==before and measure(1)==committed
    report['recovery']={'oldIndexOid':invalid_oid,'newIndexOid':recovered_oid,'heldSnapshotSeconds':time.monotonic()-held_at,'financialFunctionUnchanged':True,'concurrentWriteCommitted':True}
    print('PASS actual ready-but-invalid build refused; same owned index recovered after >15s old snapshot with concurrent ledger write and unchanged financial source.',flush=True)
    report['status']='passed'
    report['installedDefinitionMD5']=hashlib.md5(after['definition'].encode()).hexdigest()
    print('PASS exact financial rows, label precedence, self/cross-pool/NULL legs, cumulative boundaries, privileges, drift, rollback, concurrent visibility; no production operations.',flush=True)
finally:
    target=ROOT/('artifacts/bbj-audit-baseline' if args.baseline else 'artifacts/bbj-audit-reads')
    target.mkdir(parents=True,exist_ok=True)
    (target/'native.json').write_text(json.dumps(report,indent=2)+'\n')
    if writer is not None and writer.poll() is None:
        writer.terminate()
        writer.communicate(timeout=10)
    for proc in children:
        if proc.poll() is None:
            proc.terminate(); proc.wait(timeout=10)
    if started:
        run([pg/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
    shutil.rmtree(cluster)
    shutil.rmtree(socket)
