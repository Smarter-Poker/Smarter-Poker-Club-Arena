/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A JS ARRAY IS NOT A POSTGREST FILTER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-23: "THE MTT, SPINS AND HEADS UP TABLES AND EVENTS THAT WERE
 * CREATED IN THE MIDWAY UNION ARE NOT BEING DISPLAYED IN THE ATTACHED CLUBS."
 *
 * The cash half of that had one cause, and it was four characters wide.
 * `ClubHomePage` asked for the club's tables with
 *
 *     .not('status', 'in', ['closed', 'deleted'])
 *
 * `.not(column, operator, value)` does not inspect the value; it interpolates
 * it into `not.<operator>.<value>`. An array stringifies to `closed,deleted`,
 * so the wire carried `status=not.in.closed,deleted` and PostgREST replied
 *
 *     400 PGRST100  "failed to parse filter (not.in.closed,deleted)"
 *
 * The whole list came back null. Club JAQK, Shark Club and Midway each showed
 * ZERO cash tables while 44 were running, on every single load, because one
 * filter in a chained builder failed. The correct value is the group form the
 * client builds for itself in `.in()`: `'("closed","deleted")'`.
 *
 * This file states the rule for the WHOLE of src/, not for the one line that
 * happened to break, because the operator is identical everywhere and the
 * failure mode is silent: a 400 and a genuinely empty club render the same.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const SRC = resolve(__dirname, '../../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** `.not('col', 'in', [ ... ])` — the exact shape that 400s. */
const ARRAY_IN_NOT = /\.not\(\s*['"][A-Za-z0-9_]+['"]\s*,\s*['"]in['"]\s*,\s*\[/;

describe('every PostgREST "not in" filter is written as a group', () => {
  const files = walk(SRC);

  it('reads a non-trivial number of source files', () => {
    // A walker that silently finds nothing would make every assertion below
    // vacuously true, which is the classic way a guard like this rots.
    expect(files.length).toBeGreaterThan(100);
  });

  it('passes no JS array to .not(col, "in", ...) anywhere in src', () => {
    const offenders = files
      .filter((f) => ARRAY_IN_NOT.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1));

    expect(offenders).toEqual([]);
  });

  it('keeps the club lobby table query on the group form', () => {
    const src = readFileSync(join(SRC, 'pages/ClubHomePage.tsx'), 'utf8');
    expect(src).toMatch(/\.not\('status', 'in', '\("closed","deleted"\)'\)/);
  });

  it('reports a failed table query instead of silently blanking the lobby', () => {
    // The 400 above ran for hours with nothing logged, because a swallowed
    // error and an empty club are indistinguishable on screen.
    const src = readFileSync(join(SRC, 'pages/ClubHomePage.tsx'), 'utf8');
    expect(src).toMatch(/ClubHomePage\.tablesQueryFailed/);
  });
});
