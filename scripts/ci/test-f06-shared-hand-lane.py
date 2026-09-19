#!/usr/bin/env python3
"""Exercise the actual F06 guard/bindings and migration in native PostgreSQL 17."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/f06-shared-hand-lane')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=False)
pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
cluster = Path(tempfile.mkdtemp(prefix='f06-shared-hand-', dir='/tmp'))
socket = cluster / 'socket'
socket.mkdir(mode=0o700)
cmd = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
       '-h', str(socket), '-p', '55696', '-U', 'postgres', '-d', 'postgres']
results = {'scope': 'F06 source custody and shared hand lane; full financial qualification is separately recorded',
           'cases': [], 'passed': False}
installer = (ROOT / 'supabase/migrations/20260913202500_f06_preserve_shared_hand_lane.sql').read_text()
tournament_lane = 'ca:tournament-terminal-settlement:v1:00000000-0000-4000-8000-000000000099'
global_lane = 'ca:tournament-terminal-settlement:v1'
snapshot = "SELECT jsonb_build_object('seats',(SELECT jsonb_agg(s ORDER BY id) FROM table_seats s),'roster',(SELECT jsonb_agg(p ORDER BY id) FROM tournament_players p));"
same_seat = 'UPDATE table_seats SET stack=101,table_id=table_id WHERE id=2;'
same_roster = 'UPDATE tournament_players SET chips=101,table_id=table_id,seat_number=seat_number WHERE id=2;'
share_hand = "DO $$BEGIN PERFORM public.fn_ca_share_settlement_lane_for_table('00000000-0000-4000-8000-000000000002'); END$$;"
bound = "INSERT INTO smarter_private.f06_operations VALUES('00000000-0000-4000-8000-000000000002','begun','00000000-0000-4000-8000-000000000090');"


def command(argv, sql=None):
    return subprocess.run([str(x) for x in argv], input=sql, text=True, capture_output=True, env=env, timeout=30)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def run(name, sql, expected=None, error=None):
    r = command(cmd, sql)
    (out / (name + '.log')).write_text(r.stdout + r.stderr)
    passed = (r.returncode != 0 and error in r.stderr) if error else r.returncode == 0
    if expected is not None:
        passed = passed and r.stdout.rstrip('\n') == expected
    results['cases'].append({'name': name, 'passed': passed})
    require(passed, name + ': ' + r.stdout[-500:] + r.stderr[-1500:])
    return r.stdout.rstrip('\n')


def probe(name, sql, expected=None, error=None):
    return run(name, 'BEGIN;\n' + sql + '\nROLLBACK;', expected, error)


@contextmanager
def holder(lane=tournament_lane, exclusive=False):
    process = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    try:
        mode = '' if exclusive else '_shared'
        process.stdin.write("BEGIN; SELECT pg_advisory_xact_lock" + mode + "(hashtextextended('" + lane + "',0)); SELECT pg_advisory_lock(9132025);\n")
        process.stdin.flush()
        deadline = time.monotonic() + 5
        while command(cmd, "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=9132025 AND granted);").stdout.strip() != 't':
            require(process.poll() is None and time.monotonic() < deadline, 'Native holder barrier missing')
            time.sleep(.02)
        yield
        require(process.poll() is None, 'Competing holder exited before assertions')
    finally:
        if process.poll() is None:
            process.stdin.write('ROLLBACK;\n')
            process.stdin.close()
            process.wait(timeout=5)
        require(process.returncode == 0, 'Competing holder failed')


try:
    require(re.search(r'PostgreSQL\) 17\.', command([pg / 'postgres', '--version']).stdout), 'PostgreSQL 17 required')
    r = command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    require(r.returncode == 0, r.stderr)
    with (cluster / 'data/postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\nunix_socket_permissions=0700\nport=55696\nshared_buffers='16MB'\nmax_connections=10\n")
    r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-w', 'start'])
    require(r.returncode == 0, r.stderr)
    run('fixture', (ROOT / 'scripts/ci/probes/f06-shared-hand-lane/fixture.sql').read_text())
    index = runpy.run_path(str(ROOT / 'scripts/ci/probes/f06-shared-hand-lane/snapshot_index_qualification.py'))
    index['qualify'](ROOT, out, cmd, command, run, probe, require, results)
    require(results.get('snapshotIndex', {}).get('passed') is True, 'Snapshot access-path qualification did not complete')
    before = run('snapshot-before', snapshot)
    with holder():
        probe('pure-stack-column-does-not-fire', 'UPDATE table_seats SET stack=101 WHERE id=2 RETURNING stack;', '101')
        for attempt, delay in enumerate([0, .25, 1], 1):
            time.sleep(delay)
            probe('baseline-roster-promotion-attempt-' + str(attempt), share_hand + same_roster, error='40001: F06_RETRY_CANONICAL_LANE')
        probe('baseline-seat-noop-promotion', share_hand + same_seat, error='40001: F06_RETRY_CANONICAL_LANE')
    probe('same-mirror-works-after-holder', same_roster + 'SELECT chips FROM tournament_players WHERE id=2;', '101')
    require(run('baseline-writes-rolled-back', snapshot) == before, 'Baseline leaked state')
    probe('baseline-null-identity-was-misclassified', bound + 'UPDATE table_seats SET user_id=NULL WHERE id=2 RETURNING user_id IS NULL;', 't')
    run('predecessor-drift-refused', 'BEGIN; ALTER FUNCTION smarter_private.f06_source_guard() SET search_path=pg_catalog;\n' + installer, error='P0001')
    run('binding-drift-refused', 'BEGIN; ALTER TABLE table_seats DISABLE TRIGGER a00_f06_source_seat;\n' + installer, error='P0001')
    run('acl-drift-refused', 'BEGIN; GRANT EXECUTE ON FUNCTION smarter_private.f06_source_guard() TO authenticated;\n' + installer, error='P0001')
    run('install', installer)
    run('installation-replay', installer)
    run('both-reviewed-money-triggers-declared', "SELECT count(*) FROM ca_declared_money_triggers WHERE (table_name,trigger_name) IN (('table_seats','a00_f06_source_seat'),('tournament_players','a00_f06_source_roster'));", '2')
    require(run('installation-does-not-rewrite-state', snapshot) == before, 'Migration changed player state')
    with holder():
        probe('concurrent-seat-payload', share_hand + same_seat + 'SELECT stack FROM table_seats WHERE id=2;', '101')
        probe('concurrent-roster-mirror', share_hand + same_roster + 'SELECT chips FROM tournament_players WHERE id=2;', '101')
        structural = [
            ('seat-vacate', 'UPDATE table_seats SET left_at=now() WHERE id=2;'),
            ('seat-number', 'UPDATE table_seats SET seat_number=2 WHERE id=2;'),
            ('seat-identity', 'UPDATE table_seats SET user_id=gen_random_uuid() WHERE id=2;'),
            ('seat-null-identity', 'UPDATE table_seats SET user_id=NULL WHERE id=2;'),
            ('seat-table', "UPDATE table_seats SET table_id='00000000-0000-4000-8000-000000000001' WHERE id=2;"),
            ('seat-delete', 'DELETE FROM table_seats WHERE id=2;'),
            ('seat-insert', 'INSERT INTO table_seats SELECT 3,table_id,user_id,2,100,NULL FROM table_seats WHERE id=2;'),
            ('roster-status', "UPDATE tournament_players SET status='eliminated' WHERE id=2;"),
            ('roster-null-status', 'UPDATE tournament_players SET status=NULL WHERE id=2;'),
            ('roster-seat', 'UPDATE tournament_players SET seat_number=2 WHERE id=2;'),
            ('roster-user', 'UPDATE tournament_players SET user_id=gen_random_uuid() WHERE id=2;'),
            ('roster-table', "UPDATE tournament_players SET table_id='00000000-0000-4000-8000-000000000001' WHERE id=2;"),
            ('roster-delete', 'DELETE FROM tournament_players WHERE id=2;'),
        ]
        for name, change in structural:
            probe(name + '-still-excluded', change, error='40001: F06_RETRY_CANONICAL_LANE')
    for name, lane in [('global', global_lane), ('tournament', tournament_lane)]:
        with holder(lane, exclusive=True):
            probe(name + '-exclusive-blocks-seat', same_seat, error='40001: F06_RETRY_CANONICAL_LANE')
            probe(name + '-exclusive-blocks-roster', same_roster, error='40001: F06_RETRY_CANONICAL_LANE')
    probe('bound-null-identity-denied', bound + 'UPDATE table_seats SET user_id=NULL WHERE id=2;', error='55000: F06_SOURCE_EXCLUDED')
    probe('bound-unreceipted-vacate-denied', bound + 'UPDATE table_seats SET left_at=now() WHERE id=2;', error='55000: F06_SOURCE_EXCLUDED')
    probe('bound-unreceipted-roster-denied', bound + "UPDATE tournament_players SET status='eliminated' WHERE id=2;", error='55000: F06_SOURCE_EXCLUDED')
    probe('bound-payload-contract-preserved', bound + same_seat + same_roster)
    receipt = """
    INSERT INTO smarter_private.f06_attempts VALUES('00000000-0000-4000-8000-000000000091','00000000-0000-4000-8000-000000000090','00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001',2);
    INSERT INTO smarter_private.f06_dispatch VALUES('00000000-0000-4000-8000-000000000091',txid_current());
    """
    probe('canonical-receipted-seat-vacate', bound + receipt + 'UPDATE table_seats SET left_at=now() WHERE id=2 RETURNING left_at IS NOT NULL;', 't')
    probe('canonical-receipted-roster-move', bound + receipt + "UPDATE tournament_players SET table_id='00000000-0000-4000-8000-000000000001',seat_number=2 WHERE id=2 RETURNING seat_number;", '2')
    run('browser-execution-still-closed', "SELECT NOT has_function_privilege('anon','smarter_private.f06_source_guard()','EXECUTE') AND NOT has_function_privilege('authenticated','smarter_private.f06_source_guard()','EXECUTE');", 't')
    require(run('all-probes-rolled-back', snapshot) == before, 'Probe leaked player state')
    extension = runpy.run_path(str(ROOT / 'scripts/ci/probes/f06-shared-hand-lane/unsettled_qualification.py'))
    extension['qualify'](ROOT, out, cmd, command, run, probe, require, results)
    require(results.get('unsettledAbort', {}).get('passed') is True, 'Interrupted-hand qualification did not complete')
    require(results.get('successorAbort', {}).get('passed') is True, 'Successor interrupted-hand qualification did not complete')
    require(results.get('generationAbort', {}).get('passed') is True, 'Generation disposition qualification did not complete')
    require(results.get('mixedAbort', {}).get('passed') is True, 'Mixed interrupted-hand qualification did not complete')
    require(results.get('mixedCohorts', {}).get('passed') is True, 'Mixed post-cutover cohorts did not complete')
    require(results.get('mixedHuPrior', {}).get('passed') is True, 'Mixed HU prior-commit qualification did not complete')
    require(results.get('mixedHuPriorAbort', {}).get('passed') is True, 'Mixed HU original-abort qualification did not complete')
    prepared = runpy.run_path(str(ROOT / 'scripts/ci/probes/f06-shared-hand-lane/prepared_cancellation_qualification.py'))
    prepared['qualify'](ROOT, out, cmd, command, run, probe, require, results)
    require(results.get('preparedCancellation', {}).get('passed') is True, 'Prepared cancellation qualification did not complete')
    continuation = runpy.run_path(str(ROOT / 'scripts/ci/probes/f06-shared-hand-lane/no_start_continuation_qualification.py'))
    continuation['qualify'](ROOT, out, cmd, command, run, probe, require, results)
    require(results.get('noStartContinuation', {}).get('passed') is True, 'No-start continuation did not complete')
    spin = runpy.run_path(str(ROOT / 'scripts/ci/probes/f06-shared-hand-lane/spin_prior_qualification.py'))
    spin['qualify'](ROOT, out, cmd, command, run, probe, require, results)
    require(results.get('spinPrior', {}).get('passed') is True, 'Prior-backed Spin disposition qualification did not complete')
    completed = runpy.run_path(str(ROOT / 'scripts/ci/probes/f06-shared-hand-lane/completed_mtt_qualification.py'))
    completed['qualify'](ROOT, out, cmd, command, run, probe, require, results)
    require(results.get('completedMtt', {}).get('passed') is True, 'Completed MTT boundary qualification did not complete')
    interrupted = runpy.run_path(str(ROOT / 'scripts/ci/probes/f06-shared-hand-lane/interrupted_custody_qualification.py'))
    interrupted['qualify'](ROOT, out, cmd, command, run, probe, require, results)
    require(results.get('interruptedCustody', {}).get('passed') is True, 'Original interrupted custody qualification did not complete')
    retention = runpy.run_path(str(ROOT / 'scripts/ci/probes/f06-shared-hand-lane/snapshot_retention_qualification.py'))
    retention['qualify'](ROOT, out, cmd, command, run, probe, require, results)
    require(results.get('snapshotRetention', {}).get('passed') is True, 'Unresolved snapshot retention did not qualify')
    projected = runpy.run_path(str(ROOT / 'scripts/ci/probes/f06-shared-hand-lane/earlybird_projected_qualification.py'))
    projected['qualify'](ROOT, out, cmd, command, run, probe, require, results)
    require(results.get('earlybirdProjected', {}).get('passed') is True, 'Original projected witness did not qualify')
    retained = runpy.run_path(str(ROOT / 'scripts/ci/probes/f06-shared-hand-lane/retained_mtt_qualification.py'))
    retained['qualify'](ROOT, out, cmd, command, run, probe, require, results)
    require(results.get('retainedMtt', {}).get('passed') is True, 'Retained MTT qualification did not complete')
    results['passed'] = True
finally:
    if (cluster / 'data/postmaster.pid').exists():
        r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
        require(r.returncode == 0, 'Could not stop owned cluster')
    if (cluster / 'server.log').exists():
        shutil.copyfile(cluster / 'server.log', out / 'server.log')
    shutil.rmtree(cluster)
    results['ownedClusterRemoved'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps({'passed': results['passed'], 'cases': len(results['cases']), 'evidence': str(out)}))
