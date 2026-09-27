#!/usr/bin/env python3
"""Complete unchanged conservation query and online index on isolated PostgreSQL17."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'scripts/ci/fixtures/settlement-conservation-index'
PG = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
MIGRATION = ROOT / 'supabase/migrations/20260927134343_settlement_conservation_reads_only_relevant_union_transactio.sql'
ONLINE = ROOT / 'scripts/ops/build-settlement-conservation-index-concurrently.sql'
RECOVERY = ROOT / 'scripts/ops/recover-settlement-conservation-index-concurrently.sql'
cluster = Path(tempfile.mkdtemp(prefix='settlement-index-', dir=os.environ.get('TMPDIR')))
socket = Path(tempfile.mkdtemp(prefix='settle-idx-s-', dir='/tmp'))
data = cluster / 'data'
env = {'PATH': str(PG) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
children = []
started = False


def run(args, sql=None, error=None):
    p = subprocess.run([str(a) for a in args], input=sql, text=True,
                       capture_output=True, env=env, timeout=120)
    if error:
        assert p.returncode and error in p.stderr, p.stderr
        print('PASS: refused ' + error, flush=True)
    elif p.returncode:
        raise RuntimeError(p.stdout + p.stderr)
    return p.stdout.strip()


def argv():
    return [PG/'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-U', 'postgres', '-d', 'postgres']


def q(sql, error=None):
    return run(argv(), sql, error)


def wait_for(sql, seconds=8):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if q(sql) == 't':
            return
        time.sleep(.025)
    raise AssertionError('Native condition not observed: ' + sql)


def child(sql):
    p = subprocess.Popen([str(a) for a in argv()], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    children.append(p)
    p.stdin.write(sql)
    p.stdin.flush()
    return p


def nodes(node):
    yield node
    for c in node.get('Plans', []):
        yield from nodes(c)


def fingerprint():
    return q("""SELECT jsonb_build_object(
      'fn',(SELECT row_to_json(x) FROM (SELECT oid,pg_get_functiondef(oid) definition,proacl,proowner,proconfig,prosecdef,provolatile FROM pg_proc WHERE oid='fn_settlement_conservation_check()'::regprocedure)x),
      'table',(SELECT row_to_json(x) FROM (SELECT oid,relowner,relacl,relrowsecurity,relforcerowsecurity,reloptions FROM pg_class WHERE oid='union_wallet_transactions'::regclass)x),
      'constraints',(SELECT jsonb_agg(row_to_json(x) ORDER BY x.oid) FROM (SELECT oid,pg_get_constraintdef(oid) definition,convalidated,condeferrable FROM pg_constraint WHERE conrelid='union_wallet_transactions'::regclass)x),
      'policies',(SELECT jsonb_agg(row_to_json(x)) FROM (SELECT * FROM pg_policy WHERE polrelid='union_wallet_transactions'::regclass)x))""")


def result():
    return q('SELECT row_to_json(x) FROM fn_settlement_conservation_check() x ORDER BY issue,detail NULLS LAST')


try:
    assert ' 17.' in run([PG/'postgres', '--version'])
    run([PG/'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '-E', 'UTF8'])
    with (data/'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\nautovacuum=off\n")
    started = True
    run([PG/'pg_ctl', '-D', data, '-l', cluster/'server.log', '-w', 'start'])
    assert json.loads(q("SELECT json_build_object('host',inet_server_addr(),'dir',current_setting('data_directory'),'listen',current_setting('listen_addresses'))")) == {'host': None, 'dir': str(data), 'listen': ''}
    q((FIXTURE/'bootstrap.sql').read_text())
    definition = (FIXTURE/'installed.sql').read_text()
    assert hashlib.md5(definition.encode()).hexdigest() == '9502e93b3726e7e0c04e0e63ad8ceba5'
    q(definition)
    q('REVOKE ALL ON FUNCTION fn_settlement_conservation_check() FROM PUBLIC; GRANT EXECUTE ON FUNCTION fn_settlement_conservation_check() TO service_role;')
    original = fingerprint()
    last_original_id = q('SELECT max(id) FROM union_wallet_transactions')
    original_rows_sql = "SELECT md5(string_agg(md5(row_to_json(t)::text),'' ORDER BY id)) FROM union_wallet_transactions t WHERE id<=" + last_original_id
    original_rows = q(original_rows_sql)
    baseline = result()
    rows = [json.loads(line) for line in baseline.splitlines()]
    by_issue = {name: [r for r in rows if r['issue'] == name] for name in ['pnl_collect_mismatch','pnl_pay_mismatch','union_hold_not_credited','negative_balance']}
    assert {k: len(v) for k,v in by_issue.items()} == {'pnl_collect_mismatch': 2, 'pnl_pay_mismatch': 1, 'union_hold_not_credited': 5, 'negative_balance': 4}, rows
    assert all(r['severity'] == 'critical' for r in rows)
    # Independent values and identities, not a second copy of the SQL query.
    for n, amount in [(102,'10.02'),(105,'99')]:
        uid = hashlib.md5(str(n).encode()).hexdigest()
        uid = f'{uid[:8]}-{uid[8:12]}-{uid[12:16]}-{uid[16:20]}-{uid[20:]}'
        assert any(uid in r['detail'] and 'total_collected '+amount in r['detail'] for r in by_issue['pnl_collect_mismatch'])
    assert 'total_paid 12' in by_issue['pnl_pay_mismatch'][0]['detail']
    assert sum(r['detail'] is None for r in by_issue['union_hold_not_credited']) == 1
    for n in [13,14,15,16]:
        assert any(q(f'SELECT u({n})') in (r['detail'] or '') for r in by_issue['union_hold_not_credited'])
    body = definition.split('AS $function$\n',1)[1].split('$function$',1)[0]
    before = json.loads(q('SET max_parallel_workers_per_gather=0; EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+body).removeprefix('SET\n'))[0]
    old_scans = [n for n in nodes(before['Plan']) if n.get('Relation Name') == 'union_wallet_transactions']
    assert old_scans
    migration,online,recovery = MIGRATION.read_text(),ONLINE.read_text(),RECOVERY.read_text()
    q(migration,'SETTLEMENT_CONSERVATION_INDEX_MISSING_BUILD_ONLINE')
    for shape in ["(tx_type,union_id,created_at)","(tx_type,created_at,union_id) INCLUDE(club_id,amount) WHERE tx_type IN('player_pnl_collect','player_pnl_pay','settlement_hold')", "(tx_type,union_id,created_at) INCLUDE(club_id,amount) WHERE tx_type='player_pnl_collect'"]:
        q('CREATE INDEX idx_uwt_settlement_conservation ON union_wallet_transactions '+shape)
        q(migration,'SETTLEMENT_CONSERVATION_INDEX_CONTRACT_CHANGED')
        q('DROP INDEX idx_uwt_settlement_conservation')
    q('BEGIN;\n'+online+'\nCOMMIT;','cannot run inside a transaction block')
    snapshot = child("SET application_name='settlement_index_old_snapshot'; BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT id FROM union_wallet_transactions LIMIT 1;\n")
    wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='settlement_index_old_snapshot' AND state='idle in transaction' AND backend_xmin IS NOT NULL)")
    build = child("SET statement_timeout='6min'; SET lock_timeout='2s';\n"+online)
    build.stdin.close()
    wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_progress_create_index WHERE relid='union_wallet_transactions'::regclass AND phase='waiting for old snapshots')")
    q("SET statement_timeout='2s'; INSERT INTO union_wallet_transactions(union_id,amount,tx_type,created_at,wallet,direction) VALUES(u(2),1,'rake',now(),'rake_wallet','credit')")
    assert build.wait(timeout=15) != 0 and 'lock timeout' in build.stderr.read()
    assert q("SELECT NOT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid='idx_uwt_settlement_conservation'::regclass") == 't'
    q(migration,'SETTLEMENT_CONSERVATION_INDEX_CONTRACT_CHANGED')
    interrupted_oid = q("SELECT 'idx_uwt_settlement_conservation'::regclass::oid")
    # One explicit, finite recovery of the observed invalid build, while its
    # original old snapshot still exists; no hidden drop/retry.
    recover = child("SET statement_timeout='6min'; SET lock_timeout='180s';\n"+recovery)
    recover.stdin.close()
    wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_progress_create_index WHERE relid='union_wallet_transactions'::regclass AND phase='waiting for old snapshots')")
    q("SET statement_timeout='2s'; INSERT INTO union_wallet_transactions(union_id,amount,tx_type,created_at,wallet,direction) VALUES(u(2),1,'rake',now(),'rake_wallet','credit')")
    time.sleep(3)
    assert recover.poll() is None
    snapshot.stdin.write('ROLLBACK;\n'); snapshot.stdin.close()
    assert snapshot.wait(timeout=10) == 0, snapshot.stderr.read()
    assert recover.wait(timeout=30) == 0, recover.stderr.read()
    assert q("SELECT 'idx_uwt_settlement_conservation'::regclass::oid") != interrupted_oid
    assert q("SELECT count(*) FROM pg_class WHERE relname LIKE 'idx_uwt_settlement_conservation_cc%'") == '0'
    q(migration); q(migration)
    assert fingerprint() == original and result() == baseline
    assert q(original_rows_sql) == original_rows
    empty = q('BEGIN; TRUNCATE union_pnl_settlements,chip_transactions,clubs,unions,wallets,union_wallets CASCADE; SELECT count(*) FROM fn_settlement_conservation_check(); ROLLBACK;')
    assert empty.endswith('0\nROLLBACK'), empty
    assert result() == baseline
    for flag in ['indisvalid','indisready','indislive']:
        q(f"UPDATE pg_index SET {flag}=false WHERE indexrelid='idx_uwt_settlement_conservation'::regclass")
        q(migration,'SETTLEMENT_CONSERVATION_INDEX_CONTRACT_CHANGED')
        q(f"UPDATE pg_index SET {flag}=true WHERE indexrelid='idx_uwt_settlement_conservation'::regclass")
    q('CREATE ROLE wrong_owner; ALTER TABLE union_wallet_transactions OWNER TO wrong_owner;')
    q(migration,'SETTLEMENT_CONSERVATION_INDEX_CONTRACT_CHANGED')
    q('ALTER TABLE union_wallet_transactions OWNER TO postgres;')
    q("UPDATE pg_proc SET prosrc=prosrc||E'\n-- local drift' WHERE oid='fn_settlement_conservation_check()'::regprocedure")
    q(migration,'SETTLEMENT_CONSERVATION_SOURCE_CHANGED')
    q(definition)
    for role in ['anon','authenticated']:
        q('SET ROLE '+role+'; SELECT * FROM fn_settlement_conservation_check();','permission denied')
    assert q('SET ROLE service_role; SELECT count(*) FROM fn_settlement_conservation_check();').endswith('12')
    assert q("SET ROLE authenticated; SET fixture.uid='"+q('SELECT u(901)')+"'; SELECT count(*) FROM union_wallet_transactions;").endswith('0')
    assert q("SET ROLE authenticated; SET fixture.uid='"+q('SELECT u(900)')+"'; SELECT count(*) FROM union_wallet_transactions WHERE union_id<>u(1);").endswith('0')
    q("INSERT INTO union_wallet_transactions(union_id,amount,tx_type) VALUES(u(1),-1,'settlement_hold')",'check constraint')
    q("INSERT INTO union_wallet_transactions(union_id,amount,tx_type) VALUES(u(1),0.001,'settlement_hold')",'check constraint')
    q("INSERT INTO union_wallet_transactions(union_id,amount,tx_type) VALUES(u(999),1,'settlement_hold')",'foreign key constraint')
    assert fingerprint() == original and result() == baseline
    after = json.loads(q('SET max_parallel_workers_per_gather=0; EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+body).removeprefix('SET\n'))[0]
    new_scans = [n for n in nodes(after['Plan']) if n.get('Relation Name') == 'union_wallet_transactions']
    assert len(new_scans) == 3 and all(n.get('Index Name') == 'idx_uwt_settlement_conservation' for n in new_scans), new_scans
    blocks = lambda scans: sum(n['Shared Hit Blocks']+n['Shared Read Blocks'] for n in scans)
    assert blocks(new_scans) < blocks(old_scans)/4, (old_scans,new_scans)
    print(json.dumps({'baselinePlan':before,'indexedPlan':after}),flush=True)
    print(json.dumps({'acceptance':'PASS','issues':len(rows),'before_blocks':blocks(old_scans),'after_blocks':blocks(new_scans),'body':'unchanged9502','recovery':'real interrupted CIC, same-operation REINDEX while writer commits and original snapshot waits','live_limit':'local full query equivalence and plans; production whole job outcome separate'}),flush=True)
finally:
    for p in children:
        if p.poll() is None:
            p.terminate(); p.wait(timeout=10)
    if started and (data/'postmaster.pid').exists():
        run([PG/'pg_ctl','-D',data,'-m','fast','-w','stop'])
    shutil.rmtree(cluster)
    shutil.rmtree(socket)
