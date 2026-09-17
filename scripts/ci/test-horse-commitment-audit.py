#!/usr/bin/env python3
"""Four sequential, disposable PG17 daily-audit/reader controls. No remote connection."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import time

INPUTS = {
    'bootstrap': ('scripts/ci/probes/horse-commitment-audit/bootstrap.sql', '5fc31c44c01d05b84b9a61db409a95548e3dcff9d90a9dc45da7964dd7e226cb'),
    'setup': ('scripts/ci/probes/horse-commitment-audit/setup.sql', '61ff9cfad14c95f680a9ce5e308b7ea2fcd6748a3fb556d945b39a480d4b8f21'),
    'schema': ('supabase/migrations/20260914161209_horse_committed_pot_daily_audit.sql', '1c763cd40a9b6292f15d03fdb133dad7714a01d81de4e0289a8968a0c83f9c51'),
    'r1': ('scripts/ci/probes/horse-commitment-audit/original-r1-function.sql', '80202508fdd16a9e9bc8be74f2af673fbdf1a43261d0b05713a588fea2a661a6'),
    'r2': ('supabase/migrations/20260917051350_horse_commitment_reviews_preserve_format_and_canonical_rosters.sql', '90cc33502fbfcf9a6912f9dce101a038f72f810865e07390ca28b671691ec663'),
    'format85': ('scripts/ci/probes/horse-commitment-audit/format-and-commitment.sql', 'e9011307afa8d70a835917a775173b9e16d399d94f28a49b7b53121591f1f8f3'),
    'roster24': ('scripts/ci/probes/horse-commitment-audit/roster-identity.sql', '95234c46cb34fb26a39974a3c0df4cf56f51cad03e4b71419295d0e58a6e818a'),
    'reader_auth': ('scripts/ci/probes/horse-commitment-audit/reader-auth.sql', 'fed395d00a7abff91d72309cf2f27b0edc6260c9451f3142a5ba39492c84d45c'),
    'reader': ('supabase/migrations/20260917050940_horse_private_commitment_review_reader.sql', '51a8337cc2f699d5f602247f1fb996cc87b303055cbabf83e52dff4b9452e427'),
    'reader27': ('scripts/ci/probes/horse-commitment-audit/reader-page.sql', '9f2f3598b8df9dc6eb7d2ede83b7e09e99de326d35486743885709685902395b'),
}
JOBS = (
    ('R1_duplicate_negative', 'r1', 'roster24', None),
    ('R2_existing85', 'r2', 'format85', b'prepared_expectations_reached_only_if_this_fixture_is_actually_executed|85'),
    ('R2_roster24', 'r2', 'roster24', b'synthetic_roster_controls_only_if_executed|24'),
    ('private_reader27', 'reader', 'reader27', b'synthetic_reader_controls_only_if_executed|27'),
)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin', type=Path, required=True)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--allocation-parent', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if os.geteuid() == 0:
        raise RuntimeError('nonroot_fixture_user_required')
    for path in (args.pg_bin, args.source_root, args.allocation_parent, args.output):
        if not path.is_absolute():
            raise RuntimeError('explicit_absolute_paths_required')
    pg = args.pg_bin.resolve(strict=True)
    parent = args.allocation_parent.resolve(strict=True)
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(parent)) or len(str(parent)) > 45:
        raise RuntimeError('short_plain_private_allocation_parent_required')
    if shutil.disk_usage(parent).free < 1024 ** 3:
        raise RuntimeError('fixture_disk_floor_1GiB')
    for name in ('postgres', 'initdb', 'pg_ctl', 'psql', 'createdb'):
        if not (pg / name).is_file() or not os.access(pg / name, os.X_OK):
            raise RuntimeError('existing_postgresql_tools_required')
    source = args.source_root.resolve(strict=True)
    payloads = {}
    for key, (relative, expected) in INPUTS.items():
        path = (source / relative).resolve(strict=True)
        if source not in path.parents or path.stat().st_size > 65536:
            raise RuntimeError('source_path_or_size_refused')
        value = path.read_bytes()
        if digest(value) != expected:
            raise RuntimeError('source_hash_mismatch_' + key)
        payloads[key] = value
    os.umask(0o077)
    args.output.mkdir(mode=0o700, parents=False, exist_ok=False)
    evidence = args.output.resolve(strict=True)
    private_home = evidence / 'empty-home'
    private_home.mkdir(mode=0o700)
    # Construct an environment from public constants. Never consult project env,
    # PG service files, passwords, passfiles or a production connection string.
    env = {'PATH': str(pg) + ':/usr/bin:/bin', 'HOME': str(private_home),
           'LANG': 'C', 'LC_ALL': 'C', 'TZ': 'UTC', 'PGPASSFILE': '/dev/null',
           'PGSERVICEFILE': '/dev/null', 'PGCONNECT_TIMEOUT': '3'}
    started_at = time.monotonic()
    deadline = started_at + 180
    cleanup_deadline = None
    calls = []
    jobs = []
    result = {'status': 'incomplete', 'executed': False, 'jobs': jobs, 'commands': calls,
              'sourceHashes': {key: digest(value) for key, value in payloads.items()},
              'provider': {'bin': str(pg), 'hashes': {name: digest((pg / name).read_bytes())
                           for name in ('postgres', 'initdb', 'pg_ctl', 'psql', 'createdb')}},
              'scope': 'synthetic diagnostic functions only; no installed/gateway/population/GTO proof'}

    def interrupt(signum, _frame):
        raise RuntimeError('interrupted_' + str(signum))

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)

    def command(label, argv, data=None, timeout=25, cleanup=False):
        selected_deadline = cleanup_deadline if cleanup else deadline
        if selected_deadline is None:
            raise RuntimeError('cleanup_deadline_not_owned')
        remaining = min(timeout, selected_deadline - time.monotonic())
        if remaining <= 0:
            raise RuntimeError('work_deadline')
        number = len(calls)
        out = evidence / f'{number:02d}-{label}.stdout'
        err = evidence / f'{number:02d}-{label}.stderr'
        receipt = {'label': label, 'tool': Path(argv[0]).name, 'returncode': None,
                   'stdout': out.name, 'stderr': err.name, 'timedOut': False}
        calls.append(receipt)

        def child_limits():
            # initdb/pg_ctl's server inherits this limit. Normal WAL segments
            # are16MiB, so the database tools require a compatible file bound.
            limit = (128 if Path(argv[0]).name in ('initdb', 'pg_ctl', 'postgres') else 8) * 1024 ** 2
            resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))

        with out.open('xb') as stdout, err.open('xb') as stderr:
            child = subprocess.Popen(argv, stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
                                     stdout=stdout, stderr=stderr, env=env,
                                     start_new_session=True, preexec_fn=child_limits)
            try:
                child.communicate(data, timeout=remaining)
            except BaseException as error:
                receipt['timedOut'] = isinstance(error, subprocess.TimeoutExpired)
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=3)
                receipt['returncode'] = child.returncode
                raise
            receipt['returncode'] = child.returncode
        if out.stat().st_size > 8 * 1024 ** 2 or err.stat().st_size > 8 * 1024 ** 2:
            raise RuntimeError('captured_log_bound_' + label)
        return child.returncode, out.read_bytes(), err.read_bytes()

    def checked(label, argv, data=None, timeout=25):
        code, out, err = command(label, argv, data, timeout)
        if code != 0:
            raise RuntimeError('command_failed_' + label)
        return out

    failure = None
    try:
        version = checked('version', [str(pg / 'postgres'), '--version'], timeout=5)
        if not version.startswith(b'postgres (PostgreSQL) 17.'):
            raise RuntimeError('postgresql17_required')
        result['provider']['version'] = version.decode().strip()
        for name, body, fixture, marker in JOBS:
            runtime = Path(tempfile.mkdtemp(prefix='hda-', dir=parent))
            cluster, socket = runtime / 'data', runtime / 'socket'
            job = {'name': name, 'status': 'incomplete', 'allocation': str(runtime),
                   'cleanup': {'confirmed': False}, 'selectedBody': body, 'fixture': fixture}
            jobs.append(job)
            initialized = False
            start_attempted = False
            original_error = None
            try:
                runtime.chmod(0o700)
                socket.mkdir(mode=0o700)
                checked(name + '-initdb', [str(pg / 'initdb'), '-D', str(cluster), '-U', 'postgres',
                        '--auth-local=trust', '--auth-host=reject', '--no-locale', '-E', 'UTF8'])
                initialized = True
                # No shell, TCP listener, shared DB, default cluster or ambient service.
                start_attempted = True
                checked(name + '-start', [str(pg / 'pg_ctl'), '-D', str(cluster), '-l', str(runtime / 'postgres.log'),
                        '-o', f"-k {socket} -p 55439 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10 -c max_parallel_workers=0 -c statement_timeout=15000 -c idle_in_transaction_session_timeout=20000",
                        '-w', '-t', '10', 'start'], timeout=15)
                checked(name + '-createdb', [str(pg / 'createdb'), '-h', str(socket), '-p', '55439',
                        '-U', 'postgres', '--no-password', 'horse_daily_fixture'])
                psql = [str(pg / 'psql'), '-X', '--no-password', '-qAt', '-v', 'ON_ERROR_STOP=1',
                        '-v', 'VERBOSITY=verbose', '-h', str(socket), '-p', '55439', '-U', 'postgres',
                        '-d', 'horse_daily_fixture', '-f', '-']
                for item in ('bootstrap', 'setup', 'schema'):
                    checked(name + '-' + item, psql, payloads[item])
                if body == 'r2':
                    # These controls exercise the real forward migration, not a
                    # duplicate body. Every query stays in this fresh fixture DB.
                    snapshot_sql = b"""SELECT jsonb_build_object(
                      'definition',pg_get_functiondef(p.oid),'owner',p.proowner,'acl',p.proacl,
                      'reviews',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY hand_id,horse_user_id),'[]'::jsonb) FROM public.horse_commitment_reviews r),
                      'gaps',(SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY hand_id),'[]'::jsonb) FROM public.horse_commitment_audit_gaps g),
                      'days',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY day),'[]'::jsonb) FROM public.horse_commitment_audit_days d))
                      FROM pg_proc p WHERE p.oid='public.fn_horse_commitment_audit_step()'::regprocedure;"""
                    if fixture == 'format85':
                        original = checked(name + '-original-snapshot', psql, snapshot_sql)
                        definition = checked(name + '-original-definition', psql,
                            b"SELECT pg_get_functiondef('public.fn_horse_commitment_audit_step()'::regprocedure);")
                        for drift, sql in (
                            ('header', b'ALTER FUNCTION public.fn_horse_commitment_audit_step() COST 123;'),
                            ('body', b"""DO $drift$
                              DECLARE source text; definition text;
                              BEGIN
                                SELECT prosrc,pg_get_functiondef(oid) INTO source,definition
                                  FROM pg_proc WHERE oid='public.fn_horse_commitment_audit_step()'::regprocedure;
                                EXECUTE replace(definition,source,source || E'\\n-- synthetic unreviewed body\\n');
                              END; $drift$;"""),
                        ):
                            checked(name + '-drift-' + drift, psql, sql)
                            changed = checked(name + '-drift-snapshot-' + drift, psql, snapshot_sql)
                            if changed == original:
                                raise RuntimeError('migration_drift_not_created_' + drift)
                            code, _, err = command(name + '-refuse-' + drift, psql, payloads['r2'])
                            if code != 3 or b'ERROR:  P0001: horse_commitment_audit_preimage_changed' not in err:
                                raise RuntimeError('migration_drift_not_refused_' + drift)
                            if checked(name + '-refused-snapshot-' + drift, psql, snapshot_sql) != changed:
                                raise RuntimeError('migration_refusal_changed_state_' + drift)
                            # Restore only the captured fixture definition; no
                            # historical migration or application data is replayed.
                            checked(name + '-restore-original-' + drift, psql, definition)
                            if checked(name + '-restored-snapshot-' + drift, psql, snapshot_sql) != original:
                                raise RuntimeError('fixture_original_restore_mismatch_' + drift)
                        job['migrationRefusals'] = ['header_cost_123', 'unreviewed_body']
                    checked(name + '-r2', psql, payloads['r2'])
                    first = checked(name + '-installed-snapshot', psql, snapshot_sql)
                    checked(name + '-r2-repeat', psql, payloads['r2'])
                    if checked(name + '-repeated-snapshot', psql, snapshot_sql) != first:
                        raise RuntimeError('migration_repeat_changed_state')
                    job['migrationRepeatUnchanged'] = True
                elif body == 'reader':
                    checked(name + '-auth', psql, payloads['reader_auth'])
                    checked(name + '-reader', psql, payloads['reader'])
                    # The new door requires absence. A repeat must refuse and
                    # leave its exact definition, owner, ACL and private rows intact.
                    reader_snapshot_sql = b"""SELECT jsonb_build_object(
                      'definition',pg_get_functiondef(p.oid),'owner',p.proowner,'acl',p.proacl,
                      'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,
                        'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,
                        'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'acl',a.attacl) ORDER BY a.attnum)
                          FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)) ORDER BY c.relname)
                        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                        WHERE n.nspname='public' AND c.relname IN ('horse_commitment_reviews','horse_commitment_audit_gaps','horse_commitment_audit_days')),
                      'reviews',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY hand_id,horse_user_id),'[]'::jsonb) FROM public.horse_commitment_reviews r),
                      'gaps',(SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY hand_id),'[]'::jsonb) FROM public.horse_commitment_audit_gaps g),
                      'days',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY day),'[]'::jsonb) FROM public.horse_commitment_audit_days d))
                      FROM pg_proc p WHERE p.oid='public.fn_horse_commitment_review_page(date,timestamptz,uuid,uuid,integer)'::regprocedure;"""
                    reader_before = checked(name + '-installed-snapshot', psql, reader_snapshot_sql)
                    code, _, err = command(name + '-reader-repeat', psql, payloads['reader'])
                    if code != 3 or b'ERROR:  P0001: horse_daily_reader_already_exists' not in err:
                        raise RuntimeError('reader_existing_target_not_refused')
                    if checked(name + '-repeat-refused-snapshot', psql, reader_snapshot_sql) != reader_before:
                        raise RuntimeError('reader_repeat_refusal_changed_state')
                    job['migrationRepeatRefusedUnchanged'] = True
                else:
                    checked(name + '-' + body, psql, payloads[body])
                result['executed'] = True
                fixture_sql = payloads[fixture]
                if fixture == 'reader27':
                    # The retained fixture is byte-exact and owns BEGIN/ROLLBACK.
                    # This completion marker executes only after its final rollback.
                    fixture_sql += b"\nSELECT 'synthetic_reader_controls_only_if_executed',27;\n"
                code, out, err = command(name + '-fixture', psql, fixture_sql, timeout=30)
                job['fixtureReturncode'] = code
                if fixture == 'reader27':
                    # psql exits/closes on failure too. Observe from a new session
                    # that the original private rows and function remain unchanged.
                    job['fixtureRollbackUnchanged'] = checked(
                        name + '-post-fixture-snapshot', psql, reader_snapshot_sql) == reader_before
                    if not job['fixtureRollbackUnchanged']:
                        raise RuntimeError('reader_fixture_rollback_changed_state')
                if marker is None:
                    expected = b'ERROR:  P0001: roster_review_count: mixed_case_duplicate'
                    if code != 3 or expected not in err or b'synthetic_roster_controls_only_if_executed|24' in out:
                        raise RuntimeError('expected_original_duplicate_failure_not_observed')
                    job['status'] = 'expected_original_failure_observed'
                    job['observedDiagnostic'] = expected.decode()
                    job['all24Reached'] = False
                else:
                    if code != 0 or marker not in out or b'ERROR:' in err:
                        raise RuntimeError('candidate_fixture_not_complete_' + name)
                    job['status'] = 'candidate_fixture_passed'
                    if fixture == 'reader27':
                        job['syntheticReaderRows'] = 27
                    else:
                        job['caseRows'] = 85 if fixture == 'format85' else 24
            except BaseException as error:
                original_error = type(error).__name__ + ': ' + str(error)
                job['failure'] = original_error
            finally:
                cleanup_deadline = min(time.monotonic() + 45, deadline + 45)
                # A failed start can still have launched postgres. Inspect the exact
                # owned cluster even when pg_ctl start failed; never remove live data.
                try:
                    status = None
                    if initialized or start_attempted or (cluster / 'postmaster.pid').exists():
                        status, _, _ = command(name + '-status-before-stop',
                            [str(pg / 'pg_ctl'), '-D', str(cluster), 'status'], timeout=5, cleanup=True)
                        if status == 0:
                            stopped, _, _ = command(name + '-stop',
                                [str(pg / 'pg_ctl'), '-D', str(cluster), '-m', 'fast', '-w', '-t', '10', 'stop'],
                                timeout=12, cleanup=True)
                            job['cleanup']['stopReturncode'] = stopped
                            if stopped != 0:
                                raise RuntimeError('shutdown_failed_no_delete')
                        elif status != 3:
                            raise RuntimeError('cluster_status_unconfirmed_no_delete')
                        status, _, _ = command(name + '-status-after-stop',
                            [str(pg / 'pg_ctl'), '-D', str(cluster), 'status'], timeout=5, cleanup=True)
                        if status != 3:
                            raise RuntimeError('cluster_still_running_no_delete')
                    if (cluster / 'postmaster.pid').exists() or (socket.exists() and list(socket.iterdir())):
                        raise RuntimeError('pid_or_socket_remains_no_delete')
                    if time.monotonic() >= cleanup_deadline:
                        raise RuntimeError('cleanup_deadline_before_removal')
                    log = runtime / 'postgres.log'
                    if log.exists():
                        if log.stat().st_size > 8 * 1024 ** 2:
                            raise RuntimeError('postgres_log_bound_no_delete')
                        shutil.copyfile(log, evidence / (name + '-postgres.log'))
                    shutil.rmtree(runtime)
                    job['cleanup'].update({'confirmed': not runtime.exists(), 'pgCtlStatus': status,
                                           'pidAbsent': True, 'socketEmpty': True})
                except BaseException as error:
                    job['cleanup']['failure'] = type(error).__name__ + ': ' + str(error)
                if original_error or not job['cleanup']['confirmed']:
                    raise RuntimeError(original_error or 'cleanup_unconfirmed')
        result['status'] = 'qualified_synthetic_daily_function'
    except BaseException as error:
        failure = type(error).__name__ + ': ' + str(error)
        result['failure'] = failure
    finally:
        result['elapsedSeconds'] = round(time.monotonic() - started_at, 3)
        result['allOwnedAllocationsRemoved'] = bool(jobs) and all(j['cleanup']['confirmed'] for j in jobs)
        (evidence / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    # Keep the actual failure in the existing CI job log even if that runner
    # removes its workspace. Detailed local files remain the original evidence;
    # no additional cloud artifact storage or cleanup job is required.
    print(json.dumps(result, sort_keys=True))
    if failure:
        for receipt in calls:
            if receipt['returncode'] == 0 and not receipt['timedOut']:
                continue
            print('Horse diagnostic command: ' + receipt['label'], file=sys.stderr)
            for stream in ('stdout', 'stderr'):
                path = evidence / receipt[stream]
                if path.is_file():
                    with path.open('rb') as handle:
                        size = path.stat().st_size
                        handle.seek(max(0, size - 65536))
                        tail = handle.read(65536).decode('utf-8', errors='replace')
                    print(stream + ' (last65536 bytes):\n' + tail, file=sys.stderr)
    return 1 if failure else 0


if __name__ == '__main__':
    raise SystemExit(main())
