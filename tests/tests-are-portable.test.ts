/**
 * A test may not depend on a file that is not in the repository.
 *
 * tests/e2e/pot-above-chips.spec.ts read a "before" stylesheet from
 * /tmp/TablePage.before.css. That file existed on the machine the fix was
 * written on, so the suite ran 64/64 green there - and failed on the very
 * first clean CI checkout with ENOENT, taking the whole e2e job red. A local
 * pass proved nothing, which is the worst failure mode a test can have.
 *
 * This guard scans every test and spec file for filesystem paths rooted
 * outside the working tree, so that mistake cannot be made silently again.
 * URL paths ('/hub/club-arena', '/health') are untouched - only the machine
 * -local roots below are rejected.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const SEARCH_DIRS = ['tests', 'src', 'server/src'];
const TEST_FILE = /\.(test|spec)\.(ts|tsx)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', 'fixtures']);

/**
 * Absolute roots that exist on a developer machine but not on a clean
 * checkout. `~` is included because shells expand it and Node does not.
 */
const MACHINE_LOCAL = [
  { pattern: /['"`]\/tmp\//, root: '/tmp' },
  { pattern: /['"`]\/Users\//, root: '/Users' },
  { pattern: /['"`]\/home\//, root: '/home' },
  { pattern: /['"`]\/private\//, root: '/private' },
  { pattern: /['"`]\/var\/folders\//, root: '/var/folders' },
  { pattern: /['"`]~\//, root: '~' },
  { pattern: /['"`][A-Za-z]:\\\\/, root: 'a Windows drive' },
];

function collect(dir: string, out: string[] = []): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collect(path.join(dir, entry.name), out);
    } else if (TEST_FILE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const files = SEARCH_DIRS.flatMap((d) => collect(d));

describe('every test file is portable', () => {
  it('finds test files to check (the walker itself is not silently empty)', () => {
    // Without this the whole guard could pass by scanning nothing, which is
    // exactly how tests/e2e/top-rail-seat.spec.ts stopped guarding.
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain(path.join('tests', 'e2e', 'pot-above-chips.spec.ts'));
  });

  it('no test reads a path rooted outside the repository', () => {
    const offences: string[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return;
        for (const { pattern, root } of MACHINE_LOCAL) {
          if (pattern.test(line)) {
            offences.push(`${file}:${i + 1} references ${root} - ${line.trim()}`);
          }
        }
      });
    }
    expect(offences).toEqual([]);
  });

  it('the fixture the pot spec depends on is committed, not machine-local', () => {
    const fixture = path.join(ROOT, 'tests/e2e/fixtures/TablePage.before.css');
    expect(fs.existsSync(fixture)).toBe(true);
    // Non-trivial: an empty file would make the pot comparison meaningless.
    expect(fs.statSync(fixture).size).toBeGreaterThan(10_000);
    expect(fs.readFileSync(fixture, 'utf8')).toContain('.pot-area');
  });
});
