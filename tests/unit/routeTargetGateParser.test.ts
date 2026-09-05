import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * THE ROUTE GATE'S PARSER, PINNED
 *
 * `scripts/ci/check-route-targets.mjs` is the guard that catches a button
 * landing nowhere, and until 2026-09-05 it had no test of its own. That is how
 * it came to be VACUOUS: `path="*"` and `path="/"` both compiled to a
 * match-everything matcher, so a planted
 * `navigate('/this-route-does-not-exist-anywhere-xyz')` was reported OK with
 * exit 0. It had been unable to fail since the catch-all route was added.
 *
 * Fixing that widened the gate to <Link>/<NavLink> and to basename-escaping
 * <a href>, and taught it to blank comments first - because its first widened
 * run reported six failures that were ALL comment prose quoting the very bugs
 * those comments record being fixed.
 *
 * Comment-blanking is now the gate's most dangerous component: a parser that
 * over-strips produces a FALSE NEGATIVE, and a false negative here is strictly
 * worse than the vacuum it replaced - the gate would go green while a real dead
 * link shipped. So the parser gets its own cases, especially the ones that look
 * like comments and are not: a regex holding slashes, a division, a URL, an
 * apostrophe inside a comment, and a comment marker inside a string.
 *
 * It must also preserve byte offsets, or every line number the gate reports
 * points at the wrong line.
 */

const ROOT = resolve(__dirname, '../..');
const GATE = readFileSync(resolve(ROOT, 'scripts/ci/check-route-targets.mjs'), 'utf8');

/** Lift the REAL stripComments out of the shipped gate - never a copy of it. */
const loadStripComments = (): ((src: string) => string) => {
  const start = GATE.indexOf('function stripComments');
  const end = GATE.indexOf('\nfor (const file of walk');
  expect(start, 'stripComments not found in the gate').toBeGreaterThan(-1);
  expect(end, 'the walk loop that follows stripComments moved').toBeGreaterThan(start);

  return new Function(`${GATE.slice(start, end)}\nreturn stripComments;`)() as (
    s: string
  ) => string;
};

const stripComments = loadStripComments();

/**
 * The gate's own matcher AND its own normalisation, so these cases exercise the
 * real pair rather than a lookalike. An interpolation becomes `<param>` (which
 * `matches()` later resolves to a single path segment); it is NOT truncated.
 */
const NAV = /navigate\(\s*(['"`])(\/[^'"`]*?)\1|navigate\(\s*`(\/[^`]*)`/g;
const targetsIn = (code: string): string[] =>
  [...stripComments(code).matchAll(NAV)].map((m) =>
    (m[2] ?? m[3] ?? '')
      .split('?')[0]
      .split('#')[0]
      .replace(/\$\{[^}]*\}/g, '<param>')
  );

describe('the route gate hides commented-out targets', () => {
  it.each([
    ['a line comment', "// navigate('/ghost')\nnavigate('/kept')"],
    ['a block comment', "/* navigate('/ghost') */ navigate('/kept')"],
    ['a JSX comment', "{/* navigate('/ghost') */}\nnavigate('/kept')"],
    ['a doc block', "/**\n * navigate('/ghost')\n */\nnavigate('/kept')"],
  ])('%s cannot contribute a target', (_name, code) => {
    expect(targetsIn(code)).toEqual(['/kept']);
  });
});

describe('but it never eats live code that merely looks like a comment', () => {
  it.each([
    ['a URL inside a string', "const u = 'https://x.com//y'; navigate('/kept')"],
    ['a regex holding slashes', "const r = /a\\/\\/b/; navigate('/kept')"],
    ['a division expression', "const x = a / b / c; navigate('/kept')"],
    ['an apostrophe inside a comment', "// don't navigate('/ghost')\nnavigate('/kept')"],
    ['an escaped quote in a string', "const s = 'it\\'s // fine'; navigate('/kept')"],
    ['a comment marker inside a string', 'const s = "/* not a comment */"; navigate(\'/kept\')'],
  ])('%s still yields its target', (_name, code) => {
    expect(targetsIn(code)).toEqual(['/kept']);
  });

  it('a template literal keeps its interpolation as a single segment', () => {
    // `<param>` is what `matches()` expands to `[^/]+`. Truncating at the `${`
    // instead would turn `/clubs/${id}/lobby` into `/clubs/` and quietly stop
    // checking everything after the first interpolation.
    expect(targetsIn('navigate(`/clubs/${id}/lobby`)')).toEqual(['/clubs/<param>/lobby']);
  });
});

describe('the parser keeps the file the same length, so line numbers stay true', () => {
  it.each([
    ['line comment', "// hidden\nnavigate('/a')"],
    ['block comment', "/* hidden\n  still hidden */\nnavigate('/a')"],
    ['string with escapes', "const s = 'a\\\\b'; navigate('/a')"],
  ])('%s preserves byte count and newlines', (_name, code) => {
    const out = stripComments(code);
    expect(out).toHaveLength(code.length);
    expect(out.split('\n')).toHaveLength(code.split('\n').length);
  });
});

describe('the matcher no longer treats the catch-all as a match', () => {
  it('excludes both "*" and "/" from the matcher set', () => {
    // The one line that made this gate unable to fail. `matches()` answers the
    // index route directly; the catch-all renders NotFound, which IS the
    // failure this gate exists to report, never a success.
    expect(GATE).toContain("if (clean === '' || clean === '*') return null;");
    expect(GATE).toContain('.filter(Boolean)');
  });

  it('still honours a NESTED splat, which is a real prefix route', () => {
    expect(GATE).toContain("if (seg === '*') return '.*';");
  });

  it('checks Link and NavLink, not only navigate()', () => {
    expect(GATE).toContain('const LINK =');
    expect(GATE).toMatch(/Link\|NavLink/);
  });

  it('treats a SPA-path <a href> as leaving the router, but lets the Hub keep its own', () => {
    expect(GATE).toContain('const isHubOwned =');
    expect(GATE).toContain("p.startsWith('/hub/') && !p.startsWith('/hub/club-arena')");
  });
});
