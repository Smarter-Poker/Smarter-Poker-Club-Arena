#!/usr/bin/env python3
"""Execute the real pre-prepare queue with isolated clock/certificate boundaries."""
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SOURCE = (ROOT / 'server/scripts/engine-release-transaction.sh').read_text()
HELPERS = SOURCE[SOURCE.index('remaining_seconds() {'):SOURCE.index('validate_actor() {')]
START = SOURCE.index('while :; do', SOURCE.index('NEXT_FRESHNESS_CHECK=$(( $(date +%s) + 60 ))'))
STOP = SOURCE.index('  BREAK_END_EPOCH=$(( $(date +%s) + (BREAK_REMAINING_MS / 1000) ))', START)
QUEUE = SOURCE[START:STOP]
RECOVERY = SOURCE[SOURCE.index('RECOVERY_REQUESTED=0'):SOURCE.index('persist_break_deadline() {')]


def run_queue(certificates, *, now=100, deadline=1000, certificate_deadline=900,
              supersede_on=0, cancellation=False, already_released=False):
    with tempfile.TemporaryDirectory(prefix='engine-window-queue-') as temp:
        directory = Path(temp)
        sequence = directory / 'certificate-sequence'
        sequence.write_text('0')
        events = directory / 'events'
        branches = '\n'.join(
            f'{i}) printf "%s\\n" {remaining}; return {code} ;;'
            for i, (code, remaining) in enumerate(certificates, 1)
        )
        harness = f'''#!/usr/bin/env bash
set -euo pipefail
NOW={now}
DEADLINE={deadline}
CERTIFICATE_DEADLINE={certificate_deadline}
NEXT_FRESHNESS_CHECK=0
BREAK_END_EPOCH=0
MIN_BREAK_REMAINING_MS=285000
LOCK_HELD=0
LEGACY_CHECKPOINT_REQUIRED=0
LEGACY_CHECKPOINT_ATTEMPTED=0
FRESHNESS_CALLS=0
EVENTS={shlex.quote(str(events))}
SEQUENCE={shlex.quote(str(sequence))}
event() {{ printf '%s\\n' "$*" >> "$EVENTS"; }}
date() {{ [ "$1" = +%s ]; printf '%s\\n' "$NOW"; }}
die() {{ event "DIE:$*"; exit 1; }}
break_proof_seconds() {{ event UNEXPECTED_BREAK_DEADLINE; exit 98; }}
sleep() {{
  [ "$LOCK_HELD" = 0 ] || {{ event SLEEP_WITH_LOCK; exit 96; }}
  event "SLEEP:$1:$DEADLINE:$CERTIFICATE_DEADLINE:$BREAK_END_EPOCH"
  if [ {int(cancellation)} = 1 ]; then event CANCELLED; exit 143; fi
  NOW=$((NOW + $1))
}}
source_target_is_current() {{
  FRESHNESS_CALLS=$((FRESHNESS_CALLS + 1))
  event "FRESH:$FRESHNESS_CALLS"
  if [ {supersede_on} -gt 0 ] && [ "$FRESHNESS_CALLS" -ge {supersede_on} ]; then
    event SUPERSEDED; exit 77
  fi
}}
acquire_engine_lock() {{
  [ "$LOCK_HELD" = 0 ]; LOCK_HELD=1; event LOCK
}}
release_engine_lock() {{
  [ "$LOCK_HELD" = 1 ]; LOCK_HELD=0; event UNLOCK
}}
exact_runtime_instance() {{
  if [ {int(already_released)} = 1 ]; then echo original-instance; return 0; fi
  return 1
}}
emit_already_released() {{ event ALREADY_RELEASED; exit 0; }}
maintenance_certificate() {{
  n=$(cat "$SEQUENCE"); n=$((n + 1)); printf '%s\\n' "$n" > "$SEQUENCE"
  event "CERTIFICATE:$n:$LOCK_HELD"
  case "$n" in
    {branches}
    *) printf '0\\n'; return 1 ;;
  esac
}}
{HELPERS}
{RECOVERY}
{QUEUE}
  [ "$LOCK_HELD" = 1 ] || exit 95
  [ "$BREAK_REMAINING_MS" -ge "$MIN_BREAK_REMAINING_MS" ] || exit 94
  event "PREPARE_ALLOWED:$DEADLINE:$CERTIFICATE_DEADLINE:$BREAK_END_EPOCH"
  break
done
'''
        result = subprocess.run(['bash'], input=harness, text=True, capture_output=True,
                                cwd=directory, timeout=5)
        return result, events.read_text().splitlines() if events.exists() else []


class WindowQueueTests(unittest.TestCase):
    def assert_no_mutation(self, events):
        self.assertFalse(any(e.startswith('PREPARE_ALLOWED:') for e in events), events)
        self.assertNotIn('SLEEP_WITH_LOCK', events)
        self.assertNotIn('UNEXPECTED_BREAK_DEADLINE', events)

    def test_initial_short_window_reaches_later_complete_certificate(self):
        result, events = run_queue([(2, 188547), (1, 0), (0, 299999), (0, 299000)])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events[-1], 'PREPARE_ALLOWED:1000:900:0')
        self.assertEqual([e for e in events if e == 'LOCK'], ['LOCK'])
        self.assertIn('SLEEP:15:1000:900:0', events)

    def test_lock_wait_consumed_window_releases_lock_before_waiting(self):
        result, events = run_queue([(0, 299000), (2, 188547), (0, 299999), (0, 299000)])
        self.assertEqual(result.returncode, 0, result.stderr)
        position = events.index('UNLOCK')
        self.assertEqual(events[position + 1], 'SLEEP:15:1000:900:0')
        self.assertEqual(events[-1], 'PREPARE_ALLOWED:1000:900:0')
        self.assertEqual(events.count('LOCK'), 2)

    def test_short_window_never_grants_permission_at_certificate_deadline(self):
        result, events = run_queue([(2, 1)] * 10, certificate_deadline=130)
        self.assertEqual(result.returncode, 1)
        self.assert_no_mutation(events)
        self.assertIn('enough proof time remaining', events[-1])
        self.assertEqual(len([e for e in events if e.startswith('CERTIFICATE:')]), 2)

    def test_immutable_overall_deadline_is_not_extended(self):
        result, events = run_queue([(2, 1)] * 10, now=190, deadline=200)
        self.assertEqual(result.returncode, 1)
        self.assert_no_mutation(events)
        self.assertIn('SLEEP:10:200:900:0', events)
        self.assertIn('end-to-end release deadline expired while waiting', events[-1])

    def test_source_supersession_is_rechecked_during_short_window_wait(self):
        result, events = run_queue([(2, 1)] * 20, supersede_on=2)
        self.assertEqual(result.returncode, 77)
        self.assert_no_mutation(events)
        self.assertEqual(events[-1], 'SUPERSEDED')
        self.assertEqual(events.count('FRESH:2'), 1)

    def test_source_supersession_under_lock_never_prepares(self):
        result, events = run_queue([(0, 299999)], supersede_on=2)
        self.assertEqual(result.returncode, 77)
        self.assert_no_mutation(events)
        self.assertEqual(events[-2:], ['FRESH:2', 'SUPERSEDED'])

    def test_cancellation_while_waiting_never_prepares(self):
        result, events = run_queue([(2, 188547)], cancellation=True)
        self.assertEqual(result.returncode, 143)
        self.assert_no_mutation(events)
        self.assertEqual(events[-1], 'CANCELLED')

    def test_cancellation_after_locked_short_certificate_has_released_lock(self):
        result, events = run_queue([(0, 299999), (2, 188547)], cancellation=True)
        self.assertEqual(result.returncode, 143)
        self.assert_no_mutation(events)
        self.assertEqual(events[-3:], ['UNLOCK', 'SLEEP:15:1000:900:0', 'CANCELLED'])

    def test_disappeared_locked_certificate_is_retried_without_ownership(self):
        result, events = run_queue([(0, 299999), (1, 0), (0, 299999), (0, 299999)])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('UNLOCK', events)
        self.assertNotIn('SLEEP_WITH_LOCK', events)
        self.assertEqual(events[-1], 'PREPARE_ALLOWED:1000:900:0')

    def test_already_released_exact_runtime_keeps_existing_early_completion(self):
        result, events = run_queue([(2, 100), (0, 299999)], already_released=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_no_mutation(events)
        self.assertEqual(events[-1], 'ALREADY_RELEASED')


if __name__ == '__main__':
    unittest.main()
