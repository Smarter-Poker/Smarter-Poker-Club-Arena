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
         'runtime-files.mjs', 'gateway.mjs', 'auth-fixture.mjs', 'actors.mjs',
         'seed-fixture.mjs', 'native-smoke.mjs', 'build-image.sh', 'smoke-image.sh')
PREFIX = 'operations/release/fixture/'


def require(value):
    if not value:
        raise RuntimeError('native_fixture_smoke_requirement_failed')


def command(args, cwd, env, timeout=120):
    process = subprocess.Popen(args, cwd=cwd, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        stdout, _ = process.communicate(timeout=timeout)
    except BaseException:
        # Stop the entire locally spawned command group, then clean exact Docker resources.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
        raise
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
                'browser': 'chromium', 'retries': 0}
    services = {'scope': 'native-service-smoke', 'postgres': '17.11',
                'extensions': 6, 'auth': '2.196.0', 'mfa': 'aal2',
                'postgrest': '14.5', 'realtime': '2.134.10',
                'change': 'observed', 'retries': 0}
    require(rows.count(observer) == 1 and rows.count(services) == 1)
    require('Native service smoke and container cleanup passed (not a product certificate).' in output.splitlines())
    return [observer, services]


def execute(repo, output, expected, run=command):
    receipt = {'version': 1, 'scope': 'draft-pr-native-service-smoke',
               'product_certificate': False, 'status': 'failed',
               'stage': 'source', 'cleanup': {'container_absent': False, 'image_removed': False}}
    output.mkdir(parents=True, exist_ok=True)
    env = {key: os.environ[key] for key in ('PATH', 'HOME') if key in os.environ}
    env.update({'LANG': 'C.UTF-8', 'GIT_CONFIG_GLOBAL': '/dev/null',
                'GIT_CONFIG_SYSTEM': '/dev/null', 'GIT_NO_REPLACE_OBJECTS': '1'})
    name = 'ca-fixture-smoke-' + uuid.uuid4().hex
    tag = 'club-arena-component-fixture:smoke-' + uuid.uuid4().hex
    env['FIXTURE_SMOKE_CONTAINER'] = name
    image_id = None
    build_started = False
    failed = False
    try:
        require(re.fullmatch('[0-9a-f]{40}', expected))
        revision = run(['git', 'rev-parse', 'HEAD'], repo, env).strip()
        require(revision == expected)
        run(['git', 'diff', '--exit-code', 'HEAD', '--', PREFIX], repo, env)
        manifest = {}
        for file in FILES:
            path = repo / PREFIX / file
            require(path.is_file() and not path.is_symlink())
            run(['git', 'ls-files', '--error-unmatch', PREFIX + file], repo, env)
            manifest[PREFIX + file] = hashlib.sha256(path.read_bytes()).hexdigest()
        receipt.update({'control_revision': revision, 'source_revision': revision,
                        'source_sha256': manifest, 'container': name})
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
    except Exception:
        # Never serialize command output, environment, service logs, or tokens.
        failed = True
    finally:
        try:
            # Exact caller-owned name, never a broad prune or container scan.
            ids = run(['docker', 'container', 'ls', '-aq', '--filter', 'name=^/' + name + '$'], repo, env).split()
            if ids:
                run(['docker', 'container', 'rm', '--force', name], repo, env)
                failed = True  # Smoke did not itself finish cleanup.
            require(not run(['docker', 'container', 'ls', '-aq', '--filter', 'name=^/' + name + '$'], repo, env).strip())
            receipt['cleanup']['container_absent'] = True
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
