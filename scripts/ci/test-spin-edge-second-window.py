"""Isolated PostgreSQL regression for migration 20261016172618.

fn_spin_fairness_check raised a critical expectation_drift on one hourly
sliding 7-day window (z 4.52 on 2026-10-16) while the sampler, every receipt's
ladder and 14 days together (z 1.9) were on spec. The chi-square verdicts
already needed the preceding, non-overlapping window (20261015025123,
20261015215216); the mean did not.

The test loads the exact production definition captured on 2026-10-16 (its
pg_get_functiondef md5 equal to production's), proves the baseline raises a
critical on a single-window rare-tier run, applies the migration as production
would, and proves the candidate reproduces the postimage derived read-only on
production, reports a single-window crossing as expectation_unconfirmed
without an alert, still raises when the preceding window drifts the same way,
raises at once beyond |z| 6, does not confirm across opposite signs or an empty
prior window, leaves an ordinary hour and the off-ladder verdict alone, closes
the open alert and incident it names, keeps owner, security, settings and
grants, and refuses a second run. Schema and grants are those of
scripts/ci/test-spin-detectors.py. An empty throwaway cluster on a Unix socket;
no network, no production connection.
"""
import argparse
import ast
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase' / 'migrations' / '20261016172618_a_spin_edge_drift_needs_a_second_window.sql'
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'spin-edge-second-window'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/spin-edge-second-window')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='spin-edge-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55872'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

SIG = 'public.fn_spin_fairness_check(integer)'
PRE = '7124884d909fa278904c724a8f846f50'
POST = '0e6671e857d328cb86f228cac6271b94'
META = 'postgres true {"search_path=public, pg_temp"} {postgres=X/postgres,service_role=X/postgres}'
ALERT = 'fffd604c-2048-44d4-9805-96bad5a37ffd'
INCIDENT = 'a08c56e1-e081-40d6-8a2e-f03320d307c0'

tree = ast.parse((ROOT / 'scripts/ci/test-spin-detectors.py').read_text())


def constant(name):
    return next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == name for t in n.targets))


SCHEMA = constant('SCHEMA') + """
CREATE TABLE ca_drift_incidents(id uuid PRIMARY KEY, status text);
CREATE TABLE incident_actions(incident_id uuid, action text, correction_ref text);
CREATE FUNCTION fn_ca_incident_action(p_incident_id uuid, p_action text, p_note text, p_assignee uuid,
  p_root_cause text, p_correction_ref text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO incident_actions VALUES (p_incident_id, p_action, p_correction_ref);
  UPDATE ca_drift_incidents SET status = 'resolved' WHERE id = p_incident_id;
  RETURN '{"ok": true}';
END $$;
"""

# 100,000 draws on the published ladder, and the same with draws moved from
# 2x to 100x: each moved draw lifts the mean by 0.00098 (z about 0.19).
ON_SPEC = {2: 48098, 3: 39307, 4: 9000, 5: 2500, 10: 1000, 25: 75, 50: 10, 100: 10}


def lifted(moves):
    return {**ON_SPEC, 2: ON_SPEC[2] - moves, 100: ON_SPEC[100] + moves}


TAIL_RUN = lifted(23)       # z about 4.4: the 2026-10-16 shape
MILD = lifted(13)           # z about 2.5, chi-square below p < 0.01
FAULT = lifted(40)          # z about 7.6: beyond what chance produces
LOWER = {**ON_SPEC, 2: ON_SPEC[2] + 635, 4: ON_SPEC[4] - 635}  # z about -2.5


def command(args, sql=None):
    r = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=120)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def run(sql):
    return command(psql, sql)


def check(name, passed, detail=None):
    results['checks'].append({'name': name, 'passed': bool(passed), 'detail': detail})
    if not passed:
        raise AssertionError(f'{name}: {detail}')


def md5():
    return run(f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))")


def seed(current, previous):
    sql = ['TRUNCATE tournaments, financial_alerts;']
    for window, counts in (('1 hour', current), ('8 days', previous)):
        for mult, n in counts.items():
            sql.append("INSERT INTO tournaments(variant,status,spin_multiplier,created_at) "
                       f"SELECT 'spin','COMPLETED',{mult},now() - interval '{window}' - (g * interval '1 second') "
                       f"FROM generate_series(1,{n}) g;")
    run('\n'.join(sql))


def fairness():
    r = json.loads(run('SELECT fn_spin_fairness_check(7)'))
    alerts = json.loads(run("SELECT coalesce(jsonb_agg(jsonb_build_array(severity, context->>'verdict')),'[]') "
                            "FROM financial_alerts"))
    return r, alerts


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=32MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)
    run((FIXTURES / 'fn_spin_fairness_check.live-20261016.sql').read_text()
        + f';\nREVOKE ALL ON FUNCTION {SIG} FROM PUBLIC; GRANT EXECUTE ON FUNCTION {SIG} TO service_role;\n')
    check('baseline-is-production-preimage', md5() == PRE, md5())

    seed(TAIL_RUN, ON_SPEC)
    r, alerts = fairness()
    results['baseline_tail_run'] = {'verdict': r['verdict'], 'z': r['z'], 'chi': r['chi_square'], 'alerts': alerts}
    check('baseline-raises-critical-on-one-window', r['verdict'] == 'expectation_drift'
          and alerts == [['critical', 'expectation_drift']] and 4 < r['z'] < 6, r)

    migration = MIGRATION.read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    check('candidate-sets-lock-timeout', 'SET LOCAL lock_timeout' in migration)
    proof = re.search(r'^-- @live-proof: (.+)$', migration, re.M)
    check('candidate-carries-a-live-proof', proof is not None)
    # The open alert and incident the migration closes, as production holds them.
    run(f"""TRUNCATE financial_alerts; INSERT INTO financial_alerts(id, severity, source, message, context) VALUES
      ('{ALERT}', 'critical', 'fn_spin_fairness_check', 'drift', '{{"verdict": "expectation_drift"}}'),
      (gen_random_uuid(), 'critical', 'fn_spin_fairness_check', 'other', '{{"verdict": "off_ladder"}}');
      INSERT INTO ca_drift_incidents VALUES ('{INCIDENT}', 'open'), (gen_random_uuid(), 'open');""")
    run(migration)
    check('candidate-reproduces-production-derived-postimage', md5() == POST, md5())
    check('live-proof-reads-true-after-install', run(proof.group(1)) == 't')
    closed = run("SELECT string_agg(context->>'verdict' || ':' || resolved::text || ':' || "
                 "coalesce((resolution LIKE '%migration 20261016172618')::text, '-'), ',' ORDER BY id) FROM financial_alerts")
    check('only-the-named-alert-is-closed', sorted(closed.split(',')) ==
          ['expectation_drift:true:true', 'off_ladder:false:-'], closed)
    acted = run("SELECT string_agg(incident_id || '|' || action || '|' || correction_ref, ',') FROM incident_actions")
    check('only-the-named-incident-is-resolved-with-its-migration',
          acted == f'{INCIDENT}|resolve|migration 20261016172618_a_spin_edge_drift_needs_a_second_window', acted)

    seed(TAIL_RUN, ON_SPEC)
    r, alerts = fairness()
    results['candidate_tail_run'] = {k: r[k] for k in ('verdict', 'z', 'prior_window_z',
                                                       'prior_window_confirms_expectation')}
    check('a-single-window-run-is-reported-not-raised', r['verdict'] == 'expectation_unconfirmed'
          and alerts == [] and r['prior_window_confirms_expectation'] is False, r)
    check('the-window-statistics-are-unchanged',
          r['z'] == results['baseline_tail_run']['z'] and r['chi_square'] == results['baseline_tail_run']['chi'], r)

    seed(TAIL_RUN, MILD)
    r, alerts = fairness()
    results['candidate_confirmed'] = {k: r[k] for k in ('verdict', 'z', 'prior_window_z')}
    check('a-drift-in-both-windows-still-raises-critical', r['verdict'] == 'expectation_drift'
          and alerts == [['critical', 'expectation_drift']] and 2 < r['prior_window_z'] < 4
          and r['prior_window_confirms_expectation'] is True, r)

    seed(FAULT, ON_SPEC)
    r, alerts = fairness()
    results['candidate_fault'] = {k: r[k] for k in ('verdict', 'z')}
    check('beyond-z-6-raises-critical-on-one-window', r['verdict'] == 'expectation_drift'
          and alerts == [['critical', 'expectation_drift']] and r['z'] > 6, r)

    seed(TAIL_RUN, LOWER)
    r, alerts = fairness()
    results['candidate_opposite'] = {k: r[k] for k in ('verdict', 'z', 'prior_window_z')}
    check('an-opposite-drift-does-not-confirm', r['prior_window_z'] < -2
          and r['prior_window_confirms_expectation'] is False and r['verdict'] != 'expectation_drift', r)

    seed(TAIL_RUN, {})
    r, alerts = fairness()
    check('an-empty-prior-window-confirms-nothing', r['verdict'] == 'expectation_unconfirmed'
          and alerts == [] and r['prior_window_ev_draws'] == 0, r)

    seed(ON_SPEC, ON_SPEC)
    r, alerts = fairness()
    check('an-ordinary-hour-passes-and-reads-no-prior-mean', r['verdict'] == 'pass' and alerts == []
          and r['prior_window_ev_draws'] == 0, r)

    seed({**ON_SPEC, 7: 3}, ON_SPEC)
    r, alerts = fairness()
    check('an-off-ladder-draw-still-raises-critical',
          r['verdict'] == 'off_ladder' and alerts == [['critical', 'off_ladder']], r)

    meta = run(f"SELECT pg_get_userbyid(proowner)||' '||prosecdef::text||' '||coalesce(proconfig::text,'-')"
               f"||' '||coalesce(proacl::text,'-') FROM pg_proc WHERE oid = '{SIG}'::regprocedure")
    check('owner-security-settings-and-grants-kept', meta == META, meta)
    replay = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-a-second-run',
          replay.returncode != 0 and 'is not the pinned text' in replay.stderr, replay.stderr[-300:])
    check('second-run-left-the-postimage', md5() == POST)
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'output': str(out / 'RESULTS.json')}))
