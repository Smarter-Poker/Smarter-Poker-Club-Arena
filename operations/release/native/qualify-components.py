#!/usr/bin/env python3
"""Owned semantic qualification; exact images/dist/schema, no publication.

The installed fixture image must implement the documented fixed fixture-server
interface. It supplies the offline auth/PostgREST/realtime/PostgreSQL services,
browser dependencies and fixture seeding. Absence is a capability failure, never
a reason to accept an artifact or a health response as semantic qualification.
The actual product oracle lives in the pinned controls, not that image or the
candidate. Each combination gets a fresh disposable fixture and exact image.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from contextlib import contextmanager

REPO = 'Smarter-Poker/Smarter-Poker-Club-Arena'
FIXTURE_SERVER = '/usr/local/bin/fixture-server'
CASES = ['exact-schema-catalogue', 'authenticated-web-bundle',
         'engine-browser-causal-hand', 'completed-hand-persisted',
         'spectator-does-not-acquire-seat']


def require(value, reason='RELEASE_COMPONENT_SEMANTIC_REFUSED'):
    if not value:
        raise RuntimeError(reason)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def fact_digest(value):
    return digest(canonical(value).encode())


def command(args, *, check=True, timeout=300, input=None):
    # No provider credential or source-controlled GIT_* setting reaches a
    # subprocess, even a trusted one. No candidate output is printed to logs.
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LANG': 'C.UTF-8',
           'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_SYSTEM': '/dev/null',
           'GIT_CONFIG_NOSYSTEM': '1', 'GIT_NO_REPLACE_OBJECTS': '1'}
    result = subprocess.run(args, input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, env=env, check=False)
    require(not check or result.returncode == 0, 'RELEASE_SEMANTIC_NATIVE_EXECUTION_FAILED')
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def provider(route, *, archive=None):
    require(route.startswith('/repos/' + REPO + '/'))
    request = urllib.request.Request('https://api.github.com' + route, headers={
        'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'})
    opener = urllib.request.build_opener(NoRedirect())
    try:
        response = opener.open(request, timeout=30)
    except urllib.error.HTTPError as error:
        require(archive is not None and error.code == 302, 'RELEASE_SEMANTIC_ARTIFACT_UNAVAILABLE')
        location = urllib.parse.urlparse(error.headers['Location'])
        require(location.scheme == 'https' and not location.username and not location.password and
                (location.hostname.endswith('.blob.core.windows.net') or
                 location.hostname.endswith('.actions.githubusercontent.com')))
        # Signed download URL receives no Authorization header; no redirect.
        response = opener.open(urllib.request.Request(location.geturl()), timeout=30)
    if archive is None:
        raw = response.read(2 * 1024 * 1024 + 1)
        require(len(raw) <= 2 * 1024 * 1024)
        return json.loads(raw)
    size = 0
    with archive.open('xb') as stream:
        while block := response.read(1024 * 1024):
            size += len(block)
            require(size <= 4 * 1024 * 1024 * 1024, 'RELEASE_SEMANTIC_ARTIFACT_TOO_LARGE')
            stream.write(block)


def file_digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        while block := stream.read(1024 * 1024):
            h.update(block)
    return h.hexdigest()


def download_artifact(provenance, output):
    for field in ('artifact_id', 'build_run_id'):
        require(re.fullmatch(r'[1-9][0-9]*', provenance[field]))
    info = provider(f'/repos/{REPO}/actions/artifacts/{provenance["artifact_id"]}')
    require(str(info['id']) == provenance['artifact_id'] and not info['expired'] and
            str(info['workflow_run']['id']) == provenance['build_run_id'] and
            info['digest'] == provenance['archive_digest'], 'RELEASE_SEMANTIC_ARTIFACT_PROVENANCE_MISMATCH')
    provider(f'/repos/{REPO}/actions/artifacts/{provenance["artifact_id"]}/zip', archive=output)
    require('sha256:' + file_digest(output) == provenance['archive_digest'],
            'RELEASE_SEMANTIC_ARTIFACT_DIGEST_MISMATCH')


def validate_zip(path):
    # Never blindly extract candidate paths/symlinks on the Actions host.
    with zipfile.ZipFile(path) as archive:
        names = set()
        for entry in archive.infolist():
            parts = Path(entry.filename).parts
            require(not entry.is_dir() and not entry.filename.startswith('/') and
                    '..' not in parts and '\\' not in entry.filename and
                    entry.filename not in names and (entry.external_attr >> 16) & 0o170000 in (0, 0o100000))
            require(entry.file_size <= 4 * 1024 * 1024 * 1024)
            names.add(entry.filename)
        return names


def unpack_engine(path, output, expected):
    require(validate_zip(path) == {'engine-image.tar'})
    with zipfile.ZipFile(path) as archive, output.open('xb') as target:
        with archive.open('engine-image.tar') as source:
            while block := source.read(1024 * 1024):
                target.write(block)
    command(['docker', 'load', '--input', str(output)], timeout=600)
    image = json.loads(command(['docker', 'image', 'inspect', expected['identity']]).stdout)[0]
    require(image['Id'] == expected['identity'] and
            image['Config']['Labels'].get('org.opencontainers.image.revision') == expected['source_sha'],
            'RELEASE_SEMANTIC_ENGINE_IMAGE_MISMATCH')


def supabase_hostname(value):
    require(isinstance(value, str) and re.fullmatch(r'[a-z0-9]{20}\.supabase\.co', value),
            'RELEASE_SEMANTIC_FIXTURE_HOSTNAME_REFUSED')
    return value


def validate_web(path, expected, supabase_host=None):
    names = validate_zip(path)
    require({'index.html', 'build-info.json', '.release-manifest.sha256'} <= names)
    with zipfile.ZipFile(path) as archive:
        require(all(item.file_size <= 64 * 1024 * 1024 for item in archive.infolist()))
        manifest = archive.read('.release-manifest.sha256')
        require(digest(manifest) == expected['manifest_digest'] and
                expected['identity'] == 'sha256:' + digest(manifest))
        covered = set()
        compiled_hosts = set()
        for line in manifest.decode().splitlines():
            match = re.fullmatch(r'([0-9a-f]{64})  (?:\./)?(.+)', line)
            require(match is not None)
            checksum, name = match.groups()
            require(name in names and name not in covered and name != '.release-manifest.sha256')
            content = archive.read(name)
            require(digest(content) == checksum)
            if name.endswith(('.js', '.html')):
                compiled_hosts.update(match.decode() for match in re.findall(
                    rb'(?<![a-z0-9.-])[a-z0-9]{20}\.supabase\.co(?![a-z0-9.-])', content))
            covered.add(name)
        require(covered == names - {'.release-manifest.sha256'})
        require(json.loads(archive.read('build-info.json'))['ca_sha'] == expected['source_sha'])
        if supabase_host is not None:
            require(supabase_hostname(supabase_host) in compiled_hosts,
                    'RELEASE_SEMANTIC_COMPILED_HOSTNAME_MISMATCH')


def validate_native(result, tuple_value, schema, runtime_image):
    readiness = result.get('engine_readiness', {})
    require(result.get('scope') == 'club-arena-product' and result.get('product_suite') == 'live-table-schema-v1' and
            result.get('tuple') == tuple_value and result.get('runtime_image') == runtime_image and
            result.get('schema_fixture_sha256') == schema['fixture_sha256'] and
            result.get('schema_catalogue_digest') == schema['catalogue_digest'] and
            result.get('success') is True and result.get('executed') == len(CASES) and
            result.get('failed') == 0 and result.get('skipped') == 0 and result.get('retries') == 0 and
            result.get('cases') == [{'name': name, 'passed': True} for name in CASES] and
            readiness.get('timeout_ms') == 90000 and
            type(readiness.get('elapsed_ms')) is int and 0 <= readiness['elapsed_ms'] <= 90000 and
            type(readiness.get('observations')) is int and readiness['observations'] > 0 and
            readiness.get('source_sha') == tuple_value['club-arena-engine']['source_sha'] and
            readiness.get('running') is True,
            'RELEASE_SEMANTIC_PRODUCT_EXECUTION_REQUIRED')


def validate_plan(plan):
    require(plan['version'] == 1 and len(plan['tuples']) == len(plan['cutover_order']) + 1)
    require(len(set(plan['cutover_order'])) == len(plan['cutover_order']) and
            sorted(plan['cutover_order']) == sorted(plan['component_builds']))
    current = plan['tuples'][0]
    for index, target in enumerate(plan['cutover_order']):
        require(target in ('club-arena-engine', 'club-arena-web'))
        expected = {**current, target: {key: value for key, value in plan['component_builds'][target].items()
                                       if key in ('source_sha', 'identity', 'manifest_digest')}}
        require(plan['tuples'][index + 1] == expected, 'RELEASE_SEMANTIC_MATRIX_MISMATCH')
        current = expected
    for tuple_value in plan['tuples']:
        require(sorted(tuple_value) == ['club-arena-engine', 'club-arena-web'])
        for target, component in tuple_value.items():
            key = fact_digest({'target': target, **component})
            input_value = plan['artifact_inputs'].get(key)
            require(input_value and all(input_value.get(k) == v for k, v in {'target': target, **component}.items()),
                    'RELEASE_SEMANTIC_COMPONENT_INPUT_MISSING')


@contextmanager
def candidate_image_cleanup(plan, report, output):
    identities = {value['identity'] for value in plan['artifact_inputs'].values()
                  if value['target'] == 'club-arena-engine'}
    try:
        yield
    finally:
        for identity in identities:
            command(['docker', 'image', 'rm', identity], check=False, timeout=30)
        remaining = command(['docker', 'image', 'ls', '--no-trunc', '--format', '{{.ID}}']).stdout.decode().splitlines()
        require(not identities.intersection(remaining), 'RELEASE_SEMANTIC_IMAGE_CLEANUP_REQUIRED')
        report['images_removed'] = True
        report['complete'] = all(item['complete'] for item in report['fixtures'])
        write_cleanup(output, report)


def write_cleanup(output, report):
    directory = output / 'cleanup'
    directory.mkdir(mode=0o700, exist_ok=True)
    (directory / 'receipt.json').write_text(canonical(report))


def qualify(request, operation, controls, output):
    require(re.fullmatch(r'[0-9a-f-]{36}', operation))
    require(request['phase'] == 'COMPATIBILITY' and request['repository'] == REPO and
            os.environ['GITHUB_REPOSITORY'] == REPO and os.environ['GITHUB_RUN_ATTEMPT'] == '1')
    runtime_image = request['runtime_image']
    require(re.fullmatch(r'[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}', runtime_image))
    require(command(['git', '-C', str(controls), 'rev-parse', 'HEAD']).stdout.decode().strip() == request['control_sha'])
    require(os.environ['GITHUB_SHA'] == request['control_sha'])
    plan = request['qualification']
    validate_plan(plan)
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    cleanup_report = {'version': 1, 'operation_id': operation, 'run_id': os.environ['GITHUB_RUN_ID'],
                      'run_attempt': 1, 'request_digest': fact_digest(plan), 'complete': False,
                      'images_removed': False, 'fixtures': []}
    write_cleanup(output, cleanup_report)
    jobs = provider(f'/repos/{REPO}/actions/runs/{os.environ["GITHUB_RUN_ID"]}/jobs?filter=latest&per_page=100')
    matches = [job for job in jobs['jobs'] if job['name'] == 'qualify' and job['status'] == 'in_progress']
    require(jobs['total_count'] == len(jobs['jobs']) and len(matches) == 1)
    job_id = str(matches[0]['id'])
    command(['docker', 'pull', runtime_image], timeout=600)
    capability = command(['docker', 'run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL',
                          '--security-opt=no-new-privileges', runtime_image,
                          FIXTURE_SERVER, 'capabilities'], check=False)
    require(capability.returncode == 0, 'RELEASE_SEMANTIC_FIXTURE_RUNTIME_CAPABILITY_REQUIRED')
    require(json.loads(capability.stdout) == {'version': 1, 'scope': 'isolated-club-arena-fixture',
            'product_suite': 'live-table-schema-v1', 'services': ['auth', 'postgresql', 'postgrest', 'realtime', 'tls-proxy'],
            'browser': 'chromium', 'fixture_credentials': 'synthetic-local-only'},
            'RELEASE_SEMANTIC_FIXTURE_RUNTIME_CAPABILITY_REQUIRED')
    combinations = []
    with candidate_image_cleanup(plan, cleanup_report, output), tempfile.TemporaryDirectory(prefix='component-semantic-') as temp_name:
        temp = Path(temp_name)
        (temp / 'plan.json').write_text(canonical(plan))
        download_artifact(plan['schema'], temp / 'schema.zip')
        require({'schema.sql', 'fixture.json'} <= validate_zip(temp / 'schema.zip'))
        with zipfile.ZipFile(temp / 'schema.zip') as archive:
            require(archive.getinfo('schema.sql').file_size <= 128 * 1024 * 1024)
            require(digest(archive.read('schema.sql')) == plan['schema']['fixture_sha256'])
            require(archive.getinfo('fixture.json').file_size <= 1024 * 1024)
            supabase_host = supabase_hostname(json.loads(archive.read('fixture.json'))['supabase_host'])
        for key, item in plan['artifact_inputs'].items():
            require(re.fullmatch(r'[0-9a-f]{64}', key))
            download_artifact(item, temp / (key + '.zip'))
            if item['target'] == 'club-arena-engine':
                unpack_engine(temp / (key + '.zip'), temp / (key + '.tar'), item)
            else:
                validate_web(temp / (key + '.zip'), item, supabase_host)
        # The host runner need not share the fixture UID. These are sanitized
        # immutable input artifacts, not runtime-generated service credentials.
        # Explicit read-only modes let UID1000 read the mount and UID1001 read
        # the plan; private fixture state remains in the fixture-owned tmpfs.
        temp.chmod(0o755)
        for item in temp.iterdir():
            require(item.is_file() and not item.is_symlink())
            item.chmod(0o444)
        for index, tuple_value in enumerate(plan['tuples']):
            prefix = f'release-semantic-{operation}-{index}'
            network, fixture, engine = prefix + '-network', prefix + '-fixture', prefix + '-engine'
            native = None
            cleanup_entry = {'index': index, 'tuple_digest': fact_digest(tuple_value), 'complete': False}
            cleanup_report['fixtures'].append(cleanup_entry)
            write_cleanup(output, cleanup_report)
            try:
                command(['docker', 'network', 'create', '--internal', network])
                require(json.loads(command(['docker', 'network', 'inspect', network]).stdout)[0]['Internal'] is True)
                web_key = fact_digest({'target': 'club-arena-web', **tuple_value['club-arena-web']})
                # The fixture owns only disposable services and exact static
                # bytes. No Docker socket, provider token, runner environment,
                # output directory or candidate checkout is mounted.
                command(['docker', 'run', '-d', '--name', fixture, '--network', network,
                         '--user', '1000:1000',
                         '--network-alias', 'fixture', '--network-alias', 'smarter.poker',
                         '--network-alias', 'ca-static.smarter.poker', '--network-alias', 'engine.smarter.poker',
                         '--network-alias', supabase_host,
                         '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only', '--pids-limit=1024',
                         '--sysctl', 'net.ipv4.ip_unprivileged_port_start=0',
                         '--memory=8g', '--cpus=2', '--tmpfs', '/tmp:rw,nosuid,size=2g,uid=1000,gid=1000,mode=1777',
                         '--tmpfs', '/run:rw,nosuid,size=2g,uid=1000,gid=1000',
                         '--tmpfs', '/var/lib/postgresql:rw,nosuid,size=4g,uid=1000,gid=1000',
                         '--mount', f'type=bind,source={temp},target=/inputs,readonly',
                         '--mount', f'type=bind,source={controls},target=/opt/qualification/controls,readonly',
                         runtime_image, FIXTURE_SERVER, 'start', '--schema=/inputs/schema.zip',
                         f'--web=/inputs/{web_key}.zip', '--engine=http://engine:8080'])
                command(['docker', 'exec', fixture, FIXTURE_SERVER, 'ready'], timeout=120)
                env = json.loads(command(['docker', 'exec', fixture, FIXTURE_SERVER, 'engine-environment']).stdout)
                require(set(env) == {'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'PORT', 'NODE_ENV'} and
                        env['SUPABASE_URL'] == 'http://fixture:8000' and env['PORT'] == '8080' and
                        env['NODE_ENV'] == 'production', 'RELEASE_SEMANTIC_FIXTURE_ENVIRONMENT_REFUSED')
                # These are synthetic offline fixture values, never production
                # credentials. The candidate receives no other environment.
                args = ['docker', 'run', '-d', '--name', engine, '--network', network, '--network-alias', 'engine',
                        '--user', '1000:1000', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                        '--pids-limit=1024', '--memory=6g', '--cpus=2',
                        '--tmpfs', '/tmp:rw,nosuid,size=2g,uid=1000,gid=1000,mode=1777']
                for key, value in env.items():
                    require(isinstance(value, str) and '\n' not in value and '\x00' not in value)
                    args.extend(['--env', f'{key}={value}'])
                args.append(tuple_value['club-arena-engine']['identity'])
                command(args)
                observed = json.loads(command(['docker', 'inspect', engine]).stdout)[0]
                require(observed['Image'] == tuple_value['club-arena-engine']['identity'])
                result = command(['docker', 'exec', '--user', 'qualification',
                                  '--env', 'HOME=/tmp/qualification', '--env', 'TMPDIR=/tmp',
                                  '--env', 'XDG_CACHE_HOME=/tmp/qualification/cache', fixture,
                                  '/opt/qualification/node_modules/.bin/tsx',
                                  '/opt/qualification/controls/operations/release/native/component-semantic-suite.mjs',
                                  str(index), runtime_image], timeout=240)
                lines = result.stdout.decode().splitlines()
                matches = [line.removeprefix('RELEASE_SEMANTIC_RESULT:') for line in lines
                           if line.startswith('RELEASE_SEMANTIC_RESULT:')]
                require(len(matches) == 1)
                native = json.loads(matches[0])
                validate_native(native, tuple_value, plan['schema'], runtime_image)
            finally:
                # Failed, crashed, intermediate and successful cases all close
                # the entire fixture. No receipt is emitted on cleanup failure.
                for name in (engine, fixture):
                    command(['docker', 'rm', '-f', name], check=False, timeout=30)
                command(['docker', 'network', 'rm', network], check=False, timeout=30)
                containers = command(['docker', 'container', 'ls', '--all', '--format', '{{.Names}}']).stdout.decode().splitlines()
                networks = command(['docker', 'network', 'ls', '--format', '{{.Name}}']).stdout.decode().splitlines()
                require(engine not in containers and fixture not in containers and network not in networks,
                        'RELEASE_SEMANTIC_FIXTURE_CLEANUP_REQUIRED')
                cleanup_entry.update({'complete': True, 'remaining_objects': 0})
                write_cleanup(output, cleanup_report)
            combinations.append({'tuple_digest': fact_digest(tuple_value),
                'schema_fixture_sha256': plan['schema']['fixture_sha256'],
                'component_builds_digest': fact_digest(plan['component_builds']),
                'success': True, 'executed': native['executed'], 'failed': 0, 'skipped': 0, 'retries': 0,
                'native': native, 'native_receipt_digest': 'sha256:' + fact_digest(native), 'job_id': job_id,
                'cleanup': {'complete': True, 'remaining_objects': 0}})
    receipt = {'version': 1, 'success': True, 'operation_id': operation, 'provider_request': request,
               'control_sha': request['control_sha'], 'runtime_image': runtime_image,
               'run_id': os.environ['GITHUB_RUN_ID'], 'run_attempt': 1, 'request': plan,
               'request_digest': fact_digest(plan), 'combinations': combinations, 'cleanup': cleanup_report}
    (output / 'receipt.json').write_text(canonical(receipt))


if __name__ == '__main__':
    try:
        qualify(json.loads(os.environ['RELEASE_REQUEST']), os.environ['RELEASE_OPERATION_ID'],
                Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
    except Exception as error:
        # Raw API errors may contain signed URLs; child errors may contain
        # fixture tokens. Keep logs and failure reasons strictly sanitized.
        reason = str(error) if re.fullmatch(r'RELEASE_[A-Z_]+', str(error)) else 'RELEASE_SEMANTIC_EXECUTION_FAILED'
        print(reason, file=sys.stderr)
        sys.exit(1)
