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
CERTIFICATE = SOURCE[SOURCE.index('maintenance_certificate() {'):SOURCE.index('# This is one optional event')]


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


def certificate(maintenance, *, running=True, transport=True, http=200, minimum=None):
    response = json.dumps({'running': running, 'maintenance': maintenance}) + f'\n{http}'
    script = f'''set -euo pipefail
MIN_BREAK_REMAINING_MS=285000
curl() {{ [ {int(transport)} = 1 ] || return 1; printf '%s' {shlex.quote(response)}; }}
{CERTIFICATE}
maintenance_certificate {'' if minimum is None else int(minimum)}
'''
    return subprocess.run(['bash'], input=script, text=True, capture_output=True, timeout=5)


class RecoveryWindowTests(unittest.TestCase):
    def test_durable_window_can_be_missed_without_ever_certifying_restart(self):
        window = {'active': True, 'phase': 'counting_down', 'durableConfirmed': True,
                  'remainingMs': 300000, 'readyForRestart': False, 'unparkedTables': 2}
        self.assertEqual(certificate(window).returncode, 1)
        # This is observation of a real missed opportunity, never cutover authority.
        for remaining in [280000, 1000, 0]:
            with self.subTest(remaining=remaining):
                result = certificate({**window, 'remainingMs': remaining})
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertEqual(result.stdout.strip(), str(remaining))
        self.assertEqual(certificate({**window, 'readyForRestart': True,
                                      'unparkedTables': 0}).returncode, 0)

    def test_legacy_reserve_is_only_accepted_when_the_caller_names_it(self):
        # After the exact legacy checkpoint the transaction passes its 245000ms
        # legacy reserve explicitly. Without that argument the strict 285000ms
        # entry minimum still governs, so the same 260000ms window (300 s less
        # the 40 s budget the checkpoint just paid) is a missed opportunity for
        # an ordinary release and a complete certificate only for the caller
        # that has just paid the checkpoint budget.
        window = {'active': True, 'phase': 'counting_down', 'durableConfirmed': True,
                  'remainingMs': 260000, 'readyForRestart': True, 'unparkedTables': 0}
        self.assertEqual(certificate(window).returncode, 2)
        self.assertEqual(certificate(window, minimum=285000).returncode, 2)
        self.assertEqual(certificate(window, minimum=245000).returncode, 0)
        self.assertEqual(certificate({**window, 'remainingMs': 245000}, minimum=245000).returncode, 0)
        boundary = certificate({**window, 'remainingMs': 244999}, minimum=245000)
        self.assertEqual(boundary.returncode, 2, boundary.stderr)
        self.assertEqual(boundary.stdout.strip(), '244999')
        # The smaller minimum relaxes nothing but time.
        self.assertEqual(certificate({**window, 'readyForRestart': False, 'unparkedTables': 1},
                                     minimum=245000).returncode, 1)

    def test_missing_or_unconfirmed_observation_never_qualifies_a_recovery(self):
        window = {'active': True, 'phase': 'counting_down', 'durableConfirmed': True,
                  'remainingMs': 1000, 'readyForRestart': False, 'unparkedTables': 2}
        for override in [{'active': False}, {'durableConfirmed': False}, {'phase': 'idle'}]:
            with self.subTest(override=override):
                self.assertEqual(certificate({**window, **override}).returncode, 1)
        for options in [{'running': False}, {'transport': False}, {'http': 502}]:
            with self.subTest(options=options):
                self.assertEqual(certificate(window, **options).returncode, 1)

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
