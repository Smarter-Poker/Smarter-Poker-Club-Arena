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
              supersede_on=0, cancellation=False, already_released=False, legacy=False,
              checkpoint_exits=(0,), intent_after_defer=False, waiting_since=0):
    with tempfile.TemporaryDirectory(prefix='engine-window-queue-') as temp:
        directory = Path(temp)
        sequence = directory / 'certificate-sequence'
        sequence.write_text('0')
        checkpoint_sequence = directory / 'checkpoint-sequence'
        checkpoint_sequence.write_text('0')
        checkpoint_branches = '\n'.join(
            f'{i}) return {code} ;;' for i, code in enumerate(checkpoint_exits, 1)
        )
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
LEGACY_MIN_BREAK_REMAINING_MS=245000
BREAK_ADMISSION_MIN_BREAK_MS=260000
BREAK_LOCKED_MIN_BREAK_MS=245000
LEGACY_CHECKPOINT_BUDGET_SECONDS=40
LEGACY_ENTRY_ALLOWANCE_MS=15000
BREAK_WINDOW_MS=300000
BREAK_ENTRY_BUDGET_CEILING_MS=0
BREAK_ENTRY_BUDGET_MS=0
REQUEST_ROOT={shlex.quote(str(directory))}
CHECKPOINT_SEQUENCE={shlex.quote(str(checkpoint_sequence))}
LOCK_HELD=0
RECOVERY_WAIT_STARTED_EPOCH={waiting_since}
LEGACY_CHECKPOINT_REQUIRED={int(legacy)}
LEGACY_CHECKPOINT_ATTEMPTED=0
FRESHNESS_CALLS=0
EVENTS={shlex.quote(str(events))}
SEQUENCE={shlex.quote(str(sequence))}
event() {{ printf '%s\\n' "$*" >> "$EVENTS"; }}
date() {{
  case "$1" in
    +%s) printf '%s\\n' "$NOW" ;;
    +%s%3N) printf '%s\\n' "$((NOW * 1000))" ;;
    *) return 1 ;;
  esac
}}
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
# The exact legacy 8825 checkpoint path: entry countdown, seal read, rollback
# proof and the one-shot helper are stubbed; the queue's own ordering and the
# minimum it hands the post-checkpoint certificate are what is under test.
RUN_ID=35615604946-1
RELEASE_SEAL=engine-release-seal.py
LEGACY_CHECKPOINT_SHA=2f4e33560bcd23bfb5cc731f31816b2c2e2847e5
CHECKPOINT_758_SHA=758610f3f844406bbbaee2f5100ced36d84fb943
CHECKPOINT_A0_SHA=a0ab287d902879280f0c915e44f5222c5db4d7df
CHECKPOINT_8825_SHA=8825af51817f379c4261658ca29ecc9d8d81932d
CHECKPOINT_PREDECESSOR_SHA="$CHECKPOINT_8825_SHA"
legacy_checkpoint_countdown() {{ event "COUNTDOWN:$LOCK_HELD"; printf '%s\\n' $((NOW + 299)); }}
timeout() {{ printf '%s\\n' "$CHECKPOINT_8825_SHA"; }}
prove_rollback_readiness() {{ event "ROLLBACK_PROOF:$LOCK_HELD:$BREAK_END_EPOCH"; }}
# The helper's exit code per invocation: 0 ran, 75 deferred above its durable
# intent (nothing attempted), anything else refused. A deferral that leaves an
# intent behind is the fail-closed case and is simulated by writing the file.
legacy_checkpoint_stub() {{
  [ "$1" = "$RUN_ID" ]
  k=$(cat "$CHECKPOINT_SEQUENCE"); k=$((k + 1)); printf '%s\\n' "$k" > "$CHECKPOINT_SEQUENCE"
  event "LEGACY_CHECKPOINT:$LOCK_HELD:$k"; NOW=$((NOW + 25))
  if [ {int(intent_after_defer)} = 1 ]; then : > "$REQUEST_ROOT/$RUN_ID.legacy-checkpoint-intent"; fi
  case "$k" in
    {checkpoint_branches}
    *) return 1 ;;
  esac
}}
LEGACY_CHECKPOINT=legacy_checkpoint_stub
maintenance_certificate() {{
  n=$(cat "$SEQUENCE"); n=$((n + 1)); printf '%s\\n' "$n" > "$SEQUENCE"
  event "CERTIFICATE:$n:$LOCK_HELD:${{1:-$MIN_BREAK_REMAINING_MS}}"
  case "$n" in
    {branches}
    *) printf '0\\n'; return 1 ;;
  esac
}}
{HELPERS}
{RECOVERY}
{QUEUE}
  [ "$LOCK_HELD" = 1 ] || exit 95
  [ "$BREAK_REMAINING_MS" -ge "$CERTIFICATE_MIN_BREAK_MS" ] || exit 94
  [ "$LEGACY_CHECKPOINT_ATTEMPTED" = 1 ] || [ "$CERTIFICATE_MIN_BREAK_MS" = "$BREAK_LOCKED_MIN_BREAK_MS" ] || exit 93
  event "MISSED:$RECOVERY_ADMISSION_MISSED"
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

    def test_ordinary_locked_certificate_keeps_the_strict_minimum(self):
        result, events = run_queue([(0, 299999), (0, 299000)])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([e for e in events if e.startswith('CERTIFICATE:')],
                         ['CERTIFICATE:1:0:260000', 'CERTIFICATE:2:1:245000'])
        self.assertNotIn('LEGACY_CHECKPOINT:1:1', events)

    def test_legacy_checkpoint_is_read_against_the_legacy_reserve_after_it_ran(self):
        # Run 35615604946: the checkpoint enters at the 285000ms threshold and
        # its 40-second budget (~15 s entry, 20 s work, 5 s cleanup) comes out
        # of candidate proof. 260000ms after it is a complete certificate at
        # the 245000ms legacy minimum, never at the strict one, and only once
        # the checkpoint has actually been attempted.
        result, events = run_queue([(2, 275000), (0, 260000)], legacy=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        certificates = [e for e in events if e.startswith('CERTIFICATE:')]
        self.assertEqual(certificates, ['CERTIFICATE:1:0:285000', 'CERTIFICATE:2:1:245000'])
        checkpoint = events.index('LEGACY_CHECKPOINT:1:1')
        self.assertLess(events.index('ROLLBACK_PROOF:1:399'), checkpoint)
        self.assertLess(checkpoint, events.index('CERTIFICATE:2:1:245000'))
        self.assertEqual(events[-1], 'PREPARE_ALLOWED:1000:900:0')
        self.assertEqual(events.count('LOCK'), 1)

    def test_legacy_checkpoint_that_breaks_the_legacy_reserve_dies_before_prepare(self):
        result, events = run_queue([(2, 275000), (2, 244999)], legacy=True)
        self.assertEqual(result.returncode, 1)
        self.assert_no_mutation(events)
        self.assertIn('LEGACY_CHECKPOINT:1:1', events)
        self.assertIn('CERTIFICATE:2:1:245000', events)
        self.assertIn('245000ms legacy reserve', events[-1])
        self.assertIn('244999ms remaining', events[-1])

    def test_a_deferred_checkpoint_waits_for_a_later_countdown_and_enters_again(self):
        # The helper exited 75 above its durable intent: nothing was attempted,
        # so the transaction releases the lock, waits, and the NEXT countdown
        # admits a fresh attempt that is then read at the legacy minimum. One
        # attempt per countdown, the one-shot flag reset only for the deferral.
        result, events = run_queue([(2, 275000), (2, 275000), (0, 260000)], legacy=True,
                                   checkpoint_exits=(75, 0))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('LEGACY_CHECKPOINT:1:1', events)
        self.assertIn('LEGACY_CHECKPOINT:1:2', events)
        deferred = events.index('LEGACY_CHECKPOINT:1:1')
        self.assertEqual(events[deferred + 1], 'UNLOCK')
        self.assertTrue(events[deferred + 2].startswith('SLEEP:15:'), events[deferred + 2])
        # the deferral is read by NO certificate: the next unlocked read is an
        # ordinary strict one, and only the fresh attempt is read at 245000
        self.assertEqual([e for e in events if e.startswith('CERTIFICATE:')],
                         ['CERTIFICATE:1:0:285000', 'CERTIFICATE:2:0:285000', 'CERTIFICATE:3:1:245000'])
        self.assertLess(events.index('LEGACY_CHECKPOINT:1:2'), events.index('CERTIFICATE:3:1:245000'))
        self.assertEqual(events.count('LOCK'), 2)
        self.assertEqual(events[-1], 'PREPARE_ALLOWED:1000:900:0')

    def test_a_deferral_that_left_a_durable_intent_behind_ends_the_release(self):
        # Exit 75 is not trusted on its own: an intent file means the operation
        # really started, and a retry stays forbidden however the helper exited.
        result, events = run_queue([(2, 275000), (2, 275000), (0, 260000)], legacy=True,
                                   checkpoint_exits=(75, 0), intent_after_defer=True)
        self.assertEqual(result.returncode, 1)
        self.assert_no_mutation(events)
        self.assertIn('LEGACY_CHECKPOINT:1:1', events)
        self.assertNotIn('LEGACY_CHECKPOINT:1:2', events)
        self.assertEqual(events[-1], 'DIE:legacy checkpoint deferred but its durable intent exists; refusing a retry')


    def test_a_short_break_is_a_missed_scheduled_break_only_for_a_release_already_waiting(self):
        # NOW=100 reads 240000ms: the break opened at t=40 and could admit
        # until t=80. Waiting since 0 it missed that break; waiting since 90
        # it arrived after the break could admit anyone, which is not the
        # break failing, and it gets no off-cycle reason from it.
        for waiting_since, expected in [(0, 'MISSED:1'), (80, 'MISSED:1'), (90, 'MISSED:0')]:
            with self.subTest(waiting_since=waiting_since):
                result, events = run_queue([(2, 240000), (0, 299999), (0, 299000)],
                                           waiting_since=waiting_since)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(events[-2], expected)
        # The locked read's short answer is judged the same way.
        result, events = run_queue([(0, 299999), (2, 240000), (0, 299999), (0, 299000)],
                                   waiting_since=90)
        self.assertEqual(events[-2], 'MISSED:0')
        result, events = run_queue([(0, 299999), (2, 240000), (0, 299999), (0, 299000)])
        self.assertEqual(events[-2], 'MISSED:1')


if __name__ == '__main__':
    unittest.main()
