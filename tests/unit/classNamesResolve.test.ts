/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A CLASS NAME IS A STRING NAMING SOMETHING NOTHING CHECKS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The same shape as the keyframe bug that rendered eleven pages blank on
 * 2026-08-23 (see inlineAnimationsResolve.test.ts): a name lives as a raw
 * string, the thing it names lives in CSS, and nothing in between verifies
 * that one resolves to the other. When it does not resolve, nothing errors —
 * the element simply renders unstyled, which on a dark theme usually means
 * invisible or unreadable rather than obviously broken.
 *
 * WHAT COUNTS AS REACHABLE. Vite splits CSS per chunk, so a class is only
 * present when its stylesheet is loaded on that route:
 *
 *   - the stylesheets src/main.tsx imports, which are on every route;
 *   - the file's own sibling .css;
 *   - any plain .css the file imports itself.
 *
 * A definition in some other component's stylesheet does NOT count — it is
 * there only if that component happens to be in the same chunk, which is luck,
 * not a contract. `.module.css` never counts: those names are hashed at build
 * time and can never match a raw string.
 *
 * SCOPE. Only single, plain, BEM-shaped classNames (`block__element`). Not
 * template literals, not `styles.foo`, not multi-class strings, not utility
 * classes — those either resolve differently or are too noisy to judge. This
 * is the subset where an unresolved name is unambiguously a mistake.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

const ROOT = resolve(__dirname, '../../');
const SRC = join(ROOT, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function classesIn(file: string): Set<string> {
  const found = new Set<string>();
  if (!existsSync(file)) return found;
  for (const m of readFileSync(file, 'utf8').matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g))
    found.add(m[1]);
  return found;
}

const globalClasses = (() => {
  const main = readFileSync(join(SRC, 'main.tsx'), 'utf8');
  const sheets = [...main.matchAll(/import '(\.[^']+\.css)'/g)].map((m) =>
    join(SRC, m[1].replace(/^\.\//, ''))
  );
  const all = new Set<string>();
  for (const sheet of sheets) for (const c of classesIn(sheet)) all.add(c);
  return all;
})();

const BEM = /className="([a-z][a-z0-9_-]*(?:__|--)[a-z0-9_-]+)"/g;

const unresolved: string[] = [];
let checked = 0;

for (const file of walk(SRC).filter((f) => /\.tsx$/.test(f))) {
  const text = readFileSync(file, 'utf8');

  const reachable = new Set(globalClasses);
  for (const c of classesIn(file.replace(/\.tsx$/, '.css'))) reachable.add(c);
  for (const m of text.matchAll(/import\s+'([^']+\.css)'/g)) {
    if (m[1].includes('.module.')) continue;
    for (const c of classesIn(resolve(dirname(file), m[1]))) reachable.add(c);
  }

  for (const m of text.matchAll(BEM)) {
    checked++;
    if (!reachable.has(m[1])) unresolved.push(`${file.slice(SRC.length + 1)} -> ${m[1]}`);
  }
}

describe('the scanner is looking at something', () => {
  it('finds the global stylesheets', () => {
    expect(globalClasses.size).toBeGreaterThan(50);
  });

  it('checks a meaningful number of class names', () => {
    expect(checked).toBeGreaterThan(1000);
  });
});

describe('every BEM className resolves on the route that renders it', () => {
  /**
   * 43 references across 35 names on 2026-08-23, of which 27 are defined in NO
   * stylesheet anywhere — those elements render with no styling at all — and 8
   * are defined only in a stylesheet their own route never loads.
   *
   * They are not fixed here on purpose. Writing CSS for
   * `insurance-modal__ev-hero` without the design in front of you is inventing
   * an appearance, and this repo has spent a day paying for changes made
   * without the thing in view. Each belongs to whoever owns that component.
   *
   * The baseline exists so the number can only ever go DOWN: a new unresolved
   * class fails this test, and fixing one requires lowering the number in the
   * same commit. Same rule the cron governance check uses in the World Hub.
   *
   * 2026-08-27: 43 -> 41. `hdm-street__name` was three of them — two already
   * here, and the Run It Twice board block added a third. It is the street
   * label inside `.hdm-street__head`, so it was inheriting the head's type and
   * looked right by accident; `HandDetailModal.css` now defines it, and all
   * three references resolve. Baseline lowered in the same commit, per the
   * paragraph above.
   *
   * 2026-09-14: 41 -> 35. `rules-modal__section` was five of them; the rules
   * sheet's stylesheet was rewritten for the shark frame (#ClubArenaConsole)
   * and defines the section now. One more went with it.
   */
  const BASELINE = 35;

  it(`has no more than ${BASELINE} unresolved BEM class names`, () => {
    expect(unresolved.length).toBeLessThanOrEqual(BASELINE);
  });

  it('lists them, so the number is never just a number', () => {
    // Fails loudly if the list grows, and prints exactly which file and class.
    if (unresolved.length > BASELINE) {
      throw new Error(`unresolved classNames grew:\n${unresolved.join('\n')}`);
    }
    expect(unresolved.length).toBeGreaterThanOrEqual(0);
  });
});
