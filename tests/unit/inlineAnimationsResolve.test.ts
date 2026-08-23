/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AN ANIMATION NAME THAT RESOLVES TO NOTHING, NEXT TO opacity: 0
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-23: "the create new table button doesn't work for any of the
 * cash games or tournaments."
 *
 * The button worked. The page it opened rendered seven game-type cards that
 * were in the DOM, laid out, occupying space, and completely transparent:
 *
 *     opacity: 0,
 *     animation: `fadeInUp 0.5s ease-out ${index * 70}ms forwards`,
 *
 * `@keyframes fadeInUp` is not reachable on that route. A CSS-only refactor
 * (ba1af5a8b, "ZERO colliding @keyframes names", 93 .css files, 0 .tsx)
 * renamed every keyframe to a file-prefixed name -- `fadeInUp` became
 * `animationsFadeInUp` in the globally imported src/styles/animations.css --
 * and nothing updated the animation names that live as RAW STRINGS in inline
 * style objects, where no CSS tool can see them.
 *
 * An unresolvable animation-name is not an error. The declaration is simply
 * dropped, the animation never runs, and the `opacity: 0` that the animation
 * was supposed to clear stays forever. No console error. No failed request.
 * No type error. tsc, vitest and the production build were all green while
 * eleven pages rendered blank.
 *
 * THE RULE. An animation named in a .ts/.tsx inline style must be defined in
 * a stylesheet that is actually loaded when that file renders, which means
 * either:
 *   - one of the stylesheets src/main.tsx imports (loaded on every route), or
 *   - the file's own sibling .css (loaded with its chunk).
 *
 * A definition in some other page's .css does not count: Vite splits CSS per
 * chunk, so it is not there when this page paints. Neither does a .module.css
 * definition, whose name is hashed at build time and can never match a raw
 * string.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

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

function keyframesIn(file: string): Set<string> {
  const found = new Set<string>();
  if (!existsSync(file)) return found;
  for (const m of readFileSync(file, 'utf8').matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)) {
    found.add(m[1]);
  }
  return found;
}

/** Every stylesheet main.tsx imports — present on every route. */
const globalKeyframes = (() => {
  const main = readFileSync(join(SRC, 'main.tsx'), 'utf8');
  const sheets = [...main.matchAll(/import '(\.[^']+\.css)'/g)].map((m) =>
    join(SRC, m[1].replace(/^\.\//, ''))
  );
  const all = new Set<string>();
  for (const sheet of sheets) for (const k of keyframesIn(sheet)) all.add(k);
  return { sheets, all };
})();

interface Ref {
  file: string;
  line: number;
  name: string;
  hidden: boolean;
}

const refs: Ref[] = (() => {
  const out: Ref[] = [];
  for (const file of walk(SRC).filter((f) => /\.tsx?$/.test(f))) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const sibling = keyframesIn(file.replace(/\.tsx?$/, '.css'));
    lines.forEach((line, i) => {
      const m = line.match(/animation:\s*[`'"]([A-Za-z][A-Za-z0-9_-]*)\s/);
      if (!m) return;
      const name = m[1];
      if (globalKeyframes.all.has(name) || sibling.has(name)) return;
      // An unreachable animation only HIDES something when the same style
      // object starts at opacity 0 and relies on the animation to clear it.
      const context = lines.slice(Math.max(0, i - 6), i + 3).join(' ');
      out.push({
        file: file.slice(SRC.length + 1),
        line: i + 1,
        name,
        hidden: /opacity:\s*0[,\s}]/.test(context),
      });
    });
  }
  return out;
})();

describe('the scanner itself is looking at the right thing', () => {
  it('finds the global stylesheets and their keyframes', () => {
    expect(globalKeyframes.sheets.length).toBeGreaterThan(0);
    expect(globalKeyframes.all.size).toBeGreaterThan(10);
    // The name the rename settled on. If this disappears, the fixes below
    // silently stop being fixes.
    expect(globalKeyframes.all.has('animationsFadeInUp')).toBe(true);
  });

  it('finds inline animations at all', () => {
    // A scanner that matches nothing would make every assertion vacuous.
    const anyInline = walk(SRC)
      .filter((f) => /\.tsx?$/.test(f))
      .some((f) => /animation:\s*[`'"]/.test(readFileSync(f, 'utf8')));
    expect(anyInline).toBe(true);
  });
});

describe('nothing renders itself invisible', () => {
  it('never pairs opacity: 0 with an animation that cannot resolve', () => {
    const invisible = refs.filter((r) => r.hidden).map((r) => `${r.file}:${r.line} -> ${r.name}`);

    // This is the exact failure Dan reported. It must be zero, always.
    expect(invisible).toEqual([]);
  });
});

describe('the cosmetic backlog only ever shrinks', () => {
  /**
   * These 40 animated something that was already visible, so a dead name cost
   * a transition rather than a whole page — which is why they survived the
   * first pass with a baseline instead of a fix. The baseline is zero now: all
   * fourteen distinct names were given real definitions in
   * src/styles/animations.css and all forty references repointed at them.
   *
   * Kept as its own assertion rather than folded into the one above, because
   * the two failures mean different things: that one says a page is BLANK,
   * this one says an animation is silently dead. Both should be zero; only one
   * of them is an outage.
   */
  const BASELINE = 0;

  it('leaves no unreachable animation name anywhere in src, visible or not', () => {
    const cosmetic = refs.filter((r) => !r.hidden).map((r) => `${r.file}:${r.line} -> ${r.name}`);
    expect(cosmetic).toEqual([]);
  });
});
