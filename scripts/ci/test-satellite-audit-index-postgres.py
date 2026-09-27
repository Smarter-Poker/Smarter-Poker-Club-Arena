#!/usr/bin/env python3
"""Exact online index and unchanged audit on disposable native PostgreSQL 17."""
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
MIGRATION = ROOT / 'supabase/migrations/20260927044216_satellite_seat_audit_uses_a_partial_source_index.sql'
ONLINE = ROOT / 'scripts/ops/build-satellite-audit-index-concurrently.sql'
RECOVERY = ROOT / 'scripts/ops/recover-satellite-audit-index-concurrently.sql'
cluster = Path(tempfile.mkdtemp(prefix='satellite-index-', dir=os.environ.get('TMPDIR')))
socket = Path(tempfile.mkdtemp(prefix='sat-index-sock-', dir='/tmp'))
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
        FROM pg_class WHERE oid='rake_records'::regclass)x),
        'policies',(SELECT jsonb_agg(row_to_json(x)) FROM (SELECT * FROM pg_policy WHERE polrelid='rake_records'::regclass)x))""")


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
    proc.stdin.write("SET application_name='satellite_fixture_writer'; BEGIN; LOCK TABLE rake_records IN ROW EXCLUSIVE MODE;\n")
    proc.stdin.flush()
    wait_for("SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a USING(pid) WHERE a.application_name='satellite_fixture_writer' AND l.relation='rake_records'::regclass AND l.mode='RowExclusiveLock' AND l.granted)")
    return proc


def snapshot():
    proc = subprocess.Popen([str(a) for a in argv()], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, env=env)
    children.append(proc)
    proc.stdin.write("SET application_name='satellite_fixture_snapshot'; BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT id FROM rake_records LIMIT 1;\n")
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
    definition = (FIXTURE/'installed.sql').read_text()
    assert hashlib.md5(definition.encode()).hexdigest() == '462b1c631010e4bab0361967d2da2a75'
    q(definition)
    assert q("SELECT md5(pg_get_functiondef('fn_satellite_conservation_audit(integer)'::regprocedure))") == '462b1c631010e4bab0361967d2da2a75'
    q('REVOKE ALL ON FUNCTION fn_satellite_conservation_audit(integer) FROM PUBLIC; GRANT EXECUTE ON FUNCTION fn_satellite_conservation_audit(integer) TO service_role;')
    original = fingerprint()
    baseline = result()
    rows = [json.loads(line) for line in baseline.splitlines()]
    row1 = next(row for row in rows if row['satellite_name'] == 'Satellite 1')
    assert row1['seats_funded'] == 2 and row1['cash_paid'] == 20 and row1['unpaid_winners'] == 6, row1
    # The exact function body is EXPLAINed directly so SECURITY DEFINER does not
    # hide internal scans. Only its argument is replaced with the same literal.
    body = definition.split('AS $function$\n', 1)[1].split('$function$', 1)[0].replace('p_hours', '24')
    before = json.loads(q('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + body))[0]
    before_scans = [n for n in nodes(before['Plan']) if n.get('Relation Name') == 'rake_records']
    assert any(n['Node Type'] == 'Seq Scan' for n in before_scans), before_scans
    migration, online = MIGRATION.read_text(), ONLINE.read_text()
    q(migration, 'SATELLITE_AUDIT_INDEX_MISSING_BUILD_ONLINE')
    for shape in ["(source)", "(source) WHERE source='other'", "(source) INCLUDE(metadata) WHERE source='fn_award_satellite_seat'"]:
        q('CREATE INDEX idx_rake_records_satellite_seat_source ON rake_records '+shape)
        q(migration, 'SATELLITE_AUDIT_INDEX_CONTRACT_CHANGED')
        q('DROP INDEX idx_rake_records_satellite_seat_source')
    q('BEGIN;\n' + online + '\nCOMMIT;', 'cannot run inside a transaction block')
    writer = hold()
    build = subprocess.Popen([str(a) for a in argv()], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, env=env)
    children.append(build)
    build.stdin.write("SET statement_timeout='60s'; SET lock_timeout='10s';\n" + online)
    build.stdin.close()
    wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_progress_create_index WHERE relid='rake_records'::regclass)")
    assert build.poll() is None
    # This real second connection commits while the existing writer keeps the
    # concurrent build pending. No blocking ordinary CREATE INDEX substitute.
    q("SET statement_timeout='2s'; INSERT INTO rake_records(source,metadata) VALUES('cash_hand','{}');")
    assert build.poll() is None
    release(writer)
    assert build.wait(timeout=60) == 0, build.stderr.read()
    print('PASS: actual online build admits concurrent writes', flush=True)
    q(migration)
    q(migration)  # verification itself is read-only and does not replay a build
    assert fingerprint() == original and result() == baseline
    for flag in ['indisvalid', 'indisready', 'indislive']:
        q(f"UPDATE pg_index SET {flag}=false WHERE indexrelid='idx_rake_records_satellite_seat_source'::regclass")
        q(migration, 'SATELLITE_AUDIT_INDEX_CONTRACT_CHANGED')
        q(f"UPDATE pg_index SET {flag}=true WHERE indexrelid='idx_rake_records_satellite_seat_source'::regclass")
    q('CREATE ROLE wrong_owner; ALTER TABLE rake_records OWNER TO wrong_owner;')
    q(migration, 'SATELLITE_AUDIT_INDEX_CONTRACT_CHANGED')
    q('ALTER TABLE rake_records OWNER TO postgres;')
    q("UPDATE pg_proc SET prosrc=prosrc||E'\n-- local drift' WHERE oid='fn_satellite_conservation_audit(integer)'::regprocedure")
    q(migration, 'SATELLITE_AUDIT_SOURCE_CHANGED')
    q(definition)
    assert fingerprint() == original
    after = json.loads(q('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + body))[0]
    after_scans = [n for n in nodes(after['Plan']) if n.get('Relation Name') == 'rake_records']
    assert after_scans and all(n['Node Type'] != 'Seq Scan' for n in after_scans), after_scans
    assert any(n.get('Index Name') == 'idx_rake_records_satellite_seat_source' for n in nodes(after['Plan']))
    blocks = lambda scans: sum(n['Shared Hit Blocks'] + n['Shared Read Blocks'] for n in scans)
    assert blocks(after_scans) < blocks(before_scans) / 4
    assert result() == baseline
    print(json.dumps({'baselinePlan': before, 'indexedPlan': after}), flush=True)
    # Large incompressible metadata stays valid: source-only indexes impose no
    # new JSONB index-tuple limit. An INCLUDE index would reject this receipt.
    q("INSERT INTO rake_records(source,metadata) SELECT 'fn_award_satellite_seat',jsonb_build_object('satellite_id',u(999),'user_id',u(999),'large',string_agg(md5(n::text),'')) FROM generate_series(1,500)n")
    assert result() == baseline
    assert q("SET ROLE authenticated; SET fixture.uid='" + q('SELECT u(1011)') + "'; SELECT count(*) FROM rake_records;").endswith('2')
    q('SET ROLE authenticated; SELECT * FROM fn_satellite_conservation_audit(24);', 'permission denied')
    assert q('SET ROLE service_role; SELECT count(*) FROM fn_satellite_conservation_audit(24);').endswith(str(len(rows)))
    assert fingerprint() == original
    q('DROP INDEX CONCURRENTLY idx_rake_records_satellite_seat_source')
    reader = snapshot()
    q("SET lock_timeout='500ms';\n" + online, 'lock timeout')
    release(reader)
    assert q("SELECT NOT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid='idx_rake_records_satellite_seat_source'::regclass") == 't'
    q(migration, 'SATELLITE_AUDIT_INDEX_CONTRACT_CHANGED')
    invalid_oid = q("SELECT 'idx_rake_records_satellite_seat_source'::regclass::oid")
    reader = snapshot()
    recovery = subprocess.Popen([str(a) for a in argv()], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, env=env)
    children.append(recovery)
    recovery.stdin.write("SET statement_timeout='6min'; SET lock_timeout='180s';\n" + RECOVERY.read_text())
    recovery.stdin.close()
    wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_progress_create_index WHERE relid='rake_records'::regclass AND phase='waiting for old snapshots')")
    q("SET statement_timeout='2s'; INSERT INTO rake_records(source,metadata) VALUES('cash_hand','{}');")
    held_at = time.monotonic()
    time.sleep(16)  # finite local snapshot, exceeds the observed failed15s cap
    assert recovery.poll() is None
    release(reader)
    assert recovery.wait(timeout=60) == 0, recovery.stderr.read()
    print('PASS: readyTRUE invalid recovery waits beyond15s for real old snapshot while concurrent writer commits; elapsed', time.monotonic()-held_at, flush=True)
    q(migration)
    assert q("SELECT count(*) FROM pg_class WHERE relname LIKE 'idx_rake_records_satellite_seat_source_cc%'") == '0'
    recovered_oid = q("SELECT 'idx_rake_records_satellite_seat_source'::regclass::oid")
    assert invalid_oid != recovered_oid
    print('PASS: PG17 REINDEX INDEX CONCURRENTLY recovers actual invalid partial index without DROP; replacement OID recorded', invalid_oid, recovered_oid, flush=True)
    assert fingerprint() == original and result() == baseline
    print('PASS: equal full audit rows, exact unchanged function/ACL/RLS, sparse index plan, large metadata, interrupted-build refusal', flush=True)
finally:
    for proc in children:
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=10)
    if started and (data/'postmaster.pid').exists():
        run([PG/'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster)
    shutil.rmtree(socket)
