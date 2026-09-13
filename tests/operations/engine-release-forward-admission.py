#!/usr/bin/env python3
"""Execute actual release shell gates against isolated, real Git histories.

Only clock, timeout and flock boundaries are portable substitutes. This does
not claim native deadline/lock qualification or start any production process.
Git, fetch, object lookup, ancestry and all admission decisions execute for real.
"""
from pathlib import Path
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[2]
if len(sys.argv) > 2 and sys.argv[1] == '--source-root':
    ROOT = Path(sys.argv[2]).resolve()
    del sys.argv[1:3]
SOURCE = (ROOT / 'server/scripts/engine-release-transaction.sh').read_text()
WORKFLOW = (ROOT / '.github/workflows/auto-deploy-hetzner.yml').read_text()
HOST_GATE = SOURCE[SOURCE.index('source_target_is_current() {'):
                   SOURCE.index('parse_health_instance_for_sha()')]


def step_code(name, following):
    block = WORKFLOW[WORKFLOW.index('name: ' + name):WORKFLOW.index('name: ' + following)]
    start = block.index('          set -euo pipefail')
    # Drop the next YAML step's indentation/dash.
    return textwrap.dedent(block[start:].rsplit('\n      - ', 1)[0].rstrip())


PREFLIGHT = step_code('Prove the request is current protected-main engine code',
                      'Use the production Node major')
QUEUED = step_code('Recheck freshness after the FIFO wait',
                   'Establish pinned ephemeral SSH transport')
stage = WORKFLOW[WORKFLOW.index('name: Stage exact control bytes'):
                 WORKFLOW.index('name: Dispatch the staged SHA through the durable Hetzner intake')]
# Execute the existing host fetch/object/ancestry/admission block. Prerequisite
# and physical host-lock acquisition precede it and are outside this portable
# boundary; generation staging and installation follow it and never execute.
HOST_STAGE = 'export GIT_NO_REPLACE_OBJECTS=1\n' + textwrap.dedent(
    stage[stage.index('          GIT_HTTP_LOW_SPEED_LIMIT=1024'):
          stage.index('          STAGE=')])
REAL_GIT = shutil.which('git')
if not REAL_GIT:
    raise RuntimeError('git is required for actual ancestry tests')


class ForwardAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='engine-forward-admission-')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.repo = self.directory / 'repo'
        self.repo.mkdir()
        # Git hooks and CI can export repository/config selectors. Never allow
        # them to redirect these fixture writes into the calling repository.
        self.env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        self.env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                        GIT_TERMINAL_PROMPT='0')
        self.git('init', '-q', '--initial-branch=main')
        self.git('config', 'user.name', 'Disposable Release Fixture')
        self.git('config', 'user.email', 'release-fixture@example.invalid')
        self.git('config', 'commit.gpgsign', 'false')
        self.git('config', 'core.hooksPath', str(self.directory / 'no-hooks'))
        self.a = self.commit('server/a.txt', 'a')
        self.b = self.commit('server/b.txt', 'b')
        self.c = self.commit('server/c.txt', 'c')
        self.main = self.commit('docs/readme.txt', 'documentation after engine C')
        self.git('switch', '-q', '-c', 'side', self.a)
        self.side = self.commit('server/side.txt', 'side')
        self.git('switch', '-q', 'main')
        self.git('remote', 'add', 'origin', str(self.repo))
        self.high_water = self.directory / 'high-water'
        self.high_water.write_text(self.a + '\n')
        self.seal_calls = self.directory / 'seal-calls'
        self.seal = self.directory / 'seal'
        self.seal.write_text('#!/usr/bin/env bash\nset -eu\n'
                             'printf "%s\\n" "$*" >> "$SEAL_CALLS"\n'
                             '[ "$#" = 2 ] && [ "$1" = get ] && [ "$2" = high-water-sha ]\n'
                             'cat "$HIGH_WATER_FILE"\n')
        self.seal.chmod(0o700)

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

    def harness(self, code, *, target=None, control=None, requested=None,
                checkout=None, now=600, inside_break=False, fault=None, tail=''):
        target = self.b if target is None else target
        control = self.main if control is None else control
        self.git('checkout', '-q', '--detach', checkout or control)
        env = dict(self.env)
        env.update(REPO_DIR=str(self.repo), SHA=target, TARGET_SHA=target,
                   REQUESTED_SHA=target if requested is None else requested,
                   CONTROL_SHA=control, RUN_KEY='123-1',
                   DEPLOY_NOT_AFTER_EPOCH='9000', DEADLINE='9000',
                   RELEASE_DISPATCH_DEADLINE_EPOCH='9000',
                   SOURCE_LOCK=str(self.directory / 'source.lock'),
                   RELEASE_SEAL=str(self.seal), HIGH_WATER_FILE=str(self.high_water),
                   SEAL_CALLS=str(self.seal_calls),
                   GITHUB_OUTPUT=str(self.directory / 'outputs'),
                   GITHUB_STEP_SUMMARY=str(self.directory / 'summary'))
        if fault:
            bin_dir = self.directory / 'bin'
            bin_dir.mkdir(exist_ok=True)
            script = bin_dir / 'git'
            script.write_text('#!/usr/bin/env bash\n'
                              'for argument in "$@"; do\n'
                              '  if [ "$argument" = "$FAULT_OP" ]; then\n'
                              '    if [ "$FAULT_OP" = log ]; then echo malformed; exit 0; fi\n'
                              '    exit 1\n'
                              '  fi\ndone\nexec ' + shlex.quote(REAL_GIT) + ' "$@"\n')
            script.chmod(0o700)
            env.update(PATH=str(bin_dir) + os.pathsep + env['PATH'], FAULT_OP=fault)
        shell = f'''set -euo pipefail
NOW={now}
BREAK_START_MINUTE=55
SUPERSESSION_YIELD_SECONDS=900
BREAK_END_EPOCH={now + 300 if inside_break else 0}
SUPERSEDED_BY=''
date() {{ printf '%s\\n' "$NOW"; }}
remaining_seconds() {{ printf '%s\\n' "$((DEADLINE - NOW))"; }}
break_proof_seconds() {{ printf '300\\n'; }}
seconds_to_next_break() {{ printf '%s\\n' "$((3300 - NOW % 3600))"; }}
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
printf 'ADMITTED:%s\\n' "$SHA"
'''
        return subprocess.run(['bash'], input=shell, capture_output=True, text=True,
                              env=env, cwd=self.repo, timeout=15)

    def host(self, **kwargs):
        return self.harness(HOST_GATE + '\nsource_target_is_current', **kwargs)

    def accepted(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('ADMITTED:', result.stdout)

    def refused(self, result, message=None):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn('ADMITTED:', result.stdout)
        if message:
            self.assertIn(message, result.stderr)

    def test_forward_behind_main_remains_admissible_outside_break(self):
        result = self.host(now=600)
        self.accepted(result)
        self.assertIn('ENGINE_RELEASE_SUPERSEDED_BY=' + self.c, result.stdout)
        self.assertEqual(self.seal_calls.read_text().splitlines(), ['get high-water-sha'])

    def test_forward_behind_main_remains_admissible_near_and_inside_break(self):
        for now, inside in [(3000, False), (3400, True)]:
            with self.subTest(now=now, inside=inside):
                self.accepted(self.host(now=now, inside_break=inside))

    def test_documentation_only_main_advance_keeps_exact_latest_engine(self):
        result = self.host(target=self.c)
        self.accepted(result)
        self.assertNotIn('ENGINE_RELEASE_SUPERSEDED_BY=', result.stdout)

    def test_sealed_high_water_equality_is_not_backward(self):
        self.high_water.write_text(self.b + '\n')
        self.accepted(self.host())

    def test_older_request_after_newer_release_is_refused(self):
        self.high_water.write_text(self.c + '\n')
        self.refused(self.host(), 'does not contain the sealed high-water release')

    def test_intentional_rollback_cannot_lower_the_normal_deploy_floor(self):
        # A real rollback would set desired=A while retaining high-water=C.
        # This reader refuses every key except high-water-sha.
        self.high_water.write_text(self.c + '\n')
        self.refused(self.host(target=self.b), 'does not contain the sealed high-water release')
        self.assertEqual(self.seal_calls.read_text().splitlines(), ['get high-water-sha'])

    def test_divergent_target_contained_in_main_is_still_refused(self):
        self.git('merge', '--no-ff', '-qm', 'merge side', self.side)
        self.main = self.git('rev-parse', 'HEAD')
        self.high_water.write_text(self.b + '\n')
        self.refused(self.host(target=self.side), 'does not contain the sealed high-water release')

    def test_target_outside_protected_main_is_refused(self):
        self.refused(self.host(target=self.side), 'no longer contained in protected main')

    def test_missing_target_object_is_refused(self):
        self.refused(self.host(target='f' * 40), 'target object proof failed')

    def test_unreadable_high_water_refuses_even_the_latest_engine(self):
        for value in ['', 'invalid', 'F' * 40]:
            with self.subTest(value=value):
                self.high_water.write_text(value + '\n')
                self.refused(self.host(target=self.c), 'cannot prove the sealed high-water release')

    def test_missing_high_water_object_is_refused(self):
        self.high_water.write_text('f' * 40 + '\n')
        self.refused(self.host(target=self.c), 'does not contain the sealed high-water release')

    def test_high_water_advance_between_rechecks_revokes_older_target(self):
        tail = 'printf "%s\\n" ' + shlex.quote(self.c) + ' > "$HIGH_WATER_FILE"\nsource_target_is_current'
        result = self.host(tail=tail)
        self.refused(result, 'does not contain the sealed high-water release')
        self.assertEqual(self.seal_calls.read_text().splitlines(),
                         ['get high-water-sha', 'get high-water-sha'])

    def test_protected_main_rewind_revokes_target(self):
        self.git('update-ref', 'refs/heads/main', self.a)
        self.refused(self.host(), 'no longer contained in protected main')

    def test_fetch_failure_and_malformed_latest_fail_closed(self):
        self.refused(self.host(fault='fetch'), 'fetch failed after three attempts')
        self.refused(self.host(fault='log'), 'latest engine component SHA is unreadable')

    def test_all_three_workflow_gates_admit_contained_behind_tip_target(self):
        for label, code, checkout in [('preflight', PREFLIGHT, self.b),
                                      ('queued', QUEUED, self.main),
                                      ('host-stage', HOST_STAGE, self.main)]:
            with self.subTest(gate=label):
                self.accepted(self.harness(code, checkout=checkout))

    def test_workflow_gates_refuse_target_outside_main(self):
        for label, code, checkout in [('preflight', PREFLIGHT, self.side),
                                      ('queued', QUEUED, self.main),
                                      ('host-stage', HOST_STAGE, self.main)]:
            with self.subTest(gate=label):
                self.refused(self.harness(code, target=self.side, checkout=checkout))

    def test_workflow_gates_reject_unreadable_component_lookup(self):
        for label, code, checkout in [('preflight', PREFLIGHT, self.b),
                                      ('queued', QUEUED, self.main),
                                      ('host-stage', HOST_STAGE, self.main)]:
            with self.subTest(gate=label):
                self.refused(self.harness(code, checkout=checkout, fault='log'))

    def test_runner_identity_and_control_ancestry_are_still_mandatory(self):
        self.refused(self.harness(PREFLIGHT, checkout=self.b, requested=self.c))
        self.refused(self.harness(PREFLIGHT, checkout=self.b, requested='B' * 40))
        self.refused(self.harness(QUEUED, control=self.side, checkout=self.side))
        self.refused(self.harness(QUEUED, control=self.main, checkout=self.b))
        self.refused(self.harness(HOST_STAGE, control=self.side, checkout=self.main))


if __name__ == '__main__':
    unittest.main(verbosity=2)
