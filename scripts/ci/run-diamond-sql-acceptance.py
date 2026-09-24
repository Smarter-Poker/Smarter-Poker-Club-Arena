#!/usr/bin/env python3
"""Run every Diamond SQL acceptance runner against an isolated PostgreSQL 17.

The runners under tests/sql/ were written for the owner's Mac and come in two
shapes. Most of them connect to the Unix socket directory
/tmp/codex-diamond-phase2-pg on port 55472, and each fixture refuses any
database that is reachable over TCP or that carries a different name, so a
runner can never be pointed at production by an environment variable. This
script does not redirect them: it brings the socket they expect into existence
on the hosted runner, builds an empty cluster behind it, runs them one after
another (they share database names and rebuild them), and tears the cluster
down again.

The rest - PRIVATE_CLUSTER_RUNNERS below - initdb a cluster of their own inside
a temporary directory they create, own and destroy, because they load the
estate's historical schema base and must have a cluster nothing else has
written to. Two postmasters cannot share one socket and port, so those runners
cannot be moved onto the shared cluster; they hold the same property by the
same means, a socket-only server named in their own source. Which shape a
runner has is DECLARED here rather than guessed, and the check script refuses a
declaration for a runner that is not in the list at all.

The runner list is EXPLICIT rather than a glob so that a new runner cannot be
added to tests/sql/ without being named here: the script refuses to certify
when the directory holds a runner this list does not, and
scripts/ci/check-diamond-runners-listed.mjs applies the same rule statically.

Only PG_BIN reaches the runners. It selects which local PostgreSQL 17 binaries
run; the socket, port and database names stay fixed inside each runner.
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
SQL_DIR = ROOT / 'tests' / 'sql'
SOCKET_DIR = '/tmp/codex-diamond-phase2-pg'
PORT = '55472'

# Every Diamond runner, in the order they run, with the line that proves it
# reached its own end. Exit status alone is not enough: a runner whose fixture
# silently loaded nothing, or whose body was commented out, exits 0 and would
# stand in CI as a green step certifying nothing. Each proof below is the
# runner's own terminal print, so the step goes red when a runner stops
# asserting as well as when an assertion fails.
#
# Keep this list in step with tests/sql/run-*diamond*.py; the self-check below
# refuses a runner that is on disk and not here, and
# check-diamond-runners-listed.mjs refuses the same statically.
RUNNERS = [
    ('run-poker-diamond-custody.py', '69 additional assertions passed'),
    ('run-diamond-wallet-transfer.py', '37 Phase 4 assertions passed'),
    ('run-diamond-transfer-door-and-dr16.py',
     '26 isolated transfer door and DR16 checks passed; this is not a production certification.'),
    ('run-diamond-cash-custody.py',
     'Diamond custody contract passed; this is not full gameplay certification.'),
    ('run-diamond-cash-admission.py', 'forgery case leaves the fixture settled again'),
    ('run-diamond-top-up.py',
     'Diamond top-up door certified in the isolated fixture; this is not public release.'),
    ('run-diamond-straddle.py',
     'Diamond straddle admission certified in the isolated fixture; this is not public release.'),
    ('run-diamond-run-it-twice.py',
     'Diamond run-it-twice admission certified in the isolated fixture; this is not public release.'),
    ('run-diamond-bomb-pot.py',
     'Diamond bomb pot admission certified in the isolated fixture; this is not public release.'),
    ('run-diamond-plain-cash-rule.py',
     'One plain-cash rule certified in the isolated fixture; this is not public release.'),
    ('run-diamond-accepted-hand.py',
     'Diamond accepted-hand integration passed; public gameplay remains gated.'),
    ('run-diamond-controlled-play.py', 'CONTROLLED PLAY PASSED:'),
    ('run-diamond-incident-resolution.py',
     '50 isolated incident resolution checks passed; this is not a production certification.'),
    ('run-diamond-tournament-doors.py', 'Diamond tournament door capture verified.'),
    ('run-diamond-tournament-lifecycle.py',
     'Diamond tournament lifecycle cases verified against the installed doors,'),
    ('run-diamond-stats-asset-dimension.py',
     'Diamond stats asset dimension certified on isolated PostgreSQL 17.'),
    ('run-diamond-club-commerce.py',
     'club and union diamond commerce qualified in isolation'),
    ('run-diamond-club-commerce-admission.py',
     'diamond commerce admission is wired in shadow, qualified in isolation'),
    ('run-diamond-club-commerce-refunds.py',
     'diamond commerce refunds, notices and catalog lifecycle qualified in isolation'),
]
# Plain psql acceptance scripts: (file, database, the line that proves it ran).
SQL_SCRIPTS = [
    ('poker-arena-access.sql', 'poker_arena_phase2_test', 'PHASE2_LOCAL_SQL_PASS_39_ASSERTIONS'),
]
# The runners that build a cluster of their own instead of using the one this
# script starts. They load the estate's historical schema base and pin the
# installed doors against it, so they need a cluster nothing else has written
# to, on a socket inside a temporary directory they create and destroy. Being
# on this list is a DECLARATION: check-diamond-runners-listed.mjs and
# tests/unit/diamondAcceptanceCi.test.ts hold a named runner to the private
# contract (its own temporary socket, listen_addresses empty, and the shared
# socket and port never mentioned) and every other runner to the shared one
# (hard-wired to SOCKET_DIR and PORT). A runner therefore cannot be mislabelled
# into a weaker check - the two contracts exclude each other by assertion.
PRIVATE_CLUSTER_RUNNERS = [
    'run-diamond-club-commerce-admission.py',
    'run-diamond-club-commerce-refunds.py',
    'run-diamond-club-commerce.py',
    'run-diamond-stats-asset-dimension.py',
    'run-diamond-tournament-doors.py',
    'run-diamond-tournament-lifecycle.py',
]
RUNNER_NAMES = [name for name, _ in RUNNERS]
RUNNER_PATTERN = re.compile(r'^run-.*diamond.*\.py$')
DB_NAME_PATTERN = re.compile(r'\b(?:poker|ca)_[a-z0-9_]*_test\b')


def runners_on_disk():
    return sorted(p.name for p in SQL_DIR.iterdir() if RUNNER_PATTERN.match(p.name))


# What a red list check is actually asking for. The list rotted the day after it
# was written, because three runners landed on main from three other pull
# requests and each of them moved one place instead of three. Say the three.
ADDING_A_RUNNER = """
A NEW tests/sql/run-*diamond*.py RUNNER MOVES THREE PLACES IN THE SAME COMMIT:

  1. RUNNERS in scripts/ci/run-diamond-sql-acceptance.py - the file name and
     the exact line the runner's own body prints when it reaches its end. Add
     it to PRIVATE_CLUSTER_RUNNERS too if it builds its own cluster rather
     than using this script's.
  2. The EXPLICIT name list in tests/unit/diamondAcceptanceCi.test.ts.
  3. The COUNTS in that same test file, which are deliberately literal so
     that a list and a number cannot quietly disagree.

Moving one of the three and not the others is exactly what left this list
stale. Do not delete the explicit list, and do not make the count derived so
that it can never disagree - CLAUDE.md sections 8 and 10.11. Add the runner.
"""


def check_runner_list():
    on_disk = runners_on_disk()
    missing = sorted(set(on_disk) - set(RUNNER_NAMES))
    gone = sorted(set(RUNNER_NAMES) - set(on_disk))
    if missing or gone:
        raise SystemExit(
            'Diamond runner list is stale. Not listed: %s. Listed but absent: %s. '
            'Edit RUNNERS in %s.%s'
            % (missing or 'none', gone or 'none', pathlib.Path(__file__).name, ADDING_A_RUNNER)
        )
    unproved = sorted(name for name, proof in RUNNERS if not proof.strip())
    if unproved:
        raise SystemExit('these runners have no proof line: %s%s' % (unproved, ADDING_A_RUNNER))
    unknown_private = sorted(set(PRIVATE_CLUSTER_RUNNERS) - set(RUNNER_NAMES))
    if unknown_private:
        raise SystemExit(
            'PRIVATE_CLUSTER_RUNNERS names %s, which RUNNERS does not run.%s'
            % (unknown_private, ADDING_A_RUNNER)
        )


def fixture_database_names():
    names = set(db for _, db, _ in SQL_SCRIPTS)
    for path in list(SQL_DIR.glob('*.py')) + list(SQL_DIR.glob('*.sql')):
        names.update(DB_NAME_PATTERN.findall(path.read_text(errors='replace')))
    return sorted(names)


class Cluster:
    """An empty PostgreSQL 17 behind the exact socket the runners expect."""

    def __init__(self, pg_bin, work_parent, log):
        self.pg_bin = pathlib.Path(pg_bin)
        self.work_parent = work_parent
        self.log = log
        self.data = None
        self.started = False

    def tool(self, name):
        path = self.pg_bin / name
        if not path.is_file():
            raise SystemExit('PostgreSQL tool missing: %s' % path)
        return str(path)

    def psql(self, database, args, **kwargs):
        cmd = [self.tool('psql'), '-X', '-h', SOCKET_DIR, '-p', PORT, '-d', database,
               '-v', 'ON_ERROR_STOP=1', '-At'] + args
        return subprocess.run(cmd, text=True, capture_output=True, timeout=120, **kwargs)

    def answers(self):
        return subprocess.run([self.tool('pg_isready'), '-h', SOCKET_DIR, '-p', PORT],
                              capture_output=True, timeout=20).returncode == 0

    def start(self):
        os.makedirs(SOCKET_DIR, mode=0o700, exist_ok=True)
        if self.answers():
            self.log('reusing the PostgreSQL already answering on %s:%s' % (SOCKET_DIR, PORT))
            return
        self.data = pathlib.Path(tempfile.mkdtemp(prefix='diamond-acceptance-pg-', dir=self.work_parent))
        subprocess.run([self.tool('initdb'), '-D', str(self.data / 'data'), '-A', 'trust',
                        '-E', 'UTF8', '--locale=C'], check=True, capture_output=True, text=True)
        options = ('-p %s -k %s -c listen_addresses= -c fsync=off -c synchronous_commit=off '
                   '-c full_page_writes=off -c max_connections=60' % (PORT, SOCKET_DIR))
        subprocess.run([self.tool('pg_ctl'), '-D', str(self.data / 'data'), '-l',
                        str(self.data / 'server.log'), '-o', options, '-w', '-t', '60', 'start'],
                       check=True, capture_output=True, text=True)
        self.started = True
        for _ in range(60):
            if self.answers():
                break
            time.sleep(0.5)
        else:
            raise SystemExit('the isolated PostgreSQL never answered on %s:%s' % (SOCKET_DIR, PORT))
        self.log('started an isolated PostgreSQL at %s (socket only, no TCP)' % self.data)

    def ensure_databases(self, names):
        # The fixtures restate production doors verbatim, owner clause included,
        # so the cluster needs the `postgres` role those doors are owned by. A
        # cluster initialised by the runner's own account does not have it.
        roles = self.psql('postgres', ['-c', (
            "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='postgres') "
            "THEN CREATE ROLE postgres SUPERUSER; END IF; END $$")])
        if roles.returncode:
            raise SystemExit('could not ensure the postgres role: ' + roles.stderr)
        existing = set(self.psql('postgres', ['-c', 'SELECT datname FROM pg_database']).stdout.split())
        for name in names:
            if name in existing:
                continue
            created = self.psql('postgres', ['-c', 'CREATE DATABASE %s' % name])
            if created.returncode:
                raise SystemExit('could not create fixture database %s: %s' % (name, created.stderr))
            self.log('created fixture database ' + name)

    def stop(self):
        if not self.started:
            return
        subprocess.run([self.tool('pg_ctl'), '-D', str(self.data / 'data'), '-m', 'fast', '-w', 'stop'],
                       capture_output=True, text=True, timeout=120)
        self.started = False


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--pg-bin', default=os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
    parser.add_argument('--evidence', default=str(ROOT / 'artifacts' / 'diamond-sql-acceptance'))
    parser.add_argument('--work-parent', default=os.environ.get('RUNNER_TEMP') or tempfile.gettempdir())
    parser.add_argument('--only', action='append', default=[],
                        help='run only these runner file names (repeatable); the list check still applies')
    parser.add_argument('--keep-cluster', action='store_true',
                        help='leave a cluster this script started running (local debugging only)')
    args = parser.parse_args()

    evidence = pathlib.Path(args.evidence)
    evidence.mkdir(parents=True, exist_ok=True)
    receipt = {'passed': False, 'pgBin': args.pg_bin, 'runners': [], 'sqlScripts': []}

    def log(message):
        print('[diamond-acceptance] ' + message, flush=True)

    def persist():
        (evidence / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')

    check_runner_list()
    selected = [r for r in RUNNERS if not args.only or r[0] in args.only]
    unknown = sorted(set(args.only) - set(RUNNER_NAMES) - set(f for f, _, _ in SQL_SCRIPTS))
    if unknown:
        raise SystemExit('unknown runner(s): %s' % unknown)

    env = dict(os.environ, PG_BIN=str(pathlib.Path(args.pg_bin)), PYTHONUNBUFFERED='1')
    cluster = Cluster(args.pg_bin, args.work_parent, log)
    selected_scripts = [s for s in SQL_SCRIPTS if not args.only or s[0] in args.only]
    # A run made only of private-cluster runners needs no shared cluster at all.
    # Deciding that from the declaration is what keeps PRIVATE_CLUSTER_RUNNERS
    # load bearing rather than a comment that can drift from the truth.
    needs_shared = bool(selected_scripts) or any(
        name not in PRIVATE_CLUSTER_RUNNERS for name, _ in selected)
    failures = []
    try:
        if needs_shared:
            cluster.start()
            cluster.ensure_databases(fixture_database_names())
        else:
            log('every selected run builds its own cluster; no shared cluster is started')
        for name, proof in selected:
            own = name in PRIVATE_CLUSTER_RUNNERS
            started = time.monotonic()
            result = subprocess.run([sys.executable, str(SQL_DIR / name)], cwd=ROOT, env=env,
                                    text=True, capture_output=True, timeout=900)
            seconds = round(time.monotonic() - started, 1)
            (evidence / (name + '.stdout.log')).write_text(result.stdout)
            (evidence / (name + '.stderr.log')).write_text(result.stderr)
            passes = sum(1 for line in result.stdout.splitlines() if line.startswith('PASS'))
            # Both have to hold: it must not have failed, and it must have
            # reached the end that prints its own proof.
            proved = proof in result.stdout or proof in result.stderr
            entry = {'runner': name, 'returncode': result.returncode, 'seconds': seconds,
                     'passLines': passes, 'proof': proof, 'proved': proved,
                     'cluster': 'own' if own else 'shared'}
            receipt['runners'].append(entry)
            persist()
            if result.returncode or not proved:
                failures.append(name)
                log('%s: FAIL after %ss (exit %s, proof %s)' % (
                    name, seconds, result.returncode, 'present' if proved else 'ABSENT'))
                sys.stdout.write(result.stdout[-4000:])
                sys.stderr.write(result.stderr[-4000:])
            else:
                log('%s: PASS in %ss on its %s cluster, %d PASS lines, proof: %s'
                    % (name, seconds, 'own' if own else 'shared', passes, proof))
        for file_name, database, proof in selected_scripts:
            started = time.monotonic()
            result = cluster.psql(database, ['-f', file_name], cwd=SQL_DIR)
            seconds = round(time.monotonic() - started, 1)
            (evidence / (file_name + '.stdout.log')).write_text(result.stdout)
            (evidence / (file_name + '.stderr.log')).write_text(result.stderr)
            proved = result.returncode == 0 and proof in result.stdout
            receipt['sqlScripts'].append({'script': file_name, 'database': database,
                                          'returncode': result.returncode, 'seconds': seconds,
                                          'proof': proof, 'proved': proved})
            persist()
            if not proved:
                failures.append(file_name)
                log('%s: FAIL after %ss (exit %s, proof %s)' % (
                    file_name, seconds, result.returncode, 'present' if proof in result.stdout else 'absent'))
                sys.stderr.write(result.stderr[-4000:])
            else:
                log('%s: PASS in %ss (%s)' % (file_name, seconds, proof))
    finally:
        if not args.keep_cluster:
            cluster.stop()
            if cluster.data is not None:
                shutil.copy(cluster.data / 'server.log', evidence / 'postgres-server.log')
                shutil.rmtree(cluster.data, ignore_errors=True)
    receipt['passed'] = not failures
    persist()
    total = len(receipt['runners']) + len(receipt['sqlScripts'])
    if failures:
        log('%d of %d Diamond acceptance runs failed: %s' % (len(failures), total, ', '.join(failures)))
        return 1
    log('all %d Diamond acceptance runs passed on the isolated PostgreSQL' % total)
    return 0


if __name__ == '__main__':
    sys.exit(main())
