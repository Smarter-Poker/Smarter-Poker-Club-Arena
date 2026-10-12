"""Isolated PostgreSQL regression for the rake-law monitor on Diamond hands.

fn_rake_law_violations must not price a Diamond cash hand with the chip spec:
a Diamond table's rake_percent and rake_cap_bb are explicitly zero by rule
(DiamondCashBoundary), so the chip spec reads them as a 0% override and every
raked Diamond hand became over_spec (2,278 rows from 2026-10-07 04:40 UTC,
every one settled by fn_poker_diamond_settle_cash_hand at exactly its
recorded rake). A Diamond hand is instead checked against the rake its
settlement receipt accepted (diamond_rake_unsettled), and a chip hand is
priced exactly as before.

fn_ca_escalate_reconcile_criticals must file a rake_law finding under the
same source as fn_ca_reconcile_log_to_incident (COALESCE(source, kind)), so
one finding is one alert class rather than over_spec and rake_law.

The test loads the exact production definitions (their pg_get_functiondef md5
equals production's on 2026-10-08), proves the defect on both, applies the
candidate migration (a pinned-text substitution) and proves the fix and the
production-derived postimage md5. An empty throwaway cluster on a Unix
socket; no network, no production connection.
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'supabase' / 'migrations'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/rake-law-diamond-hands')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='rake-law-diamond-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55829'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

# pg_get_functiondef md5 of the production functions read on 2026-10-08,
# before and after the candidate (derived read-only on production).
LIVE_VIOL_DEF_MD5 = '812a68328e7f0aeeefe56205d337bf33'
LIVE_ESC_DEF_MD5 = '0866dffd580904655904c7fb7fbc05c4'
POST_VIOL_DEF_MD5 = 'a3e1fde3f45140c91640389d419ed553'
POST_ESC_DEF_MD5 = '09419f2424c729220b8dbaf5475e60c5'
VIOL_SIG = 'public.fn_rake_law_violations(interval)'
ESC_SIG = 'public.fn_ca_escalate_reconcile_criticals(interval)'
# Production's grants on both functions (read 2026-10-08).
GRANTS = '''
REVOKE ALL ON FUNCTION public.fn_rake_law_violations(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_rake_law_violations(interval) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_escalate_reconcile_criticals(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_escalate_reconcile_criticals(interval) TO service_role;
'''


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


def definition(path, name):
    source = path.read_text()
    m = re.search(r'CREATE OR REPLACE FUNCTION public\.' + re.escape(name) + r'\(.*?AS (\$[A-Za-z_0-9]*\$).*?\1;', source, re.S)
    if not m:
        raise ValueError('missing definition: ' + name + ' in ' + path.name)
    return m.group(0)


def one(glob):
    found = sorted(MIGRATIONS.glob(glob))
    if len(found) != 1:
        raise RuntimeError(f'expected exactly one {glob}, found {len(found)}')
    return found[0]


def defmd5(sig):
    return run(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")


SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE clubs(id uuid PRIMARY KEY, default_rake_percent numeric, rake_cap numeric,
  bbj_rake_enabled boolean, asset text);
CREATE TABLE tables(id uuid PRIMARY KEY, club_id uuid, small_blind numeric, big_blind numeric,
  max_players integer, game_variant text, rake_percent numeric, rake_cap_bb numeric, tournament_id uuid);
CREATE TABLE hand_history(id uuid PRIMARY KEY, table_id uuid, hand_number integer, created_at timestamptz,
  rake_amount numeric, bbj_amount numeric, pot_size numeric, game_variant text, players jsonb,
  community_cards text[], community_cards2 text[], showdown jsonb, actions jsonb, tournament_id uuid);
CREATE TABLE rake_records(hand_id uuid, bbj_contribution numeric, num_players integer);
CREATE TABLE poker_diamond_hand_receipts(table_id uuid, hand_number bigint, request jsonb, receipt jsonb,
  created_at timestamptz DEFAULT now(), PRIMARY KEY (table_id, hand_number));
CREATE TABLE ledger_reconcile_log(run_date date, entity_type text, entity_id uuid, ledger_balance numeric,
  stored_balance numeric, drift numeric, severity text, metadata jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE filed(source text, dedupe_key text, entity_type text);

-- Stand-ins for the chip spec readers. The chip spec: an explicit override
-- wins, otherwise 5% capped at 3 big blinds. Only the override semantics
-- matter here, and they are production's (>= 0 is an override).
CREATE FUNCTION public.fn_effective_rake(p_bb numeric, p_pot numeric, p_dealt integer, p_flop boolean,
  p_sb numeric, p_pct numeric, p_cap_bb numeric, p_seats integer)
RETURNS TABLE(rake numeric, cap numeric, percent numeric) LANGUAGE sql AS $f$
  SELECT least(trunc(p_pot * COALESCE(p_pct, 5) / 100, 2), COALESCE(p_cap_bb, 3) * p_bb),
         COALESCE(p_cap_bb, 3) * p_bb, COALESCE(p_pct, 5)
$f$;
CREATE FUNCTION public.fn_effective_bbj_drop(numeric, integer, boolean, uuid, uuid, text, numeric, numeric, numeric)
RETURNS numeric LANGUAGE sql AS $f$ SELECT 0::numeric $f$;
CREATE FUNCTION public.fn_ca_remeasure_entity(p_entity_type text, p_entity_id uuid)
RETURNS TABLE(measurable boolean, ledger_balance numeric, stored_balance numeric, severity text)
LANGUAGE sql AS $f$ SELECT false, NULL::numeric, NULL::numeric, NULL::text $f$;
CREATE FUNCTION public.fn_ca_raise_drift_incident(p_source text, p_classification text, p_severity text,
  p_dedupe_key text, p_discrepancy numeric, p_expected numeric, p_actual numeric, p_layer text,
  p_entity_type text, p_entity_id uuid, p_club_id uuid, p_union_id uuid, p_table_id uuid, p_hand_id uuid,
  p_tournament_id uuid, p_currency text, p_wallet_ids uuid[], p_transaction_ids uuid[],
  p_suspected_cause text, p_past_target boolean, p_metadata jsonb)
RETURNS uuid LANGUAGE sql AS $f$
  INSERT INTO filed VALUES (p_source, p_dedupe_key, p_entity_type) RETURNING gen_random_uuid()
$f$;
"""

CHIP_CLUB, DIAMOND_CLUB = '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000d001'
CHIP_TABLE, DIAMOND_TABLE = '00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-00000000d0a1'
BOARD = "ARRAY['As','Kd','7c','2h','9s']"
PLAYERS = '\'[{"seat":1},{"seat":2},{"seat":3}]\'::jsonb'
FLOP_ACTIONS = '\'[{"stage":"preflop"},{"stage":"flop"}]\'::jsonb'
PRE_ACTIONS = '\'[{"stage":"preflop"}]\'::jsonb'

# (key, table, hand_number, pot, rake, board?, receipt rake or None)
HANDS = [
    ('chip-fair',                  CHIP_TABLE,    1, 100, 5, True,  None),
    ('chip-overraked',             CHIP_TABLE,    2, 100, 9, True,  None),
    ('diamond-settled',            DIAMOND_TABLE, 3, 100, 5, True,  5),
    ('diamond-disagrees',          DIAMOND_TABLE, 4, 100, 6, True,  5),
    ('diamond-raked-unreceipted',  DIAMOND_TABLE, 5, 100, 4, True,  None),
    ('diamond-unraked-unreceipted', DIAMOND_TABLE, 6, 100, 0, True,  None),
    ('diamond-preflop-settled',    DIAMOND_TABLE, 7, 20,  2, False, 2),
]


def hid(n):
    return f'00000000-0000-0000-0000-{n:012d}'


def seed():
    sql = [f"""TRUNCATE clubs, tables, hand_history, rake_records, poker_diamond_hand_receipts, ledger_reconcile_log, filed;
INSERT INTO clubs VALUES ('{CHIP_CLUB}', -1, -1, true, 'chips'), ('{DIAMOND_CLUB}', -1, -1, false, 'diamonds');
INSERT INTO tables VALUES ('{CHIP_TABLE}', '{CHIP_CLUB}', 1, 2, 9, 'nlh', -1, -1, NULL),
                          ('{DIAMOND_TABLE}', '{DIAMOND_CLUB}', 1, 2, 9, 'nlh', 0, 0, NULL);"""]
    for key, table, n, pot, rake, board, receipt in HANDS:
        sql.append(
            f"INSERT INTO hand_history VALUES ('{hid(n)}', '{table}', {n}, now() - interval '10 minutes', {rake}, 0, {pot}, 'nlh', "
            f"{PLAYERS}, {BOARD if board else 'NULL'}, NULL, NULL, {FLOP_ACTIONS if board else PRE_ACTIONS}, NULL);")
        if receipt is not None:
            sql.append(f"INSERT INTO poker_diamond_hand_receipts(table_id, hand_number, request, receipt) VALUES "
                       f"('{table}', {n}, '{{}}'::jsonb, jsonb_build_object('rake', {receipt}));")
    sql.append(f"""INSERT INTO ledger_reconcile_log(run_date, entity_type, entity_id, ledger_balance, stored_balance, drift, severity, metadata) VALUES
  (CURRENT_DATE, 'rake_law', '{DIAMOND_TABLE}', 0, 5, NULL, 'critical', '{{"kind":"over_spec","hand_id":"{hid(3)}"}}'),
  (CURRENT_DATE, 'player_wallet', '00000000-0000-0000-0000-0000000000a1', 0, 1, 1, 'critical', '{{"source":"reconcile_ledger_nightly"}}'),
  (CURRENT_DATE, 'club_treasury', '{CHIP_CLUB}', 0, 1, 1, 'critical', '{{}}');""")
    run('\n'.join(sql))


def violations():
    rows = run(f"SELECT kind || '|' || hand_id || '|' || COALESCE(allowed::text, 'null') FROM public.fn_rake_law_violations('1 hour') ORDER BY 1")
    found = {}
    for line in filter(None, rows.splitlines()):
        kind, h, allowed = line.split('|')
        key = next(k for k, _, n, *_ in HANDS if hid(n) == h)
        found.setdefault(key, []).append((kind, allowed))
    return found


def escalated():
    run('TRUNCATE filed; SELECT * FROM public.fn_ca_escalate_reconcile_criticals(\'36 hours\');')
    return dict(line.split('|') for line in run('SELECT entity_type || \'|\' || source FROM filed ORDER BY 1').splitlines())


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)

    # Baseline: the exact production definitions before this change. Both are
    # unchanged on production since these migrations (prosrc md5 equal).
    base_viol = definition(one('20260921023500_a_hand_that_ended_preflop_has_no_board_to_record.sql'), 'fn_rake_law_violations')
    base_esc = definition(one('20260921024924_the_measurement_functions_say_what_they_measure.sql'), 'fn_ca_escalate_reconcile_criticals')
    run(base_viol + '\n' + base_esc + '\n' + GRANTS)
    check('baseline-violations-is-production-preimage', defmd5(VIOL_SIG) == LIVE_VIOL_DEF_MD5, defmd5(VIOL_SIG))
    check('baseline-escalator-is-production-preimage', defmd5(ESC_SIG) == LIVE_ESC_DEF_MD5, defmd5(ESC_SIG))
    seed()
    v, e = violations(), escalated()
    results['baseline'] = {'violations': v, 'escalated': e}
    check('baseline-flags-a-settled-diamond-hand-as-over-spec', v.get('diamond-settled') == [('over_spec', '0.00')], v)
    check('baseline-flags-a-settled-diamond-preflop-hand-as-no-flop-no-drop',
          v.get('diamond-preflop-settled') == [('no_flop_no_drop', '0')], v)
    check('baseline-flags-the-chip-overrake', v.get('chip-overraked') == [('over_spec', '5.00')], v)
    check('baseline-escalator-files-rake-law-under-a-second-name', e.get('rake_law') == 'ledger_reconcile_log:rake_law', e)

    # Candidate: the migration under test, applied as production would.
    candidate = one('*_a_diamond_hand_is_priced_by_the_diamond_settler_not_the_chip.sql')
    migration = candidate.read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    run(migration)
    check('candidate-reproduces-production-derived-violations-postimage', defmd5(VIOL_SIG) == POST_VIOL_DEF_MD5, defmd5(VIOL_SIG))
    check('candidate-reproduces-production-derived-escalator-postimage', defmd5(ESC_SIG) == POST_ESC_DEF_MD5, defmd5(ESC_SIG))
    seed()
    v, e = violations(), escalated()
    results['candidate'] = {'violations': v, 'escalated': e}
    check('settled-diamond-hand-is-not-a-finding', 'diamond-settled' not in v, v)
    check('settled-diamond-preflop-hand-is-not-a-finding', 'diamond-preflop-settled' not in v, v)
    check('unraked-unreceipted-diamond-hand-is-not-a-finding', 'diamond-unraked-unreceipted' not in v, v)
    check('diamond-rake-that-differs-from-its-receipt-is-a-finding',
          v.get('diamond-disagrees') == [('diamond_rake_unsettled', '5')], v)
    check('diamond-rake-with-no-receipt-is-a-finding',
          v.get('diamond-raked-unreceipted') == [('diamond_rake_unsettled', 'null')], v)
    check('chip-overrake-still-over-spec', v.get('chip-overraked') == [('over_spec', '5.00')], v)
    check('fair-chip-hand-still-clean', 'chip-fair' not in v, v)
    check('escalator-files-rake-law-under-the-trigger-source', e.get('rake_law') == 'ledger_reconcile_log:over_spec', e)
    check('escalator-keeps-an-explicit-source', e.get('player_wallet') == 'ledger_reconcile_log:reconcile_ledger_nightly', e)
    check('escalator-keeps-entity-type-when-nothing-else-names-it', e.get('club_treasury') == 'ledger_reconcile_log:club_treasury', e)
    for role in ('anon', 'authenticated'):
        r = subprocess.run(list(map(str, psql)), input=f"SET ROLE {role}; SELECT * FROM public.fn_rake_law_violations('1 hour');",
                           text=True, capture_output=True, env=env, timeout=30)
        check(role + '-cannot-read-violations', r.returncode != 0 and 'permission denied' in r.stderr)
    replay = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-a-second-run',
          replay.returncode != 0 and 'is not the pinned text' in replay.stderr, replay.stderr[-300:])
    check('second-run-left-the-postimage', defmd5(VIOL_SIG) == POST_VIOL_DEF_MD5)
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'baseline': results.get('baseline'),
                  'candidate': results.get('candidate'), 'output': str(out / 'RESULTS.json')}))
