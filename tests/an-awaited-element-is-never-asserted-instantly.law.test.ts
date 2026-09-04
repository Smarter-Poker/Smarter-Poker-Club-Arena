/**
 * AN AWAITED ELEMENT IS NEVER ASSERTED INSTANTLY.
 *
 * `findBy*` resolves as soon as the element EXISTS. It says nothing about the
 * element having settled. So this shape:
 *
 *     const btn = await screen.findByRole('button', { name: 'Load More' });
 *     expect(btn).toBeEnabled();
 *
 * is a race. It passes on an idle laptop and fails on a loaded CI box, where
 * React's next update lands a few milliseconds later than the assertion.
 *
 * On 2026-09-04 exactly that cost a pull request its run: `club-data-page-
 * renders > retires stale game pagination` failed on `toBeEnabled()` while the
 * runners were at load 40. The same test passed six times out of six locally.
 * A red run that no diff explains is worse than a slow one - it teaches agents
 * that CI is unreliable and can be re-run until green, which is how a real
 * failure eventually gets waved through.
 *
 * The fix is never to weaken the assertion. `waitFor` asserts exactly the same
 * thing; it just declines to demand that it be true on the very first tick:
 *
 *     await waitFor(() => expect(btn).toBeEnabled());
 *
 * This law only covers elements obtained with `await`. A synchronous render
 * asserting a prop-driven `disabled` has no race, and wrapping those would add
 * latency for nothing.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');

function racyAssertions(): string[] {
  // Walk it by hand. `fs.globSync` is Node 22+; CI runs Node 20, where it is
  // undefined - and a developer machine on a newer Node passes the pre-push
  // hook, so the difference only ever surfaces on a runner.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.test\.tsx?$/.test(e.name)) files.push(relative(ROOT, full));
    }
  };
  walk(join(ROOT, 'tests'));
  const found: string[] = [];

  for (const rel of files) {
    if (rel.endsWith('an-awaited-element-is-never-asserted-instantly.law.test.ts')) continue;
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');

    lines.forEach((line, i) => {
      const m = line.match(/expect\(\s*([A-Za-z_$][\w$]*)\s*\)\.toBe(Enabled|Disabled)\(\)/);
      if (!m || line.includes('waitFor')) return;

      // already inside a waitFor callback opened just above
      const near = lines.slice(Math.max(0, i - 3), i).join('\n');
      if (near.includes('waitFor(') && near.includes('=>')) return;

      // only racy when the element itself was awaited
      const back = lines.slice(Math.max(0, i - 14), i).join('\n');
      if (new RegExp(`(const|let)\\s+${m[1]}\\s*=\\s*await\\s`).test(back)) {
        found.push(`${rel}:${i + 1}  expect(${m[1]}).toBe${m[2]}()`);
      }
    });
  }
  return found;
}

describe('an awaited element is never asserted instantly', () => {
  it('has no toBeEnabled/toBeDisabled racing an awaited element', () => {
    const racy = racyAssertions();
    expect(
      racy,
      'These assert a settled state on an element that was only awaited into ' +
        'existence. They pass locally and fail on a loaded runner. Wrap each in ' +
        'waitFor - the assertion is unchanged, it just stops demanding the first ' +
        'tick:\n\n  await waitFor(() => expect(x).toBeEnabled());\n\n' +
        racy.join('\n')
    ).toEqual([]);
  });
});
