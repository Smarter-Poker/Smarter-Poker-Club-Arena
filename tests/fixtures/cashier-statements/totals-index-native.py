#!/usr/bin/env python3
"""Finite native PG17 qualification; creates only private disposable local data."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]
PG = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
MIGRATION = ROOT / 'supabase/migrations/20260927001937_cashier_receipt_totals_use_a_covered_club_time_range.sql'
ONLINE = ROOT / 'scripts/ops/build-cashier-totals-index-concurrently.sql'
FIXTURE = ROOT / 'tests/fixtures/cashier-statements'
BASE = ROOT / 'supabase/migrations/20260923131325_cashier_statements_read_every_wallet_in_one_keyset.sql'
ENV = {'PATH': str(PG) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
cluster = Path(tempfile.mkdtemp(prefix='cashier-totals-', dir=os.environ.get('TMPDIR')))
socket = Path(tempfile.mkdtemp(prefix='ct-sock-'))
data = cluster / 'data'
started = False


def run(args, sql=None, expected=None):
    result = subprocess.run([str(x) for x in args], input=sql, text=True,
                            capture_output=True, env=ENV, timeout=180)
    if expected is not None:
        assert result.returncode != 0 and expected in result.stderr, result.stderr
        print('PASS: refused ' + expected, flush=True)
    elif result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result.stdout.strip()


def argv():
    return [PG / 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-h', socket,
            '-U', 'postgres', '-d', 'postgres']


def q(sql, expected=None):
    return run(argv(), sql, expected)


def await_local_condition(sql, label, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if q(sql) == 't':
            return
        time.sleep(0.025)
    raise AssertionError('local fixture condition not observed: ' + label)


def hold_writer_lock():
    process = subprocess.Popen(argv(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, env=ENV)
    process.stdin.write("SET application_name='cashier_fixture_lock'; BEGIN; LOCK TABLE chip_transactions IN ROW EXCLUSIVE MODE;\n")
    process.stdin.flush()
    await_local_condition("SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a USING(pid) WHERE a.application_name='cashier_fixture_lock' AND l.relation='chip_transactions'::regclass AND l.mode='RowExclusiveLock' AND l.granted)", 'writer lock held')
    return process


def release_writer_lock(process):
    process.stdin.write('ROLLBACK;\n')
    process.stdin.close()
    assert process.wait(timeout=10) == 0, process.stderr.read()


def catalog():
    return q("""SELECT jsonb_agg(jsonb_build_object('oid',oid,'source',pg_get_functiondef(oid),
                'acl',proacl,'security',prosecdef,'config',proconfig) ORDER BY oid)
                FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'fn_cashier_statement_%'""")


def aggregate_sql():
    return """SELECT count(*),sum(abs(amount)),
    CASE WHEN to_user_id=u(1) AND from_user_id IS DISTINCT FROM u(1) THEN 'in'
         WHEN from_user_id=u(1) AND to_user_id IS DISTINCT FROM u(1) THEN 'out'
         ELSE 'managed' END direction
    FROM chip_transactions WHERE club_id=u(100)
      AND created_at >= '2026-09-20T07:00:00Z' AND created_at < '2026-09-27T07:00:00Z'
    GROUP BY direction ORDER BY direction"""


def plan(label):
    result = json.loads(q('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + aggregate_sql()))[0]
    print(json.dumps({'scenario': label, 'plan': result}), flush=True)
    return result


def nodes(plan_node):
    yield plan_node
    for child in plan_node.get('Plans', []):
        yield from nodes(child)


try:
    run([PG / 'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust',
         '--auth-host=reject', '--no-locale', '-E', 'UTF8'])
    with (data / 'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\nautovacuum=off\n")
    run([PG / 'pg_ctl', '-D', data, '-l', cluster / 'server.log', '-w', 'start'])
    started = True
    q((FIXTURE / 'bootstrap.sql').read_text())
    q((FIXTURE / 'baseline.sql').read_text())
    q(BASE.read_text())
    original_catalog = catalog()
    q("ALTER TABLE chip_transactions SET(autovacuum_freeze_max_age=150000000)")
    original_options = q("SELECT reloptions FROM pg_class WHERE oid='chip_transactions'::regclass")
    migration = MIGRATION.read_text()
    online = ONLINE.read_text()
    q(migration, 'CASHIER_TOTALS_INDEX_MISSING_BUILD_ONLINE')
    q('CREATE INDEX idx_chip_tx_club_time_totals ON chip_transactions(club_id,created_at)')
    q(migration, 'CASHIER_TOTALS_INDEX_CONTRACT_CHANGED')
    q('DROP INDEX idx_chip_tx_club_time_totals')
    q('BEGIN;\n' + online + '\nCOMMIT;', 'cannot run inside a transaction block')
    q(online)
    for field in ('indisvalid', 'indisready', 'indislive'):
        q(f"UPDATE pg_index SET {field}=false WHERE indexrelid='idx_chip_tx_club_time_totals'::regclass")
        q(migration, 'CASHIER_TOTALS_INDEX_CONTRACT_CHANGED')
        q(f"UPDATE pg_index SET {field}=true WHERE indexrelid='idx_chip_tx_club_time_totals'::regclass")
    q('CREATE ROLE wrong_owner; ALTER TABLE chip_transactions OWNER TO wrong_owner')
    q(migration, 'CASHIER_TOTALS_INDEX_CONTRACT_CHANGED')
    q('ALTER TABLE chip_transactions OWNER TO postgres')
    q("UPDATE pg_proc SET prosrc=prosrc||E'\n-- fixture drift' WHERE pronamespace='public'::regnamespace AND proname='fn_cashier_statement_totals'")
    q(migration, 'cashier read source drift: fn_cashier_statement_totals')
    q(BASE.read_text())
    assert catalog() == original_catalog, 'baseline replay changed captured RPC catalog'
    q('ALTER FUNCTION public.fn_cashier_statement_totals(uuid,timestamp with time zone,timestamp with time zone,jsonb) RENAME TO fixture_missing_totals')
    q(migration, 'cashier read source drift: fn_cashier_statement_totals')
    q('ALTER FUNCTION public.fixture_missing_totals(uuid,timestamp with time zone,timestamp with time zone,jsonb) RENAME TO fn_cashier_statement_totals')
    assert catalog() == original_catalog
    q(migration.replace('COMMIT;', 'ROLLBACK;'))
    assert q("SELECT reloptions FROM pg_class WHERE oid='chip_transactions'::regclass") == original_options
    print('PASS: short migration rolls back all table settings', flush=True)
    q(migration)
    assert catalog() == original_catalog, 'an accounting function, permission or security posture changed'
    options = q("SELECT reloptions::text FROM pg_class WHERE oid='chip_transactions'::regclass")
    for option in ('autovacuum_freeze_max_age=150000000', 'autovacuum_vacuum_insert_scale_factor=0',
                   'autovacuum_vacuum_insert_threshold=4000', 'autovacuum_analyze_scale_factor=0',
                   'autovacuum_analyze_threshold=3000'):
        assert option in options, options
    print('PASS: exact options with existing freeze setting and all financial RPC bytes/ACLs retained', flush=True)
    # Existing full independent oracle covers scopes, overlap, filtering, amounts,
    # escrow/restore/idempotency, export boundaries, role permissions and RLS.
    output = run(argv() + ['-f', FIXTURE / 'regression.sql'])
    print('PASS: existing complete Cashier statement native accounting/auth suite after candidate', flush=True)
    assert catalog() == original_catalog

    # Append realistic interleaved wide receipt pages. Old pages are visible,
    # recent pages are not: this distinguishes a covering index from actual
    # index-only eligibility. The fixture matches measured receipt population,
    # not production timing or live data. Every row is synthetic and disposable.
    q('DROP INDEX idx_chip_tx_club_time_totals')
    q("""INSERT INTO chip_transactions(club_id,from_user_id,to_user_id,amount,transaction_type,notes,metadata,created_at)
      SELECT u(100+(n%10)),u(1+n%1500),u(1+(n+17)%1500),1+(n%10000)/100.0,'mint',
      repeat('receipt ',12),jsonb_build_object('op_id',md5(n::text)),
      '2026-08-01Z'::timestamptz+n*interval '1 second' FROM generate_series(1,790000) n;
      VACUUM ANALYZE chip_transactions;""")
    q("""INSERT INTO chip_transactions(club_id,from_user_id,to_user_id,amount,transaction_type,notes,metadata,created_at)
      SELECT u(100+(n%10)),u(1+n%1500),u(1+(n+17)%1500),1+(n%10000)/100.0,'mint',
      repeat('receipt ',12),jsonb_build_object('op_id',md5(n::text)),
      '2026-09-20T07:00:00Z'::timestamptz+n*interval '4 seconds' FROM generate_series(1,120000) n;
      ANALYZE chip_transactions;""")
    exact_rows = q(aggregate_sql())
    baseline = plan('baseline-recent-not-visible')
    # A writer is allowed to commit while the online build is pending. Hold one
    # old writer transaction briefly, then verify another writer is not blocked.
    hold = hold_writer_lock()
    build = subprocess.Popen(argv(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, env=ENV)
    build.stdin.write("SET statement_timeout='30s'; SET lock_timeout='5s';\n" + online)
    build.stdin.close()
    await_local_condition("SELECT EXISTS(SELECT 1 FROM pg_stat_progress_create_index WHERE relid='chip_transactions'::regclass)", 'concurrent build pending')
    assert build.poll() is None, 'build did not overlap retained writer lock'
    q("SET statement_timeout='1s'; INSERT INTO chip_transactions(club_id,amount,transaction_type,created_at) VALUES(u(999),1,'mint','2026-08-01Z')")
    assert build.poll() is None, 'concurrent insert did not overlap online build'
    release_writer_lock(hold)
    assert build.wait(timeout=60) == 0, build.stderr.read()
    print('PASS: another receipt write commits while actual concurrent build waits on an existing writer lock', flush=True)
    assert q(aggregate_sql()) == exact_rows
    unmaintained = plan('covered-recent-not-visible')
    # VACUUM is the native operation performed by the unchanged autovacuum
    # mechanism. A bounded local pass isolates visibility from index coverage;
    # no claim that a production autovacuum has run is inferred from this test.
    q('VACUUM ANALYZE chip_transactions;')
    after = plan('covered-visible')
    assert q(aggregate_sql()) == exact_rows
    index_nodes = [n for n in nodes(after['Plan']) if n.get('Index Name') == 'idx_chip_tx_club_time_totals']
    assert index_nodes and all(n['Node Type'] == 'Index Only Scan' and n['Heap Fetches'] == 0 for n in index_nodes)
    before_buffers = baseline['Plan']['Shared Hit Blocks'] + baseline['Plan']['Shared Read Blocks']
    after_buffers = after['Plan']['Shared Hit Blocks'] + after['Plan']['Shared Read Blocks']
    assert after_buffers < before_buffers / 4, (before_buffers, after_buffers)
    assert not any(n.get('Node Type') == 'Index Only Scan' for n in nodes(baseline['Plan']))
    print('PASS: equal totals; baseline fails heap-free range requirement, qualified visible index uses <25% buffers', flush=True)
    print(q("SELECT json_build_object('index_bytes',pg_relation_size('idx_chip_tx_club_time_totals'),'heap_bytes',pg_table_size('chip_transactions'),'rows',reltuples,'pages',relpages,'visible',relallvisible) FROM pg_class WHERE oid='chip_transactions'::regclass"), flush=True)
    # Exact candidate's interrupted online build is a distinct durable outcome.
    q('DROP INDEX CONCURRENTLY idx_chip_tx_club_time_totals')
    hold = hold_writer_lock()
    q("SET lock_timeout='200ms';\n" + online, 'lock timeout')
    release_writer_lock(hold)
    assert q("SELECT NOT indisvalid FROM pg_index WHERE indexrelid='idx_chip_tx_club_time_totals'::regclass") == 't'
    q(migration, 'CASHIER_TOTALS_INDEX_CONTRACT_CHANGED')
    q('DROP INDEX CONCURRENTLY idx_chip_tx_club_time_totals')
    assert q("SELECT to_regclass('idx_chip_tx_club_time_totals') IS NULL") == 't'
    print('PASS: interrupted build leaves invalid durable outcome; recording refuses; explicit online cleanup removes it', flush=True)
    # Exercise the actual authenticated caller graph, not a freeze-input stub.
    from maintenance_caller_native import qualify
    qualify(q, run, argv, FIXTURE, ROOT, online, migration)
    assert catalog() == original_catalog
    print('PASS: all Cashier totals index native acceptance cases', flush=True)
finally:
    if started and (data / 'postmaster.pid').exists():
        run([PG / 'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster)
    shutil.rmtree(socket)
