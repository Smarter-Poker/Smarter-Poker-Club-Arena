#!/usr/bin/env python3
"""Draft PR native smoke evidence; never a release/product certificate."""
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import uuid

FILES = ('Dockerfile', 'package.json', 'package-lock.json', 'fixture-server.mjs',
         'runtime-files.mjs', 'gateway.mjs', 'auth-fixture.mjs', 'auth-bootstrap-proof.mjs',
         'service-role-boundary.mjs', 'actors.mjs', 'financial-route-phase.mjs',
         'seed-fixture.mjs', 'native-smoke.mjs', 'observation-bridge.mjs', 'build-image.sh', 'smoke-image.sh')
PREFIX = 'operations/release/fixture/'
CONTROL_FILES = tuple('operations/release/native/' + name for name in (
    'component-observation-protocol.mjs', 'component-observation-client.mjs',
    'component-semantic-observations.mjs'))
NATIVE_STAGES = frozenset((
    'initialization', 'observer-user-isolation', 'native-observation-bridge',
    'chromium-native-read-and-rls', 'postgresql-17-extensions',
    'postgresql-version', 'postgrest-version', 'gotrue-version', 'postgresql-initialize',
    'postgresql-start', 'postgresql-ready', 'postgresql-create-database',
    'postgresql-client-connection', 'postgresql-client-cleanup', 'postgresql-slot-identity',
    'postgresql-wal2json-native-slot', 'postgresql-wal2json-slot-inspection',
    'postgresql-wal2json-slot-drop', 'postgresql-bootstrap-roles', 'postgresql-bootstrap-schemas',
    'postgresql-extension-dblink', 'postgresql-extension-pg-stat-statements',
    'postgresql-extension-pg-trgm', 'postgresql-extension-pgcrypto',
    'postgresql-extension-uuid-ossp', 'postgresql-extension-vector',
    'postgresql-extension-inventory', 'gotrue-genuine-migrations-and-mfa',
    'gotrue-database-namespace', 'gotrue-migrate-command', 'gotrue-migration-ledger', 'gotrue-server-start',
    'gotrue-server-ready', 'gotrue-real-user-signin', 'gotrue-real-mfa-enrollment',
    'gotrue-real-mfa-persistence', 'gotrue-disabled-ledger-attribution',
    'postgrest-14-5-authentication-and-rls', 'realtime-genuine-migrations-and-change',
    'postgrest-server-start', 'postgrest-server-ready', 'postgrest-anonymous-rls', 'postgrest-invalid-token',
    'realtime-migrate-command', 'realtime-seed-command', 'realtime-tenant-row', 'realtime-tenant-migration-ledger',
    'realtime-server-start', 'realtime-server-ready', 'realtime-cookie-rpc', 'realtime-cookie-proof',
    'realtime-websocket-open', 'realtime-postgres-subscription', 'realtime-causal-change',
    'realtime-two-user-causal-isolation', 'postgrest-two-user-isolation',
    'native-observation-bridge-start', 'observer-and-browser-handoff',
    'realtime-loopback-and-gateway', 'candidate-peer-isolation',
    'native-migrated-service-role-boundary'))
NATIVE_ERROR_NAMES = frozenset(('Error', 'AssertionError', 'TypeError', 'RangeError',
                                'SyntaxError', 'TimeoutError', 'AggregateError', 'error'))
NATIVE_PG_ROUTINES = frozenset((
    'CheckSlotPermissions', 'CheckLogicalDecodingRequirements', 'internal_load_library',
    'CreateSlotOnDisk', 'SaveSlotToPath', 'XLogFileRead', 'XLogFileReadAnyTLI',
    'ReorderBufferRestoreChanges', 'ReorderBufferSerializeTXN', 'aclcheck_error'))


def native_failures(output):
    # Enumerated labels only. Never retain messages, stacks, arbitrary error
    # names, SQL, service logs, or additional fields from child output.
    records = []
    for line in output.splitlines():
        if len(line) > 2048:
            continue
        try:
            row = json.loads(line)
        except (ValueError, TypeError):
            continue
        if (not isinstance(row, dict) or row.get('status') != 'failed'
                or not isinstance(row.get('stage'), str) or row['stage'] not in NATIVE_STAGES):
            continue
        has_native_line = 'native_line' in row
        native_line = row.pop('native_line', None)
        if has_native_line and (type(native_line) is not int or not 1 <= native_line <= 9999):
            continue
        realtime = {key: row.pop(key) for key in ('realtime_log_markers', 'realtime_frames', 'realtime_database_errors') if key in row}
        if realtime and (not {'realtime_log_markers', 'realtime_frames'} <= set(realtime)
                or type(realtime['realtime_log_markers']) is not int
                or not 0 <= realtime['realtime_log_markers'] < 2 ** 22
                or not isinstance(realtime['realtime_frames'], list)
                or len(realtime['realtime_frames']) > 8
                or any(not isinstance(frame, str) or not re.fullmatch('[0-9a-f]{64}:[1-9][0-9]{0,5}', frame)
                       for frame in realtime['realtime_frames'])):
            continue
        if 'realtime_database_errors' in realtime:
            allowed_errors = {'insufficient_privilege', 'undefined_object', 'undefined_function',
                              'undefined_table', 'undefined_column', 'datatype_mismatch',
                              'unique_violation', 'object_not_in_prerequisite_state',
                              'invalid_schema_name', 'invalid_parameter_value',
                              'permission denied for database', 'permission denied for schema',
                              'permission denied for table', 'permission denied for relation',
                              'must be owner of', 'permission denied to create', 'must have admin option',
                              'permission denied to grant', 'must be member of role',
                              'must be able to set role', 'no schema has been selected'}
            errors = realtime['realtime_database_errors']
            if (not isinstance(errors, list) or not 1 <= len(errors) <= len(allowed_errors)
                    or any(not isinstance(error, str) or error not in allowed_errors for error in errors)
                    or len(errors) != len(set(errors))):
                continue
        service = {key: row.pop(key) for key in ('native_service', 'service_exit_code',
                   'service_signal', 'service_oom_kills') if key in row}
        if (('native_service' in service and (not isinstance(service['native_service'], str)
                or service['native_service'] not in {'postgres', 'auth', 'postgrest', 'realtime'}))
                or ('service_signal' in service and (not isinstance(service['service_signal'], str)
                    or service['service_signal'] not in {'SIGKILL','SIGTERM','SIGABRT','SIGSEGV','SIGBUS','SIGILL'}))
                or any(key in service and (type(service[key]) is not int or not 0 <= service[key] <= limit)
                       for key, limit in [('service_exit_code', 255), ('service_oom_kills', 999999999)])):
            continue
        listener = {key: row.pop(key) for key in ('listener_reason', 'listener_loopback4',
                    'listener_other4', 'listener_ipv6', 'listener_rows4', 'listener_rows6',
                    'listener_port4000', 'listener_http_port', 'listener_http_address') if key in row}
        if listener and (not isinstance(listener.get('listener_reason'), str)
                or listener['listener_reason'] not in {'header', 'row-shape', 'address-shape', 'listener-set'}
                or ('listener_http_address' in listener and (not isinstance(listener['listener_http_address'], str)
                    or listener['listener_http_address'] not in {'ipv4-loopback', 'ipv4-wildcard', 'ipv4-other',
                        'ipv6-loopback', 'ipv6-wildcard', 'ipv6-other', 'unknown'}))
                or any(type(value) is not int or not 0 <= value <= 65535
                       for key, value in listener.items() if key not in {'listener_reason', 'listener_http_address'})):
            continue
        auth = {key: row.pop(key) for key in ('auth_stage', 'auth_http_status') if key in row}
        if ('auth_stage' in auth and (not isinstance(auth['auth_stage'], str)
                or auth['auth_stage'] not in {'mfa-enroll', 'mfa-factor-id', 'mfa-challenge',
                    'mfa-challenge-id', 'mfa-totp', 'mfa-verify', 'mfa-session'})):
            continue
        if ('auth_http_status' in auth and (type(auth['auth_http_status']) is not int
                or not 100 <= auth['auth_http_status'] <= 599)):
            continue
        if (set(row) == {'status', 'stage', 'error'} and isinstance(row['error'], str)
                and row['error'] in NATIVE_ERROR_NAMES):
            record = {'stage': row['stage'], 'category': row['error']}
        elif ({'status', 'stage', 'error', 'exit_code'} <= set(row)
                <= {'status', 'stage', 'error', 'exit_code', 'command_phase', 'command_sqlstate'}
                and row['error'] == 'Error' and type(row['exit_code']) is int
                and 1 <= row['exit_code'] <= 255
                and ('command_phase' not in row or (isinstance(row['command_phase'], str)
                     and row['command_phase'] in {'auth-url', 'auth-open', 'auth-connect',
                                                 'auth-migrator', 'auth-migrations'}))
                and ('command_sqlstate' not in row or (isinstance(row['command_sqlstate'], str)
                     and re.fullmatch('[0-9A-Z]{5}', row['command_sqlstate'])))):
            record = {'stage': row['stage'], 'category': 'Error', 'exit_code': row['exit_code']}
            for key in ('command_phase', 'command_sqlstate'):
                if key in row:
                    record[key] = row[key]
        elif ({'status', 'stage', 'error', 'sqlstate'} <= set(row)
                <= {'status', 'stage', 'error', 'sqlstate', 'position', 'routine', 'routine_sha256', 'file_sha256'}
                and row['error'] == 'error' and isinstance(row['sqlstate'], str)
                and re.fullmatch('[0-9A-Z]{5}', row['sqlstate'])
                and ('position' not in row or (type(row['position']) is int
                     and 1 <= row['position'] <= 999999))
                and ('routine' not in row or (isinstance(row['routine'], str)
                     and row['routine'] in NATIVE_PG_ROUTINES))
                and all(key not in row or (isinstance(row[key], str)
                    and re.fullmatch('[0-9a-f]{64}', row[key]))
                    for key in ('routine_sha256', 'file_sha256'))):
            record = {'stage': row['stage'], 'category': 'error', 'sqlstate': row['sqlstate']}
            if 'position' in row:
                record['position'] = row['position']
            if 'routine' in row:
                record['routine'] = row['routine']
            for key in ('routine_sha256', 'file_sha256'):
                if key in row:
                    record[key] = row[key]
        elif set(row) == {'status', 'stage', 'reason'} and row['reason'] == 'deadline':
            record = {'stage': row['stage'], 'category': 'deadline'}
        else:
            continue
        if native_line is not None:
            record['native_line'] = native_line
        record.update(auth)
        record.update(listener)
        record.update(service)
        record.update(realtime)
        if record not in records:
            records.append(record)
    return records


class NativeSmokeFailure(RuntimeError):
    def __init__(self, output):
        super().__init__('native_fixture_services_failed')
        self.diagnostics = native_failures(output)


def require(value):
    if not value:
        raise RuntimeError('native_fixture_smoke_requirement_failed')


def command(args, cwd, env, timeout=120):
    process = subprocess.Popen(args, cwd=cwd, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, start_new_session=True)
    stdout = stderr = ''
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except BaseException:
        # Stop the entire locally spawned command group, then clean exact Docker resources.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            stdout, stderr = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
        raise
    finally:
        # Only the reviewed image build is eligible. Its allowlisted context has
        # no credentials or application data; synthetic secrets are generated
        # later during native-smoke and that command's output stays private.
        if args[:2] == ['bash', PREFIX + 'build-image.sh'] and env.get('FIXTURE_SMOKE_BUILD_LOG'):
            build_log = Path(env['FIXTURE_SMOKE_BUILD_LOG'])
            fd = os.open(build_log, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as log:
                log.write('Reviewed image build only; no native service output.\n')
                log.write((stdout + '\n' + stderr)[-131072:])
    if process.returncode != 0 and args[:2] == ['bash', PREFIX + 'smoke-image.sh']:
        raise NativeSmokeFailure(stdout + '\n' + stderr)
    require(process.returncode == 0)
    return stdout


def labels_match(labels, revision):
    return all(labels.get(key) == value for key, value in {
        'org.opencontainers.image.revision': revision,
        'org.opencontainers.image.source': 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena',
        'com.smarter-poker.scope': 'isolated-component-fixture',
        'com.smarter-poker.control-revision': revision,
        'com.smarter-poker.source-revision': revision,
    }.items())


def smoke_records(output):
    rows = []
    for line in output.splitlines():
        if line.startswith('{'):
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    observer = {'scope': 'native-service-smoke', 'observer': 'passed',
                'browser': 'chromium', 'retries': 0,
                'observation_bridge': 'native-synthetic-protocol', 'postgres_socket': 'denied'}
    services = {'scope': 'native-service-smoke', 'postgres': '17.11',
                'extensions': 6, 'auth': '2.196.0', 'mfa': 'aal2',
                'ledger_attribution': 'banned-without-session',
                'service_roles': {'auth_admin_inheritance': 'disabled',
                                  'authenticator_membership': 'set-without-inherit',
                                  'auth_schema_owner': 'supabase_admin',
                                  'auth_schema_create': 'auth-admin-only-among-application-callers',
                                  'bootstrap_postgres': 'local-superuser',
                                  'production_application_privilege_parity': False},
                'postgrest': '14.5', 'realtime': '2.134.10',
                'change': 'observed', 'retries': 0,
                'realtime_listener': '127.0.0.1:4000',
                'realtime_gateway': 'authenticated-change-observed',
                'realtime_rls': 'two-users-causal-isolation',
                'observation_bridge': 'native-synthetic-protocol'}
    peer = {'scope': 'native-service-smoke', 'peer': 'passed', 'gateway': 'reachable',
            'realtime_direct': 'refused', 'tenant_administration': 'refused'}
    require(rows.count(observer) == 1 and rows.count(services) == 1 and rows.count(peer) == 1)
    require('Native service smoke and container/network cleanup passed (not a product certificate).' in output.splitlines())
    return [observer, services, peer]


def execute(repo, output, expected, run=command):
    receipt = {'version': 1, 'scope': 'draft-pr-native-service-smoke',
               'product_certificate': False, 'status': 'failed',
               'stage': 'source', 'cleanup': {'container_absent': False, 'peer_absent': False,
                                             'network_absent': False, 'image_removed': False}}
    output.mkdir(parents=True, exist_ok=True)
    env = {key: os.environ[key] for key in ('PATH', 'HOME') if key in os.environ}
    env.update({'LANG': 'C.UTF-8', 'GIT_CONFIG_GLOBAL': '/dev/null',
                'GIT_CONFIG_SYSTEM': '/dev/null', 'GIT_NO_REPLACE_OBJECTS': '1'})
    name = 'ca-fixture-smoke-' + uuid.uuid4().hex
    peer, network = name + '-peer', name + '-network'
    tag = 'club-arena-component-fixture:smoke-' + uuid.uuid4().hex
    env['FIXTURE_SMOKE_CONTAINER'] = name
    env['FIXTURE_SMOKE_BUILD_LOG'] = str(output / 'native-build.log')
    image_id = None
    build_started = False
    failed = False
    try:
        require(re.fullmatch('[0-9a-f]{40}', expected))
        revision = run(['git', 'rev-parse', 'HEAD'], repo, env).strip()
        require(revision == expected)
        run(['git', 'diff', '--exit-code', 'HEAD', '--', PREFIX], repo, env)
        manifest = {}
        for relative in tuple(PREFIX + file for file in FILES) + CONTROL_FILES:
            path = repo / relative
            require(path.is_file() and not path.is_symlink())
            run(['git', 'ls-files', '--error-unmatch', relative], repo, env)
            manifest[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        receipt.update({'control_revision': revision, 'source_revision': revision,
                        'source_sha256': manifest, 'container': name, 'peer': peer, 'network': network})
        receipt['stage'] = 'build'
        build_started = True
        run(['bash', PREFIX + 'build-image.sh', tag], repo, env, timeout=2400)
        image = json.loads(run(['docker', 'image', 'inspect', tag], repo, env))[0]
        image_id = image['Id']
        require(re.fullmatch('sha256:[0-9a-f]{64}', image_id))
        require(image['Os'] == 'linux' and image['Architecture'] == 'amd64')
        require(labels_match(image['Config'].get('Labels') or {}, revision))
        receipt['image_id'] = image_id
        receipt['stage'] = 'native-services-and-browser'
        result = run(['bash', PREFIX + 'smoke-image.sh', image_id], repo, env, timeout=420)
        receipt['observations'] = smoke_records(result)
    except Exception as error:
        # Never serialize command output, environment, service logs, or tokens.
        if isinstance(error, NativeSmokeFailure):
            receipt['native_failures'] = error.diagnostics
        failed = True
    finally:
        try:
            # Exact caller-owned names, never a broad prune. Remove containers
            # before their network, including when the peer check fails early.
            for owned, field in ((peer, 'peer_absent'), (name, 'container_absent')):
                ids = run(['docker', 'container', 'ls', '-aq', '--filter', 'name=^/' + owned + '$'], repo, env).split()
                if ids:
                    run(['docker', 'container', 'rm', '--force', owned], repo, env)
                    failed = True  # Smoke did not itself finish cleanup.
                require(not run(['docker', 'container', 'ls', '-aq', '--filter', 'name=^/' + owned + '$'], repo, env).strip())
                receipt['cleanup'][field] = True
            names = run(['docker', 'network', 'ls', '--filter', 'name=^' + network + '$', '--format', '{{.Name}}'], repo, env).split()
            if network in names:
                run(['docker', 'network', 'rm', network], repo, env)
                failed = True
            require(network not in run(['docker', 'network', 'ls', '--filter', 'name=^' + network + '$', '--format', '{{.Name}}'], repo, env).split())
            receipt['cleanup']['network_absent'] = True
            if build_started:
                ids = run(['docker', 'image', 'ls', '-q', '--no-trunc', tag], repo, env).split()
                if ids:
                    run(['docker', 'image', 'rm', tag], repo, env)
                require(not run(['docker', 'image', 'ls', '-q', '--no-trunc', tag], repo, env).strip())
                # Removal of our tag must also remove the newly built image.
                if image_id:
                    require(image_id not in run(['docker', 'image', 'ls', '-aq', '--no-trunc'], repo, env).split())
            receipt['cleanup']['image_removed'] = True
        except Exception:
            failed = True
        if not failed:
            receipt.update({'status': 'passed', 'stage': 'complete'})
        (output / 'native-smoke-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return 1 if failed else 0


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit(2)
    def interrupted(signum, frame):
        raise InterruptedError('native_smoke_interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    sys.exit(execute(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), sys.argv[3]))
