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


BASE_HEALTH = {'running': True, 'maintenance': {'active': False,
    'recoveryWindowProtocol': 'engine-recovery-window-v1', 'recoveryWindowReady': True}}
TARGET = 'b' * 40
NEWER = 'c' * 40


def invoke(*, capability=True, active=False, eligible=True, unknown=False, live=False, minute=30, ready=True, becomes_ready=False,
           health_extra=None, maintenance_extra=None, missed=False, urgent=False,
           certificate_deadline=0, superseded='', requests=(), seal_answers=None, calls=2, advance=0):
    """Run the real request_recovery_window `calls` times, `advance` seconds apart.

    `requests` are other durable requests on this host: (run, sha, unit state,
    whether TARGET is an ancestor of sha). `seal_answers` scripts the seal's
    successive answers to a reservation that names a cause; the default is the
    historical eligible flag. Like the real seal since 2026-10-04, the stub
    answers `unavailable` to any reservation without `--cause`.
    """
    with tempfile.TemporaryDirectory(prefix='recovery-owner-') as temp:
        events = Path(temp) / 'events'
        request_root = Path(temp) / 'requests'
        request_root.mkdir()
        states, ancestors = [], []
        for run, sha, state, contains in requests:
            (request_root / f'{run}.request').write_text(f'{sha}\nurl\nactor\ngen\n{"d" * 40}\n1\n')
            states.append(f'club-arena-engine-release-v1@{run}.service) echo {state} ;;')
            if contains:
                ancestors.append(sha)
        answers = list(seal_answers) if seal_answers is not None else [
            '1800000000000' if eligible else 'unavailable']
        answer_branches = '\n'.join(f'{i}) echo {a} ;;' for i, a in enumerate(answers, 1))
        maintenance = {'active': active,
            'recoveryWindowProtocol': 'engine-recovery-window-v1' if capability else None,
            'recoveryWindowReady': ready, **(maintenance_extra or {})}
        health = json.dumps({'running': True, 'maintenance': maintenance, **(health_extra or {})})
        calls_script = []
        for call in range(calls):
            if call == 1 and becomes_ready:
                calls_script.append('HEALTH=' + shlex.quote(json.dumps(BASE_HEALTH)))
            calls_script.append('request_recovery_window')
            calls_script.append(f'NOW=$((NOW + {advance}))')
        script = f'''
set -euo pipefail
EVENTS={shlex.quote(str(events))}
SHA={TARGET}; RUN_ID=900-2; REPO_DIR=/fixture; CONTAINER=fixture; RELEASE_SEAL=fixture-seal
REQUEST_ROOT={shlex.quote(str(request_root))}
BREAK_START_MINUTE=55
BREAK_WINDOW_MS=300000
BREAK_ADMISSION_MIN_BREAK_MS=260000
CERTIFICATE_DEADLINE={certificate_deadline}
SUPERSEDED_BY={superseded}
RECOVERY_URGENT={int(urgent)}
LOCK_HELD=0
NOW={1800000000 + minute * 60}
HEALTH={shlex.quote(health)}
record() {{ printf '%s\\n' "$*" >> "$EVENTS"; }}
date() {{ echo "$NOW"; }}
curl() {{ printf '%s' "$HEALTH"; }}
die() {{ record "DIE:$*"; exit 1; }}
acquire_engine_lock() {{ [ "$LOCK_HELD" = 0 ]; LOCK_HELD=1; record LOCK; }}
release_engine_lock() {{ [ "$LOCK_HELD" = 1 ]; LOCK_HELD=0; record UNLOCK; }}
source_target_is_current() {{ record SOURCE; }}
exact_runtime_instance() {{ [ {int(live)} = 1 ]; }}
emit_already_released() {{ record ALREADY; exit 0; }}
systemctl() {{
  case "$2" in
    {' '.join(states)}
    *) echo inactive ;;
  esac
}}
fixture_git() {{
  [ "$1 $2" = 'merge-base --is-ancestor' ] && [ "$3" = "$SHA" ] || exit 94
  case " {' '.join(ancestors)} " in *" $4 "*) return 0 ;; *) return 1 ;; esac
}}
timeout() {{
  shift 3
  if [ "$1" = env ]; then shift 2; fi
  if [ "$1" = fixture-seal ] && [ "$2" = reserve-recovery-window ]; then
    [ "$LOCK_HELD" = 1 ]; shift 8; record "RESERVE${{*:+:$*}}"
    # The real seal: a failed or missed release is not a cause, and a
    # reservation that names none is `unavailable` before anything is read.
    case " $* " in *' --cause '*) ;; *) echo unavailable; return 0 ;; esac
    # The seal answers inside $(...), a subshell: count on disk.
    RESERVES=$(( $(cat "$EVENTS.reserves" 2>/dev/null || echo 0) + 1 ))
    echo "$RESERVES" > "$EVENTS.reserves"
    case "$RESERVES" in
      {answer_branches}
      *) echo unavailable ;;
    esac
  elif [ "$1" = docker ]; then
    [ "$LOCK_HELD" = 1 ]; record REQUEST
    cat > /dev/null
    [ {int(unknown)} = 0 ] || return 1
    echo accepted
  elif [ "$1 $2 $3" = "git -C $REPO_DIR" ]; then
    shift 3; fixture_git "$@"
  else exit 95; fi
}}
{RECOVERY}
RECOVERY_ADMISSION_MISSED={int(missed)}
{chr(10).join(calls_script)}
[ "$LOCK_HELD" = 0 ]
'''
        result = subprocess.run(['bash'], input=script, text=True, capture_output=True, timeout=10)
        return result, events.read_text().splitlines() if events.exists() else []


def missed(*, waiting_since, remaining_ms, now=1800003360):
    script = f'''set -euo pipefail
BREAK_WINDOW_MS=300000
BREAK_ADMISSION_MIN_BREAK_MS=260000
date() {{ echo {now}; }}
{RECOVERY}
RECOVERY_WAIT_STARTED_EPOCH={waiting_since}
note_missed_admission {remaining_ms}
echo "$RECOVERY_ADMISSION_MISSED"
'''
    result = subprocess.run(['bash'], input=script, text=True, capture_output=True, timeout=5)
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


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

    # Every request below carries an emergency cause (urgent): since the
    # owner's 2026-10-04 ruling nothing else reaches the lock or the seal.

    def test_eligible_release_reserves_and_requests_once_inside_lock(self):
        result, events = invoke(urgent=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, ['LOCK', 'SOURCE', 'RESERVE:--cause urgent', 'REQUEST', 'UNLOCK'])

    def test_unchanged_transaction_can_request_after_prior_resume_finishes(self):
        result, events = invoke(urgent=True, ready=False, becomes_ready=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, ['LOCK', 'SOURCE', 'RESERVE:--cause urgent', 'REQUEST', 'UNLOCK'])

    def test_unknown_response_keeps_one_reservation_and_never_blind_retries(self):
        result, events = invoke(urgent=True, unknown=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events.count('RESERVE:--cause urgent'), 1)
        self.assertEqual(events.count('REQUEST'), 1)
        self.assertIn(': unknown;', result.stdout)

    def test_a_reservation_the_seal_refuses_does_not_announce(self):
        result, events = invoke(urgent=True, eligible=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        # Asked once; `unavailable` is remembered for this cause, not re-asked.
        self.assertEqual(events, ['LOCK', 'SOURCE', 'RESERVE:--cause urgent', 'UNLOCK'])

    def test_already_serving_target_finishes_without_another_pause(self):
        result, events = invoke(urgent=True, live=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, ['LOCK', 'SOURCE', 'ALREADY'])

    def test_old_engine_active_break_unfinished_thaw_or_hourly_overlap_never_requests(self):
        for inputs in ({'capability': False}, {'active': True}, {'minute': 48}, {'minute': 1}, {'ready': False}):
            with self.subTest(inputs=inputs):
                result, events = invoke(urgent=True, **inputs)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(events, [])


class ProportionateRecoveryWindowTests(unittest.TestCase):
    """2026-09-26: an off-cycle window needs a reason, the newest release owns
    it, and the seal allows one per rolling hour. None of it touches what
    makes a cutover safe; these tests only ever see RESERVE and REQUEST."""

    def test_an_ordinary_release_with_no_reason_never_takes_the_lock(self):
        # The seal answers `unavailable` to every reservation without a cause
        # (2026-10-04), so a routine release has nothing to ask: it does not
        # take the engine lock, re-read the source, reserve or announce, on
        # this evaluation or any later one.
        result, events = invoke(calls=3, advance=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, [])
        self.assertEqual(result.stdout, '')

    def test_a_degraded_engine_still_gets_its_window(self):
        for extra, maintenance, sign in [
            ({}, {'breaksSinceRestartCertified': 1}, 'breaksSinceRestartCertified=1'),
            ({'liveness': 'dead'}, {}, 'liveness=dead'),
            ({'wholeFleetStalled': True}, {}, 'wholeFleetStalled'),
            ({'tournamentManagersQuarantined': 338}, {}, 'tournamentManagersQuarantined=338'),
        ]:
            with self.subTest(sign=sign):
                result, events = invoke(health_extra=extra, maintenance_extra=maintenance)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(events, ['LOCK', 'SOURCE', 'RESERVE:--cause engine-degraded',
                                          'REQUEST', 'UNLOCK'])
                self.assertIn('reason: engine-degraded ' + sign, result.stdout)

    def test_healthy_signals_are_not_degradation(self):
        # 27 quarantined managers is what a normally dealing 209d1b45 carried on
        # 2026-09-26; its 07:37Z window, spent on 16 of them, shipped nothing.
        result, events = invoke(health_extra={
            'liveness': 'ok', 'wholeFleetStalled': False, 'tournamentManagersQuarantined': 27},
            maintenance_extra={'breaksSinceRestartCertified': 0})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, [])

    def test_an_urgent_release_still_gets_its_window(self):
        result, events = invoke(urgent=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, ['LOCK', 'SOURCE', 'RESERVE:--cause urgent', 'REQUEST', 'UNLOCK'])
        self.assertIn('reason: urgent Engine-Release: urgent', result.stdout)

    def test_a_release_no_scheduled_break_can_admit_before_its_deadline_asks(self):
        # :30 now; the next :55 admission ends at :55:40. A deadline at :50
        # cannot be met by waiting, a deadline at :57 can.
        now = 1800000000 + 30 * 60
        result, events = invoke(certificate_deadline=now + 20 * 60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, ['LOCK', 'SOURCE', 'RESERVE:--cause deadline', 'REQUEST', 'UNLOCK'])
        self.assertIn('reason: deadline ', result.stdout)
        result, events = invoke(certificate_deadline=now + 27 * 60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, [])

    def test_a_missed_scheduled_break_alone_is_not_a_reason(self):
        # Owner ruling 2026-10-04: one scheduled break an hour. A break this
        # release waited through - whether or not a sibling shipped in it (94c7cf0b
        # sealed in the 06:05 window on 2026-09-26; 1cb373d1 and 6cd35918 read the
        # rest of it as a missed certificate and each asked for another) - never
        # takes the lock, never reserves and never announces.
        result, events = invoke(missed=True, calls=3, advance=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, [])
        self.assertEqual(result.stdout, '')

    def test_a_missed_break_adds_nothing_to_a_real_cause(self):
        # The emergency cause is the whole reservation; no --missed-window.
        result, events = invoke(missed=True, urgent=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, ['LOCK', 'SOURCE', 'RESERVE:--cause urgent', 'REQUEST', 'UNLOCK'])

    def test_the_newest_release_owns_the_window(self):
        requests = [('901-1', NEWER, 'activating', True)]
        result, events = invoke(urgent=True, superseded=NEWER, requests=requests)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, ['LOCK', 'SOURCE', 'UNLOCK'])
        self.assertEqual(result.stdout.count('owns any off-cycle window'), 1)
        self.assertIn('run 901-1', result.stdout)
        # Deferral is re-evaluated, not cached: a minute later it still defers.
        result, events = invoke(urgent=True, superseded=NEWER, requests=requests, advance=60)
        self.assertEqual(events, ['LOCK', 'SOURCE', 'UNLOCK', 'LOCK', 'SOURCE', 'UNLOCK'])
        self.assertEqual(result.stdout.count('owns any off-cycle window'), 1)

    def test_an_urgent_or_degraded_older_release_still_defers_to_the_newer_one(self):
        requests = [('901-1', NEWER, 'active', True)]
        for options in ({'urgent': True}, {'maintenance_extra': {'breaksSinceRestartCertified': 3}}):
            with self.subTest(options=options):
                result, events = invoke(superseded=NEWER, requests=requests, **options)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn('REQUEST', events)

    def test_only_a_live_newer_release_owns_the_window(self):
        for requests in ([('901-1', NEWER, 'failed', True)],
                         [('901-1', NEWER, 'inactive', True)],
                         [('901-1', NEWER, 'active', False)],
                         [('900-2', NEWER, 'active', True)],
                         []):
            with self.subTest(requests=requests):
                result, events = invoke(urgent=True, superseded=NEWER, requests=requests)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(events, ['LOCK', 'SOURCE', 'RESERVE:--cause urgent',
                                          'REQUEST', 'UNLOCK'])

    def test_a_spent_hour_waits_and_asks_again_later_without_announcing(self):
        result, events = invoke(urgent=True, seal_answers=['rate-limited', 'rate-limited'],
                                calls=3, advance=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        # 0s asks, 30s is inside the deferral, 60s asks again.
        self.assertEqual(events, ['LOCK', 'SOURCE', 'RESERVE:--cause urgent', 'UNLOCK',
                                  'LOCK', 'SOURCE', 'RESERVE:--cause urgent', 'UNLOCK'])
        self.assertNotIn('REQUEST', events)
        self.assertIn('off-cycle window wanted (urgent Engine-Release: urgent) but one was already announced in the last hour', result.stdout)
        result, events = invoke(urgent=True, seal_answers=['rate-limited', '1800000000000'],
                                advance=60)
        self.assertEqual(events[-2:], ['REQUEST', 'UNLOCK'])
        self.assertEqual(events.count('REQUEST'), 1)

    def test_one_window_per_release_whatever_its_reasons(self):
        result, events = invoke(urgent=True, missed=True, calls=3, advance=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events.count('RESERVE:--cause urgent'), 1)
        self.assertEqual(sum(e.startswith('RESERVE') for e in events), 1)
        self.assertEqual(events.count('REQUEST'), 1)

    def test_only_a_release_waiting_when_the_break_could_admit_it_missed_it(self):
        # Still recorded (the queue reports it), no longer a reason to ask.
        # now is :56:00 of the hour; 240000ms remain, so the break opened at
        # :55:00 and could admit until :55:40.
        now = 1800000000 + 56 * 60
        opened = now - 60
        for waiting_since, expected in [(opened - 600, '1'), (opened + 40, '1'),
                                        (opened + 41, '0'), (now, '0')]:
            with self.subTest(waiting_since=waiting_since):
                self.assertEqual(missed(waiting_since=waiting_since, remaining_ms=240000, now=now),
                                 expected)
        # "0ms remaining" is read after a break ends and says nothing about it.
        self.assertEqual(missed(waiting_since=opened - 600, remaining_ms=0, now=now), '0')
        self.assertEqual(missed(waiting_since=opened - 600, remaining_ms='x', now=now), '0')


    def test_no_window_while_the_certificate_refuses_the_engine_in_every_break(self):
        # 209d1b45, 2026-09-26 07:37Z onward: 27 stopped-bank custodies past
        # their bound. Whatever the reason, a window could admit nobody.
        for options in ({'maintenance_extra': {'stoppedCustodyStuckTables': 27,
                                               'breaksSinceRestartCertified': 1}},
                        {'urgent': True, 'maintenance_extra': {'stoppedCustodyStuckTables': 1}},
                        {'certificate_deadline': 1800000000 + 50 * 60,
                         'maintenance_extra': {'stoppedCustodyStuckTables': 27}}):
            with self.subTest(options=options):
                result, events = invoke(calls=3, advance=30, **options)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(events, [])
                self.assertEqual(result.stdout.count('admit nobody'), 1)
        # Cleared custody (0) or an engine that does not report it asks as before.
        for maintenance in ({'stoppedCustodyStuckTables': 0, 'breaksSinceRestartCertified': 1},
                            {'stoppedCustodyStuckTables': True, 'breaksSinceRestartCertified': 1},
                            {'breaksSinceRestartCertified': 1}):
            with self.subTest(maintenance=maintenance):
                result, events = invoke(maintenance_extra=maintenance)
                self.assertEqual(events, ['LOCK', 'SOURCE', 'RESERVE:--cause engine-degraded',
                                          'REQUEST', 'UNLOCK'])


if __name__ == '__main__':
    unittest.main()
