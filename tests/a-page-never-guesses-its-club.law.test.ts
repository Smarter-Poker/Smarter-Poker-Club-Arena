/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAW — A PAGE NEVER GUESSES WHICH CLUB IT IS ABOUT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The inbound half of Dan's 2026-09-02 rule. `the-menu-stays-in-the-club`
 * pins that every LINK carries its club; this pins that every PAGE which
 * receives one honours it, and that the fallback when it receives none is a
 * decision rather than an accident.
 *
 * Five pages each hand-rolled the same fallback and each copy was the same
 * bug:
 *
 *     .from('club_members').select('club_id')
 *     .eq('user_id', user.id)
 *     .limit(1).maybeSingle()
 *
 * `.limit(1)` with no `.order()` asks Postgres for A membership, not THE
 * membership. For a single-club player it looks right forever; for anyone in
 * two it returns whichever row the planner reaches first, and that can change
 * between page loads with no user action. On MarketplacePage it chose which
 * shop you saw; on FlashPoolPage it chose which club's chip balance you were
 * shown on a page where you spend them; on the agent dashboard it chose whose
 * commission book you opened.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');

/** Source with comments stripped — prose about the retired bug must not trip a pin. */
function code(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Every page that renders club-scoped data from a global route. */
const CLUB_CONTEXT_PAGES = [
  'src/pages/MarketplacePage.tsx',
  'src/pages/XMTTPage.tsx',
  'src/pages/AdminDashboardPage.tsx',
  'src/pages/AgentDashboardPage.tsx',
  'src/pages/FlashPoolPage.tsx',
];

describe('LAW: no page picks a club with an unordered limit(1)', () => {
  for (const page of CLUB_CONTEXT_PAGES) {
    it(`${page} does not take an arbitrary club_members row`, () => {
      const source = code(page);

      /* The precise shape of the bug: a club_members read narrowed to one row
         with no ordering. Reconstruct each query and check it. */
      const clubMemberQueries = source.split("from('club_members')").slice(1);
      for (const query of clubMemberQueries) {
        // Only the head of the chain belongs to this query.
        const chain = query.slice(0, 400);
        if (!chain.includes('limit(1)')) continue;
        expect(
          chain.includes("eq('club_id'") || chain.includes('order('),
          `${page}: a limit(1) club_members read must either name the club or order the rows`
        ).toBe(true);
      }
    });

    it(`${page} resolves its club through the shared resolver`, () => {
      expect(code(page)).toContain('resolvePageClubId');
    });
  }
});

describe('LAW: an explicit club in the URL is honoured, not merely noticed', () => {
  it('the resolver prefers the route path and the query param over any fallback', () => {
    /* Measured inside the FUNCTION BODY, not the file: `resolveTargetClub`
       also appears in the import block at the top, so a whole-file index
       comparison would compare a link against a step. */
    const resolver = code('src/utils/resolvePageClubId.ts');
    const body = resolver.slice(resolver.indexOf('export async function resolvePageClubId'));

    const explicit = body.indexOf('routeClubId || readClubContextParam');
    const fallback = body.indexOf('resolveTargetClub');
    expect(explicit, 'the explicit identifier must be read').toBeGreaterThan(-1);
    expect(fallback, 'the membership fallback must be read').toBeGreaterThan(-1);
    expect(fallback, 'the explicit identifier is consulted first').toBeGreaterThan(explicit);
  });

  it('refuses to pass on an identifier it could not resolve', () => {
    /* resolveClubUUID deliberately fails OPEN, returning its raw input, so a
       slug can reach a uuid column and raise 22P02 a long way from the cause.
       The resolver must check. */
    expect(code('src/utils/resolvePageClubId.ts')).toContain('isUUID(resolved)');
  });

  it('can be told not to fall back at all', () => {
    // Money-facing callers need "this exact club or nothing".
    expect(code('src/utils/resolvePageClubId.ts')).toContain('allowFallback');
  });
});

describe('LAW: a role-filtered fallback stays role-filtered, but stops being arbitrary', () => {
  for (const page of ['src/pages/AdminDashboardPage.tsx', 'src/pages/AgentDashboardPage.tsx']) {
    it(`${page} orders its staff-membership query`, () => {
      /* These pages query club_members more than once. The one this law is
         about is the role-filtered auto-discovery — the `.in('role', [...])`
         one — so find that query rather than the first that happens to
         appear. */
      const source = code(page);
      const roleFiltered = source
        .split("from('club_members')")
        .slice(1)
        .map((chunk) => chunk.slice(0, 600))
        /* Both conditions matter. `.in('role', ...)` alone also matches the
           member-roster query on these pages, which selects people rather
           than a club; the one this law governs is the CLUB-DISCOVERY query,
           and that is the one that selects `club_id`. */
        /* Both conditions matter. `.in('role', ...)` alone also matches the
           member-roster and agent-tree queries on these pages, which select
           PEOPLE within an already-known club. The query this law governs is
           the CLUB-DISCOVERY one — the only one that SELECTS `club_id`
           instead of filtering by it. */
        .filter((chunk) => chunk.includes(".in('role'") && chunk.includes(".select('club_id"));

      expect(roleFiltered.length, 'expected a role-filtered membership query').toBeGreaterThan(0);
      for (const query of roleFiltered) {
        expect(query, 'the staff-membership fallback must be ordered').toContain('order(');
      }
    });

    it(`${page} picks deterministically rather than taking mems[0]`, () => {
      const source = code(page);
      expect(source).toContain('pickPreferredClubId');
      expect(source).not.toMatch(/mems\[0\]\.club_id/);
    });
  }
});

describe('LAW: the per-club chip balance names its club', () => {
  it('FlashPoolPage filters the balance read by club_id', () => {
    /* `club_members.chip_balance` is PER CLUB. This page read it twice with
       limit(1) and no order, so a multi-club player saw an arbitrary club's
       chips on a page where those chips get spent — and the two copies could
       disagree with each other. */
    const source = code('src/pages/FlashPoolPage.tsx');
    const balanceRead = source.slice(source.indexOf("from('club_members')"));
    expect(balanceRead.slice(0, 400)).toContain("eq('club_id'");
  });
});
