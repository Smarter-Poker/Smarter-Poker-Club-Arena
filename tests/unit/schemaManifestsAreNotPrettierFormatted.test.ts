/**
 * Every generated schema manifest must be exempt from Prettier.
 *
 * WHY
 *
 * `scripts/ci/gen-schema-manifest.mjs` writes its manifests with
 * `JSON.stringify(x, null, 2)`, which puts every array element on its own line.
 * Prettier collapses a short array onto one line. The two can never agree, so a
 * manifest that lint-staged is allowed to touch oscillates:
 *
 *   generate -> 3,504 lines -> commit -> prettier rewrites to 1,177 lines
 *   -> regenerate -> 3,504 lines again
 *
 * The content is identical every time. `scripts/ci/detect-silent-revert.mjs`
 * compares blobs byte-for-byte against earlier states, so the second write is a
 * wholesale revert by its definition, and it blocks CI — correctly.
 *
 * This has happened twice. PR #360 (2026-08-23) for the columns manifest, fixed
 * by adding it to `.prettierignore`. Then the required-columns manifest was
 * added on 2026-08-28 and nobody added the line, so regenerating churned 3,965
 * lines for zero content change and an agent reverted it out of PR #1708 rather
 * than bury that in a money-adjacent diff. It stayed broken for a day.
 *
 * Both times the omission was invisible: nothing failed until somebody happened
 * to regenerate and read the diff. The generator now refuses to write an
 * unexempt file, but the generator needs a service-role key and so never runs
 * in CI. This test needs neither, and runs on every pull request.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const CI_DIR = join(ROOT, 'scripts', 'ci');

describe('generated schema manifests are exempt from Prettier', () => {
  const manifests = readdirSync(CI_DIR).filter((f) => /-manifest\.json$/.test(f));

  it('finds the manifests it is meant to be checking', () => {
    // Zero files scanned is zero violations found. Assert the floor so a
    // rename cannot turn this whole test vacuous.
    expect(manifests.length).toBeGreaterThanOrEqual(3);
  });

  it('lists every one of them in .prettierignore', () => {
    const ignored = readFileSync(join(ROOT, '.prettierignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));

    const missing = manifests.map((f) => `scripts/ci/${f}`).filter((p) => !ignored.includes(p));

    expect(missing).toEqual([]);
  });

  it('round-trips: re-serialising each manifest reproduces it byte for byte', () => {
    // THE assertion. It is the property the whole exercise protects: if this
    // holds, running the generator against an unchanged schema produces an
    // empty diff, and nothing can oscillate.
    //
    // A first draft of this file also grepped for Prettier-collapsed arrays
    // (`: [a, b]` on one line). That test was both weaker and wrong -- weaker
    // because a byte-exact round trip already implies it, wrong because the
    // `_comment` in the columns manifest literally contains the text
    // "{table: [columns]}" and matched its own regex. Deleted rather than
    // patched: two assertions of the same property, one of them approximate,
    // is how a suite starts lying.
    for (const f of manifests) {
      const text = readFileSync(join(CI_DIR, f), 'utf8');
      expect(JSON.stringify(JSON.parse(text), null, 2) + '\n', `${f} is not idempotent`).toBe(text);
    }
  });
});
