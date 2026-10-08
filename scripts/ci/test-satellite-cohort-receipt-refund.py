"""Isolated PostgreSQL regression: a settled pre-start unregistration refund
does not block a cohort satellite's receipt.

fn_ca_satellite_cohort_receipt closes every cohort satellite settlement and
requires the satellite's tournament_obligations rows to number exactly its
cash tickets plus one remainder row. It also counted the settled refund rows
fn_unregister_from_tournament writes for a player who left before the start,
so on 2026-10-07 satellite 32190e8c (three such refunds) was refused at its
own receipt every six seconds for eleven hours. 20261003023500 had already
taught the single-winner receipt (fn_ca_satellite_settlement_receipt) and both
settlement guards to ignore exactly those rows; the cohort receipt was missed.

The test loads the exact production text of the cohort receipt captured on
2026-10-08 (pg_get_functiondef md5 equal to production's) and, for the
single-winner receipt, a probe carrying the obligation count exactly as
20261003023500 installed it on production. It takes the obligation-count
statement out of each loaded definition and runs it against fixture
obligations, proves the cohort receipt counts the settled refunds (the
refusal) while the single-winner rule does not, then applies the candidate
migration verbatim and proves:
  * the cohort receipt reproduces production's derived postimage md5;
  * it no longer counts a settled pre-start unregistration refund;
  * it still counts every other obligation (seat cash ticket, remainder, an
    unsettled or partly paid unregistration refund, a refund from any other
    source), and never another tournament's rows;
  * the two receipts now count identically in every case;
  * owner, SECURITY DEFINER, settings and grants did not move;
  * a second run refuses on the pinned preimage.
An empty throwaway cluster on a Unix socket; no network, no production
connection. check_function_bodies is off for this cluster only, because the
receipts reference tables this fixture does not build; production has them.
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'supabase' / 'migrations'
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'satellite-cohort-receipt-refund'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/satellite-cohort-receipt-refund')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
env['PGOPTIONS'] = '-c check_function_bodies=off'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='sat-cohort-receipt-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55819'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

COHORT = 'public.fn_ca_satellite_cohort_receipt(uuid,uuid[])'
SINGLE = 'public.fn_ca_satellite_settlement_receipt(uuid,uuid)'
# pg_get_functiondef md5 read on production 2026-10-08; the postimage was
# derived read-only on production with replace() of the migration's anchor.
LIVE_COHORT_MD5 = '08e2b78fead0943c8106f72deb5d8788'
POST_COHORT_MD5 = 'b77ddbf69afdb53bd342e6e0c0f3a5a2'
# Production: owner postgres, SECURITY DEFINER, EXECUTE to postgres only.
GRANTS = f'''
REVOKE ALL ON FUNCTION {COHORT} FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION {SINGLE} FROM PUBLIC, anon, authenticated, service_role;
'''
# The single-winner receipt's obligation count, exactly as 20261003023500
# substituted it into production's fn_ca_satellite_settlement_receipt.
SINGLE_FIX = sorted(MIGRATIONS.glob('20261003023500_*.sql'))
SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE public.tournament_obligations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL, kind text NOT NULL, place integer, user_id uuid,
  amount_owed numeric(20,2) NOT NULL, amount_paid numeric(20,2) NOT NULL DEFAULT 0,
  source text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  settled_at timestamptz, adjustment_id uuid, terminal_closed_at timestamptz);
CREATE SCHEMA probe;
"""
COUNT_STMT = re.compile(
    r'  SELECT count\(\*\) INTO v_rows\n    FROM public\.tournament_obligations o\n'
    r'   WHERE o\.tournament_id = p_tournament_id[^;]*;')

SAT = uuid.UUID(int=0x5a7)
OTHER = uuid.UUID(int=0x07e)
U = [uuid.UUID(int=0x100 + i) for i in range(8)]
SETTLED_REFUND = ('refund', 'fn_unregister_from_tournament', '25.00', '25.00', True)
# (case, rows for SAT, count the receipt must see once fixed)
CASES = [
    ('three-settled-pre-start-refunds', [SETTLED_REFUND] * 3, 0),
    ('no-obligations', [], 0),
    ('refunds-plus-one-seat-cash-ticket',
     [SETTLED_REFUND] * 3 + [('seat', 'engine.fn_settle_satellite_tournament', '200.00', '200.00', True)], 1),
    ('refunds-plus-remainder',
     [SETTLED_REFUND] * 2 + [('satellite_remainder', 'engine.fn_settle_satellite_tournament', '12.50', '12.50', True)], 1),
    ('unsettled-unregistration-refund', [('refund', 'fn_unregister_from_tournament', '25.00', '0.00', False)], 1),
    ('partly-paid-unregistration-refund', [('refund', 'fn_unregister_from_tournament', '25.00', '10.00', True)], 1),
    ('settled-refund-from-another-source', [('refund', 'atomic_cancel_tournament', '25.00', '25.00', True)], 1),
]


def command(args, sql=None):
    r = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=60)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def run(sql):
    return command(psql, sql)


def check(name, passed, detail=None):
    results['checks'].append({'name': name, 'passed': bool(passed), 'detail': detail})
    if not passed:
        raise AssertionError(f'{name}: {detail}')


def lit(v):
    return 'NULL' if v is None else "'" + str(v).replace("'", "''") + "'"


def live_def(sig):
    return run(f"SELECT pg_get_functiondef('{sig}'::regprocedure)")


def md5_of(sig):
    return run(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")


def install_counter(sig, name):
    """Run the receipt's own obligation-count statement, taken verbatim from
    the definition loaded in this cluster, as a probe function."""
    found = COUNT_STMT.findall(live_def(sig))
    check(f'{name}-has-exactly-one-obligation-count', len(found) == 1, len(found))
    run(f'CREATE OR REPLACE FUNCTION probe.{name}(p_tournament_id uuid) RETURNS integer '
        f'LANGUAGE plpgsql AS $p$DECLARE v_rows integer; BEGIN\n{found[0]}\nRETURN v_rows; END$p$;')
    return found[0]


def seed(rows):
    sql = ['TRUNCATE public.tournament_obligations;']
    # Another tournament's settled seat obligation must never be counted.
    sql.append(f"INSERT INTO public.tournament_obligations(tournament_id, kind, user_id, amount_owed, amount_paid, source, settled_at) "
               f"VALUES ({lit(OTHER)}, 'seat', {lit(U[7])}, 200.00, 200.00, 'engine.fn_settle_satellite_tournament', now());")
    for i, (kind, source, owed, paid, settled) in enumerate(rows):
        sql.append(f"INSERT INTO public.tournament_obligations(tournament_id, kind, user_id, amount_owed, amount_paid, source, settled_at) "
                   f"VALUES ({lit(SAT)}, {lit(kind)}, {lit(U[i])}, {owed}, {paid}, {lit(source)}, "
                   f"{'now()' if settled else 'NULL'});")
    run('\n'.join(sql))


def counts():
    return {n: int(run(f"SELECT probe.{n}({lit(SAT)})")) for n in ('cohort', 'single')}


def meta(sig):
    return run(f"SELECT proacl::text || '|' || pg_get_userbyid(proowner) || '|' || prosecdef::text || '|' "
               f"|| array_to_string(proconfig, ',') FROM pg_proc WHERE oid = '{sig}'::regprocedure")


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)

    # ── Baseline: the exact production definitions before this change ──────
    check('single-receipt-fix-exists-once', len(SINGLE_FIX) == 1, [p.name for p in SINGLE_FIX])
    single_count = re.findall(r"\$i\$(  SELECT count\(\*\) INTO v_rows\n.*?;)\$i\$\);", SINGLE_FIX[0].read_text(), re.S)
    check('single-receipt-fix-carries-one-count', len(single_count) == 1, len(single_count))
    run((FIXTURES / 'fn_ca_satellite_cohort_receipt.sql').read_text() + ';\n'
        + 'CREATE OR REPLACE FUNCTION public.fn_ca_satellite_settlement_receipt(p_tournament_id uuid, p_winner_id uuid) RETURNS jsonb '
        + 'LANGUAGE plpgsql SECURITY DEFINER SET search_path TO \'public\' AS $function$\n'
        + 'DECLARE v_rows integer; BEGIN\n' + single_count[0] + '\nRETURN to_jsonb(v_rows); END $function$;\n' + GRANTS)
    check('baseline-cohort-receipt-is-production-preimage', md5_of(COHORT) == LIVE_COHORT_MD5, md5_of(COHORT))
    meta_before = {COHORT: meta(COHORT), SINGLE: meta(SINGLE)}
    single_md5 = md5_of(SINGLE)
    install_counter(COHORT, 'cohort')
    single_stmt = install_counter(SINGLE, 'single')
    seed(CASES[0][1])
    base = counts()
    results['baseline'] = base
    # The defect: the cohort receipt sees three obligations where it expects
    # zero (no cash ticket, no remainder) and refuses; the single-winner
    # receipt already ignores the same rows.
    check('baseline-cohort-receipt-counts-settled-refunds', base['cohort'] == 3, base)
    check('baseline-single-receipt-already-ignores-them', base['single'] == 0, base)

    # ── Candidate: the migration under test, applied verbatim ──────────────
    candidate = sorted(MIGRATIONS.glob('*_a_pre_start_unregistration_refund_does_not_block_a_cohort_sa.sql'))
    check('candidate-exists-once', len(candidate) == 1, [p.name for p in candidate])
    migration = candidate[0].read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    run(migration)
    check('candidate-reproduces-production-derived-postimage', md5_of(COHORT) == POST_COHORT_MD5, md5_of(COHORT))
    check('candidate-leaves-single-receipt-alone', meta(SINGLE) == meta_before[SINGLE] and single_md5 == md5_of(SINGLE))
    check('cohort-owner-security-settings-grants-unchanged', meta(COHORT) == meta_before[COHORT],
          [meta(COHORT), meta_before[COHORT]])
    cohort_stmt = install_counter(COHORT, 'cohort')
    check('both-receipts-carry-the-identical-count', cohort_stmt == single_stmt)
    results['candidate'] = {}
    for name, rows, expected in CASES:
        seed(rows)
        c = counts()
        results['candidate'][name] = c
        check('cohort-counts-' + name, c['cohort'] == expected, {'got': c, 'expected': expected})
        check('receipts-agree-' + name, c['cohort'] == c['single'], c)

    replay = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-a-second-run',
          replay.returncode != 0 and 'is not the pinned text' in replay.stderr, replay.stderr[-300:])
    check('second-run-left-the-postimage', md5_of(COHORT) == POST_COHORT_MD5)
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'baseline': results.get('baseline'),
                  'candidate': results.get('candidate'), 'output': str(out / 'RESULTS.json')}))
