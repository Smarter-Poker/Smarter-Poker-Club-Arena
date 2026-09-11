/**
 * A WORKTREE GETS A node_modules THAT WORKS
 *
 * scripts/agent-workspace.sh is byte-identical across this estate, and on
 * 2026-09-08 the World Hub's main clone held ONE package (typescript) after a
 * git-safe-push clean and a rolled-back install. The provisioner cloned that
 * one package faithfully into every tree claimed that day: no tsc, no build,
 * and a pre-push hook dying on ERR_MODULE_NOT_FOUND. Three trees, three manual
 * repairs.
 *
 * The fix landed in the World Hub first (#1658) and is copied here byte for
 * byte, because a guard that differs between repos is a guard that is only
 * true where somebody last looked.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const script = readFileSync(join(ROOT, 'scripts/agent-workspace.sh'), 'utf8');
const code = script.replace(/^\s*#.*$/gm, '');

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

  it('finishes a clone that does not satisfy the lockfile with npm ci in the tree itself', () => {
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
