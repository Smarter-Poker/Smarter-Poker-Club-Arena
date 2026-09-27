#!/usr/bin/env python3
"""Exact partial ledger index and unchanged audit on disposable native PostgreSQL 17."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'scripts/ci/fixtures/satellite-audit-index'
PG = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
MIGRATION = ROOT / 'supabase/migrations/20260927050112_satellite_pool_ledger_lookup_uses_partial_entity_index.sql'
ONLINE = ROOT / 'scripts/ops/build-satellite-ledger-audit-index-concurrently.sql'
cluster = Path(tempfile.mkdtemp(prefix='satellite-ledger-', dir=os.environ.get('TMPDIR')))
socket = Path(tempfile.mkdtemp(prefix='sat-ledger-sock-', dir='/tmp'))
data = cluster / 'data'
env = {'PATH': str(PG) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
started = False
children = []


def run(args, sql=None, error=None):
    result = subprocess.run([str(a) for a in args], input=sql, text=True,
                            capture_output=True, env=env, timeout=120)
    if error:
        assert result.returncode and error in result.stderr, result.stderr
        print('PASS: refused ' + error, flush=True)
    elif result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result.stdout.strip()


def argv():
    return [PG/'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-U', 'postgres', '-d', 'postgres']


def q(sql, error=None):
    return run(argv(), sql, error)


def fingerprint():
    return q("""SELECT jsonb_build_object('fn',(SELECT row_to_json(x) FROM
        (SELECT oid,pg_get_functiondef(oid) definition,proacl,proowner,prosecdef,proconfig FROM pg_proc
        WHERE oid='fn_satellite_conservation_audit(integer)'::regprocedure)x),
        'table',(SELECT row_to_json(x) FROM (SELECT oid,relowner,relacl,relrowsecurity,relforcerowsecurity,reloptions
        FROM pg_class WHERE oid='chip_ledger'::regclass)x),
        'policies',(SELECT jsonb_agg(row_to_json(x)) FROM (SELECT * FROM pg_policy WHERE polrelid='chip_ledger'::regclass)x))""")


def result():
    return q('SELECT row_to_json(a) FROM fn_satellite_conservation_audit(24) a ORDER BY satellite_id')


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


def hold():
    proc = subprocess.Popen([str(a) for a in argv()], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, env=env)
    children.append(proc)
    proc.stdin.write("SET application_name='satellite_fixture_writer'; BEGIN; LOCK TABLE chip_ledger IN ROW EXCLUSIVE MODE;\n")
    proc.stdin.flush()
    wait_for("SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a USING(pid) WHERE a.application_name='satellite_fixture_writer' AND l.relation='chip_ledger'::regclass AND l.mode='RowExclusiveLock' AND l.granted)")
    return proc


def snapshot():
    proc = subprocess.Popen([str(a) for a in argv()], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, env=env)
    children.append(proc)
    proc.stdin.write("SET application_name='satellite_fixture_snapshot'; BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT id FROM chip_ledger LIMIT 1;\n")
    proc.stdin.flush()
    wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='satellite_fixture_snapshot' AND state='idle in transaction' AND backend_xmin IS NOT NULL)")
    return proc


def release(proc):
    proc.stdin.write('ROLLBACK;\n')
    proc.stdin.close()
    assert proc.wait(timeout=10) == 0, proc.stderr.read()


try:
    assert ' 17.' in run([PG/'postgres', '--version'])
    run([PG/'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '-E', 'UTF8'])
    with (data/'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\nautovacuum=off\n")
    started = True
    run([PG/'pg_ctl', '-D', data, '-l', cluster/'server.log', '-w', 'start'])
    assert json.loads(q("SELECT json_build_object('host',inet_server_addr(),'dir',current_setting('data_directory'),'listen',current_setting('listen_addresses'))")) == {'host': None, 'dir': str(data), 'listen': ''}
    q((FIXTURE/'bootstrap.sql').read_text())
    q((ROOT/'scripts/ci/fixtures/satellite-ledger-audit-index/ledger.sql').read_text())
    q((ROOT/'scripts/ops/build-satellite-audit-index-concurrently.sql').read_text())
    definition = (FIXTURE/'installed.sql').read_text()
    assert hashlib.md5(definition.encode()).hexdigest() == '462b1c631010e4bab0361967d2da2a75'
    q(definition)
    q('REVOKE ALL ON FUNCTION fn_satellite_conservation_audit(integer) FROM PUBLIC; GRANT EXECUTE ON FUNCTION fn_satellite_conservation_audit(integer) TO service_role;')
    original = fingerprint()
    baseline = result()
    rows = [json.loads(line) for line in baseline.splitlines()]
    row4 = next(row for row in rows if row['satellite_name'] == 'Satellite 4')
    assert row4['pool'] == 114.75 and row4['cash_paid'] == 0 and row4['unpaid_winners'] == 10, row4
    row1 = next(row for row in rows if row['satellite_name'] == 'Satellite 1')
    assert row1['seats_funded'] == 2 and row1['cash_paid'] == 20 and row1['unpaid_winners'] == 6, row1
    body = definition.split('AS $function$\n', 1)[1].split('$function$', 1)[0].replace('p_hours', '24')
    before = json.loads(q('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + body))[0]
    before_scans = [n for n in nodes(before['Plan']) if n.get('Relation Name') == 'chip_ledger']
    assert before_scans
    own_sql = "SET ROLE authenticated; SET fixture.uid='" + q('SELECT u(4)') + "'; SELECT count(*) FROM chip_ledger;"
    own_count = q(own_sql)
    migration, online = MIGRATION.read_text(), ONLINE.read_text()
    q(migration, 'SATELLITE_LEDGER_INDEX_MISSING_BUILD_ONLINE')
    for shape in ["(from_entity_id)", "(from_entity_id) WHERE from_type='other' AND category='tournament_buyin'", "(from_entity_id) INCLUDE(amount) WHERE from_type='prize_liability' AND category='tournament_buyin'"]:
        q('CREATE INDEX idx_chip_ledger_satellite_pool_from ON chip_ledger '+shape)
        q(migration, 'SATELLITE_LEDGER_INDEX_CONTRACT_CHANGED')
        q('DROP INDEX idx_chip_ledger_satellite_pool_from')
    q('BEGIN;\n' + online + '\nCOMMIT;', 'cannot run inside a transaction block')
    writer = hold()
    build = subprocess.Popen([str(a) for a in argv()], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    children.append(build)
    build.stdin.write("SET statement_timeout='6min'; SET lock_timeout='180s';\n" + online)
    build.stdin.close()
    wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_progress_create_index WHERE relid='chip_ledger'::regclass)")
    assert build.poll() is None
    q("SET statement_timeout='2s'; INSERT INTO chip_ledger(from_type,from_entity_id,category,idempotency_key,amount) VALUES('player_wallet',u(999),'cash_hand','concurrent-writer',1)")
    assert build.poll() is None
    release(writer)
    assert build.wait(timeout=60) == 0, build.stderr.read()
    q(migration)
    q(migration)
    assert fingerprint() == original and result() == baseline and q(own_sql) == own_count
    for role in ['anon', 'authenticated']:
        q('SET ROLE '+role+'; SELECT * FROM fn_satellite_conservation_audit(24);', 'permission denied')
    assert q('SET ROLE service_role; SELECT count(*) FROM fn_satellite_conservation_audit(24);').endswith(str(len(rows)))
    for flag in ['indisvalid', 'indisready', 'indislive']:
        q(f"UPDATE pg_index SET {flag}=false WHERE indexrelid='idx_chip_ledger_satellite_pool_from'::regclass")
        q(migration, 'SATELLITE_LEDGER_INDEX_CONTRACT_CHANGED')
        q(f"UPDATE pg_index SET {flag}=true WHERE indexrelid='idx_chip_ledger_satellite_pool_from'::regclass")
    q('CREATE ROLE wrong_owner; ALTER TABLE chip_ledger OWNER TO wrong_owner;')
    q(migration, 'SATELLITE_LEDGER_INDEX_CONTRACT_CHANGED')
    q('ALTER TABLE chip_ledger OWNER TO postgres;')
    q("UPDATE pg_proc SET prosrc=prosrc||E'\n-- local drift' WHERE oid='fn_satellite_conservation_audit(integer)'::regprocedure")
    q(migration, 'SATELLITE_AUDIT_SOURCE_CHANGED')
    q(definition)
    assert fingerprint() == original
    after = json.loads(q('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + body))[0]
    after_scans = [n for n in nodes(after['Plan']) if n.get('Relation Name') == 'chip_ledger']
    assert after_scans and all(n.get('Index Name') == 'idx_chip_ledger_satellite_pool_from' for n in after_scans), after_scans
    blocks = lambda scans: sum(n['Shared Hit Blocks'] + n['Shared Read Blocks'] for n in scans)
    assert blocks(after_scans) < blocks(before_scans) / 4
    assert result() == baseline
    print(json.dumps({'baselinePlan': before, 'indexedPlan': after}), flush=True)
    print('PASS: complete unchanged audit rows; independent114.75 pool oracle with positive/negative/NULL amounts and exact LIKE exclusions; sparse entity index; real concurrent writer; role/RLS/catalog invariants', flush=True)
finally:
    for proc in children:
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=10)
    if started and (data/'postmaster.pid').exists():
        run([PG/'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster)
    shutil.rmtree(socket)
