#!/usr/bin/env python3
"""The conservation sweep's history-wide reads, before and after their online indexes.

Runs the three installed functions (byte-identical to production, md5-pinned)
on an isolated native PostgreSQL cluster, builds the four indexes with the
exact online operation, and proves: the recording migration refuses before the
build and on any wrong shape or changed source; results are identical before
and after; every read switches to its index; chip_ledger buffer reads fall by
more than 4x. It fails on the pre-fix tree (no indexes, so no index scan).
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'scripts/ci/fixtures/conservation-sweep-read-indexes'
PG = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
MIGRATION = ROOT / 'supabase/migrations/20261001152917_conservation_sweep_reads_use_covering_partial_indexes.sql'
ONLINE = ROOT / 'scripts/ops/build-conservation-sweep-read-indexes-concurrently.sql'
INSTALLED = {
    'chip-drift-installed.sql': 'd0f1d4f355477669a4bc0427de757581',
    'bbj-contributions-total-installed.sql': '6a734d07f9e43b5ebbafa5e3974abfe5',
    'bbj-conservation-installed.sql': 'cd515fb20589a20ba6b930a6831610b8',
    'payout-rows-installed.sql': 'f5cf519b32f61707d283d634c39190f2',
}
cluster = Path(tempfile.mkdtemp(prefix='sweep-read-idx-', dir=os.environ.get('TMPDIR')))
socket = Path(tempfile.mkdtemp(prefix='sweep-idx-s-', dir=os.environ.get('SOCKET_TMPDIR', '/tmp')))
data = cluster / 'data'
env = {'PATH': str(PG) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
started = False


def run(args, sql=None, error=None):
    p = subprocess.run([str(a) for a in args], input=sql, text=True,
                       capture_output=True, env=env, timeout=600)
    if error:
        assert p.returncode and error in p.stderr, (error, p.stdout, p.stderr)
        print('PASS: refused ' + error, flush=True)
        return ''
    if p.returncode:
        raise RuntimeError(p.stdout + p.stderr)
    return p.stdout.strip()


def psql(*extra):
    return [PG/'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-U', 'postgres', '-d', 'postgres', *extra]


def q(sql, error=None):
    return run(psql(), sql, error)


def nodes(node):
    yield node
    for c in node.get('Plans', []):
        yield from nodes(c)


def body(definition):
    return definition.split('AS $function$\n', 1)[1].split('$function$', 1)[0]


def explain(sql):
    out = q("SET max_parallel_workers_per_gather = 0;\nEXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql)
    return json.loads(out.split('\n', 1)[1])[0]['Plan']


def scans(plan, rel):
    return [n for n in nodes(plan) if n.get('Relation Name') == rel]


def total(n):
    return n.get('Shared Hit Blocks', 0) + n.get('Shared Read Blocks', 0)


def blocks(ns):
    """Pages a scan node read itself, excluding its subplans (the idempotency probe)."""
    return sum(total(n) - sum(total(c) for c in n.get('Plans', [])) for n in ns)


EPOCH_SQL = None  # the epoch statement, cut from the installed function body


try:
    version = run([PG/'postgres', '--version'])
    assert int(version.split()[-1].split('.')[0]) >= 16, version
    run([PG/'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '-E', 'UTF8'])
    with (data/'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\nautovacuum=off\nshared_buffers=256MB\n")
    started = True
    run([PG/'pg_ctl', '-D', data, '-l', cluster/'server.log', '-w', 'start'])
    q((FIXTURE/'bootstrap.sql').read_text())

    defs = {}
    for name, md5 in INSTALLED.items():
        text = (FIXTURE/name).read_text()
        assert hashlib.md5(text.encode()).hexdigest() == md5, name
        q(text)
        defs[name] = text
    for fn in ['fn_chip_drift_since_baseline()', 'fn_bbj_conservation_check()',
               'fn_ca_payout_rows_without_money(integer)', 'fn_bbj_contributions_total()']:
        q(f'REVOKE ALL ON FUNCTION {fn} FROM PUBLIC; GRANT EXECUTE ON FUNCTION {fn} TO service_role;')
    # The catalog reproduces production's pg_get_functiondef byte for byte.
    assert q("SELECT md5(pg_get_functiondef('fn_chip_drift_since_baseline()'::regprocedure))") == INSTALLED['chip-drift-installed.sql']
    assert q("SELECT md5(pg_get_functiondef('fn_bbj_conservation_check()'::regprocedure))") == INSTALLED['bbj-conservation-installed.sql']
    assert q("SELECT md5(pg_get_functiondef('fn_ca_payout_rows_without_money(integer)'::regprocedure))") == INSTALLED['payout-rows-installed.sql']

    bbj_body = body(defs['bbj-conservation-installed.sql'])
    start = bbj_body.index('  SELECT round(\n           (SELECT COALESCE(sum(main_balance')
    end = bbj_body.index('    INTO v_epoch_unexp;')
    EPOCH_SQL = bbj_body[start:end].replace(
        'l.created_at > v_epoch_at',
        'l.created_at > (SELECT min(taken_at) FROM public.ca_bbj_pool_snapshots WHERE is_baseline)')
    assert 'v_' not in EPOCH_SQL, EPOCH_SQL
    DRIFT_SQL = body(defs['chip-drift-installed.sql']).rstrip().rstrip(';')
    PAYOUT_SQL = body(defs['payout-rows-installed.sql']).replace('p_days', '3').rstrip().rstrip(';')

    results = lambda: {
        'drift': q("SELECT md5(string_agg(row_to_json(d)::text, ',' ORDER BY club_id, user_id)) || ':' || count(*) FILTER (WHERE abs(drift) > 0.01) FROM fn_chip_drift_since_baseline() d"),
        'bbj': q("SELECT fn_bbj_conservation_check()::text"),
        'payout': q("SELECT md5(string_agg(row_to_json(p)::text, ',' ORDER BY paid_at, idempotency_key)) || ':' || count(*) FROM fn_ca_payout_rows_without_money(3) p"),
    }
    baseline = results()
    assert baseline['drift'].endswith(':12'), baseline['drift']
    assert json.loads(baseline['bbj'])['healthy'] in (True, False)
    assert int(baseline['payout'].split(':')[1]) > 0, baseline['payout']

    before = {'drift': explain(DRIFT_SQL), 'bbj': explain(EPOCH_SQL), 'payout': explain(PAYOUT_SQL)}
    before_chip = blocks(scans(before['drift'], 'chip_ledger')) + blocks(scans(before['bbj'], 'chip_ledger'))
    assert not any('player_wallet_drift' in (n.get('Index Name') or '') for n in nodes(before['drift']))

    # The recording migration builds nothing and refuses until the online build ran.
    migration = MIGRATION.read_text()
    q(migration, 'SWEEP_READ_INDEX_MISSING_BUILD_ONLINE')
    online = ONLINE.read_text()
    q('BEGIN;\n' + online + '\nCOMMIT;', 'cannot run inside a transaction block')
    run(psql('-f', ONLINE))
    q(migration)
    q(migration)  # recording is idempotent

    after = {'drift': explain(DRIFT_SQL), 'bbj': explain(EPOCH_SQL), 'payout': explain(PAYOUT_SQL)}
    assert results() == baseline, 'results changed'
    drift_scans = scans(after['drift'], 'chip_ledger')
    assert drift_scans and all(n['Node Type'] == 'Index Only Scan' and n['Index Name'] == 'idx_chip_ledger_player_wallet_drift' for n in drift_scans), drift_scans
    bbj_scans = scans(after['bbj'], 'chip_ledger')
    assert bbj_scans and all(n['Node Type'] == 'Index Only Scan' and n['Index Name'] == 'idx_chip_ledger_bbj_pool_epoch' for n in bbj_scans), bbj_scans
    pay_scans = scans(after['payout'], 'tournament_payouts')
    assert pay_scans and all(n.get('Index Name') == 'idx_tournament_payouts_paid_at' for n in pay_scans), pay_scans
    idem = [n for n in scans(after['payout'], 'wallet_credit_idempotency') if n.get('Index Name') == 'idx_wallet_credit_idempotency_created_at']
    assert idem, 'min(created_at) does not use its index'
    after_chip = blocks(drift_scans) + blocks(bbj_scans)
    assert after_chip * 4 < before_chip, (before_chip, after_chip)
    assert blocks(pay_scans) * 4 < blocks(scans(before['payout'], 'tournament_payouts')), ('payout window read did not narrow', blocks(scans(before['payout'], 'tournament_payouts')), blocks(pay_scans))

    # Any other shape, an invalid index, or a changed reading function refuses.
    q('DROP INDEX idx_tournament_payouts_paid_at; CREATE INDEX idx_tournament_payouts_paid_at ON tournament_payouts (paid_at, tournament_id);')
    q(migration, 'SWEEP_READ_INDEX_CONTRACT_CHANGED')
    q('DROP INDEX idx_tournament_payouts_paid_at; CREATE INDEX idx_tournament_payouts_paid_at ON tournament_payouts (paid_at);')
    q("UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'idx_chip_ledger_bbj_pool_epoch'::regclass")
    q(migration, 'SWEEP_READ_INDEX_CONTRACT_CHANGED')
    q("UPDATE pg_index SET indisvalid = true WHERE indexrelid = 'idx_chip_ledger_bbj_pool_epoch'::regclass")
    q("UPDATE pg_proc SET prosrc = prosrc || E'\\n-- local drift' WHERE oid = 'fn_chip_drift_since_baseline()'::regprocedure")
    q(migration, 'SWEEP_READ_SOURCE_CHANGED')
    q(defs['chip-drift-installed.sql'])
    q(migration)
    assert results() == baseline

    print(json.dumps({
        'acceptance': 'PASS',
        'chip_ledger_blocks_before': before_chip, 'chip_ledger_blocks_after': after_chip,
        'drift_ms': [before['drift']['Actual Total Time'], after['drift']['Actual Total Time']],
        'bbj_epoch_ms': [before['bbj']['Actual Total Time'], after['bbj']['Actual Total Time']],
        'payout_ms': [before['payout']['Actual Total Time'], after['payout']['Actual Total Time']],
        'server': version,
        'live_limit': 'local plans and results; production sweep duration after install is separate evidence',
    }), flush=True)
finally:
    if started and (data/'postmaster.pid').exists():
        run([PG/'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    shutil.rmtree(socket, ignore_errors=True)
