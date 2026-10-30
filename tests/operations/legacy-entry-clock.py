#!/usr/bin/env python3
"""Actual transaction/countdown/helper predicates with an isolated clock.

The queue's existing native-I/O doubles remain doubles. Separate cases execute
the maintained deadline wrappers against real child processes and OS locks.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import types
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('queue_fixture', ROOT / 'tests/operations/engine-release-window-queue.py')
Q = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(Q)
TRANSACTION = Q.SOURCE
SHELL = (ROOT / 'server/scripts/legacy-engine-checkpoint.sh').read_text()
COUNTDOWN = TRANSACTION[TRANSACTION.index('legacy_checkpoint_countdown() {'):TRANSACTION.index('\n# This is one optional event')]
PHYSICAL = SHELL[SHELL.index('INSTANCE="$('):SHELL.index('# Persist intent before opening debugger access.')]
NATIVE_RUN = subprocess.run


def queue(*, prelock=20, now=100, work=10, changed_window=False, weekly=0, identity=True):
    def execute(args, **kwargs):
        script = kwargs['input']
        old = 'legacy_checkpoint_countdown() { event "COUNTDOWN:$LOCK_HELD"; printf \'%s\\n\' $((NOW + 299)); }'
        assert old in script
        controls = f'''
weekly_owner() {{ return {weekly}; }}
INFLIGHT_HANDS=weekly_owner
ENV_FILE=not-read
DAILY_TRANSITION=0
CHECKPOINT_PREDECESSOR_SHA="$LEGACY_CHECKPOINT_SHA"
curl() {{
  FIXTURE_NOW="$NOW" FIXTURE_LOCK="$LOCK_HELD" {sys.executable} -c 'import os,json,sys
now=int(os.environ["FIXTURE_NOW"]); locked=int(os.environ["FIXTURE_LOCK"])
end=399000+({int(changed_window)}*locked*1000)
d={{"running":True,"weeklyPayout":None,"version":"8825af51","releaseSha":"8825af51817f379c4261658ca29ecc9d8d81932d","instanceId":"1-3846b8bb","maintenance":{{"reason":"Deployment Recovery","active":True,"phase":"counting_down","durableConfirmed":True,"remainingMs":end-now*1000,"breakEndsAt":end}}}}
if not {identity!r}:d["releaseSha"]="f"*40
print(json.dumps(d),end="")
if "--write-out" in sys.argv[1:]:print("\\n200",end="")' "$@"
}}
python3() {{
  FIXTURE_NOW="$NOW" {sys.executable} -c 'import os,sys,time;time.time=lambda:int(os.environ["FIXTURE_NOW"]);program=sys.argv.pop(1);exec(program)' "$2" "${{@:3}}"
}}
'''
        script = script.replace(old, controls + COUNTDOWN)
        script = script.replace('[ "$LOCK_HELD" = 0 ]; LOCK_HELD=1; event LOCK', f'[ "$LOCK_HELD" = 0 ]; NOW=$((NOW + {prelock})); LOCK_HELD=1; event LOCK')
        start = script.index('legacy_checkpoint_stub() {')
        stop = script.index('LEGACY_CHECKPOINT=legacy_checkpoint_stub', start)
        script = script[:start] + f'''legacy_checkpoint_stub() {{
  event PHYSICAL_PROBE
  [ "$2" = "$(( {now} * 1000 + 40000 ))" ] || {{ event RESET_DEADLINE; return 1; }}
  [ "$3" = 399 ] || {{ event CHANGED_BREAK; return 1; }}
  CHECKPOINT_DEADLINE_MS="$2"
  CHECKPOINT_BREAK_END_EPOCH="$3"
  LEGACY_SHA=8825af51817f379c4261658ca29ecc9d8d81932d
  checkpoint_entry_read() {{ "$@"; }}
  defer() {{ event PHYSICAL_REFUSED; exit 75; }}
  {PHYSICAL}
  [ "$(( (NOW + {work}) * 1000 ))" -le "$CHECKPOINT_DEADLINE_MS" ] || {{ event EXPIRED_WORK; return 1; }}
  event LEGACY_CHECKPOINT
  NOW=$((NOW + {work}))
  return 0
}}
''' + script[stop:]
        # Both certificates are fresh clock observations. The queue, not this
        # double, owns which minimum applies and whether a refusal may proceed.
        start = script.index('maintenance_certificate() {')
        stop = script.index('\nremaining_seconds() {', start)
        script = script[:start] + '''maintenance_certificate() {
  event "CERTIFICATE:$LOCK_HELD:${1:-$MIN_BREAK_REMAINING_MS}"
  local remaining=$(((399 - NOW) * 1000))
  printf '%s\\n' "$remaining"
  [ "$remaining" -ge "${1:-$MIN_BREAK_REMAINING_MS}" ] || return 2
}
''' + script[stop:]
        kwargs['input'] = script
        return NATIVE_RUN(args, **kwargs)
    previous = Q.subprocess
    Q.subprocess = types.SimpleNamespace(run=execute)
    try:
        return Q.run_queue([], legacy=True, now=now, certificate_deadline=180, cancellation=True)
    finally:
        Q.subprocess = previous


class ClockTests(unittest.TestCase):
    def test_same_entry_budget_pays_prelock_and_both_actual_countdown_probes(self):
        result, events = queue()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events.count('LEGACY_CHECKPOINT'), 1, events)
        self.assertIn('CERTIFICATE:0:285000', events)
        self.assertIn('CERTIFICATE:1:245000', events)
        self.assertNotIn('RESET_DEADLINE', events)

    def test_first_admission_never_spends_the_initial_285_reserve(self):
        result, events = queue(now=115)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('LOCK', events)
        self.assertNotIn('LEGACY_CHECKPOINT', events)

    def test_a_different_durable_break_cannot_spend_the_prior_entry_clock(self):
        result, events = queue(changed_window=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('PHYSICAL_PROBE', events)

    def test_expired_shared_clock_never_opens_the_helper(self):
        result, events = queue(prelock=40)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('PHYSICAL_PROBE', events)

    def test_weekly_owned_or_unreadable_never_enters(self):
        for code in (1, 3):
            with self.subTest(code=code):
                result, events = queue(weekly=code)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('LOCK', events)

    def test_the_actual_helper_still_refuses_changed_runtime_identity(self):
        result, events = queue(identity=False)
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertIn('PHYSICAL_REFUSED', events)
        self.assertNotIn('LEGACY_CHECKPOINT', events)

    def test_physical_probe_uses_only_the_unspent_same_entry_budget(self):
        program = PHYSICAL.split("python3 -c '\n", 1)[1].rsplit("' \"$LEGACY_SHA\"", 1)[0]
        health = {'running': True, 'releaseSha': '8825af51817f379c4261658ca29ecc9d8d81932d',
                  'version': '8825af51', 'instanceId': '1-3846b8bb',
                  'maintenance': {'active': True, 'phase': 'counting_down',
                                  'durableConfirmed': True, 'remainingMs': 265000, 'breakEndsAt': 399000}}
        cases = [(265000, 140000, 399, 0), (264999, 140000, 399, 1),
                 (265000, 125000, 399, 1), (299000, 160001, 399, 1),
                 (265000, 140000, 400, 1)]
        for remaining, deadline, end, expected in cases:
            with self.subTest(remaining=remaining, deadline=deadline, end=end):
                value = json.loads(json.dumps(health)); value['maintenance']['remainingMs'] = remaining
                bootstrap = 'import sys,time;time.time=lambda:120;program=sys.argv.pop(1);exec(program)'
                result = NATIVE_RUN([sys.executable, '-c', bootstrap, program,
                                    health['releaseSha'], str(deadline), str(end)],
                                   input=json.dumps(value), text=True, capture_output=True, timeout=3)
                self.assertEqual(result.returncode, expected, result.stderr)


class NativeBudgetTests(unittest.TestCase):
    def run_bound(self, *, final=False, expired=False, locked=False):
        if not shutil.which('timeout'):
            self.fail('GNU timeout is required for the actual native deadline cases')
        import fcntl
        with tempfile.TemporaryDirectory(prefix='legacy-entry-clock-', dir=ROOT.parent) as temp:
            directory = Path(temp)
            child_pid = directory / 'child-pid'
            lock = directory / 'lock'
            descriptor = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
            if locked:
                fcntl.flock(descriptor, fcntl.LOCK_EX)
            child = ('import os,signal,time,fcntl;'
                     'from pathlib import Path;'
                     'signal.signal(signal.SIGTERM,signal.SIG_IGN);'
                     f'Path({str(child_pid)!r}).write_text(str(os.getpid()));'
                     + (f'f=open({str(lock)!r},"r+");fcntl.flock(f,fcntl.LOCK_EX);' if locked else '')
                     + 'time.sleep(10)')
            wrapper = (SHELL[SHELL.index('checkpoint_final_read() {'):SHELL.index('# /var/lock')]
                       if final else TRANSACTION[TRANSACTION.index('legacy_entry_read() {'):TRANSACTION.index('legacy_entry_trace() {')])
            # Actual wall clock, not a simulated clock: macOS date lacks %3N.
            clock = f'''date() {{ {sys.executable} -c 'import time;print(time.time_ns()//1000000)'; }}'''
            now = time.time_ns() // 1000000
            deadline = now + (2000 if final else 5000 if expired else 7500)
            variable = 'CHECKPOINT_DEADLINE_MS' if final else 'LEGACY_ENTRY_DEADLINE_MS'
            command = 'checkpoint_final_read' if final else 'legacy_entry_read'
            script = f'''set -euo pipefail
{clock}
{wrapper}
{variable}={deadline}
{command} {sys.executable} -c {__import__('shlex').quote(child)}
'''
            started = time.monotonic()
            try:
                result = NATIVE_RUN(['bash'], input=script, text=True, capture_output=True, timeout=5)
                elapsed = time.monotonic() - started
                self.assertIn(result.returncode, (124, 137, -9), result.stderr)
                self.assertLess(elapsed, 4, (elapsed, result.stderr))
                if expired:
                    self.assertFalse(child_pid.exists(), 'expired budget launched a child')
                else:
                    self.assertTrue(child_pid.exists(), 'native target never started')
                    pid = int(child_pid.read_text())
                    # A process-group KILL may leave a briefly unreaped child;
                    # it must never leave runnable work behind the deadline.
                    try:
                        os.kill(pid, 0)
                    except ProcessLookupError:
                        pass
                    else:
                        state = NATIVE_RUN(['ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True, timeout=2)
                        self.assertTrue(not state.stdout.strip() or state.stdout.strip().startswith('Z'), state.stdout)
            finally:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
                os.close(descriptor)

    def test_actual_native_lock_wait_cannot_renew_the_work_budget(self):
        self.run_bound(locked=True)

    def test_actual_native_child_ignoring_term_is_killed_inside_reserved_cleanup(self):
        self.run_bound()

    def test_expired_work_budget_never_launches_a_native_child(self):
        self.run_bound(expired=True)

    def test_actual_final_client_has_no_grace_beyond_absolute_deadline(self):
        self.run_bound(final=True)


if __name__ == '__main__':
    unittest.main()
