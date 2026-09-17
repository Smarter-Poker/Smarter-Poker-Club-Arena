#!/usr/bin/env python3
"""Execute the actual transaction's bounded recovery request with isolated I/O."""
from pathlib import Path
import json
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = (ROOT / 'server/scripts/engine-release-transaction.sh').read_text()
RECOVERY = SOURCE[SOURCE.index('RECOVERY_REQUESTED=0'):SOURCE.index('persist_break_deadline() {')]


def invoke(*, capability=True, active=False, eligible=True, unknown=False, live=False, minute=30, ready=True, becomes_ready=False):
    with tempfile.TemporaryDirectory(prefix='recovery-owner-') as temp:
        events = Path(temp) / 'events'
        health = json.dumps({'running': True, 'maintenance': {'active': active,
            'recoveryWindowProtocol': 'engine-recovery-window-v1' if capability else None,
            'recoveryWindowReady': ready}})
        script = f'''
set -euo pipefail
EVENTS={shlex.quote(str(events))}
SHA={'b' * 40}; RUN_ID=900-2; REPO_DIR=/fixture; CONTAINER=fixture; RELEASE_SEAL=fixture-seal
LOCK_HELD=0
HEALTH={shlex.quote(health)}
record() {{ printf '%s\\n' "$*" >> "$EVENTS"; }}
date() {{ echo {1800000000 + minute * 60}; }}
curl() {{ printf '%s' "$HEALTH"; }}
die() {{ record "DIE:$*"; exit 1; }}
acquire_engine_lock() {{ [ "$LOCK_HELD" = 0 ]; LOCK_HELD=1; record LOCK; }}
release_engine_lock() {{ [ "$LOCK_HELD" = 1 ]; LOCK_HELD=0; record UNLOCK; }}
source_target_is_current() {{ record SOURCE; }}
exact_runtime_instance() {{ [ {int(live)} = 1 ]; }}
emit_already_released() {{ record ALREADY; exit 0; }}
timeout() {{
  shift 3
  if [ "$1" = fixture-seal ]; then
    [ "$LOCK_HELD" = 1 ]; record RESERVE
    echo {'1800000000000' if eligible else 'unavailable'}
  elif [ "$1" = docker ]; then
    [ "$LOCK_HELD" = 1 ]; record REQUEST
    cat > /dev/null
    [ {int(unknown)} = 0 ] || return 1
    echo accepted
  else exit 95; fi
}}
{RECOVERY}
request_recovery_window
{'HEALTH=' + shlex.quote(json.dumps({'running': True, 'maintenance': {'active': False, 'recoveryWindowProtocol': 'engine-recovery-window-v1', 'recoveryWindowReady': True}})) if becomes_ready else ':'}
request_recovery_window
[ "$LOCK_HELD" = 0 ]
'''
        result = subprocess.run(['bash'], input=script, text=True, capture_output=True, timeout=5)
        return result, events.read_text().splitlines() if events.exists() else []


class RecoveryWindowTests(unittest.TestCase):
    def test_eligible_release_reserves_and_requests_once_inside_lock(self):
        result, events = invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, ['LOCK', 'SOURCE', 'RESERVE', 'REQUEST', 'UNLOCK'])

    def test_unchanged_transaction_can_request_after_prior_resume_finishes(self):
        result, events = invoke(ready=False, becomes_ready=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, ['LOCK', 'SOURCE', 'RESERVE', 'REQUEST', 'UNLOCK'])

    def test_unknown_response_keeps_one_reservation_and_never_blind_retries(self):
        result, events = invoke(unknown=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events.count('REQUEST'), 1)
        self.assertIn(': unknown;', result.stdout)

    def test_no_verified_failure_does_not_announce(self):
        result, events = invoke(eligible=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events.count('RESERVE'), 1)
        self.assertNotIn('REQUEST', events)

    def test_already_serving_target_finishes_without_another_pause(self):
        result, events = invoke(live=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, ['LOCK', 'SOURCE', 'ALREADY'])

    def test_old_engine_active_break_unfinished_thaw_or_hourly_overlap_never_requests(self):
        for inputs in ({'capability': False}, {'active': True}, {'minute': 48}, {'minute': 1}, {'ready': False}):
            with self.subTest(inputs=inputs):
                result, events = invoke(**inputs)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(events, [])


if __name__ == '__main__':
    unittest.main()
