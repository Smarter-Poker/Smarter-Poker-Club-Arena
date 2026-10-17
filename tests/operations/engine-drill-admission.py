#!/usr/bin/env python3
"""Execute the engine drill's actual shell against isolated, real Git histories.

The drill record reader, the rollback admission (inside the real
source_target_is_current), the per-mode preconditions, the crash drill and its
receipt run as written in server/scripts/engine-release-transaction.sh, and
server/scripts/install-engine-drill.sh runs as a real script. Git, ancestry and
every admission decision execute for real.

Portable substitutes only: the clock, timeout, flock and sleep; the seal reader
(a file-backed fake answering the same three questions); Docker, kill and the
health/leader probes in the crash drill (a file-backed state machine); and
`id`/`stat`, which map the test user to root so the root-ownership checks run
unprivileged in CI. Nothing here starts, stops or signals a real process.
"""
from pathlib import Path
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
stat() {
  local out
  out="$(command stat "$@")" || return $?
  printf '%s\\n' "$out" | sed "s/^$(command id -u):/0:/"
}
'''


class DrillFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='engine-drill-')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
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

    def test_a_crash_or_rollforward_drill_keeps_the_ordinary_forward_rule(self):
        for mode in ('crash', 'rollforward'):
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
    def check(self, target, mode, runtime_ok=True):
        runtime = 'exact_runtime_instance() { printf "1-aaaaaaaa\\n"; }' if runtime_ok \
            else 'exact_runtime_instance() { return 1; }'
        return self.run_shell(runtime + '\n' + DRILL_FUNCTIONS + '\ndrill_preconditions',
                              target=target, mode=mode,
                              tail='printf "ADMITTED:%s previous=%s\\n" "$SHA" "${DRILL_PREVIOUS_DESIRED:-}"')

    def test_an_ordinary_release_is_untouched(self):
        result = self.check(self.b, '')
        self.accepted(result)
        self.assertFalse(self.seal_calls.exists())

    def test_a_crash_drill_needs_the_live_desired_high_water_release(self):
        self.accepted(self.check(self.c, 'crash'))
        self.refused(self.check(self.b, 'crash'), 'must be the sealed desired and high-water release')
        self.refused(self.check(self.c, 'crash', runtime_ok=False), 'is not the exact live local and public runtime')
        self.write_seal(desired=self.b, high_water=self.c, committed=[self.b, self.c])
        self.refused(self.check(self.c, 'crash'), 'must be the sealed desired and high-water release')

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
                             ['engine-drill-v1', 'crash', self.c, 'f' * 40,
                              'owner-authorised DA08 crash drill']) + '\n'
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
        for drill, seal in (('crash', 'deploy'), ('rollback', 'rollback'), ('rollforward', 'deploy')):
            with self.subTest(drill=drill):
                result = self.read_record(['engine-drill-v1', drill, self.c, 'f' * 40,
                                           'owner-authorised DA10 drill'])
                self.accepted(result)
                self.assertIn(f'mode=[{drill}] seal={seal} reason=[engine drill {drill}: owner-authorised DA10 drill]',
                              result.stdout)

    def test_a_record_that_does_not_bind_exactly_is_refused(self):
        good = ['engine-drill-v1', 'crash', self.c, 'f' * 40, 'owner-authorised DA08 crash drill']
        for index, value, message in (
            (0, 'engine-drill-v2', 'schema is unknown'),
            (1, 'reboot', 'mode is unknown'),
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


class CrashDrillTests(DrillFixture):
    """run_crash_drill against a file-backed Docker/health/leader state machine."""

    def crash(self, *, restarts=True, same_instance=False, leader=True, image_changes=False):
        world = self.directory / 'world'
        world.mkdir()
        results = self.directory / 'drill-results'
        code = f'''
WORLD={shlex.quote(str(world))}
CONTAINER=club-arena-engine
PUBLIC_URL=https://engine.example.invalid
ENV_FILE=/dev/null
RUN_ID=123-1
CONTROL_SHA={'f' * 40}
ACTOR=owner
RUN_URL=https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/123
INVOCATION_ID={'0' * 32}
DRILL_REASON='owner-authorised DA08 crash drill'
BREAK_END_EPOCH=$((600 + 300))
MUTATION_STARTED=0
DATABASE_PROOF="$WORLD/database-proof"
printf '#!/usr/bin/env bash\\n[ "{'1' if leader else '0'}" = 1 ]\\n' > "$DATABASE_PROOF"; chmod +x "$DATABASE_PROOF"
date() {{
  case "${{1:-}}" in
    +%s%3N) printf '%s000\\n' "$NOW" ;;
    +%s%N) printf '%s000000000\\n' "$NOW" ;;
    *) printf '%s\\n' "$NOW" ;;
  esac
}}
killed() {{ [ -e "$WORLD/killed" ]; }}
docker() {{
  [ "$1 $2" = 'container inspect' ] || return 97
  local format="$4"
  case "$format" in
    '{{{{.Id}}}}') printf '%s\\n' {'c' * 64} ;;
    '{{{{.State.StartedAt}}}}') if killed && {'true' if restarts else 'false'}; then echo 2026-10-17T12:56:30Z; else echo 2026-10-17T06:55:45Z; fi ;;
    '{{{{.RestartCount}}}}') if killed && {'true' if restarts else 'false'}; then echo 1; else echo 0; fi ;;
    '{{{{.State.Pid}}}}') echo 4242 ;;
    '{{{{.State.Status}}}}') echo running ;;
    '{{{{.Image}}}}') if killed && {'true' if image_changes else 'false'}; then echo sha256:{'9' * 64}; else echo sha256:{'e' * 64}; fi ;;
    *) printf '%s\\n' "$SHA" ;;
  esac
}}
kill() {{ printf '%s %s mutation=%s\\n' "$1" "$2" "$MUTATION_STARTED" > "$WORLD/killed"; }}
health_instance() {{
  if killed && {'false' if same_instance else 'true'}; then echo 2-bbbbbbbb; else echo 1-aaaaaaaa; fi
}}
exact_runtime_instance() {{ health_instance x; }}
bounded_break_command() {{ shift; "$@"; }}
assert_time_remaining() {{ :; }}
assert_break_proof_time() {{ :; }}
bounded_sleep() {{ :; }}
persist_result() {{ echo "PERSIST:$1:$2"; }}
'''
        die_override = 'die() { printf "REFUSED:%s mutation=%s\\n" "$*" "$MUTATION_STARTED" >&2; exit 1; }'
        return self.run_shell(code + DRILL_FUNCTIONS + '\n' + die_override + '\nrun_crash_drill',
                              target=self.c, mode='crash',
                              extra_env={'ENGINE_DRILL_RESULT_DIR': str(results)},
                              tail='echo UNREACHABLE'), world, results

    def test_a_supervised_restart_is_proved_and_recorded(self):
        result, world, results = self.crash()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn('UNREACHABLE', result.stdout)
        self.assertEqual((world / 'killed').read_text().strip(), '-KILL 4242 mutation=1')
        self.assertIn('PERSIST:already-released:2-bbbbbbbb', result.stdout)
        self.assertIn('ENGINE_DRILL_RESULT=crash-recovered', result.stdout)
        receipt = json.loads((results / '123-1.json').read_text())
        self.assertEqual(receipt['mode'], 'crash')
        self.assertEqual(receipt['result'], 'crash-recovered')
        self.assertEqual(receipt['sha'], self.c)
        self.assertEqual(receipt['instanceId'], '2-bbbbbbbb')
        self.assertEqual(receipt['crash']['preInstance'], '1-aaaaaaaa')
        self.assertEqual(receipt['crash']['prePid'], '4242')
        self.assertEqual(receipt['crash']['preRestartCount'], '0')
        self.assertEqual(receipt['crash']['postRestartCount'], '1')
        self.assertEqual(oct((results / '123-1.json').stat().st_mode & 0o777), '0o600')

    def test_a_supervisor_that_never_restarts_refuses_with_recovery_armed(self):
        result, _, results = self.crash(restarts=False)
        self.refused(result, 'the supervisor never restarted the killed engine')
        self.assertIn('mutation=1', result.stderr)
        self.assertFalse((results / '123-1.json').exists())

    def test_the_old_process_answering_is_not_a_restart(self):
        result, _, _ = self.crash(same_instance=True)
        self.refused(result, 'never served exact local release health as a new process')
        self.assertIn('mutation=1', result.stderr)

    def test_a_restart_that_is_not_elected_leader_refuses(self):
        result, _, _ = self.crash(leader=False)
        self.refused(result, 'was not elected the fresh database leader')
        self.assertIn('mutation=1', result.stderr)

    def test_a_different_image_after_the_restart_refuses(self):
        result, _, _ = self.crash(image_changes=True)
        self.refused(result, 'is not the same sealed container and image')


class InstallerTests(DrillFixture):
    def install(self, mode='crash', reason='owner-authorised DA08 crash drill', *, prepare=None):
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
        (bin_dir / 'stat').write_text('#!/usr/bin/env bash\nout="$(/usr/bin/stat "$@")" || exit $?\n'
                                      'printf "%s\\n" "$out" | sed "s/^$(/usr/bin/id -u):/0:/"\n')
        for name in ('id', 'stat'):
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
                         ['engine-drill-v1', 'crash', self.c, control, 'owner-authorised DA08 crash drill'])
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
        for mode, reason in (('rollback', 'owner-authorised DA08 crash drill'),
                             ('crash', 'a different owner-authorised reason')):
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
                                      ('crash', 'short', 'drill reason must be 12 to 128')):
            with self.subTest(mode=mode, reason=reason):
                result, record, _ = self.install(mode=mode, reason=reason)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertFalse(record.exists())


if __name__ == '__main__':
    unittest.main(verbosity=1)
