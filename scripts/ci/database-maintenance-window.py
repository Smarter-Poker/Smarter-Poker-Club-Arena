#!/usr/bin/env python3
"""One finite database maintenance operation through the existing provider.

The same engine mutation flock stays held from reservation through v3 thaw.
No Docker image, process restart, database SQL or credential extraction lives here.
The original Node installer remains the only database writer.
"""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import types
import urllib.request

ROOT = Path('/var/lib/club-arena')
REPO = '/opt/club-arena'
ENGINE_LOCK = '/var/lock/club-arena-engine-up.lock'
SOURCE_LOCK = '/var/lock/club-arena-source.lock'
SCHEMA = 'database-maintenance/v1'


def require(ok, message='Database maintenance admission refused'):
    if not ok:
        raise ValueError(message)


def command(args, timeout=30):
    p = subprocess.run(args, check=True, capture_output=True, timeout=timeout)
    require(len(p.stdout) <= 1024 * 1024)
    return p.stdout.decode()


def health():
    with urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=5) as r:
        require(r.geturl() == 'http://127.0.0.1:8080/health')
        raw = r.read(1024 * 1024 + 1)
    require(len(raw) <= 1024 * 1024)
    return json.loads(raw)


def same_engine(h, request, instance):
    require(h.get('running') is True and h.get('releaseSha') == request['servingSha'])
    require(h.get('instanceId') == instance, 'Serving engine changed during database maintenance')


def freeze_certificate(h, request, instance, reservation):
    same_engine(h, request, instance)
    m = h.get('maintenance') or {}
    return (m.get('active') is True and m.get('phase') == 'counting_down'
        and m.get('durableConfirmed') is True and m.get('readyForRestart') is True
        and m.get('unparkedTables') == 0 and m.get('reason') == 'Deployment Recovery'
        and m.get('breakEndsAt') == reservation['endsAt'] and m.get('remainingMs', 0) >= 285000
        and (m.get('presentation') or {}).get('break_id') == reservation['announcedAt'])


def thaw_certificate(h, request, instance, reservation, now_ms):
    same_engine(h, request, instance)
    m = h.get('maintenance') or {}
    waves = m.get('resumeWaves') or {}
    end = reservation['endsAt']
    return (now_ms >= end and m.get('active') is False and m.get('phase') == 'idle'
        and waves.get('done') == waves.get('total') and isinstance(waves.get('total'), int)
        and waves['total'] > 0 and waves.get('startedAt', 0) >= end
        and waves.get('finishedAt', 0) >= end
        and (m.get('presentation') or {}).get('break_id') == reservation['announcedAt'])


def request_fixed_window(js, stamp, send=command):
    try:
        answer = json.loads(send(['docker', 'exec', 'club-arena-engine', 'node', '-e', js, str(stamp)], 20))
    except (subprocess.SubprocessError, ValueError):
        # Unknown acknowledgement is observed on the SAME stamp, never resent.
        return 'unknown'
    status = answer.get('status')
    require(status in ('accepted', 'active', 'pending'), 'Maintenance owner refused the fixed request')
    return status


def emit(value):
    print(json.dumps(value), flush=True)


def remote():
    request = json.loads(sys.stdin.readline(16384))
    require(set(request) == {'runId', 'controlSha', 'servingSha', 'windowId'})
    require(re.fullmatch(r'[0-9a-f]{40}', request['controlSha']) is not None)
    # Only fetch object/ref metadata under the existing source lock. Never reset
    # the checkout, replace control generations, or copy another task's files.
    with open(SOURCE_LOCK, 'a+') as source_lock:
        fcntl.flock(source_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        command(['git', '-C', REPO, 'fetch', '--no-tags', 'origin', 'main'])
    command(['git', '-C', REPO, 'merge-base', '--is-ancestor', request['controlSha'], 'origin/main'])
    own_source = command(['git', '-C', REPO, 'show', request['controlSha'] + ':scripts/ci/database-maintenance-window.py'])
    require(own_source == REMOTE_SOURCE, 'Host controller bytes differ from protected source')
    seal_source = command(['git', '-C', REPO, 'show', request['controlSha'] + ':server/scripts/engine-release-seal.py'])
    seal = types.ModuleType('database_release_seal')
    exec(compile(seal_source, 'qualified-engine-release-seal.py', 'exec'), seal.__dict__)
    with open(ENGINE_LOCK, 'a+') as engine_lock:
        fcntl.flock(engine_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # An older consumer does not know a new DB operation type. Holding its
        # existing flock prevents it mutating; do not steal an awaiting owner.
        require(not list((ROOT / 'engine-release-requests').glob('*.awaiting-certificate')),
                'An engine transaction is already awaiting its certificate')
        before = health()
        require(before.get('status') == 'ok' and before.get('liveness') == 'ok')
        require((before.get('maintenance') or {}).get('active') is False)
        instance = before.get('instanceId')
        require(isinstance(instance, str) and instance)
        same_engine(before, request, instance)
        reservation = seal.reserve_database_window(request, REPO)
        stamp = reservation['announcedAt']
        end = reservation['endsAt']
        result_path = ROOT / ('database-maintenance-result-' + request['runId'] + '.json')
        require(not result_path.exists(), 'Read the original terminal database receipt; never replay')
        receipt = {**reservation, 'schema': SCHEMA, 'instanceId': instance,
                   'controlSHA256': hashlib.sha256(own_source.encode()).hexdigest(),
                   'sealSHA256': hashlib.sha256(seal_source.encode()).hexdigest(),
                   'installer': 'unknown', 'thawed': False}
        # A lost SSH acknowledgement must not cancel the serving controller's
        # autonomous v3 thaw or release this mutation lock before that boundary.
        for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, signal.SIG_IGN)
        try:
            js = """const announcedAt=Number(process.argv[1]);
const key=process.env.INTERNAL_API_KEY;if(!key)process.exit(1);
fetch('http://127.0.0.1:8080/internal/maintenance-recovery-window',{
method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},
body:JSON.stringify({announcedAt,cause:'urgent'}),signal:AbortSignal.timeout(15000)
}).then(async r=>{const d=await r.json();if(!r.ok)process.exit(1);console.log(JSON.stringify(d));}).catch(()=>process.exit(1));"""
            request_fixed_window(js, stamp, command)
            emit({'phase': 'reserved', 'runId': request['runId'], 'announcedAt': stamp, 'endsAt': end})
            certified = False
            while int(time.time() * 1000) < end - 285000:
                h = health()
                same_engine(h, request, instance)
                if freeze_certificate(h, request, instance, reservation):
                    certified = True
                    break
                time.sleep(0.25)
            require(certified, 'Full 285-second drained/frozen reserve was not certified')
            emit({'phase': 'install', 'runId': request['runId'], 'endsAt': end})
            # The runner runs the existing installer now. A lost response is
            # UNKNOWN, never permission to allocate a new announcement.
            readable, _, _ = select.select([sys.stdin], [], [], max(0, (end - 100000) / 1000 - time.time()))
            if readable:
                line = sys.stdin.readline(4096)
                reply = json.loads(line) if line else {}
                if reply.get('runId') == request['runId'] and reply.get('installer') in ('passed', 'failed'):
                    receipt['installer'] = reply['installer']
        finally:
            # Always let the original runtime perform its v3 thaw. No manual
            # freeze clear, forced pause lift, restart, or deadline extension.
            while int(time.time() * 1000) < end + 90000:
                try:
                    h = health()
                    same_engine(h, request, instance)
                    if thaw_certificate(h, request, instance, reservation, int(time.time() * 1000)):
                        receipt['thawed'] = True
                        break
                except Exception:
                    pass
                time.sleep(1)
            if seal.database_container_identity() != {'imageId': reservation['imageId'], 'sha': request['servingSha'], 'running': True}:
                receipt['thawed'] = False
            receipt['result'] = 'completed' if receipt['thawed'] and receipt['installer'] == 'passed' else 'unproven'
            seal.write_json_atomic(result_path, receipt)
            emit({'phase': 'terminal', 'receipt': receipt})
        require(receipt['result'] == 'completed', 'Database maintenance receipt is unproven')


def runner():
    require(os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch')
    require(os.environ.get('GITHUB_REF') == 'refs/heads/main')
    window_id = os.environ.get('OWNER_WINDOW_ID', '')
    require(re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', window_id) is not None)
    preflight = subprocess.run(['node', 'scripts/ci/install-window-migrations.mjs', '--owner-window', window_id, '--preflight-only',
        '--ssl-root-cert', 'scripts/ci/certificates/supabase-prod-ca-2021.crt'], capture_output=True, text=True, timeout=30)
    require(preflight.returncode == 0, 'Migration read-only preflight refused; no break requested')
    if 'NOTHING QUEUED' in preflight.stdout:
        out = Path('artifacts/database-maintenance'); out.mkdir(parents=True, exist_ok=True)
        (out / 'receipt.json').write_text(json.dumps({'schema': SCHEMA, 'result': 'already-installed',
            'controlSha': os.environ['GITHUB_SHA'], 'windowId': window_id, 'noMaintenanceRequested': True}, indent=2) + '\n')
        print('Named migration already installed; no maintenance requested.'); return
    require('PREFLIGHT QUEUED' in preflight.stdout, 'Migration queue outcome is unknown')
    source = Path(__file__).read_text()
    request = {'runId': os.environ['GITHUB_RUN_ID'],
               'controlSha': os.environ['GITHUB_SHA'], 'windowId': window_id}
    # Public identity is independently bound again under the host lock.
    with urllib.request.urlopen('https://engine.smarter.poker/health', timeout=10) as r:
        request['servingSha'] = json.load(r)['releaseSha']
    host, key, pin = [os.environ.get(k, '') for k in ('HETZNER_HOST', 'HETZNER_SSH_PRIVATE_KEY', 'HETZNER_HOST_KEY')]
    require(re.fullmatch(r'[A-Za-z0-9.-]+', host) is not None and not host.startswith('-') and key.strip() and pin.strip())
    directory = Path(tempfile.mkdtemp(prefix='database-maintenance-', dir=os.environ['RUNNER_TEMP']))
    proc = None
    try:
        for name, content in [('key', key), ('known_hosts', pin)]:
            path = directory / name
            path.write_text(content + '\n')
            path.chmod(0o600)
        subprocess.run(['ssh-keygen', '-y', '-f', str(directory / 'key')], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(['ssh-keygen', '-l', '-f', str(directory / 'known_hosts')], check=True, stdout=subprocess.DEVNULL)
        bootstrap = 'import base64; s=base64.b64decode(' + repr(base64.b64encode(source.encode()).decode()) + ').decode(); exec(compile(s,"qualified-database-controller","exec"),{"__name__":"__main__","REMOTE_SOURCE":s})'
        import shlex
        args = ['ssh', '-i', str(directory / 'key'), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
                '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(directory / 'known_hosts'),
                '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=30',
                '-o', 'ServerAliveCountMax=10', 'root@' + host, 'python3 -c ' + shlex.quote(bootstrap)]
        proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        proc.stdin.write(json.dumps(request) + '\n'); proc.stdin.flush()
        deadline = time.monotonic() + 600
        terminal = None
        while time.monotonic() < deadline:
            readable, _, _ = select.select([proc.stdout], [], [], min(5, max(0, deadline - time.monotonic())))
            if not readable:
                require(proc.poll() is None, 'Host operation ended without its receipt')
                continue
            line = proc.stdout.readline()
            require(bool(line), 'Host operation outcome unknown; read original identity before retry')
            message = json.loads(line)
            if message.get('phase') == 'install':
                remaining = (message['endsAt'] - int(time.time() * 1000)) / 1000 - 100
                require(remaining >= 150, 'Installer admission reserve expired')
                result = subprocess.run(['node', 'scripts/ci/install-window-migrations.mjs', '--owner-window', window_id,
                    '--ssl-root-cert', 'scripts/ci/certificates/supabase-prod-ca-2021.crt'], timeout=remaining)
                proc.stdin.write(json.dumps({'runId': request['runId'], 'installer': 'passed' if result.returncode == 0 else 'failed'}) + '\n')
                proc.stdin.flush()
            elif message.get('phase') == 'terminal':
                terminal = message['receipt']; break
            else:
                require(message.get('phase') == 'reserved' and message.get('runId') == request['runId'])
        if terminal is not None:
            out = Path('artifacts/database-maintenance'); out.mkdir(parents=True, exist_ok=True)
            (out / 'receipt.json').write_text(json.dumps(terminal, indent=2) + '\n')
        require(terminal is not None and proc.wait(timeout=10) == 0)
        require(terminal.get('controlSHA256') == hashlib.sha256(source.encode()).hexdigest())
        require(terminal.get('sealSHA256') == hashlib.sha256(Path('server/scripts/engine-release-seal.py').read_bytes()).hexdigest())
        require(terminal['result'] == 'completed' and terminal['thawed'] is True)
        with urllib.request.urlopen('https://engine.smarter.poker/health', timeout=10) as r:
            public = json.load(r)
        same_engine(public, request, terminal['instanceId'])
        require((public.get('maintenance') or {}).get('active') is False)
        require(all(terminal.get(k) == v for k, v in request.items()))
        out = Path('artifacts/database-maintenance'); out.mkdir(parents=True, exist_ok=True)
        (out / 'receipt.json').write_text(json.dumps(terminal, indent=2) + '\n')
        print('One database maintenance operation completed; exact serving engine unchanged and thaw verified.')
    finally:
        if proc and proc.poll() is None:
            proc.stdin.close()
            try:
                proc.wait(timeout=600)
            except subprocess.TimeoutExpired:
                proc.terminate()
        shutil.rmtree(directory)


if __name__ == '__main__':
    try:
        remote() if 'REMOTE_SOURCE' in globals() else runner()
    except Exception as error:
        print('Database maintenance unproven: ' + str(error), file=sys.stderr)
        sys.exit(1)
