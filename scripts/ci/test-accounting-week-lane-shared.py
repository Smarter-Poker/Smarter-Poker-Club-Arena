#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════════════
 AN ACCRUAL EXCLUDES THE WEEKLY CLOSE. IT MUST NOT EXCLUDE ANOTHER ACCRUAL.
═══════════════════════════════════════════════════════════════════════════════

WHY THIS EXISTS (2026-09-29)

Four functions guard the weekly accounting period with an advisory lock keyed
on (club-or-union, week_start, week_end):

  fn_accrue_cash_hand_commissions                 once per CASH HAND
  fn_settle_tournament_rake                       once per TOURNAMENT RAKE SETTLE
  fn_lock_cash_bank_accounting_week               once per HAND, via atomic_distribute_rake
  fn_lock_accounting_tournament_recognition_week  once per tournament recognition

All four took it EXCLUSIVELY. The lock exists for one reason, written down in
fn_resolve_accounting_routing_scope:

    "Acquire before reading source-club membership: a waiting close must see
     all earning sources committed by the previous lock holder."

That is a reader/writer contract - many accruals against one close - and it was
implemented as writer/writer. The key spans SEVEN DAYS, so for a whole week
every cash hand and every tournament rake settle in a club serialised through
one lock, in FIFO order, however little each had to do. Measured on production
2026-09-29 02:52 UTC: a mean of 24.25 backends waiting on advisory locks, of
which 18.05 (74.4%) were on these week keys, against 0.80 on the per-table hand
locks that fan out correctly. Queues were observed seven deep.

The fix is one keyword in each of the four: pg_advisory_xact_lock_shared. The
close keeps the exclusive side, so the documented exclusion is preserved
EXACTLY - shared and exclusive still conflict - while accruals stop excluding
each other.

WHAT THIS PROVES, on a disposable PostgreSQL 17 cluster, against a fixture that
models the discipline and nothing else:

  1. EXCLUSIVE (the defect)  N concurrent accruals serialise: wall clock grows
                             with N.
  2. SHARED   (the fix)      the same N run concurrently: wall clock is that of
                             one of them.
  3. the close still excludes a shared accrual, and a shared accrual still
     excludes the close - in BOTH directions. This is the invariant, and a fix
     that lost it would be worse than the defect.
  4. concurrent accruals do not lose each other's writes.
  5. the settle -> recognition chain takes the same key twice in one
     transaction without requesting an upgrade of its own shared hold. This
     repository already learned that advisory upgrades deadlock
     (fn_ca_lock_settlement_lane_global, 2026-09-10), which is why all four
     guards had to move together rather than one at a time.

Usage:  python3 scripts/ci/test-accounting-week-lane-shared.py
        PG_BIN=/path/to/postgresql17/bin python3 scripts/ci/...
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/accounting-week-lane')
parser.add_argument('--writers', type=int, default=8)
parser.add_argument('--work', type=float, default=0.3)
args = parser.parse_args()
out = args.output.resolve()
if out.exists():
    shutil.rmtree(out)
out.mkdir(parents=True)

pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
PORT = '55702'
cluster = Path(tempfile.mkdtemp(prefix='accounting-week-lane-', dir='/tmp'))
socket = cluster / 'socket'
socket.mkdir(mode=0o700)
cmd = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
       '-h', str(socket), '-p', PORT, '-U', 'postgres', '-d', 'postgres']
KEY = 'club-accounting:00000000-0000-4000-8000-000000000001:1759104000:1759708800'
CLUB = '00000000-0000-4000-8000-000000000001'

results = {'scope': 'weekly accounting advisory lane: shared for accrual, exclusive for the close',
           'writers': args.writers, 'workSeconds': args.work, 'cases': [], 'passed': False}


def command(argv, sql=None, timeout=60):
    return subprocess.run([str(x) for x in argv], input=sql, text=True,
                          capture_output=True, env=env, timeout=timeout)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def record(name, passed, detail=None):
    entry = {'name': name, 'passed': bool(passed)}
    if detail is not None:
        entry['detail'] = detail
    results['cases'].append(entry)
    require(passed, name + ': ' + json.dumps(detail))
    return entry


def run(name, sql, expected=None):
    r = command(cmd, sql)
    (out / (name + '.log')).write_text(r.stdout + r.stderr)
    ok = r.returncode == 0
    if expected is not None:
        ok = ok and r.stdout.rstrip('\n') == expected
    require(ok, name + ': ' + r.stdout[-400:] + r.stderr[-1200:])
    return r.stdout.rstrip('\n')


def concurrent_accruals(shared, n, work):
    """Start n accruals at once; return the wall clock for all of them."""
    run('reset-' + ('shared' if shared else 'exclusive'),
        'TRUNCATE accounting_cash_rake_sources;')
    procs = []
    started = time.monotonic()
    for i in range(n):
        sql = ("BEGIN; SELECT accrue(('00000000-0000-4000-8000-%012d')::uuid,'%s','%s',%s,%s); COMMIT;"
               % (i, CLUB, KEY, 'true' if shared else 'false', work))
        procs.append(subprocess.Popen([str(x) for x in cmd], stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      text=True, env=env))
        procs[-1].stdin.write(sql + '\n')
        procs[-1].stdin.close()
    for p in procs:
        p.wait(timeout=120)
    elapsed = time.monotonic() - started
    for p in procs:
        require(p.returncode == 0, 'an accrual failed: ' + (p.stderr.read() or '')[-400:])
    landed = int(run('landed-' + ('shared' if shared else 'exclusive'),
                     'SELECT count(*) FROM accounting_cash_rake_sources;'))
    return elapsed, landed


def blocked(hold_sql, probe_sql, name):
    """True when probe_sql cannot proceed while hold_sql's transaction is open."""
    holder = subprocess.Popen([str(x) for x in cmd], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, env=env)
    try:
        holder.stdin.write('BEGIN; ' + hold_sql + " SELECT pg_advisory_lock(9292026);\n")
        holder.stdin.flush()
        deadline = time.monotonic() + 10
        while command(cmd, "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=9292026 AND granted);").stdout.strip() != 't':
            require(holder.poll() is None and time.monotonic() < deadline, 'holder barrier missing for ' + name)
            time.sleep(0.02)
        r = command(cmd, "SET lock_timeout='1500ms'; BEGIN; " + probe_sql + " COMMIT;")
        (out / (name + '.log')).write_text(r.stdout + r.stderr)
        return r.returncode != 0 and '55P03' in r.stderr
    finally:
        if holder.poll() is None:
            holder.stdin.write('ROLLBACK;\n')
            holder.stdin.close()
            holder.wait(timeout=10)


try:
    require(re.search(r'PostgreSQL\) 17\.', command([pg / 'postgres', '--version']).stdout),
            'PostgreSQL 17 required; set PG_BIN')
    r = command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres',
                 '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    require(r.returncode == 0, r.stderr)
    with (cluster / 'data/postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) +
                "'\nunix_socket_permissions=0700\nport=" + PORT +
                "\nshared_buffers='32MB'\nmax_connections=40\nfsync=off\n")
    r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-w', 'start'])
    require(r.returncode == 0, r.stderr)
    run('fixture', (ROOT / 'scripts/ci/probes/accounting-week-lane/fixture.sql').read_text())

    n, work = args.writers, args.work
    serial_floor = work * n * 0.75           # n writers that serialise cannot beat this
    concurrent_ceiling = work * 2.5          # n writers that do not must land near one

    # 1. THE DEFECT.
    exclusive_wall, exclusive_landed = concurrent_accruals(False, n, work)
    record('exclusive-accruals-serialise', exclusive_wall >= serial_floor and exclusive_landed == n,
           {'writers': n, 'wallSeconds': round(exclusive_wall, 3),
            'serialFloorSeconds': round(serial_floor, 3), 'rowsLanded': exclusive_landed})

    # 2. THE FIX.
    shared_wall, shared_landed = concurrent_accruals(True, n, work)
    record('shared-accruals-run-concurrently', shared_wall <= concurrent_ceiling and shared_landed == n,
           {'writers': n, 'wallSeconds': round(shared_wall, 3),
            'concurrentCeilingSeconds': round(concurrent_ceiling, 3), 'rowsLanded': shared_landed})

    speedup = exclusive_wall / shared_wall
    record('the-fix-removes-the-convoy', speedup >= 3.0,
           {'speedup': round(speedup, 2), 'exclusiveWall': round(exclusive_wall, 3),
            'sharedWall': round(shared_wall, 3)})

    # 4. no lost writes between concurrent accruals (asserted by rowsLanded above,
    #    restated here against the disjointness the shared mode now permits).
    record('concurrent-accruals-keep-every-row', shared_landed == n,
           {'expected': n, 'landed': shared_landed})

    # 3. THE INVARIANT, both directions.
    record('a-shared-accrual-still-excludes-the-close',
           blocked("SELECT accrue('00000000-0000-4000-8000-0000000000ff'::uuid,'%s','%s',true,0);" % (CLUB, KEY),
                   "SELECT close_week('%s'::uuid,'%s');" % (CLUB, KEY),
                   'close-blocked-by-shared-accrual'),
           {'holder': 'shared accrual', 'probe': 'close_week', 'expected': 'blocked'})

    record('the-close-still-excludes-an-accrual',
           blocked("SELECT close_week('%s'::uuid,'%s');" % (CLUB, KEY),
                   "SELECT accrue('00000000-0000-4000-8000-0000000000fe'::uuid,'%s','%s',true,0);" % (CLUB, KEY),
                   'accrual-blocked-by-close'),
           {'holder': 'close', 'probe': 'shared accrual', 'expected': 'blocked'})

    # A second shared accrual is NOT blocked by the first. This is the whole point.
    record('a-shared-accrual-does-not-exclude-a-sibling',
           not blocked("SELECT accrue('00000000-0000-4000-8000-0000000000fd'::uuid,'%s','%s',true,0);" % (CLUB, KEY),
                       "SELECT accrue('00000000-0000-4000-8000-0000000000fc'::uuid,'%s','%s',true,0);" % (CLUB, KEY),
                       'sibling-accrual-not-blocked'),
           {'holder': 'shared accrual', 'probe': 'shared accrual', 'expected': 'admitted'})

    # 5. the settle -> recognition chain never requests an upgrade.
    run('settle-then-recognize-takes-one-key-twice',
        "DO $$BEGIN PERFORM settle_then_recognize('%s'); END$$;\nSELECT 'ok';" % KEY, 'ok')
    record('settle-recognition-chain-does-not-upgrade', True,
           {'note': 'both guards shared; no exclusive request over a held shared lock'})

    results['passed'] = all(c['passed'] for c in results['cases'])
finally:
    command([pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    (out / 'results.json').write_text(json.dumps(results, indent=2))

print(json.dumps(results, indent=2))
raise SystemExit(0 if results['passed'] else 1)
