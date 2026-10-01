#!/usr/bin/env python3
"""The chip deadlock pairs, reproduced on an isolated cluster, before and after
20261001000000_the_chip_estate_takes_its_locks_in_one_order.

    PG_BIN=/opt/homebrew/opt/postgresql@17/bin \
    python3 scripts/qualification/chip-deadlocks.py --work <empty dir on a big disk> [--out result.json]

Production shows these deadlocks (3,605 in the 24 h to 2026-09-30 23:16 UTC) but must never be
made to produce one, so this builds its OWN PostgreSQL 17 cluster inside --work: a unix socket in a
private directory, listen_addresses empty (no TCP listener), fsync on. It reads PG_BIN from the
environment and nothing else; there is no variable that could point it at a real database.

What runs is production's own code: chip-deadlocks-live-doors.sql holds the live bodies of every
door in the reproduced cycles (pg_get_functiondef, captured read-only) and the four triggers that
reach them, laid over chip-deadlocks-schema.sql (production's column shapes and unique indexes).
The run refuses to measure unless md5(pg_get_functiondef()) of each of the 26 loaded functions
equals the production md5 pinned in chip-deadlocks.manifest.json. The five stubs in
chip-deadlocks-stubs.sql are readers (a plan, a proof, a scope) that take no lock.

Each case drives real concurrent psql sessions into the interleaving production's log shows,
using a pause gate (a session that names a key waits on an advisory lock the runner holds just
before it writes that key's row) and lock-wait detection (pg_locks). Every case runs twice:
BEFORE, on the live bodies; AFTER, once this runner has executed the migration's own substitution
block ($subs$ ... $subs$, read from the migration file) against those bodies - so the text measured
is, by construction, the text the migration installs. A deadlock is counted from the cluster log
(log_lock_waits=on writes one "detected deadlock while waiting" line per deadlock, caught or not,
exactly as production's log does).
"""
import argparse, hashlib, json, os, pathlib, queue, re, subprocess, threading, time, uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).resolve().parent
PG_BIN = os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')
DB = 'chip_deadlocks'
PORT = '55481'
GATE = 424242
MIGRATION = ROOT / 'supabase/migrations/20261001000000_the_chip_estate_takes_its_locks_in_one_order.sql'
PR5542_ORDER_LINE = '     ORDER BY s.uid::uuid\n'


class Cluster:
    def __init__(self, work):
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
        opts = ('-p %s -k %s -c listen_addresses= -c max_connections=40 -c shared_buffers=64MB '
                '-c log_lock_waits=on -c deadlock_timeout=200ms -c lc_messages=C '
                "-c log_line_prefix='%%m [%%p] '" % (PORT, self.sock))
        subprocess.run([self.tool('pg_ctl'), '-D', str(self.data), '-l', str(self.log), '-w',
                        '-o', opts, 'start'], check=True, capture_output=True, env=env)

    def stop(self):
        subprocess.run([self.tool('pg_ctl'), '-D', str(self.data), '-m', 'fast', '-w', 'stop'],
                       capture_output=True, env=dict(os.environ, LC_ALL='C'))

    def psql(self, database, *args, timeout=600):
        cmd = [self.tool('psql'), '-X', '-q', '-At', '-U', 'postgres', '-h', str(self.sock), '-p', PORT,
               '-d', database, '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off', *args]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if r.returncode:
            raise RuntimeError(r.stderr[-3000:] + r.stdout[-1000:])
        return r.stdout.strip()

    def q(self, sql):
        return self.psql(DB, '-c', sql)

    def log_size(self):
        return self.log.stat().st_size

    def log_since(self, offset):
        with open(self.log, 'rb') as f:
            f.seek(offset)
            return f.read().decode('utf8', 'replace')


class Session:
    """One psql backend fed statement by statement; each statement ends in an echoed tag."""

    def __init__(self, cl, name):
        self.name = name
        self.p = subprocess.Popen(
            [cl.tool('psql'), '-X', '-q', '-At', '-U', 'postgres', '-h', str(cl.sock), '-p', PORT, '-d', DB,
             '-v', 'ON_ERROR_STOP=0', '-P', 'pager=off'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        self.lines = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        self.n = 0
        self.pid = int(self.run("SET statement_timeout = '30s'; SELECT pg_backend_pid();").splitlines()[-1])

    def _read(self):
        for line in self.p.stdout:
            self.lines.put(line.rstrip('\n'))

    def send(self, sql):
        self.n += 1
        tag = '__END_%s_%d__' % (self.name, self.n)
        self.p.stdin.write(sql.rstrip() + '\n\\echo ' + tag + '\n')
        self.p.stdin.flush()
        return tag

    def wait(self, tag, timeout=40):
        out, end = [], time.time() + timeout
        while True:
            try:
                line = self.lines.get(timeout=max(0.05, end - time.time()))
            except queue.Empty:
                raise RuntimeError('%s: no answer in %ss (last: %s)' % (self.name, timeout, out[-3:]))
            if line == tag:
                return '\n'.join(out)
            out.append(line)

    def run(self, sql, timeout=40):
        return self.wait(self.send(sql), timeout)

    def close(self):
        try:
            self.p.stdin.write('\\q\n')
            self.p.stdin.flush()
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


def waiting(ctl, pid):
    return ctl.run('SELECT count(*) FROM pg_locks WHERE pid = %d AND NOT granted;' % pid).strip() not in ('', '0')


def wait_until_waiting(ctl, sess, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        if waiting(ctl, sess.pid):
            return True
        time.sleep(0.05)
    return False


def ids(run, case, *names):
    return {n: str(uuid.UUID(hashlib.md5(('%s:%s:%s' % (run, case, n)).encode()).hexdigest())) for n in names}


def ordered(run, case, *names):
    """Fresh ids for `names`, assigned so that names[0] < names[1] < ... as uuids."""
    raw = sorted(ids(run, case, *['%s-%d' % (case, i) for i in range(len(names))]).values())
    return dict(zip(names, raw))


def build(cl):
    cl.psql('postgres', '-c', 'DROP DATABASE IF EXISTS %s' % DB)
    cl.psql('postgres', '-c', 'CREATE DATABASE %s' % DB)
    for f in ('chip-deadlocks-schema.sql', 'chip-deadlocks-stubs.sql', 'chip-deadlocks-live-doors.sql'):
        cl.psql(DB, '-f', str(HERE / f))
    man = json.loads((HERE / 'chip-deadlocks.manifest.json').read_text())
    got = dict(line.split('|') for line in cl.q(
        "SELECT p.proname, md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
        "WHERE n.nspname='public' AND p.proname IN (%s)" % ','.join("'%s'" % k for k in man['functions'])).splitlines())
    bad = {k: (v, got.get(k)) for k, v in man['functions'].items() if got.get(k) != v}
    if bad:
        raise SystemExit('REFUSED: loaded bodies are not production\'s: %s' % bad)
    trg = dict(line.split('|', 1) for line in cl.q(
        "SELECT t.tgname, pg_get_triggerdef(t.oid) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname IN (%s)"
        % ','.join("'%s'" % k for k in man['triggers'])).splitlines())
    if trg != man['triggers']:
        raise SystemExit('REFUSED: triggers are not production\'s')
    cl.q("INSERT INTO public.accounting_cash_accrual_cutover (starts_at) VALUES ('2020-01-01T00:00:00Z')")
    return len(man['functions'])


def apply_migration(cl):
    """Execute the migration's own substitution block against the live bodies on this cluster."""
    text = MIGRATION.read_text()
    m = re.search(r'^DO \$subs\$\n.*?^END \$subs\$;\n', text, re.S | re.M)
    if not m:
        raise SystemExit('the migration has no $subs$ block')
    block = m.group(0)
    tmp = HERE / ('zz-chip-deadlocks-subs-%d.sql' % os.getpid())
    tmp.write_text("BEGIN;\nSET LOCAL lock_timeout = '2s';\n" + block + 'COMMIT;\n')
    try:
        cl.psql(DB, '-f', str(tmp))
    finally:
        tmp.unlink()
    return hashlib.md5(block.encode()).hexdigest()


# ---------------------------------------------------------------------------------------------
# Fixture pieces (synthetic ids, isolated cluster only)
# ---------------------------------------------------------------------------------------------
def seed_club(ctl, club, table=None):
    ctl.run("INSERT INTO public.clubs (id, name) VALUES ('%s', 'harness %s');"
            "INSERT INTO public.club_wallets (club_id) VALUES ('%s');" % (club, club[:8], club))
    if table:
        ctl.run("INSERT INTO public.tables (id, club_id, name) VALUES ('%s', '%s', 'harness');" % (table, club))


def seed_profiles(ctl, *users):
    ctl.run('INSERT INTO public.profiles (id) VALUES %s;' % ','.join("('%s')" % u for u in users))


def seed_stats(ctl, club, *users):
    ctl.run('INSERT INTO public.player_stats (user_id, club_id, hands_played) VALUES %s;'
            % ','.join("('%s','%s',5)" % (u, club) for u in users))


def seed_agent(ctl, agent, club, user):
    ctl.run("INSERT INTO public.agents (id, club_id, user_id, role, commission_rate, player_rakeback_rate) "
            "VALUES ('%s','%s','%s','agent',0.3,0);" % (agent, club, user))


def tier(user, agent, amount, depth):
    return {'user_id': user, 'agent_id': agent, 'amount': amount, 'rate': amount, 'depth': depth}


def seed_cash_record(ctl, rr, hand, club, table, player, credit, tiers):
    plan = {'players': [{'player_id': player, 'club_id': club, 'union_id': None, 'coordinator_union_id': None,
                         'rake_credit': credit, 'tiers': tiers}]}
    ctl.run("INSERT INTO public.rake_records (id, hand_id, table_id, club_id, rake_amount, is_tournament, created_at, metadata) "
            "VALUES ('%s','%s','%s','%s',%s,false,now() - interval '1 minute','{}');"
            "INSERT INTO public.rake_attributions (hand_id, player_id, rake_amount, rake_record_id, table_id, club_id, weighted_rake_credit) "
            "VALUES ('%s','%s',%s,'%s','%s','%s',%s);"
            "INSERT INTO public.harness_cash_plans VALUES ('%s', '%s'::jsonb);"
            % (rr, hand, table, club, credit, hand, player, credit, rr, table, club, credit, rr, json.dumps(plan)))


def seed_finish(ctl, tournament, club, sources):
    """sources: [(source_id, player, club, credit, tiers)]; the fee plan names them all active."""
    ctl.run("INSERT INTO public.tournaments (id, club_id, name, buy_in_amount, buy_in_fee, start_time) "
            "VALUES ('%s','%s','harness',10,1,now());" % (tournament, club))
    for s, player, sclub, credit, tiers in sources:
        contract = {'club_id': sclub, 'rake_credit': credit, 'tiers': tiers}
        ctl.run("INSERT INTO public.accounting_tournament_fee_sources (id, rake_record_id, tournament_id, player_id, club_id, "
                "game_type, registration_id, source_charge_ledger_id, source_entitlement_id, charged_at, rake_credit, contract) "
                "VALUES ('%s', gen_random_uuid(), '%s','%s','%s','mtt', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), "
                "now(), %s, '%s'::jsonb);" % (s, tournament, player, sclub, credit, json.dumps(contract)))
    plan = {'active_source_ids': [s[0] for s in sources], 'refunded_source_ids': [],
            'net_fee': sum(s[3] for s in sources), 'union_id': '', 'source_fingerprint': 'fp-' + tournament}
    ctl.run("INSERT INTO public.harness_fee_plans VALUES ('%s', '%s'::jsonb);" % (tournament, json.dumps(plan)))


def batch_sql(*records):
    items = json.dumps([{'source_type': 'cash_rake_record', 'source_id': r} for r in records])
    return "SELECT fn_credit_agent_commissions_batch('%s'::jsonb);" % items


def finish_sql(tournament, club):
    return ("SELECT (fn_recognize_accounting_tournament_fees('%s', now(), '%s', NULL, NULL))->>'status';"
            % (tournament, club))


def outcome(text):
    if 'deadlock detected' in text and 'ERROR' in text:
        return 'deadlock victim (rolled back)'
    if 'ERROR' in text:
        return 'error: ' + text[text.find('ERROR'):][:160]
    m = re.search(r'"reason": "([^"]*)"', text)
    if m and 'blocked' in text:
        return 'item refused and queued for retry: ' + m.group(1)
    return 'completed'


class Case:
    def __init__(self, cl, ctl, run, key, pair):
        self.cl, self.ctl, self.run, self.key, self.pair = cl, ctl, run, key, pair
        self.sessions, self.notes = [], {}

    def session(self, name):
        s = Session(self.cl, name)
        self.sessions.append(s)
        return s

    def __enter__(self):
        self.off = self.cl.log_size()
        self.t0 = time.time()
        return self

    def __exit__(self, *exc):
        for s in self.sessions:
            s.close()
        self.ctl.run('SELECT pg_advisory_unlock_all();')

    def result(self):
        time.sleep(0.3)
        log = self.cl.log_since(self.off)
        return {'case': self.key, 'pair': self.pair, 'state': self.run,
                'deadlocks': log.count('detected deadlock while waiting'),
                'deadlock_errors': log.count('ERROR:  deadlock detected'),
                'seconds': round(time.time() - self.t0, 2), **self.notes}


# ---------------------------------------------------------------------------------------------
# The cases
# ---------------------------------------------------------------------------------------------
def case_commission_one_club(cl, ctl, run):
    I = ids(run, 'A1', 'club', 'X', 'Y', 'aX', 'aY', 'p1', 'q', 'rr', 'hand', 'table', 't', 's')
    seed_club(ctl, I['club'])
    seed_profiles(ctl, I['X'], I['Y'], I['p1'], I['q'])
    seed_agent(ctl, I['aX'], I['club'], I['X'])
    seed_agent(ctl, I['aY'], I['club'], I['Y'])
    seed_cash_record(ctl, I['rr'], I['hand'], I['club'], I['table'], I['p1'], 1.00,
                     [tier(I['X'], I['aX'], 0.30, 1), tier(I['Y'], I['aY'], 0.10, 2)])
    seed_finish(ctl, I['t'], I['club'], [(I['s'], I['q'], I['club'], 1.00, [tier(I['Y'], I['aY'], 0.25, 1)])])
    with Case(cl, ctl, run, 'commission-rollups-one-club',
              'cash accrual batch x tournament finish on agent_commission_unsettled_rollup / ca_club_commission_daily') as c:
        ctl.run('SELECT pg_advisory_lock(%d);' % GATE)
        B, F = c.session('batch'), c.session('finish')
        tb = B.send("BEGIN; SET LOCAL harness.pause_before = '%s'; %s" % (I['Y'], batch_sql(I['rr'])))
        c.notes['batch_paused_after_first_tier'] = wait_until_waiting(ctl, B)
        tf = F.send('BEGIN; ' + finish_sql(I['t'], I['club']))
        c.notes['finish_waited'] = wait_until_waiting(ctl, F)
        ctl.run('SELECT pg_advisory_unlock(%d);' % GATE)
        c.notes['batch'] = outcome(B.wait(tb)); B.run('COMMIT;')
        c.notes['finish'] = outcome(F.wait(tf)); F.run('COMMIT;')
        return c.result()


def case_commission_two_clubs(cl, ctl, run):
    I = ids(run, 'A2', 'XA', 'XB', 'YA', 'YB', 'aXA', 'aXB', 'aYA', 'aYB', 'pA', 'pB', 'qA', 'qB',
            'rrA', 'rrB', 'hA', 'hB', 'tA', 'tB', 't', 'sA', 'sB')
    I.update(ordered(run, 'A2clubs', 'A', 'B'))
    for club, tb in (('A', 'tA'), ('B', 'tB')):
        seed_club(ctl, I[club])
    seed_profiles(ctl, I['XA'], I['XB'], I['YA'], I['YB'], I['pA'], I['pB'], I['qA'], I['qB'])
    for a, club, u in (('aXA', 'A', 'XA'), ('aXB', 'B', 'XB'), ('aYA', 'A', 'YA'), ('aYB', 'B', 'YB')):
        seed_agent(ctl, I[a], I[club], I[u])
    seed_cash_record(ctl, I['rrB'], I['hB'], I['B'], I['tB'], I['pB'], 1.00, [tier(I['XB'], I['aXB'], 0.30, 1)])
    seed_cash_record(ctl, I['rrA'], I['hA'], I['A'], I['tA'], I['pA'], 1.00, [tier(I['XA'], I['aXA'], 0.30, 1)])
    seed_finish(ctl, I['t'], I['A'], [(I['sA'], I['qA'], I['A'], 1.00, [tier(I['YA'], I['aYA'], 0.25, 1)]),
                                      (I['sB'], I['qB'], I['B'], 1.00, [tier(I['YB'], I['aYB'], 0.25, 1)])])
    with Case(cl, ctl, run, 'commission-rollups-two-clubs',
              'cash accrual batch (club B then A) x union finish (club A then B) on ca_club_commission_daily') as c:
        ctl.run('SELECT pg_advisory_lock(%d);' % GATE)
        B, F = c.session('batch'), c.session('finish')
        tb = B.send("BEGIN; SET LOCAL harness.pause_before = '%s'; %s" % (I['XA'], batch_sql(I['rrB'], I['rrA'])))
        c.notes['batch_paused_before_second_club'] = wait_until_waiting(ctl, B)
        tf = F.send('BEGIN; ' + finish_sql(I['t'], I['A']))
        c.notes['finish_waited'] = wait_until_waiting(ctl, F)
        ctl.run('SELECT pg_advisory_unlock(%d);' % GATE)
        c.notes['batch'] = outcome(B.wait(tb)); B.run('COMMIT;')
        c.notes['finish'] = outcome(F.wait(tf)); F.run('COMMIT;')
        return c.result()


def rake_sql(table, club, hand, number, contributions):
    return ("SELECT applied FROM atomic_distribute_rake('%s','%s','%s',%d,1.00,0,10.00,2,'%s'::jsonb,NULL,'{}'::jsonb,"
            "'WEIGHTED_CONTRIBUTED');" % (table, club, hand, number, json.dumps(contributions)))


FINISH_BANK_LOCK = ("SELECT 1 FROM public.club_wallets cw WHERE cw.club_id = '%s' ORDER BY cw.club_id FOR NO KEY UPDATE;")


def case_finish_vs_hand(cl, ctl, run):
    I = ids(run, 'C', 'club', 'table', 'h1', 'h2', 'hand', 't', 's')
    seed_club(ctl, I['club'], I['table'])
    seed_profiles(ctl, I['h1'], I['h2'])
    seed_stats(ctl, I['club'], I['h1'])
    seed_finish(ctl, I['t'], I['club'], [(I['s'], I['h1'], I['club'], 1.00, [])])
    with Case(cl, ctl, run, 'finish-vs-raked-hand',
              'tournament finish (club_wallets, then VIP carry) x raked hand (VIP carry, then club_wallets)') as c:
        F, O = c.session('finish'), c.session('hand')
        F.run('BEGIN; ' + FINISH_BANK_LOCK % I['club'])
        to = O.send('BEGIN; ' + rake_sql(I['table'], I['club'], I['hand'], 7, {I['h1']: 5, I['h2']: 5}))
        c.notes['hand_waited_for_wallet'] = wait_until_waiting(ctl, O)
        tf = F.send(finish_sql(I['t'], I['club']))
        c.notes['finish_waited'] = wait_until_waiting(ctl, F, timeout=2)
        c.notes['finish'] = outcome(F.wait(tf)); F.run('COMMIT;')
        c.notes['hand'] = outcome(O.wait(to)); O.run('COMMIT;')
        return c.result()


def case_finish_vs_two_hands(cl, ctl, run):
    I = ids(run, 'C3', 'club', 'ta', 'tb', 'h1', 'h2', 'h3', 'h4', 'hand1', 'hand2', 't', 's')
    seed_club(ctl, I['club'], I['ta'])
    ctl.run("INSERT INTO public.tables (id, club_id, name) VALUES ('%s', '%s', 'harness');" % (I['tb'], I['club']))
    seed_profiles(ctl, I['h1'], I['h2'], I['h3'], I['h4'])
    seed_stats(ctl, I['club'], I['h1'])
    seed_finish(ctl, I['t'], I['club'], [(I['s'], I['h1'], I['club'], 1.00, [])])
    with Case(cl, ctl, run, 'finish-vs-two-raked-hands',
              'finish x hand x hand through ca_club_rake_daily (three-way)') as c:
        F, O2, O1 = c.session('finish'), c.session('hand2'), c.session('hand1')
        F.run('BEGIN; ' + FINISH_BANK_LOCK % I['club'])
        t2 = O2.send('BEGIN; ' + rake_sql(I['tb'], I['club'], I['hand2'], 12, {I['h3']: 5, I['h4']: 5}))
        c.notes['hand2_waited'] = wait_until_waiting(ctl, O2)
        t1 = O1.send('BEGIN; ' + rake_sql(I['ta'], I['club'], I['hand1'], 11, {I['h1']: 5, I['h2']: 5}))
        c.notes['hand1_waited'] = wait_until_waiting(ctl, O1)
        tf = F.send(finish_sql(I['t'], I['club']))
        c.notes['finish_waited'] = wait_until_waiting(ctl, F, timeout=2)
        c.notes['finish'] = outcome(F.wait(tf)); F.run('COMMIT;')
        c.notes['hand2'] = outcome(O2.wait(t2)); O2.run('COMMIT;')
        c.notes['hand1'] = outcome(O1.wait(t1)); O1.run('COMMIT;')
        return c.result()


def case_finish_vs_horse_claims(cl, ctl, run):
    I = ids(run, 'D', 'club', 't', 's1', 's2')
    I.update(ordered(run, 'Dusers', 'u1', 'u2'))
    seed_club(ctl, I['club'])
    seed_profiles(ctl, I['u1'], I['u2'])
    seed_stats(ctl, I['club'], I['u1'], I['u2'])
    seed_finish(ctl, I['t'], I['club'], [(I['s1'], I['u1'], I['club'], 1.00, []), (I['s2'], I['u2'], I['club'], 1.00, [])])
    with Case(cl, ctl, run, 'finish-vs-horse-claims',
              'tournament finish (profiles via the player_stats trigger, +0 hands) x horse claims (profiles in claim order)') as c:
        H, F = c.session('horse-claims'), c.session('finish')
        H.run("BEGIN; SELECT fn_lock_daily_mission_user('%s');" % I['u2'])
        tf = F.send('BEGIN; ' + finish_sql(I['t'], I['club']))
        c.notes['finish_waited'] = wait_until_waiting(ctl, F, timeout=2)
        th = H.send("SELECT fn_lock_daily_mission_user('%s');" % I['u1'])
        c.notes['finish'] = outcome(F.wait(tf)); F.run('COMMIT;')
        c.notes['horse_claims'] = outcome(H.wait(th)); H.run('COMMIT;')
        return c.result()


HORSE = {
    'upsert_horse_mind_pairs': lambda k, **v: dict({'attacker_id': k, 'victim_id': 'v'}, **v),
    'upsert_horse_mind_stats': lambda k, **v: dict({'user_id': k}, **v),
    'upsert_horse_mind_stats_scoped': lambda k, **v: dict({'user_id': k, 'scope': 'holdem:hu'}, **v),
}


def case_horse_mind(cl, ctl, run, fn):
    k1, k2 = 'hm-%s-%s-1' % (run, fn[-5:]), 'hm-%s-%s-2' % (run, fn[-5:])
    row = HORSE[fn]
    with Case(cl, ctl, run, fn.replace('upsert_', '').replace('_', '-'), 'horse-mind flush x horse-mind flush on ' + fn[7:]) as c:
        ctl.run('SELECT pg_advisory_lock(%d);' % GATE)
        S1, S2 = c.session('flush1'), c.session('flush2')
        t1 = S1.send("BEGIN; SET LOCAL harness.pause_before = '%s'; SELECT %s('%s'::jsonb);"
                     % (k2, fn, json.dumps([row(k1, hands=1), row(k2, hands=1)])))
        c.notes['flush1_paused'] = wait_until_waiting(ctl, S1)
        t2 = S2.send("BEGIN; SELECT %s('%s'::jsonb);" % (fn, json.dumps([row(k2, hands=2), row(k1, hands=2)])))
        c.notes['flush2_waited'] = wait_until_waiting(ctl, S2)
        ctl.run('SELECT pg_advisory_unlock(%d);' % GATE)
        c.notes['flush1'] = outcome(S1.wait(t1)); S1.run('COMMIT;')
        c.notes['flush2'] = outcome(S2.wait(t2)); S2.run('COMMIT;')
        return c.result()


def horse_mind_values(cl, run):
    """One session, repeats and reversed keys: the rows each function leaves, keyed by input position."""
    out = {}
    for fn, row in HORSE.items():
        a, b = 'hv-%s-%s-a' % (run, fn[-5:]), 'hv-%s-%s-b' % (run, fn[-5:])
        rows = [row(b, hands=5, r_hands=1.5, n3=5), row(a, hands=3, r_hands=2.5, n3=3), row(b, hands=4, r_hands=9.5, n3=4)]
        cl.q("SELECT %s('%s'::jsonb)" % (fn, json.dumps(rows)))
        table = fn.replace('upsert_', '')
        key = 'attacker_id' if 'pairs' in fn else 'user_id'
        got = cl.q("SELECT %s, row_to_json(t)::jsonb - 'updated_at' - 'user_id' - 'attacker_id' - 'created_at' - 'id' FROM public.%s t "
                   "WHERE %s IN ('%s','%s') ORDER BY 1" % (key, table, key, a, b))
        out[fn] = [line.split('|', 1)[1] for line in got.splitlines()]
    return out


def projection2_functions(cl):
    live = cl.q("SELECT pg_get_functiondef('public.fn_project_hand_side_effects_after_post_commit_20260908(uuid)'::regprocedure)")
    start = live.index('    WITH seated AS (')
    stmt = live[start:live.index('      updated_at=now();', start) + len('      updated_at=now();')]
    anchor = '     WHERE EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=s.uid::uuid)\n'
    assert stmt.count(anchor) == 1
    pr = stmt.replace(anchor, anchor + PR5542_ORDER_LINE)
    for name, text in (('hx_projection2_live', stmt), ('hx_projection2_pr5542', pr)):
        body = (text.replace('v_h.players', 'p_players').replace('v_h.winners', 'p_winners')
                .replace('v_club', 'p_club').replace('v_bb', 'p_bb'))
        cl.q('CREATE OR REPLACE FUNCTION public.%s(p_players jsonb, p_winners jsonb, p_club uuid, p_bb numeric) '
             'RETURNS void LANGUAGE plpgsql AS $x$ BEGIN\n%s\nEND $x$' % (name, body))
    return hashlib.md5(stmt.encode()).hexdigest()


def case_pr5542(cl, ctl, run):
    I = ids(run, 'B', 'club', 'rra', 'rrb', 'ha', 'hb', 'ta', 'tb')
    I.update(ordered(run, 'Busers', 'a', 'b'))
    seed_club(ctl, I['club'])
    seed_profiles(ctl, I['a'], I['b'])
    seed_stats(ctl, I['club'], I['a'], I['b'])
    seed_cash_record(ctl, I['rrb'], I['hb'], I['club'], I['tb'], I['b'], 1.00, [])
    seed_cash_record(ctl, I['rra'], I['ha'], I['club'], I['ta'], I['a'], 1.00, [])
    with Case(cl, ctl, run, 'pr5542-player-stats-across-hands',
              'cash accrual batch (hand of b, then hand of a) x Projection 2 WITH PR #5542\'s ORDER BY (a, then b)') as c:
        ctl.run('SELECT pg_advisory_lock(%d);' % GATE)
        B, P = c.session('batch'), c.session('projection')
        tb = B.send("BEGIN; SET LOCAL harness.pause_before = '%s'; %s" % (I['a'], batch_sql(I['rrb'], I['rra'])))
        c.notes['batch_paused_before_second_hand'] = wait_until_waiting(ctl, B)
        tp = P.send("BEGIN; SELECT hx_projection2_pr5542('%s'::jsonb, '[]'::jsonb, '%s', 2);"
                    % (json.dumps([{'userId': I['a']}, {'userId': I['b']}]), I['club']))
        c.notes['projection_waited'] = wait_until_waiting(ctl, P)
        ctl.run('SELECT pg_advisory_unlock(%d);' % GATE)
        c.notes['batch'] = outcome(B.wait(tb)); B.run('COMMIT;')
        c.notes['projection'] = outcome(P.wait(tp)); P.run('COMMIT;')
        return c.result()


CASES = [case_commission_one_club, case_commission_two_clubs, case_finish_vs_hand, case_finish_vs_two_hands,
         case_finish_vs_horse_claims] + [
    (lambda fn: (lambda cl, ctl, run: case_horse_mind(cl, ctl, run, fn)))(fn) for fn in HORSE] + [case_pr5542]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--work', required=True)
    ap.add_argument('--out')
    a = ap.parse_args()
    work = pathlib.Path(a.work).resolve()
    work.mkdir(parents=True, exist_ok=True)
    cl = Cluster(work)
    cl.start()
    report = {'started': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'postgres': None, 'results': [], 'values': {}}
    try:
        report['postgres'] = cl.psql('postgres', '-c', 'SELECT version()')
        report['functions_pinned_and_verified'] = build(cl)
        report['projection2_statement_md5'] = projection2_functions(cl)
        ctl = Session(cl, 'ctl')
        for state in ('before', 'after'):
            if state == 'after':
                ctl.close()
                report['migration_subs_block_md5'] = apply_migration(cl)
                projection2_functions(cl)
                ctl = Session(cl, 'ctl')
            for case in CASES:
                r = case(cl, ctl, state)
                report['results'].append(r)
                print('%-34s %-6s deadlocks=%d  %s' % (r['case'], state, r['deadlocks'],
                      {k: v for k, v in r.items() if k not in ('case', 'pair', 'state', 'deadlocks')}), flush=True)
            report['values'][state] = horse_mind_values(cl, state)
        ctl.close()
        report['values_equal'] = report['values']['before'] == report['values']['after']
        print('horse-mind values equal before/after:', report['values_equal'])
    finally:
        cl.stop()
    report['finished'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    if a.out:
        pathlib.Path(a.out).write_text(json.dumps(report, indent=2) + '\n')
    fixed = [r for r in report['results'] if r['state'] == 'after' and not r['case'].startswith('pr5542')]
    ok = (all(r['deadlocks'] == 0 for r in fixed)
          and all(r['deadlocks'] > 0 for r in report['results'] if r['state'] == 'before')
          and report['values_equal'])
    print('CHIP DEADLOCKS: %s' % ('every fixed pair deadlocks before and not after' if ok else 'NOT AS CLAIMED'))
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
