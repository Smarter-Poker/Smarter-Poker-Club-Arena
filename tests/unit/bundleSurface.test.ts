/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BUNDLE SURFACE — the two imports that quietly cost 64 kB gzipped
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Measured 2026-08-21. Both of these are one-line regressions that no reviewer
 * would flag and no other test would notice, because the app behaves identically
 * either way — it just ships more of it.
 *
 * 1. `import('@sentry/react')` gives the bundler a live namespace object, so it
 *    keeps the whole package: the feedback widget, the canvas replay recorder and
 *    the rest rode along behind the dozen functions this app calls. Routing every
 *    consumer through `src/core/sentryBundle.ts` (named imports) cut the Sentry
 *    chunk from 138.5 kB gzipped to 80.7 kB.
 *
 * 2. `import gsap from 'gsap'` registers CSSPlugin, which exists to tween DOM
 *    style properties. The 3D replay tweens three.js objects and never touches an
 *    element, so that was 63 kB of source for nothing: 7 kB gzipped.
 *
 * The gzipped ceiling is a hard CI failure at 2048 kB and the bundle sits inside
 * 200 kB of it, so a silent 64 kB is a meaningful share of the remaining room.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

/** Import statements only — prose in a comment is not a bundling decision. */
function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [
    ...src.matchAll(/(?:^|[^\w.])import\s*(?:\(\s*)?['"]([^'"]+)['"]/gm),
    ...src.matchAll(/from\s+['"]([^'"]+)['"]/g),
  ].map((m) => m[1]);
}

describe('the bundle surface stays narrow', () => {
  const files = sourceFiles(SRC);

  it('only sentryBundle.ts reaches @sentry/react directly', () => {
    const offenders = files
      .filter((f) => importsOf(f).some((s) => s === '@sentry/react' || s.startsWith('@sentry/')))
      .map((f) => relative(process.cwd(), f))
      .filter((f) => f !== 'src/core/sentryBundle.ts');

    expect(
      offenders,
      'Import from src/core/sentryBundle.ts instead — a direct @sentry/react import ' +
        'pulls the whole package back into the chunk (+58 kB gzipped).'
    ).toEqual([]);
  });

  it('the Sentry surface is a named-import list, not a namespace', () => {
    const src = readFileSync(join(SRC, 'core/sentryBundle.ts'), 'utf8');
    expect(src).not.toMatch(/import\s+\*\s+as\s+\w+\s+from\s+['"]@sentry\/react['"]/);
    expect(src).toMatch(/import\s*\{[\s\S]*?\}\s*from\s*['"]@sentry\/react['"]/);
  });

  /**
   * PHASE 4 2026-09-05: gsap left the app entirely.
   *
   * Its one consumer was `HandReplay3D`, the 3D felt behind the platform's
   * SECOND hand replayer on `/share/hand/:handId`. That page renders the same
   * `HandReplay` as the table and the archive now, so the 3D replay, its
   * snapshot type and the three analysis widgets beside it were retired
   * rather than kept as a parallel reading of the same hand.
   *
   * The pin stays, pointed the other way: gsap is a dependency nothing
   * imports, and an `import gsap from 'gsap'` anywhere brings back a 63 kB
   * source (7 kB gzipped) whose CSSPlugin exists to tween DOM styles this app
   * animates in CSS.
   */
  it('nothing in src imports gsap at all', () => {
    const users = files
      .filter((f) => importsOf(f).some((s) => s === 'gsap' || s.startsWith('gsap/')))
      .map((f) => relative(process.cwd(), f));
    expect(users).toEqual([]);
  });
});
