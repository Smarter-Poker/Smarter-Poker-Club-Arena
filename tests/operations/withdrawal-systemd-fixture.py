#!/usr/bin/env python3
"""Linux-only isolated qualification of the loaded masked-unit stop boundary."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('withdrawal_fixture', ROOT / 'scripts/ci/withdraw-waiting-engine-release.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def run(args, timeout=10):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=True).stdout.strip()


def wait_for(predicate, seconds=8):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if predicate(): return
        time.sleep(0.05)
    raise AssertionError('Owned dummy unit did not reach the required state')


def main():
    assert os.getuid() == 0
    print('Isolated systemd version: ' + run(['systemctl', 'show', '--property=Version']), flush=True)  # Missing real systemd fails qualification.
    key = '17-1'
    prefix = 'mtt-withdrawal-fixture-' + uuid.uuid4().hex
    template = Path('/etc/systemd/system') / (prefix + '@.service')
    unit = prefix + '@' + key + '.service'
    mask = template.with_name(unit)
    group = None
    with tempfile.TemporaryDirectory(prefix=prefix + '-', dir=os.environ.get('RUNNER_TEMP') or os.environ.get('TMPDIR')) as directory:
        parent = Path(directory)
        wrapper = parent / 'engine-release-unit-wrapper-v1.sh'
        wrapper.write_text('#!/bin/bash\nif [ "$1" = start ]; then exec /bin/sleep 90; fi\nexit 0\n')
        wrapper.chmod(0o755)
        template.write_text('[Unit]\nDescription=Isolated withdrawal qualification\n[Service]\nType=oneshot\n'
                            + 'ExecStart=' + str(wrapper) + ' start %i\n'
                            + 'ExecStopPost=' + str(wrapper) + ' recover %i ${SERVICE_RESULT} ${EXIT_CODE} ${EXIT_STATUS}\n'
                            + 'KillMode=control-group\nTimeoutStopSec=10\nRestart=on-failure\nRestartSec=1\n')
        try:
            run(['systemctl', 'daemon-reload'])
            run(['systemctl', 'start', '--no-block', unit])
            wait_for(lambda: run(['systemctl', 'show', unit, '-p', 'MainPID', '--value']) not in {'', '0'})
            group = run(['systemctl', 'show', unit, '-p', 'ControlGroup', '--value'])
            # Normalize only the unique fixture template name. All real loaded
            # commands, flags, drop-ins and stop-propagation fields are unchanged.
            def command(args, timeout=5):
                raw = run(args, timeout)
                if args[:2] == ['systemctl', 'show'] and '-p' in args:
                    wanted = {args[i + 1] for i, value in enumerate(args[:-1]) if value == '-p'}
                    returned = {line.split('=', 1)[0] for line in raw.splitlines() if '=' in line}
                    safe = lambda values: sorted(value for value in values if value.isascii() and value.isalnum() and len(value) <= 64)
                    print('Isolated loaded-property keys: ' + json.dumps({'requested': safe(wanted), 'returned': safe(returned), 'missing': safe(wanted - returned), 'extra': safe(returned - wanted)}), flush=True)
                return raw.replace(str(template), str(template.parent / 'club-arena-engine-release-v1@.service'))
            with patch.object(m, 'PARENT', parent), patch.object(m, 'command', side_effect=command):
                m.loaded_stop_contract(unit, key)
                mask.symlink_to('/dev/null'); m.fsync_directory(mask.parent)
                run(['systemctl', 'daemon-reload'])
                assert run(['systemctl', 'show', unit, '-p', 'LoadState', '--value']) == 'masked'
                m.loaded_stop_contract(unit, key, allow_masked=True)
                run(['systemctl', 'stop', '--no-block', unit])
                wait_for(lambda: run(['systemctl', 'show', unit, '-p', 'ActiveState', '--value']) in {'inactive', 'failed'})
                assert run(['systemctl', 'show', unit, '-p', 'MainPID', '--value']) == '0'
                assert m.cgroup_empty(group)
                # A subsequent start is refused by the persistent instance mask.
                refused = subprocess.run(['systemctl', 'start', unit], capture_output=True, timeout=5)
                assert refused.returncode != 0
                assert run(['systemctl', 'show', unit, '-p', 'MainPID', '--value']) == '0'
        finally:
            # These names are unique and this fixture created every selected file.
            try:
                try:
                    stopped = subprocess.run(['systemctl', 'stop', unit], capture_output=True, timeout=15)
                    stop_failed = stopped.returncode != 0
                except subprocess.TimeoutExpired:
                    stop_failed = True
                if stop_failed:
                    subprocess.run(['systemctl', 'kill', '--kill-whom=all', '--signal=KILL', unit], capture_output=True, timeout=5)
                if group is not None:
                    wait_for(lambda: m.cgroup_empty(group))
            finally:
                mask.unlink(missing_ok=True); template.unlink(missing_ok=True)
                run(['systemctl', 'daemon-reload'])
                subprocess.run(['systemctl', 'reset-failed', unit], capture_output=True, timeout=5)
    print('Real Linux masked stop and empty cgroup qualification passed; owned fixture retired.')


if __name__ == '__main__': main()
