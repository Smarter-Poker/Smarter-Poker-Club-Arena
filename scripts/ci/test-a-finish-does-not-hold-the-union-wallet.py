#!/usr/bin/env python3
"""A tournament finish must not hold its union's one wallet row for its whole body.

Measured on production 2026-10-03 03:00-05:04 UTC: 1,100+ statement timeouts and
31 deadlocks whose innermost statement is the raked cash hand's union rake
credit (INSERT ... ON CONFLICT into public.union_wallets inside
atomic_distribute_rake). The row was held, in 7 of 10 samples, by
fn_complete_tournament_terminal, whose pre_seat_guard pre-locks the union
wallet FOR NO KEY UPDATE before its evidence locks and keeps it to COMMIT.

This harness runs on a disposable PostgreSQL cluster:

  * the finish's bank-claim block (club wallet, union claim, club row) is
    compiled twice into one function: once with the migration's v_old text and
    once with its v_new text, both decoded from the shipped migration file, so
    a pass proves the text as written (the md5 pins over production's
    function are asserted by the migration itself when it is applied);
  * the hand's probe is the exact union credit statement of
    atomic_distribute_rake.

Pinned:

  BEFORE  an open finish blocks every raked hand of its union.
  AFTER   it does not; the union's finishes still serialize (same union, and
          two-union claims in either order wait rather than deadlock); another
          union's finish does not wait; and once the finish really writes the
          wallet (its fee credit) the row is held from there, as before.
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
out = (ROOT / 'artifacts/finish-union-wallet-lock').resolve()
out.mkdir(parents=True, exist_ok=True)


def find_pg_bin():
    if os.environ.get('PG_BIN'):
        return Path(os.environ['PG_BIN'])
    for cand in sorted(Path('/usr/lib/postgresql').glob('*/bin'), reverse=True):
        if (cand / 'postgres').exists():
            return cand
    return Path('/opt/homebrew/opt/postgresql@17/bin')


pg = find_pg_bin()
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
cluster = Path(tempfile.mkdtemp(prefix='finish-union-wallet-', dir='/tmp'))
socket = cluster / 'socket'
socket.mkdir(mode=0o700)
PORT = '55704'
cmd = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
       '-h', str(socket), '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'scope': 'a finish does not hold the union wallet', 'cases': [], 'passed': False}

found = sorted((ROOT / 'supabase/migrations').glob('*_a_finish_does_not_hold_the_union_wallet.sql'))
if len(found) != 1:
    raise RuntimeError(f'expected exactly one shipped migration, found {len(found)}')
SHIPPED = found[0].read_text()
CODE = '\n'.join(l for l in SHIPPED.split('\n') if not l.lstrip().startswith('--'))


def side(name):
    block = CODE[CODE.index('DO $subs$'):CODE.index('END $subs$;')]
    start = block.index(name + ' := ')
    end = block.index(';\n', block.index("';", start) if name == 'v_old' else block.index('END IF;\\n\';', start))
    parts = re.findall(r"E'((?:[^'\\]|\\.)*)'", block[start:end + 1])
    return ''.join(p.replace("\\'", "'").replace('\\n', '\n') for p in parts)


OLD, NEW = side('v_old'), side('v_new')

FIXTURE = """
CREATE TABLE public.clubs (id uuid PRIMARY KEY, union_id uuid);
CREATE TABLE public.club_wallets (club_id uuid UNIQUE NOT NULL, chip_balance numeric NOT NULL DEFAULT 0);
CREATE TABLE public.union_wallets (union_id uuid UNIQUE, chip_balance numeric, rake_wallet numeric,
  total_rake_collected numeric, updated_at timestamptz);
INSERT INTO public.clubs VALUES
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000f1'),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000f1'),
  ('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-0000000000f2');
INSERT INTO public.club_wallets (club_id) SELECT id FROM public.clubs;
INSERT INTO public.union_wallets VALUES
  ('00000000-0000-0000-0000-0000000000f1', 0, 10, 10, now()),
  ('00000000-0000-0000-0000-0000000000f2', 0, 10, 10, now());
"""
A, B, C = ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b',
           '00000000-0000-0000-0000-00000000000c')
N1, N2 = '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2'


def finish_block(union_claim):
    """The finish's bank-claim block exactly as pre_seat_guard runs it (lines
    126-150 of production's body), with the union claim under test."""
    return ("CREATE OR REPLACE FUNCTION public.finish_claims(p_club uuid, p_event_union uuid)\n"
            "RETURNS void LANGUAGE plpgsql AS $f$\n"
            "DECLARE v_t record; v_event_union_id uuid := p_event_union; v_current_union_id uuid;\n"
            "  v_locked_current_union_id uuid; p_tournament_id uuid;\nBEGIN\n"
            "  SELECT p_club AS club_id INTO v_t;\n"
            "  IF v_t.club_id IS NOT NULL THEN\n"
            "    SELECT c.union_id INTO v_current_union_id FROM public.clubs c WHERE c.id = v_t.club_id;\n"
            "    PERFORM 1 FROM public.club_wallets cw\n     WHERE cw.club_id = v_t.club_id\n"
            "     ORDER BY cw.club_id FOR NO KEY UPDATE;\n" + union_claim +
            "    SELECT c.union_id INTO v_locked_current_union_id\n      FROM public.clubs c\n"
            "     WHERE c.id = v_t.club_id\n     FOR NO KEY UPDATE;\n"
            "  END IF;\nEND $f$;\n")


def hand(union, rake='2.50'):
    # atomic_distribute_rake's union rake credit, verbatim apart from its variables.
    return ("INSERT INTO public.union_wallets (union_id, chip_balance, rake_wallet, total_rake_collected)\n"
            f"     VALUES ('{union}', 0, {rake}, {rake})\n"
            "ON CONFLICT (union_id) DO UPDATE SET\n"
            f"     rake_wallet          = public.union_wallets.rake_wallet + {rake},\n"
            f"     total_rake_collected = COALESCE(public.union_wallets.total_rake_collected, 0) + {rake},\n"
            "     updated_at           = NOW()\nRETURNING rake_wallet;")


def command(argv, sql=None, timeout=60):
    return subprocess.run([str(x) for x in argv], input=sql, text=True,
                          capture_output=True, env=env, timeout=timeout)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def run(name, sql, expected=None):
    r = command(cmd, sql)
    (out / (name + '.log')).write_text(r.stdout + r.stderr)
    passed = r.returncode == 0 and (expected is None or r.stdout.rstrip('\n') == expected)
    results['cases'].append({'name': name, 'passed': passed})
    require(passed, name + ': ' + r.stdout[-400:] + r.stderr[-1200:])
    return r.stdout.rstrip('\n')


def blocked_while_open(tag, holder_sql, probes):
    """Hold holder_sql open in one transaction, then run each probe with a short
    lock_timeout. Returns {probe_name: blocked}."""
    holder = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, env=env)
    try:
        holder.stdin.write('BEGIN;\n' + holder_sql + '\nSELECT pg_advisory_lock(3102026);\n')
        holder.stdin.flush()
        deadline = time.monotonic() + 15
        while command(cmd, "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'"
                           " AND objid=3102026 AND granted);").stdout.strip() != 't':
            require(holder.poll() is None and time.monotonic() < deadline,
                    tag + ': the holder never reached its barrier: ' + (holder.stderr.read() if holder.poll() is not None else ''))
            time.sleep(.02)
        seen = {}
        for name, sql in probes.items():
            r = command(cmd, "SET lock_timeout='1200ms';\nBEGIN;\n" + sql + "\nROLLBACK;\n")
            (out / f'{tag}-{name}.log').write_text(r.stdout + r.stderr)
            is_blocked = r.returncode != 0 and '55P03' in r.stderr
            require(r.returncode == 0 or is_blocked, f'{tag} {name} failed for another reason: ' + r.stderr[-800:])
            require('40P01' not in r.stderr, f'{tag} {name} deadlocked')
            seen[name] = is_blocked
        return seen
    finally:
        if holder.poll() is None:
            holder.stdin.write('ROLLBACK;\n')
            holder.stdin.close()
            holder.wait(timeout=10)


try:
    require(OLD.startswith('    PERFORM 1 FROM public.union_wallets uw\n') and OLD.endswith('FOR NO KEY UPDATE;\n'),
            'could not decode v_old')
    require('pg_advisory_xact_lock' in NEW and 'union_wallets uw' not in NEW, 'could not decode v_new')
    version = command([pg / 'postgres', '--version']).stdout
    require(re.search(r'PostgreSQL\) 1[6-9]\.', version), 'PostgreSQL 16+ required: ' + version)
    r = command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres',
                 '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    require(r.returncode == 0, r.stderr)
    with (cluster / 'data/postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) +
                "'\nunix_socket_permissions=0700\nport=" + PORT +
                "\nshared_buffers='16MB'\nmax_connections=20\ndeadlock_timeout='200ms'\n")
    r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-w', 'start'])
    require(r.returncode == 0, r.stderr)
    run('fixture', FIXTURE)

    # BEFORE: the finish's claim is the wallet row itself.
    run('before-image', finish_block(OLD))
    before = blocked_while_open('before', f"SELECT public.finish_claims('{A}', '{N1}');",
                                {'union-hand': hand(N1)})
    results['cases'].append({'name': 'before-an-open-finish-blocks-every-raked-hand-of-its-union',
                             **before, 'passed': before['union-hand']})
    require(before['union-hand'], 'BEFORE arm did not reproduce the convoy; '
            'the test cannot prove a fix it cannot first break')

    # AFTER: the shipped text.
    run('after-image', finish_block(NEW))
    after = blocked_while_open('after', f"SELECT public.finish_claims('{A}', '{N1}');", {
        'union-hand': hand(N1),
        'same-union-finish': f"SELECT public.finish_claims('{B}', '{N1}');",
        'other-union-finish': f"SELECT public.finish_claims('{C}', '{N2}');",
        'other-union-hand': hand(N2),
    })
    ok = (not after['union-hand'] and after['same-union-finish']
          and not after['other-union-finish'] and not after['other-union-hand'])
    results['cases'].append({'name': 'after-the-hand-passes-and-the-unions-finishes-still-serialize',
                             **after, 'passed': ok})
    require(ok, f'AFTER arm: {after}')

    # A two-union claim (event union N2, club currently in N1) and a claim
    # naming them the other way round wait for each other; neither deadlocks.
    two = blocked_while_open('two-unions', f"SELECT public.finish_claims('{A}', '{N2}');", {
        'reverse-pair-finish': f"SELECT public.finish_claims('{C}', '{N1}');",
        'union-1-hand': hand(N1),
        'union-2-hand': hand(N2),
    })
    ok = two['reverse-pair-finish'] and not two['union-1-hand'] and not two['union-2-hand']
    results['cases'].append({'name': 'two-union-claims-wait-in-sorted-order-and-hands-pass', **two, 'passed': ok})
    require(ok, f'two-union arm: {two}')

    # Once the finish really credits the union (its fee, increment_union_wallet)
    # the row is held from there to COMMIT, exactly as before.
    wrote = blocked_while_open('after-fee-credit', f"SELECT public.finish_claims('{A}', '{N1}');\n"
                               + hand(N1, '7.00'), {'union-hand': hand(N1)})
    results['cases'].append({'name': 'the-row-is-held-from-the-finishs-real-write', **wrote,
                             'passed': wrote['union-hand']})
    require(wrote['union-hand'], 'a finish that has written the wallet must hold it')

    run('nothing-was-committed-by-the-probes',
        f"SELECT rake_wallet FROM public.union_wallets WHERE union_id='{N1}';", '10')
    results['passed'] = all(c.get('passed', True) for c in results['cases'])
finally:
    if (cluster / 'data/postmaster.pid').exists():
        command([pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    if (cluster / 'server.log').exists():
        shutil.copyfile(cluster / 'server.log', out / 'server.log')
    shutil.rmtree(cluster, ignore_errors=True)
    results['ownedClusterRemoved'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps({'passed': results['passed'], 'cases': len(results['cases']),
                      'evidence': str(out)}))
