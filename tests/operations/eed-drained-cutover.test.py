#!/usr/bin/env python3
"""eed06fe5 is replaced at a drained hand boundary, never by a census that cannot fit.

Executes the real pre-prepare queue of engine-release-transaction.sh (through
the window-queue fixture's isolated clock/certificate doubles), the real
census-fit and strict-certificate predicates embedded in it, and the real
drained-boundary mode of engine-release-inflight-hands.py with its two
database reads replaced by scripted answers.
"""
import importlib.util
import io
import json
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import subprocess
import sys
import types
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('queue_fixture', ROOT / 'tests/operations/engine-release-window-queue.py')
Q = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(Q)
TRANSACTION = Q.SOURCE
NATIVE_RUN = subprocess.run
EED = 'eed06fe51dea622069c661a6213d5b031ff3a9e3'


def embedded_python(function, after):
    """The python3 -c program of `function`, taken from the shipped script."""
    body = TRANSACTION[TRANSACTION.index(function + '() {'):]
    body = body[body.index(after):]
    start = body.index("python3 -c '\n") + len("python3 -c '\n")
    return body[start:body.index("\n'", start)]


CENSUS_FIT = embedded_python('legacy_census_fits', 'printf')
CERTIFICATE = embedded_python('maintenance_certificate', 'verdict="$(')


def run_python(program, payload, env):
    return NATIVE_RUN([sys.executable, '-c', program], input=json.dumps(payload), text=True,
                      capture_output=True, timeout=10, env={'PATH': '/usr/bin:/bin', **env})


class CensusFitTests(unittest.TestCase):
    ENV = {'EXPECTED_SHA': EED, 'MS_PER_MB': '12', 'ALLOWANCE_MS': '30300'}

    def fit(self, memory, sha=EED):
        return run_python(CENSUS_FIT, {'releaseSha': sha, 'memory': memory}, self.ENV).returncode

    def test_the_live_heap_never_fits(self):
        # /health at 21:2x UTC 2026-10-31 read 3243 and 3700; 19:55Z was ~3850.
        for heap in (3243, 3700, 3850, 2525):
            with self.subTest(heap=heap):
                self.assertEqual(self.fit({'heapUsedMb': heap}), 1)

    def test_a_small_heap_fits_with_the_rounding_margin(self):
        self.assertEqual(self.fit({'heapUsedMb': 2524}), 0)
        self.assertEqual(self.fit({'heapUsedMb': 1200}), 0)

    def test_an_unreadable_heap_is_never_a_fit(self):
        for memory in (None, {}, {'heapUsedMb': None}, {'heapUsedMb': True},
                       {'heapUsedMb': 0}, {'heapUsedMb': -5}, {'heapUsedMb': '2000'}):
            with self.subTest(memory=memory):
                self.assertEqual(self.fit(memory), 3)

    def test_a_different_serving_release_is_never_measured_as_eed(self):
        self.assertEqual(self.fit({'heapUsedMb': 100}, sha='f' * 40), 3)


class StrictCertificateTests(unittest.TestCase):
    def certificate(self, maintenance, strict):
        payload = {'running': True, 'handsInFlightTotal': 0, 'weeklyPayout': None,
                   'maintenance': {'reason': 'Deployment Recovery', 'active': True,
                                   'phase': 'counting_down', 'durableConfirmed': True,
                                   'remainingMs': 290000, **maintenance}}
        return run_python(CERTIFICATE, payload, {'MIN_BREAK_MS': '260000',
                                                 'STRICT_RESTART_CERTIFICATE': strict})

    def test_an_open_certificate_admits_in_both_modes(self):
        for strict in ('0', '1'):
            result = self.certificate({'readyForRestart': True, 'unparkedTables': 0}, strict)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), '290000')

    def test_a_bounded_preparation_never_reaches_the_database_admission_when_strict(self):
        shut = {'readyForRestart': False, 'unparkedTables': 3,
                'unparkedReasons': {'f06_preparation_stuck': 3}}
        self.assertEqual(self.certificate(shut, '0').returncode, 4)
        strict = self.certificate(shut, '1')
        self.assertEqual(strict.returncode, 1)
        self.assertIn('the restart certificate is shut', strict.stderr)

    def test_cards_in_air_refuses_in_both_modes(self):
        shut = {'readyForRestart': False, 'unparkedTables': 78,
                'unparkedReasons': {'cards_in_air': 78}}
        for strict in ('0', '1'):
            self.assertEqual(self.certificate(shut, strict).returncode, 1)


def load_helper():
    spec = importlib.util.spec_from_file_location('inflight', ROOT / 'server/scripts/engine-release-inflight-hands.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DrainedWitnessHelperTests(unittest.TestCase):
    QUIET = {'contract': 'drained-predecessor-witness-v1', 'observed_at': '2026-10-31T21:55:30Z',
             'moving_window_seconds': 120, 'lightning_window_seconds': 600,
             'reserved_tournament_permits': 102, 'retained_tournament_hands': 102,
             'moving_tournament_hands': 0, 'unsettled_recent_lightning_hands': 0}

    def run_helper(self, witness, snapshots=()):
        helper = load_helper()
        calls = []
        helper.read_fixed_env = lambda _path: {
            'SUPABASE_URL': 'https://kuklfnapbkmacvwxktbh.supabase.co', 'SUPABASE_SERVICE_ROLE_KEY': 'k'}

        def get_json(url, _key, _timeout, payload=None):
            calls.append(url.split('/rest/v1/')[1].split('?')[0])
            if 'fn_ca_release_drained_predecessor_witness' in url:
                if witness == 'unreachable':
                    helper.unknown('the database could not be reached')
                return witness
            if snapshots == 'unreachable':
                helper.unknown('the database could not be reached')
            return list(snapshots)
        helper.get_json = get_json
        sys.argv = ['helper', '--env-file', 'unused', '--drained-predecessor', '--timeout-seconds', '5']
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            with self.assertRaises(SystemExit) as raised:
                helper.main()
        return raised.exception.code, calls, err.getvalue()

    def test_quiet_only_when_both_halves_were_read_and_quiet(self):
        code, calls, err = self.run_helper(self.QUIET)
        self.assertEqual(code, 0, err)
        self.assertEqual(calls, ['rpc/fn_ca_release_drained_predecessor_witness', 'hand_state_snapshots'])
        # Durable retained hands on stalled tables are reported, never a refusal.
        self.assertIn('retained_tournament_hands=102', err)

    def test_any_moving_hand_refuses(self):
        for key in ('moving_tournament_hands', 'unsettled_recent_lightning_hands'):
            with self.subTest(key=key):
                code, _calls, _err = self.run_helper({**self.QUIET, key: 1})
                self.assertEqual(code, 1)
        code, _calls, _err = self.run_helper(self.QUIET, snapshots=[{'table_id': 't', 'hand_number': 1}])
        self.assertEqual(code, 1)

    def test_unreadable_is_unknown_never_quiet(self):
        broken = [
            'unreachable', None, [], {**self.QUIET, 'contract': 'other'},
            {**self.QUIET, 'moving_tournament_hands': None},
            {**self.QUIET, 'moving_tournament_hands': False},
            {**self.QUIET, 'unsettled_recent_lightning_hands': -1},
            {**self.QUIET, 'lightning_window_seconds': 60},
            {k: v for k, v in self.QUIET.items() if k != 'observed_at'},
        ]
        for witness in broken:
            with self.subTest(witness=witness):
                code, _calls, _err = self.run_helper(witness)
                self.assertEqual(code, 3)
        code, _calls, _err = self.run_helper(self.QUIET, snapshots='unreachable')
        self.assertEqual(code, 3)


def drained_queue(certificates, *, legacy=False, census_fits=(), witness=(0,), predecessor=EED,
                  cancellation=False):
    """The real queue with eed06fe5 sealed as the predecessor."""
    census_branches = '\n'.join(f'{i}) return {c} ;;' for i, c in enumerate(census_fits, 1))
    witness_branches = '\n'.join(f'{i}) return {c} ;;' for i, c in enumerate(witness, 1))

    def execute(args, **kwargs):
        script = kwargs['input']
        old = 'CHECKPOINT_PREDECESSOR_SHA="$CHECKPOINT_8825_SHA"\n'
        assert old in script
        controls = f'''CHECKPOINT_PREDECESSOR_SHA={predecessor}
DRAINED_PREDECESSOR_CUTOVER={int(not legacy)}
LEGACY_CHECKPOINT_REQUIRED={int(legacy)}
CENSUS_CALLS=0
CONTROL_DIR=/nonexistent-control
WITNESS_CALLS=0
legacy_census_fits() {{
  CENSUS_CALLS=$((CENSUS_CALLS + 1)); event "CENSUS_FIT:$LOCK_HELD:$CENSUS_CALLS"
  case "$CENSUS_CALLS" in
    {census_branches}
    *) return 1 ;;
  esac
}}
drained_predecessor_witness() {{
  WITNESS_CALLS=$((WITNESS_CALLS + 1)); event "WITNESS:$LOCK_HELD:$WITNESS_CALLS"
  case "$WITNESS_CALLS" in
    {witness_branches}
    *) return 1 ;;
  esac
}}
switch_to_drained_predecessor_cutover() {{
  LEGACY_CHECKPOINT_REQUIRED=0; DRAINED_PREDECESSOR_CUTOVER=1; event SWITCH_TO_DRAINED
}}
'''
        script = script.replace(old, controls)
        harness_timeout = "timeout() { printf '%s\\n' \"$CHECKPOINT_8825_SHA\"; }"
        assert harness_timeout in script
        script = script.replace(harness_timeout, f"timeout() {{ printf '%s\\n' {predecessor}; }}")
        # Record which strictness each certificate read was asked for.
        script = script.replace('event "CERTIFICATE:$n:$LOCK_HELD:${1:-$MIN_BREAK_REMAINING_MS}"',
                                'event "CERTIFICATE:$n:$LOCK_HELD:${1:-$MIN_BREAK_REMAINING_MS}:strict=$DRAINED_PREDECESSOR_CUTOVER"')
        kwargs['input'] = script
        return NATIVE_RUN(args, **kwargs)
    previous = Q.subprocess
    Q.subprocess = types.SimpleNamespace(run=execute)
    try:
        return Q.run_queue(certificates, legacy=legacy, cancellation=cancellation)
    finally:
        Q.subprocess = previous


class DrainedQueueTests(unittest.TestCase):
    def assert_no_checkpoint(self, events):
        self.assertFalse(any(e.startswith('LEGACY_CHECKPOINT') for e in events), events)
        self.assertFalse(any(e.startswith('COUNTDOWN') for e in events), events)

    def test_a_drained_boundary_cuts_over_on_the_ordinary_ladder_without_a_checkpoint(self):
        result, events = drained_queue([(0, 262000), (0, 250000)])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_no_checkpoint(events)
        self.assertIn('CERTIFICATE:1:0:260000:strict=1', events)
        self.assertIn('CERTIFICATE:2:1:245000:strict=1', events)
        # The witness is read under the lock and BEFORE the locked certificate,
        # which stays the last read before the break deadline is fixed.
        self.assertLess(events.index('WITNESS:1:1'), events.index('CERTIFICATE:2:1:245000:strict=1'))
        self.assertIn('LIGHTNING_HOLD:0', events)
        self.assertTrue(events[-1].startswith('PREPARE_ALLOWED:'), events)

    def test_a_predecessor_that_is_not_drained_releases_the_lock_and_never_prepares(self):
        result, events = drained_queue([(0, 262000)] * 3, witness=(1, 1, 1), cancellation=True)
        self.assertNotEqual(result.returncode, 0)
        self.assert_no_checkpoint(events)
        self.assertIn('UNLOCK', events)
        self.assertLess(events.index('WITNESS:1:1'), events.index('UNLOCK'))
        self.assertFalse(any(e.startswith('PREPARE_ALLOWED:') for e in events), events)
        self.assertNotIn('SLEEP_WITH_LOCK', events)

    def test_a_witness_that_cannot_be_read_never_prepares(self):
        result, events = drained_queue([(0, 262000)], witness=(3,), cancellation=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(e.startswith('PREPARE_ALLOWED:') for e in events), events)

    def test_a_shut_certificate_never_reaches_the_witness(self):
        result, events = drained_queue([(1, 290000)], cancellation=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(e.startswith('WITNESS') for e in events), events)
        self.assertNotIn('LOCK', events)

    def test_a_later_drained_read_in_the_same_break_still_cuts_over(self):
        result, events = drained_queue([(0, 275000), (0, 262000), (0, 250000)], witness=(1, 0))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_no_checkpoint(events)
        self.assertEqual(events.count('LOCK'), 2)
        self.assertTrue(events[-1].startswith('PREPARE_ALLOWED:'), events)

    def test_a_census_that_stops_fitting_while_waiting_is_never_entered(self):
        result, events = drained_queue([(0, 262000), (0, 250000)], legacy=True, census_fits=(1,))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('SWITCH_TO_DRAINED', events)
        self.assert_no_checkpoint(events)
        self.assertTrue(events[-1].startswith('PREPARE_ALLOWED:'), events)

    def test_a_census_that_stops_fitting_at_the_intent_is_never_opened(self):
        # Fits at the top of the pass, no longer fits immediately before the
        # one-shot intent: nothing is written and the break is still usable.
        result, events = drained_queue([(2, 290000), (0, 262000), (0, 250000)], legacy=True,
                                       census_fits=(0, 1))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(e.startswith('LEGACY_CHECKPOINT') for e in events), events)
        self.assertIn('SWITCH_TO_DRAINED', events)
        self.assertLess(events.index('CENSUS_FIT:1:2'), events.index('SWITCH_TO_DRAINED'))
        self.assertTrue(events[-1].startswith('PREPARE_ALLOWED:'), events)

    def test_a_census_that_fits_keeps_the_existing_checkpoint_path(self):
        result, events = drained_queue([(2, 275000), (0, 260000)], legacy=True, census_fits=(0, 0))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('SWITCH_TO_DRAINED', events)
        self.assertTrue(any(e.startswith('LEGACY_CHECKPOINT') for e in events), events)
        self.assertFalse(any(e.startswith('WITNESS') for e in events), events)

    def test_a_different_legacy_profile_under_the_lock_refuses(self):
        result, events = drained_queue([(0, 262000)], predecessor='8825af51817f379c4261658ca29ecc9d8d81932d')
        self.assertEqual(result.returncode, 1)
        self.assertTrue(any('different legacy profile' in e for e in events), events)


class PreNoticeGateTests(unittest.TestCase):
    """The decision is made before the wait loop, where no notice exists yet."""

    def test_the_gate_precedes_every_announcement_path(self):
        gate = TRANSACTION.index('if ! legacy_census_fits; then\n    switch_to_drained_predecessor_cutover')
        loop = TRANSACTION.index('while :; do', gate)
        self.assertLess(gate, loop)
        # request_recovery_window is only ever CALLED inside the loop.
        calls = [i for i in range(len(TRANSACTION)) if TRANSACTION.startswith('request_recovery_window\n', i)
                 or TRANSACTION.startswith('        request_recovery_window\n', i)]
        self.assertTrue(all(i > gate for i in calls))

    def test_an_unreadable_witness_refuses_before_notice(self):
        block = TRANSACTION[TRANSACTION.index('if ! legacy_census_fits; then\n    switch_to_drained_predecessor_cutover'):]
        block = block[:block.index('\nfi\nfi\n') if '\nfi\nfi\n' in block else 600]
        self.assertIn('[ "$DRAINED_WITNESS_RC" = 0 ] || [ "$DRAINED_WITNESS_RC" = 1 ]', block)
        self.assertIn("refusing before any notice so no break is spent", block)


if __name__ == '__main__':
    unittest.main()
