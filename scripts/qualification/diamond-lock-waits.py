#!/usr/bin/env python3
"""Diamond Phase 11 line 5: lock waits on the Diamond custody and ledger rows under
concurrent hand settlements and buy-in / cash-out wallet movements.

    python3 scripts/qualification/diamond-lock-waits.py --work <empty dir on a big disk> [--quick]

Production cannot show this without risk (the Diamond tables are idle and the arena switches
are Dan's), so this builds its OWN PostgreSQL 17 cluster inside --work: a unix socket in a
private directory, listen_addresses empty (no TCP listener at all), fsync and synchronous
commit left on. The fixture guards require port 55472, which here is only the name of a socket
file in that private directory. It reads PG_BIN from the environment and nothing else: there is
no variable that could point it at a real database.

What runs is the estate's own isolated fixture (tests/sql, loaded exactly as
tests/sql/run-diamond-accepted-hand.py loads it) with the LIVE Diamond doors laid over it:
diamond-lock-waits-live-doors.sql was captured read-only from production, and the run refuses
to measure unless md5(pg_get_functiondef(...)) of every loaded door equals production's. Then
diamond-lock-waits-setup.sql seats players at K tables through the live reserve door, and
pgbench drives:
  settle  - one hand at one table: the shared settlement lane, then fn_poker_diamond_settle_cash_hand
            (table row, every player's wallet row, seats, custody, purchase lots, receipt) and the
            deferred seat-custody guard at commit. Each client owns its own tables, as one engine
            owns a table, so the only contention is the contention a real fleet would have: the
            same players at several tables, and wallet movements beside the hands.
  churn   - the wallet legs of a buy-in and a cash-out: fn_poker_diamond_reserve at a table the
            player is not seated at, then fn_poker_diamond_release.
Every wait of 10 ms or more is written to the cluster log by log_lock_waits
(deadlock_timeout=10ms) and parsed; pg_locks is also sampled every 50 ms.
"""
import argparse, json, os, pathlib, re, shutil, subprocess, threading, time

ROOT = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).resolve().parent
SQL_DIR = ROOT / 'tests/sql'
PG_BIN = os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')
DB = 'poker_diamond_phase6_accepted_test'
PORT = '55472'
LIVE_MD5 = {
    'fn_poker_diamond_settle_cash_hand': '3aab9170062e97840afc7d15999691ad',
    'fn_poker_diamond_reserve': 'cf2150429728d8d796711e9bdbb22f51',
    'fn_poker_diamond_release': 'd525cb1e20d6fb05e5b5e51497b127e7',
    'fn_poker_diamond_seat_keeps_custody': 'd80aed613a97e567268cb2bf6fdfd094',
    'fn_ca_share_settlement_lane_for_table': '409b14ee72ce888d3b26524c52d49a68',
    'fn_poker_diamond_cash_variant': '929c207a922004eb0e764011a2fe386c',
    'fn_poker_diamond_plain_cash_table': '94fb4dd7359850d388262de813c0caf1',
    'fn_poker_diamond_top_up': 'fe1cf0ce225ef0977ceef3dd8bfb4598',
}
# The top-up took the wallet before the table; every other Diamond cash door (the hand settler,
# the buy-in, the cash-out) takes the table and then the wallet. The migration
# 20260930130000_a_diamond_top_up_takes_the_table_before_the_wallet makes exactly this
# substitution; the harness makes it too, locally, and proves the text is the migration's.
TOP_UP_OLD = (" PERFORM pg_advisory_xact_lock(hashtextextended('table_seat:'||p_table_id,0));\n"
              " -- Wallet first, exactly as the reserve and the hand settler take it.\n"
              " SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=p_user_id FOR UPDATE;\n")
TOP_UP_NEW = (" PERFORM pg_advisory_xact_lock(hashtextextended('table_seat:'||p_table_id,0));\n"
              " -- The table row before the wallet. The hand settler, the buy-in and the cash-out\n"
              " -- all take this table and then the wallet; a top-up that took the wallet first\n"
              " -- deadlocked against the settlement of the hand it followed (Diamond Phase 11\n"
              " -- line 5, measured). Locked bare, so every refusal and replay below answers as\n"
              " -- it did: only the order in which the locks are taken changes.\n"
              " PERFORM 1 FROM public.tables WHERE id=p_table_id FOR UPDATE;\n"
              " -- Then the wallet, before its custody and lots, as the reserve and the settler take it.\n"
              " SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=p_user_id FOR UPDATE;\n")


def pct(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, max(0, -(-p * len(xs) // 100) - 1))]


def summary(xs):
    xs = [x for x in xs if x is not None]
    r = lambda v: None if v is None else round(v, 2)
    return {'n': len(xs), 'p50': r(pct(xs, 50)), 'p95': r(pct(xs, 95)), 'p99': r(pct(xs, 99)),
            'max': r(max(xs) if xs else None)}


class Cluster:
    def __init__(self, work):
        self.work = work
        self.data = work / 'pg' / 'data'
        self.sock = work / 'pg' / 's'
        self.log = work / 'pg' / 'postgres.log'

    def tool(self, name):
        return str(pathlib.Path(PG_BIN) / name)

    def start(self):
        env = dict(os.environ, LC_ALL='C', LANG='C')
        if not (self.data / 'PG_VERSION').exists():
            self.sock.mkdir(parents=True, exist_ok=True)
            subprocess.run([self.tool('initdb'), '-D', str(self.data), '-U', 'postgres', '-A', 'trust',
                            '--no-locale', '-E', 'UTF8'], check=True, capture_output=True, env=env)
        opts = ('-p %s -k %s -c listen_addresses= -c max_connections=150 -c shared_buffers=512MB '
                '-c log_lock_waits=on -c deadlock_timeout=10ms -c lc_messages=C '
                "-c log_line_prefix='%%m [%%p] '" % (PORT, self.sock))
        subprocess.run([self.tool('pg_ctl'), '-D', str(self.data), '-l', str(self.log), '-w',
                        '-o', opts, 'start'], check=True, capture_output=True, env=env)

    def stop(self):
        subprocess.run([self.tool('pg_ctl'), '-D', str(self.data), '-m', 'fast', '-w', 'stop'],
                       capture_output=True, env=dict(os.environ, LC_ALL='C'))

    def psql(self, database, *args, cwd=None, timeout=600):
        cmd = [self.tool('psql'), '-X', '-q', '-At', '-U', 'postgres', '-h', str(self.sock), '-p', PORT,
               '-d', database, '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off', *args]
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, timeout=timeout)
        if r.returncode:
            raise RuntimeError(r.stderr[-3000:] + r.stdout[-1000:])
        return r.stdout.strip()

    def q(self, sql):
        return self.psql(DB, '-c', sql)


def build(cl, tables, seats, per_player):
    cl.psql('postgres', '-c', 'DROP DATABASE IF EXISTS %s' % DB)
    cl.psql('postgres', '-c', 'CREATE DATABASE %s' % DB)
    base = (SQL_DIR / 'poker-diamond-custody.sql').read_text()
    base = base.replace('poker_diamond_phase3_test', DB).replace(
        'DROP SCHEMA IF EXISTS public CASCADE;',
        "SET client_min_messages='warning'; DROP SCHEMA IF EXISTS public CASCADE; SET client_min_messages='notice';")
    chain = (base + '\n\\ir poker-diamond-cash-custody-setup.sql\n'
             '\\ir poker-diamond-accepted-hand-schema.sql\n'
             '\\ir poker-diamond-accepted-hand-prerequisites.sql\n'
             '\\ir ../../supabase/migrations/20260910030442_diamond_accepted_hands_retain_history_without_chip_obligatio.sql\n'
             '\\ir poker-diamond-accepted-hand-setup.sql\n')
    tmp = SQL_DIR / ('zz-diamond-lock-waits-%d.sql' % os.getpid())
    tmp.write_text(chain)
    try:
        cl.psql(DB, '-f', str(tmp), cwd=SQL_DIR)
    finally:
        tmp.unlink()
    cl.psql(DB, '-f', str(HERE / 'diamond-lock-waits-schema.sql'))
    cl.psql(DB, '-f', str(HERE / 'diamond-lock-waits-live-doors.sql'))
    got = dict(line.split('|') for line in cl.q(
        "SELECT p.proname, md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n "
        "ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN (%s)"
        % ','.join("'%s'" % k for k in LIVE_MD5)).splitlines())
    if got != LIVE_MD5:
        raise SystemExit('loaded doors are not the live doors: %s' % json.dumps(got, indent=1))
    out = cl.psql(DB, '-v', 'tables=%d' % tables, '-v', 'seats=%d' % seats, '-v', 'per_player=%d' % per_player,
                  '-f', str(HERE / 'diamond-lock-waits-setup.sql'), cwd=HERE)
    return json.loads(out.splitlines()[-1])


def table_first_top_up(cl):
    """Lay the migration's lock order over the live top-up, by the migration's own substitution."""
    body = cl.q("SELECT pg_get_functiondef('public.fn_poker_diamond_top_up(uuid,uuid,numeric,numeric,uuid)'::regprocedure)")
    if body.count(TOP_UP_OLD) != 1:
        raise SystemExit('the live top-up no longer carries the clause this substitution replaces')
    new = body.replace(TOP_UP_OLD, TOP_UP_NEW)
    tmp = HERE / ('zz-top-up-%d.sql' % os.getpid())
    tmp.write_text(new + ';\n')
    try:
        cl.psql(DB, '-f', str(tmp))
    finally:
        tmp.unlink()
    return cl.q("SELECT md5(pg_get_functiondef('public.fn_poker_diamond_top_up(uuid,uuid,numeric,numeric,uuid)'::regprocedure))")


def invariants(cl):
    return json.loads(cl.q(
        "SELECT json_build_object("
        "'seat_stack_total',(SELECT sum(s.stack) FROM table_seats s JOIN perf_tables t ON t.table_id=s.table_id WHERE s.left_at IS NULL),"
        "'custody_total',(SELECT sum(c.balance) FROM poker_diamond_custody c JOIN perf_tables t ON t.table_id=c.target_id WHERE c.state='active'),"
        "'custody_equals_seat',(SELECT bool_and(c.balance=s.stack) FROM poker_diamond_custody c JOIN table_seats s ON s.id=c.seat_id AND s.left_at IS NULL WHERE c.state='active'),"
        "'wallet_total',(SELECT sum(diamonds) FROM profiles p JOIN perf_players pp ON pp.user_id=p.id),"
        "'wallet_plus_custody',(SELECT sum(diamonds) FROM profiles p JOIN perf_players pp ON pp.user_id=p.id)"
        "+(SELECT sum(c.balance) FROM poker_diamond_custody c JOIN perf_tables t ON t.table_id=c.target_id WHERE c.state='active'),"
        "'top_ups',(SELECT count(*) FROM poker_diamond_movements WHERE request->>'action'='top_up'),"
        "'hands',(SELECT count(*) FROM poker_diamond_hand_receipts))"))


def sample_locks(cl, stop, out):
    while not stop.is_set():
        try:
            rows = cl.q("SELECT coalesce(c.relname, l.locktype)||':'||l.mode||'|'||"
                        "round((extract(epoch FROM clock_timestamp()-l.waitstart)*1000)::numeric,1) "
                        "FROM pg_locks l LEFT JOIN pg_class c ON c.oid=l.relation WHERE NOT l.granted")
            out.append([r.split('|') for r in rows.splitlines() if r])
        except Exception:
            pass
        time.sleep(0.05)


WAIT = re.compile(r'\[(\d+)\] LOG:  process \d+ (acquired|still waiting for) (\w+) on (\w+)(?: (.*?))? after ([\d.]+) ms')
CONTEXT_REL = re.compile(r'in relation "(\w+)"')
CONTEXT_FN = re.compile(r'PL/pgSQL function (\w+)\([^)]*\) line (\d+)')


def parse_waits(cl, text):
    """Every wait of 10 ms or more, from log_lock_waits: which row or lock, and which door line waited."""
    rel = dict(line.split('|') for line in cl.q("SELECT oid, relname FROM pg_class WHERE relkind='r'").splitlines())
    records = re.split(r'\n(?=\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)', text)
    pending, durations, still, deadlocks = {}, [], 0, 0
    for i, rec in enumerate(records):
        if 'deadlock detected' in rec:
            deadlocks += 1
        m = WAIT.search(rec)
        if not m:
            continue
        pid, kind, mode, target, rest, ms = m.group(1), m.group(2), m.group(3), m.group(4), m.group(5) or '', float(m.group(6))
        if kind == 'still waiting for':
            still += 1
            context = ' '.join(records[i + 1:i + 3])
            r = CONTEXT_REL.search(context)
            fns = CONTEXT_FN.findall(context)
            where = r.group(1) if r else target
            if target in ('tuple', 'relation') and not r:
                oid = re.search(r'relation (\d+)', ('relation ' + rest) if target == 'relation' else rest)
                where = rel.get(oid.group(1), '?') if oid else '?'
            door = ('%s:%s' % fns[0]) if fns else '?'
            pending[pid] = '%s row (%s on %s) waited in %s' % (where, mode, target, door)
        else:
            durations.append((pending.pop(pid, '(no context) %s on %s' % (mode, target)), ms))
    by = {}
    for where, ms in durations:
        by.setdefault(where, []).append(ms)
    return {'waits_over_10ms': len(durations), 'still_waiting_reports': still, 'deadlocks_logged': deadlocks,
            'wait_ms': summary([ms for _, ms in durations]),
            'by_lock': {k: summary(v) for k, v in sorted(by.items(), key=lambda kv: -len(kv[1]))}}


def run(cl, work, name, clients, tables, players, scripts, seconds):
    per = tables // clients
    files = {'settle': '\\set m random(0, :per - 1)\nSELECT perf_settle(:client_id + :clients * :m);\n',
             'topup': '\\set t random(0, :tables - 1)\nSELECT perf_topup(:t);\n'}
    args = []
    for s, w in scripts:
        f = work / ('%s.sql' % s)
        f.write_text(files[s])
        args += ['-f', '%s@%d' % (f, w)]
    before = json.loads(cl.q("SELECT json_build_object('deadlocks',deadlocks,'rollbacks',xact_rollback,"
                             "'commits',xact_commit) FROM pg_stat_database WHERE datname=current_database()"))
    log_at = cl.log.stat().st_size
    prefix = work / ('pgb-%s' % name)
    for old in work.glob('pgb-%s*' % name):
        old.unlink()
    stop, samples = threading.Event(), []
    th = threading.Thread(target=sample_locks, args=(cl, stop, samples))
    th.start()
    load0 = os.getloadavg()[0]
    r = subprocess.run([cl.tool('pgbench'), '-n', '-U', 'postgres', '-h', str(cl.sock), '-p', PORT,
                        '-c', str(clients), '-j', str(min(clients, 8)), '-T', str(seconds),
                        '-D', 'per=%d' % per, '-D', 'clients=%d' % clients, '-D', 'players=%d' % players,
                        '-D', 'tables=%d' % tables,
                        '--max-tries=5', '--failures-detailed', '-r', '-l', '--log-prefix', str(prefix),
                        *args, DB], capture_output=True, text=True)
    stop.set()
    th.join()
    after = json.loads(cl.q("SELECT json_build_object('deadlocks',deadlocks,'rollbacks',xact_rollback,"
                            "'commits',xact_commit) FROM pg_stat_database WHERE datname=current_database()"))
    with open(cl.log, 'r', errors='replace') as fh:
        fh.seek(log_at)
        waits = parse_waits(cl, fh.read())
    lat, failed_in_log = {}, {}
    for f in work.glob('pgb-%s*' % name):
        for line in f.read_text().splitlines():
            p = line.split()
            if len(p) < 6:
                continue
            if not p[2].isdigit():
                # --failures-detailed writes the failure kind (deadlock, serialization, failed)
                # where a committed transaction writes its latency.
                failed_in_log[p[2]] = failed_in_log.get(p[2], 0) + 1
                continue
            lat.setdefault(scripts[int(p[3])][0], []).append(int(p[2]) / 1000.0)
    tps = re.search(r'tps = ([\d.]+) \(without', r.stdout)
    failed = re.search(r'number of failed transactions: (\d+)', r.stdout)
    retried = re.search(r'number of transactions retried: (\d+)', r.stdout)
    waiting = [len(s) for s in samples]
    worst = [float(x[1]) for s in samples for x in s if len(x) > 1 and x[1] not in ('', None)]
    return {
        'name': name, 'clients': clients, 'tables': tables, 'players': players,
        'scripts': scripts, 'seconds': seconds, 'loadavg_at_start': round(load0, 1),
        'tps': float(tps.group(1)) if tps else None,
        'transactions': sum(len(v) for v in lat.values()),
        'latency_ms': {k: summary(v) for k, v in lat.items()},
        'failed': int(failed.group(1)) if failed else None,
        'failed_in_log': failed_in_log,
        'retried': int(retried.group(1)) if retried else None,
        'pgbench_rc': r.returncode, 'pgbench_tail': r.stdout[-1200:] + r.stderr[-600:],
        'deadlocks': after['deadlocks'] - before['deadlocks'],
        'rollbacks': after['rollbacks'] - before['rollbacks'],
        'lock_waits': waits,
        'pg_locks_samples': len(samples),
        'waiters_per_sample': summary(waiting),
        'waiting_ms_in_samples': summary(worst),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--work', required=True)
    ap.add_argument('--quick', action='store_true')
    ap.add_argument('--out')
    a = ap.parse_args()
    work = pathlib.Path(a.work).resolve()
    work.mkdir(parents=True, exist_ok=True)
    T = 6 if a.quick else 20
    plan = [
        # name, clients, tables, per_player, scripts, seconds, top-up lock order
        ('settle-1-client', 1, 64, 1, [('settle', 1)], T, 'live'),
        ('settle-16-clients-own-players', 16, 64, 1, [('settle', 1)], T, 'live'),
        ('settle-16-clients-4-tables-per-player', 16, 64, 4, [('settle', 1)], T, 'live'),
        ('settle-and-topup-16-clients-live-door', 16, 64, 4, [('settle', 4), ('topup', 1)], T, 'live'),
        ('settle-and-topup-16-clients-table-first', 16, 64, 4, [('settle', 4), ('topup', 1)], T, 'table-first'),
        ('settle-and-topup-48-clients-live-door', 48, 96, 4, [('settle', 4), ('topup', 1)], T, 'live'),
        ('settle-and-topup-48-clients-table-first', 48, 96, 4, [('settle', 4), ('topup', 1)], T, 'table-first'),
    ]
    cl = Cluster(work)
    cl.start()
    results = {'harness': 'scripts/qualification/diamond-lock-waits.py', 'started_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
               'postgres': cl.psql('postgres', '-c', 'SELECT version()'),
               'settings': cl.psql('postgres', '-c', "SELECT string_agg(name||'='||setting, ', ' ORDER BY name) FROM pg_settings WHERE name IN ('fsync','synchronous_commit','shared_buffers','deadlock_timeout','log_lock_waits','max_connections','listen_addresses')"),
               'runs': []}
    try:
        built = None
        for name, clients, tables, per_player, scripts, seconds, order in plan:
            if built != (tables, per_player, order):
                fixture = build(cl, tables, 6, per_player)
                built = (tables, per_player, order)
                fixture['top_up_md5'] = (table_first_top_up(cl) if order == 'table-first'
                                         else LIVE_MD5['fn_poker_diamond_top_up'])
                # One settle per table first: every table has a receipt and warm pages.
                cl.q('SELECT count(perf_settle(idx)) FROM perf_tables')
            inv0 = invariants(cl)
            row = run(cl, work, name, clients, tables, fixture['players'], scripts, seconds)
            row['top_up_lock_order'] = order
            row['fixture'] = fixture
            row['invariants_before'] = inv0
            row['invariants_after'] = invariants(cl)
            results['runs'].append(row)
            print(json.dumps({k: row[k] for k in ('name', 'tps', 'transactions', 'latency_ms', 'failed', 'deadlocks',
                                                  'lock_waits', 'waiters_per_sample')}), flush=True)
    finally:
        cl.stop()
    text = json.dumps(results, indent=2)
    if a.out:
        pathlib.Path(a.out).write_text(text)
    print('DIAMOND LOCK-WAIT MEASUREMENT COMPLETE: %d runs' % len(results['runs']))


if __name__ == '__main__':
    main()
