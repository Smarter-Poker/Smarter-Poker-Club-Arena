#!/usr/bin/env python3
"""Execute the rollback drill's actual shell against isolated, real Git histories.

The drill record reader, the rollback admission (inside the real
source_target_is_current), the per-mode preconditions and the drill receipt
run as written in server/scripts/engine-release-transaction.sh, and
server/scripts/install-engine-drill.sh runs as a real script. Git, ancestry and
every admission decision execute for real.

Portable substitutes only: the clock, timeout, flock and sleep; the seal reader
(a file-backed fake answering the same three questions); and `id`/`stat`/
`readlink`/`mapfile`, which map the test user to root and stand in for GNU and
Bash 5 behaviour on macOS, so the root-ownership checks run unprivileged in CI
and on the workstation. Nothing here starts, stops or signals a process.
"""
from pathlib import Path
import atexit
import base64
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SOURCE = (ROOT / 'server/scripts/engine-release-transaction.sh').read_text()
ENTRY_READ = SOURCE[SOURCE.index('legacy_entry_read() {'):SOURCE.index('legacy_entry_trace() {')]
INSTALLER = ROOT / 'server/scripts/install-engine-drill.sh'
HOST_GATE = SOURCE[SOURCE.index('source_target_is_current() {'):
                   SOURCE.index('parse_health_instance_for_sha()')]
RECORD_BLOCK = SOURCE[SOURCE.index('DRILL_FILE="$REQUEST_ROOT/$RUN_ID.drill"'):
                      SOURCE.index("DRILL_PREVIOUS_DESIRED=''")]
DRILL_FUNCTIONS = SOURCE[SOURCE.index('drill_git() {'):SOURCE.index('create_image_lease() {')]
REAL_GIT = shutil.which('git')
if not REAL_GIT:
    raise RuntimeError('git is required for actual ancestry tests')

PORTABLE_ROOT = '''
id() { if [ "${1:-}" = -u ]; then echo 0; else command id "$@"; fi; }
stat() { python3 "$PORTABLE_STAT" "$@"; }
# The production host runs Bash 5. macOS ships Bash 3.2 without mapfile, so a
# fixture-local `mapfile -t NAME` stands in only where the builtin is missing.
if ! help mapfile >/dev/null 2>&1; then
  mapfile() {
    [ "${1:-}" = -t ] && [ "$#" = 2 ] || return 2
    case "$2" in ''|*[!A-Za-z0-9_]*) return 2 ;; esac
    local __name="$2" __line __index=0
    eval "$__name=()"
    while IFS= read -r __line || [ -n "$__line" ]; do
      eval "$__name[$__index]=\\"\\$__line\\""
      __index=$((__index + 1))
    done
  }
fi
'''


# GNU `stat -c '%u:%a'` (lstat, so a symlink is reported as itself) on any
# platform, with the test user reported as root. macOS stat has no -c.
PORTABLE_STAT_SOURCE = """import os, sys
args = sys.argv[1:]
if len(args) != 3 or args[:2] != ['-c', '%u:%a']:
    sys.exit('portable stat supports only: stat -c %u:%a FILE')
try:
    st = os.lstat(args[2])
except OSError as error:
    sys.exit(f'stat: {error}')
uid = 0 if st.st_uid == os.getuid() else st.st_uid
print(f'{uid}:{st.st_mode & 0o7777:o}')
"""
_PORTABLE_STAT_DIR = tempfile.mkdtemp(prefix='engine-drill-stat-')
atexit.register(shutil.rmtree, _PORTABLE_STAT_DIR, True)
PORTABLE_STAT = os.path.join(_PORTABLE_STAT_DIR, 'stat.py')
with open(PORTABLE_STAT, 'w') as _handle:
    _handle.write(PORTABLE_STAT_SOURCE)
os.environ['PORTABLE_STAT'] = PORTABLE_STAT

class DrillFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='engine-drill-')
        self.addCleanup(self.temp.cleanup)
        # Resolved: macOS temp directories sit behind the /var -> /private/var
        # symlink, and the installer compares its own canonical path.
        self.directory = Path(self.temp.name).resolve()
        self.repo = self.directory / 'repo'
        self.repo.mkdir()
        self.env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        self.env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                        GIT_TERMINAL_PROMPT='0')
        self.git('init', '-q', '--initial-branch=main')
        self.git('config', 'user.name', 'Disposable Drill Fixture')
        self.git('config', 'user.email', 'drill-fixture@example.invalid')
        self.git('config', 'commit.gpgsign', 'false')
        self.git('config', 'core.hooksPath', str(self.directory / 'no-hooks'))
        self.ancient = self.commit('server/ancient.txt', 'below every floor')
        self.engine_floor = self.commit('server/custody.txt', 'engine custody floor')
        self.tournament_floor = self.commit('server/tournament.txt', 'tournament floor')
        self.a = self.commit('server/a.txt', 'a')
        self.b = self.commit('server/b.txt', 'b')
        self.c = self.commit('server/c.txt', 'c')
        self.main = self.commit('docs/readme.txt', 'documentation after engine C')
        self.git('switch', '-q', '-c', 'side', self.a)
        self.side = self.commit('server/side.txt', 'side')
        self.git('switch', '-q', 'main')
        self.git('remote', 'add', 'origin', str(self.repo))
        self.state = self.directory / 'seal-state.json'
        self.write_seal(desired=self.c, high_water=self.c, committed=[self.a, self.b, self.c])
        self.seal_calls = self.directory / 'seal-calls'
        self.seal = self.directory / 'seal'
        self.seal.write_text('''#!/usr/bin/env python3
import json, os, sys
with open(os.environ["SEAL_CALLS"], "a") as calls: calls.write(" ".join(sys.argv[1:]) + "\\n")
state = json.load(open(os.environ["SEAL_STATE"]))
args = sys.argv[1:]
if args[:1] == ["get"]:
    print({"desired-sha": state["desired"], "high-water-sha": state["highWater"],
           "desired-image-id": state.get("image", "sha256:" + "e" * 64)}[args[1]])
elif args[:2] == ["attest-committed-sha", "--sha"]:
    if args[2] not in state["committed"]: sys.exit(1)
    print(args[2], "sha256:" + "e" * 64, "100-1")
else:
    sys.exit(97)
''')
        self.seal.chmod(0o700)

    def write_seal(self, *, desired, high_water, committed):
        self.state.write_text(json.dumps(
            {'desired': desired, 'highWater': high_water, 'committed': committed}))

    def git(self, *args):
        result = subprocess.run([REAL_GIT, '-C', str(self.repo), *args],
                                capture_output=True, text=True, env=self.env, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def commit(self, filename, content):
        path = self.repo / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        self.git('add', filename)
        self.git('commit', '-qm', content)
        return self.git('rev-parse', 'HEAD')

    def run_shell(self, code, *, target, mode='', extra_env=None, tail='printf "ADMITTED:%s\\n" "$SHA"'):
        env = dict(self.env)
        env.update(REPO_DIR=str(self.repo), SHA=target, DEADLINE='9000',
                   SOURCE_LOCK=str(self.directory / 'source.lock'),
                   RELEASE_SEAL=str(self.seal), SEAL_STATE=str(self.state),
                   SEAL_CALLS=str(self.seal_calls))
        env.update(extra_env or {})
        shell = f'''set -euo pipefail
NOW=600
BREAK_END_EPOCH=0
SUPERSEDED_BY=''
DRILL_MODE={shlex.quote(mode)}
DRILL_ENGINE_FLOOR_SHA={self.engine_floor}
DRILL_TOURNAMENT_FLOOR_SHA={self.tournament_floor}
date() {{ printf '%s\\n' "$NOW"; }}
remaining_seconds() {{ printf '%s\\n' "$((DEADLINE - NOW))"; }}
break_proof_seconds() {{ printf '300\\n'; }}
timeout() {{
  while [[ "$1" = --* ]]; do shift; done
  [[ "$1" = *s ]] || exit 98
  shift
  "$@"
}}
flock() {{ :; }}
sleep() {{ :; }}
die() {{ printf 'REFUSED:%s\\n' "$*" >&2; exit 1; }}
{ENTRY_READ}
{code}
{tail}
'''
        return subprocess.run(['bash'], input=shell, capture_output=True, text=True,
                              env=env, cwd=self.repo, timeout=20)

    def accepted(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('ADMITTED:', result.stdout)

    def refused(self, result, message):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn('ADMITTED:', result.stdout)
        self.assertIn(message, result.stderr)


class RollbackAdmissionTests(DrillFixture):
    """The real source_target_is_current, with the real drill functions."""

    def host(self, target, mode):
        return self.run_shell(DRILL_FUNCTIONS + HOST_GATE + '\nsource_target_is_current',
                              target=target, mode=mode)

    def test_an_older_sealed_release_above_both_floors_is_admitted_as_a_rollback(self):
        result = self.host(self.b, 'rollback')
        self.accepted(result)
        self.assertNotIn('ENGINE_RELEASE_SUPERSEDED_BY=', result.stdout)
        self.assertIn('attest-committed-sha --sha ' + self.b, self.seal_calls.read_text())

    def test_the_same_older_target_is_still_refused_as_an_ordinary_release(self):
        self.refused(self.host(self.b, ''), 'does not contain the sealed high-water release')

    def test_a_rollforward_drill_keeps_the_ordinary_forward_rule(self):
        for mode in ('rollforward',):
            with self.subTest(mode=mode):
                self.refused(self.host(self.b, mode), 'does not contain the sealed high-water release')
                self.accepted(self.host(self.c, mode))

    def test_the_high_water_itself_is_not_a_rollback(self):
        self.refused(self.host(self.c, 'rollback'), 'is the sealed high-water release itself')

    def test_a_target_newer_than_the_high_water_is_not_a_rollback(self):
        self.write_seal(desired=self.b, high_water=self.b, committed=[self.a, self.b, self.c])
        self.refused(self.host(self.c, 'rollback'), 'is not older than the sealed high-water release')

    def test_a_target_below_either_compatibility_floor_is_refused(self):
        self.write_seal(desired=self.c, high_water=self.c,
                        committed=[self.ancient, self.engine_floor, self.a, self.b, self.c])
        self.refused(self.host(self.ancient, 'rollback'), 'is below the compatibility floor ' + self.engine_floor)
        self.refused(self.host(self.engine_floor, 'rollback'),
                     'is below the compatibility floor ' + self.tournament_floor)

    def test_a_release_this_host_never_sealed_is_refused(self):
        self.write_seal(desired=self.c, high_water=self.c, committed=[self.c])
        self.refused(self.host(self.b, 'rollback'), 'was never sealed on this host')

    def test_a_target_outside_protected_main_is_refused_before_the_drill_rule(self):
        self.write_seal(desired=self.c, high_water=self.c, committed=[self.side, self.c])
        self.refused(self.host(self.side, 'rollback'), 'is no longer contained in protected main')


class PreconditionTests(DrillFixture):
    def check(self, target, mode):
        return self.run_shell(DRILL_FUNCTIONS + '\ndrill_preconditions',
                              target=target, mode=mode,
                              tail='printf "ADMITTED:%s previous=%s\\n" "$SHA" "${DRILL_PREVIOUS_DESIRED:-}"')

    def test_an_ordinary_release_is_untouched(self):
        result = self.check(self.b, '')
        self.accepted(result)
        self.assertFalse(self.seal_calls.exists())

    def test_a_rollback_drill_needs_a_target_that_is_not_already_desired(self):
        result = self.check(self.b, 'rollback')
        self.accepted(result)
        self.assertIn('previous=' + self.c, result.stdout)
        self.write_seal(desired=self.b, high_water=self.c, committed=[self.b, self.c])
        self.refused(self.check(self.b, 'rollback'), 'already is the sealed desired release')

    def test_a_rollforward_needs_a_rollback_to_undo_and_the_high_water_as_target(self):
        self.refused(self.check(self.c, 'rollforward'), 'found no rolled-back release to roll forward from')
        self.write_seal(desired=self.b, high_water=self.c, committed=[self.b, self.c])
        self.accepted(self.check(self.c, 'rollforward'))
        self.refused(self.check(self.b, 'rollforward'), 'must be the sealed high-water release')


class RecordTests(DrillFixture):
    def read_record(self, lines=None, *, mode=0o600, symlink=False, absent=False):
        requests = self.directory / 'requests'
        requests.mkdir(exist_ok=True)
        record = requests / '123-1.drill'
        if record.exists() or record.is_symlink():
            record.unlink()
        if not absent:
            body = '\n'.join(lines if lines is not None else
                             ['engine-drill-v1', 'rollforward', self.c, 'f' * 40,
                              'owner-authorised DA10 rollforward drill']) + '\n'
            if symlink:
                real = self.directory / 'elsewhere'
                real.write_text(body)
                record.symlink_to(real)
            else:
                record.write_text(body)
                record.chmod(mode)
        code = PORTABLE_ROOT + '''
validate_actor() {
  python3 - "$1" <<'PY'
import sys
actor = sys.argv[1]
raise SystemExit(0 if actor and len(actor) <= 128 and all(ord(c) >= 32 and ord(c) != 127 for c in actor) else 1)
PY
}
REQUEST_ROOT="$REQUESTS"
RUN_ID=123-1
CONTROL_SHA="$CONTROL"
''' + RECORD_BLOCK
        return self.run_shell(code, target=self.c,
                              extra_env={'REQUESTS': str(requests), 'CONTROL': 'f' * 40},
                              tail='printf "ADMITTED:%s mode=[%s] seal=%s reason=[%s]\\n" '
                                   '"$SHA" "$DRILL_MODE" "$SEAL_MODE" "$SEAL_PREPARE_REASON"')

    def test_no_record_is_an_ordinary_release(self):
        result = self.read_record(absent=True)
        self.accepted(result)
        self.assertIn("mode=[] seal=deploy reason=[normal protected-main engine release]", result.stdout)

    def test_each_mode_maps_to_its_seal_mode(self):
        for drill, seal in (('rollback', 'rollback'), ('rollforward', 'deploy')):
            with self.subTest(drill=drill):
                result = self.read_record(['engine-drill-v1', drill, self.c, 'f' * 40,
                                           'owner-authorised DA10 drill'])
                self.accepted(result)
                self.assertIn(f'mode=[{drill}] seal={seal} reason=[engine drill {drill}: owner-authorised DA10 drill]',
                              result.stdout)

    def test_a_record_that_does_not_bind_exactly_is_refused(self):
        good = ['engine-drill-v1', 'rollforward', self.c, 'f' * 40, 'owner-authorised DA10 rollforward drill']
        for index, value, message in (
            (0, 'engine-drill-v2', 'schema is unknown'),
            (1, 'reboot', 'mode is unknown'),
            # The crash drill is its own route (engine-crash-drill.sh), never this record.
            (1, 'crash', 'mode is unknown'),
            (2, self.b, 'names a different target'),
            (3, 'e' * 40, 'names a different control commit'),
            (4, 'too short', 'reason must be 12 to 128'),
        ):
            with self.subTest(field=index):
                lines = list(good)
                lines[index] = value
                self.refused(self.read_record(lines), message)
        self.refused(self.read_record(good[:4]), 'invalid field count')
        self.refused(self.read_record(mode=0o644), 'ownership or mode is invalid')
        self.refused(self.read_record(symlink=True), 'is not a regular file')


class ReceiptTests(DrillFixture):
    """record_drill_receipt is evidence beside the seal result, never a gate."""

    def receipt(self, directory, mode='rollback'):
        code = DRILL_FUNCTIONS + f"""
RUN_ID=123-1
CONTROL_SHA={'f' * 40}
ACTOR=owner
RUN_URL=https://example.invalid/run/123
INVOCATION_ID=abc123
BREAK_END_EPOCH=1792240300
DRILL_REASON='owner-authorised DA10 {mode} drill'
DRILL_PREVIOUS_DESIRED={self.c}
record_drill_receipt sealed 1-bbbbbbbb
"""
        return self.run_shell(code, target=self.b, mode=mode,
                              extra_env={'ENGINE_DRILL_RESULT_DIR': str(directory)})

    def test_a_sealed_rollback_writes_one_private_exact_receipt(self):
        results = self.directory / 'results'
        result = self.receipt(results)
        self.accepted(result)
        self.assertIn('ENGINE_DRILL_MODE=rollback', result.stdout)
        self.assertIn('ENGINE_DRILL_RESULT=sealed', result.stdout)
        path = results / '123-1.json'
        self.assertEqual(oct(path.stat().st_mode & 0o777), '0o600')
        receipt = json.loads(path.read_text())
        self.assertEqual(receipt['schema'], 'engine-drill-result-v1')
        self.assertEqual((receipt['runId'], receipt['mode'], receipt['result']), ('123-1', 'rollback', 'sealed'))
        self.assertEqual((receipt['sha'], receipt['previousDesiredSha']), (self.b, self.c))
        self.assertEqual((receipt['instanceId'], receipt['breakEndEpoch']), ('1-bbbbbbbb', 1792240300))
        self.assertNotIn('crash', receipt)
        self.assertEqual([p.name for p in results.iterdir()], ['123-1.json'])

    def test_an_unwritable_receipt_is_said_loudly_and_never_fails_the_release(self):
        blocker = self.directory / 'not-a-directory'
        blocker.write_text('x')
        result = self.receipt(blocker / 'results')
        self.accepted(result)
        self.assertIn('could not be written; the seal result above still stands', result.stderr)
        self.assertNotIn('ENGINE_DRILL_RESULT=', result.stdout)

    def test_an_ordinary_release_writes_no_receipt(self):
        results = self.directory / 'results'
        self.accepted(self.receipt(results, mode=''))
        self.assertFalse(results.exists())


class InstallerTests(DrillFixture):
    def install(self, mode='rollforward', reason='owner-authorised DA10 rollforward drill', *, prepare=None):
        if not hasattr(self, 'control'):
            self.stage_control()
        return self.run_installer(mode, reason, prepare)

    def stage_control(self):
        staging = self.directory / 'staging'
        stage = staging / '123-1/server/scripts'
        stage.mkdir(parents=True, exist_ok=True)
        requests = self.directory / 'requests'
        installer = stage / 'install-engine-drill.sh'
        installer.write_bytes(INSTALLER.read_bytes())
        installer.chmod(0o755)
        intake = stage / 'install-engine-intake.sh'
        intake.write_text('#!/usr/bin/env bash\nprintf "INTAKE:%s\\n" "$*"\n')
        intake.chmod(0o755)
        # The control commit holds exactly these staged bytes.
        for path in (installer, intake):
            target = self.repo / 'server/scripts' / path.name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(path.read_bytes())
            self.git('add', str(target.relative_to(self.repo)))
        self.git('commit', '-qm', 'control')
        self.control = self.git('rev-parse', 'HEAD')
        self.staging, self.installer, self.requests = staging, installer, requests

    def run_installer(self, mode, reason, prepare):
        staging, installer, requests, control = self.staging, self.installer, self.requests, self.control
        if prepare:
            prepare(requests)
        bin_dir = self.directory / 'bin'
        bin_dir.mkdir(exist_ok=True)
        (bin_dir / 'id').write_text('#!/usr/bin/env bash\n[ "${1:-}" = -u ] && { echo 0; exit; }\nexec /usr/bin/id "$@"\n')
        (bin_dir / 'stat').write_text('#!/usr/bin/env bash\nexec python3 "$PORTABLE_STAT" "$@"\n')
        # GNU `readlink -e -- PATH` on any platform: macOS readlink has no -e.
        (bin_dir / 'readlink').write_text(
            '#!/usr/bin/env bash\n[ "$1" = -e ] && [ "$2" = -- ] && [ "$#" = 3 ] || exit 2\n'
            'exec python3 -c \'import os,sys; p=sys.argv[1]; '
            'sys.exit(1) if not os.path.exists(p) else print(os.path.realpath(p))\' "$3"\n')
        for name in ('id', 'stat', 'readlink'):
            (bin_dir / name).chmod(0o755)
        env = dict(self.env)
        env.update(PATH=str(bin_dir) + os.pathsep + env['PATH'], REPO_DIR=str(self.repo),
                   ENGINE_RELEASE_REQUEST_ROOT=str(requests),
                   ENGINE_CONTROL_STAGING_ROOT=str(staging))
        reason_b64 = base64.b64encode(reason.encode()).decode()
        result = subprocess.run(
            [str(installer), '--mode', mode, '--target-sha', self.c, '--control-sha', control,
             '--run-id', '123-1', '--actor', 'owner', '--reason-b64', reason_b64,
             '--not-after-epoch', '1792240000'],
            capture_output=True, text=True, env=env, timeout=20)
        return result, requests / '123-1.drill', control

    def test_binds_the_drill_then_hands_the_unchanged_arguments_to_the_intake(self):
        result, record, control = self.install()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(record.read_text().splitlines(),
                         ['engine-drill-v1', 'rollforward', self.c, control, 'owner-authorised DA10 rollforward drill'])
        self.assertEqual(oct(record.stat().st_mode & 0o777), '0o600')
        self.assertIn(f'INTAKE:--target-sha {self.c} --control-sha {control} --run-id 123-1 '
                      '--actor owner --not-after-epoch 1792240000', result.stdout)

    def test_an_identical_replay_is_idempotent_and_a_different_drill_is_refused(self):
        first, record, _ = self.install()
        self.assertEqual(first.returncode, 0, first.stderr)
        bound = record.read_bytes()
        again, _, _ = self.install()
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(record.read_bytes(), bound)
        for mode, reason in (('rollback', 'owner-authorised DA10 rollforward drill'),
                             ('rollforward', 'a different owner-authorised reason')):
            with self.subTest(mode=mode, reason=reason):
                other, _, _ = self.install(mode=mode, reason=reason)
                self.assertNotEqual(other.returncode, 0)
                self.assertIn('already bound to a different drill', other.stderr)
                self.assertEqual(record.read_bytes(), bound)

    def test_refuses_a_run_key_that_already_holds_an_ordinary_request(self):
        def ordinary(requests):
            requests.mkdir(parents=True, exist_ok=True)
            (requests / '123-1.request').write_text('ordinary\n')
        result, record, _ = self.install(prepare=ordinary)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('already has a release request and no drill record', result.stderr)
        self.assertFalse(record.exists())

    def test_refuses_bad_modes_and_reasons_before_writing(self):
        for mode, reason, message in (('reboot', 'owner-authorised drill run', 'drill mode must be'),
                                      ('crash', 'owner-authorised drill run', 'drill mode must be'),
                                      ('rollforward', 'short', 'drill reason must be 12 to 128')):
            with self.subTest(mode=mode, reason=reason):
                result, record, _ = self.install(mode=mode, reason=reason)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertFalse(record.exists())


if __name__ == '__main__':
    unittest.main(verbosity=1)
