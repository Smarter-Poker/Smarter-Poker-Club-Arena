"""Isolated two-session PostgreSQL regression: a Diamond wallet lock never blocks
a foreign-key check.

Production, 2026-10-21 23:03-23:12 UTC: Turbo Tuesday PKO's atomic finish was
refused eight times with 40P01. The finish releases every entrant's custody
through fn_poker_diamond_release, which locked each profile FOR UPDATE; a hand
commit that updates the same tournament_players row twice in its transaction
re-checks fk_tournament_players_user_id_profiles (FOR KEY SHARE on the profile).
FOR UPDATE refuses FOR KEY SHARE, and the two transactions closed a cycle.

This test loads production's exact text of the three Diamond wallet doors
(pg_get_functiondef md5 equal to production on 2026-10-21) into an empty
cluster, then for each door:
  * lifts the door's own profile-lock statement out of its live definition,
    drives it against a hand-commit transaction in the order the logs show,
    and proves it deadlocks (40P01 in the server log);
  * applies migration 20261021234940 and proves every door reads back as the
    derived postimage, with owner, SECURITY DEFINER, settings and grants
    unchanged, and the watched doors declared;
  * drives the migrated door's lifted statement through the same interleaving
    and proves both transactions commit with no deadlock;
  * proves the migrated lock still refuses every other wallet writer
    (FOR UPDATE, FOR NO KEY UPDATE and a row UPDATE all wait on it).
A second run of the migration is refused by its pinned preimage. An empty
throwaway cluster on a Unix socket; no network, no production connection.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20261021234940_a_diamond_wallet_lock_never_blocks_a_foreign_key_check.sql'
FX = ROOT / 'scripts/ci/fixtures/diamond-wallet-locks'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path,
                    default=ROOT / 'artifacts/a-diamond-wallet-lock-never-blocks-a-foreign-key-check')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='diamond-wallet-locks-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55841'
LOG = cluster / 'server.log'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

# name -> (regprocedure, production md5 on 2026-10-21, derived postimage md5, watched)
DOORS = {
    'fn_poker_diamond_release': ('public.fn_poker_diamond_release(uuid,uuid)',
                                 'd525cb1e20d6fb05e5b5e51497b127e7', 'f52d63d2163f3f85dfe1e72a1ef267e7', True),
    'fn_poker_diamond_reserve': ('public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)',
                                 'cf2150429728d8d796711e9bdbb22f51', '99fb5f4f483710c49e1a2ee8824b0992', True),
    'add_diamonds_to_balance': ('public.add_diamonds_to_balance(uuid,integer,text,text,text,uuid)',
                                '5d356b15727558df9c498dbb05a745d0', '06177aba483ac900056a9b4d769e1870', False),
}
A = '10000000-0000-0000-0000-00000000000a'
B = '20000000-0000-0000-0000-00000000000b'
T = 'c0000000-0000-0000-0000-0000000000a1'

SCHEMA = f"""
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
ALTER DATABASE postgres SET check_function_bodies = off;
CREATE TABLE public.profiles(id uuid PRIMARY KEY, diamonds bigint NOT NULL DEFAULT 0,
  diamond_multiplier numeric NOT NULL DEFAULT 1, total_hands_played bigint NOT NULL DEFAULT 0);
CREATE TABLE public.tournament_players(tournament_id uuid NOT NULL, user_id uuid NOT NULL,
  chips integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'playing',
  CONSTRAINT fk_tournament_players_user_id_profiles FOREIGN KEY (user_id)
    REFERENCES public.profiles(id) ON DELETE CASCADE);
INSERT INTO public.profiles(id, diamonds) VALUES ('{A}', 100), ('{B}', 100);
INSERT INTO public.tournament_players(tournament_id, user_id) VALUES ('{T}', '{A}'), ('{T}', '{B}');
-- Production's guard register, reduced to what the migration calls.
CREATE TABLE public.ca_guard_defs(proname text PRIMARY KEY, def_hash text, declared_ref text);
CREATE FUNCTION public.fn_ca_guard_watchlist() RETURNS text[] LANGUAGE sql AS
  $$SELECT ARRAY['fn_poker_diamond_release','fn_poker_diamond_reserve']$$;
CREATE FUNCTION public.fn_ca_declare_guard_redefinition(p_proname text, p_ref text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_hash text;
BEGIN
  IF NOT (p_proname = ANY (public.fn_ca_guard_watchlist())) THEN
    RAISE EXCEPTION '% is not on the guard watchlist', p_proname;
  END IF;
  SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) INTO v_hash
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = p_proname;
  INSERT INTO public.ca_guard_defs VALUES (p_proname, v_hash, p_ref)
  ON CONFLICT (proname) DO UPDATE SET def_hash = EXCLUDED.def_hash, declared_ref = EXCLUDED.declared_ref;
  RETURN v_hash;
END $$;
"""


def command(args, sql=None):
    r = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=120)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def run(sql):
    return command(psql, sql)


def attempt(sql):
    r = subprocess.run(list(map(str, psql)), input=sql, text=True, capture_output=True, env=env, timeout=120)
    return r.returncode, (r.stdout + r.stderr).strip()


def spawn(sql):
    return subprocess.Popen(list(map(str, psql)), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, env=env)


def finish(p, sql):
    o, e = p.communicate(sql, timeout=120)
    return p.returncode, (o + e).strip()


def check(name, passed, detail=None):
    results['checks'].append({'name': name, 'passed': bool(passed), 'detail': detail})
    if not passed:
        raise AssertionError(f'{name}: {detail}')


def deadlocks():
    return LOG.read_text(errors='replace').count('deadlock detected')


LOCK = re.compile(r'(?:PERFORM|SELECT)\b[^;]*?FROM public\.profiles WHERE id ?= ?(\w+) FOR (?:NO KEY )?UPDATE;', re.S)


def lifted(name):
    """The door's own profile-lock statement, from its current definition."""
    d = run(f"SELECT pg_get_functiondef('{DOORS[name][0]}'::regprocedure)")
    m = list(LOCK.finditer(d))
    check(f'{name}: exactly one profile-lock statement', len(m) == 1, len(m))
    stmt = m[0].group(0)
    return stmt, m[0].group(1)


def wallet_block(stmt, var):
    """A transaction that takes the door's lock on A, then (as the finish's
    custody loop does) on B, with the variables the door's text reads."""
    decl = ('v_owner uuid; p_user_id uuid; v_wallet bigint; v_old_balance bigint; '
            'v_multiplier numeric;')
    return f"""DO $w$
DECLARE {decl}
BEGIN
  {var} := '{A}';
  {stmt}
  PERFORM pg_sleep(1.0);
  {var} := '{B}';
  {stmt}
END $w$;
SELECT 'wallet-done';
"""


HAND = f"""BEGIN;
-- the hand's profile write (trg_sync_profile_total_hands) holds B
UPDATE public.profiles SET total_hands_played = total_hands_played + 1 WHERE id = '{B}';
-- line 206 writes the same tournament_players row twice; the second write
-- re-checks fk_tournament_players_user_id_profiles: FOR KEY SHARE on A
UPDATE public.tournament_players SET chips = chips + 1 WHERE tournament_id = '{T}' AND user_id = '{A}';
UPDATE public.tournament_players SET chips = chips + 1 WHERE tournament_id = '{T}' AND user_id = '{A}';
SELECT pg_sleep(1.5);
COMMIT;
SELECT 'hand-done';
"""


def round_trip(stmt, var):
    before = deadlocks()
    w = spawn(None)
    w.stdin.write(wallet_block(stmt, var))
    w.stdin.flush()
    time.sleep(0.3)
    h = spawn(None)
    h.stdin.write(HAND)
    h.stdin.flush()
    wr = finish(w, '')
    hr = finish(h, '')
    return deadlocks() - before, wr, hr


def waits_for(lock_sql, contender_sql):
    """Does contender_sql wait on a transaction holding lock_sql on A?"""
    holder = spawn(None)
    holder.stdin.write(f"BEGIN;\n{lock_sql}\nSELECT pg_sleep(2);\nCOMMIT;\n")
    holder.stdin.flush()
    time.sleep(0.4)
    code, text = attempt(f"SET lock_timeout = '300ms';\n{contender_sql}\n")
    finish(holder, '')
    return code != 0 and 'lock timeout' in text, text


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', LOG, '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB "
                        f"-c max_connections=20 -c deadlock_timeout=200ms", '-w', 'start'])
    run(SCHEMA)
    for name, (sig, live, after, _) in DOORS.items():
        text = (FX / f'{name}.live-20261021.sql').read_text()
        check(f'{name}: the fixture is the production md5', hashlib.md5(text.encode()).hexdigest() == live)
        run(text + ';')
        got = run(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")
        check(f'{name}: the loaded text reads back as production', got == live, got)

    for name in DOORS:
        stmt, var = lifted(name)
        check(f'{name}: the live door locks FOR UPDATE', stmt.endswith('FOR UPDATE;'), stmt)
        n, wr, hr = round_trip(stmt, var)
        check(f'{name}: the live lock deadlocks with a hand commit', n >= 1,
              {'deadlocks': n, 'wallet': wr, 'hand': hr})
    run(f"UPDATE public.profiles SET total_hands_played = 0; UPDATE public.tournament_players SET chips = 0;")

    code, text = attempt(MIGRATION.read_text())
    check('the migration installs', code == 0, text[-1500:])
    for name, (sig, live, after, watched) in DOORS.items():
        got = run(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")
        check(f'{name}: reads back as the derived postimage', got == after, got)
        expected = (FX / f'{name}.expected-postimage.sql').read_text()
        check(f'{name}: the postimage fixture is the derived text',
              hashlib.md5(expected.encode()).hexdigest() == after)
        changed = run(f"SELECT pg_get_functiondef('{sig}'::regprocedure)")
        live_text = (FX / f'{name}.live-20261021.sql').read_text()
        check(f'{name}: only the lock clause and its note changed',
              re.sub(r'\n\s*-- [^\n]*', '', changed).replace('FOR NO KEY UPDATE;', 'FOR UPDATE;')
              == re.sub(r'\n\s*-- [^\n]*', '', live_text).strip())
        declared = run(f"SELECT count(*) FROM public.ca_guard_defs WHERE proname = '{name}' "
                       f"AND declared_ref LIKE 'migration 20261021234940_%'")
        check(f'{name}: watched-door declaration matches', declared == ('1' if watched else '0'), declared)

    for name in DOORS:
        stmt, var = lifted(name)
        check(f'{name}: the migrated door locks FOR NO KEY UPDATE', stmt.endswith('FOR NO KEY UPDATE;'), stmt)
        n, wr, hr = round_trip(stmt, var)
        check(f'{name}: after the fix the hand and the wallet both commit, no deadlock',
              n == 0 and wr[0] == 0 and hr[0] == 0 and 'wallet-done' in wr[1] and 'hand-done' in hr[1],
              {'deadlocks': n, 'wallet': wr, 'hand': hr})
        lock = f"SELECT 1 FROM public.profiles WHERE id = '{A}' FOR NO KEY UPDATE;"
        for label, contender in (
                ('FOR UPDATE', f"SELECT 1 FROM public.profiles WHERE id = '{A}' FOR UPDATE;"),
                ('FOR NO KEY UPDATE', lock),
                ('a row UPDATE', f"UPDATE public.profiles SET diamonds = diamonds WHERE id = '{A}';")):
            waited, detail = waits_for(lock, contender)
            check(f'{name}: the migrated lock still refuses {label}', waited, detail)
        ok, detail = waits_for(lock, f"SELECT 1 FROM public.profiles WHERE id = '{A}' FOR KEY SHARE;")
        check(f'{name}: the migrated lock admits a foreign-key check', not ok, detail)
    totals = run("SELECT sum(total_hands_played)::text || '/' || (SELECT sum(chips) FROM public.tournament_players)::text FROM public.profiles")
    check('every hand that ran committed its writes exactly once', totals == '3/6', totals)

    code, text = attempt(MIGRATION.read_text())
    check('a second run is refused by the pinned preimage', code != 0 and 'is not the pinned text' in text, text[-400:])
finally:
    (out / 'results.json').write_text(json.dumps(results, indent=2))
    try:
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])
    except Exception:
        pass
    if LOG.exists():
        shutil.copy(LOG, out / 'server.log')
    shutil.rmtree(cluster, ignore_errors=True)
print(json.dumps({'passed': sum(c['passed'] for c in results['checks']), 'checks': len(results['checks'])}))
