#!/usr/bin/env python3
"""Real PostgreSQL 17 qualification of 20261019151125 on the exact live bodies.

The four engine writers (insert_hole_cards, save_hand_state_snapshot,
fn_ca_process_hand_post_commit_obligations, fn_project_hand_side_effects) and
both F06 hand guards are installed from their md5-pinned production text.
Real concurrent backends then show, before the migration, the production
defect (a writer of one table refused while its tournament lane is held or
queued exclusively) and, after it, that the writer waits for the lane (bounded),
that two tables of one tournament still write concurrently, that an exclusive
tournament authority still cannot overlap a writer, and that a writer which
waited still sees and obeys the fence its authority committed.
"""
import argparse
import hashlib
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=False)
pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
cluster = Path(tempfile.mkdtemp(prefix='writers-lane-', dir=os.environ.get('TMPDIR')))
socket = cluster / 'socket'
socket.mkdir(mode=0o700)
port = os.environ.get('WRITERS_LANE_TEST_PORT', '55719')
base_env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
base_env['LC_ALL'] = 'C'
cmd = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
       '-h', str(socket), '-p', port, '-U', 'postgres', '-d', 'postgres']
MIGRATION = 'supabase/migrations/20261019151125_tournament_table_writers_wait_for_their_shared_lane.sql'
migration = (ROOT / MIGRATION).read_text()
rows = json.loads((ROOT / 'scripts/dev/fixtures/tournament-table-writers-lane-preimages.json').read_text())
require_hash = '14a5bd2d30427f5682f358b342e19fa2300616de5911faad7f586272919db1d2'
if hashlib.sha256(migration.encode()).hexdigest() != require_hash:
    raise RuntimeError('qualified migration bytes changed')
results = {'passed': False, 'migration_sha256': hashlib.sha256(migration.encode()).hexdigest(), 'cases': []}

T1 = '00000000-0000-4000-8000-000000000099'   # the tournament under test
T2 = '00000000-0000-4000-8000-000000000098'   # an unrelated tournament
A = '00000000-0000-4000-8000-00000000000a'    # T1 table A
B = '00000000-0000-4000-8000-00000000000b'    # T1 table B
C = '00000000-0000-4000-8000-00000000000c'    # T2 table C
D = '00000000-0000-4000-8000-00000000000d'    # cash table (no tournament)
HA = '00000000-0000-4000-8000-0000000000a7'   # accepted hand 7 at table A
HB = '00000000-0000-4000-8000-0000000000b7'   # accepted hand 7 at table B
U = '00000000-0000-4000-8000-000000000001'
G_LANE = 'ca:tournament-terminal-settlement:v1'
T1_LANE = G_LANE + ':' + T1
T2_LANE = G_LANE + ':' + T2


def execute(argv, sql=None, app='qualify', timeout=40):
    env = dict(base_env, PGAPPNAME=app)
    return subprocess.run([str(x) for x in argv], input=sql, text=True, capture_output=True, env=env, timeout=timeout)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def record(name, passed, elapsed, detail=''):
    results['cases'].append({'name': name, 'passed': passed, 'elapsedSeconds': round(elapsed, 3)})
    (out / (name + '.log')).write_text(detail)
    require(passed, name + ': ' + detail[-2000:])


def run(name, sql, expected=None, error=None):
    before = time.monotonic()
    r = execute(cmd, sql)
    elapsed = time.monotonic() - before
    passed = (r.returncode != 0 and error in r.stderr) if error else r.returncode == 0
    if expected is not None:
        passed = passed and r.stdout.rstrip('\n') == expected
    record(name, passed, elapsed, r.stdout + r.stderr)
    return r.stdout.rstrip('\n')


def q(sql):
    r = execute(cmd, sql)
    require(r.returncode == 0, r.stderr)
    return r.stdout.rstrip('\n')


CARDS = lambda t: "SELECT public.insert_hole_cards('" + t + "',7,'[{\"user_id\":\"" + U + "\",\"seat_number\":1,\"cards\":[\"As\",\"Kd\"]}]');"
# Hand 8: save_hand_state_snapshot skips a hand already committed (hand 7).
SNAP = lambda t: "SELECT public.save_hand_state_snapshot('" + t + "',8,'{}'::jsonb,'{}'::jsonb,1,'[]'::jsonb,'preflop');"
POST = lambda h: "SELECT public.fn_ca_process_hand_post_commit_obligations('" + h + "')->>'ok';"
PROJ = lambda h: "SELECT public.fn_project_hand_side_effects('" + h + "')->>'ok';"
WRITERS_A = [('cards', CARDS(A)), ('snapshot', SNAP(A)), ('post-commit', POST(HA)), ('projection', PROJ(HA))]


def as_writer(sql, end='ROLLBACK'):
    return 'BEGIN;\nSET ROLE service_role;\n' + sql + '\n' + end + ';\n'


class Session:
    """One real backend driven over stdin; ready() is proven through pg_locks."""
    _n = 0

    def __init__(self, sql_before_barrier):
        Session._n += 1
        self.barrier = 19151000 + Session._n
        self.app = 'session-' + str(Session._n)
        env = dict(base_env, PGAPPNAME=self.app)
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        self.p.stdin.write(sql_before_barrier + '\nSELECT pg_advisory_lock(' + str(self.barrier) + ');\n')
        self.p.stdin.flush()
        deadline = time.monotonic() + 8
        while q("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=" + str(self.barrier) + " AND granted);") != 't':
            require(self.p.poll() is None and time.monotonic() < deadline, 'session barrier absent: ' + (self.p.stderr.read() if self.p.poll() is not None else ''))
            time.sleep(.02)

    def finish(self, end):
        self.p.stdin.write(end + ';\n')
        self.p.stdin.close()
        o, e = self.p.communicate(timeout=20)
        require(self.p.returncode == 0, self.app + ' failed: ' + e)
        return o + e


@contextmanager
def holding(sql, end='ROLLBACK'):
    s = Session('BEGIN;\n' + sql)
    try:
        yield s
    finally:
        if s.p.poll() is None:
            s.finish(end)


def xlock(lane):
    return "SELECT pg_advisory_xact_lock(hashtextextended('" + lane + "',0));"


def slock(lane):
    return "SELECT pg_advisory_xact_lock_shared(hashtextextended('" + lane + "',0));"


class Writer(threading.Thread):
    def __init__(self, sql, end='ROLLBACK'):
        super().__init__(daemon=True)
        Session._n += 1
        self.app = 'writer-' + str(Session._n)
        self.sql = as_writer(sql, end)
        self.r = None

    def run(self):
        t0 = time.monotonic()
        self.r = execute(cmd, self.sql, app=self.app)
        self.elapsed = time.monotonic() - t0


def wait_until_waiting(app):
    deadline = time.monotonic() + 5
    while True:
        st = q("SELECT COALESCE((SELECT wait_event_type FROM pg_stat_activity WHERE application_name='" + app + "'),'none');")
        if st == 'Lock':
            return
        require(time.monotonic() < deadline, app + ' never waited (state ' + st + ')')
        time.sleep(.02)


def locks_held_while_waiting(app):
    """Everything the waiting writer holds besides its own virtual/xid locks.
    The one advisory lock it may hold is G shared: the key is checked."""
    return q("SELECT COALESCE(string_agg(l.locktype||':'||l.mode||':'||COALESCE(c.relname,'')"
             "||CASE WHEN l.locktype='advisory' AND ((l.classid::bigint<<32)|l.objid::bigint)<>hashtextextended('" + G_LANE + "',0) THEN 'NOT-G' ELSE '' END,',' ORDER BY 1),'') "
             "FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid LEFT JOIN pg_class c ON c.oid=l.relation "
             "WHERE a.application_name='" + app + "' AND l.granted AND l.locktype NOT IN ('virtualxid','transactionid') "
             "AND NOT (l.locktype='relation' AND l.mode='AccessShareLock');")


snapshot = ("SELECT jsonb_build_object('cards',(SELECT jsonb_agg(c ORDER BY table_id) FROM public.table_hole_cards c),"
            "'snaps',(SELECT jsonb_agg(s.table_id ORDER BY table_id) FROM public.hand_state_snapshots s),"
            "'commits',(SELECT jsonb_agg(jsonb_build_object('h',hand_id,'done',post_commit_completed_at IS NOT NULL) ORDER BY hand_id) FROM public.hand_atomic_commits),"
            "'fences',(SELECT count(*) FROM smarter_private.f06_prepared_hand_cancellations)+(SELECT count(*) FROM smarter_private.f06_unsettled_hand_aborts));")
SIGS = [r['signature'] for r in rows]
metadata = ("SELECT jsonb_agg(jsonb_build_object('sig',oid::regprocedure::text,'owner',proowner::regrole::text,'definer',prosecdef,"
            "'config',proconfig,'acl',proacl::text) ORDER BY oid::regprocedure::text) FROM pg_proc WHERE oid IN ("
            + ','.join("'" + s + "'::regprocedure" for s in SIGS) + ");")

try:
    require('PostgreSQL) 17.' in execute([pg / 'postgres', '--version']).stdout, 'PG17 required')
    r = execute([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    require(r.returncode == 0, r.stderr)
    r = execute([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-w', '-o',
                 "-k " + str(socket) + " -p " + port + " -h '' -c shared_buffers=16MB -c max_connections=20 -c deadlock_timeout=200ms", 'start'])
    require(r.returncode == 0, r.stderr)

    # The relations the six unchanged production bodies touch, with the columns
    # they read and write. No RPC, guard or auth function is replaced; the one
    # stub is the projection tail fn_project_hand_side_effects hands off to.
    run('ground', '''
CREATE SCHEMA smarter_private; CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto SCHEMA extensions;
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
GRANT USAGE ON SCHEMA smarter_private, extensions TO service_role, anon, authenticated;
CREATE TABLE public.clubs(id uuid PRIMARY KEY, asset text);
CREATE TABLE public.tables(id uuid PRIMARY KEY, tournament_id uuid, club_id uuid);
CREATE TABLE public.table_hole_cards(table_id uuid, hand_number integer, user_id uuid, seat_number integer, cards jsonb,
  created_at timestamptz DEFAULT now(), PRIMARY KEY(table_id, hand_number, user_id));
CREATE TABLE public.hand_state_snapshots(table_id uuid, hand_number integer, state_json jsonb, config_json jsonb, dealer_seat integer,
  players_json jsonb, stage text, pending_deadlines jsonb, disconnect_states jsonb, updated_at timestamptz, is_complete boolean NOT NULL DEFAULT false);
CREATE UNIQUE INDEX ON public.hand_state_snapshots(table_id) WHERE is_complete = FALSE;
CREATE TABLE public.hand_atomic_commits(hand_id uuid PRIMARY KEY, table_id uuid, hand_number bigint, committed_at timestamptz DEFAULT now(),
  post_commit_payload jsonb, post_commit_payload_hash text, post_commit_completed_at timestamptz, post_commit_result jsonb);
CREATE TABLE public.hand_history(id uuid PRIMARY KEY, table_id uuid, hand_number bigint, players jsonb);
CREATE TABLE public.hand_projection_outbox(hand_id uuid PRIMARY KEY, table_id uuid, hand_number bigint);
CREATE TABLE public.table_pending_addons(id uuid, table_id uuid, amount numeric, resolved_at timestamptz, applied_to_stack numeric, refunded numeric);
CREATE TABLE smarter_private.f06_hand_permits(table_id uuid, hand_number bigint, tournament_id uuid);
CREATE TABLE smarter_private.f06_unsettled_hand_aborts(table_id uuid, hand_number bigint);
CREATE TABLE smarter_private.f06_generation_abort_hands(table_id uuid, hand_number bigint);
CREATE TABLE smarter_private.f06_mixed_abort_hands(table_id uuid, hand_number bigint);
CREATE TABLE smarter_private.f06_prepared_hand_cancellations(table_id uuid, hand_number bigint);
CREATE TABLE smarter_private.f06_no_start_continuations(table_id uuid, hand_number bigint);
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
CREATE FUNCTION public.fn_project_hand_side_effects_after_post_commit_20260908(p_hand_id uuid) RETURNS jsonb
  LANGUAGE sql AS $$ SELECT jsonb_build_object('ok', true, 'projection_applied', true, 'hand_id', p_hand_id) $$;
''' + "INSERT INTO public.tables VALUES('" + A + "','" + T1 + "',NULL),('" + B + "','" + T1 + "',NULL),('" + C + "','" + T2 + "',NULL),('" + D + "',NULL,NULL);\n"
        + "INSERT INTO smarter_private.f06_hand_permits VALUES('" + A + "',7,'" + T1 + "'),('" + B + "',7,'" + T1 + "');\n"
        + "INSERT INTO public.hand_atomic_commits(hand_id,table_id,hand_number,post_commit_payload) SELECT h,t,7,"
        + "'{\"time_banks\":[],\"rake\":null,\"bbj_contribution\":null,\"pending_addons\":null,\"promo_playthrough\":[],\"insurance\":[]}'::jsonb"
        + " FROM (VALUES('" + HA + "'::uuid,'" + A + "'::uuid),('" + HB + "','" + B + "')) v(h,t);\n"
        + "UPDATE public.hand_atomic_commits SET post_commit_payload_hash=encode(extensions.digest(convert_to(post_commit_payload::text,'UTF8'),'sha256'),'hex');\n"
        + "INSERT INTO public.hand_history SELECT hand_id,table_id,7,'[]'::jsonb FROM public.hand_atomic_commits;\n"
        + "INSERT INTO public.hand_projection_outbox SELECT hand_id,table_id,7 FROM public.hand_atomic_commits;\n")

    for i, row in enumerate(rows):
        sig = row['signature']
        grants = 'REVOKE ALL ON FUNCTION ' + sig + ' FROM PUBLIC;\n'
        if 'service_role=X' in row['acl']:
            grants += 'GRANT EXECUTE ON FUNCTION ' + sig + ' TO service_role;\n'
        run('preimage-' + str(i), row['definition'] + ';\n' + grants)
        run('exact-preimage-' + str(i), "SELECT md5(pg_get_functiondef('" + sig + "'::regprocedure));", row['definition_hash'])
    run('bindings', '''
CREATE TRIGGER a00_f06_cancelled_preparation BEFORE INSERT OR UPDATE ON public.table_hole_cards FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_cancelled_preparation_writer_guard();
CREATE TRIGGER a00_f06_cancelled_preparation BEFORE INSERT OR UPDATE ON public.hand_state_snapshots FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_cancelled_preparation_writer_guard();
CREATE TRIGGER a00_f06_aborted_hand BEFORE INSERT OR UPDATE ON public.hand_atomic_commits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_aborted_hand_guard();
CREATE TRIGGER a00_f06_cancelled_preparation BEFORE INSERT OR UPDATE ON public.hand_atomic_commits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_cancelled_preparation_writer_guard();
''')
    state0 = run('state-before', snapshot)
    meta = run('metadata-before', metadata)

    # Uncontended, every writer works on the preimages (rolled back).
    for name, sql in WRITERS_A:
        run('uncontended-before-' + name, as_writer(sql))

    # BEFORE: the production defect. An exclusive tournament authority (or G)
    # refuses every writer of every table of its tournament at once.
    for label, lane in [('global', G_LANE), ('tournament', T1_LANE)]:
        with holding(xlock(lane)):
            for name, sql in WRITERS_A:
                t0 = time.monotonic()
                r = execute(cmd, as_writer(sql))
                el = time.monotonic() - t0
                record('before-' + label + '-exclusive-refuses-' + name,
                       r.returncode != 0 and '55P03' in r.stderr and 'F06_RETRY_CANONICAL_LANE' in r.stderr and el < 2, el, r.stderr)
    # BEFORE: an exclusive request merely QUEUED behind another table's shared
    # holder refuses the writer too (new shared requests queue behind it).
    with holding(slock(T1_LANE)) as shared_holder:
        queued = Writer(xlock(T1_LANE))
        queued.start()
        wait_until_waiting(queued.app)
        r = execute(cmd, as_writer(CARDS(A)))
        record('before-queued-exclusive-refuses-cards', r.returncode != 0 and 'F06_RETRY_CANONICAL_LANE' in r.stderr, 0, r.stderr)
    queued.join(10)

    # Drift refusal: any change to a pinned body aborts the whole migration.
    run('preimage-drift-refused', 'BEGIN; ALTER FUNCTION public.insert_hole_cards(uuid,integer,text) SET search_path=public, pg_temp;\n' + migration,
        error='is not the pinned text')
    run('drift-left-nothing-behind', "SELECT md5(pg_get_functiondef('public.insert_hole_cards(uuid,integer,text)'::regprocedure)), "
        "to_regprocedure('smarter_private.f06_wait_table_lane(uuid)') IS NULL;",
        next(r['definition_hash'] for r in rows if r['signature'].startswith('public.insert_hole_cards')) + '|t')

    run('install', migration)
    run('metadata-preserved', metadata, meta)
    run('guards-unchanged', "SELECT string_agg(md5(pg_get_functiondef(oid)),',' ORDER BY oid::regprocedure::text) FROM pg_proc WHERE oid IN "
        "('smarter_private.f06_aborted_hand_guard()'::regprocedure,'smarter_private.f06_cancelled_preparation_writer_guard()'::regprocedure);",
        '49046cee6eb91ce98c44564e0590e452,3219dd0db0c0de9e8f9c02f4609eaaf8')
    run('no-state-rewritten', snapshot, state0)
    run('helper-privileges', "SELECT has_function_privilege('service_role','smarter_private.f06_wait_table_lane(uuid)','EXECUTE'), "
        "has_function_privilege('anon','smarter_private.f06_wait_table_lane(uuid)','EXECUTE'), "
        "has_function_privilege('authenticated','smarter_private.f06_wait_table_lane(uuid)','EXECUTE');", 't|f|f')

    # AFTER: the same exclusive authority makes the writer WAIT, holding no
    # lock while it waits, and the writer succeeds once the authority ends.
    for label, lane in [('global', G_LANE), ('tournament', T1_LANE)]:
        for name, sql in WRITERS_A:
            with holding(xlock(lane)) as h:
                w = Writer(sql)
                w.start()
                wait_until_waiting(w.app)
                held = locks_held_while_waiting(w.app)
                time.sleep(0.8)
                require(w.is_alive(), 'writer did not wait')
                h.finish('COMMIT')
            w.join(10)
            record('after-' + label + '-exclusive-waits-then-' + name,
                   w.r.returncode == 0 and 'F06_RETRY' not in w.r.stderr and w.elapsed >= 0.8, w.elapsed, w.r.stdout + w.r.stderr)
            # Waiting for G it holds nothing; waiting for T(id) it holds only
            # G shared, the lane's own first step (G before T, as every
            # authority takes it). No row, relation or other advisory lock.
            record('after-' + label + '-waits-holding-no-lock-' + name,
                   held == ('' if label == 'global' else 'advisory:ShareLock:'), 0, 'held while waiting: ' + held)

    # AFTER: bounded. An authority that outlives 4 s still yields the same
    # sentinel the engine already classifies and retries.
    with holding(xlock(T1_LANE)):
        t0 = time.monotonic()
        r = execute(cmd, as_writer(CARDS(A)))
        el = time.monotonic() - t0
        record('after-wait-is-bounded-at-4s', r.returncode != 0 and '55P03' in r.stderr and 'F06_RETRY_CANONICAL_LANE' in r.stderr
               and 3.5 <= el <= 6.5, el, r.stderr)

    # AFTER: a queued exclusive request is waited for, not a refusal.
    shared_holder = Session('BEGIN;\n' + slock(T1_LANE))
    queued = Writer(xlock(T1_LANE))
    queued.start()
    wait_until_waiting(queued.app)
    w = Writer(CARDS(A))
    w.start()
    wait_until_waiting(w.app)
    time.sleep(0.5)
    shared_holder.finish('COMMIT')
    queued.join(10)
    w.join(10)
    record('after-queued-exclusive-is-waited-for', w.r.returncode == 0 and queued.r.returncode == 0, w.elapsed, w.r.stderr + queued.r.stderr)

    # AFTER: two tables of one tournament write concurrently. Table A's
    # writer keeps its transaction (and its shared lane) open; table B's four
    # writers complete without waiting.
    with holding('SET ROLE service_role;\n' + CARDS(A) + '\n' + POST(HA) + '\nRESET ROLE;'):
        for name, sql in [('cards', CARDS(B)), ('snapshot', SNAP(B)), ('post-commit', POST(HB)), ('projection', PROJ(HB))]:
            t0 = time.monotonic()
            r = execute(cmd, as_writer(sql))
            el = time.monotonic() - t0
            record('after-sibling-table-concurrent-' + name, r.returncode == 0 and el < 1.0, el, r.stdout + r.stderr)
        # ...and an exclusive tournament authority cannot overlap that open writer.
        t0 = time.monotonic()
        r = execute(cmd, "BEGIN; SET LOCAL lock_timeout='1s';\n" + xlock(T1_LANE) + "\nROLLBACK;")
        el = time.monotonic() - t0
        record('after-authority-cannot-overlap-open-writer', r.returncode != 0 and 'lock timeout' in r.stderr, el, r.stderr)

    # AFTER: a writer that waited sees and obeys the fence its authority
    # committed (cancellation for cards/snapshot, abort for the commit row).
    for name, sql, fence, err in [
            ('cards', CARDS(A), "INSERT INTO smarter_private.f06_prepared_hand_cancellations VALUES('" + A + "',7);", 'F06_CANCELLED_PREPARATION_FENCED'),
            ('snapshot', SNAP(A), "INSERT INTO smarter_private.f06_prepared_hand_cancellations VALUES('" + A + "',8);", 'F06_CANCELLED_PREPARATION_FENCED'),
            ('post-commit', POST(HA), "INSERT INTO smarter_private.f06_unsettled_hand_aborts VALUES('" + A + "',7);", 'F06_ABORTED_HAND_FENCED'),
            ('projection', PROJ(HA), "INSERT INTO smarter_private.f06_unsettled_hand_aborts VALUES('" + A + "',7);", 'F06_ABORTED_HAND_FENCED')]:
        with holding(xlock(T1_LANE) + '\n' + fence) as h:
            w = Writer(sql)
            w.start()
            wait_until_waiting(w.app)
            time.sleep(0.3)
            h.finish('COMMIT')
        w.join(10)
        record('after-waiting-writer-obeys-committed-fence-' + name, w.r.returncode != 0 and err in w.r.stderr, w.elapsed, w.r.stderr)
        q('DELETE FROM smarter_private.f06_prepared_hand_cancellations; DELETE FROM smarter_private.f06_unsettled_hand_aborts;')

    # AFTER: another tournament's lane and a cash table are untouched.
    with holding(xlock(T2_LANE)):
        for name, sql in WRITERS_A:
            t0 = time.monotonic()
            r = execute(cmd, as_writer(sql))
            el = time.monotonic() - t0
            record('after-unrelated-tournament-lane-' + name, r.returncode == 0 and el < 1.0, el, r.stderr)
    with holding(xlock(G_LANE)):
        for name, sql in [('cards', CARDS(D)), ('snapshot', SNAP(D))]:
            t0 = time.monotonic()
            r = execute(cmd, as_writer(sql))
            el = time.monotonic() - t0
            record('after-cash-table-takes-no-lane-' + name, r.returncode == 0 and el < 1.0, el, r.stderr)

    # AFTER: a caller that already holds T(id) exclusively (as
    # fn_ca_resume_hand_submission does) re-enters without waiting.
    for name, sql in WRITERS_A:
        t0 = time.monotonic()
        r = execute(cmd, 'BEGIN;\n' + xlock(T1_LANE) + '\nSET ROLE service_role;\n' + sql + '\nROLLBACK;')
        el = time.monotonic() - t0
        record('after-exclusive-holder-re-enters-' + name, r.returncode == 0 and el < 1.0, el, r.stderr)

    # AFTER: the guards are unchanged - a direct write that did not take the
    # lane first is still refused promptly, never waited for.
    with holding(xlock(T1_LANE)):
        t0 = time.monotonic()
        r = execute(cmd, "BEGIN; SET ROLE service_role; INSERT INTO public.table_hole_cards(table_id,hand_number,user_id,seat_number,cards) VALUES('"
                    + A + "',8,'" + U + "',1,'[]'); ROLLBACK;")
        el = time.monotonic() - t0
        record('after-direct-write-still-refused-by-guard', r.returncode != 0 and 'F06_RETRY_CANONICAL_LANE' in r.stderr and el < 2, el, r.stderr)

    run('all-probes-rolled-back', snapshot, state0)

    # Committed, uncontended: the work itself is unchanged.
    run('commit-cards', as_writer(CARDS(A), 'COMMIT'))
    run('commit-snapshot', as_writer(SNAP(A), 'COMMIT'))
    run('commit-projection', as_writer(PROJ(HB), 'COMMIT'), 'true')
    run('committed-effects', "SELECT (SELECT count(*) FROM public.table_hole_cards WHERE table_id='" + A + "'), "
        "(SELECT count(*) FROM public.hand_state_snapshots WHERE table_id='" + A + "'), "
        "(SELECT post_commit_completed_at IS NOT NULL FROM public.hand_atomic_commits WHERE hand_id='" + HB + "');", '1|1|t')
    results['passed'] = True
finally:
    execute([pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    (out / 'result.json').write_text(json.dumps(results, indent=2) + '\n')
print('PASS tournament table writers wait for their lane: ' + str(len(results['cases'])) + ' real PostgreSQL cases')
