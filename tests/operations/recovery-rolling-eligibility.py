#!/usr/bin/env python3
"""Real recovery block, owner-minute predicate and locked seal on isolated files.

Health, protected-source transport, engine lock and announcement are positive
I/O fixtures, including floor-entry creation and foreign-owner checks. Floor
retirement uses the maintained cleanup function. The seal CLI, file lock,
rolling-hour calculation and durable
reservation are real. No serving engine or production database is contacted.
"""
from contextlib import contextmanager
import datetime as dt
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = (ROOT / 'server/scripts/engine-release-transaction.sh').read_text()
PRIOR = int(dt.datetime.fromisoformat('2026-10-29T23:53:05.705+00:00').timestamp() * 1000)
FIRST = int(dt.datetime.fromisoformat('2026-10-30T00:53:00+00:00').timestamp() * 1000)
TARGET = 'b' * 40


@contextmanager
def fixture(priors=None, *, malformed=False, unknown=False, floor=False):
    with tempfile.TemporaryDirectory(prefix='recovery-rolling-', dir=os.environ.get('RUNNER_TEMP') or os.environ.get('TMPDIR') or ROOT.parent) as name:
        root = Path(name)
        state_dir = root / 'state'
        state_dir.mkdir()
        state_file = state_dir / 'engine-release-seal.json'
        state_file.write_text(json.dumps({'schema': 1, 'desired': {'sha': 'a' * 40, 'imageId': 'sha256:' + '1' * 64}, 'highWaterSha': 'a' * 40, 'generation': 1, 'pending': None}))
        for i, stamp in enumerate([PRIOR] if priors is None else priors):
            p = state_dir / f'engine-recovery-window-{899-i}-1.json'
            p.write_text('{' if malformed else json.dumps({'runId': f'{899-i}-1', 'sha': 'a' * 40, 'announcedAt': stamp, 'cause': 'urgent'}))
            os.utime(p, ns=(stamp * 1_000_000, stamp * 1_000_000))
        windows = {'version': 1, 'windows': [{'id': 'offline-exact-minute', 'contains': TARGET, 'ownerOrder': 'Offline fixture known eligible owner order', 'notBefore': '2026-10-30T00:00:00Z', 'notAfter': '2026-10-30T03:00:00Z', 'announceAtChicagoMinutes': [53]}]}
        (root / 'windows.json').write_text(json.dumps(windows))
        wrapper = root / 'seal-wrapper.py'
        wrapper.write_text(f'''#!/usr/bin/env python3
import importlib.util,os
spec=importlib.util.spec_from_file_location('actual_seal',{str(ROOT / 'server/scripts/engine-release-seal.py')!r})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.time.time=lambda:int(os.environ['NOW_MS'])/1000
# Protected ancestry is an explicitly positive outer transport fixture.
m.git_is_ancestor=lambda *args:None
m.main()
''')
        wrapper.chmod(0o700)
        env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'CASE': str(root), 'ENGINE_RELEASE_STATE_DIR': str(state_dir), 'ENGINE_RELEASE_STATE_FILE': str(state_file), 'ENGINE_RELEASE_LOCK_FILE': str(root / 'seal.lock'), 'ENGINE_RELEASE_AUDIT_FILE': str(state_dir / 'audit.jsonl'), 'ENGINE_RELEASE_RESULT_DIR': str(state_dir / 'results')}
        health = json.dumps({'liveness': 'ok', 'releaseSha': 'a' * 40, 'running': True, 'maintenance': {'active': False, 'recoveryWindowReady': True, 'recoveryWindowProtocol': 'engine-recovery-window-v1'}})
        block = SOURCE[SOURCE.index('RECOVERY_REQUESTED=0'):SOURCE.index('persist_break_deadline() {')]
        script = f'''set -euo pipefail
CASE={shlex.quote(str(root))}
SHA={TARGET}; RUN_ID=900-2; REPO_DIR=/offline-fixture; CONTAINER=offline-fixture
RELEASE_SEAL="$CASE/seal-wrapper.py"; REQUEST_ROOT="$CASE/requests"; mkdir -p "$REQUEST_ROOT"
SUPERSEDED_BY=''; LEGACY_CHECKPOINT_REQUIRED=0; CERTIFICATE_DEADLINE=0; LOCK_HELD=0
HEALTH={shlex.quote(health)}
record() {{ printf '%s\\n' "$*" >> "$CASE/events"; }}
date() {{ [ "$1" = +%s ]; echo "$((NOW_MS/1000))"; }}
curl() {{ record HEALTH; printf '%s' "$HEALTH"; }}
die() {{ echo "DIE:$*" >&2; exit 90; }}
acquire_engine_lock() {{ [ "$LOCK_HELD" = 0 ]; LOCK_HELD=1; record LOCK; }}
release_engine_lock() {{ [ "$LOCK_HELD" = 1 ]; LOCK_HELD=0; record UNLOCK; }}
source_target_is_current() {{ record SOURCE; }}
exact_runtime_instance() {{ return 1; }}
emit_already_released() {{ exit 91; }}
fixture_git() {{
 if [ "$1" = show ]; then cat "$CASE/windows.json"; return; fi
 if [ "$1" = merge-base ]; then [ "$4" = "$SHA" ]; return; fi
 exit 92
}}
timeout() {{
 shift 3
 if [ "$1" = env ]; then shift 2; fi
 if [ "$1" = git ]; then shift 3; fixture_git "$@"
 elif [ "$1" = "$RELEASE_SEAL" ]; then record "SEAL:$NOW_MS"; "$@"
 elif [ "$1" = docker ]; then cat >/dev/null; record "ANNOUNCE:$NOW_MS"; {'return 1' if unknown else 'echo accepted'}
 else echo unexpected-transport >&2; exit 93; fi
}}
{block}
'''
        if floor:
            helper = SOURCE[SOURCE.index('retire_unannounced_floor_entry() {'):SOURCE.index('# THE NEWEST WAITING RELEASE')]
            floor_setup = """ACTIVATION_FLOOR_OWNER_WINDOW=offline-exact-minute
FLOOR_DISPOSITION=never-entered
refuse_foreign_floor_owner() { record FLOOR_OWNER_CHECK; }
record_floor_runtime_entry() { printf 'fixture-owned-entry\\n' > "$REQUEST_ROOT/$RUN_ID.activation-entry"; }
"""
            script = script.replace(block, helper + floor_setup + block)
        before = state_file.read_bytes()
        yield root, env, script, before
        if state_file.read_bytes() != before:
            raise AssertionError('Primary release seal changed during announcement qualification')


def invoke(times, *, priors=None, malformed=False, unknown=False):
    with fixture(priors, malformed=malformed, unknown=unknown) as (root, env, script, _):
        for stamp in times:
            script += f'export NOW_MS={stamp}\nrequest_recovery_window\nprintf "STATE next=%s requested=%s lock=%s\\n" "$RECOVERY_NEXT_EVALUATION" "$RECOVERY_REQUESTED" "$LOCK_HELD"\n'
        result = subprocess.run(['bash', '-c', script], env=env, text=True, capture_output=True, timeout=15)
        events = (root / 'events').read_text().splitlines() if (root / 'events').exists() else []
        reservation = root / 'state/engine-recovery-window-900-2.json'
        return result, events, json.loads(reservation.read_text()) if reservation.exists() else None


class RollingEligibility(unittest.TestCase):
    def test_existing_owner_minute_reaches_exact_rolling_boundary_once(self):
        result, events, receipt = invoke([FIRST, PRIOR + 3_600_000 - 1, FIRST + 6000, FIRST + 11000])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f'next={(PRIOR + 3_600_000 + 999)//1000} requested=0 lock=0', result.stdout)
        self.assertEqual(sum(e.startswith('SEAL:') for e in events), 2, events)
        self.assertEqual([e for e in events if e.startswith('ANNOUNCE:')], [f'ANNOUNCE:{FIRST+6000}'])
        self.assertEqual(receipt['announcedAt'], FIRST + 6000)
        self.assertEqual(receipt['cause'], 'urgent')
        self.assertEqual(events.count('LOCK'), events.count('UNLOCK'))

    def test_latest_blocker_owns_eligibility_not_first_sorted_reservation(self):
        latest = PRIOR + 14_500
        result, events, receipt = invoke([FIRST, FIRST + 20_000, FIRST + 21_000], priors=[PRIOR, latest])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f'next={(latest+3_600_000+999)//1000} requested=0', result.stdout)
        self.assertEqual([e for e in events if e.startswith('ANNOUNCE:')], [f'ANNOUNCE:{FIRST+21000}'])
        self.assertEqual(receipt['announcedAt'], FIRST + 21_000)

    def test_seal_accepts_exact_hour_equality_without_an_earlier_reservation(self):
        result, events, receipt = invoke([PRIOR + 3_600_000])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(receipt['announcedAt'], PRIOR + 3_600_000)
        self.assertEqual(sum(e.startswith('ANNOUNCE:') for e in events), 1)

    def test_unknown_prior_json_keeps_existing_file_time_refusal(self):
        result, events, receipt = invoke([FIRST], malformed=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f'next={(PRIOR+3_600_000+999)//1000} requested=0', result.stdout)
        self.assertIsNone(receipt)
        self.assertFalse(any(e.startswith('ANNOUNCE:') for e in events))

    def test_eligibility_outside_owner_minute_cannot_widen_the_window(self):
        prior = FIRST - 3_600_000 + 59_001
        result, events, receipt = invoke([FIRST, FIRST + 60_000], priors=[prior])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum(e.startswith('SEAL:') for e in events), 1)
        self.assertIsNone(receipt)
        self.assertNotIn('ANNOUNCE:', '\n'.join(events))

    def test_unknown_announcement_ack_never_allocates_or_sends_again(self):
        result, events, receipt = invoke([FIRST, FIRST + 6000, FIRST + 11000], unknown=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(': unknown;', result.stdout)
        self.assertEqual(sum(e.startswith('ANNOUNCE:') for e in events), 1)
        self.assertEqual(sum(e.startswith('SEAL:') for e in events), 2)
        self.assertEqual(receipt['announcedAt'], FIRST + 6000)

    def test_floor_epoch_refusal_retires_only_its_unannounced_entry(self):
        with fixture(floor=True) as (root, env, script, _):
            foreign = root / 'requests/foreign.activation-entry'
            foreign.parent.mkdir(exist_ok=True)
            foreign.write_text('foreign-owner')
            result = subprocess.run(['bash', '-c', script + f'export NOW_MS={FIRST}\nrequest_recovery_window\n'], env=env, text=True, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((root / 'requests/900-2.activation-entry').exists())
            self.assertEqual(foreign.read_text(), 'foreign-owner')
            self.assertFalse((root / 'state/engine-recovery-window-900-2.json').exists())
            self.assertNotIn('ANNOUNCE:', (root / 'events').read_text())

    def test_floor_unknown_reservation_keeps_its_entry(self):
        with fixture(floor=True) as (root, env, script, _):
            (root / 'seal-wrapper.py').write_text('#!/usr/bin/env python3\nraise SystemExit(75)\n')
            result = subprocess.run(['bash', '-c', script + f'export NOW_MS={FIRST}\nrequest_recovery_window\n'], env=env, text=True, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((root / 'requests/900-2.activation-entry').is_file())
            self.assertFalse((root / 'state/engine-recovery-window-900-2.json').exists())
            self.assertNotIn('ANNOUNCE:', (root / 'events').read_text())

    def test_corrupt_future_eligibility_cannot_authorize_an_announcement(self):
        with fixture() as (root, env, script, _):
            prior = root / 'state/engine-recovery-window-899-1.json'
            prior.write_text(json.dumps({'announcedAt': 10**20}))
            result = subprocess.run(['bash', '-c', script + f'export NOW_MS={FIRST}\nrequest_recovery_window\n'], env=env, text=True, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 90, result.stderr)
            self.assertIn('invalid recovery announcement timestamp', result.stderr)
            self.assertNotIn('ANNOUNCE:', (root / 'events').read_text())
            self.assertFalse((root / 'state/engine-recovery-window-900-2.json').exists())

    def test_default_cli_stays_compatible_and_metadata_is_readonly(self):
        with fixture() as (root, env, _, _):
            env['NOW_MS'] = str(FIRST)
            args = [str(root / 'seal-wrapper.py'), 'reserve-recovery-window', '--sha', TARGET, '--run-id', '900-2', '--repo', '/offline-fixture', '--cause', 'urgent']
            normal = subprocess.run(args, env=env, text=True, capture_output=True, timeout=5)
            detailed = subprocess.run(args + ['--include-eligibility'], env=env, text=True, capture_output=True, timeout=5)
            self.assertEqual(normal.returncode, 0, normal.stderr)
            self.assertEqual(detailed.returncode, 0, detailed.stderr)
            self.assertEqual(normal.stdout, 'rate-limited\n')
            self.assertEqual(detailed.stdout, f'rate-limited:{PRIOR+3_600_000}\n')
            self.assertFalse((root / 'state/engine-recovery-window-900-2.json').exists())
            self.assertFalse((root / 'state/audit.jsonl').exists())

    def test_native_seal_lock_allows_only_one_concurrent_boundary_reservation(self):
        with fixture(priors=[]) as (root, env, _, _):
            env['NOW_MS'] = str(FIRST)
            commands = [[str(root / 'seal-wrapper.py'), 'reserve-recovery-window', '--sha', TARGET, '--run-id', run, '--repo', '/offline-fixture', '--cause', 'urgent', '--include-eligibility'] for run in ['900-2', '901-2']]
            children = [subprocess.Popen(cmd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for cmd in commands]
            try:
                replies = [child.communicate(timeout=5) for child in children]
                self.assertEqual([child.returncode for child in children], [0, 0], replies)
                self.assertEqual(sorted(out.strip() for out, _ in replies), sorted([str(FIRST), f'rate-limited:{FIRST+3_600_000}']))
                self.assertEqual(len(list((root / 'state').glob('engine-recovery-window-*.json'))), 1)
            finally:
                for child in children:
                    if child.poll() is None:
                        child.kill()
                for child in children:
                    child.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main()
