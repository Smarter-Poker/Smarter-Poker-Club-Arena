#!/usr/bin/env python3
"""PostgreSQL 17 qualification: late registration closes at whichever of its
level or clock deadline comes first.

fn_tournament_late_registration_open is the one admission authority behind
wallet, ticket and horse registration, late-registration capacity and both
satellite delivery authorities (which seat a RUNNING target's winner in the
same transaction since #5253). As installed on production it read the clock
ONLY when no level cap was configured, so "Sunday Funday Six-Card Closer"
(late_reg_levels 9, late_reg_mins 90, started 2026-09-21 04:00) still admitted
at level 3 five days later.

RED   the installed predicate (fixtures/late-registration-clock, prosrc md5
      920def27...) answers OPEN for a tournament past its clock deadline at an
      early level - asserted, so this gate proves the defect is real.
GREEN migration 20260926035534 applied verbatim from its file: that case is
      CLOSED, a tournament inside both windows is OPEN, the level cap still
      closes it inside the clock, and every legacy shape (levels only, clock
      only, rebuy-level fallback, explicit zero, finalized pool, full field,
      nothing configured, not running) answers exactly as before.
Also: the migration's preimage guard refuses a one-byte drift, its post-apply
assertions hold, and a second apply is refused (never replayed).

No production credentials, no network, no production rows: an owned cluster in
a temporary directory, removed in the finally block.
"""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIX = ROOT / 'scripts/ci/fixtures/late-registration-clock'
MIGRATION = ROOT / 'supabase/migrations/20260926035534_late_registration_closes_at_whichever_of_its_level_or_clock_.sql'
INSTALLED_PROSRC_MD5 = '920def27870ad5babe69dac7622025f7'
REFUSAL = 'LATE_REG_CLOCK_PREIMAGE_CHANGED'
CLOSER = 'c7f21a83-367c-459e-9639-067fa92516f5'

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/late-registration-clock')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
env['LANG'] = 'C'
cluster = pathlib.Path(tempfile.mkdtemp(prefix='ca-late-reg-clock-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
PORT = '55772'
results = {
    'checks': [],
    'production_mutations': False,
    'scope': 'fn_tournament_late_registration_open as installed on production (RED) and as migration 20260926035534 installs it (GREEN), with its three real dependencies, in an owned PG17 cluster.',
}
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']


def command(args, sql=None, timeout=120):
    result = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=timeout)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def run(sql):
    return command(psql, sql)


def attempt(sql):
    result = subprocess.run(list(map(str, psql)), input=sql, text=True, capture_output=True, env=env, timeout=60)
    return result.returncode == 0, result.stderr.strip()


def check(name, passed, detail=None):
    entry = {'name': name, 'passed': bool(passed)}
    if detail is not None:
        entry['detail'] = detail
    results['checks'].append(entry)
    if not passed:
        raise AssertionError(name + ('' if detail is None else ': ' + str(detail)))


def prosrc_md5():
    return run("SELECT md5(prosrc) FROM pg_proc WHERE proname='fn_tournament_late_registration_open'")


# name -> (row columns, expected answer under the corrected rule)
# Times are relative to the cluster clock so the scenarios are deterministic.
AGO = "clock_timestamp() - interval '{}'"
SCENARIOS = {
    # (a) the defect: past the clock deadline at an early level.
    'closer-past-clock-early-level': (dict(id=CLOSER, lrl=9, rbl=None, mins=90, lvl=3, started=AGO.format('5 days')), False),
    'past-clock-by-one-second': (dict(lrl=9, rbl=None, mins=90, lvl=3, started=AGO.format('90 minutes 1 second')), False),
    'rebuy-level-fallback-past-clock': (dict(lrl=None, rbl=6, mins=60, lvl=2, started=AGO.format('2 days')), False),
    'both-configured-no-start-fails-closed': (dict(lrl=9, rbl=None, mins=90, lvl=0, started='NULL'), False),
    # (b) inside both windows: level and clock both admit.
    'inside-both-windows': (dict(lrl=9, rbl=None, mins=90, lvl=3, started=AGO.format('20 minutes')), True),
    'inside-both-windows-level-zero': (dict(lrl=9, rbl=None, mins=90, lvl=0, started=AGO.format('1 minute')), True),
    # (c) the level cap still closes it while the clock is open.
    'level-cap-reached-inside-clock': (dict(lrl=9, rbl=None, mins=90, lvl=9, started=AGO.format('20 minutes')), False),
    'level-cap-passed-inside-clock': (dict(lrl=9, rbl=None, mins=90, lvl=12, started=AGO.format('20 minutes')), False),
    # Legacy shapes: unchanged answers.
    'levels-only-open': (dict(lrl=8, rbl=None, mins=0, lvl=3, started=AGO.format('5 days')), True),
    'levels-only-closed': (dict(lrl=8, rbl=None, mins=0, lvl=8, started=AGO.format('5 minutes')), False),
    'clock-only-open': (dict(lrl=0, rbl=0, mins=30, lvl=40, started=AGO.format('10 minutes')), True),
    'clock-only-closed': (dict(lrl=0, rbl=0, mins=30, lvl=0, started=AGO.format('31 minutes')), False),
    'explicit-zero-levels-suppresses-rebuy-fallback': (dict(lrl=0, rbl=6, mins=30, lvl=9, started=AGO.format('10 minutes')), True),
    'nothing-configured': (dict(lrl=0, rbl=0, mins=0, lvl=0, started=AGO.format('1 minute')), False),
    'finalized-pool': (dict(lrl=9, rbl=None, mins=90, lvl=0, started=AGO.format('1 minute'), finalized=True), False),
    'full-fixed-field': (dict(lrl=9, rbl=None, mins=90, lvl=0, started=AGO.format('1 minute'), fmt='sng-v1', maxp=2, players=2), False),
    'unlimited-mtt-ignores-max-players': (dict(lrl=9, rbl=None, mins=90, lvl=0, started=AGO.format('1 minute'), maxp=2, players=2), True),
    'not-running': (dict(lrl=9, rbl=None, mins=90, lvl=0, started=AGO.format('1 minute'), status='REGISTERING'), False),
}
# Exactly these answered wrongly before the fix; every other answer is unchanged.
DEFECT = {'closer-past-clock-early-level', 'past-clock-by-one-second',
          'rebuy-level-fallback-past-clock', 'both-configured-no-start-fails-closed'}


def seed():
    run('TRUNCATE public.tournaments, public.tournament_players;')
    for n, (row, _) in SCENARIOS.items():
        tid = row.get('id') or run("SELECT md5('late-reg-clock:" + n + "')::uuid")
        row['id'] = tid
        sql = ("INSERT INTO public.tournaments(id,name,status,format_contract,prize_pool_finalized,current_level,"
               "late_reg_levels,rebuy_levels,late_reg_mins,started_at,max_players) VALUES ("
               f"'{tid}','{n}','{row.get('status', 'RUNNING')}','{row.get('fmt', 'mtt-v2')}',"
               f"{'true' if row.get('finalized') else 'false'},{row['lvl']},"
               f"{'NULL' if row['lrl'] is None else row['lrl']},{'NULL' if row['rbl'] is None else row['rbl']},"
               f"{row['mins']},{row['started']},{row.get('maxp', 'NULL')});")
        for i in range(row.get('players', 0)):
            sql += f"INSERT INTO public.tournament_players(tournament_id,user_id) VALUES ('{tid}',md5('{n}:{i}')::uuid);"
        run(sql)


def answers():
    got = {}
    for n, (row, _) in SCENARIOS.items():
        got[n] = run(f"SELECT public.fn_tournament_late_registration_open('{row['id']}')") == 't'
    return got


try:
    check('postgres-17', command([pg / 'postgres', '--version']).startswith('postgres (PostgreSQL) 17.'))
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
             '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log',
             '-o', f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=8",
             '-w', 'start'])

    run((FIX / 'dependencies.sql').read_text())
    run((FIX / 'installed-predicate.sql').read_text())
    check('exact-production-preimage', prosrc_md5() == INSTALLED_PROSRC_MD5, prosrc_md5())
    check('exact-production-acl',
          run("SELECT proacl::text FROM pg_proc WHERE proname='fn_tournament_late_registration_open'")
          == '{postgres=X/postgres,service_role=X/postgres}')

    # ------------------------------------------------------------------ RED ---
    seed()
    before = answers()
    wrong = {n for n, (_, want) in SCENARIOS.items() if before[n] != want}
    results['red_answers'] = before
    check('RED-installed-predicate-admits-past-the-clock', wrong == DEFECT, sorted(wrong))
    check('RED-closer-reports-open-before-the-fix', before['closer-past-clock-early-level'] is True)

    # ---------------------------------------- preimage refuses a drifted body -
    ok, err = attempt('BEGIN;\n'
                      "ALTER FUNCTION public.fn_tournament_late_registration_open(uuid) SET search_path TO 'public';\n"
                      "CREATE OR REPLACE FUNCTION public.fn_tournament_late_registration_open(p_tournament_id uuid)"
                      " RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $f$ SELECT false $f$;\n"
                      + MIGRATION.read_text().split('BEGIN;', 1)[1].rsplit('COMMIT;', 1)[0] + '\nROLLBACK;\n')
    check('preimage-refuses-a-drifted-definition', (not ok) and REFUSAL in err, err[-300:])
    check('drift-attempt-rolled-back', prosrc_md5() == INSTALLED_PROSRC_MD5)

    # ---------------------------------------------------------------- GREEN ---
    migration = MIGRATION.read_text()
    check('migration-is-one-transaction', migration.count('\nBEGIN;\n') == 1 and migration.count('\nCOMMIT;\n') == 1)
    run(migration)
    check('migration-installed-new-definition', prosrc_md5() != INSTALLED_PROSRC_MD5)
    check('acl-unchanged',
          run("SELECT proacl::text FROM pg_proc WHERE proname='fn_tournament_late_registration_open'")
          == '{postgres=X/postgres,service_role=X/postgres}')
    after = answers()
    results['green_answers'] = after
    for n, (_, want) in SCENARIOS.items():
        check('GREEN-' + n, after[n] == want, {'got': after[n], 'want': want})
    check('GREEN-only-the-defect-changed',
          {n for n in SCENARIOS if before[n] != after[n]} == DEFECT)

    # ------------------------------------------------ never replayed -------
    installed = prosrc_md5()
    ok, err = attempt(migration)
    check('second-apply-is-refused', (not ok) and REFUSAL in err, err[-300:])
    check('second-apply-changed-nothing', prosrc_md5() == installed)
finally:
    subprocess.run(list(map(str, [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])),
                   capture_output=True, env=env)
    shutil.rmtree(cluster, ignore_errors=True)
    (out / 'results.json').write_text(json.dumps(results, indent=2, default=str) + '\n')

print(json.dumps({'passed': all(c['passed'] for c in results['checks']), 'checks': len(results['checks'])}))
