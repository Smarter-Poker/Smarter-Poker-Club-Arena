#!/usr/bin/env python3
"""A tournament table's hand does not wait for its sibling tables.

Migration 20261003230910_a_tournament_table_s_hand_does_not_wait_for_its_sibling_tabl
moves the per-table F06 hand calls from smarter_private.f06_prefix (tournament
lane T(id) EXCLUSIVE, tournament row FOR UPDATE) to
public.fn_ca_f06_share_table_lane (T(id) SHARED, tournament row FOR SHARE,
this table and its seats FOR UPDATE).

Two disposable PostgreSQL clusters hold the EXACT live definitions of the three
changed functions (fixtures/f06-share-table-lane/preimages.json, md5-pinned)
and the live lane authorities. One stays on the pre-image; the other applies
the SHIPPED migration unchanged. The harness proves:

  APPLY     the shipped migration's pins match the fixtures and it installs;
  BEFORE    on the pre-image, a hand call on table 2 waits for a hand call
            holding table 1 of the same tournament (the defect);
  SIBLING   after, it does not wait;
  SAME      after, two calls on one table still serialize;
  EXCL      after, a tournament-wide authority (T(id) exclusive) still waits
            for a table call, and a table call still waits for it;
  NOSTART   after, finish_hand never_started still takes the exclusive lane;
  LAW       begin/finish/number-state answers are unchanged: one reserved
            permit per table, replay, accepted finish needs its evidence;
  FENCE     a wrong lease generation is still refused;
  CONCUR    eight tables dealing at once with a tournament-wide authority
            interleaved: no deadlock, no error, every hand accepted.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / 'scripts/ci/fixtures/f06-share-table-lane'
OUT = (ROOT / 'artifacts/f06-share-table-lane').resolve()
OUT.mkdir(parents=True, exist_ok=True)


def find_pg_bin():
    if os.environ.get('PG_BIN'):
        return Path(os.environ['PG_BIN'])
    for cand in sorted(Path('/usr/lib/postgresql').glob('*/bin'), reverse=True):
        if (cand / 'postgres').exists():
            return cand
    return Path('/opt/homebrew/opt/postgresql@17/bin')


PG = find_pg_bin()
AS_PG = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
ENV = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
ENV['LC_ALL'] = 'C'

found = sorted((ROOT / 'supabase/migrations').glob('*_a_tournament_table_s_hand_does_not_wait_for_its_sibling_tabl.sql'))
if len(found) != 1:
    raise RuntimeError(f'expected exactly one shipped migration, found {len(found)}')
SHIPPED = found[0].read_text()
PRE = json.loads((FIX / 'preimages.json').read_text())
LANES = (FIX / 'lane-authorities.sql').read_text()

T = '00000000-0000-4000-8000-0000000000a1'
G = '00000000-0000-4000-8000-0000000000b1'
TABLES = [f'00000000-0000-4000-8000-0000000001{i:02d}' for i in range(8)]

SCHEMA = r"""
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth; CREATE SCHEMA smarter_private;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
  AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
CREATE TABLE public.tournaments (id uuid PRIMARY KEY, status text NOT NULL);
CREATE TABLE public.tournament_players (tournament_id uuid, user_id uuid, PRIMARY KEY (tournament_id, user_id));
CREATE TABLE public.tables (id uuid PRIMARY KEY, tournament_id uuid REFERENCES public.tournaments(id),
  f06_lifecycle bigint NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'active', is_deleted boolean DEFAULT false);
CREATE TABLE public.table_seats (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), table_id uuid REFERENCES public.tables(id), user_id uuid);
CREATE TABLE public.engine_tournament_leases (tournament_id uuid PRIMARY KEY, protocol_version int, lease_generation uuid, heartbeat_at timestamptz);
CREATE TABLE public.hand_atomic_commits (hand_id uuid PRIMARY KEY, table_id uuid, hand_number bigint, post_commit_completed_at timestamptz);
CREATE TABLE public.hand_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), table_id uuid, hand_number bigint);
CREATE TABLE smarter_private.f06_hand_permits (permit_id uuid PRIMARY KEY, tournament_id uuid, table_id uuid REFERENCES public.tables(id),
  lifecycle bigint, hand_number bigint, custody_id uuid, generation uuid, state text NOT NULL DEFAULT 'reserved'
  CHECK (state IN ('reserved','accepted','never_started','aborted_unsettled')), evidence_id uuid,
  UNIQUE (table_id, hand_number));
CREATE UNIQUE INDEX f06_one_hand ON smarter_private.f06_hand_permits (table_id) WHERE state = 'reserved';
CREATE TABLE smarter_private.f06_operations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_table_id uuid, lifecycle bigint,
  state text, custody_id uuid, custody_generation uuid, revision int DEFAULT 0);
CREATE TABLE smarter_private.f06_absent_permit_releases (permit_id uuid PRIMARY KEY);
CREATE TABLE smarter_private.f06_hand_dispatch (permit_id uuid PRIMARY KEY);
"""


def seed():
    rows = ',\n'.join(f"('{t}', '{T}')" for t in TABLES)
    seats = ',\n'.join(f"('{t}', gen_random_uuid())" for t in TABLES for _ in range(3))
    return f"""
INSERT INTO public.tournaments VALUES ('{T}', 'RUNNING');
INSERT INTO public.engine_tournament_leases VALUES ('{T}', 2, '{G}', now() + interval '1 day');
INSERT INTO public.tables (id, tournament_id) VALUES {rows};
INSERT INTO public.table_seats (table_id, user_id) VALUES {seats};
"""


AS_ENGINE = (f"SET request.jwt.claim.role = 'service_role'; SET app.smarter_data_actor = 'tournament-manager'; "
             f"SET app.smarter_tournament_id = '{T}'; SET app.smarter_tournament_lease_generation = '{G}'; ")


class Cluster:
    def __init__(self, name, port):
        self.dir = Path(tempfile.mkdtemp(prefix=f'f06-lane-{name}-', dir='/tmp'))
        self.sock = self.dir / 'socket'
        self.sock.mkdir(mode=0o700)
        if AS_PG:
            shutil.chown(self.dir, 'postgres')
            shutil.chown(self.sock, 'postgres')
        self.port = str(port)
        subprocess.run(AS_PG + [str(PG / 'initdb'), '-D', str(self.dir / 'data'), '-U', 'postgres', '-A', 'trust'],
                       env=ENV, check=True, capture_output=True)
        subprocess.run(AS_PG + [str(PG / 'pg_ctl'), '-D', str(self.dir / 'data'), '-l', str(self.dir / 'log'), '-w',
                        '-o', f"-k {self.sock} -p {self.port} -c listen_addresses='' -c fsync=off -c deadlock_timeout=200ms",
                        'start'], env=ENV, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def psql(self, sql, check=True, timeout=120):
        r = subprocess.run([str(PG / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(self.sock),
                            '-p', self.port, '-U', 'postgres', '-d', 'postgres'],
                           input=sql, text=True, capture_output=True, env=ENV, timeout=timeout)
        if check and r.returncode != 0:
            raise RuntimeError(r.stderr)
        return r

    def stop(self):
        subprocess.run(AS_PG + [str(PG / 'pg_ctl'), '-D', str(self.dir / 'data'), '-m', 'immediate', 'stop'],
                       env=ENV, capture_output=True)
        shutil.rmtree(self.dir, ignore_errors=True)


def install(c):
    c.psql(SCHEMA + seed())
    c.psql(LANES)
    for name, d in PRE['definitions'].items():
        c.psql(d.rstrip('\n') + ';\n')
    c.psql("""
      DO $g$ DECLARE f regprocedure; BEGIN
        FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname IN ('public', 'smarter_private') AND p.prokind = 'f' LOOP
          EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
          EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
        END LOOP; END $g$;""")
    got = c.psql("SELECT string_agg(p.proname || '=' || md5(pg_get_functiondef(p.oid)), ',' ORDER BY p.proname) FROM pg_proc p "
                 "WHERE p.proname IN ('fn_f06_hand_number_state','fn_f06_begin_hand','fn_f06_finish_hand');").stdout.strip()
    want = ','.join(f'{k}={PRE["pins"][k]}' for k in sorted(PRE['pins']))
    return got == want, got


def timed(c, sql, check=False):
    t0 = time.time()
    r = c.psql(sql, check=check)
    return round((time.time() - t0) * 1000), r


def hold(c, sql, seconds):
    t = threading.Thread(target=c.psql, args=(AS_ENGINE + f"BEGIN; {sql}; SELECT pg_sleep({seconds}); COMMIT;",), kwargs={'check': False})
    t.start()
    time.sleep(0.5)
    return t


def state(tb):
    return f"SELECT public.fn_f06_hand_number_state('{T}', '{G}', '{tb}')"


results = {'scope': "a tournament table's hand does not wait for its sibling tables", 'cases': [], 'passed': False}


def case(name, ok, **kw):
    results['cases'].append({'case': name, **kw, 'ok': bool(ok)})


old = new = None
try:
    old = Cluster('old', 55841)
    new = Cluster('new', 55842)
    for c in (old, new):
        ok, got = install(c)
        case(f'fixture definitions are the pinned live text ({c.port})', ok, got=got)
    r = new.psql(SHIPPED, check=False)
    posts = new.psql("SELECT string_agg(p.proname || '=' || md5(pg_get_functiondef(p.oid)), ',' ORDER BY p.proname) FROM pg_proc p "
                     "WHERE p.proname IN ('fn_f06_hand_number_state','fn_f06_begin_hand','fn_f06_finish_hand');").stdout.strip()
    case('APPLY the shipped migration to its pinned post-images', r.returncode == 0 and posts ==
         'fn_f06_begin_hand=e498a501aaa983f397bd4da1afa09875,fn_f06_finish_hand=f85ee8fbf794e9087926715fd340499d,'
         'fn_f06_hand_number_state=79c2a20b8f72b7fdacab80bbe7850e30', stderr=r.stderr.strip()[-600:], posts=posts)

    # BEFORE: the defect on the pre-image.
    t = hold(old, state(TABLES[0]), 2)
    ms, r = timed(old, AS_ENGINE + state(TABLES[1]) + ';')
    t.join()
    case('BEFORE a sibling table waits on the pre-image', r.returncode == 0 and ms >= 1200, ms=ms)

    t = hold(new, state(TABLES[0]), 2)
    ms, r = timed(new, AS_ENGINE + state(TABLES[1]) + ';')
    t.join()
    case('SIBLING table does not wait', r.returncode == 0 and ms < 800, ms=ms, out=r.stdout.strip()[:120])

    t = hold(new, state(TABLES[0]), 2)
    ms, r = timed(new, AS_ENGINE + state(TABLES[0]) + ';')
    t.join()
    case('SAME table still serializes', r.returncode == 0 and ms >= 1200, ms=ms)

    t = hold(new, f"SELECT public.fn_ca_lock_settlement_lane_for_tournament('{T}')", 2)
    ms, r = timed(new, AS_ENGINE + state(TABLES[2]) + ';')
    t.join()
    case('EXCL a table call waits for a tournament-wide authority', r.returncode == 0 and ms >= 1200, ms=ms)

    t = hold(new, state(TABLES[3]), 2)
    ms, r = timed(new, AS_ENGINE + f"SELECT public.fn_ca_lock_settlement_lane_for_tournament('{T}');")
    t.join()
    case('EXCL a tournament-wide authority waits for a table call', r.returncode == 0 and ms >= 1200, ms=ms)

    # LAW: answers unchanged.
    p1, c1, ev = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    begin = lambda p, n, tb=TABLES[4]: f"SELECT public.fn_f06_begin_hand('{T}', '{G}', '{tb}', 1, '{p}', {n}, '{c1}')"
    a = new.psql(AS_ENGINE + begin(p1, 1000001) + ';').stdout.strip()
    b = new.psql(AS_ENGINE + begin(p1, 1000001) + ';').stdout.strip()
    x = new.psql(AS_ENGINE + begin(str(uuid.uuid4()), 1000002) + ';').stdout.strip()
    s = new.psql(AS_ENGINE + state(TABLES[4]) + ';').stdout.strip()
    case('LAW begin reserves, replays, and refuses a second reserved permit',
         '"ok": true' in a and '"state": "reserved"' in b and 'hand_permit_unresolved' in x and '"can_reserve": false' in s,
         begin=a[:90], replay=b[:90], second=x, state=s[:160])
    r = new.psql(AS_ENGINE + f"SELECT public.fn_f06_finish_hand('{T}', '{G}', '{p1}', 'accepted', '{ev}');", check=False)
    case('LAW an accepted finish still needs its committed hand', r.returncode != 0 and 'F06_HAND_EVIDENCE_REQUIRED' in r.stderr,
         stderr=r.stderr.strip()[:160])
    new.psql(f"INSERT INTO public.hand_atomic_commits VALUES ('{ev}', '{TABLES[4]}', 1000001, now());")
    f = new.psql(AS_ENGINE + f"SELECT public.fn_f06_finish_hand('{T}', '{G}', '{p1}', 'accepted', '{ev}');").stdout.strip()
    s = new.psql(AS_ENGINE + state(TABLES[4]) + ';').stdout.strip()
    case('LAW an accepted finish records it and frees the table', '"state": "accepted"' in f and '"can_reserve": true' in s
         and '"used_hand_number_max": "1000001"' in s, finish=f[:120], state=s[:160])

    # NOSTART keeps the exclusive lane: while a table call holds T shared, a
    # never_started finish waits for it.
    p2 = str(uuid.uuid4())
    new.psql(AS_ENGINE + begin(p2, 1000002) + ';')
    t = hold(new, state(TABLES[5]), 2)
    ms, r = timed(new, AS_ENGINE + f"SELECT public.fn_f06_finish_hand('{T}', '{G}', '{p2}', 'never_started', '{uuid.uuid4()}');")
    t.join()
    case('NOSTART a never_started finish still takes the exclusive lane', ms >= 1200 and 'F06_EXACT_QUIESCENT_CUSTODY_REQUIRED' in r.stderr,
         ms=ms, stderr=r.stderr.strip()[:120])

    r = new.psql(AS_ENGINE.replace(G, str(uuid.uuid4())) + state(TABLES[6]) + ';', check=False)
    r2 = new.psql(AS_ENGINE + f"SELECT public.fn_f06_hand_number_state('{T}', '{uuid.uuid4()}', '{TABLES[6]}');", check=False)
    case('FENCE a wrong lease generation is refused', 'F06_PROTOCOL2_REQUIRED' in r.stderr and 'F06_PROTOCOL2_REQUIRED' in r2.stderr)

    # CONCUR: eight tables dealing with a tournament-wide authority interleaved.
    errors = []

    def dealer(i):
        tb = TABLES[i]
        for k in range(6):
            p, e = str(uuid.uuid4()), str(uuid.uuid4())
            n = 2000000 + i * 100 + k
            sql = (AS_ENGINE + f"BEGIN; {state(tb)}; SELECT public.fn_f06_begin_hand('{T}', '{G}', '{tb}', 1, '{p}', {n}, '{uuid.uuid4()}'); "
                   f"SELECT pg_sleep(0.05); COMMIT; "
                   f"INSERT INTO public.hand_atomic_commits VALUES ('{e}', '{tb}', {n}, now()); "
                   f"BEGIN; SELECT public.fn_f06_finish_hand('{T}', '{G}', '{p}', 'accepted', '{e}'); SELECT pg_sleep(0.05); COMMIT;")
            r = new.psql(sql, check=False)
            if r.returncode != 0:
                errors.append(r.stderr.strip()[-200:])

    def authority():
        for _ in range(6):
            r = new.psql(AS_ENGINE + f"BEGIN; SELECT public.fn_ca_lock_settlement_lane_for_tournament('{T}'); "
                         f"SELECT 1 FROM public.tables WHERE tournament_id = '{T}' ORDER BY id FOR UPDATE; SELECT pg_sleep(0.1); COMMIT;",
                         check=False)
            if r.returncode != 0:
                errors.append('authority: ' + r.stderr.strip()[-200:])
            time.sleep(0.1)

    new.psql("SELECT pg_stat_reset();")
    for tb in TABLES:
        new.psql(f"DELETE FROM smarter_private.f06_hand_permits WHERE table_id = '{tb}' AND state = 'reserved';")
    th = [threading.Thread(target=dealer, args=(i,)) for i in range(8)] + [threading.Thread(target=authority)]
    t0 = time.time()
    [x.start() for x in th]
    [x.join() for x in th]
    accepted = new.psql("SELECT count(*) FROM smarter_private.f06_hand_permits WHERE hand_number >= 2000000 AND state = 'accepted';").stdout.strip()
    deadlocks = new.psql("SELECT deadlocks FROM pg_stat_database WHERE datname = 'postgres';").stdout.strip()
    case('CONCUR eight tables and a tournament-wide authority: no deadlock, every hand accepted',
         not errors and accepted == '48' and deadlocks == '0', errors=errors[:3], accepted=accepted, deadlocks=deadlocks,
         seconds=round(time.time() - t0, 2))

    results['passed'] = all(x['ok'] for x in results['cases'])
finally:
    for c in (old, new):
        if c:
            c.stop()
    (OUT / 'result.json').write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))

if not results['passed']:
    raise SystemExit(1)
