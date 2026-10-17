#!/usr/bin/env python3
"""The crash snapshot read finds its one row in a cached plan (20261017170945).

Disposable native PostgreSQL. Builds hand_state_snapshots with the production
indexes that matter here, fills it the way a long-lived table fills it (many
completed snapshots, at most one incomplete per table), and asks the planner
for the GENERIC plan of the engine's boot read exactly as PostgREST
parameterises it:

    WHERE table_id = $1 AND is_complete = $2 ORDER BY updated_at DESC LIMIT $3

Before the migration that plan walks every snapshot of the table through
(table_id, hand_number) and filters is_complete - the 2026-10-17 12:57Z
timeouts. After it, both columns are index conditions and the read touches
the incomplete entry only. The migration is applied the way
scripts/ci/apply-recorded-migration.mjs applies it: each CREATE INDEX
CONCURRENTLY preamble statement alone and outside a transaction, then the body.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/ci'))
MIGRATION = ROOT / 'supabase/migrations/20261017170945_the_crash_snapshot_read_finds_its_one_row_in_a_cached_plan.sql'
PG = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
cluster = Path(tempfile.mkdtemp(prefix='crash-snapshot-plan-', dir=os.environ.get('TMPDIR')))
socket = Path(tempfile.mkdtemp(prefix='csp-sock-', dir='/tmp'))
data = cluster / 'data'
env = {'PATH': str(PG) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
started = False

TABLES = 40
SNAPSHOTS_PER_TABLE = 2500


def run(args, sql=None):
    result = subprocess.run([str(a) for a in args], input=sql, text=True,
                            capture_output=True, env=env, timeout=600)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result.stdout.strip()


def q(sql):
    return run([PG / 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-h', socket,
                '-U', 'postgres', '-d', 'postgres'], sql)


def generic_plan():
    plan = json.loads(q("""
        EXPLAIN (GENERIC_PLAN, FORMAT JSON)
        SELECT hand_number, state_json, players_json, stage, updated_at
          FROM public.hand_state_snapshots
         WHERE table_id = $1 AND is_complete = $2
         ORDER BY updated_at DESC LIMIT $3;"""))
    return plan[0]['Plan']


def scans(node):
    found = []
    if 'Index Name' in node:
        found.append(node)
    for child in node.get('Plans', []):
        found.extend(scans(child))
    return found


def filters(node):
    found = [node['Filter']] if 'Filter' in node else []
    for child in node.get('Plans', []):
        found.extend(filters(child))
    return found


def split_migration(sql):
    """The applier's own split, so this test applies what production would."""
    out = run(['node', '-e', """
        import('./scripts/ci/migration-concurrent-preamble.mjs').then((m) => {
          const s = require('fs').readFileSync(process.argv[1], 'utf8');
          process.stdout.write(JSON.stringify(m.splitConcurrentPreamble(s)));
        });""", MIGRATION])
    shape = json.loads(out)
    assert shape['ok'], shape
    return [i['statement'] for i in shape['indexes']], shape['body']


try:
    env['PATH'] = str(PG) + ':' + os.environ.get('PATH', '/usr/bin:/bin')
    run([PG / 'initdb', '-D', data, '-U', 'postgres', '--auth=trust'])
    run([PG / 'pg_ctl', '-D', data, '-l', cluster / 'log', '-w', '-o',
         f"-k {socket} -c listen_addresses=''", 'start'])
    started = True

    q("""
    CREATE TABLE public.hand_state_snapshots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      table_id uuid NOT NULL,
      hand_number integer NOT NULL,
      state_json jsonb NOT NULL DEFAULT '{}',
      players_json jsonb NOT NULL DEFAULT '[]',
      stage text NOT NULL DEFAULT 'preflop',
      is_complete boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX idx_hand_state_snapshots_table_hand
      ON public.hand_state_snapshots (table_id, hand_number);
    CREATE UNIQUE INDEX idx_hand_snapshots_one_active_per_table
      ON public.hand_state_snapshots (table_id) WHERE is_complete = false;
    CREATE INDEX idx_hand_state_snapshots_created_at
      ON public.hand_state_snapshots (created_at DESC);
    """)
    q(f"""
    INSERT INTO public.hand_state_snapshots (table_id, hand_number, is_complete, state_json, updated_at)
    SELECT t.id, h, h < {SNAPSHOTS_PER_TABLE},
           jsonb_build_object('pot', h, 'board', repeat('x', 200)),
           now() - make_interval(secs => {SNAPSHOTS_PER_TABLE} - h)
      FROM (SELECT gen_random_uuid() id FROM generate_series(1, {TABLES})) t,
           generate_series(1, {SNAPSHOTS_PER_TABLE}) h;
    ANALYZE public.hand_state_snapshots;
    """)

    plan = generic_plan()
    before = scans(plan)
    assert len(before) == 1, before
    assert before[0]['Index Name'] == 'idx_hand_state_snapshots_table_hand', before
    assert any('is_complete' in f for f in filters(plan)), plan
    print('PASS: without the migration the cached plan walks (table_id, hand_number) and filters is_complete', flush=True)

    preamble, body = split_migration(MIGRATION.read_text())
    assert len(preamble) == 1, preamble
    for statement in preamble:
        q(statement)  # alone, outside any transaction - CONCURRENTLY requires it
    q(body)
    print('PASS: migration applied the way the applier applies it', flush=True)

    plan = generic_plan()
    after = scans(plan)
    assert len(after) == 1, after
    assert after[0]['Index Name'] == 'idx_hand_state_snapshots_table_complete', after
    cond = after[0].get('Index Cond', '')
    assert 'table_id' in cond and 'is_complete' in cond, after
    assert not any('is_complete' in f for f in filters(plan)), plan
    print('PASS: the cached plan reads (table_id, is_complete) with both as index conditions', flush=True)

    # The read now touches only incomplete entries: measure it with the generic plan forced.
    some_table = q('SELECT table_id FROM public.hand_state_snapshots LIMIT 1;')
    probe = q(f"""
    SET plan_cache_mode = force_generic_plan;
    PREPARE boot_read(uuid, boolean, integer) AS
      SELECT hand_number FROM public.hand_state_snapshots
       WHERE table_id = $1 AND is_complete = $2 ORDER BY updated_at DESC LIMIT $3;
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      EXECUTE boot_read('{some_table}', false, 1);
    """)
    executed = json.loads(probe[probe.index('['):])  # after psql's SET / PREPARE tags
    plan = executed[0]['Plan']
    rows_read = sum(n.get('Actual Rows', 0) for n in scans(plan))
    assert rows_read <= 1, plan
    print(f'PASS: the forced generic plan returned {rows_read} index row(s) for a table with {SNAPSHOTS_PER_TABLE} snapshots', flush=True)

    # Re-applying is a no-op (IF NOT EXISTS) and the body still verifies.
    for statement in preamble:
        q(statement)
    q(body)
    print('PASS: re-application is idempotent', flush=True)
finally:
    if started:
        subprocess.run([str(PG / 'pg_ctl'), '-D', str(data), '-m', 'immediate', 'stop'],
                       capture_output=True, env=env)
    shutil.rmtree(cluster, ignore_errors=True)
    shutil.rmtree(socket, ignore_errors=True)
