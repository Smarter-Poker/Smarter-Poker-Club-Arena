/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SORT MUST NOT DELETE ROWS
 * ═══════════════════════════════════════════════════════════════════════════
 * ClubHomePage's 'starting_soon' sort - the DEFAULT one - used to
 * `rows.filter(isLateReg)` and return only the tournaments a player could
 * still enter. A filter wearing a sort's clothes: the lobby's first
 * impression silently dropped every tournament past late registration, and
 * the result count blamed the tab and the saved filters ("Showing 12 Of 111")
 * for a narrowing neither of them did.
 *
 * These tests pin the rule against the source, the way the other
 * shipped-invariant specs do, because the behaviour lives inside a useMemo in
 * a 2,500-line page that cannot be imported in isolation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'src/pages/ClubHomePage.tsx'), 'utf8');

/** The body of the tournament sort switch, comments stripped. */
function startingSoonCase(): string {
  const i = src.indexOf("case 'starting_soon': {");
  expect(i, "the tournament 'starting_soon' sort case").toBeGreaterThan(-1);
  const body = src.slice(i, src.indexOf("case 'recommended'", i));
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe("the lobby's default sort", () => {
  it('does not filter rows out of the list', () => {
    const body = startingSoonCase();
    // The exact shape that shipped: a filter feeding the returned sort.
    expect(body).not.toMatch(/rows\s*\.\s*filter\s*\(/);
    expect(body).not.toMatch(/const\s+activeOnly\s*=/);
  });

  it('sorts every row it was given, enterable games first', () => {
    const body = startingSoonCase();
    // It must return a sort over `rows` itself, not over a derived subset.
    expect(body).toMatch(/return\s+rows\s*\.\s*sort\s*\(/);
    // And the ranking must still put what you can enter at the top.
    expect(body).toMatch(/stillEnterable/);
  });

  it('leaves the filtering to controls that say they filter', () => {
    /* Open Registration / Late Reg live in the status chips, which ARE
       filters and are counted as narrowing by `narrowing.filtered`. */
    expect(src).toMatch(/open_reg|late_reg/);
  });
});

describe('list caps are visible, never silently wrong', () => {
  it('reports the total as a floor when a query came back full', () => {
    expect(src).toMatch(/countsCapped/);
    // Rendered next to the total, not swallowed.
    expect(src).toMatch(/countsCapped \? '\+' : ''/);
  });

  it('caps every list query, not just the tables one', () => {
    const limits = src.match(/\.limit\(QUERY_LIMITS\.LIST\)/g) || [];
    // tables + tournaments.
    //
    // Was 3: tables, the club's tournaments, and a separate union/XMTT
    // tournament query. That third query is gone as of 2026-08-23 - one
    // applyClubScope call now returns union-owned games AND the club's private
    // ones in a single round trip, the same shape the table query already
    // used. Two queries meant two failure modes, and the one that mattered
    // (the union query timing out) emptied every tournament tab while the
    // club query quietly succeeded with nothing.
    expect(limits.length).toBeGreaterThanOrEqual(2);
  });
});

describe('the fetch and the realtime admission rule agree', () => {
  it('excludes the same dead statuses on both paths', () => {
    // belongsInTableList drops 'closed' AND 'deleted'; so must the query.
    expect(src).toMatch(/\.not\('status',\s*'in',\s*'\("closed","deleted"\)'\)/);
  });

  /**
   * WHY THIS SECOND ASSERTION EXISTS.
   *
   * On 2026-08-23 this file asserted the ARRAY form, because the commit that
   * introduced the array also edited the test to match it ("test: fix regex to
   * match actual source code"). The array is not a filter PostgREST can read:
   * `.not(col, 'in', value)` interpolates the value into `not.in.<value>`, so
   * `['closed','deleted']` becomes `not.in.closed,deleted` and the request
   * comes back 400 PGRST100. The cash list was null on EVERY club lobby load
   * for hours, and the green test said the query was right.
   *
   * So the rule is now stated twice: the group form must be present, and the
   * array form must be absent anywhere in the file. A test may only be
   * relaxed to match the source when the source is the thing that is correct.
   */
  it('never passes a JS array where PostgREST wants a group', () => {
    expect(src).not.toMatch(/\.not\(\s*'[a-z_]+'\s*,\s*'in'\s*,\s*\[/);
  });
});
