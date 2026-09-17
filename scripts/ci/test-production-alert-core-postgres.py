#!/usr/bin/env python3
"""Qualify composed alert identity/wording with authentic owner routing in PG17.

Uses maintained static SQL and the actual checkout component/qualifier. No
production credentials, outbound sender, external provider or runner service.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path('scripts/ci/probes/production-alert-core/notification')
LEAVES = (
    'inputs/schema.sql', 'principals.sql', 'inputs/access.sql',
    'inputs/policies.sql', 'provider-supplement.sql', 'provider-roles.sql',
    'provider-roles-check.sql', 'provider-check.sql', 'empty-provider-check.sql',
    'readback.sql', 'inputs/owner-notification-catalog-postimage.sql',
    'inputs/linked-invoice-positive.sql', 'inputs/captured-financial-store-policy.sql',
)
CHECKOUT_INPUTS = {'component': 'scripts/ci/probes/production-alert-core/inputs/owner-notification-component.sql', 'qualifier': 'scripts/ci/probes/production-alert-core/inputs/owner-notification-qualification.sql', 'core_supplement': 'scripts/ci/probes/production-alert-core/core-catalog-supplement.sql', 'core_component': 'supabase/components/production-alert-identity-and-rake-wording.sql', 'core_rollback': 'supabase/components/production-alert-identity-and-rake-wording.rollback.sql', 'core_identity': 'scripts/qualification/production-alert-core-identity.sql', 'core_connected': 'scripts/qualification/production-alert-core-connected.sql', 'core_readback': 'scripts/ci/probes/production-alert-core/readback.sql', 'core_received_reconcile': 'scripts/ci/probes/production-alert-core/inputs/received-reconcile.sql', 'cash_connected': 'scripts/qualification/cash-pot-check-connected.sql', 'cash_preimage': 'scripts/ci/probes/production-alert-core/cash-checker-preimage.sql', 'cash_component': 'supabase/components/cash-pot-check-evidence.sql', 'cash_rollback': 'supabase/components/cash-pot-check-evidence.rollback.sql'}

CHECKOUT_INPUTS.update({
    'direct_component': 'supabase/components/direct-operational-source-intake.sql',
    'direct_rollback': 'supabase/components/direct-operational-source-intake.rollback.sql',
    'direct_authority': 'supabase/components/direct-operational-source-intake.authority.sql',
    'direct_functions': 'supabase/components/direct-operational-source-intake.functions.sql',
    'direct_postimage': 'supabase/components/direct-operational-source-intake.postimage.sql',
    'direct_qualifier': 'scripts/qualification/direct-operational-source-intake.sql',
    'direct_engine_catalog': 'scripts/qualification/fixtures/direct-operational-source-intake/engine-catalog.sql',
    'direct_prepare': 'scripts/qualification/fixtures/direct-operational-source-intake/prepare.sql',
    'direct_readback': 'scripts/qualification/fixtures/direct-operational-source-intake/readback.sql',
    'direct_source_capture': 'scripts/qualification/fixtures/direct-operational-source-intake/authority.json',
    'direct_engine_preimage': 'scripts/qualification/fixtures/direct-operational-source-intake/engine-preimage.sql',
    'direct_race': 'scripts/qualification/fixtures/direct-operational-source-intake/race.sql',
    'direct_financial_race': 'scripts/qualification/fixtures/direct-operational-source-intake/financial-race.sql',
    'direct_state': 'scripts/qualification/fixtures/direct-operational-source-intake/state.sql',
    'direct_retained': 'scripts/qualification/fixtures/direct-operational-source-intake/retained.sql',
    'legacy_envelope_component': 'supabase/components/direct-operational-source-legacy-envelope.sql',
    'legacy_envelope_rollback': 'supabase/components/direct-operational-source-legacy-envelope.rollback.sql',
    'legacy_envelope_qualifier': 'scripts/qualification/direct-operational-source-legacy-envelope.sql',
})

MARKER = b'CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();'


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def check_blob(name, data, pin):
    require(type(pin.get('bytes')) is int and len(data) == pin['bytes']
            and digest(data) == pin.get('sha256'), 'source pin mismatch: ' + name)


def check_sequence(row):
    expected = {'start': '1', 'increment': '1', 'minimum': '1',
                'maximum': '9223372036854775807', 'cache': '1'}
    require(row.get('type') == 'bigint' and row.get('cycle') is False,
            'sequence type/cycle drift')
    for key, value in expected.items():
        require(type(row.get(key)) is str and row[key] == value,
                'sequence bound must remain exact decimal text: ' + key)
    return ('START WITH ' + row['start'] + ' INCREMENT BY ' + row['increment']
            + ' MINVALUE ' + row['minimum'] + ' MAXVALUE ' + row['maximum']
            + ' CACHE ' + row['cache'] + ' NO CYCLE')


def split_schema(schema):
    require(schema.count(MARKER) == 1, 'authentic first-trigger boundary ambiguous')
    prefix, suffix = schema.split(MARKER)
    suffix = MARKER + suffix
    require(b'CREATE TRIGGER ' not in prefix and b'CREATE CONSTRAINT TRIGGER ' not in prefix
            and prefix + suffix == schema, 'trigger boundary/reassembly drift')
    return prefix, suffix


def command_budget(deadline, now, requested):
    require(deadline is not None, 'original deadline absent')
    budget = min(requested, deadline - now - 3)
    if budget <= 0:
        raise TimeoutError('original work/cleanup deadline exhausted')
    return budget


def qualifies(receipt):
    return (receipt.get('sql_slice_passed') is True
            and receipt.get('terminal_observed') is True
            and receipt.get('source_stable') is True
            and not receipt.get('failure') and not receipt.get('cleanup_errors'))


def exact_blocker(observed, holder, waiter):
    return (type(holder) is int and type(waiter) is int and holder > 0 and waiter > 0
            and holder != waiter and observed.get('holder') == holder
            and observed.get('waiter') == waiter and observed.get('blockers') == [holder]
            and observed.get('holder_state') == 'idle in transaction'
            and observed.get('waiter_state') == 'active' and observed.get('wait_type') == 'Lock')


def race_exit(case, holder_exit, waiter_exit, stderr):
    require(case in ('finite_first', 'capture_first', 'reversed_batch', 'financial_first'), 'unknown race case')
    require(holder_exit == 0, 'race holder did not commit/exit successfully')
    if case == 'finite_first':
        require(waiter_exit == 3 and re.search(r'ERROR:\s+P0001:\s+operational source exact receipt collision\n', stderr),
                'racing legacy winner must refuse this strict engine ACK with its exact error')
    else:
        require(waiter_exit == 0, 'race waiter failed its actual operation/commit')


def record_interruption(receipt, signum, *, during_cleanup):
    # Preserve cancellation as a failure without interrupting the owned stop.
    receipt['passed'] = False
    if not receipt.get('failure'):
        receipt['failure'] = {'type': 'Interrupted',
                              'message': 'qualification interrupted by signal ' + str(signum)}
    if not during_cleanup:
        raise RuntimeError('qualification interrupted by signal ' + str(signum))


def pinned_sources(root, manifest):
    expected = {str(FIXTURE / leaf) for leaf in LEAVES}
    require(manifest.get('schemaVersion') == 1
            and set(manifest.get('fixtureFiles', {})) == expected,
            'fixed fixture manifest set/version drift')
    bindings = manifest.get('checkoutInputs', {})
    require(set(bindings) == set(CHECKOUT_INPUTS), 'checkout binding set drift')
    pins = dict(manifest['fixtureFiles'])
    for label, path in CHECKOUT_INPUTS.items():
        require(bindings[label].get('path') == path, 'checkout binding path drift: ' + label)
        pins[path] = bindings[label]
    sources = {}
    for name, pin in pins.items():
        path = root / name
        require(path.is_file() and path.resolve() == path
                and not path.is_symlink(), 'nonregular or redirected input: ' + name)
        data = path.read_bytes()
        check_blob(name, data, pin)
        sources[name] = data
    return sources


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path,
                        default=ROOT / 'artifacts/production-alert-core')
    args = parser.parse_args()
    require(sys.platform == 'linux' and os.geteuid() != 0,
            'existing nonroot Linux PG17 job required')
    pg = Path(os.environ.get('PG_BIN', ''))
    require(pg.is_absolute() and all(os.access(pg / name, os.X_OK)
            for name in ('postgres', 'psql', 'initdb', 'pg_ctl', 'createdb')),
            'PG_BIN must identify the existing resolved PG17 binaries')
    manifest_path = ROOT / FIXTURE / 'manifest.json'
    require(manifest_path.is_file() and manifest_path.resolve() == manifest_path,
            'regular maintained fixture manifest required')
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    sources = pinned_sources(ROOT, manifest)
    sequence_clause = check_sequence(manifest['sequenceContract'])
    require(sources[str(FIXTURE / 'provider-supplement.sql')].decode().count(sequence_clause) == 1,
            'exact sequence authority and supplement disagree')
    prefix, suffix = split_schema(sources[str(FIXTURE / 'inputs/schema.sql')])
    adapter_bytes = Path(__file__).read_bytes()
    out = args.output.resolve()
    require(out.is_relative_to(ROOT / 'artifacts'), 'output must stay inside checkout artifacts')
    out.mkdir(parents=True, exist_ok=False)
    work = Path(tempfile.mkdtemp(prefix='owner-notify-', dir='/tmp'))
    work.chmod(0o700)
    (work / 'home').mkdir(mode=0o700)
    (work / 'socket').mkdir(mode=0o700)
    (work / 'schema-prefix.sql').write_bytes(prefix)
    (work / 'schema-suffix.sql').write_bytes(suffix)
    execution = str(uuid.uuid4())
    ordinary = str(uuid.uuid4())
    db = 'qual_owner_notify_' + execution.replace('-', '')
    data = work / 'data'
    socket = work / 'socket'
    deadline = time.monotonic() + 240
    cleanup_deadline = None
    # Intentionally do not inherit PG, application/provider credentials, HOME or shell configuration.
    env = {'PATH': str(pg) + ':/usr/bin:/bin', 'HOME': str(work / 'home'),
           'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'PGCONNECT_TIMEOUT': '3',
           'PGAPPNAME': 'owner-notify-' + execution}
    receipt = {
        'execution': execution, 'scope': manifest['scope'], 'stages': [],
        'sql_slice_passed': False, 'connected_services_qualified': False,
        'production_touched': False, 'terminal_observed': False,
        'source_stable': False, 'cleanup_errors': [], 'passed': False, 'failure': None,
        'manifest_sha256': digest(manifest_bytes), 'adapter_sha256': digest(adapter_bytes),
        'input_sha256': {name: digest(value) for name, value in sources.items()},
    }

    def persist():
        temp = out / 'RESULTS.tmp'
        with temp.open('w') as handle:
            json.dump(receipt, handle, indent=2)
            handle.write('\n'); handle.flush(); os.fsync(handle.fileno())
        os.replace(temp, out / 'RESULTS.json')

    def command(stage, argv, timeout=30, cleanup=False, allow=(0,)):
        active_deadline = cleanup_deadline if cleanup else deadline
        budget = command_budget(active_deadline, time.monotonic(), timeout)
        entry = {'stage': stage, 'started_monotonic': time.monotonic()}
        receipt['stages'].append(entry); persist()
        stdout, stderr = out / (stage + '.stdout'), out / (stage + '.stderr')
        with stdout.open('wb') as output, stderr.open('wb') as errors:
            child = subprocess.Popen([str(a) for a in argv], stdout=output, stderr=errors,
                                     env=env, start_new_session=True)
            try:
                child.wait(timeout=budget)
            except BaseException:
                entry['interrupted_or_timed_out'] = True
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait(timeout=max(0.001, min(3, active_deadline - time.monotonic())))
                entry['returncode'] = child.returncode; persist()
                raise
        entry['returncode'] = child.returncode
        entry['stdout_sha256'] = digest(stdout.read_bytes())
        entry['stderr_sha256'] = digest(stderr.read_bytes())
        persist()
        require(child.returncode in allow, 'stage failed: ' + stage)
        return stdout.read_text()

    variables = ['-v', 'execution_uuid=' + execution, '-v', 'ordinary_user_uuid=' + ordinary,
                 '-v', 'legacy_operational_uuid=' + str(uuid.uuid5(uuid.UUID(execution), 'legacy-operational')),
                 '-v', 'legacy_personal_uuid=' + str(uuid.uuid5(uuid.UUID(execution), 'legacy-personal'))]

    def sql(stage, path, user='fixture_bootstrap', phase=None, extra=()):
        argv = [pg / 'psql', '-X', '-w', '-A', '-t', '-h', socket, '-p', '55432',
                '-U', user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'] + variables
        if phase:
            argv += ['-v', 'phase=' + phase]
        return command(stage, argv + list(extra) + ['-f', path], timeout=70)

    def direct_race(case, index):
        """One finite real two-session schedule in this already-owned cluster."""
        stage = 'direct_source_race_' + case
        path = ROOT / CHECKOUT_INPUTS['direct_financial_race' if case == 'financial_first' else 'direct_race']
        local_deadline = time.monotonic() + command_budget(deadline, time.monotonic(), 12)
        clients = []
        entry = {'stage': stage, 'clients': [], 'blocked_observation': None}
        receipt['stages'].append(entry); persist()

        def launch(side):
            require(time.monotonic() < local_deadline, 'original race work deadline exhausted before launch')
            output = out / (stage + '_' + side + '.stdout')
            errors = out / (stage + '_' + side + '.stderr')
            handles = [output.open('wb'), errors.open('wb')]
            application = 'direct-' + execution.replace('-', '') + '-' + str(index) + '-' + side
            argv = [str(pg / 'psql'), '-X', '-w', '-A', '-t', '-h', str(socket), '-p', '55432',
                    '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose']
            argv += variables + ['-v', 'race_case=' + case, '-v', 'race_side=' + side,
                                 '-v', 'race_application=' + application, '-f', str(path)]
            if side == 'holder':
                argv += ['-f', '-']
            try:
                process = subprocess.Popen(argv, stdin=subprocess.PIPE if side == 'holder' else subprocess.DEVNULL,
                                           stdout=handles[0], stderr=handles[1], env=env, start_new_session=True)
            except BaseException:
                for handle in handles:
                    handle.close()
                raise
            detail = {'side': side, 'pid': process.pid, 'application_name': application}
            clients.append((process, handles, output, errors, detail))
            entry['clients'].append(detail); persist()
            return clients[-1]

        def marker(client, ready=False):
            process, _, output, _, _ = client
            text = output.read_text()
            require(len(text) < 65536, 'unexpected race transcript size')
            matches = re.findall(r'^DIRECT_BACKEND:([0-9]+)$', text, re.M)
            require(len(matches) <= 1, 'ambiguous race backend identity')
            if matches and (not ready or 'DIRECT_HOLDER_READY\n' in text):
                return int(matches[0])
            require(process.poll() is None, 'race client exited before its required marker')
            return None

        try:
            holder = launch('holder')
            holder_pid = None
            while holder_pid is None:
                require(time.monotonic() < local_deadline, 'race holder readiness deadline')
                holder_pid = marker(holder, ready=True)
                if holder_pid is None:
                    time.sleep(0.02)
            waiter = launch('waiter')
            waiter_pid = None
            # The real lock timeout remains 3s. Observe and release within 2s;
            # missing proof is failure, not an invented race or a timeout pass.
            overlap_deadline = min(local_deadline, time.monotonic() + 2)
            observation_number = 0
            while entry['blocked_observation'] is None:
                require(time.monotonic() < overlap_deadline, 'exact separate-session overlap not observed')
                waiter_pid = marker(waiter)
                if waiter_pid is not None:
                    observation_number += 1
                    query = ("SELECT json_build_object('holder',h.pid,'waiter',w.pid,"
                             "'holder_state',h.state,'waiter_state',w.state,'wait_type',w.wait_event_type,"
                             "'blockers',pg_blocking_pids(w.pid)) FROM pg_stat_activity h CROSS JOIN pg_stat_activity w "
                             "WHERE h.pid=" + str(holder_pid) + " AND w.pid=" + str(waiter_pid))
                    observed_text = command(stage + '_overlap_' + str(observation_number),
                        [pg / 'psql', '-X', '-w', '-A', '-t', '-h', socket, '-p', '55432', '-U', 'postgres',
                         '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', query], timeout=min(1, max(0.001, overlap_deadline-time.monotonic())))
                    observed = json.loads(observed_text) if observed_text.strip() else {}
                    if exact_blocker(observed, holder_pid, waiter_pid):
                        require(holder[0].poll() is None and waiter[0].poll() is None,
                                'race process became terminal before overlap evidence')
                        entry['blocked_observation'] = observed; persist()
                        break
                time.sleep(0.02)
            holder[0].stdin.write(b'COMMIT;\n\\q\n'); holder[0].stdin.flush(); holder[0].stdin.close()
            for client in (holder, waiter):
                client[0].wait(timeout=max(0.001, local_deadline-time.monotonic()))
            race_exit(case, holder[0].returncode, waiter[0].returncode, waiter[3].read_text())
            entry['schedule_passed'] = True
        finally:
            # Client exit is not backend retirement. The same independently
            # checked pg_ctl allocation shutdown remains mandatory below.
            for process, handles, output, errors, detail in clients:
                try:
                    if process.poll() is None:
                        detail['forced_termination'] = True
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        process.wait(timeout=command_budget(deadline, time.monotonic(), 3))
                    detail['returncode'] = process.returncode
                    if process.stdin is not None and not process.stdin.closed:
                        process.stdin.close()
                except BaseException as error:
                    receipt['cleanup_errors'].append(stage + ' original client: ' + str(error))
                finally:
                    for handle in handles:
                        handle.close()
                    detail['stdout_sha256'] = digest(output.read_bytes())
                    detail['stderr_sha256'] = digest(errors.read_bytes())
            persist()
        sql(stage + '_readback', path, user='postgres', extra=(
            '-v', 'race_case=' + case, '-v', 'race_side=verify', '-v', 'race_application=' + stage))

    cleanup_started = False

    def interrupted(signum, frame):
        record_interruption(receipt, signum, during_cleanup=cleanup_started)

    original_handlers = {s: signal.signal(s, interrupted) for s in (signal.SIGINT, signal.SIGTERM)}
    pg_attempted = False
    try:
        persist()
        receipt['checkout_head'] = command('checkout_head', ['/usr/bin/git', '-C', ROOT, 'rev-parse', 'HEAD'], timeout=3).strip()
        require(re.fullmatch(r'[0-9a-f]{40}', receipt['checkout_head']), 'actual checkout identity unavailable')
        version = command('pg_version', [pg / 'postgres', '--version'], timeout=3)
        require(re.fullmatch(r'postgres \(PostgreSQL\) 17(?:\.[0-9]+)?[^\n]*\n?', version), 'PG17 required')
        command('initdb', [pg / 'initdb', '-D', data, '-U', 'fixture_bootstrap',
                          '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
        with (data / 'postgresql.conf').open('a') as handle:
            handle.write("\nlisten_addresses=''\nport=55432\nunix_socket_directories='" + str(socket)
                         + "'\nunix_socket_permissions=0700\nshared_buffers='32MB'\nwork_mem='4MB'"
                         + "\nmaintenance_work_mem='64MB'\nmax_connections=8\nmax_worker_processes=0"
                         + "\nmax_parallel_workers=0\nmax_wal_senders=0\nwal_level=logical"
                         + "\nstatement_timeout='20s'\nlock_timeout='3s'\nidle_in_transaction_session_timeout='20s'\n")
        pg_attempted = True
        command('pg_start', [pg / 'pg_ctl', '-D', data, '-l', out / 'postgres.log', '-w', '-t', '12', 'start'], timeout=15)
        bootstrap = [pg / 'psql', '-X', '-w', '-h', socket, '-p', '55432', '-U', 'fixture_bootstrap',
                     '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
        command('create_sql_owner', bootstrap + ['-c', 'CREATE ROLE postgres NOSUPERUSER INHERIT LOGIN CREATEDB CREATEROLE REPLICATION BYPASSRLS'], timeout=5)
        command('create_database', [pg / 'createdb', '-h', socket, '-p', '55432', '-U', 'fixture_bootstrap', '-O', 'postgres', db], timeout=5)
        sql('schema_prefix', work / 'schema-prefix.sql')
        sql('restore_preexisting_principals', ROOT / FIXTURE / 'principals.sql')
        sql('schema_suffix_all_real_triggers', work / 'schema-suffix.sql')
        for stage, leaf in (
            ('authentic_access', 'inputs/access.sql'), ('authentic_policies', 'inputs/policies.sql'),
            ('current_notification_supplement', 'provider-supplement.sql'),
            ('current_tested_roles', 'provider-roles.sql'), ('tested_role_readback', 'provider-roles-check.sql'),
            ('current_catalog_readback', 'provider-check.sql'), ('empty_provider_readback', 'empty-provider-check.sql'),
        ):
            sql(stage, ROOT / FIXTURE / leaf)
        sql('prepare', ROOT / CHECKOUT_INPUTS['qualifier'], user='postgres', phase='prepare')
        before = sql('committed_prepare_observer', ROOT / FIXTURE / 'readback.sql', user='postgres')
        sql('candidate', ROOT / CHECKOUT_INPUTS['component'], user='postgres')
        sql('candidate_catalog_postimage', ROOT / FIXTURE / 'inputs/owner-notification-catalog-postimage.sql', user='postgres')
        sql('verify', ROOT / CHECKOUT_INPUTS['qualifier'], user='postgres', phase='verify')
        after = sql('committed_verify_observer', ROOT / FIXTURE / 'readback.sql', user='postgres')
        require(before == after, 'committed original notification/inbox state changed during rollback-scoped verification')
        sql('core_catalog_supplement', ROOT / CHECKOUT_INPUTS['core_supplement'])
        sql('core_original_identity_matrix', ROOT / CHECKOUT_INPUTS['core_identity'], user='postgres')
        sql('core_identity_rollback_readback', ROOT / CHECKOUT_INPUTS['core_readback'], user='postgres')
        sql('core_actual_connected_chain', ROOT / CHECKOUT_INPUTS['core_connected'], user='postgres')
        sql('core_connected_rollback_readback', ROOT / CHECKOUT_INPUTS['core_readback'], user='postgres')
        sql('cash_actual_connected_chain', ROOT / CHECKOUT_INPUTS['cash_connected'], user='postgres')
        sql('cash_connected_rollback_readback', ROOT / CHECKOUT_INPUTS['core_readback'], user='postgres')
        # Extend the same actual component check; no new job, provider or sender.
        sql('direct_source_engine_catalog', ROOT / CHECKOUT_INPUTS['direct_engine_catalog'])
        sql('direct_source_old_receipt_prepare', ROOT / CHECKOUT_INPUTS['direct_prepare'], user='postgres')
        sql('direct_source_current_bridge', ROOT / CHECKOUT_INPUTS['core_component'], user='postgres')
        sql('direct_source_install', ROOT / CHECKOUT_INPUTS['direct_component'], user='postgres')
        direct_before = sql('direct_source_before_cases', ROOT / CHECKOUT_INPUTS['direct_state'], user='postgres')
        sql('direct_source_native_cases', ROOT / CHECKOUT_INPUTS['direct_qualifier'], user='postgres')
        diagnostic = (out / 'direct_source_native_cases.stderr').read_text()
        require('operational source capture failed kind=financial id=ea100000-0000-4000-8000-000000000004'
                in diagnostic and 'SQLSTATE=23514' in diagnostic,
                'real local-storage failure diagnostic was not observed')
        require(direct_before == sql('direct_source_after_cases', ROOT / CHECKOUT_INPUTS['direct_state'], user='postgres'),
                'rollback-scoped cases changed any committed selected source/evidence row')
        sql('direct_source_legacy_import_cases', ROOT / CHECKOUT_INPUTS['legacy_envelope_qualifier'], user='postgres')
        require(direct_before == sql('direct_source_after_legacy_import', ROOT / CHECKOUT_INPUTS['direct_state'], user='postgres'),
                'legacy envelope qualification changed committed source or evidence rows')
        final_originals = sql('core_original_notifications_readback', ROOT / FIXTURE / 'readback.sql', user='postgres')
        require(after == final_originals, 'core qualification changed committed original notification/inbox state')
        # Subsequent cases intentionally commit source evidence in this disposable
        # allocation. No deleted test rows or empty-store rollback substitute.
        for index, case in enumerate(('finite_first', 'capture_first', 'reversed_batch', 'financial_first')):
            direct_race(case, index)
        sql('direct_source_commit_retained_evidence', ROOT / CHECKOUT_INPUTS['direct_retained'], user='postgres')
        retained_before = sql('direct_source_before_retaining_rollback', ROOT / CHECKOUT_INPUTS['direct_state'], user='postgres')
        sql('direct_source_retaining_rollback', ROOT / CHECKOUT_INPUTS['direct_rollback'], user='postgres')
        sql('direct_source_restore_bridge', ROOT / CHECKOUT_INPUTS['core_rollback'], user='postgres')
        sql('direct_source_readback', ROOT / CHECKOUT_INPUTS['direct_readback'], user='postgres')
        require(retained_before == sql('direct_source_after_retaining_rollback', ROOT / CHECKOUT_INPUTS['direct_state'], user='postgres'),
                'component rollback changed committed source, snapshot, pending, receipt or inbox evidence')
        # This positive commits invoice notifications and pushes. Run it only after
        # every rollback-scoped check has verified the untouched original rows.
        sql('linked_invoice_positive', ROOT / FIXTURE / 'inputs/linked-invoice-positive.sql', user='postgres')
        receipt['sql_slice_passed'] = True
    except BaseException as error:
        receipt['failure'] = {'type': type(error).__name__, 'message': str(error)}
    finally:
        cleanup_started = True
        cleanup_deadline = time.monotonic() + 30
        try:
            if pg_attempted:
                pidfile = data / 'postmaster.pid'
                original_pid = int(pidfile.read_text().splitlines()[0]) if pidfile.exists() else None
                try:
                    command('pg_stop_fast', [pg / 'pg_ctl', '-D', data, '-w', '-t', '10', '-m', 'fast', 'stop'], timeout=12, cleanup=True)
                except BaseException as first:
                    receipt['cleanup_errors'].append('original fast-stop failure: ' + str(first))
                    command('pg_stop_immediate', [pg / 'pg_ctl', '-D', data, '-w', '-t', '8', '-m', 'immediate', 'stop'], timeout=10, cleanup=True)
                command('pg_stopped_readback', [pg / 'pg_ctl', '-D', data, 'status'], timeout=3, cleanup=True, allow=(3,))
                require(not pidfile.exists()
                        and not (original_pid is not None and Path('/proc', str(original_pid)).exists())
                        and not (socket / '.s.PGSQL.55432').exists(),
                        'owned PostgreSQL process/socket absence not proved')
            receipt['terminal_observed'] = True
        except BaseException as error:
            receipt['cleanup_errors'].append(str(error))
        try:
            receipt['source_stable'] = (
                manifest_path.read_bytes() == manifest_bytes
                and Path(__file__).read_bytes() == adapter_bytes
                and pinned_sources(ROOT, manifest) == sources)
        except BaseException as error:
            receipt['source_readback_error'] = str(error)
        if receipt['terminal_observed']:
            try:
                shutil.rmtree(work)
                receipt['owned_cluster_removed'] = not work.exists()
            except BaseException as error:
                receipt['cleanup_errors'].append('scratch cleanup: ' + str(error))
        else:
            receipt['retained_owned_cluster_path'] = str(work)
        receipt['passed'] = qualifies(receipt)
        persist()
        for signum, handler in original_handlers.items():
            signal.signal(signum, handler)
    print(json.dumps({'passed': receipt['passed'], 'stages': len(receipt['stages']), 'evidence': str(out)}))
    return 0 if receipt['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
