#!/usr/bin/env python3
"""One Diamond cannot be spent twice: concurrency, duplicate delivery and crash
recovery against the installed Diamond money doors.

Isolated PostgreSQL 17 only. This runner never connects to production: it
initdbs its own cluster on a private unix socket with listen_addresses empty,
loads the estate's historical schema pair and the Diamond tournament fixture's
deltas and captures, then this suite's own md5-pinned capture of every money
door the cases run, the tables those doors write in production's exact shape
and its scene, and drives REAL concurrent sessions against those doors.

Phase 11, line 2: "Test transfer/store/game concurrency, duplicate delivery
and crash recovery." Three groups of cases:

  RACE      one balance, many spenders at once (transfer, store purchase,
            cash buy-in, top-up, tournament registration), with every
            interleaving forced by a held transaction or a pause gate and
            proved by pg_blocking_pids before it is released;
  REPLAY    the same request id delivered twice concurrently and twice
            sequentially to every money door: exactly one effect, every
            retry answered with the first receipt word for word (after the
            caller's wallet has moved), and the same id with a different
            payload refused by name;
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
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
SQL = ROOT / 'tests/sql'
BASE = (ROOT / 'scripts/ci/probes/bbj-bank-replay/funded/source'
             / 'internal-ledger-native-fixture-0006/build')
# The socket lives in a temporary directory this run creates; the port only
# names the socket file inside it, and nothing listens on TCP.
PORT = '55734'
DB = 'diamond_concurrency'
# PG_BIN is the ONLY thing this runner reads from the environment, and it names
# the PostgreSQL 17 binaries - never a server.
PG_BIN = os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')
CANDIDATES = ['/opt/homebrew/opt/postgresql@17/bin', '/usr/lib/postgresql/17/bin',
              '/usr/pgsql-17/bin', '/opt/postgresql@17/bin']

# The runner's last line, and the proof scripts/ci/run-diamond-sql-acceptance.py
# requires in its output: kept on one line so the wrapper's list check finds it here.
PROOF = 'checks passed: one Diamond cannot be spent twice under concurrency, duplicate delivery or a crash; isolated PostgreSQL 17, not a production certification.'

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
                    "deadlock_timeout='200ms'\ntrack_functions='all'\n"
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
        self.notices = [e for e in errs if e.startswith('NOTICE:')]
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



# ---------------------------------------------------------------------------
# The scene, as the cases see it (diamond-concurrency-seed.sql made it).
# ---------------------------------------------------------------------------
ARENA = '002c2d27-9584-4e52-835a-bb2be148fc81'


def player(n):
    return '10000000-0000-0000-0000-0000000000%02x' % n


def session_uuid(uid):
    return str(uuid.UUID(hashlib.md5(('concurrency-session:' + uid).encode()).hexdigest()))


def q(value):
    return "'" + str(value).replace("'", "''") + "'"


def client_context(uid):
    """A real browser call: PostgREST's authenticated role, the player's JWT, a live session."""
    claims = json.dumps({'role': 'authenticated', 'sub': uid, 'session_id': session_uuid(uid)})
    return ("SET ROLE authenticated; SELECT set_config('request.jwt.claims', %s, false), "
            "set_config('request.jwt.claim.sub', %s, false), "
            "set_config('request.jwt.claim.role', 'authenticated', false), "
            "set_config('request.headers', '{}', false)" % (q(claims), q(uid)))


# The engine: service_role, as the engine's own PostgREST calls arrive.
ENGINE_CONTEXT = ("SET ROLE service_role; SELECT set_config('request.jwt.claims', '{\"role\":\"service_role\"}', false), "
                  "set_config('request.jwt.claim.sub', '', false), "
                  "set_config('request.jwt.claim.role', 'service_role', false), "
                  "set_config('request.headers', '{\"x-smarter-data-actor\":\"service\",\"x-smarter-data-protocol\":\"1\"}', false)")
# The rebuy money core and the prize payer are executable by their owner only:
# the engine reaches them inside its own SECURITY DEFINER doors
# (process_tournament_rebuy, the terminal). A core session is that owner with
# the engine's claims - exactly what runs inside those doors.
CORE_CONTEXT = ENGINE_CONTEXT.replace('SET ROLE service_role', 'RESET ROLE')


class Door:
    """One money door call: who calls it, the SQL, and how its durable receipt is read back."""

    def __init__(self, name, actor, context, sql, receipt=None, users=()):
        self.name, self.actor, self.context, self.sql = name, actor, context, sql
        self.receipt, self.users = receipt, list(users)


def transfer(sender, recipient, amount, ref):
    return Door('transfer', sender, client_context(sender),
                'SELECT public.send_wallet_diamond_transfer(%s::uuid, %d, NULL, %s)' % (q(recipient), amount, q(ref)),
                users=[sender, recipient])


def purchase(uid, feature, req):
    return Door('purchase', uid, client_context(uid),
                'SELECT public.fn_purchase_feature_v2(%s::uuid, %s, %s::uuid)' % (q(uid), q(feature), q(req)),
                receipt="SELECT result FROM public.digital_purchase_receipts WHERE user_id=%s AND request_id=%s" % (q(uid), q(req)),
                users=[uid])


def buyin(uid, table, seat, amount, key):
    return Door('buy-in', uid, client_context(uid),
                'SELECT public.atomic_table_buyin(%s::uuid, %s::uuid, %d, %d, false, %s::uuid, %s::uuid)'
                % (q(uid), q(table), seat, amount, q(ARENA), q(key)),
                receipt='SELECT public.fn_ca_cash_buyin_receipt(%s::uuid, %s::uuid)' % (q(key), q(table)),
                users=[uid])


def topup(uid, table, amount, expected, req):
    return Door('top-up', uid, ENGINE_CONTEXT,
                'SELECT public.fn_poker_diamond_top_up(%s::uuid, %s::uuid, %d, %d, %s::uuid)'
                % (q(uid), q(table), amount, expected, q(req)), users=[uid])


def cashout(uid, table, seat, occupancy):
    return Door('cash-out', uid, ENGINE_CONTEXT,
                "SELECT public.fn_cashout_seat_occupancy(%s::uuid, %s::uuid, %d, %s::uuid, 'voluntary')"
                % (q(uid), q(table), seat, q(occupancy)), users=[uid])


def register(uid, tid, req):
    return Door('register', uid, client_context(uid),
                'SELECT public.fn_register_for_tournament_request(%s::uuid, %s::uuid)' % (q(tid), q(req)),
                users=[uid])


def unregister(uid, tid, req):
    return Door('unregister', uid, client_context(uid),
                'SELECT public.fn_unregister_from_tournament(%s::uuid, %s::uuid)' % (q(tid), q(req)),
                users=[uid])


def rebuy(uid, tid, token, cost=None):
    return Door('rebuy', uid, CORE_CONTEXT,
                "SELECT public.fn_ca_process_tournament_chip_purchase_money_v1(%s::uuid, %s::uuid, 'rebuy', %s, NULL, 1, %s)"
                % (q(tid), q(uid), 'NULL' if cost is None else '%d' % cost, q(token)), users=[uid])


def payout(uid, tid, amount, key):
    return Door('payout', uid, CORE_CONTEXT,
                "SELECT public.fn_poker_diamond_tournament_pay(%s::uuid, %d, %s, 'prize', %s::uuid, 'concurrency payout')"
                % (q(uid), amount, q(key), q(tid)), users=[uid])


def rid():
    return str(uuid.uuid4())


class Suite:
    """The controller: owns every session, proves every wait, and records every check."""

    def __init__(self, cluster):
        self.cluster = cluster
        self.passed = 0
        self.evidence = {'cases': [], 'refusals': {}, 'waits': {}}
        self.sessions = []
        self.next_player = 1
        self.next_seat = {}
        self.targets = dict(line.split('|') for line in cluster.sql(
            'SELECT name, id FROM concurrency_fixture.targets').splitlines())
        self.ctrl = self.session('controller')

    # -- sessions -----------------------------------------------------------
    def session(self, name, context=None):
        s = Session(self.cluster, name)
        if context:
            s.ok(context)
        self.sessions.append(s)
        return s

    def door_session(self, door, tag):
        return self.session('%s_%s_%d' % (door.name.replace('-', ''), tag, len(self.sessions)), door.context)

    def close_all(self):
        for s in self.sessions:
            if s is not self.ctrl:
                s.close()
        self.sessions = [self.ctrl]

    def players(self, k):
        out = [player(self.next_player + i) for i in range(k)]
        self.next_player += k
        if self.next_player > 199:            # 199 and 200 are the chip-entry players
            raise Failure('the scene ran out of fresh players')
        return out

    def seat(self, table_name=None):
        """A (table id, seat number) nobody has used yet in this run."""
        names = [table_name] if table_name else ['cash_%d' % i for i in range(1, 17)]
        for name in names:
            n = self.next_seat.get(name, 0) + 1
            if n <= 6:
                self.next_seat[name] = n
                return self.targets[name], n
        raise Failure('the scene ran out of Diamond cash seats')

    # -- checks -------------------------------------------------------------
    def check(self, ok, label, detail=None):
        if not ok:
            raise Failure('FAIL: %s%s' % (label, (' - ' + str(detail)[:1500]) if detail is not None else ''))
        self.passed += 1
        print('PASS: ' + label, flush=True)

    def money(self, users):
        return json.loads(self.ctrl.ok('SELECT concurrency_fixture.money(ARRAY[%s]::uuid[])'
                                       % ','.join(q(u) for u in users))[0])

    def invariants(self, label):
        rows = self.ctrl.ok("SELECT name || '|' || ok::text || '|' || COALESCE(detail, '') FROM concurrency_fixture.invariants()")
        bad = [r for r in rows if r.split('|')[1] != 'true']
        self.check(not bad and len(rows) == 14,
                   '%s: all 14 invariants hold (no overdraw, wallets equal journals, custody equals movements, '
                   'no orphan, identity whole)' % label, bad)

    def wallet(self, uid):
        return int(self.ctrl.ok('SELECT diamonds FROM public.profiles WHERE id=%s' % q(uid))[0])

    def prove_waits(self, victim, holders, label, seconds=10.0):
        """The victim's statement is blocked on a lock held by one of `holders`."""
        pids = [h.pid for h in holders]
        deadline = time.monotonic() + seconds
        seen = None
        while time.monotonic() < deadline:
            row = self.ctrl.ok("SELECT COALESCE(wait_event_type, '') || '|' || COALESCE(wait_event, '') || '|' || "
                               "COALESCE(array_to_string(pg_blocking_pids(pid), ','), '') "
                               "FROM pg_stat_activity WHERE pid=%d" % victim.pid)
            if row:
                kind, event, blockers = row[0].split('|')
                seen = (kind, event, blockers)
                if kind == 'Lock' and set(int(b) for b in blockers.split(',') if b) & set(pids):
                    self.evidence['waits'].setdefault(label, []).append('%s:%s' % (kind, event))
                    return event
            time.sleep(0.02)
        raise Failure('FAIL: %s - %s never waited on %s (last seen %s)' % (label, victim.name, pids, seen))

    def result(self, rows_errs):
        rows, errs = rows_errs
        if errs:
            return {'error': errs[0].split('ERROR:', 1)[-1].strip()}
        text = rows[-1] if rows else ''
        try:
            return json.loads(text) if text and text[0] in '{[' else {'value': text}
        except ValueError:
            return {'value': text}

    def refusal(self, door, res, names):
        """A refusal must be named: an error or a reply carrying one of the door's own refusal names."""
        text = json.dumps(res)
        named = any(n in text for n in names)
        self.evidence['refusals'].setdefault(door.name, set()).add(
            res.get('error') or res.get('code') or res.get('reason') or text[:80])
        return named


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


# ---------------------------------------------------------------------------
# RACE: one balance, many spenders at once.
# ---------------------------------------------------------------------------
GOLD = ('card_back_gold', 150)          # production's price row, copied by the seed
REFUSED = {                              # each door's own name for "not enough Diamonds"
    'transfer': ['insufficient_transferable_diamonds'],
    'purchase': ['Insufficient diamonds'],
    'buy-in': ['insufficient_settled_diamonds'],
    'top-up': ['insufficient_settled_diamonds'],
    'register': ['insufficient_diamonds'],
}


def succeeded(door, res):
    if 'error' in res:
        return False
    if door.name == 'buy-in':
        return True                                   # void on success; errors raise
    if door.name == 'register':
        return res.get('ok') is True
    return res.get('success') is True


def spenders(suite, x, y, seat_table, spare, tid, stack):
    """The five doors that can take one wallet's Diamonds, as one player would reach them."""
    return {
        'transfer': (transfer(x, y, 150, 'race-transfer-' + rid()[:18]), 150),
        'purchase': (purchase(x, GOLD[0], rid()), GOLD[1]),
        'buy-in': (buyin(x, spare[0], spare[1], 200, rid()), 200),
        'top-up': (topup(x, seat_table, 100, stack, rid()), 100),
        'register': (register(x, tid, rid()), 25),
    }


def seat_player(suite, uid, table, seat, amount):
    """A client buy-in, committed: the player sits with `amount` in custody."""
    s = suite.session('seat_%s_%d' % (uid[-2:], len(suite.sessions)), client_context(uid))
    res = suite.result(s.step(buyin(uid, table, seat, amount, rid()).sql))
    s.close()
    suite.check('error' not in res, 'a client buys %d Diamonds into a Diamond cash seat through atomic_table_buyin' % amount, res)
    return suite.ctrl.ok('SELECT occupancy_id FROM public.table_seats WHERE user_id=%s AND table_id=%s AND left_at IS NULL'
                         % (q(uid), q(table)))[0]


def race_ordered(suite, order, tables, tid):
    """Each spender holds its transaction open while the next one arrives and is PROVED to wait on it."""
    x, y = suite.players(2)
    (seat_table, seat_no), spare = suite.seat(tables[0]), suite.seat(tables[1])
    seat_player(suite, x, seat_table, seat_no, 100)
    start = suite.wallet(x)
    doors = spenders(suite, x, y, seat_table, spare, tid, 100)
    remaining, expect = start, {}
    for name in order:                      # the serial model the database must agree with
        amount = doors[name][1]
        expect[name] = amount <= remaining
        if expect[name]:
            remaining -= amount
    held, results = None, {}
    for name in order:
        door = doors[name][0]
        s = suite.door_session(door, 'ord')
        s.ok('BEGIN')
        s.send(door.sql)
        if held is not None:
            # A door that refused by raising has already released its locks (the
            # error aborted its transaction); every other held door is waited on.
            if 'error' not in held[2]:
                suite.prove_waits(s, [held[0]], 'race-ordered')
            held[0].step('COMMIT')
            results[held[1]] = held[2]
        results_now = suite.result(s.wait())
        held = (s, name, results_now)
    held[0].step('COMMIT')
    results[held[1]] = held[2]
    label = ' -> '.join(order)
    for name in order:
        door, amount = doors[name]
        ok = succeeded(door, results[name])
        suite.check(ok == expect[name],
                    'race %s: %s %s exactly as the serial order says (%s)'
                    % (label, name, 'is paid' if expect[name] else 'is refused', 'paid' if ok else 'refused'),
                    results[name])
        if not ok:
            suite.check(suite.refusal(door, results[name], REFUSED[name]),
                        'race %s: the %s refusal is named %s' % (label, name, REFUSED[name][0]), results[name])
    suite.check(suite.wallet(x) == remaining,
                'race %s: the wallet ends at exactly %d = %d less every paid spender; no update was lost'
                % (label, remaining, start), suite.wallet(x))
    suite.invariants('race ' + label)
    suite.close_all()
    suite.evidence['cases'].append({'group': 'race', 'case': 'ordered ' + label,
                                    'paid': [n for n in order if expect[n]], 'refused': [n for n in order if not expect[n]],
                                    'wallet_end': remaining})


def race_barrier(suite, rep, tables, tid):
    """All five released at the same instant from one advisory barrier; any interleaving must still serialize."""
    x, y = suite.players(2)
    (seat_table, seat_no), spare = suite.seat(tables[0]), suite.seat(tables[1])
    seat_player(suite, x, seat_table, seat_no, 100)
    start = suite.wallet(x)
    doors = spenders(suite, x, y, seat_table, spare, tid, 100)
    key = 910000 + rep
    suite.ctrl.ok('SELECT pg_advisory_lock(%d)' % key)
    sess = {}
    names = list(doors)
    for name in names[rep % 5:] + names[:rep % 5]:      # a different queue order on every repetition
        door, amount = doors[name]
        s = suite.door_session(door, 'bar')
        s.send('BEGIN; SELECT pg_advisory_xact_lock_shared(%d); %s; COMMIT' % (key, door.sql))
        sess[name] = s
    for name, s in sess.items():
        suite.prove_waits(s, [suite.ctrl], 'race-barrier')
    suite.ctrl.ok('SELECT pg_advisory_unlock(%d)' % key)
    results = {name: suite.result(s.wait(60)) for name, s in sess.items()}
    paid = [n for n in doors if succeeded(doors[n][0], results[n])]
    refused = [n for n in doors if n not in paid]
    spent = sum(doors[n][1] for n in paid)
    end = suite.wallet(x)
    suite.check(spent <= start and end == start - spent,
                'race barrier %d: five spenders released at once, %s paid (%d Diamonds) and the wallet ends at exactly %d'
                % (rep, '+'.join(paid) or 'none', spent, start - spent), (results, end))
    suite.check(all(end < doors[n][1] for n in refused),
                'race barrier %d: every refused spender asked for more than the wallet finally held (%s), so each refusal '
                'was decided on the committed balance' % (rep, ', '.join('%s %d' % (n, doors[n][1]) for n in refused) or 'none'),
                (end, refused, results))
    for n in refused:
        suite.check(suite.refusal(doors[n][0], results[n], REFUSED[n]),
                    'race barrier %d: the %s refusal is named %s' % (rep, n, REFUSED[n][0]), results[n])
    suite.invariants('race barrier %d' % rep)
    suite.close_all()
    suite.evidence['cases'].append({'group': 'race', 'case': 'barrier %d' % rep, 'paid': paid, 'refused': refused,
                                    'wallet_end': end})


def race_crossing(suite, table):
    """Two wallets sending to each other while one of them spends: no deadlock, nothing lost."""
    x, y = suite.players(2)
    total = suite.wallet(x) + suite.wallet(y)
    # Deterministic half: X->Y is held; Y->X arrives and must wait for it (both lock the lower id first).
    a = suite.door_session(transfer(x, y, 300, 'cross-xy-' + rid()[:20]), 'x')
    b = suite.door_session(transfer(y, x, 700, 'cross-yx-' + rid()[:20]), 'y')
    a.ok('BEGIN')
    ra = suite.result(a.step(transfer(x, y, 300, 'cross-xy-held-000001').sql))
    b.send(transfer(y, x, 700, 'cross-yx-wait-000001').sql)
    suite.prove_waits(b, [a], 'race-crossing')
    a.ok('COMMIT')
    rb = suite.result(b.wait())
    suite.check(ra.get('success') is True and rb.get('success') is True,
                'crossing transfers: Y->X 700 waited for X->Y 300 to commit and then saw the 300 it needed', (ra, rb))
    suite.check(suite.wallet(x) == 900 and suite.wallet(y) == 100,
                'crossing transfers: X holds 900 and Y holds 100, exactly', (suite.wallet(x), suite.wallet(y)))
    # Racing half: both directions and two spends released together.
    key = 919000
    suite.ctrl.ok('SELECT pg_advisory_lock(%d)' % key)
    doors = [transfer(x, y, 400, 'cross-xy-' + rid()[:20]), transfer(y, x, 90, 'cross-yx-' + rid()[:20]),
             buyin(x, table[0], table[1], 200, rid()), purchase(y, 'rabbit_hunt', rid())]
    sess = []
    for d in doors:
        s = suite.door_session(d, 'x2')
        s.send('BEGIN; SELECT pg_advisory_xact_lock_shared(%d); %s; COMMIT' % (key, d.sql))
        sess.append(s)
    for s in sess:
        suite.prove_waits(s, [suite.ctrl], 'race-crossing-barrier')
    suite.ctrl.ok('SELECT pg_advisory_unlock(%d)' % key)
    res = [suite.result(s.wait(60)) for s in sess]
    deadlocked = [r for r in res if 'deadlock' in json.dumps(r)]
    suite.check(not deadlocked, 'crossing transfers released together with a buy-in and a purchase: no deadlock', res)
    custody = int(suite.ctrl.ok('SELECT COALESCE(sum(balance),0) FROM public.poker_diamond_custody WHERE user_id IN (%s, %s)'
                                % (q(x), q(y)))[0])
    spent = 5 if succeeded(doors[3], res[3]) else 0
    suite.check(suite.wallet(x) + suite.wallet(y) + custody + spent == total,
                'crossing transfers: the two wallets, the seat custody and the store price add back to the %d they began with'
                % total, (suite.wallet(x), suite.wallet(y), custody, spent, res))
    suite.invariants('race crossing')
    suite.close_all()
    suite.evidence['cases'].append({'group': 'race', 'case': 'crossing wallets', 'results': [
        'paid' if succeeded(d, r) else 'refused' for d, r in zip(doors, res)]})


def race_mid_door(suite, name, gate, table_names):
    """A spender paused INSIDE its door, after it has locked and read the wallet and before it
    writes it; a second spender asking for the whole balance must wait, and then see the debit."""
    x, y, z = suite.players(3)
    (seat_table, seat_no), spare = suite.seat(table_names[0]), suite.seat(table_names[1])
    seat_player(suite, x, seat_table, seat_no, 100)
    start = suite.wallet(x)
    door, amount = spenders(suite, x, y, seat_table, spare, suite.targets['mtt_race'], 100)[name]
    suite.ctrl.ok('SELECT pg_advisory_lock(%s)' % gate_lock(gate))
    a = suite.door_session(door, 'mid')
    a.ok("SET concurrency.pause_at = %s" % q(gate))
    a.send(door.sql)
    suite.prove_waits(a, [suite.ctrl], 'race-mid-door')
    whole = transfer(x, z, start, 'race-whole-' + rid()[:20])
    b = suite.door_session(whole, 'whole')
    b.send(whole.sql)
    event = suite.prove_waits(b, [a], 'race-mid-door')
    suite.ctrl.ok('SELECT pg_advisory_unlock(%s)' % gate_lock(gate))
    ra, rb = suite.result(a.wait()), suite.result(b.wait())
    label = '%s paused at its %s write' % (name, gate)
    suite.check(succeeded(door, ra), '%s: it completes once released' % label, ra)
    suite.check(rb.get('code') == 'insufficient_transferable_diamonds',
                '%s: a transfer of the whole %d arriving meanwhile waited on it (%s lock) and was refused by name '
                'on the balance it left, never on the balance it read' % (label, start, event), rb)
    suite.check(suite.wallet(x) == start - amount, '%s: the wallet ends at exactly %d' % (label, start - amount))
    suite.invariants('race ' + label)
    suite.close_all()
    suite.evidence['cases'].append({'group': 'race', 'case': label, 'wait': event})


def race_buyin_meets_registration(suite, table_name):
    """One player's registration paused inside the reserve while the same player's cash buy-in
    arrives. Both take the player's table-cap lock and the player's wallet; unless they take them
    in one order, one of them dies of a deadlock."""
    x, = suite.players(1)
    table, seat = suite.seat(table_name)
    reg = register(x, suite.targets['mtt_race'], rid())
    buy = buyin(x, table, seat, 200, rid())
    suite.ctrl.ok('SELECT pg_advisory_lock(%s)' % gate_lock('custody'))
    a = suite.door_session(reg, 'meet')
    a.ok("SET concurrency.pause_at = 'custody'")
    a.send(reg.sql)
    suite.prove_waits(a, [suite.ctrl], 'race-buyin-registration')
    b = suite.door_session(buy, 'meet')
    b.send(buy.sql)
    event = suite.prove_waits(b, [a], 'race-buyin-registration')
    suite.ctrl.ok('SELECT pg_advisory_unlock(%s)' % gate_lock('custody'))
    ra, rb = suite.result(a.wait()), suite.result(b.wait())
    label = 'a registration paused inside its reserve meets the same player\'s cash buy-in'
    suite.check(ra.get('ok') is True and 'error' not in rb,
                '%s: the buy-in waited on it (%s lock), then both completed - no deadlock' % (label, event), (ra, rb))
    suite.check(suite.wallet(x) == 500 - 25 - 200, '%s: the wallet ends at exactly 275' % label, suite.wallet(x))
    suite.invariants('race ' + label)
    suite.close_all()
    suite.evidence['cases'].append({'group': 'race', 'case': 'buy-in meets registration', 'wait': event})


def race_chip_entry_meets(suite, what):
    """One player's CHIP registration paused as its roster row goes in - after its seat
    acquisition locked the player's profile row, before the roster trigger takes the
    player's table-cap lock - while the same player's Diamond registration or Diamond
    cash buy-in arrives. Every seat door takes the table cap and the profile row; the
    order has to be one across both assets, or one of the two dies of a deadlock."""
    x = player(0xc7 if what == 'registration' else 0xc8)   # joined the chip club in the seed
    start = suite.wallet(x)
    chip = register(x, suite.targets['mtt_chip'], rid())
    if what == 'registration':
        other, cost = register(x, suite.targets['mtt_race'], rid()), 25
    else:
        table, seat = suite.seat()
        other, cost = buyin(x, table, seat, 200, rid()), 200
    suite.ctrl.ok('SELECT pg_advisory_lock(%s)' % gate_lock('roster_entry'))
    a = suite.door_session(chip, 'chip')
    a.ok("SET concurrency.pause_at = 'roster_entry'")
    a.send(chip.sql)
    suite.prove_waits(a, [suite.ctrl], 'race-chip-entry')
    b = suite.door_session(other, 'meet')
    b.send(other.sql)
    event = suite.prove_waits(b, [a], 'race-chip-entry')
    suite.ctrl.ok('SELECT pg_advisory_unlock(%s)' % gate_lock('roster_entry'))
    ra, rb = suite.result(a.wait()), suite.result(b.wait())
    label = "a chip registration paused at its roster entry meets the same player's Diamond %s" % what
    suite.check(ra.get('ok') is True and ra.get('asset') == 'chips' and succeeded(other, rb),
                '%s: the Diamond door waited on it (%s lock), then both completed - no deadlock' % (label, event),
                (ra, rb))
    suite.check(suite.wallet(x) == start - cost, '%s: the wallet ends at exactly %d' % (label, start - cost),
                suite.wallet(x))
    suite.invariants('race ' + label)
    suite.close_all()
    suite.evidence['cases'].append({'group': 'race', 'case': 'chip registration meets Diamond ' + what,
                                    'wait': event})


def run_race(suite):
    t = suite.targets
    tid = t['mtt_race']
    race_ordered(suite, ['transfer', 'purchase', 'buy-in', 'top-up', 'register'], ('cash_1', 'cash_2'), tid)
    race_ordered(suite, ['register', 'top-up', 'buy-in', 'purchase', 'transfer'], ('cash_3', 'cash_4'), tid)
    race_ordered(suite, ['buy-in', 'transfer', 'register', 'purchase', 'top-up'], ('cash_5', 'cash_6'), tid)
    for rep in range(1, 5):
        race_barrier(suite, rep, ('cash_%d' % (6 + rep), 'cash_%d' % (10 + rep)), tid)
    race_crossing(suite, suite.seat('cash_15'))
    n = int(suite.ctrl.ok('SELECT concurrency_fixture.install_gates(true)')[0])
    for name, gate in (('transfer', 'journal'), ('purchase', 'wallet'), ('buy-in', 'custody'),
                       ('top-up', 'journal'), ('register', 'custody')):
        race_mid_door(suite, name, gate, ('cash_15', 'cash_16'))
    race_buyin_meets_registration(suite, 'cash_16')
    race_chip_entry_meets(suite, 'registration')
    race_chip_entry_meets(suite, 'buy-in')
    suite.ctrl.ok('SELECT concurrency_fixture.install_gates(false)')


# ---------------------------------------------------------------------------
# REPLAY: the same request id delivered twice - concurrently, after a rolled
# back first attempt, and sequentially - to every money door.
# ---------------------------------------------------------------------------
def delta(before, after):
    """What moved between two money documents: wallet changes and row-count changes."""
    out = {}
    for u, v in after['wallets'].items():
        if v != before['wallets'].get(u):
            out['wallet:' + u[-2:]] = v - before['wallets'][u]
    for k in ('custody', 'custody_rows', 'journal_rows', 'movements', 'ledger_rows', 'transfers', 'purchases',
              'grants', 'live_seats', 'seat_rows', 'cashout_receipts', 'credit_keys', 'entry_receipts'):
        if after[k] != before[k]:
            out[k] = after[k] - before[k]
    if after['roster'] != before['roster']:
        out['roster'] = 'changed'
    return out


class Replayable:
    """One door, prepared so the same request can be delivered again and again.

    prepare() builds a fresh scene and returns (door, users, expected one-effect delta, receipt reader,
    a door with the same request id and a different payload, and the names that refusal may carry)."""

    def __init__(self, name, prepare, same_reply, mismatch_names):
        self.name, self.prepare, self.same_reply, self.mismatch_names = name, prepare, same_reply, mismatch_names


def prep_transfer(suite):
    x, y = suite.players(2)
    ref = 'replay-transfer-' + rid()[:20]
    return (transfer(x, y, 120, ref), [x, y], {'wallet:' + x[-2:]: -120, 'wallet:' + y[-2:]: 120,
                                                'journal_rows': 2, 'transfers': 1},
            None, transfer(x, y, 121, ref))


def prep_purchase(suite):
    x, = suite.players(1)
    req = rid()
    return (purchase(x, GOLD[0], req), [x], {'wallet:' + x[-2:]: -150, 'journal_rows': 1, 'purchases': 1, 'grants': 1},
            None, purchase(x, 'card_back_dragon', req))


def prep_buyin(suite):
    x, = suite.players(1)
    table, seat = suite.seat()
    key = rid()
    d = buyin(x, table, seat, 120, key)
    return (d, [x], {'wallet:' + x[-2:]: -120, 'custody': 120, 'custody_rows': 1, 'journal_rows': 1, 'movements': 1,
                     'live_seats': 1, 'seat_rows': 1, 'entry_receipts': 1},
            d.receipt, buyin(x, table, seat, 121, key))


def prep_topup(suite):
    x, = suite.players(1)
    table, seat = suite.seat()
    seat_player(suite, x, table, seat, 100)
    req = rid()
    return (topup(x, table, 60, 100, req), [x], {'wallet:' + x[-2:]: -60, 'custody': 60, 'journal_rows': 1, 'movements': 1},
            None, topup(x, table, 61, 100, req))


def prep_cashout(suite):
    x, = suite.players(1)
    table, seat = suite.seat()
    occ = seat_player(suite, x, table, seat, 140)
    return (cashout(x, table, seat, occ), [x], {'wallet:' + x[-2:]: 140, 'custody': -140, 'journal_rows': 1,
                                                'movements': 1, 'live_seats': -1, 'cashout_receipts': 1},
            None, cashout(x, table, seat + 1 if seat < 6 else seat - 1, occ))


def prep_register(suite, tournament='mtt_replay'):
    x, = suite.players(1)
    req = rid()
    tid = suite.targets[tournament]
    return (register(x, tid, req), [x], {'wallet:' + x[-2:]: -25, 'custody': 25, 'custody_rows': 1, 'journal_rows': 1,
                                         'movements': 1, 'ledger_rows': 1, 'roster': 'changed', 'entry_receipts': 1},
            None, register(x, suite.targets['mtt_reg'], req))


def prep_unregister(suite):
    x, = suite.players(1)
    tid = suite.targets['mtt_replay']
    s = suite.session('prereg_%d' % len(suite.sessions), client_context(x))
    r = suite.result(s.step(register(x, tid, rid()).sql))
    r2 = suite.result(s.step(register(x, suite.targets['mtt_reg'], rid()).sql))
    s.close()
    suite.check(r.get('ok') is True and r2.get('ok') is True,
                'a client registers in two Diamond MTTs through fn_register_for_tournament_request', (r, r2))
    req = rid()
    return (unregister(x, tid, req), [x], {'wallet:' + x[-2:]: 25, 'custody': -25, 'journal_rows': 1, 'movements': 1,
                                           'ledger_rows': 1, 'roster': 'changed'},
            None, unregister(x, suite.targets['mtt_reg'], req))


def prep_rebuy(suite):
    x, = suite.players(1)
    tid = suite.targets['mtt_rebuy']
    s = suite.session('prereg_%d' % len(suite.sessions), client_context(x))
    r = suite.result(s.step(register(x, tid, rid()).sql))
    s.close()
    suite.check(r.get('ok') is True, 'a client registers in the rebuy MTT', r)
    token = 'replay-rebuy-' + rid()[:12]
    return (rebuy(x, tid, token), [x], {'wallet:' + x[-2:]: -25, 'custody': 25, 'journal_rows': 1, 'movements': 1,
                                        'ledger_rows': 1, 'roster': 'changed', 'credit_keys': 1},
            None, rebuy(x, tid, token, 26))


PAY_ENTRANTS = []


def prep_payout(suite):
    tid = suite.targets['mtt_pay']
    if not PAY_ENTRANTS:
        for u in suite.players(6):
            s = suite.session('payreg_%d' % len(suite.sessions), client_context(u))
            r = suite.result(s.step(register(u, tid, rid()).sql))
            s.close()
            suite.check(r.get('ok') is True, 'a client registers in the payout MTT', r)
            PAY_ENTRANTS.append(u)
    payee = PAY_ENTRANTS[0]
    key = 'replay-pay-' + rid()
    return (payout(payee, tid, 7, key), list(PAY_ENTRANTS),
            {'wallet:' + payee[-2:]: 7, 'custody': -7, 'journal_rows': 1, 'ledger_rows': 1, 'credit_keys': 1},
            None, payout(payee, tid, 8, key))


# Every Diamond money door answers a retry with its first receipt, word for word,
# and refuses the same request id with a different payload by name (decided by
# Claude on Dan's delegation of 2026-09-30; 20260930235000). The rebuy money core
# is the one exception to the first rule, and not a door: it is shared with chips
# and reached only through process_tournament_rebuy, which answers a retry with
# its stored first receipt before the core is reached and refuses the core's
# "already charged" answer by name.
REPLAYABLE = [
    Replayable('transfer', prep_transfer, True, ['idempotency_payload_mismatch']),
    Replayable('purchase', prep_purchase, True, ['REQUEST_ID_REUSED']),
    Replayable('buy-in', prep_buyin, True, ['IDEMPOTENCY_KEY_REUSED']),
    Replayable('top-up', prep_topup, True, ['idempotency_payload_mismatch']),
    Replayable('cash-out', prep_cashout, True, ['CASHOUT_OCCUPANCY_SCOPE_MISMATCH']),
    Replayable('register', prep_register, True, ['IDEMPOTENCY_KEY_REUSED']),
    Replayable('unregister', prep_unregister, True, ['idempotency_payload_mismatch']),
    Replayable('rebuy', prep_rebuy, False, ['Price mismatch']),
    Replayable('payout', prep_payout, True, ['diamond_tournament_pay_key_reused']),
]


def settle_delta(got, want):
    """The one-effect delta, allowing movements the door may add beyond the ones named (drains)."""
    for k, v in want.items():
        if got.get(k) != v:
            return False
    return all(k in want or k == 'movements' for k in got)


DONORS = {}


def move_wallet(suite, spec, uid, label):
    """Move the caller's wallet between deliveries - a transfer in from a donor, through the
    real transfer door - so a retry that rebuilt its receipt from the wallet as it stands
    would answer differently from the first delivery."""
    if spec.name not in DONORS:
        DONORS[spec.name] = suite.players(1)[0]
    donor = DONORS[spec.name]
    before = suite.wallet(uid)
    s = suite.session('donor_%d' % len(suite.sessions), client_context(donor))
    r = suite.result(s.step(transfer(donor, uid, 11, 'replay-move-' + rid()[:20]).sql))
    s.close()
    suite.check(r.get('success') is True and suite.wallet(uid) == before + 11,
                "%s: the caller's wallet moved between deliveries (a transfer of 11 in)" % label, r)


def durable(suite, spec, door):
    if door.receipt is None:
        return None
    s = suite.session('receipt_%d' % len(suite.sessions), door.context)
    r = s.ok(door.receipt)
    s.close()
    return r


def replay_variant(suite, spec, variant):
    door, users, want, _, other = spec.prepare(suite)
    before = suite.money(users)
    a, b = suite.door_session(door, 'a'), suite.door_session(door, 'b')
    label = '%s delivered twice %s' % (spec.name, variant)
    if variant == 'concurrently':
        a.ok('BEGIN')
        ra = suite.result(a.step(door.sql))
        b.send(door.sql)
        event = suite.prove_waits(b, [a], 'replay-' + spec.name)
        a.ok('COMMIT')
        rb = suite.result(b.wait())
        suite.check('error' not in ra and 'error' not in rb,
                    '%s: the second delivery waited on the first (%s lock) and neither was refused' % (label, event), (ra, rb))
    elif variant == 'after a rolled-back first attempt':
        a.ok('BEGIN')
        ra = suite.result(a.step(door.sql))
        b.send(door.sql)
        event = suite.prove_waits(b, [a], 'replay-' + spec.name)
        a.ok('ROLLBACK')
        rb = suite.result(b.wait())
        suite.check('error' not in rb, '%s: the waiting delivery completed the request itself once the first rolled back'
                    % label, rb)
        ra = rb
    else:
        ra = suite.result(a.step(door.sql))
        rb = suite.result(b.step(door.sql))
        suite.check('error' not in ra and 'error' not in rb, '%s: both deliveries answered' % label, (ra, rb))
    after = suite.money(users)
    got = delta(before, after)
    suite.check(settle_delta(got, want), '%s: exactly one effect (%s)' % (
        label, ', '.join('%s %+d' % (k, v) if isinstance(v, int) else k for k, v in sorted(want.items()))), got)
    move_wallet(suite, spec, door.actor, label)
    after = suite.money(users)
    third = suite.result(b.step(door.sql))
    suite.check(suite.money(users) == after, "%s: a third delivery, after the caller's wallet moved, moves nothing"
                % label, third)
    if variant == 'after a rolled-back first attempt':
        first, replays = rb, [third]
    else:
        first, replays = ra, [rb, third]
    if spec.same_reply:
        suite.check('error' not in first and all(r == first for r in replays),
                    "%s: every retry answers the first receipt word for word, with no replay marker, even after the "
                    "caller's wallet moved" % label, [first] + replays)
    if spec.name == 'purchase':
        stored = json.loads(suite.ctrl.ok("SELECT result FROM public.digital_purchase_receipts WHERE user_id=%s"
                                          % q(users[0]))[0])
        suite.check(first.get('granted') is True and first.get('cost') == 150 and stored == first,
                    '%s: the first answer is the stored receipt - one debit of 150, one grant' % label, (first, stored))
    elif spec.name == 'payout':
        suite.check(first.get('value') == 't', '%s: the payer answers every delivery of the payment true' % label, first)
    elif spec.name == 'rebuy':
        suite.check(first.get('chips_added') == 10000 and first.get('idempotent') is None
                    and all(r.get('idempotent') is True and r.get('success') is True for r in replays),
                    '%s: the money core charges once and answers every replay "already charged" (idempotent); the '
                    'public door process_tournament_rebuy answers a retry with its stored first receipt before it '
                    'reaches the core, and refuses that answer by name' % label, (first, replays))
    if door.receipt and spec.name == 'buy-in':
        r1, r2 = durable(suite, spec, door), durable(suite, spec, door)
        suite.check(r1 == r2 and r1 and '"confirmed"' in r1[0],
                    '%s: the player reads the buy-in receipt back as confirmed, identically, every time' % label, (r1, r2))
    if other is not None:
        ro = suite.result(b.step(other.sql))
        suite.check(suite.refusal(other, ro, spec.mismatch_names) and suite.money(users) == after,
                    '%s: the same request id with a different payload is refused by name (%s) and moves nothing'
                    % (label, ro.get('error', ro)[:80] if isinstance(ro.get('error', ro), str) else ro), ro)
    suite.invariants(label)
    suite.close_all()
    suite.evidence['cases'].append({'group': 'replay', 'door': spec.name, 'variant': variant, 'delta': got,
                                    'same_reply': ra == rb})


def run_replay(suite):
    for spec in REPLAYABLE:
        for variant in ('concurrently', 'after a rolled-back first attempt', 'sequentially'):
            replay_variant(suite, spec, variant)


# ---------------------------------------------------------------------------
# RECOVERY: a session killed mid-transaction at every point a door writes.
# ---------------------------------------------------------------------------
PREPARE = {spec.name: spec for spec in REPLAYABLE}


def gate_lock(gate):
    return "hashtext('concurrency-gate:' || %s)" % q(gate)


def trace_gates(suite, name):
    """The write points one door passes, in order (a development aid and the drift check)."""
    door, users, want, _, _ = PREPARE[name].prepare(suite)
    s = suite.door_session(door, 'trace')
    s.ok("SET concurrency.trace = 'on'")
    res = suite.result(s.step(door.sql))
    order = []
    for n in s.notices:
        g = n.split('GATE', 1)[-1].strip()
        if g not in order:
            order.append(g)
    suite.close_all()
    return order, res


def kill_at(suite, name, gate):
    spec = PREPARE[name]
    door, users, want, _, _ = spec.prepare(suite)
    before = suite.money(users)
    label = '%s killed at %s' % (name, gate)
    suite.ctrl.ok('SELECT pg_advisory_lock(%s)' % gate_lock(gate))
    v = suite.door_session(door, 'victim')
    v.ok("SET concurrency.pause_at = %s" % q(gate))
    v.send(door.sql)
    suite.prove_waits(v, [suite.ctrl], 'recovery-gate')
    killed = suite.ctrl.ok('SELECT pg_terminate_backend(%d)' % v.pid)
    try:
        v.p.wait(timeout=15)
    except subprocess.TimeoutExpired:
        raise Failure('FAIL: %s - the killed session did not end' % label)
    suite.sessions.remove(v)
    gone = suite.ctrl.ok('SELECT count(*) FROM pg_stat_activity WHERE pid=%d' % v.pid)
    suite.ctrl.ok('SELECT pg_advisory_unlock(%s)' % gate_lock(gate))
    suite.check(killed == ['t'] and gone == ['0'],
                '%s: the controller terminated the session while it was paused inside the door' % label, (killed, gone))
    suite.check(suite.money(users) == before,
                '%s: nothing moved - no wallet, custody, journal, movement, ledger, seat or receipt row survived' % label,
                delta(before, suite.money(users)))
    suite.invariants(label)
    r = suite.door_session(door, 'retry')
    first = suite.result(r.step(door.sql))
    after = suite.money(users)
    got = delta(before, after)
    suite.check('error' not in first and settle_delta(got, want),
                '%s: the retry of the same request completes exactly once' % label, (first, got))
    again = suite.result(r.step(door.sql))
    suite.check(suite.money(users) == after and (not spec.same_reply or again == first),
                '%s: and a second retry moves nothing%s' % (label, ' and answers the same receipt' if spec.same_reply else ''),
                (first, again))
    suite.invariants(label + ' and retried')
    suite.close_all()
    suite.evidence['cases'].append({'group': 'recovery', 'door': name, 'killed_at': gate, 'retry_delta': got})


# Every write point each door passes, in the order it passes them (traced once per
# run; a door that grows or loses a write point fails the trace check first).
KILL_POINTS = {
    'transfer': ['journal', 'wallet', 'transfer_row'],
    'purchase': ['wallet', 'journal', 'grant', 'purchase_row'],
    'buy-in': ['claim', 'custody', 'journal', 'wallet', 'movement', 'custody_update', 'seat', 'receipt'],
    'top-up': ['journal', 'wallet', 'custody_update', 'seat_update', 'movement'],
    'cash-out': ['seat_update', 'wallet', 'journal', 'custody_update', 'movement', 'cashout_receipt'],
    'register': ['claim', 'custody', 'journal', 'wallet', 'movement', 'custody_update', 'ledger', 'roster_entry', 'roster',
                 'receipt'],
    'unregister': ['wallet', 'journal', 'custody_update', 'movement', 'ledger'],
    'rebuy': ['credit_key', 'journal', 'wallet', 'custody_update', 'movement', 'ledger', 'roster_update'],
    'payout': ['credit_key', 'wallet', 'journal', 'movement', 'custody_update', 'ledger'],
}


def run_recovery(suite, gates_by_door=KILL_POINTS):
    n = int(suite.ctrl.ok('SELECT concurrency_fixture.install_gates(true)')[0])
    suite.check(n >= 17, 'the pause gates are installed on the %d write points the money doors pass' % n)
    for name, gates in gates_by_door.items():
        order, _ = trace_gates(suite, name)
        suite.check(order == gates, '%s passes its write points in the order the cases expect: %s'
                    % (name, ' -> '.join(gates)), order)
        for gate in gates:
            kill_at(suite, name, gate)
    suite.ctrl.ok('SELECT concurrency_fixture.install_gates(false)')


# ---------------------------------------------------------------------------
# CRASH: the whole cluster stopped in immediate mode in the middle of a
# workload, restarted, recovered from its WAL, and every request retried.
# ---------------------------------------------------------------------------
def add_delta(total, want):
    for k, v in want.items():
        if v == 'changed':
            total[k] = 'changed'
        else:
            total[k] = total.get(k, 0) + v
    return {k: v for k, v in total.items() if v != 0}


def run_crash(suite):
    n = int(suite.ctrl.ok('SELECT concurrency_fixture.install_gates(true)')[0])
    order = ['transfer', 'purchase', 'buy-in', 'top-up', 'cash-out', 'register', 'unregister', 'rebuy', 'payout']
    requests = []      # (label, name, door, users, want, state)
    for name in order:                                  # committed before the crash; the answer is "lost"
        door, users, want, _, _ = PREPARE[name].prepare(suite)
        pre = suite.money(users)
        s = suite.door_session(door, 'committed')
        res = suite.result(s.step(door.sql))
        suite.check('error' not in res and settle_delta(delta(pre, suite.money(users)), want),
                    'crash workload: %s committed before the crash, exactly once' % name, res)
        requests.append(('%s committed' % name, name, door, users, want, 'committed'))
    paused = []
    for name in order:                                  # paused mid-door, holding its locks
        door, users, want, _, _ = PREPARE[name].prepare(suite)
        gate = KILL_POINTS[name][len(KILL_POINTS[name]) // 2]
        suite.ctrl.ok('SELECT pg_advisory_lock(%s)' % gate_lock(gate + ':' + name))
        requests.append(('%s paused at %s' % (name, gate), name, door, users, want, 'in_flight'))
        paused.append((name, gate, door))
    victims = []
    for name, gate, door in paused:
        v = suite.door_session(door, 'inflight')
        v.ok("SET concurrency.pause_at = %s" % q(gate))
        v.ok("SET concurrency.pause_lock = %s" % q(gate + ':' + name))
        v.send(door.sql)
        victims.append((name, v, door))
    # Each victim waits either on its own gate (held by the controller) or behind another
    # victim that holds a lock it needs (two doors on one table share the seat lock).
    for name, v, door in victims:
        suite.prove_waits(v, [suite.ctrl] + [o for _, o, _ in victims if o is not v], 'crash-paused')
    queued = []
    for name, v, door in victims[:4]:                   # the same request again, waiting behind the paused one
        w = suite.door_session(door, 'queued')
        w.send(door.sql)
        suite.prove_waits(w, [v], 'crash-queued')
        queued.append(w)
    held = []
    for name in ('transfer', 'register'):               # done, but never committed
        # (the held registration is in an event of its own: registrations into one
        # event serialize, and the paused one above would hold this one back)
        door, users, want, _, _ = (prep_register(suite, 'mtt_crash') if name == 'register'
                                   else PREPARE[name].prepare(suite))
        h = suite.door_session(door, 'held')
        h.ok('BEGIN')
        res = suite.result(h.step(door.sql))
        suite.check('error' not in res, 'crash workload: %s answered inside a transaction that never commits' % name, res)
        requests.append(('%s held uncommitted' % name, name, door, users, want, 'held'))
        held.append(h)
    groups = {}
    for label, name, door, users, want, state in requests:
        groups.setdefault(tuple(sorted(users)), []).append((label, name, door, users, want, state))
    before = {}
    for key, reqs in groups.items():
        base = suite.money(list(key))
        before[key] = base
    # Nothing uncommitted is visible yet; what the controller reads now is the committed state.
    committed_state = {key: suite.money(list(key)) for key in groups}

    started = time.monotonic()
    suite.cluster.stop('immediate')
    stopped = time.monotonic()
    for s in list(suite.sessions):              # every client lost its server
        try:
            s.p.stdin.close()
        except OSError:
            pass
        try:
            s.p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            s.p.kill()
    suite.sessions = []
    suite.cluster.start()
    recovered = time.monotonic()
    log = suite.cluster.log.read_text(errors='replace')
    suite.check('database system was interrupted' in log or 'was not properly shut down' in log,
                'the cluster stopped in immediate mode with %d paused doors, %d queued duplicates and %d open transactions, '
                'and restarted through WAL crash recovery (%.1fs)' % (len(victims), len(queued), len(held),
                                                                     recovered - stopped))
    suite.ctrl = suite.session('controller')
    for key, reqs in groups.items():
        want_after_crash = {}
        for label, name, door, users, want, state in reqs:
            if state == 'committed':
                want_after_crash = add_delta(want_after_crash, want)
        # The groups were measured after their committed requests, so recovery must leave them exactly there.
        got = delta(committed_state[key], suite.money(list(key)))
        suite.check(got == {}, 'after recovery: %s - every committed effect survived and nothing uncommitted appeared'
                    % ', '.join(r[0] for r in reqs), got)
    suite.invariants('after crash recovery')
    stale = suite.ctrl.ok('SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE %s' % q('%_inflight_%'))
    suite.check(stale == ['0'], 'after recovery no paused door is still running')
    suite.ctrl.ok('SELECT concurrency_fixture.install_gates(false)')
    # Every request retried twice: committed ones move nothing, the rest complete exactly once.
    for key, reqs in groups.items():
        start = suite.money(list(key))
        expect = {}
        for label, name, door, users, want, state in reqs:
            if state != 'committed':
                expect = add_delta(expect, want)
        for label, name, door, users, want, state in reqs:
            r = suite.door_session(door, 'after')
            res = suite.result(r.step(door.sql))
            suite.check('error' not in res, 'after recovery the retry of %s is answered' % label, res)
        mid = suite.money(list(key))
        got = delta(start, mid)
        suite.check(settle_delta(got, expect) if expect else got == {},
                    'after recovery: retrying %s completes each unfinished request exactly once and repeats nothing'
                    % ', '.join(r[0] for r in reqs), (got, expect))
        for label, name, door, users, want, state in reqs:
            r = suite.door_session(door, 'again')
            suite.result(r.step(door.sql))
        suite.check(suite.money(list(key)) == mid, 'after recovery: a second retry of %s moves nothing'
                    % ', '.join(r[0] for r in reqs))
        suite.close_all()
    suite.invariants('after crash recovery and every retry')
    suite.evidence['cases'].append({'group': 'crash', 'paused': [p[0] + '@' + p[1] for p in paused],
                                    'queued': len(queued), 'held': len(held),
                                    'stop_to_ready_seconds': round(recovered - stopped, 2)})


# ---------------------------------------------------------------------------
# What ran: every function the cases executed must be production's text.
# ---------------------------------------------------------------------------
def collect_executed(suite):
    """Record every estate function the finished sessions executed.

    pg_stat_user_functions with track_functions=all counts every PL/pgSQL and
    SQL function call (a SQL function the planner inlines is not counted, and
    its text is part of the caller's plan).  Only the schemas the captures come
    from are recorded: realtime.send and the extensions/pg_catalog helpers are
    the platform's, loaded by the base, and not Diamond doors."""
    suite.close_all()
    time.sleep(0.5)
    rows = suite.ctrl.ok("SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) "
                         "|| ')|' || md5(pg_get_functiondef(p.oid)) FROM pg_stat_user_functions f "
                         "JOIN pg_proc p ON p.oid = f.funcid JOIN pg_namespace n ON n.oid = p.pronamespace "
                         "WHERE n.nspname IN ('public', 'smarter_private') AND f.calls > 0")
    for row in rows:
        ident, md5 = row.rsplit('|', 1)
        suite.executed[ident] = md5


def check_executed(suite):
    pins = json.loads((SQL / 'diamond-concurrency-doors.manifest.json').read_text()).get('executed_pins', {})
    unpinned = sorted(i for i in suite.executed if i not in pins)
    moved = sorted(i for i in suite.executed if i in pins and pins[i] != suite.executed[i])
    suite.check(not unpinned and not moved,
                'the cases executed %d functions and every one is the exact text production ran when this capture was '
                'taken (md5 of pg_get_functiondef pinned per function)' % len(suite.executed),
                {'not compared with production': unpinned[:20], 'text differs from its pin': moved[:20]})


def run_cases(cluster, list_executed=False):
    suite = Suite(cluster)
    suite.executed = {}
    suite.ctrl.ok('SELECT pg_stat_reset()')
    try:
        suite.invariants('the scene')
        run_race(suite)
        run_replay(suite)
        run_recovery(suite)
        collect_executed(suite)          # crash recovery resets the statistics, so read them first
        run_crash(suite)
        collect_executed(suite)
        if list_executed:
            print('EXECUTED ' + json.dumps(suite.executed, sort_keys=True), flush=True)
        check_executed(suite)
        gates = suite.ctrl.ok("SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'zzzzzzzz_concurrency_gate_%' "
                              "OR tgname LIKE 'trg_d_concurrency_gate_%'")
        suite.check(gates == ['0'], 'no pause gate is left on any table')
        ev = suite.evidence
        ev['refusals'] = {k: sorted(v) for k, v in ev['refusals'].items()}
        ev['waits'] = {k: sorted(set(v)) for k, v in ev['waits'].items()}
        print('EVIDENCE ' + json.dumps(ev, sort_keys=True), flush=True)
        print('%d %s' % (suite.passed, PROOF), flush=True)
    finally:
        for s in list(suite.sessions):
            s.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bindir')
    ap.add_argument('--keep', action='store_true')
    ap.add_argument('--load-only', action='store_true')
    ap.add_argument('--until')
    ap.add_argument('--list-executed', action='store_true')
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
        run_cases(cluster, args.list_executed)
    finally:
        if cluster.running and not args.keep:
            cluster.stop('immediate')
        if not args.keep:
            shutil.rmtree(cluster.root, ignore_errors=True)
        else:
            print('kept cluster at ' + str(cluster.root), flush=True)



if __name__ == '__main__':
    main()
