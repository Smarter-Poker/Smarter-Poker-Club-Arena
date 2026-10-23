#!/usr/bin/env python3
"""Run the REAL engine-crash-drill.sh against a stubbed host.

The serving "engine" is a real child process. The only mutation the drill may
make is SIGKILL to that process; the stubbed Docker answers from whether that
process is still alive, exactly as a supervisor would observe it. Every other
host fact (seal, systemd units, /health, database witnesses) is scripted.
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'server/scripts'
SHA = 'a' * 40
OTHER = 'b' * 40
IMAGE = 'sha256:' + 'c' * 64
BEFORE_INSTANCE = '1-aaaaaaaa'
AFTER_INSTANCE = '1-bbbbbbbb'

DOCKER = r'''#!/usr/bin/env python3
import json, os, subprocess, sys
state = json.load(open(os.environ['DRILL_TEST_STATE']))
def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    try:
        stat = open(f'/proc/{pid}/stat').read().split()[2]
        return stat != 'Z'
    except OSError:
        result = subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True)
        return result.returncode == 0 and bool(result.stdout.strip()) and not result.stdout.strip().startswith('Z')
args = sys.argv[1:]
if args[:2] != ['container', 'inspect'] or args[2] != '-f':
    raise SystemExit(2)
fmt, name = args[3], args[4]
if name == 'sp-autoheal':
    print(state['autoheal']); raise SystemExit(0)
killed = not alive(state['pid'])
restarted = killed and state['restart']
facts = {
    '{{.State.Status}}': 'running' if (not killed or restarted) else 'exited',
    '{{index .Config.Labels "sp.release.sha"}}': state['label'],
    '{{.Image}}': state['image'],
    '{{.HostConfig.RestartPolicy.Name}}': state['policy'],
    '{{index .Config.Labels "autoheal"}}': 'true',
    '{{.Id}}': 'container-1',
    '{{.State.StartedAt}}': '2026-10-17T12:00:00Z' if restarted else '2026-10-17T10:00:00Z',
    '{{.RestartCount}}': '4' if restarted else '3',
    '{{.State.Pid}}': '999999' if restarted else str(state['pid']),
}
print(facts[fmt])
'''

CURL = r'''#!/usr/bin/env python3
import json, os, subprocess, sys, time
state_path = os.environ['DRILL_TEST_STATE']
state = json.load(open(state_path))
url = sys.argv[-1]
def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    try:
        return open(f'/proc/{pid}/stat').read().split()[2] != 'Z'
    except OSError:
        result = subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True)
        return result.returncode == 0 and bool(result.stdout.strip()) and not result.stdout.strip().startswith('Z')
killed = not alive(state['pid'])
now = int(time.time() * 1000)
if killed and not state['restart']:
    raise SystemExit(7)
reads = state.setdefault('reads_after_kill', 0)
ends_at = state.setdefault('break_ends_at_ms', now + state['remaining_ms'])
if killed:
    state['reads_after_kill'] = reads + 1
json.dump(state, open(state_path, 'w'))
remaining = ends_at - now
maintenance = {
    'active': True, 'phase': 'counting_down', 'durableConfirmed': True,
    'readyForRestart': state['ready'], 'unparkedTables': 0 if state['ready'] else 3,
    'remainingMs': remaining, 'breakEndsAt': ends_at + state['clock_skew_ms'],
    'reason': 'Scheduled Engine Maintenance',
}
if killed and reads < state['adopt_after_reads']:
    maintenance = {'active': False, 'phase': 'idle'}
elif killed:
    maintenance['breakEndsAt'] += state['adopt_break_shift_ms']
if killed and reads >= max(state['leave_break_after'], state['adopt_after_reads'] + 3):
    maintenance = {'active': False, 'phase': 'idle'}
body = {
    'running': True, 'liveness': 'ok', 'releaseSha': state['serving_sha'],
    'instanceId': (state['after_instance'] if killed else '1-aaaaaaaa'),
    'handsInFlightTotal': 0, 'maintenance': maintenance,
}
sys.stdout.write(json.dumps(body) + '\n200')
'''

SYSTEMCTL = r'''#!/usr/bin/env bash
if [ "$1" = list-units ]; then
  if [ -n "${DRILL_TEST_BUSY_UNIT:-}" ]; then echo "$DRILL_TEST_BUSY_UNIT loaded activating running x"; fi
  exit 0
fi
exit 0
'''

SEAL = r'''#!/usr/bin/env bash
case "$1 $2" in
  'get desired-sha') echo "$DRILL_TEST_DESIRED_SHA" ;;
  'get desired-image-id') echo 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' ;;
  'pending-owner ') echo "${DRILL_TEST_PENDING:-none}" ;;
  *) exit 9 ;;
esac
'''

DB_PROOF = r'''#!/usr/bin/env bash
echo "db-proof $*" >> "$DRILL_TEST_EVENTS"
exit "${DRILL_TEST_LEADER_RC:-0}"
'''

SUPERVISOR = r'''#!/usr/bin/env bash
echo "supervisor force=$ENGINE_SUPERVISOR_FORCE_DESIRED exact=$ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH held=$ENGINE_SUPERVISOR_LOCK_HELD" >> "$DRILL_TEST_EVENTS"
exit 0
'''

DRILL_DB_PROOF = r'''#!/usr/bin/env bash
echo "drill-db-proof $*" >> "$DRILL_TEST_EVENTS"
[ "${DRILL_TEST_POST_RC:-0}" = 0 ] || exit 1
echo '{"handsAfterThaw":{"sampled":40,"tables":9}}'
'''


def write(path: Path, text: str) -> None:
    path.write_text(text)
    path.chmod(0o755)


def run_drill(*, desired=SHA, serving=SHA, label=SHA, image=IMAGE, policy='always',
              autoheal='running', restart=True, ready=True, remaining_ms=280_000,
              clock_skew_ms=0, after_instance=AFTER_INSTANCE, busy_unit='', pending='',
              leader_rc=0, post_rc=0, leave_break_after=3, admission_seconds=30,
              restart_seconds=5, authorization='DA08 crash rehearsal approved by owner',
              adopt_after_reads=0, adopt_break_shift_ms=0):
    with tempfile.TemporaryDirectory(prefix='crash-drill-') as temp:
        temp = Path(temp)
        stage, control, bin_dir, state_dir = temp / 'stage', temp / 'control', temp / 'bin', temp / 'state'
        for d in (stage, control, bin_dir):
            d.mkdir()
        shutil.copy2(SCRIPTS / 'engine-crash-drill.sh', stage / 'engine-crash-drill.sh')
        write(stage / 'engine-drill-database-proof.py', DRILL_DB_PROOF)
        write(control / 'engine-release-seal.py', SEAL)
        write(control / 'engine-release-database-proof.py', DB_PROOF)
        write(control / 'engine-supervisor.sh', SUPERVISOR)
        write(bin_dir / 'docker', DOCKER)
        write(bin_dir / 'curl', CURL)
        write(bin_dir / 'systemctl', SYSTEMCTL)
        write(bin_dir / 'id', '#!/usr/bin/env bash\necho 0\n')
        # The production host has GNU tools. These fixture-local substitutes
        # let the same real script run on macOS without changing its decisions.
        if not shutil.which('date') or os.uname().sysname == 'Darwin':
            write(bin_dir / 'date', '''#!/usr/bin/env python3
import sys, time
if sys.argv[1:] == ['+%s']: print(int(time.time()))
elif sys.argv[1:] == ['+%s%3N']: print(int(time.time() * 1000))
elif sys.argv[1:] == ['+%s%N']: print(time.time_ns())
else: raise SystemExit(2)
''')
        if not shutil.which('timeout'):
            write(bin_dir / 'timeout', '''#!/usr/bin/env python3
import os, subprocess, sys
args = sys.argv[1:]
while args and args[0].startswith('--'): args.pop(0)
seconds = float(args.pop(0).removesuffix('s'))
try: raise SystemExit(subprocess.run(args, timeout=seconds, pass_fds=tuple(fd for fd in range(3, 10) if os.path.exists('/dev/fd/' + str(fd)))).returncode)
except subprocess.TimeoutExpired: raise SystemExit(124)
''')
        if not shutil.which('flock'):
            write(bin_dir / 'flock', '''#!/usr/bin/env python3
import fcntl, sys, time
args = sys.argv[1:]
mode = args.pop(0)
wait = float(args.pop(0)) if mode == '-w' else 0
fd = int(args.pop(0))
if mode == '-u': fcntl.flock(fd, fcntl.LOCK_UN); raise SystemExit(0)
deadline = time.monotonic() + wait
while True:
    try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); break
    except BlockingIOError:
        if time.monotonic() >= deadline: raise SystemExit(1)
        time.sleep(0.01)
''')
        env_file = temp / 'engine.env'
        env_file.write_text('SUPABASE_URL=https://example.invalid\n')
        engine = subprocess.Popen(['sleep', '600'])
        events = temp / 'events'
        events.write_text('')
        state = temp / 'state.json'
        state.write_text(json.dumps({
            'pid': engine.pid, 'restart': restart, 'label': label, 'image': image,
            'policy': policy, 'autoheal': autoheal, 'ready': ready, 'remaining_ms': remaining_ms,
            'clock_skew_ms': clock_skew_ms, 'serving_sha': serving, 'after_instance': after_instance,
            'leave_break_after': leave_break_after,
            'adopt_after_reads': adopt_after_reads, 'adopt_break_shift_ms': adopt_break_shift_ms,
        }))
        # Positive cases must reach the crash/recovery assertions, rather than
        # expire while starting the stubbed host prerequisites. The full hook
        # measured these reads beyond the former eight-second allowance.
        # Negative admission cases still explicitly pass four seconds; the
        # production 900-second reserve and all drill guards are unchanged.
        not_after = int(time.time()) + 900 + admission_seconds
        env = {
            **os.environ,
            'PATH': f'{bin_dir}:{os.environ["PATH"]}',
            'ENGINE_CONTROL_DIR': str(control), 'ENV_FILE': str(env_file),
            'ENGINE_LOCK_FILE': str(temp / 'engine.lock'), 'ENGINE_DRILL_LOCK_FILE': str(temp / 'drill.lock'),
            'ENGINE_DRILL_STATE_DIR': str(state_dir), 'ENGINE_DRILL_POLL_SECONDS': '1',
            'ENGINE_DRILL_RESTART_SECONDS': str(restart_seconds),
            # The real drill reserves at least 10s for database leadership.
            # A 12s fixture left only 2s for supervisor/public-health checks;
            # Python subprocess startup on the loaded Mac consumed that before
            # the delayed-adoption assertion could run. Keep the same guards
            # and negative outcomes with a bounded 30s fixture recovery budget.
            # Production still owns its separate 180s ceiling.
            'ENGINE_DRILL_HEALTH_SECONDS': '30',
            'DRILL_TEST_STATE': str(state), 'DRILL_TEST_EVENTS': str(events),
            'DRILL_TEST_DESIRED_SHA': desired, 'DRILL_TEST_BUSY_UNIT': busy_unit,
            'DRILL_TEST_PENDING': pending, 'DRILL_TEST_LEADER_RC': str(leader_rc),
            'DRILL_TEST_POST_RC': str(post_rc),
        }
        auth = base64.b64encode(authorization.encode()).decode()
        try:
            result = subprocess.run(
                ['bash', str(stage / 'engine-crash-drill.sh'), '--run-id', '123-1', '--expected-sha', SHA,
                 '--not-after-epoch', str(not_after), '--authorization-b64', auth],
                env=env, capture_output=True, text=True, timeout=120,
            )
            killed = engine.poll() is not None
        finally:
            if engine.poll() is None:
                engine.send_signal(signal.SIGTERM)
            engine.wait()
        receipt_path = state_dir / '123-1.json'
        receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else None
        return result, killed, receipt, events.read_text()


def outcome(result) -> str:
    for line in result.stdout.splitlines():
        if line.startswith('ENGINE_DRILL_RESULT='):
            return line.split('=', 1)[1]
    return ''


class CrashDrill(unittest.TestCase):
    def test_passes_only_through_supervisor_restart_and_every_witness(self):
        result, killed, receipt, events = run_drill()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(outcome(result), 'passed')
        self.assertTrue(killed, 'the engine process must have been SIGKILLed')
        self.assertEqual(receipt['result'], 'passed')
        names = [e['event'] for e in receipt['events']]
        self.assertEqual(names, ['requested', 'preflight', 'before', 'killed', 'restarted', 'recovered', 'passed'])
        self.assertEqual(receipt['events'][0]['data']['authorization'], 'DA08 crash rehearsal approved by owner')
        self.assertIn(f'--instance-id {BEFORE_INSTANCE}', events)
        self.assertIn(f'--instance-id {AFTER_INSTANCE}', events)
        self.assertIn('drill-db-proof', events)
        self.assertNotIn('supervisor', events, 'a passing drill never needs the forced restore')

    def test_refuses_with_nothing_mutated(self):
        cases = {
            'sealed desired is another release': dict(desired=OTHER),
            'container not the sealed release': dict(label=OTHER),
            'container not the sealed image': dict(image='sha256:' + 'd' * 64),
            'restart policy is not production supervision': dict(policy='no'),
            'autoheal is not running': dict(autoheal='exited'),
            'a release unit owns the lane': dict(busy_unit='club-arena-engine-release-v1@9-1.service'),
            'the seal has a pending cutover': dict(pending='active 9-1 false 2000000000'),
            'local health is another release': dict(serving=OTHER),
            'the fleet is not parked': dict(ready=False),
            'the break is too short': dict(remaining_ms=240_000),
            'the break clocks disagree': dict(clock_skew_ms=20_000),
            'the leader is not the serving instance': dict(leader_rc=1),
            'authorization too short': dict(authorization='go'),
        }
        for name, kwargs in cases.items():
            with self.subTest(name):
                result, killed, receipt, events = run_drill(admission_seconds=4, **kwargs)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertFalse(killed, f'{name}: the engine must not be touched')
                self.assertNotIn('supervisor', events)
                if receipt is not None:
                    self.assertEqual(receipt['result'], 'refused')
                    self.assertNotIn('killed', [e['event'] for e in receipt['events']])

    def test_no_supervisor_restart_is_a_failure_that_forces_the_sealed_runtime_back(self):
        result, killed, receipt, events = run_drill(restart=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(outcome(result), 'failed')
        self.assertTrue(killed)
        self.assertEqual(receipt['result'], 'failed')
        self.assertIn('supervisor force=1 exact=1 held=1', events)

    def test_a_restart_that_keeps_the_old_instance_is_not_recovery(self):
        result, killed, receipt, events = run_drill(after_instance=BEFORE_INSTANCE)
        self.assertEqual(outcome(result), 'failed')
        self.assertIn('supervisor force=1', events)

    def test_missing_hand_progression_after_the_thaw_fails(self):
        result, killed, receipt, events = run_drill(post_rc=1)
        self.assertEqual(outcome(result), 'failed')
        self.assertEqual(receipt['result'], 'failed')

    def test_leadership_before_delayed_break_adoption_is_not_a_false_failure(self):
        result, killed, receipt, events = run_drill(adopt_after_reads=5)
        self.assertEqual(outcome(result), 'passed', result.stdout + result.stderr)
        self.assertTrue(killed)
        self.assertEqual(receipt['result'], 'passed')
        self.assertNotIn('supervisor', events)

    def test_missing_break_adoption_exhausts_the_existing_budget_and_restores(self):
        result, killed, receipt, events = run_drill(adopt_after_reads=1000)
        self.assertEqual(outcome(result), 'failed')
        self.assertTrue(killed)
        self.assertEqual(receipt['result'], 'failed')
        self.assertIn('supervisor force=1 exact=1 held=1', events)

    def test_a_different_durable_break_does_not_certify_recovery(self):
        result, killed, receipt, events = run_drill(adopt_break_shift_ms=60_000, leave_break_after=1000)
        self.assertEqual(outcome(result), 'failed')
        self.assertTrue(killed)
        self.assertEqual(receipt['result'], 'failed')
        self.assertIn('supervisor force=1 exact=1 held=1', events)


if __name__ == '__main__':
    unittest.main()
