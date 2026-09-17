#!/usr/bin/env python3
"""Qualify exact Class4 completed-hand resolver and real PG17 concurrency.

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
from build_pg17_isolationtester import VERSION, VERSION_NUM, OUTPUT as TOOL_ROOT, TOOL_LEAF, SOURCE_SHA256, validate_version

FIXTURE = Path('scripts/ci/probes/production-alert-core/notification')
CLASS4 = Path('scripts/ci/probes/class4-hand-outcome')
TOOL = TOOL_ROOT / TOOL_LEAF
LEAVES = (
    'inputs/schema.sql', 'principals.sql', 'inputs/access.sql',
    'inputs/policies.sql', 'provider-supplement.sql', 'provider-roles.sql',
    'provider-roles-check.sql', 'provider-check.sql', 'empty-provider-check.sql',
    'readback.sql', 'inputs/owner-notification-catalog-postimage.sql',
    'inputs/linked-invoice-positive.sql', 'inputs/captured-financial-store-policy.sql',
)
CHECKOUT_INPUTS = {'isolation_builder': 'scripts/ci/build_pg17_isolationtester.py', 'core_supplement': 'scripts/ci/probes/production-alert-core/core-catalog-supplement.sql', 'core_component': 'supabase/components/production-alert-identity-and-rake-wording.sql', 'core_rollback': 'supabase/components/production-alert-identity-and-rake-wording.rollback.sql', 'catalog_supplement': 'scripts/ci/probes/class4-hand-outcome/catalog-supplement.sql', 'captured_functions': 'scripts/ci/probes/class4-hand-outcome/captured-functions.json', 'readback': 'scripts/ci/probes/class4-hand-outcome/readback.sql', 'class4_component': 'supabase/components/class4-hand-outcome-evidence.sql', 'class4_rollback': 'supabase/components/class4-hand-outcome-evidence.rollback.sql', 'class4_primary': 'scripts/qualification/class4-hand-outcome-evidence.sql', 'class4_drift': 'scripts/qualification/class4-hand-outcome-evidence.drift.sql', 'class4_concurrency': 'scripts/qualification/class4-hand-outcome-evidence.concurrency.spec', 'class4_preimage': 'scripts/qualification/fixtures/class4-hand-outcome-evidence.preimage.sql', 'class4_candidate': 'scripts/qualification/fixtures/class4-hand-outcome-evidence.candidate.sql', 'class4_originals': 'scripts/qualification/fixtures/class4-hand-outcome-evidence.originals.sql'}

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
            and receipt.get('concurrency_passed') is True
            and receipt.get('terminal_observed') is True
            and receipt.get('source_stable') is True
            and not receipt.get('failure') and not receipt.get('cleanup_errors'))


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



def validate_tool_receipt(receipt, pg):
    require(receipt.get('passed') is True and receipt.get('version') == VERSION
            and receipt.get('sourceSha256') == SOURCE_SHA256,
            'successful official17.11 build receipt required')
    require(receipt.get('tool', {}).get('path') == str(TOOL)
            and TOOL.is_file() and not TOOL.is_symlink()
            and digest(TOOL.read_bytes()) == receipt['tool'].get('sha256'),
            'actual isolation executable identity drift')
    library = Path(receipt.get('libpq', {}).get('path', ''))
    require(library.is_absolute() and library.is_relative_to(TOOL_ROOT / 'toolchain')
            and library.is_file() and library.resolve() == library
            and digest(library.read_bytes()) == receipt['libpq'].get('sha256'),
            'matching source-built libpq identity drift')
    require(digest((pg / 'postgres').read_bytes()) == receipt.get('packagedPostgresSha256'),
            'packaged server identity differs from tool build receipt')


def validate_isolation(stdout, stderr):
    require(not re.search(r'(?mi)(?:^|\s)(?:ERROR|FATAL|PANIC):', stdout + '\n' + stderr),
            'isolationtester SQL error cannot pass even with exit zero')
    require(not stderr.strip(), 'unexpected isolationtester stderr')
    schedules = [
        (['change_begin','change_identity','a_begin','a_resolve_unknown','change_commit','a_commit','assert_unknown'],
         'a_resolve_unknown', 'change_commit'),
        (['a_begin','a_resolve_one','b_begin','b_resolve_zero','a_commit','b_commit','assert_once'],
         'b_resolve_zero', 'a_commit'),
    ]
    starts = list(re.finditer(r'^starting permutation: (.+)$', stdout, re.M))
    require(len(starts) == len(schedules), 'exact two original permutations required')
    for index, (steps, waiter, releaser) in enumerate(schedules):
        start = starts[index]
        require(start.group(1).split() == steps, 'original permutation order drift')
        block = stdout[start.end():starts[index+1].start() if index+1 < len(starts) else len(stdout)]
        records = list(re.finditer(r'^step ([a-z_]+):', block, re.M))
        events = []
        for i, record in enumerate(records):
            text = block[record.end():records[i+1].start() if i+1 < len(records) else len(block)]
            kind = 'complete' if '<... completed>' in text else 'wait' if '<waiting ...>' in text else 'step'
            events.append((record.group(1), kind))
        expected = []
        for name in steps:
            expected.append((name, 'wait' if name == waiter else 'step'))
            if name == releaser:
                expected.append((waiter, 'complete'))
        require(events == expected, 'missing, extra or misordered actual blocked/unblocked step: ' + waiter)
    return True

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path,
                        default=ROOT / 'artifacts/class4-hand-outcome')
    args = parser.parse_args()
    require(sys.platform == 'linux' and os.geteuid() != 0,
            'existing nonroot Linux PG17 job required')
    pg = Path(os.environ.get('PG_BIN', ''))
    require(pg.is_absolute() and all(os.access(pg / name, os.X_OK)
            for name in ('postgres', 'psql', 'initdb', 'pg_ctl', 'createdb')),
            'PG_BIN must identify the existing resolved PG17 binaries')
    manifest_path = ROOT / CLASS4 / 'manifest.json'
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
    work = Path(tempfile.mkdtemp(prefix='class4-', dir='/tmp'))
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
           'PGAPPNAME': 'class4-' + execution,
           'PGOPTIONS': '-c app.class4_execution_uuid=' + execution}
    receipt = {
        'execution': execution, 'scope': manifest['scope'], 'stages': [],
        'sql_slice_passed': False, 'connected_services_qualified': False,
        'production_touched': False, 'terminal_observed': False,
        'source_stable': False, 'cleanup_errors': [], 'passed': False, 'failure': None,
        'concurrency_passed': False, 'fixture_authority_delta': 'GRANT SET ON PARAMETER session_replication_role TO postgres only for original synthetic seed phase; service_role unchanged',
        'atomic_money_writer_qualified': False, 'representative_backlog_qualified': False,
        'manifest_sha256': digest(manifest_bytes), 'adapter_sha256': digest(adapter_bytes),
        'input_sha256': {name: digest(value) for name, value in sources.items()},
    }

    def persist():
        temp = out / 'RESULTS.tmp'
        with temp.open('w') as handle:
            json.dump(receipt, handle, indent=2)
            handle.write('\n'); handle.flush(); os.fsync(handle.fileno())
        os.replace(temp, out / 'RESULTS.json')

    def command(stage, argv, timeout=30, cleanup=False, allow=(0,), stdin_path=None):
        active_deadline = cleanup_deadline if cleanup else deadline
        budget = command_budget(active_deadline, time.monotonic(), timeout)
        entry = {'stage': stage, 'started_monotonic': time.monotonic()}
        receipt['stages'].append(entry); persist()
        stdout, stderr = out / (stage + '.stdout'), out / (stage + '.stderr')
        with stdout.open('wb') as output, stderr.open('wb') as errors:
            input_file = stdin_path.open('rb') if stdin_path is not None else open(os.devnull, 'rb')
            try:
                child = subprocess.Popen([str(a) for a in argv], stdout=output, stderr=errors,
                                         stdin=input_file, env=env, start_new_session=True)
            finally:
                input_file.close()
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

    def sql(stage, path, user='fixture_bootstrap', phase=None):
        argv = [pg / 'psql', '-X', '-w', '-A', '-t', '-h', socket, '-p', '55432',
                '-U', user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'] + variables
        if phase:
            argv += ['-v', 'phase=' + phase]
        return command(stage, argv + ['-f', path], timeout=70)

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
        validate_version(version, 'Class4 packaged server')
        tool_receipt_path = TOOL_ROOT / 'receipt.json'
        tool_receipt_bytes = tool_receipt_path.read_bytes()
        tool_receipt = json.loads(tool_receipt_bytes)
        validate_tool_receipt(tool_receipt, pg)
        tool_version = command('isolation_version', [TOOL, '-V'], timeout=3)
        validate_version(tool_version, 'Class4 isolationtester')
        receipt['isolation_tool_receipt_sha256'] = digest(tool_receipt_bytes)
        receipt['tool_identity'] = tool_receipt['tool']
        receipt['libpq_identity'] = tool_receipt['libpq']
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
        class4_db = 'class4_native_' + execution.replace('-', '')
        command('rename_owned_empty_database', bootstrap + ['-c', 'ALTER DATABASE ' + db + ' RENAME TO ' + class4_db], timeout=5)
        db = class4_db
        # The original qualifier explicitly seeds synthetic receipts in replica mode.
        # This fixture-only permission is recorded; it is never granted to tested API roles.
        command('fixture_seed_parameter_authority', bootstrap + ['-c',
                'GRANT SET ON PARAMETER session_replication_role TO postgres'], timeout=5)
        sql('core_catalog_supplement', ROOT / CHECKOUT_INPUTS['core_supplement'])
        sql('class4_exact_captured_functions', ROOT / CHECKOUT_INPUTS['catalog_supplement'])
        sql('core_guarded_install', ROOT / CHECKOUT_INPUTS['core_component'], user='postgres')
        before = json.loads(sql('class4_empty_preimage', ROOT / CHECKOUT_INPUTS['readback'], user='postgres').splitlines()[-1])
        require(before['resolver_definition_md5'] == '0874e7e5fa2a2b3b68bc8d3cdc7de8ab'
                and before['bridge_definition_md5'] == '00a43ae03ab12cec9505e2bfed71d937'
                and before['raiser_definition_md5'] == 'a6df5f2eef07aa3f606db79d93944590',
                'exact composed source admission required')
        require(before['server_version_num'] == VERSION_NUM, 'actual PG17.11 endpoint required')
        sql('class4_original_states_and_drift', ROOT / CHECKOUT_INPUTS['class4_primary'], user='postgres')
        after = json.loads(sql('class4_primary_rollback_observer', ROOT / CHECKOUT_INPUTS['readback'], user='postgres').splitlines()[-1])
        require(before == after, 'primary rollback did not restore source and empty subject state')
        sql('class4_candidate_for_concurrency', ROOT / CHECKOUT_INPUTS['class4_component'], user='postgres')
        candidate = json.loads(sql('class4_concurrency_empty_observer', ROOT / CHECKOUT_INPUTS['readback'], user='postgres').splitlines()[-1])
        require(candidate == dict(before, resolver_definition_md5='edd4397b2daeadade433cd01a26a1c70'),
                'concurrency candidate admission changed unrelated state')
        transcript = command('class4_actual_isolation', [TOOL, 'host=' + str(socket)
                + ' port=55432 user=postgres dbname=' + db], timeout=70,
                stdin_path=ROOT / CHECKOUT_INPUTS['class4_concurrency'])
        validate_isolation(transcript, (out / 'class4_actual_isolation.stderr').read_text())
        receipt['concurrency_passed'] = True
        after_races = json.loads(sql('class4_concurrency_teardown_observer', ROOT / CHECKOUT_INPUTS['readback'], user='postgres').splitlines()[-1])
        require(after_races == candidate, 'concurrency teardown did not restore empty subject state')
        sql('class4_guarded_final_source_rollback', ROOT / CHECKOUT_INPUTS['class4_rollback'], user='postgres')
        final = json.loads(sql('class4_final_empty_source_observer', ROOT / CHECKOUT_INPUTS['readback'], user='postgres').splitlines()[-1])
        require(final == before, 'final guarded rollback did not restore exact original source/state')
        validate_tool_receipt(tool_receipt, pg)
        require(tool_receipt_path.read_bytes() == tool_receipt_bytes, 'isolation build receipt changed')
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
