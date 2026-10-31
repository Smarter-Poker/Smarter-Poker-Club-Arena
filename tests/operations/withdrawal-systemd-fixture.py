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
    key = '41177442979-1'
    prefix = 'mtt-withdrawal-fixture-' + uuid.uuid4().hex
    template = Path('/etc/systemd/system') / (prefix + '@.service')
    unit = prefix + '@' + key + '.service'
    mask = template.with_name(unit)
    group = None
    intake_template = template.with_name(prefix + '-intake@.service')
    path_template = template.with_name(prefix + '-intake@.path')
    intake_unit = prefix + '-intake@' + key + '.service'
    path_unit = prefix + '-intake@' + key + '.path'
    other_masks = [template.with_name(intake_unit), template.with_name(path_unit)]
    with tempfile.TemporaryDirectory(prefix=prefix + '-', dir=os.environ.get('RUNNER_TEMP') or os.environ.get('TMPDIR')) as directory:
        parent = Path(directory)
        wrapper = parent / 'engine-release-unit-wrapper-v1.sh'
        generation = parent / 'engine-control-generations' / m.CANCEL_CONTROL
        generation.mkdir(parents=True)
        recovery = generation / 'engine-release-recover.sh'
        recovery.write_text('#!/bin/bash\nsleep 90\nexit 0\n')
        recovery.chmod(0o755)
        wrapper.write_text('#!/bin/bash\nif [ "$1" = start ]; then /bin/bash '+str(recovery)+' --run-id "$2" --mode retryable; fi\nexit 0\n')
        wrapper.chmod(0o755)
        template.write_text('[Unit]\nDescription=Isolated withdrawal qualification\n[Service]\nType=oneshot\n'
                            + 'ExecStart=' + str(wrapper) + ' start %i\n'
                            + 'ExecStopPost=' + str(wrapper) + ' recover %i ${SERVICE_RESULT} ${EXIT_CODE} ${EXIT_STATUS}\n'
                            + 'KillMode=control-group\nTimeoutStopSec=10\nRestart=on-failure\nRestartSec=1\n')
        intake_template.write_text('[Service]\nType=oneshot\nExecStart=/bin/true\n')
        path_template.write_text('[Path]\nPathExists='+str(parent/'never-created')+'\nUnit='+intake_unit+'\n')
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
                main_pid = int(run(['systemctl', 'show', unit, '-p', 'MainPID', '--value']))
                children_path = Path('/proc') / str(main_pid) / 'task' / str(main_pid) / 'children'
                wait_for(lambda: bool(children_path.read_text().strip()))
                children = children_path.read_text().split()
                assert len(children) == 1
                child = m.process(int(children[0]))
                assert child['parent'] == main_pid
                assert m.cancellation_child_class(child['argv'], key, {'originals': {}}) == 'pinned_announcement_recovery'
                assert m.cancellation_child_class(child['argv'], key, {'originals': {'engine-release-requests/'+key+'.awaiting-certificate':'present'}}) == 'unproven'
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
                # A real expired-style oneshot exits 75, then owns no process
                # during its exact 30-second restart delay. Never stop this case.
                mask.unlink(); run(['systemctl', 'daemon-reload'])
                recovery.write_text('#!/bin/bash\nexit 75\n')
                wrapper.write_text('#!/bin/bash\n/bin/bash '+str(recovery)+' --run-id "$2" --mode retryable\nrc=$?\nexit "$rc"\n')
                template.write_text(template.read_text().replace('RestartSec=1', 'RestartSec=30s'))
                run(['systemctl', 'daemon-reload'])
                # Reload may unload this stopped unique instance; start loads it.
                run(['systemctl', 'start', '--no-block', unit])
                wait_for(lambda: m.unit_snapshot(unit)['SubState'] == 'auto-restart')
                empty_state = m.unit_snapshot(unit)
                assert empty_state['MainPID'] == '0'
                m.loaded_stop_contract(unit, key)
                m.empty_retry_admission(unit, empty_state, key, {'originals': {}})
                bindings = {service: m.configured_service_cgroup(service, m.unit_snapshot(service, service_context=True))
                            for service in [unit, intake_unit]}
                for other in [intake_unit, path_unit]:
                    empty_other = m.prove_unit_empty(other)
                    assert empty_other['ActiveState'] in {'inactive', 'failed'}
                assert m.unit_snapshot(path_unit)['MainPID'] is None
                for other_mask in other_masks: other_mask.symlink_to('/dev/null')
                mask.symlink_to('/dev/null'); m.fsync_directory(mask.parent)
                run(['systemctl', 'daemon-reload'])
                wait_for(lambda: m.unit_snapshot(unit)['ActiveState'] in {'inactive', 'failed'}, seconds=35)
                m.quiet_units([unit, intake_unit, path_unit], empty_state['ControlGroup'] or None, native_empty=True, bindings=bindings)
                m.loaded_stop_contract(unit, key, allow_masked=True, bindings=bindings)
                closed = m.prove_unit_empty(unit, bindings)
                assert closed['MainPID'] == '0'
                if empty_state['ControlGroup']: assert m.cgroup_empty(empty_state['ControlGroup'])
                assert run(['systemctl', 'show', unit, '-p', 'LoadState', '--value']) == 'masked'
                print('Real Linux 30-second auto-restart empty admission and natural masked quiescence passed without stop.', flush=True)
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
                for owned in [*other_masks, intake_template, path_template]: owned.unlink(missing_ok=True)
                run(['systemctl', 'daemon-reload'])
                subprocess.run(['systemctl', 'reset-failed', unit], capture_output=True, timeout=5)
    print('Real Linux masked stop and empty cgroup qualification passed; owned fixture retired.')


if __name__ == '__main__': main()
