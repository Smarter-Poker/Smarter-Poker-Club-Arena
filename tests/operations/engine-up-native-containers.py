#!/usr/bin/env python3
"""Isolated real-Docker qualification; never points at a production daemon.

Requires the GitHub-hosted Docker daemon and explicit scratch/source paths.
All containers and the temporary image carry a unique fixture label. The
launcher receives dummy configuration and a fixture-only release authority.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import time
import urllib.request
import uuid


def require(value, message):
    if not value:
        raise AssertionError(message)


def run(args, timeout=30, check=True, **kwargs):
    return subprocess.run(args, text=True, capture_output=True, timeout=timeout,
                          check=check, **kwargs)


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def response(port, expected):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=1) as reply:
                if reply.read().decode() == expected:
                    return
        except OSError:
            pass
        time.sleep(.05)
    raise AssertionError(f'fixture HTTP owner did not become {expected}')


SERVER = """const http=require('http'),fs=require('fs');
try {fs.writeFileSync('/var/lib/club-arena/engine-alerts/native-started','started')} catch(e) {if(e.code!=='ENOENT')throw e}
const server=http.createServer((q,r)=>r.end(process.env.PROBE_ID||'candidate'));
server.listen(8080,'0.0.0.0');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
"""

# The wrapper only adds bounded barriers around the real Docker CLI. Thus
# serial stop-then-create cannot accidentally pass as overlapping execution.
WRAPPER = r'''#!/usr/bin/env python3
import os,pathlib,subprocess,sys,time
a=sys.argv[1:]; root=pathlib.Path(os.environ['NATIVE_HANDSHAKE'])
def mark(n): (root/n).write_text('observed\n')
def wait(n):
    end=time.monotonic()+10
    while not (root/n).exists():
        if time.monotonic()>end: raise RuntimeError('missing overlap edge '+n)
        time.sleep(.02)
if a and a[0]=='stop':
    mark('stop-entered'); wait('create-returned')
elif a and a[0]=='create':
    mark('create-entered'); wait('stop-entered')
elif a and a[0]=='start':
    if not (root/'stop-returned').exists(): raise RuntimeError('start preceded old process exit')
    mark('start-entered')
r=subprocess.run([os.environ['NATIVE_REAL_DOCKER'],*a])
if r.returncode==0 and a and a[0] in ('stop','create','start'): mark(a[0]+'-returned')
sys.exit(r.returncode)
'''


def main():
    # Defaults are this checkout's own maintained launcher and server image
    # recipe, so the calling workflow names no engine controller path (only
    # the sealed release transaction may; tests/engine-release-seal.law.test.ts).
    repo = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine-up', type=Path, default=repo / 'server' / 'scripts' / 'engine-up.sh')
    parser.add_argument('--dockerfile', type=Path, default=repo / 'server' / 'Dockerfile')
    parser.add_argument('--scratch-root', required=True, type=Path)
    args = parser.parse_args()
    require(os.environ.get('GITHUB_ACTIONS') == 'true', 'native fixture requires isolated GitHub Actions')
    require(not os.environ.get('DOCKER_HOST') and not os.environ.get('DOCKER_CONTEXT'),
            'caller-selected Docker endpoints are forbidden')
    docker = shutil.which('docker')
    require(docker is not None, 'real Docker qualification is required, never skipped')
    run([docker, 'info'])
    base = re.search(r'^FROM\s+(node:[^\s]+@sha256:[0-9a-f]{64})(?:\s|$)',
                     args.dockerfile.read_text(), re.MULTILINE)
    require(base is not None, 'server Dockerfile must provide its pinned Node base')
    require(args.engine_up.is_file(), 'actual maintained engine-up.sh is required')
    require(args.scratch_root.is_absolute() and args.scratch_root.is_dir(), 'explicit scratch root required')
    ident = uuid.uuid4().hex
    prefix = 'sp-native-' + ident
    label = 'sp.native.fixture=' + ident
    scratch = args.scratch_root / prefix
    scratch.mkdir(mode=0o700)
    image = prefix + ':fixture'
    sha = 'a' * 40
    report = {'fixture': ident, 'portCreateBeforeStop': False,
              'prematureStartRefused': False, 'actualLauncherOverlap': False}
    try:
        (scratch / 'server.cjs').write_text(SERVER)
        (scratch / 'Dockerfile').write_text(
            f'FROM {base[1]}\nWORKDIR /app\nCOPY server.cjs /app/server.cjs\n'
            f'LABEL sp.native.fixture="{ident}" sp.release.sha="{sha}"\n'
            'CMD ["node","/app/server.cjs"]\n')
        run([docker, 'build', '--label', label, '-t', image, str(scratch)], timeout=180)
        image_id = run([docker, 'image', 'inspect', '-f', '{{.Id}}', image]).stdout.strip()
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', image_id), 'exact image identity required')
        port = free_port()
        old, candidate = prefix + '-port-old', prefix + '-port-created'
        started = scratch / 'started'
        started.mkdir()
        common = ['--label', label, '--memory', '128m', '--cpus', '1',
                  '-p', f'127.0.0.1:{port}:8080']
        run([docker, 'run', '-d', '--name', old, *common, '-e', 'PROBE_ID=old', image_id])
        response(port, 'old')
        run([docker, 'create', '--name', candidate, *common,
             '--mount', f'type=bind,source={started},target=/var/lib/club-arena/engine-alerts', image_id])
        state = json.loads(run([docker, 'inspect', '-f', '{{json .State}}', candidate]).stdout)
        require(state['Status'] == 'created' and not state['Running'], 'create ran the application')
        require(not (started / 'native-started').exists(), 'create executed application code')
        response(port, 'old')
        report['portCreateBeforeStop'] = True
        # Prove port admission happens at start on a separate throwaway
        # container. Docker 29 leaves a container whose start was refused on
        # port allocation unable to publish that port on any later start
        # (measured: running, `docker port` empty, connection refused), so a
        # refused container must never be reused; the candidate never is.
        refused = prefix + '-port-refused'
        refused_started = scratch / 'refused-started'
        refused_started.mkdir()
        run([docker, 'create', '--name', refused, *common, '--mount',
             f'type=bind,source={refused_started},target=/var/lib/club-arena/engine-alerts', image_id])
        negative = run([docker, 'start', refused], check=False)
        require(negative.returncode != 0, 'premature start unexpectedly stole the serving port')
        require('port is already allocated' in negative.stderr,
                'premature start failed for a reason other than port admission: ' + negative.stderr)
        require(not (refused_started / 'native-started').exists(), 'failed port admission ran application')
        run([docker, 'rm', '-f', refused])
        response(port, 'old')
        report['prematureStartRefused'] = True
        run([docker, 'stop', '-t', '5', old])
        run([docker, 'start', candidate])
        published = run([docker, 'port', candidate, '8080/tcp']).stdout.strip()
        require(published == f'127.0.0.1:{port}', 'candidate did not publish the released port: ' + published)
        response(port, 'candidate')
        require((started / 'native-started').exists(), 'application did not start after old exit')
        run([docker, 'rm', '-f', old, candidate])

        # Exercise the actual launcher, not a reimplementation of its ordering.
        port = free_port()
        canonical = prefix + '-engine'
        run([docker, 'run', '-d', '--name', canonical, '--label', label,
             '-p', f'127.0.0.1:{port}:8080', '-e', 'PROBE_ID=old', image_id])
        response(port, 'old')
        env_file = scratch / 'dummy.env'
        env_file.write_text('PORT=8080\nPROBE_ID=candidate\n')
        seal = scratch / 'fixture-seal'
        seal.write_text(f'#!/bin/sh\nprintf "%s\\n" "desired {sha} {image_id}"\n')
        seal.chmod(0o700)
        bin_dir, handshake = scratch / 'bin', scratch / 'handshake'
        bin_dir.mkdir()
        handshake.mkdir()
        wrapper = bin_dir / 'docker'
        wrapper.write_text(WRAPPER)
        wrapper.chmod(0o700)
        env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ['PATH'],
                   CONTAINER=canonical, IMAGE=image_id, ENV_FILE=str(env_file),
                   PORT=f'127.0.0.1:{port}', ENGINE_RELEASE_SEAL=str(seal),
                   ENGINE_ALERT_JOURNAL_HOST_DIR=str(scratch / 'alerts'),
                   ENGINE_HORSE_JOURNAL_HOST_DIR=str(scratch / 'horse'),
                   LOG_DIR=str(scratch / 'logs'), LOCK_FILE=str(scratch / 'lock'),
                   NATIVE_HANDSHAKE=str(handshake), NATIVE_REAL_DOCKER=docker)
        # No inherited production authority or token can enter this fixture.
        for key in ('ENGINE_UP_LOCK_HELD', 'ENGINE_RELEASE_TOKEN', 'ENGINE_RELEASE_TOKEN_FD'):
            env.pop(key, None)
        result = run(['bash', str(args.engine_up.resolve())], env=env, timeout=40, check=False)
        (scratch / 'launcher.stdout').write_text(result.stdout)
        (scratch / 'launcher.stderr').write_text(result.stderr)
        require(result.returncode == 0, 'actual launcher failed its real-Docker overlap barriers: ' + result.stderr)
        require(all((handshake / edge).exists() for edge in
                    ('stop-entered', 'create-entered', 'create-returned', 'stop-returned', 'start-returned')),
                'actual launcher omitted an overlap or exit boundary')
        response(port, 'candidate')
        require((scratch / 'alerts' / 'native-started').exists(), 'canonical start did not reach application')
        report['actualLauncherOverlap'] = True
        report['imageId'] = image_id
        print(json.dumps(report, sort_keys=True))
    finally:
        # Only UUID-labelled fixture resources; never daemon-wide cleanup.
        listed = run([docker, 'ps', '-aq', '--filter', 'label=' + label], check=False).stdout.split()
        for container in listed:
            if re.fullmatch(r'[0-9a-f]{12,64}', container):
                run([docker, 'rm', '-f', container], check=False)
        run([docker, 'image', 'rm', image], check=False)
        (scratch / 'result.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
