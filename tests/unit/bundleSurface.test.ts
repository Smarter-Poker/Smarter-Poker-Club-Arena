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
