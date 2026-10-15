"""Isolated PostgreSQL regression: the conservation sweep files a governance finding once.

fn_union_governance_check() ends with UNION ALL SELECT * FROM
fn_union_credit_risk_check(), so a credit-risk row is already a governance row.
fn_ca_conservation_sweep() ran both checks and filed every credit-risk finding
twice, under two sources. The test loads the exact production sweep captured on
2026-10-15 (its pg_get_functiondef md5 equals production's) over stand-ins for
the checks it runs, proves one credit-risk finding is filed twice, applies the
candidate migration (a pinned-text substitution) and proves it is filed once,
under governance, with its invariant name, that a governance-only finding is
still filed, the derived postimage md5, the grants, that the migration refuses
when governance stops including credit risk, and that a second run is refused.
An empty throwaway cluster on a Unix socket; no network, no production
connection.
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
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'the-sweep-files-a-governance-finding-once'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/the-sweep-files-a-governance-finding-once')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='sweep-once-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55831'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

SIG = 'public.fn_ca_conservation_sweep()'
LIVE_DEF_MD5 = '69e18c182275d84f3ed624e53fd8bcf9'
POST_DEF_MD5 = '81995d0a3590cab15132df5b1ef609e8'
GRANTS = f'''
REVOKE ALL ON FUNCTION {SIG} FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {SIG} TO service_role;
'''

# Stand-ins. Every other check the sweep names is absent, so it errors inside
# its own subtransaction and is filed as sweepfail: that is the sweep's own
# behaviour and is not counted below.
SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE ca_detector_runs(detector text, detail jsonb);
CREATE TABLE fixture_filed(source text, dedupe_key text, rows jsonb);
CREATE TABLE fixture_credit(invariant text, severity text, offenders bigint, detail text);
CREATE TABLE fixture_governance(invariant text, severity text, offenders bigint, detail text);
CREATE FUNCTION public.fn_union_credit_risk_check()
  RETURNS TABLE(invariant text, severity text, offenders bigint, detail text)
  LANGUAGE sql AS $$ SELECT * FROM fixture_credit $$;
CREATE FUNCTION public.fn_union_governance_check()
  RETURNS TABLE(invariant text, severity text, offenders bigint, detail text)
  LANGUAGE sql AS $$ SELECT * FROM fixture_governance
  UNION ALL
  SELECT * FROM fn_union_credit_risk_check() $$;
CREATE FUNCTION public.fn_ca_raise_drift_incident(p_source text, p_classification text, p_severity text, p_dedupe_key text,
  p_discrepancy numeric DEFAULT NULL, p_expected numeric DEFAULT NULL, p_actual numeric DEFAULT NULL,
  p_layer text DEFAULT NULL, p_entity_type text DEFAULT NULL, p_entity_id uuid DEFAULT NULL, p_club_id uuid DEFAULT NULL,
  p_union_id uuid DEFAULT NULL, p_table_id uuid DEFAULT NULL, p_tournament_id uuid DEFAULT NULL, p_hand_id uuid DEFAULT NULL,
  p_settlement_id text DEFAULT NULL, p_wallet_ids uuid[] DEFAULT NULL, p_transaction_ids uuid[] DEFAULT NULL,
  p_suspected_cause text DEFAULT NULL, p_ledger_balanced boolean DEFAULT NULL, p_metadata jsonb DEFAULT NULL)
  RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO fixture_filed VALUES (p_source, p_dedupe_key, p_metadata->'rows'); SELECT NULL::uuid $$;
"""
ECO = "('union_eco_not_recorded','warning',1,'closed week has no union_eco_ledger row')"
GOV_ONLY = "('settlement_needs_review','warning',2,'parked periods')"


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


def sweep(credit, governance):
    run('TRUNCATE fixture_filed, fixture_credit, fixture_governance, ca_detector_runs;'
        + (f'INSERT INTO fixture_credit VALUES {credit};' if credit else '')
        + (f'INSERT INTO fixture_governance VALUES {governance};' if governance else ''))
    run(f'SELECT {SIG}')
    rows = run("SELECT coalesce(json_agg(json_build_object('source', source, 'invariants', "
               "(SELECT json_agg(r->>'invariant') FROM jsonb_array_elements(rows) r)) ORDER BY source), '[]') "
               "FROM fixture_filed WHERE dedupe_key LIKE 'sweep:fn_union_%'")
    return json.loads(rows)


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
    run((FIXTURES / 'fn_ca_conservation_sweep.live-20261015.sql').read_text() + ';' + GRANTS)
    check('baseline-is-production-preimage', defmd5() == LIVE_DEF_MD5)
    base = sweep(ECO, None)
    results['baseline'] = base
    check('baseline-files-one-credit-finding-twice',
          [b['source'] for b in base] == ['fn_ca_conservation_sweep:fn_union_credit_risk_check',
                                          'fn_ca_conservation_sweep:fn_union_governance_check'], base)

    migration = one('*_the_sweep_files_a_governance_finding_once.sql').read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    check('candidate-carries-live-proof', '@live-proof:' in migration and POST_DEF_MD5 in migration)

    # The guard: a governance check that stopped including credit risk refuses.
    run("ALTER FUNCTION public.fn_union_governance_check() RENAME TO fn_union_governance_check_kept;"
        "CREATE FUNCTION public.fn_union_governance_check() RETURNS TABLE(invariant text, severity text, offenders bigint, detail text)"
        " LANGUAGE sql AS $$ SELECT * FROM fixture_governance $$;")
    refused = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-when-governance-drops-credit-risk',
          refused.returncode != 0 and 'no longer includes fn_union_credit_risk_check' in refused.stderr, refused.stderr[-300:])
    check('refusal-left-the-preimage', defmd5() == LIVE_DEF_MD5)
    run("DROP FUNCTION public.fn_union_governance_check();"
        "ALTER FUNCTION public.fn_union_governance_check_kept() RENAME TO fn_union_governance_check;")

    run(migration)
    check('candidate-reproduces-production-derived-postimage', defmd5() == POST_DEF_MD5)
    got = sweep(ECO, None)
    results['candidate'] = got
    check('one-credit-finding-is-filed-once-under-governance',
          got == [{'source': 'fn_ca_conservation_sweep:fn_union_governance_check', 'invariants': ['union_eco_not_recorded']}], got)
    both = sweep(ECO, GOV_ONLY)
    results['candidate_both'] = both
    check('governance-and-credit-findings-are-one-incident',
          both == [{'source': 'fn_ca_conservation_sweep:fn_union_governance_check',
                    'invariants': ['settlement_needs_review', 'union_eco_not_recorded']}], both)
    check('a-clean-union-files-nothing', sweep(None, None) == [])
    for role in ('anon', 'authenticated'):
        r = subprocess.run(list(map(str, psql)), input=f'SET ROLE {role}; SELECT {SIG};',
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
