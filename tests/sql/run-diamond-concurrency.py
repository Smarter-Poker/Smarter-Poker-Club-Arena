#!/usr/bin/env python3
"""One Diamond cannot be spent twice: concurrency, duplicate delivery and crash
recovery against the installed Diamond money doors.

Isolated PostgreSQL 17 only. This runner never connects to production: it
initdbs its own cluster on a private unix socket with listen_addresses empty,
loads the estate's historical schema pair, the Diamond tournament fixture
(both deltas, both captures and its seed), then this suite's own production
table shapes, its own md5-pinned capture of every money door the cases run
and its scene, and drives REAL concurrent sessions against those doors.

Phase 11, line 2: "Test transfer/store/game concurrency, duplicate delivery
and crash recovery." Three groups of cases:

  RACE      one balance, many spenders at once (transfer, store purchase,
            cash buy-in, top-up, tournament registration), with every
            interleaving forced by a held transaction or a pause gate and
            proved by pg_blocking_pids before it is released;
  REPLAY    the same request id delivered twice concurrently and twice
            sequentially to every money door;
  RECOVERY  a session killed mid-transaction at each dangerous point
            (pg_terminate_backend from a controller session), and the whole
            cluster stopped in immediate mode in the middle of a workload,
            restarted, recovered and retried.

After every case: no wallet below zero, every balance equal to its journal,
no orphaned custody, movement, journal, receipt or ledger row, and the supply
identity (players + house + custody = register) exactly where the scene left
it.

The scene opens cash_games_enabled and tournaments_enabled INSIDE THIS
PRIVATE CLUSTER ONLY - the money doors refuse a closed arena, and a race
nobody can enter proves nothing. Production's switches are Dan's and nothing
here can reach them: the cluster has no TCP listener and PG_BIN is the only
thing this runner reads from the environment.

Usage:
  python3 tests/sql/run-diamond-concurrency.py [--bindir DIR] [--keep]
"""
import argparse
import hashlib
import json
import os
import pathlib
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
SQL = ROOT / 'tests/sql'
BASE = (ROOT / 'scripts/ci/probes/bbj-bank-replay/funded/source'
             / 'internal-ledger-native-fixture-0006/build')
# The Diamond tournament seed this scene builds on refuses any database but its
# own name on its own port. Both live inside the private cluster this run
# creates, on a socket in a temporary directory, so they name nothing shared.
PORT = '55733'
DB = 'diamond_tournament_lifecycle'
# PG_BIN is the ONLY thing this runner reads from the environment, and it names
# the PostgreSQL 17 binaries - never a server.
PG_BIN = os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')
CANDIDATES = ['/opt/homebrew/opt/postgresql@17/bin', '/usr/lib/postgresql/17/bin',
              '/usr/pgsql-17/bin', '/opt/postgresql@17/bin']

CAPTURES = [
    (SQL / 'diamond-tournament-doors-captured.sql',
     SQL / 'diamond-tournament-doors-captured.manifest.json'),
    (SQL / 'diamond-tournament-lifecycle-doors.sql',
     SQL / 'diamond-tournament-lifecycle-doors.manifest.json'),
    (SQL / 'diamond-concurrency-doors.sql',
     SQL / 'diamond-concurrency-doors.manifest.json'),
]
LOAD = [
    BASE / '00-roles.sql',
    BASE / '10-historical-schema.sql',
    SQL / 'diamond-tournament-fixture-schema.sql',
    SQL / 'diamond-tournament-doors-captured.sql',
    SQL / 'diamond-tournament-lifecycle-schema.sql',
    SQL / 'diamond-tournament-lifecycle-doors.sql',
    SQL / 'diamond-tournament-lifecycle-seed.sql',
    SQL / 'diamond-concurrency-doors.sql',
    SQL / 'diamond-concurrency-schema.sql',
    SQL / 'diamond-concurrency-seed.sql',
]


def find_bindir(explicit):
    for d in ([explicit] if explicit else []) + [PG_BIN] + CANDIDATES:
        if not d:
            continue
        p = pathlib.Path(d)
        if (p / 'initdb').exists() and (p / 'psql').exists() and (p / 'pg_ctl').exists():
            out = subprocess.run([str(p / 'postgres'), '--version'],
                                 capture_output=True, text=True).stdout
            if re.search(r'\(PostgreSQL\) 17\.', out):
                return p, out.strip()
    raise SystemExit('PostgreSQL 17 binaries not found; pass --bindir or set PG_BIN')


def check_capture(capture, manifest):
    """Every @@PIN must match the block under it, and the manifest must agree."""
    text = capture.read_text()
    blocks = re.findall(
        r'-- @@DOOR (?P<ident>[^\n]+)\n-- @@PIN md5=(?P<md5>[0-9a-f]{32}) len=(?P<len>\d+) owner=\S+\n'
        r'(?P<body>.*?);\nALTER FUNCTION ', text, re.S)
    if not blocks:
        raise SystemExit('%s carries no readable doors' % capture.name)
    bad = [ident for ident, md5, ln, body in blocks
           if hashlib.md5((body + '\n').encode()).hexdigest() != md5 or len(body + '\n') != int(ln)]
    if bad:
        raise SystemExit('captured door bodies in %s disagree with their own pins: %s'
                         % (capture.name, ', '.join(bad[:5])))
    doors = json.loads(manifest.read_text())['doors']
    if len(doors) != len(blocks):
        raise SystemExit('%s names %d doors, %s carries %d'
                         % (manifest.name, len(doors), capture.name, len(blocks)))
    return len(blocks)


class Failure(Exception):
    pass


class Blocked(Exception):
    """A step did not finish inside its window: the session is still waiting."""


class Cluster:
    """A private PostgreSQL 17 this run creates, owns, crashes, restarts and destroys."""

    def __init__(self, bindir, root):
        self.bindir, self.root = bindir, root
        self.data, self.sock = root / 'data', root / 'sock'
        self.log = root / 'postgres.log'
        self.env = dict(os.environ, LC_ALL='C', PGTZ='UTC')
        self.running = False

    def tool(self, name):
        return str(self.bindir / name)

    def run(self, argv, **kw):
        r = subprocess.run([str(x) for x in argv], capture_output=True, text=True,
                           env=self.env, timeout=1800, **kw)
        if r.returncode:
            sys.stderr.write(r.stdout[-6000:] + '\n' + r.stderr[-6000:] + '\n')
            raise SystemExit('refused: ' + ' '.join(str(x) for x in argv[:3]))
        return r

    def init(self):
        self.sock.mkdir(mode=0o700)
        os.chmod(self.root, 0o700)
        self.run([self.tool('initdb'), '-D', self.data, '-U', 'postgres', '--auth-local=trust',
                  '--auth-host=reject', '--encoding=UTF8', '--no-locale'])
        # synchronous_commit stays ON: a commit this suite counts as durable has
        # its WAL written before the client hears COMMIT, so the immediate stop
        # below can only lose what never committed - production's own contract.
        # fsync off only skips the flush to the platter, which a postmaster crash
        # (not an operating-system crash) never needs: the kernel keeps the pages.
        with (self.data / 'postgresql.conf').open('a') as f:
            f.write("\nlisten_addresses=''\nport=%s\nunix_socket_directories='%s'\n"
                    "unix_socket_permissions=0700\nmax_connections=40\n"
                    "shared_buffers='128MB'\nfsync=off\nsynchronous_commit=on\n"
                    "full_page_writes=off\nlog_min_error_statement=error\n"
                    "deadlock_timeout='200ms'\ntrack_functions='pl'\n"
                    "log_line_prefix='%%m [%%p] %%a '\n" % (PORT, self.sock))

    def start(self):
        self.run([self.tool('pg_ctl'), '-D', self.data, '-l', self.log, '-w', '-t', '120', 'start'])
        self.running = True

    def stop(self, mode):
        subprocess.run([self.tool('pg_ctl'), '-D', str(self.data), '-m', mode, '-w', 'stop'],
                       capture_output=True, text=True, env=self.env, timeout=120)
        self.running = False

    def psql_argv(self, *extra):
        return [self.tool('psql'), '-X', '-q', '-h', str(self.sock), '-p', PORT, '-U', 'postgres',
                '-d', DB] + list(extra)

    def sql(self, text, check=True):
        """One statement batch on a fresh connection; returns stdout (tuples only)."""
        r = subprocess.run(self.psql_argv('-At', '-v', 'ON_ERROR_STOP=1', '-c', text),
                           capture_output=True, text=True, env=self.env, timeout=300)
        if check and r.returncode:
            raise Failure('SQL failed: %s\n%s' % (text[:300], r.stderr[-3000:]))
        return r.stdout.strip() if check else r

    def load(self, path):
        return self.run(self.psql_argv('-v', 'ON_ERROR_STOP=1', '-f', str(path)))


class Session:
    """One real client connection, driven step by step through psql over pipes.

    Every step is followed by a marker on stdout and on stderr, so a step's rows
    and its errors are read back as a unit; a step whose marker does not arrive
    inside its window is BLOCKED, and the caller proves who it waits on."""

    def __init__(self, cluster, name):
        self.cluster, self.name, self.n = cluster, name, 0
        self.p = subprocess.Popen(cluster.psql_argv('-At', '-v', 'ON_ERROR_STOP=0'),
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, bufsize=1, env=cluster.env)
        self.out, self.err = queue.Queue(), queue.Queue()
        for stream, q in ((self.p.stdout, self.out), (self.p.stderr, self.err)):
            threading.Thread(target=self._pump, args=(stream, q), daemon=True).start()
        self.pending = None
        self.step("SET application_name = '%s'" % name)
        self.pid = int(self.step('SELECT pg_backend_pid()')[0][-1])

    @staticmethod
    def _pump(stream, q):
        for line in iter(stream.readline, ''):
            q.put(line.rstrip('\n'))
        q.put(None)

    def send(self, sql):
        if self.pending is not None:
            raise Failure('%s: a step is still in flight' % self.name)
        self.n += 1
        mark = '__STEP_%d_%s__' % (self.n, self.name)
        self.p.stdin.write(sql.strip().rstrip(';') + ';\n\\echo ' + mark + '\n\\warn ' + mark + '\n')
        self.p.stdin.flush()
        self.pending = (mark, [], [])
        return mark

    def _drain(self, q, mark, into, deadline):
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                return False
            try:
                line = q.get(timeout=min(left, 0.05))
            except queue.Empty:
                continue
            if line is None:
                return None
            if line == mark:
                return True
            into.append(line)

    def wait(self, seconds=30.0):
        """(rows, errors) of the step in flight, or Blocked if it is still waiting."""
        mark, rows, errs = self.pending
        deadline = time.monotonic() + seconds
        got = self._drain(self.out, mark, rows, deadline)
        if got is False:
            raise Blocked(self.name)
        if got is None:
            self.pending = None
            raise Failure('%s: the connection ended (%s)' % (self.name, ' | '.join(errs + rows)[-500:]))
        if self._drain(self.err, mark, errs, time.monotonic() + 10) is not True:
            raise Failure('%s: stderr marker missing' % self.name)
        self.pending = None
        return rows, [e for e in errs if not e.startswith('NOTICE:') and not e.startswith('WARNING:')]

    def step(self, sql, seconds=30.0):
        self.send(sql)
        return self.wait(seconds)

    def ok(self, sql, seconds=30.0):
        rows, errs = self.step(sql, seconds)
        if errs:
            raise Failure('%s: %s -> %s' % (self.name, sql[:200], errs))
        return rows

    def gone(self, seconds=10.0):
        """True once the server side of this connection has ended."""
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if self.p.poll() is not None:
                return True
            try:
                self.p.stdin.write('\n')
                self.p.stdin.flush()
            except (BrokenPipeError, OSError):
                return True
            time.sleep(0.05)
        return False

    def close(self):
        try:
            if self.p.poll() is None:
                self.p.stdin.write('\\q\n')
                self.p.stdin.flush()
                self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


def build(cluster, until=None):
    cluster.init()
    cluster.start()
    cluster.run(cluster.psql_argv()[:-2] + ['-d', 'postgres', '-c',
                'CREATE DATABASE %s TEMPLATE template0' % DB])
    boundary = cluster.sql("SELECT (inet_server_addr() IS NULL)::text||' '||current_user").split()
    if boundary != ['true', 'postgres']:
        raise SystemExit('the fixture boundary is not the private socket it requires')
    print('PASS: private socket-only PostgreSQL 17, owned by this run', flush=True)
    for f in LOAD:
        started = time.monotonic()
        r = cluster.load(f)
        for line in (r.stdout + r.stderr).splitlines():
            if 'PASS:' in line and f.name.startswith('diamond-concurrency'):
                print(line.split('PASS:', 1)[1].strip(), flush=True)
        print('loaded %s in %.1fs' % (f.name, time.monotonic() - started), flush=True)
        if until and f.name == until:
            return


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bindir')
    ap.add_argument('--keep', action='store_true')
    ap.add_argument('--load-only', action='store_true')
    ap.add_argument('--until')
    args = ap.parse_args()
    for f in LOAD + [m for _, m in CAPTURES]:
        if not f.exists():
            raise SystemExit('missing fixture input: ' + str(f))
    for capture, manifest in CAPTURES:
        n = check_capture(capture, manifest)
        print('PASS: %d doors in %s agree with their own pins and the manifest'
              % (n, capture.name), flush=True)
    bindir, version = find_bindir(args.bindir)
    print('using ' + version, flush=True)
    cluster = Cluster(bindir, pathlib.Path(tempfile.mkdtemp(prefix='diamond-concurrency-')))
    try:
        build(cluster, args.until)
        if args.load_only or args.until:
            return
        run_cases(cluster)
    finally:
        if cluster.running and not args.keep:
            cluster.stop('immediate')
        if not args.keep:
            shutil.rmtree(cluster.root, ignore_errors=True)
        else:
            print('kept cluster at ' + str(cluster.root), flush=True)


if __name__ == '__main__':
    main()
