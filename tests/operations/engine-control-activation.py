#!/usr/bin/env python3
"""Execute the installer's real generation admission and activation on disk."""
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = (ROOT / 'server/scripts/install-engine-supervisor.sh').read_text()
PROTOCOL = (ROOT / 'server/scripts/engine-release-protocol-v1.schema').read_bytes()


def section(start, end):
    return SOURCE[SOURCE.index(start):SOURCE.index(end, SOURCE.index(start))]


class Activation(unittest.TestCase):
    def test_canonical_upgrade_idempotence_and_downgrade(self):
        with tempfile.TemporaryDirectory(prefix='engine-control-activation-') as name:
            # resolve(): on macOS the temp dir is /var/folders/..., a symlink into
            # /private, and the installer's `readlink -e` returns the resolved
            # path, so an unresolved GENERATION_ROOT never prefix-matches it.
            root = Path(name).resolve()
            repo = root / 'repo'
            scripts = repo / 'server/scripts'
            scripts.mkdir(parents=True)
            env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
            env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)

            def git(*args):
                return subprocess.check_output(['git', '-C', str(repo), *args], env=env, stderr=subprocess.DEVNULL).decode().strip()

            git('init', '-q')
            git('config', 'user.name', 'Control fixture')
            git('config', 'user.email', 'control-fixture@example.invalid')
            (scripts / 'engine-release-protocol-v1.schema').write_bytes(PROTOCOL)
            shas = []
            generations = root / 'engine-control-generations'
            generations.mkdir()
            for content in ('old', 'new'):
                (scripts / 'control.sh').write_text('#!/bin/sh\n# ' + content + '\n')
                git('add', '.')
                git('commit', '-qm', content)
                sha = git('rev-parse', 'HEAD')
                shas.append(sha)
                generation = generations / sha
                generation.mkdir()
                for file in ('control.sh', 'engine-release-protocol-v1.schema'):
                    (generation / file).write_bytes((scripts / file).read_bytes())
                (generation / 'control-sha').write_text(sha + '\n')
                (generation / 'generation-files').write_text('control.sh\nengine-release-protocol-v1.schema\n')
            git('update-ref', 'refs/remotes/origin/main', shas[1])
            active = root / 'engine-control'
            active.symlink_to(generations / shas[0])
            # GNU mv -T is unavailable on the Mac. Preserve its exact atomic
            # replace semantics with os.replace; Linux invokes the same shim.
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            move = bin_dir / 'mv'
            move.write_text('#!/usr/bin/env python3\nimport os,sys\nos.replace(sys.argv[-2],sys.argv[-1])\n')
            move.chmod(0o755)
            readlink = bin_dir / 'readlink'
            readlink.write_text('#!/usr/bin/env python3\nfrom pathlib import Path\nimport sys\nprint(Path(sys.argv[-1]).resolve(strict=True))\n')
            readlink.chmod(0o755)
            q = shlex.quote
            prefix = f'''set -euo pipefail
REPO_DIR={q(str(repo))}
CONTROL_DIR={q(str(active))}
CONTROL_PARENT={q(str(root))}
GENERATION_ROOT={q(str(generations))}
PROTOCOL_V1_FILE=engine-release-protocol-v1.schema
PROTOCOL_V1_SHA256=7c5aba4d2bc572edc5ef84c5280e1ffe517e5949b41788c18eeb003abea74044
CORE_FILES=(control.sh engine-release-protocol-v1.schema)
die() {{ echo "$*" >&2; exit 1; }}
fsync_paths() {{ :; }}
# Bash 3 on macOS lacks mapfile; preserve the simple -t array read used here.
if ! type mapfile >/dev/null 2>&1; then
  mapfile() {{ local target="$2" line; eval "$target=()"; while IFS= read -r line; do eval "$target+=(\\\"\\$line\\\")"; done; }}
fi
'''
            validation = section('validate_v1_protocol() {', '\n[ "$(id -u)" = 0 ]')
            admission = section("ACTIVE_CONTROL_SHA=''", '\n# Ignore caller-supplied source directories.')
            activation_start = SOURCE.index('  NEXT_LINK="$CONTROL_PARENT/.engine-control.next.$$"')
            activation_start = SOURCE.rfind('\nif ', 0, activation_start) + 1
            activation = SOURCE[activation_start:SOURCE.index('\n# Retire every installation edge', activation_start)]
            env['PATH'] = str(bin_dir) + os.pathsep + env['PATH']

            def install(sha):
                code = prefix + '\n' + validation + '\nCONTROL_SHA=' + sha + '\n' + admission
                code += '\nGENERATION_DIR="$GENERATION_ROOT/$CONTROL_SHA"\n' + activation
                return subprocess.run(['bash', '-c', code], text=True, capture_output=True, env=env)

            result = install(shas[1])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(active.resolve(), generations / shas[1], 'validated older canonical generation must activate the requested newer one')
            inode = active.lstat().st_ino
            result = install(shas[1])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(active.lstat().st_ino, inode, 'same SHA must not replace its active symlink')
            result = install(shas[0])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('refusing downgrade', result.stdout)
            self.assertIn('ENGINE_CONTROL_INSTALL_SHA=' + shas[1], result.stdout)
            self.assertEqual(active.resolve(), generations / shas[1])
            self.assertEqual(active.lstat().st_ino, inode)


if __name__ == '__main__':
    unittest.main()
