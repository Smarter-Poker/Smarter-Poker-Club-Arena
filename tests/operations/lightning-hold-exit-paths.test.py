#!/usr/bin/env python3
"""The Lightning hold's three shell functions, driven end to end with a fake
helper, a fake /health and a fake clock, through every path a release takes.

Extracted from server/scripts/engine-release-transaction.sh verbatim (the
functions and their state lines), so what runs here is what runs on the host.
The helper is a shell stub that records every call and acts on the journal the
way engine-release-lightning-hold.py does at the file level: pause creates the
journal, resume renames it to .released, a refusal keeps it and exits 1, an
unknown keeps it and exits 3. Scenarios:

  1. a counting-down break that this run cannot consume places no hold; a
     qualifying one places it once and never re-sends inside the break
  2. a break that passes without a cutover gives Lightning back (resume with
     the thaw already reported) and clears the placed flag
  3. a refused resume is said once and not asked again every pass
  4. a signalled exit makes one attempt inside the stop clock
  5. a retried transaction inherits its predecessor's journal
  6. a helper that cannot run is NEVER ASKED, not placed
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = (ROOT / 'server/scripts/engine-release-transaction.sh').read_text()


def slice_fn(name: str) -> str:
    start = SOURCE.index(name + '() {')
    return SOURCE[start:SOURCE.index('\n}\n', start) + 3]


STATE = SOURCE[SOURCE.index('LIGHTNING_HOLD_FILE="$REQUEST_ROOT/$RUN_ID.lightning-hold.json"'):SOURCE.index('\n', SOURCE.index('[ ! -e "$LIGHTNING_HOLD_FILE" ] || LIGHTNING_HOLD_PLACED=1')) + 1]
FUNCTIONS = slice_fn('hold_lightning_when_counting_down') + slice_fn('release_lightning_hold_if_break_over') + slice_fn('release_lightning_hold')

HELPER = r'''#!/usr/bin/env bash
# fake engine-release-lightning-hold.py: records calls, acts on the journal.
action="$1"; shift
hold=""; while [ $# -gt 0 ]; do case "$1" in --hold-file) hold="$2"; shift 2;; *) shift;; esac; done
echo "$action $(basename "$hold")" >> "$CALLS"
mode="$(cat "$HELPER_MODE")"
case "$action" in
  pause)
    [ "$mode" != pause-unknown ] || exit 3
    [ -e "$hold" ] || printf '{"schema":"engine-release-lightning-hold/v1","run_id":"7-1","held":["c1"]}\n' > "$hold"
    exit 0 ;;
  resume)
    case "$mode" in
      resume-refused) exit 1 ;;
      resume-unknown) exit 3 ;;
    esac
    [ ! -e "$hold" ] || mv "$hold" "$hold.released"
    exit 0 ;;
esac
exit 2
'''


class LightningHoldExitPaths(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / 'requests').mkdir()
        helper = self.root / 'hold.sh'
        helper.write_text(HELPER)
        helper.chmod(0o755)
        self.calls = self.root / 'calls'
        self.calls.write_text('')
        self.mode = self.root / 'mode'
        self.mode.write_text('ok')
        self.health = self.root / 'health.json'
        self.set_health(active=False)

    def tearDown(self):
        self.tmp.cleanup()

    def set_health(self, *, active: bool, reason: str = 'Scheduled Engine Maintenance', running: bool = True):
        m = {'active': active, 'phase': 'counting_down' if active else 'idle', 'durableConfirmed': active, 'reason': reason, 'schedule': None}
        self.health.write_text(json.dumps({'running': running, 'maintenance': m}))

    def run_bash(self, body: str, *, chicago: str = '2026-10-31T09:00:00Z', env_extra: dict | None = None, timeout_cmd: str = 'timeout'):
        """Run STATE + FUNCTIONS + body with the fakes. `chicago` is the UTC
        instant the hold's clock reads (python's datetime.now is patched)."""
        prefix = f'''set -euo pipefail
REQUEST_ROOT="{self.root}/requests"; RUN_ID=7-1; ENV_FILE=/dev/null
LIGHTNING_HOLD="{self.root}/hold.sh"; export CALLS="{self.calls}" HELPER_MODE="{self.mode}"
DRILL_MODE=''; DAILY_TRANSITION=0; ACTIVATION_FLOOR_END_EPOCH=0; ACTIVATION_FLOOR_OWNER_WINDOW=''
BREAK_END_EPOCH=0; LEGACY_ENTRY_BREAK_END_EPOCH=0
curl() {{ cat "{self.health}"; printf '\\n200'; }}
sleep() {{ echo "sleep $1" >> "{self.calls}"; }}
timeout() {{ shift 3; "$@"; }}
python3() {{ FAKE_NOW="{chicago}" command python3 -c 'import datetime as _d, sys, os
class _N(_d.datetime):
    @classmethod
    def now(cls, tz=None):
        base=_d.datetime.fromisoformat(os.environ["FAKE_NOW"].replace("Z","+00:00"))
        return base.astimezone(tz) if tz else base.replace(tzinfo=None)
_d.datetime=_N
import runpy
code=sys.argv[1]
exec(compile(code, "<hold>", "exec"), {{"__name__": "__main__"}})' "$2" "${{@:3}}"; }}
'''
        script = prefix + STATE + FUNCTIONS + body
        env = {**os.environ, **(env_extra or {})}
        return subprocess.run(['bash', '-c', script], capture_output=True, text=True, timeout=60, env=env)

    def calls_made(self):
        return [l for l in self.calls.read_text().splitlines() if not l.startswith('sleep')]

    def test_only_a_break_this_run_can_consume_places_the_hold_and_only_once(self):
        # Hourly :55 Scheduled break at 02:53 Chicago: not daily, not recovery -> no hold.
        self.set_health(active=True)
        r = self.run_bash('hold_lightning_when_counting_down; echo "placed=$LIGHTNING_HOLD_PLACED"', chicago='2026-10-31T07:53:30Z')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('placed=0', r.stdout)
        self.assertEqual(self.calls_made(), [])
        # 03:58 Chicago daily announcement -> hold placed once; a second pass re-sends nothing.
        r = self.run_bash('hold_lightning_when_counting_down; hold_lightning_when_counting_down; echo "placed=$LIGHTNING_HOLD_PLACED"', chicago='2026-10-31T08:58:30Z')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('placed=1', r.stdout)
        self.assertEqual(self.calls_made(), ['pause 7-1.lightning-hold.json'])
        self.assertTrue((self.root / 'requests/7-1.lightning-hold.json').exists())
        # A Deployment Recovery break qualifies at any minute.
        (self.root / 'requests/7-1.lightning-hold.json').unlink(); self.calls.write_text('')
        self.set_health(active=True, reason='Deployment Recovery')
        r = self.run_bash('hold_lightning_when_counting_down; echo "placed=$LIGHTNING_HOLD_PLACED"', chicago='2026-10-31T02:53:30Z')
        self.assertIn('placed=1', r.stdout)
        # An owner-window run is admitted only on its recovery break: the daily one places nothing.
        (self.root / 'requests/7-1.lightning-hold.json').unlink(); self.calls.write_text('')
        self.set_health(active=True)
        r = self.run_bash('ACTIVATION_FLOOR_OWNER_WINDOW=w1; ACTIVATION_FLOOR_END_EPOCH=9999999999; hold_lightning_when_counting_down; echo "placed=$LIGHTNING_HOLD_PLACED"', chicago='2026-10-31T08:58:30Z')
        self.assertIn('placed=0', r.stdout)
        self.assertEqual(self.calls_made(), [])

    def test_a_passed_break_gives_lightning_back_and_clears_the_flag(self):
        self.set_health(active=True)
        r = self.run_bash('''hold_lightning_when_counting_down
release_lightning_hold_if_break_over   # still counting down: nothing
printf '%s' "$(cat "$(ls ''' + str(self.root) + '''/requests/*.json)" >/dev/null && echo still-held)"; echo
cat > "''' + str(self.health) + '''" <<'J'
{"running": true, "maintenance": {"active": false, "phase": "idle"}}
J
release_lightning_hold_if_break_over
echo "placed=$LIGHTNING_HOLD_PLACED"''', chicago='2026-10-31T08:58:30Z')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('placed=0', r.stdout)
        self.assertEqual(self.calls_made(), ['pause 7-1.lightning-hold.json', 'resume 7-1.lightning-hold.json'])
        self.assertFalse((self.root / 'requests/7-1.lightning-hold.json').exists())
        self.assertTrue((self.root / 'requests/7-1.lightning-hold.json.released').exists())

    def test_a_refused_resume_is_said_once_and_not_asked_every_pass(self):
        self.set_health(active=True)
        self.run_bash('hold_lightning_when_counting_down', chicago='2026-10-31T08:58:30Z')
        self.calls.write_text('')
        self.mode.write_text('resume-refused')
        self.set_health(active=False)
        r = self.run_bash('release_lightning_hold_if_break_over; release_lightning_hold_if_break_over; release_lightning_hold_if_break_over; echo "placed=$LIGHTNING_HOLD_PLACED"')
        self.assertEqual(r.returncode, 0, r.stderr)
        # One in-loop attempt per pass, three passes; the refusal keeps the journal and the flag.
        self.assertEqual(self.calls_made(), ['resume 7-1.lightning-hold.json'] * 3)
        self.assertIn('placed=1', r.stdout)
        self.assertEqual(r.stderr.count('FATAL: the Lightning hold for run 7-1 could not be released'), 3)
        self.assertTrue((self.root / 'requests/7-1.lightning-hold.json').exists())

    def test_a_signalled_exit_makes_one_attempt_inside_the_stop_clock(self):
        (self.root / 'requests/7-1.lightning-hold.json').write_text('{}')
        self.mode.write_text('resume-unknown')
        self.set_health(active=False)
        r = self.run_bash('release_lightning_hold 75 $(( $(date +%s) + 100 )); echo "rc=$?"')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.calls_made(), ['resume 7-1.lightning-hold.json'])  # attempts=1
        self.assertIn('FATAL', r.stderr)
        # No stop budget left: nothing is asked, the journal is retained for the fence.
        self.calls.write_text('')
        r = self.run_bash('release_lightning_hold 75 $(( $(date +%s) + 5 ))')
        self.assertEqual(self.calls_made(), [])
        self.assertIn('no stop budget left', r.stderr)
        self.assertTrue((self.root / 'requests/7-1.lightning-hold.json').exists())
        # An ordinary exit: three attempts, fifteen seconds apart.
        self.calls.write_text('')
        r = self.run_bash('release_lightning_hold 0')
        self.assertEqual(self.calls_made(), ['resume 7-1.lightning-hold.json'] * 3)
        self.assertEqual(self.calls.read_text().count('sleep 15'), 2)

    def test_a_retried_transaction_inherits_the_journal_and_a_missing_helper_is_never_asked(self):
        (self.root / 'requests/7-1.lightning-hold.json').write_text('{}')
        r = self.run_bash('echo "placed=$LIGHTNING_HOLD_PLACED"')
        self.assertIn('placed=1', r.stdout)
        (self.root / 'requests/7-1.lightning-hold.json').unlink()
        self.set_health(active=True)
        r = self.run_bash('LIGHTNING_HOLD=/nonexistent/hold.py; hold_lightning_when_counting_down; echo "placed=$LIGHTNING_HOLD_PLACED"', chicago='2026-10-31T08:58:30Z')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('NEVER ASKED', r.stderr)
        self.assertIn('placed=0', r.stdout)


if __name__ == '__main__':
    unittest.main()
