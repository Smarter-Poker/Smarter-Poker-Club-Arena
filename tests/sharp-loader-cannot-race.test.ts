/**
 * The shared sharp prefix cannot be raced by two jobs on one box.
 *
 * 2026-09-03: `CSS Beat E2E` - a REQUIRED check - failed on PR #2779 with
 *
 *   npm error ENOTEMPTY: directory not empty, rename
 *     '/tmp/ca-webp-sharp/node_modules/sharp' -> '.../.sharp-Xz06ay6F'
 *
 * and blocked the pull request for a reason unrelated to its diff. The loader
 * installed into ONE fixed path, `os.tmpdir()/ca-webp-sharp`. That was safe
 * while every CI job had a machine to itself; it stopped being safe when eight
 * self-hosted runners started sharing one box and one /tmp.
 *
 * Reproduced locally by running four cold loads at once: the old code failed
 * 4 of 4, the fixed code passed 4 of 4.
 *
 * The fix is the standard atomic-cache shape - stage privately, publish with a
 * single rename, and if someone beat you to it use theirs. These pins are the
 * three parts of that shape. Renaming the directory per runner is NOT an
 * acceptable substitute: two jobs on the same runner, or two agents on a
 * workstation, still collide.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '../scripts/lib/sharp-loader.mjs'), 'utf8');

describe('sharp-loader cannot race across concurrent jobs', () => {
  it('installs into a private staging directory, never straight into the cache', () => {
    // The cwd handed to npm must be the staging dir. If this is ever CACHE
    // again, two concurrent installs are back to sharing one node_modules.
    expect(src).toMatch(/execSync\(\s*['"]npm install[^]*?cwd:\s*staging/);
  });

  it('the staging directory is unique per process AND random', () => {
    // pid alone is not enough: pids are reused, and two runners on one box can
    // hold the same pid at the same moment.
    expect(src).toMatch(/staging\s*=\s*`\$\{CACHE\}\.staging\.\$\{process\.pid\}\.\$\{randomBytes/);
  });

  it('publishes with a single rename and yields to whoever won', () => {
    expect(src).toContain('renameSync(staging, CACHE)');
    // The catch around it must recover by USING the existing cache, not by
    // failing - a lost race is the normal case, not an error.
    const i = src.indexOf('renameSync(staging, CACHE)');
    const after = src.slice(i, i + 500);
    expect(after).toMatch(/catch[^]*tryPrefix\(CACHE\)/);
  });

  it('has a warm path that runs no npm at all', () => {
    // Once any job on the box has published the cache there is nothing left to
    // race over - and nothing to install, which is also why CI got faster.
    expect(src).toMatch(/const warm = tryPrefix\(CACHE\);\s*\n\s*if \(warm\) return warm;/);
  });

  it('never leaves a staging directory behind on failure', () => {
    // The nightly GC ages /tmp by mtime now, so debris would linger a full day.
    const i = src.lastIndexOf('catch (err)');
    expect(src.slice(i)).toMatch(
      /rmSync\(staging,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/
    );
  });
});
