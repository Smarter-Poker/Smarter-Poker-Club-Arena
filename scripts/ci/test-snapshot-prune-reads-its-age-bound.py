"""Isolated PostgreSQL regression: the snapshot prune reads its age bound
before it calls the per-row disposal function.

sp_prune_hand_state_snapshots (cron sp_prune_hand_state_snapshots_2m, every two
minutes) filtered its candidates with smarter_private.horse_snapshot_disposable
alone. That function refuses every snapshot created or updated in the last
eight days, but the planner cannot see inside it, so each run called it once
per snapshot row in the table: 2.8M calls on 2026-10-16 to delete nothing, 40
to 120 s a run, and the 2 min role timeout killed a third of the runs
(PgCronFailuresElevated).

The test loads the exact production definition captured on 2026-10-16 (its
pg_get_functiondef md5 equals production's) and a stand-in disposal function
that applies the same eight-day gate and counts its own calls. It proves the
baseline calls the function for every young snapshot, then applies the
candidate migration and proves:
  * the same rows are deleted (old, certified, disposable) and the same rows
    are kept (young, old but refused, old without a certificate);
  * the function is called only for rows past the eight-day bound;
  * the postimage md5 equals production's derived postimage, and the grants
    are unchanged;
  * a second install is refused by the pinned preimage.
An empty throwaway cluster on a Unix socket; no network, no production
connection.
"""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase' / 'migrations' / '20261016103317_the_snapshot_prune_reads_its_age_bound_before_the_function.sql'
FIXTURE = ROOT / 'scripts' / 'ci' / 'fixtures' / 'snapshot-prune-age-bound' / 'sp_prune_hand_state_snapshots.sql'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/snapshot-prune-reads-its-age-bound')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='snapshot-prune-age-bound-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55829'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

# pg_get_functiondef md5 of the production function read 2026-10-16, before
# and after the candidate (the postimage derived read-only on production).
LIVE_DEF_MD5 = '54116971d0db8245a31761d7f61a0884'
POST_DEF_MD5 = '9796fd7b8fba97bf4fe0481740397f9e'
SIG = 'public.sp_prune_hand_state_snapshots(integer)'
YOUNG = 2000

SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA smarter_private;
CREATE TABLE public.hand_state_snapshots(id uuid PRIMARY KEY, table_id uuid NOT NULL, hand_number bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  players_json jsonb, is_complete boolean DEFAULT true);
CREATE INDEX idx_hand_state_snapshots_created_at ON public.hand_state_snapshots(created_at DESC);
CREATE INDEX idx_hand_state_snapshots_table_hand ON public.hand_state_snapshots(table_id, hand_number);
CREATE TABLE smarter_private.horse_adaptive_disposal_certificates(hand_id uuid PRIMARY KEY, table_id uuid, hand_number bigint);
CREATE INDEX horse_adaptive_disposal_snapshot_identity ON smarter_private.horse_adaptive_disposal_certificates(table_id, hand_number);
CREATE TABLE smarter_private.f06_hand_permits(table_id uuid, hand_number bigint, state text);
CREATE SEQUENCE smarter_private.disposable_calls;
-- Stand-in for the production function: the same first test (eight days on
-- statement_timestamp), then a horse-only stand-in for the rest of its holds.
-- It counts every call, which is what the regression measures.
CREATE FUNCTION smarter_private.horse_snapshot_disposable(p_snapshot uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $f$
DECLARE s public.hand_state_snapshots;
BEGIN
  PERFORM nextval('smarter_private.disposable_calls');
  SELECT * INTO s FROM public.hand_state_snapshots WHERE id = p_snapshot;
  IF NOT FOUND OR s.created_at >= statement_timestamp() - interval '8 days'
     OR s.updated_at >= statement_timestamp() - interval '8 days' THEN RETURN false; END IF;
  RETURN s.players_json @> '[{"is_horse": true}]' AND NOT s.players_json @> '[{"is_horse": false}]';
END $f$;
"""
GRANTS = """
REVOKE ALL ON FUNCTION public.sp_prune_hand_state_snapshots(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sp_prune_hand_state_snapshots(integer) TO service_role;
"""

HORSE = '[{"is_horse": true}]'
HUMAN = '[{"is_horse": true}, {"is_horse": false}]'
# (uuid suffix, age in days, players, certified): the rows past the bound.
OLD = [
    (1, 9, HORSE, True),    # old, certified, disposable: deleted
    (2, 10, HORSE, True),   # deleted
    (3, 30, HORSE, True),   # deleted
    (4, 9, HUMAN, True),    # old but refused by the function: kept
    (5, 9, HORSE, False),   # old, no certificate: kept
]
DELETED = {1, 2, 3}


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


def sid(n):
    return f'00000000-0000-0000-0000-{n:012d}'


def seed():
    sql = ['TRUNCATE public.hand_state_snapshots, smarter_private.horse_adaptive_disposal_certificates;',
           # Young snapshots, every one certified: exactly what production holds.
           f"""INSERT INTO public.hand_state_snapshots(id, table_id, hand_number, created_at, updated_at, players_json)
               SELECT ('00000000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid, '{sid(9)}', 100000 + g,
                      now() - make_interval(hours => g % 150), now() - make_interval(hours => g % 150), '{HORSE}'
                 FROM generate_series(1, {YOUNG}) g;""",
           """INSERT INTO smarter_private.horse_adaptive_disposal_certificates
               SELECT gen_random_uuid(), table_id, hand_number FROM public.hand_state_snapshots;"""]
    for n, days, players, certified in OLD:
        sql.append(f"INSERT INTO public.hand_state_snapshots VALUES ('{sid(n)}','{sid(8)}',{n},"
                   f"now() - make_interval(days => {days}), now() - make_interval(days => {days}), '{players}', true);")
        if certified:
            sql.append(f"INSERT INTO smarter_private.horse_adaptive_disposal_certificates VALUES (gen_random_uuid(),'{sid(8)}',{n});")
    sql.append('ANALYZE public.hand_state_snapshots; ANALYZE smarter_private.horse_adaptive_disposal_certificates;')
    run('\n'.join(sql))


def prune():
    """One cron run: returns (deleted, function calls, surviving old ids, young rows left)."""
    seed()
    before = int(run("SELECT last_value + (CASE WHEN is_called THEN 0 ELSE -1 END) FROM smarter_private.disposable_calls"))
    deleted = int(run('SELECT public.sp_prune_hand_state_snapshots(10000)'))
    after = int(run("SELECT last_value FROM smarter_private.disposable_calls"))
    kept = run("SELECT string_agg(right(id::text, 1), ',' ORDER BY id) FROM public.hand_state_snapshots "
               f"WHERE table_id = '{sid(8)}'")
    young = int(run(f"SELECT count(*) FROM public.hand_state_snapshots WHERE table_id = '{sid(9)}'"))
    return deleted, after - before, kept, young


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)
    run(FIXTURE.read_text() + ';' + GRANTS)
    check('baseline-is-production-preimage',
          run(f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))") == LIVE_DEF_MD5)

    deleted, calls, kept, young = prune()
    results['baseline'] = {'deleted': deleted, 'calls': calls, 'kept_old': kept, 'young_left': young}
    check('baseline-deletes-only-the-disposable-rows', deleted == len(DELETED) and kept == '4,5', results['baseline'])
    check('baseline-calls-the-function-for-every-young-row', calls >= YOUNG, results['baseline'])

    body = MIGRATION.read_text()
    run(body)
    check('postimage-is-production-derived-postimage',
          run(f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))") == POST_DEF_MD5)
    check('grants-unchanged',
          run(f"SELECT proacl::text FROM pg_proc WHERE oid = '{SIG}'::regprocedure")
          == '{postgres=X/postgres,service_role=X/postgres}')

    deleted, calls, kept, young = prune()
    results['after'] = {'deleted': deleted, 'calls': calls, 'kept_old': kept, 'young_left': young}
    check('same-rows-deleted', deleted == len(DELETED), results['after'])
    check('same-old-rows-kept', kept == '4,5', results['after'])
    check('young-rows-untouched', young == YOUNG, results['after'])
    # Two DELETE statements per round (the CTE and the re-check), one round
    # that deletes and one that finds nothing: a handful of calls, never one
    # per young row.
    check('function-called-only-past-the-bound', calls <= 4 * len(OLD), results['after'])

    # A second install is refused by the pinned preimage, not applied twice.
    try:
        run(body)
        check('reinstall-is-refused', False, 'second install succeeded')
    except RuntimeError as e:
        check('reinstall-is-refused', 'is not the pinned text' in str(e), str(e)[:200])
    results['passed'] = True
finally:
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2))
    try:
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])
    except Exception:
        pass
    shutil.rmtree(cluster, ignore_errors=True)

print(json.dumps(results, indent=2))
