"""Isolated PostgreSQL regression for the drift incident push headline.

fn_ca_raise_drift_incident() hands fn_ca_incident_notify() the headline that
becomes the owner's notification title and the Production Alerts alert name.
A chip finding with no amount (a liveness check such as the knockout door,
filed at 0.00 by fn_ca_conservation_sweep) was headlined "0.00 chip drift:
ledger_imbalance", which names a drift of nothing and hides the check. It must
be headlined by its detector and severity; a finding with an amount keeps
"<amount> chip drift: <classification>" and a Diamond finding keeps its own
headline.

The test loads the exact production definition captured on 2026-10-15 (its
pg_get_functiondef md5 equals production's) over minimal stand-ins for the
tables and helpers it calls, proves it headlines the liveness finding as a
0.00 drift, applies the candidate migration (a pinned-text substitution) and
proves the three headlines, the derived postimage md5, the grants and that a
second run is refused. An empty throwaway cluster on a Unix socket; no
network, no production connection.
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
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'a-finding-with-no-amount-is-not-a-chip-drift'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/a-finding-with-no-amount-is-not-a-chip-drift')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='zero-headline-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55829'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

SIG = ('public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,'
       'uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)')
LIVE_DEF_MD5 = 'e6dac566804430737ee80da0a1801b40'
POST_DEF_MD5 = 'b5025fd1a0f856767f3a91166722ed7f'
GRANTS = f'''
REVOKE ALL ON FUNCTION {SIG} FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {SIG} TO service_role;
'''

# Minimal stand-ins for what the function reads and calls. The headline is
# what the notifier receives, so the stand-in notifier records it.
SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE ca_detector_registry(source text PRIMARY KEY, owner text, sla_hours integer, note text, status text);
CREATE TABLE ca_drift_incidents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), classification text, severity text,
  layer text, source text, dedupe_key text, union_id uuid, club_id uuid, entity_type text, entity_id uuid,
  table_id uuid, tournament_id uuid, hand_id uuid, settlement_id text, wallet_ids uuid[], transaction_ids uuid[],
  expected_amount numeric, actual_amount numeric, discrepancy_amount numeric, ledger_balanced boolean,
  suspected_cause text, metadata jsonb, currency text, status text DEFAULT 'open', occurrences integer DEFAULT 1,
  last_seen_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX ON ca_drift_incidents(dedupe_key) WHERE status <> 'resolved';
CREATE TABLE ca_incident_events(incident_id uuid, kind text, detail jsonb);
CREATE TABLE ca_incident_file_failures(source text, dedupe_key text, classification text, severity text,
  discrepancy numeric, sqlstate text, message text);
CREATE TABLE fixture_headlines(incident_id uuid, headline text);
CREATE TABLE fixture_alerts(severity text, source text, message text);
CREATE FUNCTION public.fn_ca_is_midway_scope(uuid, uuid, uuid, uuid, jsonb) RETURNS boolean
  LANGUAGE sql AS $$ SELECT true $$;
CREATE FUNCTION public.fn_ca_stable_dedupe_key(text) RETURNS text LANGUAGE sql AS $$ SELECT $1 $$;
CREATE FUNCTION public.fn_raise_server_financial_alert(text, text, text, jsonb) RETURNS void
  LANGUAGE sql AS $$ INSERT INTO fixture_alerts VALUES ($1, $2, $3) $$;
CREATE FUNCTION public.fn_ca_incident_notify(p_incident_id uuid, p_kind text, p_headline text, p_senior_only boolean DEFAULT false)
  RETURNS integer LANGUAGE sql AS $$ INSERT INTO fixture_headlines VALUES ($1, $3); SELECT 1 $$;
"""

CASES = [
    # (dedupe key, source, classification, severity, discrepancy, metadata)
    ('liveness', 'fn_ca_conservation_sweep:fn_ca_knockout_door_stalled', 'ledger_imbalance', 'critical', 0, None),
    ('null-amount', 'fn_ca_conservation_sweep:fn_ca_tables_that_cannot_deal', 'ledger_imbalance', 'critical', None, None),
    ('money', 'reconcile_ledger_nightly', 'ledger_imbalance', 'critical', 12.5, None),
    ('diamond', 'ca_diamond_incidents', 'unknown', 'critical', 0, '{"asset": "diamonds", "rule": "DR0"}'),
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


def one(glob):
    found = sorted(MIGRATIONS.glob(glob))
    if len(found) != 1:
        raise RuntimeError(f'expected exactly one {glob}, found {len(found)}')
    return found[0]


def lit(v):
    return 'NULL' if v is None else "'" + str(v).replace("'", "''") + "'"


def headlines():
    run('TRUNCATE ca_drift_incidents, ca_incident_events, fixture_headlines, fixture_alerts, ca_detector_registry;')
    got = {}
    for key, source, cls, sev, amount, meta in CASES:
        run(f"SELECT public.fn_ca_raise_drift_incident({lit(source)}, {lit(cls)}, {lit(sev)}, {lit(key)}, "
            f"{'NULL' if amount is None else amount}, NULL, NULL, 'ledger', 'check', "
            f"NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, {lit(meta)}::jsonb);")
        got[key] = run("SELECT h.headline FROM fixture_headlines h JOIN ca_drift_incidents i ON i.id = h.incident_id "
                       f"WHERE i.dedupe_key = {lit(key)}")
    got['alerts'] = run("SELECT string_agg(message, ' | ' ORDER BY source) FROM fixture_alerts")
    return got


def defmd5():
    return run(f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))")


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)
    run((FIXTURES / 'fn_ca_raise_drift_incident.live-20261015.sql').read_text() + ';' + GRANTS)
    check('baseline-is-production-preimage', defmd5() == LIVE_DEF_MD5)
    base = headlines()
    results['baseline'] = base
    check('baseline-headlines-a-liveness-finding-as-a-zero-drift', base['liveness'] == '0.00 chip drift: ledger_imbalance', base)

    migration = one('*_a_finding_with_no_amount_is_not_a_chip_drift.sql').read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    check('candidate-carries-live-proof', '@live-proof:' in migration and POST_DEF_MD5 in migration)
    run(migration)
    check('candidate-reproduces-production-derived-postimage', defmd5() == POST_DEF_MD5)
    got = headlines()
    results['candidate'] = got
    check('liveness-finding-is-headlined-by-its-check',
          got['liveness'] == 'fn_ca_conservation_sweep:fn_ca_knockout_door_stalled is critical', got)
    check('a-null-amount-is-headlined-by-its-check',
          got['null-amount'] == 'fn_ca_conservation_sweep:fn_ca_tables_that_cannot_deal is critical', got)
    check('a-real-drift-keeps-its-amount', got['money'] == base['money'] == '12.50 chip drift: ledger_imbalance', got)
    check('a-diamond-finding-is-unchanged', got['diamond'] == base['diamond'] == 'Diamond rule DR0 is critical', got)
    check('the-financial-alert-message-is-unchanged', got['alerts'] == base['alerts'], got['alerts'])
    for role in ('anon', 'authenticated'):
        r = subprocess.run(list(map(str, psql)),
                           input=f"SET ROLE {role}; SELECT public.fn_ca_raise_drift_incident('x','unknown','info','k');",
                           text=True, capture_output=True, env=env, timeout=30)
        check(role + '-cannot-call', r.returncode != 0 and 'permission denied' in r.stderr)
    replay = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-a-second-run',
          replay.returncode != 0 and 'is not the pinned text' in replay.stderr, replay.stderr[-300:])
    check('second-run-left-the-postimage', defmd5() == POST_DEF_MD5)
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'baseline': results.get('baseline'),
                  'candidate': results.get('candidate'), 'output': str(out / 'RESULTS.json')}))
