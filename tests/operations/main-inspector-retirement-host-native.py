"""Owned-fixture adapter: real host wrapper, disk/lock/pipe/alarm and native Docker.

Only host-only authority (systemd/sealed predecessor and root-owned fixture files)
is supplied here. Never invoked by production and accepts only the isolated
container identity already checked by the existing container qualification.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from types import SimpleNamespace
from unittest.mock import patch

repo = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('native_host', repo / 'server/scripts/main-inspector-retirement.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
root, container, image, scenario = Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
assert root.is_absolute() and root.is_dir() and not root.is_symlink()
assert re.fullmatch(r'[0-9a-f]{64}', container)
assert re.fullmatch(r'sha256:[0-9a-f]{64}', image)
assert scenario in {'success', 'deferred-close-timeout'}
run, invocation, control_sha = '41119520418-1', 'a' * 32, 'b' * 40
control = root / 'control'
lock = root / 'engine.lock'
lock.touch(exist_ok=False)
request = root / (run + '.request')
request.write_text('\n'.join(['c' * 40, 'fixture', 'fixture', str(control), control_sha, str(int(time.time()) + 60)]) + '\n')
(control / 'control-sha').write_text(control_sha)
actual_run, actual_fstat, actual_lstat = subprocess.run, os.fstat, Path.lstat

def command(args, **kwargs):
    if args[0] == 'systemctl':
        return SimpleNamespace(stdout=f'InvocationID={invocation}\nActiveState=activating\nSubState=start\n'.encode())
    if args[0].endswith('engine-release-seal.py'):
        return SimpleNamespace(stdout=((host.SOURCE if args[-1] == 'desired-sha' else image) + '\n').encode())
    assert args[:2] == ['docker', 'inspect'] and args[-1] == 'club-arena-engine'
    return actual_run(args[:-1] + [container], **kwargs)

def health(_url, timeout):
    assert _url == 'http://127.0.0.1:8080/health'
    expression = "const r=require('node:http').get('http://127.0.0.1:8080/host-health',s=>{let b='';s.on('data',c=>b+=c);s.on('end',()=>{if(s.statusCode!==200)process.exit(2);process.stdout.write(b)})});r.on('error',()=>process.exit(3))"
    value = actual_run(['docker', 'exec', container, 'node', '--no-inspect', '-e', expression],
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout).stdout
    return io.BytesIO(value)

def owned_stat(value):
    fields = list(value); fields[4] = 0
    return os.stat_result(fields)

def lstat(path, *args, **kwargs):
    value = actual_lstat(path, *args, **kwargs)
    return owned_stat(value) if path == request else value

out, err = io.StringIO(), io.StringIO()
fd = os.open(lock, os.O_RDWR)
os.dup2(fd, 9)
started = time.monotonic()
saved_stderr = os.dup(2)
read_stderr, write_stderr = os.pipe()
os.dup2(write_stderr, 2)
os.close(write_stderr)
try:
    with patch.object(host, 'CONTROL', control), patch.object(host, 'IMAGE', image), \
         patch.object(sys, 'argv', ['host.py', run, invocation]), \
         patch.dict(os.environ, {'ENGINE_LOCK_FILE': str(lock), 'ENGINE_RELEASE_REQUEST_ROOT': str(root)}), \
         patch.object(os, 'geteuid', return_value=0), \
         patch.object(os, 'fstat', side_effect=lambda n: owned_stat(actual_fstat(n))), \
         patch.object(Path, 'lstat', lstat), \
         patch.object(subprocess, 'run', side_effect=command), \
         patch.object(host.urllib.request, 'urlopen', side_effect=health), \
         contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = host.retire()
finally:
    os.dup2(saved_stderr, 2)
    os.close(saved_stderr)
    error_bytes = os.read(read_stderr, 4096)
    os.close(read_stderr)
    if fd != 9: os.close(fd)
    os.close(9)
elapsed = (time.monotonic() - started) * 1000
intent = root / (run + '.main-inspector-retirement-intent')
receipt = root / (run + '.main-inspector-retirement-receipt')
# The host publishes its bounded, redacted failure facts directly to fd 2,
# not redirect_stderr's StringIO. Keep those facts when an earlier admission
# predicate fails, without changing any acceptance condition or deadline.
assertion_facts = {
    'code': code,
    'intentPresent': intent.is_file(),
    'receiptPresent': receipt.exists(),
    'elapsedMs': round(elapsed, 3),
    'hostDiagnostic': error_bytes.decode('ascii', errors='replace'),
    'adapterStderr': err.getvalue()[:4096],
}
if scenario == 'success':
    assert code == 0 and receipt.is_file(), assertion_facts
    outcome = json.loads(receipt.read_text())['outcome']
else:
    assert code == 1 and intent.is_file() and not receipt.exists(), assertion_facts
    lines = error_bytes.decode('ascii').splitlines()
    diagnostic = json.loads(lines[0])
    assert diagnostic['intent'] == 'durable' and diagnostic['ack'] == 'flushed', diagnostic
    assert diagnostic['childExit'] == 'nonzero', diagnostic
    outcome = diagnostic['native']
    assert outcome['stage'] == 'native_close' and outcome['reason'] == 'deadline_exhausted', diagnostic
    assert outcome['closeRequested'] is True and outcome['closeAcknowledged'] is True, diagnostic
    assert outcome['connectionClosed'] is False and outcome['listenerAbsent'] is None, diagnostic
assert elapsed < 19700, f'host has no positive20s receipt margin: {elapsed}'
print(json.dumps({'code': code, 'outcome': outcome, 'elapsedMs': elapsed,
                  'hostDeadlineMs': 20000, 'extraOuterGraceMs': 0,
                  'intentDurable': intent.is_file(), 'receiptPresent': receipt.is_file()}))
