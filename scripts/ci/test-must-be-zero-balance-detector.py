#!/usr/bin/env python3
"""PostgreSQL 17 qualification: a must_be_zero account is checked by its balance.

RED is the detector exactly as installed before migration 20260925131500 - a
sixty-minute flow window - against a settlement_suspense that stands at
4,170,904.48 with no leg in eleven days. GREEN is the same state through the
candidate. The incident filer is production's real fn_ca_raise_drift_incident,
not a stub, because the claim that a standing imbalance folds into ONE incident
is a claim about that function. Only notification DELIVERY is stubbed, and it is
qualified elsewhere.

No production credentials, no network, no production rows: an owned cluster in a
temporary directory, removed in the finally block.
"""
import argparse
import decimal
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
PROBE = ROOT / 'scripts/ci/probes/must-be-zero-balance'
MIGRATION = ROOT / 'supabase/migrations/20260925131500_a_must_be_zero_account_is_checked_by_its_balance.sql'

# Production identities read 2026-09-25 on project kuklfnapbkmacvwxktbh. A drift
# in any of them means this probe is qualifying something other than what runs.
INSTALLED_DETECTOR_MD5 = '0d5579e36566f6f0c4ec1285549e11e6'
INCIDENT_FILER_MD5 = 'a6df5f2eef07aa3f606db79d93944590'
MIDWAY_SCOPE_MD5 = 'a5a8bb3048872ea4c8acf58f1f64390d'
STABLE_KEY_MD5 = 'c894c79fd08c95666e25d6f0ee4f11d0'

# The production figures this defect was measured at, 2026-09-25 12:52 UTC.
SUSPENSE_IN = '21730142.57'
SUSPENSE_OUT = '17559238.09'
SUSPENSE_BALANCE = '4170904.48'

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/must-be-zero-balance')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
env['LANG'] = 'C'
cluster = pathlib.Path(tempfile.mkdtemp(prefix='ca-must-be-zero-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
PORT = '55763'
results = {
    'checks': [],
    'production_mutations': False,
    'scope': 'The repaired fn_ca_suspense_regression_check, its maintained ca_must_be_zero_hours balance and production\'s real incident filer, in an owned PG17 cluster. Notification delivery is recorded, not delivered. No financial acceptance and no production row is read or written.',
}
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']


def command(args, sql=None, timeout=120):
    result = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=timeout)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def run(sql):
    return command(psql, sql)


def check(name, passed, detail=None):
    entry = {'name': name, 'passed': bool(passed)}
    if detail is not None:
        entry['detail'] = detail
    results['checks'].append(entry)
    if not passed:
        raise AssertionError(name + ('' if detail is None else ': ' + str(detail)))


def refuses(name, sql, reason):
    result = subprocess.run(list(map(str, psql)), input=sql, text=True, capture_output=True, env=env, timeout=60)
    check(name, result.returncode != 0 and reason in result.stderr, result.stderr.strip()[-400:])


def md5_of(signature):
    return run("SELECT md5(pg_get_functiondef('" + signature + "'::regprocedure))")


def open_incidents(key=None):
    where = "status <> 'resolved'" + ('' if key is None else " AND dedupe_key = " + lit(key))
    return int(run('SELECT count(*) FROM ca_drift_incidents WHERE ' + where))


def incident(key):
    row = run(
        "SELECT coalesce(row_to_json(i)::text,'') FROM ca_drift_incidents i"
        " WHERE dedupe_key = " + lit(key) + " AND status <> 'resolved'")
    return json.loads(row) if row else None


def lit(value):
    return "'" + str(value).replace("'", "''") + "'"


def amt(value):
    """row_to_json renders numeric as a JSON number; compare by value, not text."""
    return None if value is None else decimal.Decimal(str(value))


def same(value, expected):
    return amt(value) == amt(expected)


def seed_standing_imbalance():
    """The production shape: a big net IN, a smaller net OUT, both long past.

    Amounts and leg wording are the measured production ones so the figures this
    probe asserts are the figures the defect was reported with.
    """
    run("""
    TRUNCATE chip_ledger;
    TRUNCATE ca_must_be_zero_hours;
    INSERT INTO chip_ledger (from_type, to_type, amount, category, description, created_at)
    VALUES ('club_treasury','settlement_suspense',""" + SUSPENSE_IN + """,'adjustment',
            'auto-ledgered clubs.chip_treasury delta -""" + SUSPENSE_IN + """', now() - interval '18 days'),
           ('settlement_suspense','agent_wallet',""" + SUSPENSE_OUT + """,'adjustment',
            'auto-ledgered agents.agent_wallet_balance delta """ + SUSPENSE_OUT + """', now() - interval '11 days');
    """)


try:
    check('postgres-17', command([pg / 'postgres', '--version']).startswith('postgres (PostgreSQL) 17.'))
    if shutil.disk_usage(tempfile.gettempdir()).free < 512 * 1024 ** 2:
        raise RuntimeError('512 MiB disk reserve required')
    command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
             '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log',
             '-o', f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=32MB -c max_connections=12",
             '-w', 'start'])

    run((PROBE / 'catalog.sql').read_text())
    run((PROBE / 'incident-filer.sql').read_text())
    check('exact-production-incident-filer',
          md5_of('public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)') == INCIDENT_FILER_MD5)
    check('exact-production-scope-gate',
          md5_of('public.fn_ca_is_midway_scope(uuid,uuid,uuid,uuid,jsonb)') == MIDWAY_SCOPE_MD5)
    check('exact-production-stable-dedupe-key',
          md5_of('public.fn_ca_stable_dedupe_key(text)') == STABLE_KEY_MD5)

    # ------------------------------------------------------------------ RED ---
    run((PROBE / 'installed-detector.sql').read_text())
    check('exact-installed-detector-preimage',
          md5_of('public.fn_ca_suspense_regression_check()') == INSTALLED_DETECTOR_MD5)
    # ca_must_be_zero_hours does not exist yet; the RED half never touches it.
    run("""
    TRUNCATE chip_ledger;
    INSERT INTO chip_ledger (from_type, to_type, amount, category, description, created_at)
    VALUES ('club_treasury','settlement_suspense',""" + SUSPENSE_IN + """,'adjustment','auto-ledgered clubs.chip_treasury delta', now() - interval '18 days'),
           ('settlement_suspense','agent_wallet',""" + SUSPENSE_OUT + """,'adjustment','auto-ledgered agents.agent_wallet_balance delta', now() - interval '11 days');
    """)
    check('RED-balance-is-really-non-zero',
          run("SELECT round(sum(CASE WHEN to_type='settlement_suspense' THEN amount ELSE -amount END),2) FROM chip_ledger") == SUSPENSE_BALANCE)
    check('RED-installed-detector-reports-nothing',
          run('SELECT fn_ca_suspense_regression_check()') == '0')
    check('RED-no-incident-filed', open_incidents() == 0)
    check('RED-no-notification', int(run('SELECT count(*) FROM probe_notifications')) == 0)

    # ---------------------------------------------------------------- GREEN ---
    run(MIGRATION.read_text())
    candidate_md5 = md5_of('public.fn_ca_suspense_regression_check()')
    check('candidate-installed', candidate_md5 != INSTALLED_DETECTOR_MD5)
    check('GREEN-the-guard-redefinition-declares-itself',
          run("SELECT declared_ref FROM ca_guard_defs WHERE proname='fn_ca_suspense_regression_check'")
          == 'migration 20260925131500_a_must_be_zero_account_is_checked_by_its_balance')
    check('GREEN-the-declared-baseline-is-the-definition-this-migration-made',
          run("SELECT def_hash FROM ca_guard_defs WHERE proname='fn_ca_suspense_regression_check'") == candidate_md5)
    check('GREEN-the-previous-definition-is-kept-to-diff-against',
          int(run("SELECT count(*) FROM ca_guard_def_history WHERE proname='fn_ca_suspense_regression_check'")) == 1)
    check('GREEN-baseline-recorded-at-install',
          run("SELECT baseline_balance::text FROM ca_must_be_zero_state WHERE account_type='settlement_suspense'") == SUSPENSE_BALANCE)
    check('GREEN-balance-read-from-buckets',
          run("SELECT round(sum(chips_in-chips_out),2)::text FROM ca_must_be_zero_hours WHERE account_type='settlement_suspense'") == SUSPENSE_BALANCE)
    check('GREEN-detector-reports-the-balance', int(run('SELECT fn_ca_suspense_regression_check()')) >= 1)
    filed = incident('must-be-zero-balance:settlement_suspense')
    check('GREEN-incident-filed', filed is not None)
    check('GREEN-incident-carries-the-balance', same(filed['discrepancy_amount'], SUSPENSE_BALANCE), filed['discrepancy_amount'])
    check('GREEN-incident-is-a-ledger-imbalance', filed['classification'] == 'ledger_imbalance' and filed['severity'] == 'critical')
    check('GREEN-incident-names-the-account', filed['entity_type'] == 'settlement_suspense')
    check('GREEN-incident-states-the-legs',
          same(filed['metadata']['chips_in'], SUSPENSE_IN) and same(filed['metadata']['chips_out'], SUSPENSE_OUT), filed['metadata'])
    check('GREEN-incident-refuses-to-authorise-a-move',
          'the destination is the owner' in filed['suspected_cause'])
    check('GREEN-existing-alert-surface-used', int(run("SELECT count(*) FROM probe_financial_alerts WHERE source='drift_incident:fn_ca_suspense_regression_check'")) == 1)
    check('GREEN-notified-once', int(run('SELECT count(*) FROM probe_notifications')) == 1)

    # A STANDING CONDITION IS ONE INCIDENT, NOT NINETY-SIX A DAY.
    for _ in range(8):
        run('SELECT fn_ca_suspense_regression_check()')
    check('standing-condition-folds-to-one-incident',
          open_incidents('must-be-zero-balance:settlement_suspense') == 1)
    check('standing-condition-counts-its-recurrences',
          int(incident('must-be-zero-balance:settlement_suspense')['occurrences']) == 9)
    check('standing-condition-notifies-once',
          int(run('SELECT count(*) FROM probe_notifications')) == 1)
    check('no-storm-incident', open_incidents('storm:fn_ca_suspense_regression_check') == 0)
    check('growth-is-not-reported-while-the-balance-is-the-baseline',
          open_incidents('must-be-zero-growth:settlement_suspense') == 0)

    # MUST_BE_ZERO IS LOAD-BEARING: the check follows the column, not a name.
    run("UPDATE ca_ledger_accounts SET must_be_zero = true WHERE account_type = 'chip_retirement';")
    run("INSERT INTO chip_ledger (from_type,to_type,amount,category,description,created_at)"
        " VALUES ('club_treasury','chip_retirement',777.77,'adjustment','a burn nobody balanced', now() - interval '30 minutes');")
    run('SELECT fn_ca_suspense_regression_check()')
    newly = incident('must-be-zero-balance:chip_retirement')
    check('a-newly-declared-must-be-zero-account-is-checked', newly is not None)
    check('the-new-account-reports-its-own-balance', same(newly['discrepancy_amount'], '777.77'), newly['discrepancy_amount'])
    run("UPDATE ca_ledger_accounts SET must_be_zero = false WHERE account_type = 'chip_retirement';"
        "DELETE FROM chip_ledger WHERE to_type='chip_retirement';"
        "DELETE FROM ca_must_be_zero_hours WHERE account_type='chip_retirement';"
        "DELETE FROM ca_must_be_zero_state WHERE account_type='chip_retirement';"
        "UPDATE ca_drift_incidents SET status='resolved', resolved_at=now() WHERE dedupe_key='must-be-zero-balance:chip_retirement';")

    # THE FLOW ARM IS NOT WEAKENED. Same key, same wording, same tolerance.
    run("INSERT INTO chip_ledger (from_type,to_type,amount,category,description,created_at)"
        " VALUES ('spin_reserve','settlement_suspense',250.00,'spin_prize','auto-ledgered spin_bonus_pools.balance delta -250.00', now() - interval '5 minutes');")
    run('SELECT fn_ca_suspense_regression_check()')
    flow = incident('suspense-regression')
    check('flow-arm-still-raises-its-own-finding', flow is not None)
    check('flow-arm-reports-the-hour-not-the-balance', same(flow['discrepancy_amount'], '250.00'), flow['discrepancy_amount'])
    check('flow-arm-keeps-its-severity', flow['severity'] == 'warning')
    check('flow-arm-keeps-its-wording', 'in the last hour' in flow['suspected_cause'])

    # GROWTH IS ITS OWN FINDING: the standing 4.17M is the owner's decision, a
    # balance that keeps moving is a live writer and must be louder.
    grown = incident('must-be-zero-growth:settlement_suspense')
    check('a-balance-that-moved-off-its-baseline-is-reported', grown is not None)
    check('growth-reports-the-movement-not-the-balance', same(grown['discrepancy_amount'], '250.00'), grown['discrepancy_amount'])
    check('growth-names-the-baseline-it-moved-from', same(grown['expected_amount'], SUSPENSE_BALANCE), grown['expected_amount'])

    # A SETTLEMENT-SHAPED PASS-THROUGH IS NOT A FINDING. The weekly rakeback
    # cascade debits the bank and credits the player inside ONE transaction, so
    # suspense nets to zero and the balance must not move. This is the assertion
    # that the first weekly book on 2026-09-28 cannot be alarmed by this control.
    run("DELETE FROM chip_ledger WHERE category='spin_prize';"
        "UPDATE ca_drift_incidents SET status='resolved', resolved_at=now()"
        " WHERE dedupe_key IN ('suspense-regression','must-be-zero-growth:settlement_suspense');")
    run('SELECT fn_ca_suspense_regression_check()')
    check('pass-through-precondition-balance-is-back-to-baseline',
          run("SELECT last_balance::text FROM ca_must_be_zero_state WHERE account_type='settlement_suspense'") == SUSPENSE_BALANCE)
    run("""
    BEGIN;
    INSERT INTO chip_ledger (from_type,to_type,amount,category,description,created_at)
    VALUES ('club_treasury','settlement_suspense',12345.67,'rakeback','weekly rakeback close: bank debit', now()),
           ('settlement_suspense','player_wallet',12345.67,'rakeback','weekly rakeback close: player credit', now());
    COMMIT;
    """)
    run('SELECT fn_ca_suspense_regression_check()')
    check('a-settlement-pass-through-leaves-the-balance-unmoved',
          run("SELECT last_balance::text FROM ca_must_be_zero_state WHERE account_type='settlement_suspense'") == SUSPENSE_BALANCE)
    check('a-settlement-pass-through-raises-no-flow-finding',
          open_incidents('suspense-regression') == 0)
    check('a-settlement-pass-through-raises-no-growth-finding',
          open_incidents('must-be-zero-growth:settlement_suspense') == 0)

    # BOUNDED BY CONSTRUCTION. Sealed hours are not re-read: change a sealed row
    # behind the detector's back and the balance it reports does not move. That
    # is the property that keeps this off a 5.8M-row sequential scan.
    before = run("SELECT last_balance::text FROM ca_must_be_zero_state WHERE account_type='settlement_suspense'")
    run("DELETE FROM chip_ledger WHERE created_at < now() - interval '3 hours';")
    run('SELECT fn_ca_suspense_regression_check()')
    check('sealed-hours-are-not-rescanned',
          run("SELECT last_balance::text FROM ca_must_be_zero_state WHERE account_type='settlement_suspense'") == before, before)
    plan = run("EXPLAIN (COSTS off) SELECT round(sum(chips_in-chips_out),2) FROM ca_must_be_zero_hours WHERE account_type='settlement_suspense'")
    check('the-balance-is-read-off-the-buckets-not-the-journal', 'chip_ledger' not in plan, plan)
    refresh_plan = run(
        "EXPLAIN (COSTS off) SELECT 1 FROM chip_ledger l JOIN ca_ledger_accounts a"
        " ON a.must_be_zero AND (l.from_type=a.account_type OR l.to_type=a.account_type)"
        " WHERE l.created_at >= date_trunc('hour', now()) - interval '2 hours'")
    check('the-refresh-window-is-index-bounded',
          'idx_chip_ledger_created_at' in refresh_plan or 'Index' in refresh_plan, refresh_plan)

    # IT REFUSES ITS OWN REPLAY. An installed migration is never replayed, and
    # here that rule has teeth: a second application would re-read the journal
    # and re-baseline the standing imbalance to whatever it is at the time,
    # which would silently authorise it. The precondition names the definition
    # it found instead.
    refuses('refuses-its-own-replay', MIGRATION.read_text(), 'is not the reviewed definition')
    check('a-refused-replay-leaves-the-baseline-alone',
          run("SELECT baseline_balance::text FROM ca_must_be_zero_state WHERE account_type='settlement_suspense'") == SUSPENSE_BALANCE)
    check('a-refused-replay-leaves-the-candidate-installed',
          md5_of('public.fn_ca_suspense_regression_check()') == candidate_md5)

    # THE PRECONDITION REFUSES TO OVERWRITE SOMEBODY ELSE'S DETECTOR.
    run("CREATE OR REPLACE FUNCTION public.fn_ca_suspense_regression_check() RETURNS integer"
        " LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$SELECT 0$$;")
    refuses('refuses-an-unreviewed-installed-detector', MIGRATION.read_text(),
            'is not the reviewed definition')
    run((PROBE / 'installed-detector.sql').read_text())
    run("UPDATE ca_ledger_accounts SET must_be_zero = false;")
    refuses('refuses-when-nothing-declares-must-be-zero', MIGRATION.read_text(),
            'nothing to enforce')
finally:
    if (cluster / 'data/postmaster.pid').exists():
        try:
            command([pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
        except Exception:
            pass
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps({'passed': sum(1 for c in results['checks'] if c['passed']),
                  'total': len(results['checks']),
                  'output': str(out / 'RESULTS.json'),
                  'owned_cluster_removed': results['owned_cluster_removed']}))
