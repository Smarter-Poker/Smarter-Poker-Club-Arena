#!/usr/bin/env python3
"""PostgreSQL 17 qualification: settlement_suspense is restated to zero, journal only.

Migration 20260926060005 posts one correction per audited finding through the
existing correction authority (fn_ca_post_correction, production's exact
definition), links each to its own incident, and refuses to commit unless the
account reads 0.00 and every balance-bearing table is unchanged inside the same
repeatable-read snapshot. This probe builds production's exact pinned
definitions in an owned cluster, seeds a standing imbalance of the production
shape, and proves:

  RED    the installed balance arm cannot close its own incident (its closure
         basis is outside the table's CHECK and it writes no correction_ref);
  GREEN  the restatement zeroes the account through the writer, moves no
         balance, is refused under READ COMMITTED, by a non-service caller, by a
         plan that does not zero the account and by a leg named twice, replays as
         a no-op, and the next detector run closes the incident as
         verified_remeasured with no flow, growth, suspense-rollup, undeclared
         or coverage finding;
  ONE-OFF the production wrapper refuses any other operation id and refuses a
         journal that does not reproduce the audited findings.

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
MBZ = ROOT / 'scripts/ci/probes/must-be-zero-balance'
PROBE = ROOT / 'scripts/ci/probes/settlement-suspense-restatement'
MBZ_MIGRATION = ROOT / 'supabase/migrations/20260925131500_a_must_be_zero_account_is_checked_by_its_balance.sql'
MIGRATION = ROOT / 'supabase/migrations/20260926060005_settlement_suspense_is_restated_to_its_real_counterparties.sql'
OPERATION = 'f4a2c6d0-5e1b-4c7a-9d3e-26092026a0b1'

# Production identities read 2026-09-26 on project kuklfnapbkmacvwxktbh.
PINNED = {
    'public.fn_ca_post_correction(text,uuid,text,uuid,numeric,text,uuid,bigint,uuid,uuid,jsonb)': '4492ef51ddb64edfac10a0535efb40b5',
    'public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)': 'a6df5f2eef07aa3f606db79d93944590',
    'public.fn_ca_suspense_regression_check()': 'd55850b430002d4292079a2dff72c99a',
    'public.fn_ca_quick_reconcile()': '1fa22b57be6709733e7b851aa1fb4005',
    'public.fn_ca_undeclared_leg_check(integer)': '60f7054727b0c73fac21e68468fb71fd',
    'public.fn_ca_chip_store_coverage_gaps()': 'a7f4a0cefa56955937376a810cb13d60',
    'public.fn_ca_declare_guard_redefinition(text,text)': '3a3746dc6e0a5b7a1db97805588c0eb8',
    'public.fn_ca_resolution_needs_a_cause()': '48547879bc49d84f5898e8cb44fe1951',
}
SUCCESSORS = {
    'public.fn_ca_suspense_regression_check()': '7315bea1dd3819c9cc2935668e108d8c',
    'public.fn_ca_quick_reconcile()': '89691752a5e2272cf53e0f55773eca30',
    'public.fn_ca_undeclared_leg_check(integer)': '953497d9b5fc13e131dab34956f9310b',
    'public.fn_ca_chip_store_coverage_gaps()': '9f44a12318e13f1ef9942ed2a2758d1a',
}

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/settlement-suspense-restatement')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
env['LANG'] = 'C'
cluster = pathlib.Path(tempfile.mkdtemp(prefix='ca-suspense-restatement-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
PORT = '55771'
results = {'checks': [], 'production_mutations': False,
           'scope': 'Migration 20260926060005 against production\'s exact pinned definitions in an owned PG17 cluster. No production row is read or written.'}
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
SERVICE = "SET request.jwt.claims = '{\"role\":\"service_role\"}';"


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
    check(name, result.returncode != 0 and reason in result.stderr, result.stderr.strip()[-500:])


def md5_of(signature):
    return run("SELECT md5(pg_get_functiondef('" + signature + "'::regprocedure))")


def suspense():
    return run("SELECT COALESCE(round(sum(CASE WHEN to_type='settlement_suspense' THEN amount ELSE -amount END),2),0)::text"
               " FROM chip_ledger WHERE (from_type='settlement_suspense') <> (to_type='settlement_suspense')")


def open_count(key):
    return int(run("SELECT count(*) FROM ca_drift_incidents WHERE status <> 'resolved' AND dedupe_key = '" + key + "'"))


def fingerprint():
    return run('SELECT fn_ca_balance_table_fingerprint()::text')


# The production shape: an agent -> member distribution observed once per side,
# a spin draw whose winner was paid through the unattributed felt, a rake credit
# with no counterparty, a certification opening grant, and one transfer routed
# through the corridor that nets to nothing.
SEED = """
INSERT INTO clubs (id, chip_treasury) VALUES ('00000000-0000-0000-0000-00000000c1b1', 2500000);
INSERT INTO club_members (club_id, user_id, chip_balance) VALUES
  ('00000000-0000-0000-0000-00000000c1b1','00000000-0000-0000-0000-0000000000a1', 10000),
  ('00000000-0000-0000-0000-00000000c1b1','00000000-0000-0000-0000-0000000000a2', 4);
INSERT INTO agents (user_id, club_id, agent_wallet_balance) VALUES
  ('00000000-0000-0000-0000-0000000000a9','00000000-0000-0000-0000-00000000c1b1', 90000);
INSERT INTO table_seats (table_id, user_id, stack) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a2', 250);
INSERT INTO chip_ledger (id, from_type, from_entity_id, to_type, to_entity_id, amount, category, description, created_at) VALUES
 ('10000000-0000-0000-0000-000000000001','agent_wallet','00000000-0000-0000-0000-0000000000a9','settlement_suspense',NULL,10000.00,'adjustment','auto-ledgered agents.agent_wallet_balance delta -10000.00','2026-09-01 14:02:25.115084+00'),
 ('10000000-0000-0000-0000-000000000002','table_stack',NULL,'player_wallet','00000000-0000-0000-0000-0000000000a1',10000.00,'adjustment','auto-audited club_members.chip_balance delta 10000.00','2026-09-01 14:02:25.115084+00'),
 ('10000000-0000-0000-0000-000000000003','spin_reserve','2d968239-acdd-4a2c-99f2-a369ff37ae31','settlement_suspense',NULL,4.00,'spin_prize','auto-ledgered spin_bonus_pools.balance delta -4.00','2026-09-01 19:57:21.890763+00'),
 ('10000000-0000-0000-0000-000000000004','settlement_suspense',NULL,'union_wallet','059bb325-6eeb-4bbd-957d-3a82e755bb0c',1.70,'adjustment','auto-ledgered union_wallets.rake_wallet delta 1.70','2026-08-31 14:41:00.542686+00'),
 ('10000000-0000-0000-0000-000000000005','settlement_suspense',NULL,'club_treasury','b87a0572-2efd-429e-afa2-bbe4e0e74d23',100000.00,'adjustment','auto-ledgered clubs.chip_treasury delta 100000.00','2026-08-31 19:53:17.953741+00'),
 ('10000000-0000-0000-0000-000000000006','club_treasury','00000000-0000-0000-0000-00000000c1b1','settlement_suspense',NULL,50.00,'adjustment','auto-ledgered clubs.chip_treasury delta -50.00','2026-09-07 19:20:49.954503+00'),
 ('10000000-0000-0000-0000-000000000007','settlement_suspense',NULL,'player_wallet','00000000-0000-0000-0000-0000000000a2',50.00,'rakeback','rakeback','2026-09-07 19:20:49.954503+00');
"""
BALANCE = '-89997.70'

PLAN = json.dumps([
    {'finding': 'L01', 'direction': 'out_of_account', 'counterparty_type': 'table_stack', 'counterparty_entity': None,
     'amount': 10000.00, 'legs': ['10000000-0000-0000-0000-000000000001'],
     'real_counterparty': 'the member wallet the distribution credited', 'evidence': 'probe',
     'reason': 'Journal-only restatement: the agent distribution whose member side was journaled at table_stack(NULL).'},
    {'finding': 'L02', 'direction': 'out_of_account', 'counterparty_type': 'table_stack', 'counterparty_entity': None,
     'amount': 4.00, 'legs': ['10000000-0000-0000-0000-000000000003'],
     'real_counterparty': 'the spin winner', 'evidence': 'probe',
     'reason': 'Journal-only restatement: the spin draw paid to its winner through table_stack(NULL).'},
    {'finding': 'L09', 'direction': 'into_account', 'counterparty_type': 'table_stack', 'counterparty_entity': None,
     'amount': 1.70, 'legs': ['10000000-0000-0000-0000-000000000004'],
     'real_counterparty': 'the felt the rake came off', 'evidence': 'probe',
     'reason': 'Journal-only restatement: union rake credited with no counterparty; the rake came off the felt.'},
    {'finding': 'L15', 'direction': 'into_account', 'counterparty_type': 'issuance_reserve', 'counterparty_entity': None,
     'amount': 100000.00, 'legs': ['10000000-0000-0000-0000-000000000005'],
     'real_counterparty': 'the unjournaled opening grant', 'evidence': 'probe',
     'reason': 'Journal-only restatement: a certification club opening grant that the journal never named as issuance.'},
])
AUTH = json.dumps({'by': 'Dan (owner)', 'on': '2026-09-26', 'text': 'Post correction legs to zero it'})


def engine(plan=PLAN, isolation='REPEATABLE READ', claims=SERVICE):
    return ('BEGIN ISOLATION LEVEL ' + isolation + ';' + claims +
            "SELECT fn_ca_restate_must_be_zero_account('" + OPERATION + "','settlement_suspense','"
            + plan.replace("'", "''") + "'::jsonb,'" + AUTH + "'::jsonb)::text; COMMIT;")


try:
    check('postgres-17', command([pg / 'postgres', '--version']).startswith('postgres (PostgreSQL) 17.'))
    command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
             '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log',
             '-o', f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=32MB -c max_connections=12",
             '-w', 'start'])

    run((MBZ / 'catalog.sql').read_text())
    run((MBZ / 'incident-filer.sql').read_text())
    run((MBZ / 'installed-detector.sql').read_text())
    run((PROBE / 'catalog-extension.sql').read_text())
    run((PROBE / 'installed-definitions.sql').read_text())
    run((PROBE / 'installed-quick-reconcile.sql').read_text())
    run((PROBE / 'triggers.sql').read_text())
    run(SEED)
    check('seeded-standing-imbalance', suspense() == BALANCE, suspense())
    run(MBZ_MIGRATION.read_text())
    for signature, expected in PINNED.items():
        check('exact-production-' + signature.split('(')[0].split('.')[1], md5_of(signature) == expected, md5_of(signature))
    run('SELECT fn_ca_suspense_regression_check()')
    check('the-standing-imbalance-is-an-open-critical', open_count('must-be-zero-balance:settlement_suspense') == 1)

    # ------------------------------------------------------------------ RED ---
    # The installed balance arm, handed a balance that is back at zero, cannot
    # close its own incident: the transaction that tries is refused.
    zero_it = ("INSERT INTO chip_ledger (from_type,to_type,amount,category,description)"
               " VALUES ('table_stack','settlement_suspense'," + BALANCE.lstrip('-') + ",'correction','probe');")
    refuses('RED-installed-closure-writes-no-cause-or-evidence',
            'BEGIN;' + zero_it + ' SELECT fn_ca_suspense_regression_check(); COMMIT;',
            'is not resolved until')
    refuses('RED-installed-closure-basis-is-outside-the-table-vocabulary',
            "BEGIN; UPDATE ca_drift_incidents SET root_cause = repeat('a written-down cause ', 3),"
            " correction_ref = 'verified: probe' WHERE dedupe_key = 'must-be-zero-balance:settlement_suspense';"
            + zero_it + ' SELECT fn_ca_suspense_regression_check(); COMMIT;',
            'ca_drift_incidents_closure_basis_check')

    # -------------------------------------------------------------- INSTALL ---
    run(MIGRATION.read_text())
    for signature, expected in SUCCESSORS.items():
        check('successor-' + signature.split('(')[0].split('.')[1], md5_of(signature) == expected, md5_of(signature))
    check('both-watched-guards-declare-the-redefinition',
          run("SELECT count(*) FROM ca_guard_defs WHERE declared_ref = 'migration 20260926060005_settlement_suspense_is_restated_to_its_real_counterparties'") == '2')
    check('the-engine-is-not-granted-to-the-api',
          run("SELECT has_function_privilege('service_role','public.fn_ca_restate_must_be_zero_account(uuid,text,jsonb,jsonb)','EXECUTE')") == 'f')
    check('the-one-off-is-service-role-only',
          run("SELECT has_function_privilege('service_role','public.fn_ca_restate_settlement_suspense_20260926(uuid)','EXECUTE')"
              " AND NOT has_function_privilege('authenticated','public.fn_ca_restate_settlement_suspense_20260926(uuid)','EXECUTE')"
              " AND NOT has_function_privilege('anon','public.fn_ca_restate_settlement_suspense_20260926(uuid)','EXECUTE')") == 't')
    refuses('the-migration-refuses-its-own-replay', MIGRATION.read_text(), 'is not the reviewed definition')

    # ------------------------------------------------------------- ONE-OFF ---
    refuses('one-off-refuses-another-operation-id',
            SERVICE + "SELECT fn_ca_restate_settlement_suspense_20260926(gen_random_uuid());", 'runs under operation')
    refuses('one-off-refuses-a-non-service-caller',
            "SELECT fn_ca_restate_settlement_suspense_20260926('" + OPERATION + "');", 'service_role_required')
    refuses('one-off-refuses-a-journal-that-is-not-the-audited-one',
            'BEGIN ISOLATION LEVEL REPEATABLE READ;' + SERVICE +
            "SELECT fn_ca_restate_settlement_suspense_20260926('" + OPERATION + "'); COMMIT;",
            'no longer matches the audited finding')
    check('a-refused-one-off-posts-nothing', suspense() == BALANCE, suspense())

    # --------------------------------------------------------------- ENGINE ---
    refuses('refused-under-read-committed', engine(isolation='READ COMMITTED'), 'repeatable_read_required')
    refuses('refused-without-service-role', engine(claims=''), 'service_role_required')
    short = json.loads(PLAN)[:3]
    refuses('refused-when-the-plan-does-not-zero-the-account', engine(plan=json.dumps(short)), 'the plan restates')
    twice = json.loads(PLAN)
    twice[1]['legs'] = twice[0]['legs']
    refuses('refused-when-a-leg-does-not-net-to-its-finding', engine(plan=json.dumps(twice)), 'legs net')
    paired = json.loads(PLAN)
    paired[0]['legs'] = ['10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001']
    refuses('refused-when-a-leg-is-named-twice', engine(plan=json.dumps(paired)), 'named legs are live')
    check('refusals-post-nothing',
          suspense() == BALANCE and run("SELECT count(*) FROM chip_ledger WHERE category='correction'") == '0'
          and run("SELECT count(*) FROM ca_correction_request_intents_v1") == '0', suspense())

    before = fingerprint()
    outcome = json.loads(run(engine()))
    check('restated', outcome['ok'] is True and outcome['replayed'] is False, outcome)
    check('the-account-reads-zero', suspense() == '0.00', suspense())
    check('four-corrections-one-per-finding', outcome['corrections_posted'] == 4 and outcome['legs_restated'] == 4, outcome)
    check('the-balance-tables-are-identical-inside-the-transaction', outcome['balance_tables_identical'] is True)
    check('the-balance-tables-are-identical-after-commit', fingerprint() == before)
    check('every-correction-went-through-the-writer',
          run("SELECT count(*) FROM chip_ledger WHERE category='correction' AND metadata->>'posted_via'='fn_ca_post_correction'"
              " AND idempotency_key LIKE 'correction:inc:%' AND metadata->>'operation_id'='" + OPERATION + "'") == '4')
    check('every-correction-retains-its-full-request-intent',
          run("SELECT count(*) FROM ca_correction_request_intents_v1 i JOIN chip_ledger l ON l.id=i.ledger_id"
              " WHERE i.request_intent->>'reason' = (SELECT value->>'reason' FROM jsonb_array_elements('"
              + PLAN.replace("'", "''") + "'::jsonb) WHERE value->>'finding' = l.metadata->>'finding')") == '4')
    check('every-correction-names-its-real-counterparty',
          run("SELECT count(*) FROM chip_ledger WHERE category='correction' AND metadata ? 'real_counterparty'"
              " AND metadata->'owner_authorization'->>'text' = 'Post correction legs to zero it'") == '4')
    check('the-counterparties-are-the-planned-ones',
          run("SELECT string_agg(from_type||'>'||to_type||':'||round(amount,2), ',' ORDER BY metadata->>'finding') FROM chip_ledger"
              " WHERE category='correction' AND metadata->>'posted_via'='fn_ca_post_correction'")
          == 'settlement_suspense>table_stack:10000.00,settlement_suspense>table_stack:4.00,'
             'table_stack>settlement_suspense:1.70,issuance_reserve>settlement_suspense:100000.00')
    check('every-restated-leg-is-mapped-once',
          run('SELECT count(*), count(DISTINCT corrected_leg_id) FROM ca_journal_restatement_legs') == '4|4')
    check('the-routed-transfer-is-left-alone',
          run("SELECT count(*) FROM ca_journal_restatement_legs WHERE corrected_leg_id IN "
              "('10000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000007')") == '0')
    check('each-linkage-incident-is-closed-by-repair',
          run("SELECT count(*) FROM ca_drift_incidents WHERE source='fn_ca_restate_must_be_zero_account'"
              " AND status='resolved' AND closure_basis='repair' AND correction_ref LIKE 'chip_ledger %'"
              " AND severity='info'") == '4')
    check('the-receipt-is-written', run("SELECT legs_restated||'|'||corrections_posted||'|'||balance_after FROM ca_journal_restatements") == '4|4|0.00')
    check('the-audited-baseline-is-now-zero',
          run("SELECT baseline_balance::text FROM ca_must_be_zero_state WHERE account_type='settlement_suspense'") == '0')
    check('the-parent-incident-records-the-repair',
          run("SELECT count(*) FROM ca_incident_events e JOIN ca_drift_incidents i ON i.id=e.incident_id"
              " WHERE i.dedupe_key='must-be-zero-balance:settlement_suspense' AND e.kind='repair_action'") == '1')

    replay = json.loads(run(engine()))
    check('a-replay-posts-nothing', replay['replayed'] is True and replay['corrections_posted'] == 0, replay)
    check('a-replay-leaves-the-journal-alone',
          run("SELECT count(*) FROM chip_ledger WHERE category='correction' AND metadata->>'posted_via'='fn_ca_post_correction'") == '4')
    refuses('the-receipt-is-append-only', 'DELETE FROM ca_journal_restatements;', 'append-only')
    refuses('a-restated-leg-cannot-be-restated-again',
            engine(plan=PLAN).replace(OPERATION, '00000000-0000-0000-0000-00000000beef'), 'already restated')

    # ------------------------------------------------------------ DETECTORS ---
    run('SELECT fn_ca_suspense_regression_check()')
    closed = json.loads(run("SELECT row_to_json(i)::text FROM ca_drift_incidents i"
                            " WHERE dedupe_key='must-be-zero-balance:settlement_suspense' ORDER BY created_at DESC LIMIT 1"))
    check('the-balance-arm-closes-the-incident', closed['status'] == 'resolved', closed['status'])
    check('closed-as-re-measured', closed['closure_basis'] == 'verified_remeasured', closed['closure_basis'])
    check('closed-with-the-measured-evidence', closed['correction_ref'].startswith('verified: balance arm re-measured settlement_suspense at 0'), closed['correction_ref'])
    check('no-growth-finding', open_count('must-be-zero-growth:settlement_suspense') == 0)
    check('no-flow-finding-for-a-declared-correction', open_count('suspense-regression') == 0)
    run('SELECT fn_ca_quick_reconcile()')
    check('no-suspense-rollup-for-a-declared-correction',
          int(run("SELECT count(*) FROM ca_drift_incidents WHERE dedupe_key LIKE 'qr:suspense:%'")) == 0)
    check('no-undeclared-leg-for-a-declared-correction', run('SELECT count(*) FROM fn_ca_undeclared_leg_check(24)') == '0')
    check('no-coverage-gap-for-a-declared-correction',
          run("SELECT count(*) FROM fn_ca_chip_store_coverage_gaps() WHERE store='settlement_suspense'") == '0')
    for _ in range(3):
        run('SELECT fn_ca_suspense_regression_check()')
    check('the-closed-incident-stays-closed', open_count('must-be-zero-balance:settlement_suspense') == 0)

    # The flow arm is not weakened: an undeclared leg still raises.
    run("INSERT INTO chip_ledger (from_type,to_type,amount,category,description)"
        " VALUES ('spin_reserve','settlement_suspense',250.00,'spin_prize','auto-ledgered spin_bonus_pools.balance delta -250.00');")
    run('SELECT fn_ca_suspense_regression_check()')
    check('an-undeclared-leg-still-raises-the-flow-finding', open_count('suspense-regression') == 1)
    check('and-the-balance-finding', open_count('must-be-zero-balance:settlement_suspense') == 1)
    check('and-growth-from-the-zero-baseline', open_count('must-be-zero-growth:settlement_suspense') == 1)
    check('an-undeclared-leg-still-shows-as-undeclared', run('SELECT count(*) FROM fn_ca_undeclared_leg_check(24)') == '1')
    check('an-uncounted-store-that-moved-still-shows',
          run("SELECT count(*) FROM fn_ca_chip_store_coverage_gaps() WHERE store='settlement_suspense'") == '1')
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
