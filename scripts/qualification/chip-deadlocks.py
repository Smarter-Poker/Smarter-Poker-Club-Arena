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
# 20261001000500 reverses that migration's atomic_distribute_rake change (it made a tournament finish
# queue behind raked hands on club_wallets in production); the AFTER state is both, in order.
REVERT = ROOT / 'supabase/migrations/20261001000500_a_raked_hand_takes_its_club_wallet_where_it_did.sql'
# 20261001001000 makes the batch and the retry TRY their up-front commission keys: waiting for one
# outside an item put the whole batch behind the role's lock_timeout (8 s) and failed it whole.
KEYS_FIX = ROOT / 'supabase/migrations/20261001001000_a_cash_batch_never_waits_for_a_commission_key.sql'
# 20261019094914 takes every key in club order before the first item, waits for a busy one at most
# 1 s holding only lower keys, and returns an item whose keys are not all held as deferred instead of
# letting it take its key out of order in the trigger - the 40P01 of 2026-10-19 07:28:34, which
# 20261001001000's try-and-stop walk left open. Its AFTER state is called 'sorted' here.
SORTED_FIX = ROOT / ('supabase/migrations/'
                     '20261019094914_commission_keys_in_club_order_refresh_reads_accrued.sql')
BUSY_KEY_CASES = ('batch-vs-finish-on-a-busy-key', 'retry-vs-finish-on-a-busy-key')
# 20261019171753 skips a busy key instead of ending the walk at it, and the retry reads a window of
# due sources: a head deferred for one busy key can no longer hold the whole queue (production
# 2026-10-19 17:00: a Lightning source and four Midway sources at the head, Midway's keys the
# lowest uuids). Its AFTER state is called 'skipping' here.
SKIP_FIX = ROOT / 'supabase/migrations/20261019171753_a_busy_commission_key_never_holds_the_cash_queue.sql'
STARVE_CASES = ('retry-queue-head-on-a-busy-key', 'batch-item-behind-a-busy-key')
# 20261019194410 (installed 2026-10-19) rebuilt the batch on 20261019171753's text: it also takes every
# 'player-stats-user:<player>' key in player order after the club keys, and the hand projection takes
# the same keys. Its batch (and its projection, when this cluster carries 194410's pinned preimage) is
# installed here before the budget; that state is called 'keyed' and is production's text.
KEYED_FIX = ROOT / 'supabase/migrations/20261019194410_replay_holds_no_lock_past_its_receipt_player_stats_key_order.sql'
KEYED_BODIES = (
    ('batch', 'fn_credit_agent_commissions_batch(jsonb)', '1ae9eb0e32f8169ce0cdd6b730c859a6',
     '9befae963f3b9cda25b357f60a9b53d7'),
    ('projection', 'fn_project_hand_side_effects_after_post_commit_20260908(uuid)', 'ef3cb3725ca3a1566e0e1254830a9a63',
     'cee6c2257fcc49c6c6974e5fe8832107'))
# 20261019214727 bounds every item's lock wait (2 s) and every call (8 s), so a call always returns
# inside the engine's 15 s client budget (2026-10-19 17:02: a 16.1 s batch, two items behind a held
# profiles row at the session's 8 s lock_timeout, halted the settler for 27 minutes). It replaces
# 20261019190103, merged but refused at install because 20261019194410 had replaced the batch, and it
# keeps 194410's player key walk. Its AFTER state is called 'budgeted' here.
BUDGET_FIX = ROOT / 'supabase/migrations/20261019214727_a_cash_source_call_fits_the_engines_patience.sql'
NOT_FIXED = ('finish-vs-raked-hand', 'finish-vs-two-raked-hands', 'pr5542-player-stats-across-hands')
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


def apply_migration(cl, path=MIGRATION):
    """Execute a migration's own substitution block against the bodies on this cluster."""
    text = path.read_text()
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


def probe_budget_rolled_back(cl):
    """20261019214727's $subs$ block in a transaction that is rolled back: what it lands on from
    the text this cluster holds now. Used on 20261019171753's text, the other accepted preimage."""
    text = BUDGET_FIX.read_text()
    block = re.search(r'^DO \$subs\$\n.*?^END \$subs\$;\n', text, re.S | re.M).group(0)
    tmp = HERE / ('zz-chip-deadlocks-probe-%d.sql' % os.getpid())
    tmp.write_text("BEGIN;\nSET LOCAL lock_timeout = '2s';\n" + block +
                   "SELECT md5(pg_get_functiondef('public.fn_credit_agent_commissions_batch(jsonb)'::regprocedure)) || ',' ||"
                   " md5(pg_get_functiondef('public.fn_retry_cash_accounting_sources(integer)'::regprocedure));\nROLLBACK;\n")
    try:
        before = cl.q("SELECT md5(pg_get_functiondef('public.fn_credit_agent_commissions_batch(jsonb)'::regprocedure))")
        out = cl.psql(DB, '-f', str(tmp)).splitlines()[-1]
        after_rollback = cl.q("SELECT md5(pg_get_functiondef('public.fn_credit_agent_commissions_batch(jsonb)'::regprocedure))")
    finally:
        tmp.unlink()
    batch, retry = out.split(',')
    return {'batch_before': before, 'batch_inside': batch, 'retry_inside': retry, 'batch_after_rollback': after_rollback}


def apply_keyed(cl):
    """Install 20261019194410's batch (and its projection, if this cluster holds 194410's pinned
    preimage of it) exactly as its $subs$ block would: preimage md5, text, postimage md5."""
    text, done = KEYED_FIX.read_text(), {}
    for tag, sig, before, after in KEYED_BODIES:
        body = re.search(r'\$%s\$(CREATE OR REPLACE FUNCTION.*?)\$%s\$' % (tag, tag), text, re.S).group(1)
        md5 = lambda: cl.q("SELECT md5(pg_get_functiondef('public.%s'::regprocedure))" % sig)
        cur = md5()
        if cur != before:
            if tag == 'batch':
                raise SystemExit('REFUSED: the batch is not 20261019194410\'s preimage (%s)' % cur)
            done[tag] = 'not installed: this cluster holds %s, not 194410\'s preimage' % cur
            continue
        tmp = HERE / ('zz-chip-deadlocks-keyed-%d.sql' % os.getpid())
        tmp.write_text(body + ';\n')
        try:
            cl.psql(DB, '-f', str(tmp))
        finally:
            tmp.unlink()
        if md5() != after:
            raise SystemExit('REFUSED: %s is not 20261019194410\'s postimage (%s)' % (sig, md5()))
        done[tag] = after
    return done


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
    d = re.search(r'"deferred": \[([^\]]*)\]', text)
    if d and d.group(1).strip():
        return 'deferred until its commission keys are free: %d' % len(d.group(1).split(','))
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


def case_batch_key_held(cl, ctl, run):
    """A finish holds a club's commission key; the batch (lock_timeout 1 s, the role's 8 s scaled)
    must refuse that one item for retry, never fail whole."""
    I = ids(run, 'K', 'club', 'X', 'aX', 'p1', 'rr', 'hand', 'table')
    seed_club(ctl, I['club'])
    seed_profiles(ctl, I['X'], I['p1'])
    seed_agent(ctl, I['aX'], I['club'], I['X'])
    seed_cash_record(ctl, I['rr'], I['hand'], I['club'], I['table'], I['p1'], 1.00, [tier(I['X'], I['aX'], 0.30, 1)])
    with Case(cl, ctl, run, 'batch-while-a-finish-holds-a-key',
              'cash accrual batch while a tournament finish holds its club commission key (lock_timeout)') as c:
        H, B = c.session('finish'), c.session('batch')
        H.run("BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('agent-commission:%s',0));" % I['club'])
        out = B.run("SET lock_timeout = '1s'; BEGIN; " + batch_sql(I['rr']))
        c.notes['batch'] = outcome(out)
        B.run('ROLLBACK;')
        H.run('COMMIT;')
        return c.result()


def seed_busy_key_pair(ctl, run, tag):
    """Two clubs A < B. Cash records rrB (club B) then rrA (club A); a union finish with a club A
    source and a club B source. The production pair of 2026-10-19: Club JAQK (a0000000-...) < SHARK CLUB."""
    I = ids(run, tag, 'XA', 'XB', 'YA', 'YB', 'aXA', 'aXB', 'aYA', 'aYB', 'pA', 'pB', 'qA', 'qB',
            'rrA', 'rrB', 'hA', 'hB', 'tA', 'tB', 't', 'sA', 'sB')
    I.update(ordered(run, tag + 'clubs', 'A', 'B'))
    for club in ('A', 'B'):
        seed_club(ctl, I[club])
    seed_profiles(ctl, I['XA'], I['XB'], I['YA'], I['YB'], I['pA'], I['pB'], I['qA'], I['qB'])
    for a, club, u in (('aXA', 'A', 'XA'), ('aXB', 'B', 'XB'), ('aYA', 'A', 'YA'), ('aYB', 'B', 'YB')):
        seed_agent(ctl, I[a], I[club], I[u])
    seed_cash_record(ctl, I['rrB'], I['hB'], I['B'], I['tB'], I['pB'], 1.00, [tier(I['XB'], I['aXB'], 0.30, 1)])
    seed_cash_record(ctl, I['rrA'], I['hA'], I['A'], I['tA'], I['pA'], 1.00, [tier(I['XA'], I['aXA'], 0.30, 1)])
    seed_finish(ctl, I['t'], I['A'], [(I['sA'], I['qA'], I['A'], 1.00, [tier(I['YA'], I['aYA'], 0.25, 1)]),
                                      (I['sB'], I['qB'], I['B'], 1.00, [tier(I['YB'], I['aYB'], 0.25, 1)])])
    return I


def commissions_written(ctl, I):
    """agent_commissions rows per earner: each tier must be written exactly once (or not at all if rolled back)."""
    got = dict(line.split('|') for line in ctl.run(
        "SELECT u, (SELECT count(*) FROM public.agent_commissions ac WHERE ac.user_id = u::uuid) FROM unnest(ARRAY[%s]) u;"
        % ','.join("'%s'" % I[k] for k in ('XA', 'XB', 'YA', 'YB'))).splitlines())
    return {k: int(got[I[k]]) for k in ('XA', 'XB', 'YA', 'YB')}


def case_batch_busy_key(cl, ctl, run, hold_past_wait=True):
    """The 40P01 of 2026-10-19 07:28:34. A union finish holds club A's key (its first source) and is
    about to ask for club B's. The cash batch's items are rrB (club B) then rrA (club A). Live
    (20261001001000): the key walk meets busy A and stops, rrB takes B in the trigger, rrA waits for A,
    the finish asks for B: deadlock. Sorted: the batch waits for A holding nothing; if the finish still
    holds A after 1 s both items are deferred and resubmitted (as the settler does) once it commits;
    if the finish commits inside the wait, the batch takes A then B and runs both."""
    I = seed_busy_key_pair(ctl, run, 'E' if hold_past_wait else 'E2')
    key = 'batch-vs-finish-on-a-busy-key' if hold_past_wait else 'batch-waits-briefly-for-a-busy-key'
    with Case(cl, ctl, run, key, 'cash batch (club B item, then club A item) x union finish (club A, then B) '
              'while the finish holds club A') as c:
        ctl.run('SELECT pg_advisory_lock(%d);' % GATE)
        F, B = c.session('finish'), c.session('batch')
        tf = F.send("BEGIN; SET LOCAL harness.pause_before = '%s'; %s" % (I['YB'], finish_sql(I['t'], I['A'])))
        c.notes['finish_paused_holding_club_a'] = wait_until_waiting(ctl, F)
        t0 = time.time()
        tb = B.send('BEGIN; ' + batch_sql(I['rrB'], I['rrA']))
        if run in ('sorted', 'skipping', 'keyed', 'budgeted') and hold_past_wait:
            c.notes['batch'] = outcome(B.wait(tb))
            c.notes['batch_seconds'] = round(time.time() - t0, 2)
            B.run('COMMIT;')
            c.notes['written_while_deferred'] = commissions_written(ctl, I)
            ctl.run('SELECT pg_advisory_unlock(%d);' % GATE)
            c.notes['finish'] = outcome(F.wait(tf)); F.run('COMMIT;')
            c.notes['resubmitted'] = outcome(B.run(batch_sql(I['rrB'], I['rrA'])))
        else:
            c.notes['batch_waited'] = wait_until_waiting(ctl, B)
            ctl.run('SELECT pg_advisory_unlock(%d);' % GATE)
            # Either side may be the victim and the other must not wait on an open transaction:
            # both COMMITs are queued now, each runs as soon as its own statement returns.
            tfc, tbc = F.send('COMMIT;'), B.send('COMMIT;')
            c.notes['finish'] = outcome(F.wait(tf)); F.wait(tfc)
            c.notes['batch'] = outcome(B.wait(tb)); B.wait(tbc)
            c.notes['batch_seconds'] = round(time.time() - t0, 2)
        c.notes['commissions'] = commissions_written(ctl, I)
        return c.result()


def seed_blocked_work(ctl, rr, attempt_at):
    rid = str(uuid.uuid4())
    ctl.run("INSERT INTO public.accounting_cash_source_receipts (id, rake_record_id, attempt, earned_at, source_fingerprint, "
            "status, reason, sqlstate, scope, result) VALUES ('%s','%s',1,now(),'harness','blocked','deadlock detected',"
            "'40P01','{}','{}');"
            "INSERT INTO public.accounting_cash_source_work (rake_record_id, receipt_id, source_fingerprint, status, attempts, "
            "next_attempt_at) VALUES ('%s','%s','harness','blocked',1,'%s');" % (rid, rr, rr, rid, attempt_at))


def case_retry_busy_key(cl, ctl, run):
    """The same pair through fn_retry_cash_accounting_sources: two refused sources, rrB due before rrA,
    retried while the finish holds club A."""
    I = seed_busy_key_pair(ctl, run, 'R')
    # Only these two are due: refusals left by earlier cases are parked, because since 20261019171753
    # the retry reads a window of due sources and would otherwise run those as well.
    ctl.run("UPDATE public.accounting_cash_source_work SET next_attempt_at = 'infinity' WHERE status = 'blocked';")
    # The oldest due sources in the cluster, so a limit of 2 selects exactly these two, rrB first.
    seed_blocked_work(ctl, I['rrB'], '1990-01-01T00:00:00Z')
    seed_blocked_work(ctl, I['rrA'], '1990-01-01T00:00:01Z')
    work = "SELECT string_agg(status || ':' || attempts, ',' ORDER BY next_attempt_at) FROM public.accounting_cash_source_work " \
           "WHERE rake_record_id IN ('%s','%s');" % (I['rrB'], I['rrA'])
    with Case(cl, ctl, run, 'retry-vs-finish-on-a-busy-key', 'cash retry (club B source, then club A source) x union '
              'finish (club A, then B) while the finish holds club A') as c:
        ctl.run('SELECT pg_advisory_lock(%d);' % GATE)
        F, B = c.session('finish'), c.session('retry')
        tf = F.send("BEGIN; SET LOCAL harness.pause_before = '%s'; %s" % (I['YB'], finish_sql(I['t'], I['A'])))
        c.notes['finish_paused_holding_club_a'] = wait_until_waiting(ctl, F)
        tb = B.send('BEGIN; SELECT fn_retry_cash_accounting_sources(2);')
        if run in ('sorted', 'skipping', 'keyed', 'budgeted'):
            c.notes['retry'] = outcome(B.wait(tb)); B.run('COMMIT;')
            c.notes['work_while_deferred'] = ctl.run(work)
            ctl.run('SELECT pg_advisory_unlock(%d);' % GATE)
            c.notes['finish'] = outcome(F.wait(tf)); F.run('COMMIT;')
            c.notes['retried_again'] = outcome(B.run('SELECT fn_retry_cash_accounting_sources(2);'))
        else:
            c.notes['retry_waited'] = wait_until_waiting(ctl, B)
            ctl.run('SELECT pg_advisory_unlock(%d);' % GATE)
            tfc, tbc = F.send('COMMIT;'), B.send('COMMIT;')
            c.notes['finish'] = outcome(F.wait(tf)); F.wait(tfc)
            c.notes['retry'] = outcome(B.wait(tb)); B.wait(tbc)
        c.notes['work'] = ctl.run(work)
        c.notes['commissions'] = commissions_written(ctl, I)
        return c.result()


def commission_key_sql(club):
    return "SELECT pg_advisory_xact_lock(hashtextextended('agent-commission:%s',0));" % club


def call_json(sess, sql):
    """One SELECT returning a jsonb, read back as a dict."""
    out = sess.run(sql)
    return json.loads(out.splitlines()[-1])


def case_retry_starvation(cl, ctl, run):
    """Production 2026-10-19 17:00, in miniature. Two clubs M < L (Midway's keys are the lowest
    uuids, Lightning's sorts after). The due refusals, fewest refusals then due time: L0, then M1..M4
    (the head five), then L5..L7. A finish holds club M's key throughout. Three retry calls of
    p_limit 5. Production's text ('sorted'): each call's walk ends at busy M, all five head sources
    are deferred, the same five come back, and nothing - not L0, not L5..L7 - ever runs.
    20261019171753 ('skipping'): the walk skips M, takes L, and the first call runs L0 and L5..L7.
    Then the finish commits and one more call runs the M sources."""
    names = ['XM', 'XL', 'aM', 'aL', 'tM', 'tL'] + ['p%d' % i for i in range(8)] + ['rr%d' % i for i in range(8)] + \
        ['h%d' % i for i in range(8)]
    I = ids(run, 'S', *names)
    I.update(ordered(run, 'Sclubs', 'M', 'L'))
    for club in ('M', 'L'):
        seed_club(ctl, I[club])
    seed_profiles(ctl, I['XM'], I['XL'], *[I['p%d' % i] for i in range(8)])
    seed_agent(ctl, I['aM'], I['M'], I['XM'])
    seed_agent(ctl, I['aL'], I['L'], I['XL'])
    layout = [('L', 0), ('M', 1), ('M', 2), ('M', 3), ('M', 4), ('L', 5), ('L', 6), ('L', 7)]
    # Only these eight are due: every other refusal left by earlier cases is parked for this case.
    ctl.run("UPDATE public.accounting_cash_source_work SET next_attempt_at = 'infinity' WHERE status = 'blocked';")
    for club, i in layout:
        seed_cash_record(ctl, I['rr%d' % i], I['h%d' % i], I[club], I['t' + club], I['p%d' % i], 1.00,
                         [tier(I['X' + club], I['a' + club], 0.30, 1)])
        seed_blocked_work(ctl, I['rr%d' % i], '1980-01-01T00:00:%02dZ' % i)
    # As a multiset (ordered by status), so a processed row's new due time cannot reorder it.
    work = ("SELECT string_agg(status || ':' || attempts, ',' ORDER BY status, attempts) FROM public.accounting_cash_source_work "
            "WHERE rake_record_id IN (%s);")
    l_rows = work % ','.join("'%s'" % I['rr%d' % i] for _, i in layout if _ == 'L')
    m_rows = work % ','.join("'%s'" % I['rr%d' % i] for _, i in layout if _ == 'M')
    with Case(cl, ctl, run, 'retry-queue-head-on-a-busy-key', 'cash retry queue whose head waits on a busy lower club key, '
              'free-keyed sources behind it') as c:
        H, R = c.session('finish'), c.session('retry')
        H.run('BEGIN; ' + commission_key_sql(I['M']))
        calls = []
        for _ in range(3):
            j = call_json(R, 'SELECT fn_retry_cash_accounting_sources(5)::text;')
            calls.append({'ok': j['ok'], 'blocked': j['blocked'], 'deferred': len(j.get('deferred') or [])})
        c.notes['calls_while_m_busy'] = calls
        c.notes['l_while_m_busy'] = ctl.run(l_rows)
        c.notes['m_while_m_busy'] = ctl.run(m_rows)
        H.run('COMMIT;')
        j = call_json(R, 'SELECT fn_retry_cash_accounting_sources(5)::text;')
        c.notes['call_after_release'] = {'ok': j['ok'], 'blocked': j['blocked'], 'deferred': len(j.get('deferred') or [])}
        c.notes['l_after'] = ctl.run(l_rows)
        c.notes['m_after'] = ctl.run(m_rows)
        c.notes['commission_rows'] = {k: int(ctl.run("SELECT count(*) FROM public.agent_commissions WHERE user_id = '%s';" % I[k]))
                                      for k in ('XM', 'XL')}
        return c.result()


RETRY_DRAIN_BUDGET_S = 30.0   # CASH_RETRY_DRAIN_BUDGET_MS in RakebackSettlerService.ts
RETRY_LIMIT = 5               # CASH_RETRY_LIMIT at the engine's 15 s client budget


def case_retry_backlog_drain(cl, ctl, run, n=400):
    """2026-10-19 19:48: 12,135 Midway sources due after their cause was fixed, retried five a run
    (one fn_retry_cash_accounting_sources(5) per settler inner run): 40 an hour. Here N due refusals
    over two clubs, each with its own agent, are drained the way each engine does it. 'one-call-a-run':
    one call per inner run, three runs (one drain cycle). 'drain': the run calls again while a call
    comes back full and settled something, within the 30 s run budget, exactly as
    drainCashSourceRetries(). Every source must accrue exactly once and every call must stay inside
    the 8 s server budget."""
    names = ['XM', 'XL', 'aM', 'aL', 'tM', 'tL'] + ['p%d' % i for i in range(10)]
    I = ids(run, 'RB', *names)
    I.update(ordered(run, 'RBclubs', 'M', 'L'))
    for club in ('M', 'L'):
        seed_club(ctl, I[club])
    seed_profiles(ctl, I['XM'], I['XL'], *[I['p%d' % i] for i in range(10)])
    seed_agent(ctl, I['aM'], I['M'], I['XM'])
    seed_agent(ctl, I['aL'], I['L'], I['XL'])
    ctl.run("UPDATE public.accounting_cash_source_work SET next_attempt_at = 'infinity' WHERE status = 'blocked';")
    rr = ids(run, 'RBrr', *['rr%d' % i for i in range(n)])
    hh = ids(run, 'RBhh', *['h%d' % i for i in range(n)])
    for i in range(n):
        club = 'M' if i % 3 else 'L'
        seed_cash_record(ctl, rr['rr%d' % i], hh['h%d' % i], I[club], I['t' + club], I['p%d' % (i % 10)], 1.00,
                         [tier(I['X' + club], I['a' + club], 0.30, 1)])
        seed_blocked_work(ctl, rr['rr%d' % i], '1980-01-01T00:00:00Z')
    in_list = ','.join("'%s'" % v for v in rr.values())
    status = ("SELECT string_agg(status || ':' || n, ',' ORDER BY status) FROM (SELECT status, count(*) n FROM "
              "public.accounting_cash_source_work WHERE rake_record_id IN (%s) GROUP BY status) s;" % in_list)

    def call(R):
        t = time.time()
        j = call_json(R, 'SELECT fn_retry_cash_accounting_sources(%d)::text;' % RETRY_LIMIT)
        return j, time.time() - t

    with Case(cl, ctl, run, 'retry-backlog-drain', '%d due cash refusals, retried the way the engine runs' % n) as c:
        R = c.session('retry')
        # The engine before: one call per inner run, three inner runs per drain cycle.
        one = 0
        for _ in range(3):
            j, _s = call(R)
            one += j['ok']
        c.notes['one_call_a_run'] = {'runs': 3, 'accrued': one}
        # The engine now: each run drains while calls come back full and settle something.
        runs, calls, longest, accrued, t0 = [], 0, 0.0, 0, time.time()
        while True:
            deadline, run_calls, run_ok, full = time.time() + RETRY_DRAIN_BUDGET_S, 0, 0, False
            while True:
                j, secs = call(R)
                run_calls += 1
                longest = max(longest, secs)
                run_ok += j['ok']
                full = j['ok'] + j['blocked'] + len(j.get('deferred') or []) == RETRY_LIMIT
                if not full or j['ok'] + j['blocked'] == 0 or time.time() >= deadline:
                    break
            runs.append({'calls': run_calls, 'accrued': run_ok})
            calls += run_calls
            accrued += run_ok
            if not full or len(runs) >= 50:
                break
        elapsed = time.time() - t0
        c.notes['drain'] = {'runs': runs, 'calls': calls, 'accrued': accrued, 'seconds': round(elapsed, 2),
                            'longest_call_seconds': round(longest, 3),
                            'sources_per_second': round(accrued / elapsed, 1) if elapsed else None}
        c.notes['work_after'] = ctl.run(status)
        c.notes['commission_rows'] = int(ctl.run(
            "SELECT count(*) FROM public.agent_commissions WHERE user_id IN ('%s','%s');" % (I['XM'], I['XL'])))
        c.notes['n'] = n
        return c.result()


def case_batch_skips_busy_key(cl, ctl, run):
    """A page batch of two cash items, rrM (club M) then rrL (club L), while a finish holds club M's
    key (M < L). Production's text: the walk ends at M and both are deferred, though rrL needs only
    the free key L. 20261019171753: rrL runs, rrM alone is deferred; after the finish commits the
    settler's resubmission runs rrM. Every commission is written once."""
    I = ids(run, 'BS', 'XM', 'XL', 'aM', 'aL', 'pM', 'pL', 'rrM', 'rrL', 'hM', 'hL', 'tM', 'tL')
    I.update(ordered(run, 'BSclubs', 'M', 'L'))
    for club in ('M', 'L'):
        seed_club(ctl, I[club])
    seed_profiles(ctl, I['XM'], I['XL'], I['pM'], I['pL'])
    seed_agent(ctl, I['aM'], I['M'], I['XM'])
    seed_agent(ctl, I['aL'], I['L'], I['XL'])
    seed_cash_record(ctl, I['rrM'], I['hM'], I['M'], I['tM'], I['pM'], 1.00, [tier(I['XM'], I['aM'], 0.30, 1)])
    seed_cash_record(ctl, I['rrL'], I['hL'], I['L'], I['tL'], I['pL'], 1.00, [tier(I['XL'], I['aL'], 0.30, 1)])
    with Case(cl, ctl, run, 'batch-item-behind-a-busy-key', 'cash batch (club M item, club L item) while a finish holds '
              'club M') as c:
        H, B = c.session('finish'), c.session('batch')
        H.run('BEGIN; ' + commission_key_sql(I['M']))
        j = call_json(B, batch_sql(I['rrM'], I['rrL']).replace(');', ')::text;'))
        c.notes['batch'] = {'ok': j['ok'], 'blocked': j['blocked'], 'deferred': sorted(
            'rrM' if d == I['rrM'] else 'rrL' for d in (j.get('deferred') or []))}
        H.run('COMMIT;')
        resubmit = [I[k] for k in ('rrM', 'rrL') if k in c.notes['batch']['deferred']]
        j = call_json(B, batch_sql(*resubmit).replace(');', ')::text;'))
        c.notes['resubmitted'] = {'ok': j['ok'], 'blocked': j['blocked'], 'deferred': len(j.get('deferred') or [])}
        c.notes['commission_rows'] = {k: int(ctl.run("SELECT count(*) FROM public.agent_commissions WHERE user_id = '%s';" % I[k]))
                                      for k in ('XM', 'XL')}
        return c.result()


def case_items_behind_held_rows(cl, ctl, run, held=3):
    """2026-10-19 17:02 in miniature. One club, five cash sources, each crediting its own agent. A
    long transaction holds the agents rows of the first `held` sources (production: one holder kept
    a profiles and a union_wallets row ~45 s after the break). The batch session runs with the
    engine role's lock_timeout of 8 s. Production's text waits 8 s per blocked item, so three of them
    make a ~24 s call - past the engine's 15 s. 20261019190103 waits 2 s per item and starts no item
    after 8 s, so the same call returns in ~6 s; with five held rows the fifth item is deferred."""
    names = ['C', 't'] + ['X%d' % i for i in range(5)] + ['a%d' % i for i in range(5)] + ['p%d' % i for i in range(5)] + \
        ['rr%d' % i for i in range(5)] + ['h%d' % i for i in range(5)]
    I = ids(run, 'HR%d' % held, *names)
    seed_club(ctl, I['C'])
    seed_profiles(ctl, *[I['X%d' % i] for i in range(5)], *[I['p%d' % i] for i in range(5)])
    for i in range(5):
        seed_agent(ctl, I['a%d' % i], I['C'], I['X%d' % i])
        seed_cash_record(ctl, I['rr%d' % i], I['h%d' % i], I['C'], I['t'], I['p%d' % i], 1.00,
                         [tier(I['X%d' % i], I['a%d' % i], 0.30, 1)])
    key = 'batch-items-behind-held-rows' if held == 3 else 'batch-runs-out-of-budget'
    with Case(cl, ctl, run, key, 'cash batch of five while a long transaction holds %d of their agent rows '
              '(session lock_timeout 8 s)' % held) as c:
        H, B = c.session('holder'), c.session('batch')
        H.run("BEGIN; SELECT 1 FROM public.agents WHERE id IN (%s) FOR UPDATE;"
              % ','.join("'%s'" % I['a%d' % i] for i in range(held)))
        B.run("SET lock_timeout = '8s';")
        t0 = time.time()
        j = call_json(B, batch_sql(*[I['rr%d' % i] for i in range(5)]).replace(');', ')::text;'))
        c.notes['call_seconds'] = round(time.time() - t0, 2)
        c.notes['batch'] = {'ok': j['ok'], 'blocked': j['blocked'], 'deferred': len(j.get('deferred') or [])}
        c.notes['lock_timeout_after'] = B.run('SHOW lock_timeout;').splitlines()[-1]
        H.run('COMMIT;')
        deferred = j.get('deferred') or []
        if deferred:
            r2 = call_json(B, batch_sql(*deferred).replace(');', ')::text;'))
            c.notes['resubmitted'] = {'ok': r2['ok'], 'blocked': r2['blocked'], 'deferred': len(r2.get('deferred') or [])}
        c.notes['commission_rows'] = sum(int(ctl.run("SELECT count(*) FROM public.agent_commissions WHERE user_id = '%s';"
                                                     % I['X%d' % i])) for i in range(5))
        return c.result()


CASES = [case_commission_one_club, case_commission_two_clubs, case_finish_vs_hand, case_finish_vs_two_hands,
         case_finish_vs_horse_claims] + [
    (lambda fn: (lambda cl, ctl, run: case_horse_mind(cl, ctl, run, fn)))(fn) for fn in HORSE] + [case_pr5542, case_batch_key_held]


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
        for state in ('before', 'after', 'sorted', 'skipping', 'keyed', 'budgeted'):
            if state == 'sorted':
                ctl.close()
                report['sorted_fix_subs_block_md5'] = apply_migration(cl, SORTED_FIX)
                ctl = Session(cl, 'ctl')
            if state == 'skipping':
                ctl.close()
                report['skip_fix_subs_block_md5'] = apply_migration(cl, SKIP_FIX)
                ctl = Session(cl, 'ctl')
            if state == 'keyed':
                ctl.close()
                report['budget_on_171753_text'] = probe_budget_rolled_back(cl)
                report['keyed_bodies'] = apply_keyed(cl)
                ctl = Session(cl, 'ctl')
            if state == 'budgeted':
                ctl.close()
                report['budget_fix_subs_block_md5'] = apply_migration(cl, BUDGET_FIX)
                ctl = Session(cl, 'ctl')
            if state == 'after':
                ctl.close()
                report['migration_subs_block_md5'] = apply_migration(cl)
                report['revert_subs_block_md5'] = apply_migration(cl, REVERT)
                ctl = Session(cl, 'ctl')
                r = case_batch_key_held(cl, ctl, 'after-0000-0500')
                ctl.close()
                report['results'].append(r)
                print('%-34s %-15s %s' % (r['case'], r['state'], r['batch']), flush=True)
                report['keys_fix_subs_block_md5'] = apply_migration(cl, KEYS_FIX)
                projection2_functions(cl)
                ctl = Session(cl, 'ctl')
            for case in CASES:
                r = case(cl, ctl, state)
                report['results'].append(r)
                print('%-34s %-6s deadlocks=%d  %s' % (r['case'], state, r['deadlocks'],
                      {k: v for k, v in r.items() if k not in ('case', 'pair', 'state', 'deadlocks')}), flush=True)
            # The 2026-10-19 pair: production's text ('after') against 20261019094914 ('sorted').
            if state in ('after', 'sorted', 'skipping', 'keyed', 'budgeted'):
                busy = [case_batch_busy_key, case_retry_busy_key]
                if state in ('sorted', 'skipping', 'keyed', 'budgeted'):
                    busy.append(lambda cl, ctl, run: case_batch_busy_key(cl, ctl, run, hold_past_wait=False))
                    busy += [case_batch_skips_busy_key, case_retry_starvation]
                if state in ('skipping', 'keyed', 'budgeted'):
                    busy.append(case_items_behind_held_rows)
                if state == 'budgeted':
                    busy.append(lambda cl, ctl, run: case_items_behind_held_rows(cl, ctl, run, held=5))
                    busy.append(case_retry_backlog_drain)
                for case in busy:
                    r = case(cl, ctl, state)
                    report['results'].append(r)
                    print('%-34s %-6s deadlocks=%d  %s' % (r['case'], state, r['deadlocks'],
                          {k: v for k, v in r.items() if k not in ('case', 'pair', 'state', 'deadlocks')}), flush=True)
            report['values'][state] = horse_mind_values(cl, state)
        ctl.close()
        report['values_equal'] = (report['values']['before'] == report['values']['after']
                                  == report['values']['sorted'] == report['values']['skipping']
                                  == report['values']['keyed'] == report['values']['budgeted'])
        print('horse-mind values equal before/after:', report['values_equal'])
    finally:
        cl.stop()
    report['finished'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    held = {r['state']: r['batch'] for r in report['results'] if r['case'] == 'batch-while-a-finish-holds-a-key'}
    report['batch_while_a_key_is_held'] = held
    keys_ok = (held.get('before') == 'completed' and held.get('after-0000-0500', '').startswith('error: ERROR:  canceling statement due to lock timeout')
               and held.get('after', '').startswith('item refused and queued for retry')
               and held.get('sorted', '').startswith('deferred until its commission keys are free: 1')
               and held.get('skipping', '').startswith('deferred until its commission keys are free: 1')
               and held.get('keyed', '').startswith('deferred until its commission keys are free: 1')
               and held.get('budgeted', '').startswith('deferred until its commission keys are free: 1'))
    print('batch while a finish holds its key:', held, 'OK' if keys_ok else 'NOT AS CLAIMED')
    fixed = [r for r in report['results'] if r['state'] in ('after', 'sorted', 'skipping', 'keyed', 'budgeted') and r['case'] not in NOT_FIXED
             and r['case'] != 'batch-while-a-finish-holds-a-key'
             and not (r['state'] == 'after' and r['case'] in BUSY_KEY_CASES)]
    by = {(r['case'], r['state']): r for r in report['results']}
    once = {'XA': 1, 'XB': 1, 'YA': 1, 'YB': 1}
    busy_ok = (
        # production's text deadlocks on the 2026-10-19 interleaving, batch and retry alike
        all(by[(k, 'after')]['deadlocks'] > 0 for k in BUSY_KEY_CASES)
        # 20261019094914 does not, and every commission tier is written exactly once
        and all(by[(k, 'sorted')]['deadlocks'] == 0 and by[(k, 'sorted')]['commissions'] == once
                for k in BUSY_KEY_CASES + ('batch-waits-briefly-for-a-busy-key',))
        # a key still busy after 1 s defers both items, writes nothing, refuses nothing
        and by[('batch-vs-finish-on-a-busy-key', 'sorted')]['batch'] == 'deferred until its commission keys are free: 2'
        and by[('batch-vs-finish-on-a-busy-key', 'sorted')]['written_while_deferred'] == {'XA': 0, 'XB': 0, 'YA': 0, 'YB': 0}
        and by[('batch-vs-finish-on-a-busy-key', 'sorted')]['finish'] == 'completed'
        and by[('batch-vs-finish-on-a-busy-key', 'sorted')]['resubmitted'] == 'completed'
        # a deferred retry leaves its blocked work exactly as it was, and accrues on the next retry
        and by[('retry-vs-finish-on-a-busy-key', 'sorted')]['retry'] == 'deferred until its commission keys are free: 2'
        and by[('retry-vs-finish-on-a-busy-key', 'sorted')]['work_while_deferred'] == 'blocked:1,blocked:1'
        and by[('retry-vs-finish-on-a-busy-key', 'sorted')]['retried_again'] == 'completed'
        and by[('retry-vs-finish-on-a-busy-key', 'sorted')]['work'] == 'accrued:2,accrued:2'
        # a key freed inside the wait is taken in order and both items run in the same call
        and by[('batch-waits-briefly-for-a-busy-key', 'sorted')]['batch'] == 'completed'
        and by[('batch-waits-briefly-for-a-busy-key', 'sorted')]['finish'] == 'completed')
    report['busy_key_ok'] = busy_ok
    q = lambda case, state: by[(case, state)]
    none = {'ok': 0, 'blocked': 0, 'deferred': 5}
    skip_ok = (
        # 2026-10-19 17:00 reproduced on production's text: a head waiting on busy M runs nothing,
        # call after call, and nothing behind it (club L, free) is ever reached
        q('retry-queue-head-on-a-busy-key', 'sorted')['calls_while_m_busy'] == [none, none, none]
        and q('retry-queue-head-on-a-busy-key', 'sorted')['l_while_m_busy'] == 'blocked:1,blocked:1,blocked:1,blocked:1'
        and q('retry-queue-head-on-a-busy-key', 'sorted')['call_after_release'] == {'ok': 5, 'blocked': 0, 'deferred': 0}
        and q('retry-queue-head-on-a-busy-key', 'sorted')['l_after'] == 'accrued:2,blocked:1,blocked:1,blocked:1'
        # 20261019171753: the first call runs every free-keyed source, the busy-keyed head waits untouched
        and q('retry-queue-head-on-a-busy-key', 'skipping')['calls_while_m_busy'][0] == {'ok': 4, 'blocked': 0, 'deferred': 1}
        and q('retry-queue-head-on-a-busy-key', 'skipping')['l_while_m_busy'] == 'accrued:2,accrued:2,accrued:2,accrued:2'
        and q('retry-queue-head-on-a-busy-key', 'skipping')['m_while_m_busy'] == 'blocked:1,blocked:1,blocked:1,blocked:1'
        and q('retry-queue-head-on-a-busy-key', 'skipping')['call_after_release'] == {'ok': 4, 'blocked': 0, 'deferred': 0}
        and q('retry-queue-head-on-a-busy-key', 'skipping')['m_after'] == 'accrued:2,accrued:2,accrued:2,accrued:2'
        and q('retry-queue-head-on-a-busy-key', 'skipping')['commission_rows'] == {'XM': 4, 'XL': 4}
        # the batch: an item needing only a free key is no longer deferred for an unrelated busy one
        and q('batch-item-behind-a-busy-key', 'sorted')['batch'] == {'ok': 0, 'blocked': 0, 'deferred': ['rrL', 'rrM']}
        and q('batch-item-behind-a-busy-key', 'skipping')['batch'] == {'ok': 1, 'blocked': 0, 'deferred': ['rrM']}
        and all(q('batch-item-behind-a-busy-key', st)['commission_rows'] == {'XM': 1, 'XL': 1}
                and q('batch-item-behind-a-busy-key', st)['resubmitted']['deferred'] == 0 for st in ('sorted', 'skipping'))
        # the 2026-10-19 deadlock pair stays fixed with the gaps, and every commission is written once
        and all(q(k, 'skipping')['deadlocks'] == 0 and q(k, 'skipping')['commissions'] == once
                for k in BUSY_KEY_CASES + ('batch-waits-briefly-for-a-busy-key',))
        and q('batch-vs-finish-on-a-busy-key', 'skipping')['batch'] == 'deferred until its commission keys are free: 1'
        and q('batch-vs-finish-on-a-busy-key', 'skipping')['written_while_deferred'] == {'XA': 0, 'XB': 1, 'YA': 0, 'YB': 0}
        and q('batch-vs-finish-on-a-busy-key', 'skipping')['finish'] == 'completed'
        and q('batch-vs-finish-on-a-busy-key', 'skipping')['resubmitted'] == 'completed'
        and q('retry-vs-finish-on-a-busy-key', 'skipping')['retry'] == 'deferred until its commission keys are free: 1'
        and q('retry-vs-finish-on-a-busy-key', 'skipping')['work_while_deferred'] == 'blocked:1,accrued:2'
        and q('retry-vs-finish-on-a-busy-key', 'skipping')['retried_again'] == 'completed'
        and q('retry-vs-finish-on-a-busy-key', 'skipping')['work'] == 'accrued:2,accrued:2'
        and q('batch-waits-briefly-for-a-busy-key', 'skipping')['batch'] == 'completed')
    report['skip_ok'] = skip_ok
    budget_ok = (
        # 2026-10-19 17:02 reproduced on production's text: three items behind held rows, 8 s each
        q('batch-items-behind-held-rows', 'skipping')['call_seconds'] >= 15
        and q('batch-items-behind-held-rows', 'skipping')['batch'] == {'ok': 2, 'blocked': 3, 'deferred': 0}
        # and on production's installed text, 20261019194410's
        and q('batch-items-behind-held-rows', 'keyed')['call_seconds'] >= 15
        and q('batch-items-behind-held-rows', 'keyed')['batch'] == {'ok': 2, 'blocked': 3, 'deferred': 0}
        # 20261019190103: the same call fits the engine's budget, with the same outcome
        and q('batch-items-behind-held-rows', 'budgeted')['call_seconds'] < 9.5
        and q('batch-items-behind-held-rows', 'budgeted')['batch'] == {'ok': 2, 'blocked': 3, 'deferred': 0}
        and q('batch-items-behind-held-rows', 'budgeted')['lock_timeout_after'] == '8s'
        and all(q('batch-items-behind-held-rows', st)['commission_rows'] == 2 for st in ('skipping', 'keyed', 'budgeted'))
        # five held rows: the call stops at its 8 s and defers the rest, which the resubmission accrues
        and q('batch-runs-out-of-budget', 'budgeted')['call_seconds'] < 9.5
        and q('batch-runs-out-of-budget', 'budgeted')['batch'] == {'ok': 0, 'blocked': 4, 'deferred': 1}
        and q('batch-runs-out-of-budget', 'budgeted')['resubmitted'] == {'ok': 1, 'blocked': 0, 'deferred': 0}
        and q('batch-runs-out-of-budget', 'budgeted')['commission_rows'] == 1
        # and everything 20261019171753 established still holds under the budget
        and q('retry-queue-head-on-a-busy-key', 'budgeted')['calls_while_m_busy'][0] == {'ok': 4, 'blocked': 0, 'deferred': 1}
        and q('retry-queue-head-on-a-busy-key', 'budgeted')['m_after'] == 'accrued:2,accrued:2,accrued:2,accrued:2'
        and q('retry-queue-head-on-a-busy-key', 'budgeted')['commission_rows'] == {'XM': 4, 'XL': 4}
        and q('batch-item-behind-a-busy-key', 'budgeted')['batch'] == {'ok': 1, 'blocked': 0, 'deferred': ['rrM']}
        and all(q(k, 'budgeted')['deadlocks'] == 0 and q(k, 'budgeted')['commissions'] == once
                for k in BUSY_KEY_CASES + ('batch-waits-briefly-for-a-busy-key',))
        and q('batch-vs-finish-on-a-busy-key', 'budgeted')['batch'] == 'deferred until its commission keys are free: 1'
        and q('retry-vs-finish-on-a-busy-key', 'budgeted')['work'] == 'accrued:2,accrued:2')
    report['budget_ok'] = budget_ok
    rb = q('retry-backlog-drain', 'budgeted')
    drain_ok = (
        # 2026-10-19 19:48: one call a run retries five a run, three a cycle
        rb['one_call_a_run'] == {'runs': 3, 'accrued': 3 * RETRY_LIMIT}
        # drainCashSourceRetries(): the rest of the backlog accrues, every source once, inside the run
        # budget, every call inside the 8 s server budget, the last call short (the queue is empty)
        and rb['drain']['accrued'] == rb['n'] - 3 * RETRY_LIMIT
        and rb['work_after'] == 'accrued:%d' % rb['n']
        and rb['commission_rows'] == rb['n']
        and rb['drain']['longest_call_seconds'] < 8.0
        and rb['deadlocks'] == 0)
    report['drain_ok'] = drain_ok
    probe = report.get('budget_on_171753_text') or {}
    either_ok = (
        # on production's installed text (20261019194410's batch) the budget lands on the combined body
        (report.get('keyed_bodies') or {}).get('batch') == '9befae963f3b9cda25b357f60a9b53d7'
        # and on 20261019171753's text, the other accepted preimage, on the budget-only body
        and probe.get('batch_before') == '1ae9eb0e32f8169ce0cdd6b730c859a6'
        and probe.get('batch_inside') == '6c9a388585158521f0ac36300d5124fd'
        and probe.get('retry_inside') == 'df10ba64229df0c99918dad77f39aec7'
        and probe.get('batch_after_rollback') == '1ae9eb0e32f8169ce0cdd6b730c859a6')
    report['either_order_ok'] = either_ok
    print('20261019214727 accepts 20261019194410\'s and 20261019171753\'s texts:', 'OK' if either_ok else 'NOT AS CLAIMED',
          report.get('keyed_bodies'), probe)
    print('2026-10-19 retry backlog (%d due: one call a run drains %d a cycle; the drain loop drains the rest, %s/s):'
          % (rb['n'], rb['one_call_a_run']['accrued'], rb['drain']['sources_per_second']),
          'OK' if drain_ok else 'NOT AS CLAIMED')
    print('2026-10-19 17:02 slow call (production text > 15 s, 20261019214727 < 9.5 s):',
          'OK' if budget_ok else 'NOT AS CLAIMED')
    print('2026-10-19 17:00 starvation (production text starves, 20261019171753 does not):',
          'OK' if skip_ok else 'NOT AS CLAIMED')
    print('2026-10-19 busy-key pair (deadlocks on production text, not after 20261019094914):',
          'OK' if busy_ok else 'NOT AS CLAIMED')
    ok = (all(r['deadlocks'] == 0 for r in fixed)
          and all(r['deadlocks'] > 0 for r in report['results'] if r['state'] == 'before' and r['case'] != 'batch-while-a-finish-holds-a-key')
          and report['values_equal'] and keys_ok and busy_ok and skip_ok and budget_ok and drain_ok and either_ok)
    print('CHIP DEADLOCKS: %s' % ('every fixed pair deadlocks before and not after' if ok else 'NOT AS CLAIMED'))
    report['passed'] = ok
    if a.out:
        pathlib.Path(a.out).write_text(json.dumps(report, indent=2) + '\n')
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
