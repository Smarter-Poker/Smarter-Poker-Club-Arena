#!/usr/bin/env python3
"""Exact candidate frontend validation. No artifact selection or publication.

The registered immutable Node image must include Git and Python; this boundary
probes those capabilities and fails rather than dropping tests. Candidate code
only receives a read-only archive and disposable scratch, never runner secrets.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def require(value):
    if not value:
        raise RuntimeError('RELEASE_FRONTEND_QUALIFICATION_REFUSED')


def environment():
    return {**{k: v for k, v in os.environ.items() if not k.upper().startswith('GIT_')},
            'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_SYSTEM': '/dev/null',
            'GIT_CONFIG_NOSYSTEM': '1', 'GIT_NO_REPLACE_OBJECTS': '1'}


def run(args, **kwargs):
    return subprocess.run(args, check=True, timeout=3000, env=environment(), **kwargs)


def text(args):
    return run(args, stdout=subprocess.PIPE).stdout.decode().strip()


def qualify(request, operation_id, source, controls, output):
    require(re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', operation_id))
    require(request['phase'] == 'VALIDATION' and request['frontend_qualification_version'] == 1)
    require(request['components'] == ['club-arena-web'] and request['target'] == 'club-arena-web')
    require(request['repository'] == 'Smarter-Poker/Smarter-Poker-Club-Arena')
    require(all(re.fullmatch(r'[0-9a-f]{40}', request[k]) for k in
                ('source_sha', 'accepted_head_sha', 'expected_base_sha', 'tested_tree_sha', 'control_sha')))
    require(re.fullmatch(r'node:22[^@\s]*@sha256:[0-9a-f]{64}', request['runtime_image']))
    require(text(['git', '-C', str(controls), 'rev-parse', 'HEAD']) == request['control_sha'])
    require(text(['git', '-C', str(source), 'rev-parse', 'HEAD']) == request['source_sha'])
    require(text(['git', '-C', str(source), 'rev-parse', 'HEAD^{tree}']) == request['tested_tree_sha'])
    require(text(['git', '-C', str(source), 'show', '-s', '--format=%P', 'HEAD']).split() ==
            [request['expected_base_sha'], request['accepted_head_sha']])
    require(re.fullmatch(r'[1-9][0-9]*', os.environ['GITHUB_RUN_ID']))
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix='frontend-qualification-') as scratch:
        archive = Path(scratch) / 'source.tar'
        run(['git', '-C', str(source), 'archive', '--format=tar', '--output=' + str(archive), request['source_sha']])
        name = 'release-frontend-test-' + operation_id
        args = ['docker', 'run', '--name', name, '--user', '1000:1000', '--cap-drop=ALL',
                '--security-opt=no-new-privileges', '--pids-limit=1024', '--memory=8g', '--cpus=2',
                '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=12g,mode=1777',
                '--mount', f'type=bind,source={archive},target=/source.tar,readonly',
                '--env', 'HOME=/tmp', '--env', 'CI=true', '--env', 'GIT_CONFIG_GLOBAL=/dev/null',
                '--env', 'GIT_CONFIG_SYSTEM=/dev/null', '--env', 'GIT_CONFIG_NOSYSTEM=1',
                request['runtime_image'], 'sh', '-eu', '-c',
                'git --version; python3 --version; mkdir /tmp/source; cd /tmp/source; tar -xf /source.tar; '
                'npm ci --include=dev --no-audit --no-fund; '
                './node_modules/.bin/tsc --noEmit; ./node_modules/.bin/vitest run tests/; '
                './node_modules/.bin/eslint src/']
        try:
            run(args)
        finally:
            subprocess.run(['docker', 'rm', '-f', name], timeout=30, check=False, env=environment(),
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    receipt = {'frontend_qualification_version': 1, 'operation_id': operation_id,
               'control_sha': request['control_sha'], 'run_id': os.environ['GITHUB_RUN_ID'],
               'success': True, 'request': request, 'source_tree_sha': request['tested_tree_sha'],
               'checks': ['root-typecheck', 'root-vitest', 'frontend-lint']}
    (output / 'receipt.json').write_text(json.dumps(receipt, separators=(',', ':')))


if __name__ == '__main__':
    qualify(json.loads(os.environ['RELEASE_REQUEST']), os.environ['RELEASE_OPERATION_ID'],
            Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve())
