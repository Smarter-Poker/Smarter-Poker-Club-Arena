/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SCOPE RULE IS WRITTEN ONCE, AND THE TWO SHAPES OF IT AGREE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-23: "THIS CAN NEVER BREAK. ANY TIME THE UNION CREATES NEW
 * TABLES, THEY MUST BE DISPLAYED INSIDE THEIR ATTACHED CLUBS RIGHT AWAY."
 *
 * One sentence — "a union club sees the union's games plus its own private
 * ones" — was written SIX times, in three languages:
 *
 *   1/2. get_club_home's tables and tournaments clauses      (SQL)
 *   3.   the cash-table fetch                                (PostgREST .or)
 *   4.   the tournament fetch                                (two queries)
 *   5/6. belongsInTableList / belongsInTournamentList        (JS predicates)
 *
 * Copy 2 was found still missing its union branch: Shark Club and Club JAQK
 * each showed 43 tables and ZERO Spins, MTTs or heads-up games while the union
 * ran 90 joinable ones. The realtime rules even carried a comment saying they
 * "MUST mirror the fetch queries" — which is the whole disease. A rule that
 * six places must remember is a rule that drifts, and this one drifted twice.
 *
 * These tests fail if a seventh copy appears, or if the two surviving shapes
 * — the predicate realtime judges by and the filter the database is queried
 * with — ever stop agreeing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  inClubScope,
  clubScopeOrExpression,
  applyClubScope,
  type ClubScope,
} from '../../src/utils/clubScope';

const clubHome = readFileSync(resolve(__dirname, '../../src/pages/ClubHomePage.tsx'), 'utf8');
const code = clubHome.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const UNION = 'union-1';
const ME = 'club-me';
const OTHER = 'club-other';
const unionScope: ClubScope = { clubId: ME, unionId: UNION };
const soloScope: ClubScope = { clubId: ME, unionId: null };

describe('the rule itself', () => {
  it('a union club sees every union-owned game', () => {
    expect(inClubScope({ union_id: UNION, club_id: OTHER, is_private: false }, unionScope)).toBe(
      true
    );
  });

  it('...and its own private games', () => {
    expect(inClubScope({ union_id: null, club_id: ME, is_private: true }, unionScope)).toBe(true);
  });

  it('...but never another club’s private game', () => {
    expect(inClubScope({ union_id: null, club_id: OTHER, is_private: true }, unionScope)).toBe(
      false
    );
  });

  it('...and not a stray public game belonging to another club', () => {
    expect(inClubScope({ union_id: null, club_id: OTHER, is_private: false }, unionScope)).toBe(
      false
    );
  });

  it('a standalone club sees what it owns, and nothing of any union', () => {
    expect(inClubScope({ union_id: null, club_id: ME, is_private: false }, soloScope)).toBe(true);
    expect(inClubScope({ union_id: UNION, club_id: OTHER, is_private: false }, soloScope)).toBe(
      false
    );
  });

  it('never admits a null row', () => {
    expect(inClubScope(null, unionScope)).toBe(false);
    expect(inClubScope(undefined, unionScope)).toBe(false);
  });
});

describe('the two shapes cannot disagree', () => {
  /**
   * The filter string is what the DATABASE applies; the predicate is what
   * REALTIME applies. If they diverge, a row appears live and vanishes on
   * reload — or the reverse. This walks every combination and holds them to
   * the same answer.
   */
  it('the or-expression selects exactly the rows the predicate admits', () => {
    const expr = clubScopeOrExpression(unionScope);
    // The expression has exactly two disjuncts, matching the rule's two limbs.
    expect(expr).toBe(`union_id.eq.${UNION},and(club_id.eq.${ME},is_private.eq.true)`);

    const matchesExpr = (r: { union_id: string | null; club_id: string; is_private: boolean }) =>
      r.union_id === UNION || (r.club_id === ME && r.is_private === true);

    for (const union_id of [UNION, null]) {
      for (const club_id of [ME, OTHER]) {
        for (const is_private of [true, false]) {
          const row = { union_id, club_id, is_private };
          expect(
            inClubScope(row, unionScope),
            `predicate and filter disagree on ${JSON.stringify(row)}`
          ).toBe(matchesExpr(row));
        }
      }
    }
  });

  it('refuses to build a union filter for a standalone club', () => {
    expect(() => clubScopeOrExpression(soloScope)).toThrow();
  });

  it('applies the union shape as one or(), and the solo shape as in()', () => {
    const calls: string[] = [];
    const fake = {
      or(f: string) {
        calls.push(`or:${f}`);
        return fake;
      },
      in(c: string, v: readonly string[]) {
        calls.push(`in:${c}:${v.join('|')}`);
        return fake;
      },
    };
    applyClubScope(fake, unionScope);
    expect(calls).toEqual([`or:union_id.eq.${UNION},and(club_id.eq.${ME},is_private.eq.true)`]);

    calls.length = 0;
    applyClubScope(fake, { clubId: ME, unionId: null, siblingClubIds: [ME, OTHER] });
    expect(calls).toEqual([`in:club_id:${ME}|${OTHER}`]);
  });
});

describe('the lobby holds no seventh copy of the rule', () => {
  it('both fetches and both realtime rules go through the module', () => {
    expect(code).toMatch(/applyClubScope\(tableQuery/);
    expect(code).toMatch(/applyClubScope\(clubTournamentQuery/);
    expect((code.match(/inClubScope\(row, rtScope\)/g) ?? []).length).toBe(2);
  });

  it('no hand-written union scope survives anywhere in the page', () => {
    // The exact shapes that drifted before.
    expect(code).not.toMatch(/union_id\.eq\.\$\{unionId\}.*is_private\.eq\.true/);
    expect(code).not.toMatch(/row\.union_id === unionId/);
    expect(code).not.toMatch(/\.eq\('club_id', resolvedId\)\.eq\('is_private', true\)/);
  });

  it('tournaments are fetched in ONE query, the same shape as tables', () => {
    // Two queries meant two failure modes, and the one that mattered - the
    // union query timing out - emptied every tournament tab while the club
    // query quietly succeeded with nothing.
    expect(code).not.toMatch(/xmttResults/);
    expect(code).toMatch(
      /const \[tableResult, clubTournamentResult, bbjResult\] = await Promise\.all/
    );
  });
});

describe('a dropped socket cannot leave the lobby stale', () => {
  it('re-reads the lists when the channel comes back', () => {
    // Realtime gives no backlog on resubscribe: events fired during the gap
    // are gone, so the only way to see them is to ask again.
    expect(code).toMatch(/if \(firstSubscribe\)/);
    expect(code).toMatch(/void loadClubData\(\(\) => isMounted\)/);
  });

  it('does not double-fetch on the very first subscribe', () => {
    expect(code).toMatch(/firstSubscribe = false/);
  });

  it('still subscribes to BOTH the club and the union streams', () => {
    // Without the union filter no union row is ever delivered, and the
    // admission rule above never even runs.
    expect(code).toMatch(/filter: `club_id=eq\.\$\{resolvedId\}`/);
    expect(code).toMatch(/filter: `union_id=eq\.\$\{unionId\}`/);
  });
});
