#!/usr/bin/env python3
"""The hand submission resume path must plan on current statistics.

2026-09-28. fn_ca_resume_hand_submission picks its candidate with one query.
That query was the single largest source of statement timeouts on the platform
(4,443 cancellations in seven and a half hours), measured at 57,367 ms against
the 8s engine budget while answering "nothing to resume".

It was never a missing index. public.hand_atomic_commits held 3.78M rows in
11 GB with analyze_count = 0 and last_autoanalyze = NULL: it had been given
aggressive VACUUM settings and no ANALYZE settings, so autovacuum ran while
autoanalyze still used the global rule of 50 + 10% of the table, which is
377,643 modifications on that table. The planner costed LIMIT 1 at 6.35, chose
a nested loop probing hand_atomic_commits once per candidate row, and paid
16,065 random heap fetches. With current statistics it merges against
hand_atomic_commits_pkey and the same query runs in 112 ms.

This test pins the POLICY, not a one off ANALYZE. A threshold expressed as a
fraction of the table is the bug: a tenth of 3.78M rows is 377K modifications
of drift. Every table the resume path reads must declare an absolute analyze
threshold, which is autovacuum_analyze_scale_factor = 0 plus a row count.

Red without supabase/migrations/20260928200404_the_resume_path_plans_on_current_statistics.sql.
"""
import argparse
from pathlib import Path
import json
import os
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/resume-path-statistics-policy')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
cluster = Path(tempfile.mkdtemp(prefix='resume-stats-', dir='/tmp'))
socket = cluster / 'socket'
socket.mkdir(mode=0o700)
cmd = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
       '-h', str(socket), '-p', '55701', '-U', 'postgres', '-d', 'postgres']

MIGRATION = ROOT / 'supabase/migrations/20260928200404_the_resume_path_plans_on_current_statistics.sql'

# The four tables fn_ca_resume_hand_submission reads to pick its candidate, and
# the largest absolute analyze threshold each may declare. A threshold above
# this is drift the planner would carry into the engine's 8s budget.
GOVERNED = {
    'public.hand_atomic_commits': 20000,
    'smarter_private.hand_submissions': 20000,
    'smarter_private.hand_submission_disposals': 5000,
    'smarter_private.f06_hand_permits': 5000,
}

# Production before the fix: hand_atomic_commits carried VACUUM tuning and no
# ANALYZE tuning; the other three declared no storage parameters at all.
FIXTURE = """
CREATE SCHEMA smarter_private;
CREATE TABLE public.hand_atomic_commits(
  table_id uuid, hand_number bigint, hand_id uuid,
  post_commit_completed_at timestamptz, post_commit_result jsonb, filler text,
  PRIMARY KEY(table_id, hand_number))
  WITH (autovacuum_vacuum_scale_factor=0.0, autovacuum_vacuum_threshold=20000);
CREATE UNIQUE INDEX hand_atomic_commits_hand_number_key ON public.hand_atomic_commits(hand_number);
CREATE TABLE smarter_private.hand_submissions(
  submission_id uuid PRIMARY KEY, table_id uuid, hand_number bigint);
CREATE UNIQUE INDEX hand_submissions_table_id_hand_number_key
  ON smarter_private.hand_submissions(table_id, hand_number);
CREATE TABLE smarter_private.hand_submission_disposals(
  table_id uuid, hand_number bigint, PRIMARY KEY(table_id, hand_number));
CREATE TABLE smarter_private.f06_hand_permits(
  table_id uuid, hand_number bigint, state text, PRIMARY KEY(table_id, hand_number));
CREATE UNIQUE INDEX f06_one_hand ON smarter_private.f06_hand_permits(table_id) WHERE state='reserved';
"""

POLICY = """
SELECT n.nspname||'.'||c.relname,
       COALESCE((SELECT o FROM unnest(c.reloptions) o WHERE o LIKE 'autovacuum_analyze_scale_factor=%'),'<none>'),
       COALESCE((SELECT o FROM unnest(c.reloptions) o WHERE o LIKE 'autovacuum_analyze_threshold=%'),'<none>')
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname||'.'||c.relname = ANY(__TABLES__)
 ORDER BY 1;
"""

results = {'scope': 'Resume path statistics policy: every table the candidate query reads '
                    'must declare an absolute analyze threshold, never a fraction of the table',
           'cases': [], 'passed': False}


def command(argv, sql=None):
    return subprocess.run([str(x) for x in argv], input=sql, text=True,
                          capture_output=True, env=env, timeout=120)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def run(name, sql, expected=None):
    r = command(cmd, sql)
    (out / (name + '.log')).write_text(r.stdout + r.stderr)
    passed = r.returncode == 0
    if expected is not None:
        passed = passed and r.stdout.rstrip('\n') == expected
    results['cases'].append({'name': name, 'passed': passed})
    require(passed, name + ': ' + r.stdout[-500:] + r.stderr[-1500:])
    return r.stdout.rstrip('\n')


def policy_rows():
    arg = 'ARRAY[' + ','.join("'" + t + "'" for t in GOVERNED) + ']'
    rows = run('policy-read', POLICY.replace('__TABLES__', arg))
    parsed = {}
    for line in rows.splitlines():
        if not line.strip():
            continue
        rel, scale, threshold = line.split('|')
        parsed[rel] = (scale, threshold)
    return parsed


try:
    require(MIGRATION.exists(), 'Missing migration: ' + str(MIGRATION))
    require(re.search(r'PostgreSQL\) 17\.', command([pg / 'postgres', '--version']).stdout),
            'PostgreSQL 17 required')
    r = command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres',
                 '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    require(r.returncode == 0, r.stderr)
    with (cluster / 'data/postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket)
                + "'\nunix_socket_permissions=0700\nport=55701\nshared_buffers='32MB'\nmax_connections=10\n")
    r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-w', 'start'])
    require(r.returncode == 0, r.stderr)

    run('fixture', FIXTURE)

    # THE DEFECT, STATED. Before the migration not one of the four declares an
    # analyze policy, so every one of them inherits the global rule: 50 plus a
    # tenth of the table. On a 3.78M row table that is 377,643 modifications of
    # drift, which is how hand_atomic_commits reached analyze_count = 0.
    before = policy_rows()
    results['before'] = {k: list(v) for k, v in before.items()}
    require(len(before) == len(GOVERNED), 'Fixture did not create every governed table')
    unset_before = [t for t, (scale, _) in before.items() if scale == '<none>']
    require(sorted(unset_before) == sorted(GOVERNED),
            'Fixture must reproduce the pre fix state: every governed table on the global rule, got '
            + json.dumps(results['before']))
    results['cases'].append({'name': 'pre-fix-state-is-the-global-ten-percent-rule', 'passed': True})

    run('install', MIGRATION.read_text())
    run('installation-replay', MIGRATION.read_text())

    after = policy_rows()
    results['after'] = {k: list(v) for k, v in after.items()}
    for table, ceiling in GOVERNED.items():
        scale, threshold = after.get(table, ('<none>', '<none>'))
        require(scale != '<none>' and float(scale.split('=')[1]) == 0.0,
                table + ' still lets its analyze threshold scale with the table (' + scale
                + '). A tenth of a large table is the drift this migration exists to end.')
        require(threshold != '<none>', table + ' declares no absolute analyze threshold')
        value = int(threshold.split('=')[1])
        require(0 < value <= ceiling,
                table + ' analyze threshold ' + str(value) + ' exceeds the ceiling ' + str(ceiling))
        results['cases'].append({'name': 'absolute-analyze-threshold:' + table, 'passed': True})

    # The mechanism, recorded as evidence: with statistics present the planner
    # merges against hand_atomic_commits_pkey instead of probing it per row.
    run('seed', """
INSERT INTO public.hand_atomic_commits
SELECT ('11111111-1111-4111-8111-'||lpad((g%20)::text,12,'0'))::uuid, g,
       ('00000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid, now(),
       jsonb_build_object('ok','true'), repeat('z',600)
FROM generate_series(1,120000) g;
INSERT INTO smarter_private.hand_submissions
SELECT ('00000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,
       ('11111111-1111-4111-8111-'||lpad((g%20)::text,12,'0'))::uuid, g
FROM generate_series(1,120000) g;
ANALYZE;
""")
    candidate = """
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, COSTS OFF)
SELECT j.* FROM smarter_private.hand_submissions j
 LEFT JOIN public.hand_atomic_commits c ON c.table_id=j.table_id AND c.hand_number=j.hand_number
 LEFT JOIN smarter_private.f06_hand_permits p ON p.table_id=j.table_id AND p.hand_number=j.hand_number
 WHERE j.table_id='11111111-1111-4111-8111-000000000007'
 AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals dd
   WHERE dd.table_id=j.table_id AND dd.hand_number=j.hand_number)
 AND (c.hand_id IS DISTINCT FROM j.submission_id OR c.post_commit_completed_at IS NULL
   OR c.post_commit_result->>'ok' IS DISTINCT FROM 'true' OR p.state='reserved')
 ORDER BY j.hand_number LIMIT 1;
"""
    plan = run('candidate-plan-on-current-statistics', candidate)
    results['plannedOrderedMerge'] = 'hand_atomic_commits_pkey' in plan
    results['plannedPerRowProbe'] = 'hand_atomic_commits_hand_number_key' in plan
    (out / 'candidate-plan.txt').write_text(plan)

    results['passed'] = True
finally:
    if (cluster / 'data/postmaster.pid').exists():
        r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
        require(r.returncode == 0, 'Could not stop owned cluster')
    if (cluster / 'server.log').exists():
        shutil.copyfile(cluster / 'server.log', out / 'server.log')
    shutil.rmtree(cluster, ignore_errors=True)
    results['ownedClusterRemoved'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps({'passed': results['passed'], 'cases': len(results['cases']),
                      'evidence': str(out)}))
