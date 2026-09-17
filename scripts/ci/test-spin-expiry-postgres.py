#!/usr/bin/env python3
"""Finite hosted PG17 Spin expiry qualification, using authentic captured inputs.

Runs source-specific controls first, then independent preimage and candidate
clusters. No provider daemon, VM, arbitrary database target, retry or resume.
The financial schedules and their independent oracle remain authoritative.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'scripts/ci/probes/spin-expiry'
ORIGIN_MANIFEST = 'bee0d56349f89b0324962455b770fde4b5c322970b2b7b5a11ad69536b3ff580'
MARKER = b'CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();'
OWNER = '47965354-0e56-43ef-931c-ddaab82af765'
REFUND_ACTOR = '2d1cd6c3-5700-4af9-a271-d4863fdab20d'
IMAGES = ('preimage', 'candidate')
CASES = {'preimage': ('order',), 'candidate': ('order', 'timeout', 'committed-refund')}
CASE_RESULTS = {'order': 'business-order.json', 'timeout': 'business-timeout.json',
                'committed-refund': 'committed-refund.jsonl'}
SERVER_ENDPOINT_QUERY = """SELECT jsonb_build_object(
  'user',current_user,'session_user',session_user,'port',current_setting('port'),
  'address',inet_server_addr(),'listen_addresses',current_setting('listen_addresses'),
  'unix_socket_directories',current_setting('unix_socket_directories'));"""
CLEAN_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
             'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
             'PYTHONDONTWRITEBYTECODE': '1'}
REPLACEMENTS = {'scripts/qualification/spin-expiry-business-races.md': 'scripts/qualification/spin-expiry-business-races.md', 'scripts/qualification/spin-expiry-business-races.py': 'scripts/qualification/spin-expiry-business-races.py', 'scripts/qualification/spin-expiry-business-state.sql': 'scripts/qualification/spin-expiry-business-state.sql', 'scripts/qualification/spin-expiry-committed-refund-oracle.py': 'scripts/qualification/spin-expiry-committed-refund-oracle.py', 'scripts/qualification/spin-expiry-committed-refund-state.sql': 'scripts/qualification/spin-expiry-committed-refund-state.sql', 'scripts/qualification/spin-expiry-committed-refund.authority.json': 'scripts/qualification/spin-expiry-committed-refund.authority.json', 'scripts/qualification/spin-expiry-committed-refund.md': 'scripts/qualification/spin-expiry-committed-refund.md', 'scripts/qualification/spin-expiry-committed-refund.py': 'scripts/qualification/spin-expiry-committed-refund.py', 'scripts/qualification/spin-expiry-lock-order.authority.json': 'scripts/qualification/spin-expiry-lock-order.authority.json', 'scripts/qualification/spin-expiry-lock-order.component-inputs.sql': 'scripts/qualification/spin-expiry-lock-order.component-inputs.sql', 'scripts/qualification/spin-expiry-lock-order.md': 'scripts/qualification/spin-expiry-lock-order.md', 'scripts/qualification/spin-expiry-lock-order.sql': 'scripts/qualification/spin-expiry-lock-order.sql', 'scripts/qualification/spin-expiry-real-funded-fixture.sql': 'scripts/qualification/spin-expiry-real-funded-fixture.sql', 'supabase/components/spin-expiry-lock-order.rollback.sql': 'supabase/components/spin-expiry-lock-order.rollback.sql', 'supabase/components/spin-expiry-lock-order.sql': 'supabase/components/spin-expiry-lock-order.sql'}
FIXED_INPUTS = frozenset(('inputs/schema.sql', 'inputs/access.sql', 'inputs/policies.sql', 'principals.sql', 'provider-supplement.sql', 'provider-roles.sql', 'provider-roles-check.sql', 'provider-check.sql', 'empty-provider-check.sql', 'inputs/catalog-sequence-exact.json', 'inputs/spin-catalog-supplement.sql', 'inputs/entry-provider-supplement.sql', 'inputs/entry-sequence-authority.sql', 'inputs/settle-source-authority.sql', 'inputs/captured-financial-store-policy.sql', 'inputs/captured-spin-catalog.json', 'spin-catalog-observer.sql'))

def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def validate_server_endpoint(value, socket_path):
    # PG17 restricts unix_socket_directories to privileged diagnostic readers.
    # The existing fixture bootstrap checks server configuration; business
    # sessions retain their captured nonsuperuser roles and owned socket checks.
    require(value == {'user': 'fixture_bootstrap', 'session_user': 'fixture_bootstrap',
                      'port': '5432', 'address': None, 'listen_addresses': '',
                      'unix_socket_directories': str(socket_path)},
            'private server endpoint configuration differs')


def server_endpoint_command(PG, socket_path):
    return [str(PG / 'psql'), '-X', '-w', '-h', str(socket_path), '-p', '5432',
            '-U', 'fixture_bootstrap', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
            '-qAt', '-c', SERVER_ENDPOINT_QUERY]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def pin(data):
    return {'sha256': digest(data), 'bytes': len(data)}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate JSON member: ' + key)
        result[key] = value
    return result


def decode(data):
    return json.loads(data, object_pairs_hook=unique_object)


def safe_name(name):
    require(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*', name)
            and all(part not in ('.', '..') for part in name.split('/'))
            and name != 'manifest.json', 'unsafe provider leaf')
    return name


def read_regular(path, limit):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= limit,
            'non-regular, linked or oversized source: ' + str(path))
    def identity(value):
        # Reading may legitimately update atime; mutation-relevant fields may not change.
        return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
                value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    with path.open('rb') as handle:
        require(identity(os.fstat(handle.fileno())) == identity(info), 'source changed before read')
        data = handle.read(limit + 1)
    require(len(data) == info.st_size and identity(path.lstat()) == identity(info), 'source changed during read')
    return data


class CleanupOutcome:
    def __init__(self):
        self.errors = []
        self.terminal = False

    def failed(self, error):
        self.errors.append(str(error))

    def observed_stopped(self):
        self.terminal = True

    def qualifies(self):
        return self.terminal and not self.errors


def command_budget(deadline, now, requested):
    if deadline is None:
        raise RuntimeError('cleanup deadline absent')
    # The three-second client exit wait stays inside the same original deadline.
    budget = min(requested, deadline - now - 3)
    if budget <= 0:
        raise TimeoutError('original command/cleanup deadline exhausted')
    return budget


def cleanup_negative_controls():
    clean = CleanupOutcome()
    if clean.qualifies():
        raise AssertionError('unobserved terminal accepted')
    clean.observed_stopped()
    if not clean.qualifies():
        raise AssertionError('clean terminal rejected')
    failed = CleanupOutcome()
    failed.failed('original fast-stop failure')
    failed.observed_stopped()  # A successful fallback must preserve the failure.
    if failed.qualifies() or failed.errors != ['original fast-stop failure']:
        raise AssertionError('fallback erased original cleanup failure')
    if command_budget(30, 0, 12) != 12 or command_budget(30, 20, 10) != 7:
        raise AssertionError('cleanup command received a new independent deadline')
    try:
        command_budget(30, 27, 10)
    except TimeoutError:
        return
    raise AssertionError('exhausted cleanup budget accepted')


def sequence_contract(row):
    expected = {'start': '1', 'increment': '1', 'minimum': '1',
                'maximum': '9223372036854775807', 'cache': '1'}
    for key, value in expected.items():
        if type(row.get(key)) is not str or not re.fullmatch(r'[0-9]+', row[key]) or row[key] != value:
            raise ValueError('sequence bound must be exact captured decimal TEXT: ' + key)
    if row.get('type') != 'bigint' or row.get('cycle') is not False:
        raise ValueError('sequence kind/cycle drift')
    return expected


def sequence_negative_controls(row):
    # Direct regression for the observed JSON bigint rounding; run before PG.
    sequence_contract(row)
    for bad in (9223372036854776000, float(9223372036854775807),
                '9223372036854776000', None, '9.223372036854776e18'):
        changed = dict(row, maximum=bad)
        try:
            sequence_contract(changed)
        except ValueError:
            continue
        raise AssertionError('unsafe sequence metadata accepted')


def canonical_uuid(value):
    parsed = str(uuid.UUID(value))
    if parsed != value:
        raise ValueError('canonical lowercase UUID required')
    return parsed


def owned_path(path, root, *, directory=False, private=False):
    require(path.is_absolute() and path.resolve() == path
            and (path == root or root in path.parents), 'noncanonical or escaping source path')
    for item in (path, *path.parents):
        info = item.lstat()
        require(not stat.S_ISLNK(info.st_mode) and info.st_uid == os.geteuid()
                and not info.st_mode & 0o022, 'foreign, symlink or writable source path: ' + str(item))
        if item == root: break
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode),
            'wrong source path kind')
    if private: require(stat.S_IMODE(info.st_mode) == 0o700, 'private directory mode required')


def load_fixture(directory):
    owned_path(directory, ROOT, directory=True)
    owned_path(directory / 'manifest.json', directory)
    raw = read_regular(directory / 'manifest.json', 262144)
    manifest = decode(raw)
    require(manifest.get('schemaVersion') == 1 and manifest.get('kind') == 'spin-expiry-hosted-fixture'
            and manifest.get('originManifestSha256') == ORIGIN_MANIFEST, 'fixture provenance mismatch')
    entries = manifest.get('files')
    require(isinstance(entries, dict) and set(entries) == FIXED_INPUTS, 'exact fixed input inventory required')
    files = {}
    for name, expected in entries.items():
        safe_name(name)
        require(isinstance(expected, dict) and set(expected) == {'sha256', 'bytes'}
                and type(expected['bytes']) is int and 0 < expected['bytes'] <= 16777216
                and isinstance(expected['sha256'], str)
                and re.fullmatch(r'[0-9a-f]{64}', expected['sha256']), 'malformed fixture pin')
        leaf = directory / name
        owned_path(leaf, directory)
        data = read_regular(leaf, 16777216)
        require(pin(data) == expected, 'fixture leaf mismatch: ' + name)
        files[name] = data
    actual, count = set(), 0
    for current, dirs, leaves in os.walk(directory, followlinks=False):
        for name in dirs + leaves:
            count += 1
            require(count <= 64, 'fixture inventory bound exceeded')
            item = Path(current) / name
            owned_path(item, directory, directory=name in dirs)
        actual.update((Path(current) / name).relative_to(directory).as_posix() for name in leaves)
    require(actual == FIXED_INPUTS | {'manifest.json'}, 'unpinned fixture leaves')
    return raw, manifest, files


def git_read(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], env=CLEAN_ENV, timeout=5)


def source_packet():
    head = git_read('rev-parse', 'HEAD').decode().strip()
    tree = git_read('rev-parse', 'HEAD^{tree}').decode().strip()
    require(re.fullmatch(r'[0-9a-f]{40}', head) and re.fullmatch(r'[0-9a-f]{40}', tree), 'invalid checkout identity')
    raw, fixture_manifest, fixed = load_fixture(FIXTURE)
    # Static inputs and maintained qualification code must be exactly committed.
    relative = (FIXTURE / 'manifest.json').relative_to(ROOT).as_posix()
    require(git_read('show', head + ':' + relative) == raw, 'fixture manifest differs from checkout HEAD')
    for name, data in fixed.items():
        relative = (FIXTURE / name).relative_to(ROOT).as_posix()
        require(git_read('show', head + ':' + relative) == data, 'fixture differs from checkout HEAD: ' + name)
    copied = dict(fixed)
    for name in REPLACEMENTS:
        owned_path(ROOT / name, ROOT)
        actual = read_regular(ROOT / name, 1048576)
        require(git_read('show', head + ':' + name) == actual, 'qualification source differs from checkout HEAD: ' + name)
        copied[name] = actual
    for name in ('scripts/ci/test-spin-expiry-postgres.py', 'scripts/ci/test_spin_expiry_wrapper.py'):
        actual = read_regular(ROOT / name, 1048576)
        require(git_read('show', head + ':' + name) == actual, 'wrapper source differs from checkout HEAD: ' + name)
    manifest = {'schemaVersion': 1, 'kind': 'spin-expiry-hosted-attempt',
                'checkout': {'head': head, 'tree': tree}, 'fixtureManifestSha256': digest(raw),
                'fixtureProvenance': fixture_manifest,
                'files': {name: pin(data) for name, data in copied.items()}}
    return manifest, copied


def stage_packet(allocation, manifest, files):
    owned_path(allocation, allocation, directory=True, private=True)
    require(set(files) == FIXED_INPUTS | set(REPLACEMENTS)
            and set(manifest['files']) == set(files), 'source inventory incomplete')
    source = allocation / 'source'; source.mkdir(mode=0o700)
    for name, data in files.items():
        safe_name(name)
        require(pin(data) == manifest['files'][name], 'source bytes differ before staging')
        leaf = source / name; leaf.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with leaf.open('xb') as handle:
            handle.write(data); handle.flush(); os.fsync(handle.fileno())
        leaf.chmod(0o400)
    raw = (json.dumps(manifest, indent=2) + '\n').encode()
    with (source / 'manifest.json').open('xb') as handle: handle.write(raw)
    (source / 'manifest.json').chmod(0o400)
    verify_packet(source, raw, manifest)
    return raw


def verify_packet(source, raw, manifest):
    owned_path(source, source, directory=True, private=True)
    require(read_regular(source / 'manifest.json', 262144) == raw, 'staged manifest changed')
    actual = set()
    for current, dirs, leaves in os.walk(source, followlinks=False):
        for name in dirs:
            owned_path(Path(current) / name, source, directory=True)
        for name in leaves:
            leaf = Path(current) / name; owned_path(leaf, source)
            actual.add(leaf.relative_to(source).as_posix())
    require(actual == set(manifest['files']) | {'manifest.json'}, 'staged inventory changed')
    for name, expected in manifest['files'].items():
        require(pin(read_regular(source / name, 16777216)) == expected, 'staged source changed: ' + name)


def find_pg():
    requested = os.environ.get('PG_BIN')
    require(requested and Path(requested).is_absolute(), 'PG_BIN must name existing PostgreSQL17 tools')
    pg = Path(requested).resolve()
    for name in ('postgres', 'initdb', 'pg_ctl', 'psql', 'createdb'):
        require((pg / name).is_file() and os.access(pg / name, os.X_OK), 'missing PostgreSQL binary: ' + name)
    return pg


def process_group_absent(pid):
    try: os.killpg(pid, 0)
    except ProcessLookupError: return True
    return False


def finish_clients(clients, deadline, outcome):
    terminal = True
    for child, entry in clients:
        try:
            if child.poll() is None or not process_group_absent(child.pid):
                outcome.failed('original command process group required forced cleanup: ' + str(child.pid))
                try: os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError: pass
            if child.poll() is None:
                child.wait(timeout=command_budget(deadline, time.monotonic(), 2))
            entry['terminal_returncode'] = child.returncode
            # One original cleanup deadline; no new per-iteration time allowance.
            while not process_group_absent(child.pid):
                remaining = deadline - time.monotonic()
                require(remaining > 0, 'original process group cleanup deadline exhausted')
                time.sleep(min(0.02, remaining))
            require(child.returncode is not None, 'original client exit unobserved')
        except BaseException as error:
            terminal = False
            outcome.failed(error)
    return terminal


def validate_case_result(case, raw, execution, tournament, image):
    if case == 'committed-refund':
        records = [decode(line) for line in raw.splitlines()]
        require(records and records[-1].get('event') == 'terminal_source_oracle_result'
                and records[-1].get('observed') is True
                and records[-1].get('client_and_server_cleanup') is True
                and records[-1].get('source_stable') is True
                and records[0].get('execution') == execution
                and records[0].get('tournament') == tournament,
                'original committed-refund terminal lacks required evidence')
    else:
        result = decode(raw)
        require(result.get('scenario_observed') is True and result.get('cleanup_verified') is True
                and result.get('source_stable') is True and result.get('execution') == execution
                and result.get('fixture_tournament') == tournament
                and result.get('image') == image and result.get('case') == case
                and result.get('selected_before') == result.get('selected_after')
                and result.get('authority_before') == result.get('authority_after'),
                'original order/timeout result lacks exact required evidence')


def retained_evidence(work, output, receipt, source_manifest):
    # Exact allowlist: no PGDATA, homes, passwords, arbitrary worktrees or env.
    names = {'receipt.json', 'postgres.log'} | set(CASE_RESULTS.values())
    for stage in receipt.get('stages', []):
        name = stage['stage']
        require(re.fullmatch(r'[a-z0-9_]+', name), 'unsafe evidence stage name')
        names.update((name + '.stdout', name + '.stderr'))
    mandatory = {'receipt.json'}
    for stage in receipt.get('stages', []):
        mandatory.update((stage['stage'] + '.stdout', stage['stage'] + '.stderr'))
    mandatory.update(case['result_path'] for case in receipt.get('business_cases', []) if case.get('state') == 'passed')
    require(all((work / name).exists() for name in mandatory), 'original evidence leaf missing')
    kept = {}
    for name in sorted(names):
        leaf = work / name
        if not leaf.exists(): continue
        owned_path(leaf, work)
        data = read_regular(leaf, 33554432)
        with (output / name).open('xb') as handle: handle.write(data)
        kept[name] = pin(data)
    (output / 'source-manifest.json').write_bytes(source_manifest)
    (output / 'evidence-manifest.json').write_text(json.dumps(kept, indent=2) + '\n')
    return kept


def qualify(args, allocation, manifest_bytes, manifest, PG):
    ROOT = allocation / 'source'
    verify_packet(ROOT, manifest_bytes, manifest)
    embedded = (ROOT / 'scripts/qualification/spin-expiry-lock-order.component-inputs.sql').read_text()
    for label, name in [('forward', 'spin-expiry-lock-order.sql'),
                        ('rollback', 'spin-expiry-lock-order.rollback.sql')]:
        delimiter = '$spin_expiry_' + label + '_source$'
        parts = embedded.split(delimiter)
        if len(parts) != 3 or parts[1] != (ROOT / 'supabase/components' / name).read_text():
            raise ValueError('catalog embedded component differs from exact checkout: ' + label)
    row = json.loads((ROOT / 'inputs/catalog-sequence-exact.json').read_text())['rows'][0]
    bounds = sequence_contract(row)
    sequence_negative_controls(row)
    cleanup_negative_controls()
    identity = ('START WITH ' + bounds['start'] + ' INCREMENT BY ' + bounds['increment']
                + ' MINVALUE ' + bounds['minimum'] + ' MAXVALUE ' + bounds['maximum']
                + ' CACHE ' + bounds['cache'] + ' NO CYCLE')
    if (ROOT / 'provider-supplement.sql').read_text().count(identity) != 1:
        raise ValueError('sequence overlay no longer matches exact text authority')
    schema = (ROOT / 'inputs/schema.sql').read_bytes()
    if schema.count(MARKER) != 1:
        raise ValueError('authentic first-trigger boundary ambiguous')
    prefix, suffix = schema.split(MARKER)
    suffix = MARKER + suffix
    if b'CREATE TRIGGER ' in prefix or b'CREATE CONSTRAINT TRIGGER ' in prefix or prefix + suffix != schema:
        raise ValueError('trigger prefix boundary/reassembly drift')
    work = allocation / 'work'
    work.mkdir(mode=0o700)  # Existing allocation work refuses; no retry/resume.
    (work / 'home').mkdir(mode=0o700)
    (work / 'socket').mkdir(mode=0o700)
    (work / 'schema-prefix.sql').write_bytes(prefix)
    (work / 'schema-suffix.sql').write_bytes(suffix)
    data = work / 'data'
    deadline = time.monotonic() + 240
    cleanup_deadline = None
    receipt = {'execution': args.execution, 'source_manifest_sha256': hashlib.sha256(manifest_bytes).hexdigest(),
               'native_status': 'running', 'stages': [], 'full_qualification': False,
               'business_scenario_passed': False, 'business_qualified': False,
               'catalog_slice_passed': False,
               'image': args.image, 'tournament': args.tournament, 'business_cases': [],
               'qualification_scope': 'one authentic funded Spin expiry schedule',
               'connected_services_qualified': False, 'cleanup_verified': False,
               'execution_backend': 'hosted-owned-pg17-unix-socket',
               'work_deadline_seconds': 240, 'cleanup_deadline_seconds': 30,
               'pg_binary_sha256': {name: hashlib.sha256((PG / name).read_bytes()).hexdigest()
                                    for name in ('postgres', 'psql', 'initdb', 'pg_ctl', 'createdb')}}
    passfile = work / 'home/.spin-expiry.pgpass'
    with passfile.open('xb'): pass
    passfile.chmod(0o600)
    clients = []
    original_pid = None
    env = {'PGPASSFILE': str(passfile), 'PSQL_HISTORY': '/dev/null', 'PATH': str(PG) + ':/usr/bin:/bin', 'HOME': str(work / 'home'),
           'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'PGCONNECT_TIMEOUT': '3',
           'PGAPPNAME': 'spin5-business-' + args.execution,
           'PYTHONDONTWRITEBYTECODE': '1',
           'PGOPTIONS': '-c qualification.execution_uuid=' + args.execution}

    def persist():
        target = work / 'receipt.json'
        temp = work / 'receipt.tmp'
        with temp.open('w') as handle:
            json.dump(receipt, handle, indent=2); handle.write('\n'); handle.flush(); os.fsync(handle.fileno())
        os.replace(temp, target)

    def command(stage, command_args, *, timeout=30, cleanup=False, allow=(0,)):
        active_deadline = cleanup_deadline if cleanup else deadline
        budget = command_budget(active_deadline, time.monotonic(), timeout)
        entry = {'stage': stage, 'started_monotonic': time.monotonic(), 'argv': command_args}
        receipt['stages'].append(entry); persist()
        stdout = work / (stage + '.stdout'); stderr = work / (stage + '.stderr')
        with stdout.open('wb') as out, stderr.open('wb') as err:
            child = subprocess.Popen(command_args, stdout=out, stderr=err, env=env, start_new_session=True)
            entry['pid'] = child.pid
            clients.append((child, entry))
            try:
                child.wait(timeout=budget)
            except BaseException as interrupted:
                entry['client_deadline_exceeded'] = True
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait(timeout=max(0.001, min(3, active_deadline - time.monotonic())))
                entry['returncode'] = child.returncode; persist()
                raise RuntimeError('client interrupted; database effect/cleanup remains unknown: ' + stage) from interrupted
        entry['returncode'] = child.returncode
        entry['stdout_sha256'] = hashlib.sha256(stdout.read_bytes()).hexdigest()
        entry['stderr_sha256'] = hashlib.sha256(stderr.read_bytes()).hexdigest()
        persist()
        if child.returncode not in allow:
            raise RuntimeError('stage failed: ' + stage)
        return stdout.read_text()

    db = 'qual_spin_expiry_' + args.execution.replace('-', '')
    vars_ = ['-v', 'execution_uuid=' + args.execution, '-v', 'ordinary_user_uuid=' + args.ordinary_user,
             '-v', 'tournament_uuid=' + args.tournament]

    def sql(stage, path, user='fixture_bootstrap'):
        cmd = [str(PG / 'psql'), '-X', '-w', '-A', '-t', '-h', str(work / 'socket'),
               '-p', '5432', '-U', user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'] + vars_
        return command(stage, cmd + ['-f', str(path)], timeout=70)

    failed = None
    pg_attempted = False
    try:
        version = command('pg_version', [str(PG / 'postgres'), '--version'], timeout=3)
        if not re.fullmatch(r'postgres \(PostgreSQL\) 17(?:\.[0-9]+)?[^\n]*\n?', version):
            raise ValueError('PG17 required')
        command('initdb', [str(PG / 'initdb'), '-D', str(data), '-U', 'fixture_bootstrap',
                          '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'], timeout=30)
        with (data / 'postgresql.conf').open('a') as handle:
            handle.write("\nlisten_addresses=''\nport=5432\nunix_socket_directories='" + str(work / 'socket')
                         + "'\nunix_socket_permissions=0700\nshared_buffers='32MB'\nwork_mem='4MB'\nmaintenance_work_mem='64MB'\nmax_connections=8"
                         + "\nmax_worker_processes=0\nmax_parallel_workers=0\nmax_wal_senders=0\nwal_level=logical"
                         + "\nstatement_timeout='20s'\nlock_timeout='3s'\nidle_in_transaction_session_timeout='20s'\n")
        pg_attempted = True
        command('pg_start', [str(PG / 'pg_ctl'), '-D', str(data), '-l', str(work / 'postgres.log'), '-w', '-t', '12', 'start'], timeout=15)
        original_pid = int((data / 'postmaster.pid').read_text().splitlines()[0])
        bootstrap = [str(PG / 'psql'), '-X', '-w', '-h', str(work / 'socket'), '-p', '5432', '-U', 'fixture_bootstrap', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
        server_endpoint = decode(command('server_endpoint_readback',
            server_endpoint_command(PG, work / 'socket'), timeout=5))
        validate_server_endpoint(server_endpoint, work / 'socket')
        receipt['server_endpoint'] = server_endpoint
        persist()
        extension_query = "SELECT json_build_object('pgcrypto',EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='pgcrypto'),'uuid-ossp',EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='uuid-ossp'),'pg_trgm_1_6',EXISTS(SELECT 1 FROM pg_available_extension_versions WHERE name='pg_trgm' AND version='1.6'));"
        extensions = decode(command('extension_availability', bootstrap + ['-qAt', '-c', extension_query], timeout=5))
        require(extensions == {'pgcrypto': True, 'uuid-ossp': True, 'pg_trgm_1_6': True}, 'required authentic PostgreSQL extensions unavailable')
        command('create_sql_owner', bootstrap + ['-c', 'CREATE ROLE postgres NOSUPERUSER INHERIT LOGIN CREATEDB CREATEROLE REPLICATION BYPASSRLS'], timeout=5)
        command('create_database', [str(PG / 'createdb'), '-w', '-h', str(work / 'socket'), '-p', '5432', '-U', 'fixture_bootstrap', '-O', 'postgres', db], timeout=5)
        sql('schema_prefix', work / 'schema-prefix.sql')
        sql('restore_preexisting_principals', ROOT / 'principals.sql')
        sql('schema_suffix_all_real_triggers', work / 'schema-suffix.sql')
        sql('authentic_access', ROOT / 'inputs/access.sql')
        sql('authentic_policies', ROOT / 'inputs/policies.sql')
        sql('current_notification_supplement', ROOT / 'provider-supplement.sql')
        sql('current_tested_roles', ROOT / 'provider-roles.sql')
        sql('tested_role_readback', ROOT / 'provider-roles-check.sql')
        sql('current_catalog_readback', ROOT / 'provider-check.sql')
        sql('empty_provider_readback', ROOT / 'empty-provider-check.sql')
        sql('authentic_spin_catalog_supplement', ROOT / 'inputs/spin-catalog-supplement.sql')
        sql('authentic_entry_provider_supplement', ROOT / 'inputs/entry-provider-supplement.sql')
        sql('authentic_entry_sequence_authority', ROOT / 'inputs/entry-sequence-authority.sql')
        sql('authentic_settlement_source_authority', ROOT / 'inputs/settle-source-authority.sql')
        if args.image == 'candidate':
            # Retain the already proven catalog guard in the SAME required CI
            # allocation, so future qualifier/rollback changes cannot skip it.
            before = sql('spin_catalog_before', ROOT / 'spin-catalog-observer.sql', user='postgres')
            sql('spin_catalog_rollback_qualification',
                ROOT / 'scripts/qualification/spin-expiry-lock-order.sql', user='postgres')
            after = sql('spin_catalog_after', ROOT / 'spin-catalog-observer.sql', user='postgres')
            if before != after:
                raise AssertionError('selected catalog changed after rollback-only qualification')
            receipt['catalog_slice_passed'] = True
            sql('install_candidate', ROOT / 'supabase/components/spin-expiry-lock-order.sql', user='postgres')
        sql('real_funded_paid_seat_fixture',
            ROOT / 'scripts/qualification/spin-expiry-real-funded-fixture.sql', user='postgres')
        # A positive one-minute policy is explicitly admitted for this isolated
        # fixture. Never mutate joined_at or hold a transaction open while aging.
        # This is one finite wait, not a retry, observer loop or state repair.
        if deadline - time.monotonic() < (95 if args.image == 'preimage' else 155):
            raise TimeoutError('insufficient original budget for natural aging and bounded schedule')
        receipt['natural_aging'] = {'started_monotonic': time.monotonic(), 'seconds': 65}
        persist()
        time.sleep(65)
        receipt['natural_aging']['finished_monotonic'] = time.monotonic()
        # One database/allocation identity is shared only by the candidate's
        # explicit serial cases. Both rollback cases independently prove exact
        # business/catalog restoration plus client/backend cleanup before reuse.
        # The only committing case is last. Failure or unknown outcome stops the
        # allocation immediately; no case is retried or resumed.
        cases = CASES[args.image]
        for ordinal, case in enumerate(cases, start=1):
            case_record = {'case': case, 'case_identity': args.execution + ':' + str(ordinal) + ':' + case,
                           'execution': args.execution, 'state': 'running'}
            receipt['business_cases'].append(case_record)
            persist()
            command_args = [sys.executable]
            common = ['--psql', str(PG / 'psql'), '--execution', args.execution,
                      '--tournament', args.tournament]
            if case == 'committed-refund':
                result_path = work / 'committed-refund.jsonl'
                command_args += [str(ROOT / 'scripts/qualification/spin-expiry-committed-refund.py')]
                command_args += common + ['--journal', str(result_path)]
            else:
                result_path = work / ('business-' + case + '.json')
                command_args += [str(ROOT / 'scripts/qualification/spin-expiry-business-races.py')]
                command_args += common + ['--image', args.image, '--case', case,
                                          '--output', str(result_path)]
            command('actual_business_' + case, command_args, timeout=30)
            validate_case_result(case, result_path.read_bytes(), args.execution, args.tournament, args.image)
            case_record.update(state='passed', result_sha256=hashlib.sha256(result_path.read_bytes()).hexdigest(),
                               result_path=str(result_path.relative_to(work)))
            persist()
        receipt['business_scenario_passed'] = True
    except BaseException as error:
        failed = str(error)
        receipt['failure'] = {'type': type(error).__name__, 'message': str(error)}
    finally:
        # A killed client, timeout, or failed stop command is never terminal proof.
        cleanup_outcome = CleanupOutcome()
        cleanup_deadline = time.monotonic() + 30
        for sig in (signal.SIGINT, signal.SIGTERM): signal.signal(sig, signal.SIG_IGN)
        pg_terminal = not pg_attempted
        try:
            if pg_attempted:
                pidfile = data / 'postmaster.pid'
                if pidfile.exists():
                    observed_pid = int(pidfile.read_text().splitlines()[0])
                    require(original_pid in (None, observed_pid), 'original PostgreSQL identity changed')
                    original_pid = observed_pid
                try:
                    command('pg_stop_fast', [str(PG / 'pg_ctl'), '-D', str(data), '-w', '-t', '10', '-m', 'fast', 'stop'], timeout=12, cleanup=True)
                except Exception as first:
                    receipt['fast_stop_failure'] = str(first)
                    cleanup_outcome.failed(first)
                    command('pg_stop_immediate', [str(PG / 'pg_ctl'), '-D', str(data), '-w', '-t', '8', '-m', 'immediate', 'stop'], timeout=10, cleanup=True)
                command('pg_stopped_readback', [str(PG / 'pg_ctl'), '-D', str(data), 'status'], timeout=3, cleanup=True, allow=(3,))
                if pidfile.exists() or (original_pid is not None and Path('/proc', str(original_pid)).exists()) or (work / 'socket/.s.PGSQL.5432').exists():
                    raise RuntimeError('owned PostgreSQL process/socket absence not proved')
            pg_terminal = True
        except BaseException as error:
            cleanup_outcome.failed(error)
        clients_terminal = finish_clients(clients, cleanup_deadline, cleanup_outcome)
        receipt['original_clients_terminal'] = clients_terminal
        if pg_terminal and clients_terminal:
            cleanup_outcome.observed_stopped()
        receipt['cleanup_verified'] = cleanup_outcome.terminal
        receipt['cleanup_errors'] = cleanup_outcome.errors
        try:
            verify_packet(ROOT, manifest_bytes, manifest)
            receipt['source_stable'] = True
        except BaseException as error:
            receipt['source_stable'] = False
            receipt['source_readback_error'] = str(error)
        receipt['native_status'] = 'business_scenario_passed_cleanup_observed' if failed is None and cleanup_outcome.qualifies() and receipt['source_stable'] else 'failed_or_unknown'
        receipt['postmaster_pid'] = original_pid
        receipt['hosted_cleanup_observed'] = cleanup_outcome.qualifies()
        persist()
    return receipt


def validate_receipt(receipt, execution, ordinary, tournament, image, manifest_sha,
                     source, PG):
    require(image in IMAGES, 'unknown FIFO5 image')
    require(receipt.get('execution') == execution and receipt.get('source_manifest_sha256') == manifest_sha
            and receipt.get('image') == image and receipt.get('tournament') == tournament,
            'wrong/stale qualification receipt')
    require(receipt.get('native_status') == 'business_scenario_passed_cleanup_observed'
            and receipt.get('business_scenario_passed') is True and receipt.get('cleanup_verified') is True
            and receipt.get('cleanup_errors') == [] and receipt.get('source_stable') is True
            and 'failure' not in receipt, 'business scenario or cleanup did not qualify')
    require(receipt.get('full_qualification') is False and receipt.get('connected_services_qualified') is False
            and receipt.get('business_qualified') is False, 'unexpected claim beyond observed schedules')
    require(receipt.get('execution_backend') == 'hosted-owned-pg17-unix-socket'
            and receipt.get('hosted_cleanup_observed') is True
            and receipt.get('original_clients_terminal') is True, 'hosted terminal observation absent')
    require(receipt.get('catalog_slice_passed') is (image == 'candidate'), 'catalog qualification outcome mismatch')
    stages = receipt.get('stages')
    require(isinstance(stages, list) and 0 < len(stages) <= 64, 'missing bounded original stage evidence')
    require(all(isinstance(stage, dict) for stage in stages), 'invalid original stage')
    names = [stage.get('stage') for stage in stages]
    validate_server_endpoint(receipt.get('server_endpoint'), source.parent / 'work/socket')
    require(names.count('server_endpoint_readback') == 1, 'server endpoint readback absent or repeated')
    endpoint_index = names.index('server_endpoint_readback')
    endpoint_stage = stages[endpoint_index]
    require(endpoint_stage.get('returncode') == 0
            and endpoint_stage.get('argv') == server_endpoint_command(PG, source.parent / 'work/socket'),
            'server endpoint readback identity or outcome differs')
    catalog = ['spin_catalog_before', 'spin_catalog_rollback_qualification', 'spin_catalog_after']
    expected = (catalog + ['install_candidate'] if image == 'candidate' else []) + ['real_funded_paid_seat_fixture']
    expected += ['actual_business_' + case for case in CASES[image]]
    require(all(names.count(name) == 1 for name in expected)
            and [names.index(name) for name in expected] == sorted(names.index(name) for name in expected),
            'original phase sequence absent or repeated')
    require(endpoint_index < min(names.index(name) for name in expected),
            'server endpoint readback must precede qualification and financial setup')
    if image == 'preimage':
        require(not any(name in names for name in catalog + ['install_candidate']),
                'candidate installation or catalog execution in preimage allocation')
    else:
        before, after = (stages[names.index(name)].get('stdout_sha256')
                         for name in ('spin_catalog_before', 'spin_catalog_after'))
        require(isinstance(before, str) and re.fullmatch(r'[0-9a-f]{64}', before) and before == after,
                'original catalog observer bytes changed or missing')
    require([name for name in names if isinstance(name, str) and name.startswith('actual_business_')]
            == ['actual_business_' + case for case in CASES[image]], 'unexpected or reordered business invocation')
    sql_inputs = {
        'spin_catalog_before': 'spin-catalog-observer.sql',
        'spin_catalog_rollback_qualification': 'scripts/qualification/spin-expiry-lock-order.sql',
        'spin_catalog_after': 'spin-catalog-observer.sql',
        'install_candidate': 'supabase/components/spin-expiry-lock-order.sql',
        'real_funded_paid_seat_fixture': 'scripts/qualification/spin-expiry-real-funded-fixture.sql',
    }
    for name in expected:
        stage = stages[names.index(name)]
        require(stage.get('returncode') == 0 and isinstance(stage.get('argv'), list) and stage['argv'],
                'stage identity or outcome mismatch')
        if not name.startswith('actual_business_'):
            require(stage['argv'][0] == str(PG / 'psql')
                    and 'execution_uuid=' + execution in stage['argv']
                    and 'ordinary_user_uuid=' + ordinary in stage['argv']
                    and 'tournament_uuid=' + tournament in stage['argv']
                    and stage['argv'][-2:] == ['-f', str(source / sql_inputs[name])], 'SQL stage identity mismatch')
    cases = receipt.get('business_cases')
    require(isinstance(cases, list) and len(cases) == len(CASES[image]), 'case receipt count mismatch')
    for ordinal, (case, record) in enumerate(zip(CASES[image], cases), start=1):
        require(isinstance(record, dict) and record.get('case') == case and record.get('execution') == execution
                and record.get('case_identity') == execution + ':' + str(ordinal) + ':' + case
                and record.get('state') == 'passed' and record.get('result_path') == CASE_RESULTS[case]
                and isinstance(record.get('result_sha256'), str)
                and re.fullmatch(r'[0-9a-f]{64}', record['result_sha256']), 'wrong or incomplete original case receipt')
        common = ['--psql', str(PG / 'psql'), '--execution', execution, '--tournament', tournament]
        work = source.parent / 'work'
        if case == 'committed-refund':
            argv = [sys.executable, str(source / 'scripts/qualification/spin-expiry-committed-refund.py')]
            argv += common + ['--journal', str(work / CASE_RESULTS[case])]
        else:
            argv = [sys.executable, str(source / 'scripts/qualification/spin-expiry-business-races.py')]
            argv += common + ['--image', image, '--case', case, '--output', str(work / CASE_RESULTS[case])]
        require(stages[names.index('actual_business_' + case)]['argv'] == argv,
                'original business case invocation differs')
    return cases


class AttemptCancelled(Exception):
    pass


def new_identity(image):
    values = [str(uuid.uuid4()) for _ in range(3)]
    require(len(set(values + [OWNER, REFUND_ACTOR])) == 5, 'fixture identity collision')
    return argparse.Namespace(execution=values[0], ordinary_user=values[1], tournament=values[2], image=image)


def run_image(image, PG):
    require(image in IMAGES, 'unknown FIFO5 image')
    args = new_identity(image)
    output = ROOT / 'artifacts/spin-expiry' / args.execution
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    allocation = None
    result = {'execution': args.execution, 'image': image, 'passed': False,
              'full_qualification': False, 'connected_services_qualified': False,
              'failures': [], 'sourceWrapperSha256': digest(Path(__file__).read_bytes())}
    receipt = None
    try:
        manifest, files = source_packet()
        manifest['execution'] = args.execution
        manifest['image'] = image
        manifest['ordinary_user'] = args.ordinary_user
        manifest['tournament'] = args.tournament
        allocation = Path(tempfile.mkdtemp(prefix='spin5-', dir='/tmp')).resolve()
        allocation.chmod(0o700)
        result['allocation'] = str(allocation)
        manifest_bytes = stage_packet(allocation, manifest, files)
        result['sourceManifestSha256'] = digest(manifest_bytes)
        receipt = qualify(args, allocation, manifest_bytes, manifest, PG)
        result['cleanupVerified'] = receipt['cleanup_verified']
        retained_evidence(allocation / 'work', output, receipt, manifest_bytes)
        validate_receipt(receipt, args.execution, args.ordinary_user, args.tournament, image,
                         digest(manifest_bytes), allocation / 'source', PG)
        for case in receipt['business_cases']:
            original = read_regular(allocation / 'work' / case['result_path'], 33554432)
            require(digest(original) == case['result_sha256'], 'original case receipt digest mismatch')
        # Evidence is retained before removal; uncertain/failed allocations stay.
        shutil.rmtree(allocation)
        require(not allocation.exists(), 'owned temporary allocation removal unobserved')
        result['ownedDirectoryRemoved'] = True
        result['passed'] = True
    except BaseException as error:
        result['failures'].append({'type': type(error).__name__, 'message': str(error)})
        # If interruption occurred inside the qualifier, its finally already
        # performed the single owned cleanup and preserved the original outcome.
        if allocation is not None and (allocation / 'work/receipt.json').is_file() and receipt is None:
            try:
                receipt = decode(read_regular(allocation / 'work/receipt.json', 1048576))
                retained_evidence(allocation / 'work', output, receipt, manifest_bytes)
            except BaseException as evidence_error:
                result['failures'].append({'stage': 'retain_evidence', 'message': str(evidence_error)})
    finally:
        (output / 'RESULT.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'passed': result['passed'], 'execution': args.execution, 'image': image,
                      'evidence': str(output), 'full_qualification': False}), flush=True)
    return 0 if result['passed'] else 1


def source_controls():
    path = Path(__file__).with_name('test_spin_expiry_wrapper.py')
    spec = importlib.util.spec_from_file_location('spin_expiry_wrapper_tests', path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromModule(module)).wasSuccessful()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-test', action='store_true', help='bounded source controls only; no PostgreSQL')
    args = parser.parse_args()
    if not source_controls(): return 1
    if args.self_test: return 0
    require(sys.platform == 'linux' and os.geteuid() != 0, 'ordinary non-root Linux hosted runner required')
    PG = find_pg()
    def interrupted(signum, _frame):
        raise AttemptCancelled('original CI command cancelled by signal ' + str(signum))
    for image in IMAGES:
        for sig in (signal.SIGINT, signal.SIGTERM): signal.signal(sig, interrupted)
        if run_image(image, PG) != 0: return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
