#!/usr/bin/env python3
"""Credential-free candidate tests/build; runs only on an isolated Actions runner.

Candidate code sees a read-only Git archive and container-local scratch. It
cannot read the runner environment, control checkout, Docker socket, receipt
output or Actions artifact credentials. This script never stages or publishes.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def require(condition):
    if not condition:
        raise RuntimeError('RELEASE_QUALIFICATION_CONTRACT_REFUSED')


def run(args, **kwargs):
    return subprocess.run(args, check=True, timeout=1800, **kwargs)


def text(args):
    return run(args, stdout=subprocess.PIPE).stdout.decode().strip()


def qualify(request, operation_id, source, controls, output):
    require(re.fullmatch(r'[0-9a-f-]{36}', operation_id))
    require(request['phase'] in ('VALIDATION', 'BUILD'))
    require(all(re.fullmatch(r'[0-9a-f]{40}', request[k]) for k in
                ('source_sha', 'accepted_head_sha', 'expected_base_sha', 'tested_tree_sha', 'control_sha')))
    require(re.fullmatch(r'node:22[^@\s]*@sha256:[0-9a-f]{64}', request['runtime_image']))
    require(request['components'] == ['club-arena-engine'])
    require(text(['git', '-C', str(controls), 'rev-parse', 'HEAD']) == request['control_sha'])
    require(text(['git', '-C', str(source), 'rev-parse', 'HEAD']) == request['source_sha'])
    require(text(['git', '-C', str(source), 'rev-parse', 'HEAD^{tree}']) == request['tested_tree_sha'])
    if request['phase'] == 'VALIDATION':
        require(text(['git', '-C', str(source), 'show', '-s', '--format=%P', 'HEAD']).split() ==
                [request['expected_base_sha'], request['accepted_head_sha']])
    dockerfile = text(['git', '-C', str(source), 'show', 'HEAD:server/Dockerfile'])
    bases = re.findall(r'^FROM\s+(\S+)\s*$', dockerfile, re.MULTILINE)
    require(bases == [request['runtime_image']])
    server_tree = text(['git', '-C', str(source), 'rev-parse', 'HEAD:server'])
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    run(['node', str(controls / 'operations/release/engine-doors-manifest.mjs'), str(source / 'server/src'), str(output / 'doors.json')])
    doors = json.loads((output / 'doors.json').read_text())
    artifact = {'components': {}}
    with tempfile.TemporaryDirectory(prefix='candidate-qualification-') as temp:
        temp = Path(temp)
        archive = temp / 'server.tar'
        run(['git', '-C', str(source), 'archive', '--format=tar', '--output=' + str(archive), server_tree])
        name = 'release-test-' + operation_id
        # No candidate-provided command or environment key is interpolated.
        args = ['docker', 'run', '--name', name, '--user', '1000:1000', '--cap-drop=ALL',
                '--security-opt=no-new-privileges', '--pids-limit=512', '--memory=6g', '--cpus=2',
                '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=5g,mode=1777',
                '--mount', f'type=bind,source={archive},target=/source.tar,readonly',
                '--env', 'HOME=/tmp', '--env', 'CI=true', request['runtime_image'],
                'sh', '-eu', '-c', 'mkdir /tmp/source; cd /tmp/source; tar -xf /source.tar; '
                'npm ci --include=dev --no-audit --no-fund; '
                './node_modules/.bin/tsc --noEmit; ./node_modules/.bin/vitest run']
        try:
            run(args)
        finally:
            subprocess.run(['docker', 'rm', '-f', name], timeout=30, check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if request['phase'] == 'BUILD':
            image = 'club-arena-release-candidate:' + operation_id
            environment = {**os.environ, 'ENGINE_BUILD_CONTEXT_ROOT': str(temp / 'build'),
                           'ENGINE_BUILD_LOCK_FILE': str(temp / 'build.lock')}
            try:
                # Frozen existing build contract, executed from pinned controls.
                run(['bash', str(controls / 'server/scripts/build-engine-image.sh'),
                     str(source), request['source_sha'], image], env=environment)
                identity = text(['docker', 'image', 'inspect', '-f', '{{.Id}}', image])
                require(re.fullmatch(r'sha256:[0-9a-f]{64}', identity))
                archive = output / 'engine-image.tar'
                run(['docker', 'save', '--output', str(archive), image])
                h = hashlib.sha256()
                with archive.open('rb') as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b''):
                        h.update(block)
                artifact['components']['club-arena-engine'] = {
                    'identity': identity, 'archive_digest': 'sha256:' + h.hexdigest(), 'archive_bytes': archive.stat().st_size,
                    'server_tree_sha': server_tree, 'build_contract': 'clean-server-archive-v1',
                    'artifact_name': 'release-engine-' + operation_id}
            finally:
                subprocess.run(['docker', 'image', 'rm', image], timeout=30, check=False,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    receipt = {'operation_id': operation_id, 'control_sha': request['control_sha'],
               'run_id': os.environ['GITHUB_RUN_ID'], 'success': True, 'request': request, 'database_doors': doors}
    if request['phase'] == 'BUILD':
        receipt['artifact'] = artifact
    (output / 'receipt.json').write_text(json.dumps(receipt, separators=(',', ':')))


if __name__ == '__main__':
    qualify(json.loads(os.environ['RELEASE_REQUEST']), os.environ['RELEASE_OPERATION_ID'],
            Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve())
