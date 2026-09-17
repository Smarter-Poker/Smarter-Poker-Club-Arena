/**
 * NON-MAC WORKTREE DEPENDENCY PROVISIONING
 *
 * scripts/agent-workspace.sh is byte-identical across this estate, and on
 * 2026-09-08 the World Hub's main clone held ONE package (typescript) after a
 * git-safe-push clean and a rolled-back install. The provisioner cloned that
 * one package faithfully into every tree claimed that day: no tsc, no build,
 * and a pre-push hook dying on ERR_MODULE_NOT_FOUND. Three trees, three manual
 * repairs.
 *
 * The fix landed in the World Hub first (#1658) and is copied here byte for
 * byte. The 2026-09-11 user instruction now prohibits Mac worktree copies and
 * installs in Club Arena; separate executable tests cover that policy. World
 * Hub is outside this task's write scope.
 */
import { describe, it, expect } from 'vitest';
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const script = readFileSync(join(ROOT, 'scripts/agent-workspace.sh'), 'utf8');
const code = script.replace(/^\s*#.*$/gm, '');

describe('Mac workspaces never recreate the purged dependencies', () => {
  for (const scenario of [
    'workspace',
    'policy-drift',
    'policy-missing',
    'older-main',
    'missing-shared',
    'gutted-shared',
    'journal-probe',
  ]) {
    it(`executes the ${scenario} path without installs, dependency copies or repairs`, () => {
      const temporary = mkdtempSync(join(tmpdir(), 'ca-mac-dependency-policy-'));
      try {
        const clone = join(temporary, 'clone');
        const trees = join(temporary, 'trees');
        const tree = join(trees, 'probe');
        const bin = join(temporary, 'bin');
        const trace = join(temporary, 'unexpected-mutation');
        for (const dir of [clone, tree, bin, join(clone, 'scripts')])
          mkdirSync(dir, { recursive: true });
        for (const dir of [clone, tree, join(clone, 'server'), join(tree, 'server')]) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'package.json'), '{}');
        }
        writeFileSync(
          join(clone, 'scripts/check-node-modules.sh'),
          readFileSync(join(ROOT, 'scripts/check-node-modules.sh'))
        );
        if (scenario !== 'missing-shared') {
          mkdirSync(join(clone, 'node_modules/typescript'), { recursive: true });
          writeFileSync(join(clone, 'node_modules/typescript/KEEP'), 'existing package bytes');
        }
        const policyDir = join(tree, 'docs/agent-policy');
        mkdirSync(policyDir, { recursive: true });
        for (const name of readdirSync(join(ROOT, 'docs/agent-policy'))) {
          writeFileSync(join(policyDir, name), readFileSync(join(ROOT, 'docs/agent-policy', name)));
        }
        if (scenario === 'policy-drift')
          writeFileSync(join(policyDir, 'OPERATING-LAW.md'), 'stale instruction');
        if (scenario === 'policy-missing') rmSync(join(policyDir, 'HARDENING.md'));
        const executable = (name: string, text: string) =>
          writeFileSync(join(bin, name), '#!/bin/bash\n' + text, { mode: 0o755 });
        executable('uname', "printf 'Darwin\\n'\n");
        for (const name of ['npm', 'cp'])
          executable(
            name,
            'printf "%s\\n" "unexpected ' + name + '" >> "$MAC_TEST_TRACE"\nexit 79\n'
          );
        executable(
          'git',
          `case "$*" in
          'rev-parse --path-format=absolute --git-common-dir') printf '%s/.git\\n' "$MAC_TEST_CLONE";;
          *'fetch origin main --quiet') exit 0;;
          *'show origin/main:scripts/agent-workspace.sh')
            if [ "$MAC_TEST_OLD_MAIN" = 1 ]; then printf '# old dependency provisioner\\n';
            else cat "$MAC_TEST_SOURCE"; fi;;
          *'rev-parse --git-dir') printf '.git\\n';;
          *'status --porcelain') printf ' M retained-source.ts\\n';;
          *'branch --show-current') printf 'agent/probe/fix-disk\\n';;
          *'rev-list --count HEAD..origin/main') printf '0\\n';;
          *) printf 'unexpected git mutation\\n' >> "$MAC_TEST_TRACE"; exit 79;;
        esac\n`
        );
        const env = {
          ...process.env,
          PATH: bin + ':' + process.env.PATH,
          AGENT_WORKTREE_ROOT: trees,
          AGENT_WORKSPACE_REEXEC: '',
          MAC_TEST_CLONE: clone,
          MAC_TEST_TRACE: trace,
          MAC_TEST_SOURCE: join(ROOT, 'scripts/agent-workspace.sh'),
          MAC_TEST_OLD_MAIN: scenario === 'older-main' ? '1' : '0',
        };
        const workspace = ['workspace', 'older-main', 'policy-drift', 'policy-missing'].includes(
          scenario
        );
        const args = workspace
          ? [join(ROOT, 'scripts/agent-workspace.sh'), 'probe', 'fix-disk', '--print-path']
          : [
              join(
                ROOT,
                scenario === 'journal-probe'
                  ? 'scripts/ci/probes/chip-journal-atomicity/run-isolated.sh'
                  : 'scripts/check-node-modules.sh'
              ),
            ];
        let exitCode = 0;
        let output = '';
        try {
          output = execFileSync('bash', args, { cwd: tree, env, encoding: 'utf8', stdio: 'pipe' });
        } catch (error) {
          exitCode = Number((error as { status: number }).status);
        }
        expect(exitCode).toBe(scenario === 'workspace' ? 0 : 1);
        if (scenario === 'workspace') expect(output.trim()).toBe(tree);
        expect(existsSync(trace)).toBe(false);
        expect(existsSync(join(tree, 'node_modules'))).toBe(false);
        expect(existsSync(join(tree, 'server/node_modules'))).toBe(false);
        if (scenario !== 'missing-shared')
          expect(readFileSync(join(clone, 'node_modules/typescript/KEEP'), 'utf8')).toBe(
            'existing package bytes'
          );
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    });
  }
});

describe('the provisioner judges a node_modules by its payload', () => {
  it('has a usability test, not a presence test', () => {
    expect(code).toMatch(/^node_modules_usable\(\) \{/m);
    expect(code).toContain('[ -x "$nm/.bin/tsc" ] || return 1');
    expect(code).toContain('[ "$n" -ge 100 ] || return 1');
  });

  it('borrows from a sibling tree only when the lockfile matches', () => {
    expect(code).toMatch(/^find_node_modules_donor\(\) \{/m);
    expect(code).toContain('package-lock.json');
    expect(code).toContain('cmp -s');
  });

  it('tests the source before cloning it, and repairs when nothing can donate', () => {
    expect(code).toContain('if ! node_modules_usable "$src/node_modules" "$rel"; then');
    expect(code).toContain('bash "$ROOT/scripts/check-node-modules.sh"');
  });

  /**
   * USABLE IS NOT CURRENT (2026-09-10). The Club Arena main clone sat 25
   * commits behind origin/main; its install matched its own old lockfile and
   * passed every test above, and every tree cut from origin/main that day came
   * up with tsc failing on a package the tree's lockfile named and the clone's
   * did not. The donor search compared candidates against the main clone's
   * lockfile - the stale one - so it could never help. The reference is the
   * lockfile the TREE will run with, for the source and for every donor.
   */
  it("judges an install against the tree's own lockfile, not the main clone's", () => {
    expect(code).toMatch(/^node_modules_matches_lockfile\(\) \{/m);
    // npm's own record of what it installed is what is compared...
    expect(code).toContain('.package-lock.json');
    // ...against the lockfile of the tree being provisioned, source and donor alike.
    expect(code).toContain(
      'node_modules_matches_lockfile "$src/node_modules" "$dst/package-lock.json"'
    );
    expect(code).toContain('local lock="$DIR${rel:+/$rel}/package-lock.json"');
    expect(code).toContain('node_modules_matches_lockfile "$nm" "$lock" || continue');
    // Optional platform packages are empty by design and must not count.
    expect(code).toContain('v.optional) continue');
  });

  it('retains the non-Mac installer for a clone that does not satisfy its lockfile', () => {
    expect(code).toContain(
      'node_modules_matches_lockfile "$dst/node_modules" "$dst/package-lock.json"'
    );
    expect(code).toContain('npm ci --no-audit --no-fund');
    // In the TREE, never the main clone: `cd "$dst"` precedes it.
    expect(code).toMatch(/\(cd "\$dst" && npm ci --no-audit --no-fund/);
  });

  it('still calls the repair script this repo actually has', () => {
    // Invoked as `bash <path>`, so the mode does not decide whether it
    // runs: what matters is that the file the provisioner names exists.
    // The World Hub called a check-node-modules.sh it did not have and
    // printed "No such file" on every claim for weeks.
    const repair = join(ROOT, 'scripts/check-node-modules.sh');
    expect(existsSync(repair)).toBe(true);
    expect(readFileSync(repair, 'utf8')).toContain('npm ci');
  });
});

describe('the provisioner does not trust the copy of itself that it is', () => {
  // 2026-09-11. The main clone's working tree is kept current by nothing. That
  // day the Club Arena clone was 630 commits behind origin/main with 408 staged
  // entries from an abandoned index, and two things followed in one morning:
  // `./scripts/agent-workspace.sh` was 100644 there and refused to run, and the
  // copy that did run was the pre-2026-09-10 provisioner, which judges
  // node_modules against the MAIN CLONE's lockfile instead of the tree's - the
  // bug every assertion above exists to prevent, reintroduced by a stale file.
  //
  // The worktree was never at risk; it is cut from origin/main either way. The
  // risk is that the LOGIC doing the cutting is old, and the banner it prints
  // looks identical when it is.

  it('fetches and compares itself against origin/main before doing anything', () => {
    expect(code).toMatch(/git -C "\$ROOT" fetch origin main --quiet/);
    expect(code).toContain('git -C "$ROOT" show origin/main:scripts/agent-workspace.sh');
    expect(code).toContain('!= "$(cat "$0")"');
  });

  it('hands over to main rather than warning, and cannot loop doing it', () => {
    // A warning would ask an agent to decide whether a 630-commit-old
    // provisioner matters, with nothing to decide it with.
    expect(code).toMatch(/AGENT_WORKSPACE_REEXEC=1 exec bash "\$_MAIN_SCRIPT" "\$@"/);
    // The guard variable is read before the comparison and set on the exec, so
    // the copy handed to does not compare itself and hand over again.
    expect(code).toMatch(/\[ -z "\$\{AGENT_WORKSPACE_REEXEC:-\}" \]/);
  });

  it('says how far behind the clone it was invoked from is', () => {
    expect(code).toContain('rev-list --count HEAD..origin/main');
  });

  it('compares before it mutates anything', () => {
    // If the handover happened after `git worktree add`, main's copy would
    // inherit a tree the stale copy had already made, which is the one
    // arrangement worse than either script running alone.
    const handover = code.indexOf('AGENT_WORKSPACE_REEXEC=1 exec bash');
    const worktreeAdd = code.indexOf('git -C "$ROOT" worktree add');
    expect(handover).toBeGreaterThan(-1);
    expect(worktreeAdd).toBeGreaterThan(-1);
    expect(handover).toBeLessThan(worktreeAdd);
  });

  it('is executable, because the playbook tells agents to run it by path', () => {
    // The World Hub's copy lost this bit on 2026-08-24 in a parity restore and
    // spent eighteen days refusing `./scripts/agent-workspace.sh` with
    // Permission denied, in the one repo where an agent is most likely to be
    // reading instructions rather than improvising.
    const mode = execFileSync('git', ['ls-files', '-s', 'scripts/agent-workspace.sh'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).split(' ')[0];
    expect(mode, 'scripts/agent-workspace.sh is not executable in git').toBe('100755');
  });
});
