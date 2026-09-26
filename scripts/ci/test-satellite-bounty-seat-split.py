#!/usr/bin/env python3
"""PostgreSQL 17 qualification: a satellite seat can no longer fund a PKO's
prize ladder with its bounty.

THE MIS-SPLIT (2026-09-04, Sunday Funday High Roller PKO 3f19bd70 and
a21c0cb6). 221 horses reached two PKO events (67.50 buy-in incl. 35.00
bounty, 7.50 fee, 3,500.00 guarantee) by satellite seat. The satellite-award
path in force then credited the whole 67.50 of each seat to the PRIZE ladder
(tournament_escrow.satellite_in = n x 67.50, bounty_in = 0) and
trg_seed_bounty_head raised bounty_pool with no bank behind it. On the
66-entrant event the field received 4,455.00 against an advertised
max(3,500, 66 x 32.50) + 66 x 35.00 = 5,810.00: 1,355.00 short.

WHICH PATH HANDLES A SATELLITE AWARD INTO A PKO TODAY: none. Since
20260911110907 (#4296) a satellite cannot be created into, or re-pointed at,
a bounty / PKO / mystery-bounty / Spin target (trigger
satellite_feeds_only_a_deliverable_target), and
fn_settle_satellite_tournament refuses such a target before any money moves
("uses an unsupported bounty or Spin entry split"). fn_award_satellite_seat,
the only seat path that ever carried the bounty slice, splits through
fn_tournament_entry_split. This probe pins all of it on production's exact
definitions:

RED    the 09-04 arithmetic, reproduced with production's own
       fn_tournament_entry_split: crediting the whole seat to the prize ladder
       shorts the 66-entrant field by exactly 1,355.00 and the 155-entrant
       field by 0.00.
GREEN  the split production uses carves 35.00 of every 75.00 seat into the
       bounty and 32.50 into the prize; a satellite INSERTed with a PKO,
       bounty, mystery or Spin target is refused; re-pointing a satellite at
       one is refused; turning a live satellite's target into a PKO is
       refused; a plain buy-in target is accepted.

No production credentials, no network, no production rows.
"""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
PROBE = ROOT / 'scripts/ci/probes/satellite-bounty-split'

# Production identities read 2026-09-26 on project kuklfnapbkmacvwxktbh.
PINNED = {
    'fn_tournament_entry_split': '46074e04b60ecb97557b63ef25c5739d',
    'fn_satellite_target_is_deliverable': '04d7e4261b54193a2c46916eb8b9f41e',
    'fn_satellite_feeds_only_a_deliverable_target': 'e5fed8a4fe1dc07bf2628b84d07538ce',
}
REFUSAL = 'the satellite settlement authority refuses a bounty, PKO, mystery-bounty or Spin entry split'
LIVE_REFUSAL = 'is fed by a live satellite and cannot take a bounty, PKO, mystery-bounty or Spin entry split'

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/satellite-bounty-seat-split')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
env['LANG'] = 'C'
cluster = pathlib.Path(tempfile.mkdtemp(prefix='ca-satellite-bounty-split-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
PORT = '55773'
results = {'checks': [], 'production_mutations': False,
           'scope': "Production's exact fn_tournament_entry_split and satellite-target guard in an owned PG17 cluster. No production row is read or written."}
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']


def command(args, sql=None, timeout=120):
    result = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=timeout)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def run(sql):
    return command(psql, sql)


def attempt(sql):
    result = subprocess.run(list(map(str, psql)), input='BEGIN;\n' + sql + '\nROLLBACK;\n',
                            text=True, capture_output=True, env=env, timeout=60)
    return result.returncode == 0, result.stderr.strip()


def check(name, passed, detail=None):
    entry = {'name': name, 'passed': bool(passed)}
    if detail is not None:
        entry['detail'] = detail
    results['checks'].append(entry)
    if not passed:
        raise AssertionError(name + ('' if detail is None else ': ' + str(detail)))


def refused(name, sql, needle=REFUSAL):
    ok, err = attempt(sql)
    check(name, (not ok) and needle in err, err[-300:])


def accepted(name, sql):
    ok, err = attempt(sql)
    check(name, ok, err[-300:] if err else None)


SCHEMA = """
CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,
  name text,
  status text NOT NULL DEFAULT 'REGISTERING',
  variant text,
  tournament_type text,
  is_bounty boolean NOT NULL DEFAULT false,
  is_pko boolean NOT NULL DEFAULT false,
  is_mystery_bounty boolean NOT NULL DEFAULT false,
  is_premium_spin boolean NOT NULL DEFAULT false,
  satellite_target_id uuid,
  satellite_target uuid
);
"""
TRIGGER = ("CREATE TRIGGER satellite_feeds_only_a_deliverable_target BEFORE INSERT OR UPDATE OF satellite_target_id, "
           "satellite_target, is_bounty, is_pko, is_mystery_bounty, is_premium_spin, variant, tournament_type "
           "ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_satellite_feeds_only_a_deliverable_target();")

PKO = "'00000000-0000-0000-0000-00000000f019'"
PLAIN = "'00000000-0000-0000-0000-0000000000aa'"
SAT = "'00000000-0000-0000-0000-00000000005a'"

try:
    check('postgres-17', command([pg / 'postgres', '--version']).startswith('postgres (PostgreSQL) 17.'))
    command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
             '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log',
             '-o', f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=8",
             '-w', 'start'])
    run(SCHEMA)
    for name in PINNED:
        run((PROBE / f'{name}.sql').read_text() + ';')
        got = run(f"SELECT md5(prosrc) FROM pg_proc WHERE proname='{name}'")
        check(f'exact-production-{name}', got == PINNED[name], got)
    run(TRIGGER)

    # ------------------------------------------------------------------ RED ---
    # The 09-04 path: the whole 67.50 of every seat went to the prize ladder.
    # What the field was owed is the split production uses, plus the guarantee
    # on the prize ladder; what it got is n x 67.50 through that ladder.
    short = run("""
      SELECT string_agg(n || ':' || round(owed - paid, 2), ',' ORDER BY n)
        FROM (SELECT n, GREATEST(3500.00, n * s.prize) + n * s.bounty AS owed, n * 67.50 AS paid
                FROM (VALUES (66), (155)) v(n)
                CROSS JOIN LATERAL public.fn_tournament_entry_split(67.50, 7.50, 35.00, true) s) z""")
    check('RED-the-0904-mis-split-shorts-66-entrants-by-1355-and-155-by-0', short == '66:1355.00,155:0.00', short)

    # ---------------------------------------------------------------- GREEN ---
    split = run("SELECT charge || '/' || rake || '/' || bounty || '/' || prize FROM public.fn_tournament_entry_split(67.50, 7.50, 35.00, true)")
    check('GREEN-a-75-seat-carves-35-bounty-and-32.50-prize', split == '75.00/7.50/35.00/32.50', split)
    plain = run("SELECT bounty || '/' || prize FROM public.fn_tournament_entry_split(67.50, 7.50, 35.00, false)")
    check('GREEN-a-plain-target-carries-no-bounty', plain == '0/67.50', plain)

    run(f"INSERT INTO public.tournaments(id, name, is_pko, is_bounty, variant) VALUES ({PKO}, 'PKO target', true, true, 'progressive_bounty');")
    run(f"INSERT INTO public.tournaments(id, name) VALUES ({PLAIN}, 'Plain target');")
    for flag in ('is_pko', 'is_bounty', 'is_mystery_bounty', 'is_premium_spin'):
        tid = "'00000000-0000-0000-0000-0000000001" + str(len(flag)).zfill(2) + "'"
        refused(f'GREEN-a-satellite-into-a-{flag}-target-is-refused',
                f"INSERT INTO public.tournaments(id, name, {flag}) VALUES ({tid}, 'T', true);\n"
                f"INSERT INTO public.tournaments(id, name, variant, satellite_target_id) VALUES ({SAT}, 'S', 'satellite', {tid});")
    refused('GREEN-a-satellite-into-a-spin-target-is-refused',
            "INSERT INTO public.tournaments(id, name, variant) VALUES ('00000000-0000-0000-0000-000000000599', 'Spin', 'spin');\n"
            f"INSERT INTO public.tournaments(id, name, variant, satellite_target) VALUES ({SAT}, 'S', 'satellite', '00000000-0000-0000-0000-000000000599');")
    refused('GREEN-a-satellite-into-the-0904-PKO-shape-is-refused',
            f"INSERT INTO public.tournaments(id, name, variant, satellite_target_id) VALUES ({SAT}, 'S', 'satellite', {PKO});")
    accepted('GREEN-a-satellite-into-a-plain-target-is-accepted',
             f"INSERT INTO public.tournaments(id, name, variant, satellite_target_id) VALUES ({SAT}, 'S', 'satellite', {PLAIN});")
    refused('GREEN-re-pointing-a-satellite-at-a-PKO-is-refused',
            f"INSERT INTO public.tournaments(id, name, variant, satellite_target_id) VALUES ({SAT}, 'S', 'satellite', {PLAIN});\n"
            f"UPDATE public.tournaments SET satellite_target_id = {PKO} WHERE id = {SAT};")
    refused('GREEN-a-live-satellite-target-cannot-become-a-PKO',
            f"INSERT INTO public.tournaments(id, name, variant, satellite_target_id) VALUES ({SAT}, 'S', 'satellite', {PLAIN});\n"
            f"UPDATE public.tournaments SET is_pko = true, is_bounty = true WHERE id = {PLAIN};", LIVE_REFUSAL)
    accepted('GREEN-a-finished-satellite-does-not-pin-its-target',
             f"INSERT INTO public.tournaments(id, name, variant, status, satellite_target_id) VALUES ({SAT}, 'S', 'satellite', 'COMPLETED', {PLAIN});\n"
             f"UPDATE public.tournaments SET is_pko = true, is_bounty = true WHERE id = {PLAIN};")
finally:
    subprocess.run(list(map(str, [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])),
                   capture_output=True, env=env)
    shutil.rmtree(cluster, ignore_errors=True)
    (out / 'results.json').write_text(json.dumps(results, indent=2) + '\n')

print(json.dumps({'passed': all(c['passed'] for c in results['checks']), 'checks': len(results['checks'])}))
