"""Isolated PostgreSQL regression: a horse claim never waits on a player lock.

fn_ca_horse_claim_due (pg_cron, every minute) is one transaction that claims
up to 500 horse rewards for up to 45 seconds and keeps every horse's
daily-missions advisory lock and profiles row until it ends. On 2026-10-15
00:03 to 00:15 UTC it was one side of 14 of the 16 production deadlocks: it
held horse A and WAITED for horse B, while the engine's commission batch
(apply_rakeback_player_stats -> fn_sync_profile_total_hands) held B and waited
for A. The 00:28 reports show the same cycle through the daily-missions
advisory lock that fn_lock_daily_mission_user takes before the row.

This test loads the exact production text of fn_ca_horse_claim_due captured
on 2026-10-15 (its pg_get_functiondef md5 equals production's), drives the two
production schedules with real concurrent sessions, and proves:

  baseline (live text)  each schedule deadlocks, and the side Postgres cancels
                        loses its work (a hand's commission batch, or a claim
                        filed as a failure and deferred instead of paid);
  candidate (migration) the same schedules never deadlock, the run never waits,
                        the busy horse is left owed and is paid by the next
                        run, and every reward is credited exactly once.

The claim body is a reduction of claim_daily_challenge_serialized_body that
takes production's locks in production's order (challenge row, then the
milestone step's fn_lock_daily_mission_user - advisory lock, then the profiles
row - then the diamond UPDATE and its journal row under a unique reference).
fn_lock_daily_mission_user is production's text. An empty throwaway cluster on
a Unix socket; no network, no production connection.
"""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'supabase' / 'migrations'
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'horse-claim-lock-order'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/horse-claim-lock-order')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='horse-claim-lock-order-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55821'
LOG = cluster / 'server.log'


def psql_args(app='horse-claim-test'):
    return [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(sock), '-p', PORT,
            '-U', 'postgres', '-d', f'dbname=postgres application_name={app}']


results = {'checks': [], 'scenarios': [], 'production_mutations': False}

# pg_get_functiondef md5 of production's fn_ca_horse_claim_due read on
# 2026-10-15, before and after the candidate (derived read-only on production).
LIVE_DEF_MD5 = '57b62c3786f3120097abb919f880243c'
POST_DEF_MD5 = '4207064ff1b6bd00f8fb9470e40e6c10'
SIG = 'public.fn_ca_horse_claim_due(integer)'
H1, H2, H3 = (uuid.UUID(int=0xA0 + n) for n in (1, 2, 3))
C1, C2, C3 = (uuid.UUID(int=n) for n in (1, 2, 3))  # claim (primary key) order
REWARD = {C1: 10, C2: 20, C3: 40}
OWNER = {C1: H1, C2: H2, C3: H3}
HOLD = '1.5'  # seconds each claim keeps the run inside the loop after its locks


def command(args, sql=None, timeout=60):
    r = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=timeout)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def run(sql):
    return command(psql_args(), sql)


def check(name, passed, detail=None):
    results['checks'].append({'name': name, 'passed': bool(passed), 'detail': detail})
    if not passed:
        raise AssertionError(f'{name}: {detail}')


def wait_until(what, predicate, timeout=15.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError(f'timed out waiting for {what}')


def deadlocks_logged():
    # Read PostgreSQL's authoritative deadlock counter. Server log routing and
    # whether the claim catches the error do not change the recorded event.
    return int(run("SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()"))


SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;
CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;

CREATE TABLE public.profiles(id uuid PRIMARY KEY, is_horse boolean NOT NULL,
  diamonds integer NOT NULL DEFAULT 0, total_hands_played integer NOT NULL DEFAULT 0);
CREATE TABLE public.user_daily_challenges(id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES public.profiles(id),
  completed boolean NOT NULL, claimed boolean NOT NULL DEFAULT false, claimed_at timestamptz,
  expired_at timestamptz, completed_at timestamptz, diamond_reward_snapshot integer NOT NULL,
  tier_snapshot text NOT NULL DEFAULT 'daily');
CREATE TABLE public.ca_horse_claim_deferrals(challenge_row_id uuid PRIMARY KEY, user_id uuid,
  refused_by text, detail text, retry_after timestamptz, refusals integer NOT NULL DEFAULT 1,
  last_refused_at timestamptz);
CREATE TABLE public.diamond_transactions(id bigserial PRIMARY KEY, user_id uuid NOT NULL REFERENCES public.profiles(id),
  amount integer NOT NULL, reference_id text NOT NULL, UNIQUE (user_id, reference_id));
CREATE TABLE public.diamond_incidents(code text, user_id uuid, detail jsonb);
CREATE FUNCTION public.fn_ca_diamond_incident(p_code text, p_severity text, p_user uuid, p_amount numeric,
  p_source text, p_detail jsonb) RETURNS void LANGUAGE sql AS
  $$ INSERT INTO public.diamond_incidents VALUES (p_code, p_user, p_detail) $$;

-- Production's text (read 2026-10-15).
CREATE OR REPLACE FUNCTION public.fn_lock_daily_mission_user(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'A Daily Missions player is required';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('daily-missions-user:' || p_user_id::text, 0)
  );

  PERFORM 1
  FROM public.profiles
  WHERE id = p_user_id
  FOR NO KEY UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Missions profile not found for player %', p_user_id;
  END IF;
END;
$function$;

-- claim_daily_challenge_serialized_body reduced to production's locks, in
-- production's order: the challenge row FOR UPDATE, the claimed UPDATE (whose
-- trigger runs the milestone step: fn_lock_daily_mission_user), the diamond
-- UPDATE of the profiles row and its journal row under the claim's own
-- reference. An already-claimed row pays nothing, exactly as production.
CREATE FUNCTION public.claim_daily_challenge_serialized_body(p_user_id uuid, p_challenge_row_id uuid,
  p_reward_amount numeric DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_row public.user_daily_challenges%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.user_daily_challenges
   WHERE id = p_challenge_row_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Challenge not found'; END IF;
  IF v_row.claimed THEN RETURN jsonb_build_object('claimed', false, 'alreadyClaimed', true); END IF;
  UPDATE public.user_daily_challenges SET claimed = true, claimed_at = now() WHERE id = p_challenge_row_id;
  PERFORM public.fn_lock_daily_mission_user(p_user_id);
  UPDATE public.profiles SET diamonds = diamonds + v_row.diamond_reward_snapshot WHERE id = p_user_id;
  INSERT INTO public.diamond_transactions(user_id, amount, reference_id)
  VALUES (p_user_id, v_row.diamond_reward_snapshot, 'challenge_claim:' || p_challenge_row_id::text || ':diamonds');
  -- The test's clock: keep the run inside the loop, holding this horse's locks,
  -- long enough for the other session to queue behind them.
  PERFORM pg_sleep(COALESCE(NULLIF(current_setting('test.hold', true), ''), '0')::numeric);
  RETURN jsonb_build_object('claimed', true);
END $$;
"""

GRANTS = f"""
REVOKE ALL ON FUNCTION {SIG} FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION {SIG} TO service_role;
"""


def seed():
    sql = ['TRUNCATE public.diamond_transactions, public.ca_horse_claim_deferrals, public.diamond_incidents,'
           ' public.user_daily_challenges, public.profiles;']
    for h in (H1, H2, H3):
        sql.append(f"INSERT INTO public.profiles(id, is_horse) VALUES ('{h}', true);")
    for c in (C1, C2, C3):
        sql.append("INSERT INTO public.user_daily_challenges(id, user_id, completed, completed_at, diamond_reward_snapshot)"
                   f" VALUES ('{c}', '{OWNER[c]}', true, now() - interval '1 hour', {REWARD[c]});")
    run('\n'.join(sql))


def locked_by_someone(user):
    """True when another session holds horse `user`'s profiles row (this probe never waits)."""
    return run(f"SELECT count(*) FROM (SELECT 1 FROM public.profiles WHERE id = '{user}' FOR UPDATE SKIP LOCKED) s") == '0'


def session_is(app, state):
    return run(f"SELECT count(*) FROM pg_stat_activity WHERE application_name = '{app}' AND state = '{state}'") == '1'


def claim_run():
    return subprocess.Popen(psql_args('claim-run'), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, env=env)


def parse_run(stdout):
    rows = [line for line in stdout.splitlines() if '|' in line]
    if len(rows) != 1:
        raise AssertionError(f'unexpected claim output: {stdout!r}')
    claimed, capped, failed, ran, refused = rows[0].split('|')
    return {'claimed': int(claimed), 'capped': int(capped), 'failed': int(failed), 'ran': ran == 't'}


def scenario(label, blocker):
    """Drive production's cycle with two real sessions.

    The player session (the engine's commission batch, or another
    daily-missions path) holds horse H2 and then asks for horse H1 while the
    claim run is holding H1 and is about to reach H2.
    """
    seed()
    before = deadlocks_logged()
    player = subprocess.Popen(psql_args('player-writer'), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, env=env)
    if blocker == 'profile':
        # fn_sync_profile_total_hands: UPDATE profiles, one player at a time, in hand order.
        first = f"UPDATE public.profiles SET total_hands_played = total_hands_played + 1 WHERE id = '{H2}';"
        second = f"UPDATE public.profiles SET total_hands_played = total_hands_played + 1 WHERE id = '{H1}';"
    else:
        # fn_lock_daily_mission_user's order: the advisory lock, then the row.
        first = f"SELECT pg_advisory_xact_lock(hashtextextended('daily-missions-user:' || '{H2}', 0));"
        second = (f"UPDATE public.profiles SET total_hands_played = total_hands_played + 1 WHERE id = '{H1}';")
    player.stdin.write('BEGIN;\n' + first + '\n')
    player.stdin.flush()
    # Observed from pg_stat_activity only: a probe that touched the rows could
    # itself be what a SKIP LOCKED read steps over.
    wait_until('the player session to hold H2', lambda: session_is('player-writer', 'idle in transaction'))
    check(f'{label}-player-holds-h2', locked_by_someone(H2) if blocker == 'profile' else run(
        "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted") == '1')

    claim = claim_run()
    claim.stdin.write(f"SET test.hold = '{HOLD}';\nSELECT * FROM {SIG.split('(')[0]}(500);\n")
    claim.stdin.flush()
    # The claim sleeps inside its first claim (H1) with H1's locks held.
    wait_until('the claim run to hold H1', lambda: run(
        "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'claim-run'"
        " AND wait_event = 'PgSleep'") == '1')

    started = time.monotonic()
    player.stdin.write(second + '\nCOMMIT;\n')
    player.stdin.flush()
    claim_out, claim_err = claim.communicate(timeout=60)
    claim_elapsed = time.monotonic() - started
    player_out, player_err = player.communicate(timeout=60)

    first_run = parse_run(claim_out) if claim.returncode == 0 else None
    state = json.loads(run("""SELECT json_build_object(
      'claimed', (SELECT json_object_agg(id, claimed) FROM public.user_daily_challenges),
      'deferred', (SELECT coalesce(json_agg(json_build_object('row', challenge_row_id, 'by', refused_by,
                    'detail', detail)), '[]') FROM public.ca_horse_claim_deferrals),
      'hands', (SELECT json_object_agg(id, total_hands_played) FROM public.profiles))"""))
    record = {
        'label': label, 'blocker': blocker,
        'claim_exit': claim.returncode, 'claim_stderr': claim_err.strip(), 'first_run': first_run,
        'claim_seconds_after_player_asked': round(claim_elapsed, 3),
        'player_exit': player.returncode, 'player_stderr': player_err.strip(),
        'deadlocks_logged': deadlocks_logged() - before, 'state_after_first_run': state,
    }
    results['scenarios'].append(record)
    return record


def ledger():
    return json.loads(run("""SELECT json_build_object(
      'credits', (SELECT json_object_agg(reference_id, n) FROM (
                   SELECT reference_id, count(*) n FROM public.diamond_transactions GROUP BY 1) s),
      'diamonds', (SELECT json_object_agg(id, diamonds) FROM public.profiles),
      'unclaimed', (SELECT count(*) FROM public.user_daily_challenges WHERE NOT claimed),
      'deferred', (SELECT count(*) FROM public.ca_horse_claim_deferrals))"""))


def ref(c):
    return f'challenge_claim:{c}:diamonds'


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', LOG, '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB"
                        " -c max_connections=20 -c deadlock_timeout=100ms -c logging_collector=off",
                        '-w', 'start'])
    run(SCHEMA)

    # ── Baseline: production's exact text ──────────────────────────────────
    run((FIXTURES / 'fn_ca_horse_claim_due.live-20261015.sql').read_text() + ';' + GRANTS)
    check('baseline-is-production-preimage',
          run(f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))") == LIVE_DEF_MD5)

    for blocker in ('profile', 'advisory'):
        r = scenario(f'baseline-{blocker}', blocker)
        cancelled_claim = any('deadlock detected' in (d['detail'] or '')
                              for d in r['state_after_first_run']['deferred'])
        check(f'baseline-{blocker}-deadlocks', r['deadlocks_logged'] >= 1
              and (cancelled_claim or 'deadlock detected' in r['player_stderr']), r)
        # Postgres cancels one side, and that side loses its work: the player
        # writer's transaction (in production, a hand's commission batch), or
        # the claim, which is filed as a failure and deferred instead of paid.
        # Production logged both on 2026-10-15.
        lost_player = ('deadlock detected' in r['player_stderr']
                       and all(v == 0 for v in r['state_after_first_run']['hands'].values()))
        lost_claim = (cancelled_claim and r['state_after_first_run']['claimed'][str(C2)] is False
                      and r['first_run'] is not None and r['first_run']['failed'] >= 1)
        check(f'baseline-{blocker}-the-cancelled-side-loses-its-work', lost_player or lost_claim, r)

    # ── Candidate: the migration, applied as written ───────────────────────
    migration = sorted(MIGRATIONS.glob('*_a_horse_claim_never_waits_on_a_player_lock.sql'))
    check('exactly-one-migration', len(migration) == 1, [p.name for p in migration])
    command(psql_args() + ['-f', migration[0]])
    check('candidate-is-derived-postimage',
          run(f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))") == POST_DEF_MD5)
    acl = run(f"SELECT proacl::text || '|' || pg_get_userbyid(proowner) || '|' || prosecdef || '|' ||"
              f" coalesce(proconfig::text, '') FROM pg_proc WHERE oid = '{SIG}'::regprocedure")
    check('grants-owner-security-settings-unchanged',
          acl == '{postgres=X/postgres,service_role=X/postgres}|postgres|false|{"search_path=public, pg_temp"}', acl)
    check('migration-is-pinned-to-the-preimage', LIVE_DEF_MD5 in migration[0].read_text()
          and migration[0].read_text().count(POST_DEF_MD5) == 2)

    for blocker in ('profile', 'advisory'):
        r = scenario(f'candidate-{blocker}', blocker)
        check(f'candidate-{blocker}-no-deadlock', r['deadlocks_logged'] == 0 and r['claim_exit'] == 0
              and r['player_exit'] == 0, r)
        check(f'candidate-{blocker}-first-run-pays-the-free-horses-and-leaves-the-busy-one-owed',
              r['first_run'] == {'claimed': 2, 'capped': 0, 'failed': 0, 'ran': True}
              and r['state_after_first_run']['claimed'] == {str(C1): True, str(C2): False, str(C3): True}
              and r['state_after_first_run']['deferred'] == [], r)
        # The run never waited on H2: it finished its two held claims and left.
        check(f'candidate-{blocker}-the-run-never-waits', r['claim_seconds_after_player_asked'] < 2 * float(HOLD) + 1.5, r)
        check(f'candidate-{blocker}-the-player-writer-committed',
              r['state_after_first_run']['hands'][str(H1)] == 1, r)
        second = parse_run(command(psql_args(), f'SELECT * FROM {SIG.split("(")[0]}(500);'))
        third = parse_run(command(psql_args(), f'SELECT * FROM {SIG.split("(")[0]}(500);'))
        book = ledger()
        check(f'candidate-{blocker}-next-run-pays-the-skipped-horse',
              second == {'claimed': 1, 'capped': 0, 'failed': 0, 'ran': True}
              and third == {'claimed': 0, 'capped': 0, 'failed': 0, 'ran': True}, [second, third])
        check(f'candidate-{blocker}-every-reward-credited-exactly-once',
              book['credits'] == {ref(c): 1 for c in (C1, C2, C3)}
              and book['diamonds'] == {str(OWNER[c]): REWARD[c] for c in (C1, C2, C3)}
              and book['unclaimed'] == 0 and book['deferred'] == 0, book)
finally:
    try:
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])
    except Exception:
        pass
    results['passed'] = bool(results['checks']) and all(c['passed'] for c in results['checks'])
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str))
    shutil.rmtree(cluster, ignore_errors=True)

print(json.dumps({'passed': results['passed'], 'checks': len(results['checks'])}))
