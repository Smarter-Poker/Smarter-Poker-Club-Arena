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
 *
 * TWO KINDS OF PIN HERE, deliberately. The pages are pinned by their source,
 * bounded by the statement each query is (tests/helpers/sourceWindow) and
 * never by a byte count. The resolver is a pure `src/utils` module, so it is
 * IMPORTED and exercised: its order of preference is asserted by calling it,
 * not by comparing the offsets of two identifiers in its text.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blankNonCode } from './helpers/sourceWindow';

vi.mock('../src/utils/clubIdResolver', () => ({
  isUUID: (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  resolveClubUUID: vi.fn(),
}));

vi.mock('../src/utils/clubQuickLink', () => ({
  fetchQuickLinkClubs: vi.fn(),
  readCachedQuickLinkClubs: vi.fn(),
  readLastClubId: vi.fn(),
  resolveTargetClub: vi.fn(),
}));

import { resolveClubUUID } from '../src/utils/clubIdResolver';
import {
  fetchQuickLinkClubs,
  readCachedQuickLinkClubs,
  readLastClubId,
  resolveTargetClub,
} from '../src/utils/clubQuickLink';
import {
  hasUnresolvableClubParam,
  pickPreferredClubId,
  resolvePageClubId,
} from '../src/utils/resolvePageClubId';

const root = join(__dirname, '..');

const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

/**
 * Every statement in `src` that contains `anchor` in CODE, each bounded by the
 * statement it belongs to: from the anchor forward to the first `;` at bracket
 * depth zero. A Supabase query chain is one statement, so the window grows
 * exactly as fast as the chain does and can never be outrun by it.
 *
 * The anchor here is a string literal (`from('club_members')`), which
 * `blankNonCode` erases, so occurrences are located in the raw source and only
 * the bracket walk uses the blanked copy. A mention inside a comment would
 * yield a window of prose that no pin below can match, so it cannot produce a
 * false pass either way.
 */
function statementsContaining(src: string, anchor: string): string[] {
  const cleaned = blankNonCode(src);
  const out: string[] = [];
  let at = src.indexOf(anchor);
  while (at >= 0) {
    let depth = 0;
    let end = cleaned.length;
    for (let i = at; i < cleaned.length; i++) {
      const c = cleaned[i];
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') depth--;
      else if (c === ';' && depth <= 0) {
        end = i + 1;
        break;
      }
    }
    out.push(src.slice(at, end));
    at = src.indexOf(anchor, end);
  }
  return out;
}

/** Every page that renders club-scoped data from a global route. */
const CLUB_CONTEXT_PAGES = [
  'src/pages/MarketplacePage.tsx',
  'src/pages/XMTTPage.tsx',
  'src/pages/AdminDashboardPage.tsx',
  'src/pages/AgentDashboardPage.tsx',
  'src/pages/FlashPoolPage.tsx',
];

/**
 * Pages that route their fallback through the shared resolver. Marketplace is
 * deliberately NOT here: a 2026-09-04 fix (Dan hit the bug himself - Deep
 * Stack Society with zero items while Shark Club had twelve on sale) gave it
 * a BETTER fallback than the generic one - the club you are inside, then the
 * club with the most active stock, then any membership. That is
 * deterministic and page-aware, so this law holds Marketplace to the OUTCOME
 * (no arbitrary row, above) and not to a particular helper. Do not "unify" it
 * onto the resolver; you would be trading a smarter answer for a tidier one.
 */
const RESOLVER_PAGES = CLUB_CONTEXT_PAGES.filter((p) => !p.endsWith('MarketplacePage.tsx'));

const CLUB_MEMBERS = "from('club_members')";

describe('LAW: no page picks a club with an unordered limit(1)', () => {
  for (const page of CLUB_CONTEXT_PAGES) {
    it(`${page} does not take an arbitrary club_members row`, () => {
      /* The precise shape of the bug: a club_members read narrowed to one row
         with no ordering. Each query is one statement; check each. */
      for (const chain of statementsContaining(read(page), CLUB_MEMBERS)) {
        if (!chain.includes('limit(1)')) continue;
        expect(
          chain.includes("eq('club_id'") || chain.includes('order('),
          `${page}: a limit(1) club_members read must either name the club or order the rows`
        ).toBe(true);
      }
    });
  }

  for (const page of RESOLVER_PAGES) {
    it(`${page} resolves its club through the shared resolver`, () => {
      expect(blankNonCode(read(page))).toContain('resolvePageClubId');
    });
  }
});

describe('LAW: an explicit club in the URL is honoured, not merely noticed', () => {
  const UUID_A = '11111111-1111-4111-8111-111111111111';
  const UUID_B = '22222222-2222-4222-8222-222222222222';
  const UUID_LAST = '33333333-3333-4333-8333-333333333333';

  beforeEach(() => {
    vi.mocked(resolveClubUUID).mockReset();
    vi.mocked(fetchQuickLinkClubs).mockReset();
    vi.mocked(readCachedQuickLinkClubs).mockReset();
    vi.mocked(readLastClubId).mockReset();
    vi.mocked(resolveTargetClub).mockReset();
    // The membership fallback, when consulted, always has an answer, so any
    // test below that expects the explicit identifier is proving PRECEDENCE.
    vi.mocked(readCachedQuickLinkClubs).mockReturnValue([{ id: UUID_LAST }] as never);
    vi.mocked(resolveTargetClub).mockReturnValue({ id: UUID_LAST } as never);
    vi.mocked(fetchQuickLinkClubs).mockResolvedValue([{ id: UUID_LAST }] as never);
    // resolveClubUUID fails OPEN by contract: a UUID comes back as itself,
    // anything else comes back unchanged unless a test says otherwise.
    vi.mocked(resolveClubUUID).mockImplementation(async (v: string) => v);
  });

  it('the route path outranks everything, including a fallback that has an answer', async () => {
    await expect(
      resolvePageClubId({ routeClubId: UUID_A, search: `?club=${UUID_B}`, userId: 'u1' })
    ).resolves.toBe(UUID_A);
    expect(resolveTargetClub).not.toHaveBeenCalled();
    expect(fetchQuickLinkClubs).not.toHaveBeenCalled();
  });

  it('the ?club= param outranks the membership fallback', async () => {
    await expect(resolvePageClubId({ search: `?club=${UUID_B}`, userId: 'u1' })).resolves.toBe(
      UUID_B
    );
    expect(resolveTargetClub).not.toHaveBeenCalled();
  });

  it('a slug in the URL is resolved to its UUID before it reaches a query', async () => {
    vi.mocked(resolveClubUUID).mockImplementation(async (v: string) =>
      v === 'deep-stack-society' ? UUID_A : v
    );
    await expect(
      resolvePageClubId({ search: '?club=deep-stack-society', userId: 'u1' })
    ).resolves.toBe(UUID_A);
    expect(resolveClubUUID).toHaveBeenCalledWith('deep-stack-society');
  });

  it('refuses to pass on an identifier it could not resolve', async () => {
    /* resolveClubUUID deliberately fails OPEN, returning its raw input, so a
       slug can reach a uuid column and raise 22P02 a long way from the cause.
       The resolver must check, and must never hand the raw slug on. */
    const resolved = await resolvePageClubId({ search: '?club=no-such-club', userId: 'u1' });
    expect(resolved).not.toBe('no-such-club');
    // With the fallback allowed, a bad link degrades to the membership rule.
    expect(resolved).toBe(UUID_LAST);
  });

  it('can be told not to fall back at all', async () => {
    // Money-facing callers need "this exact club or nothing".
    await expect(
      resolvePageClubId({ search: '?club=no-such-club', userId: 'u1', allowFallback: false })
    ).resolves.toBeNull();
    await expect(resolvePageClubId({ userId: 'u1', allowFallback: false })).resolves.toBeNull();
    expect(resolveTargetClub).not.toHaveBeenCalled();
    expect(fetchQuickLinkClubs).not.toHaveBeenCalled();
  });

  it('with no identifier and no user it answers null, never a guess', async () => {
    await expect(resolvePageClubId({})).resolves.toBeNull();
    expect(fetchQuickLinkClubs).not.toHaveBeenCalled();
  });

  it('with no identifier it uses the shared last-visited rule, cached before fetched', async () => {
    await expect(resolvePageClubId({ userId: 'u1' })).resolves.toBe(UUID_LAST);
    expect(fetchQuickLinkClubs).not.toHaveBeenCalled();

    vi.mocked(readCachedQuickLinkClubs).mockReturnValue([] as never);
    vi.mocked(resolveTargetClub).mockReturnValueOnce(null as never);
    await expect(resolvePageClubId({ userId: 'u1' })).resolves.toBe(UUID_LAST);
    expect(fetchQuickLinkClubs).toHaveBeenCalledWith('u1');
  });

  it('tells a bad link apart from no link', () => {
    expect(hasUnresolvableClubParam('?club=no-such-club', null)).toBe(true);
    expect(hasUnresolvableClubParam('?club=no-such-club', UUID_A)).toBe(false);
    expect(hasUnresolvableClubParam('', null)).toBe(false);
    expect(hasUnresolvableClubParam(null, null)).toBe(false);
  });
});

describe('LAW: a role-filtered fallback stays role-filtered, but stops being arbitrary', () => {
  for (const page of ['src/pages/AdminDashboardPage.tsx', 'src/pages/AgentDashboardPage.tsx']) {
    it(`${page} orders its staff-membership query`, () => {
      /* These pages query club_members more than once. The one this law is
         about is the role-filtered auto-discovery - the `.in('role', [...])`
         one - so find that query rather than the first that happens to
         appear. Both conditions matter: `.in('role', ...)` alone also matches
         the member-roster and agent-tree queries on these pages, which select
         PEOPLE within an already-known club. The query this law governs is
         the CLUB-DISCOVERY one - the only one that SELECTS `club_id` instead
         of filtering by it. */
      const roleFiltered = statementsContaining(read(page), CLUB_MEMBERS).filter(
        (chain) => chain.includes(".in('role'") && chain.includes(".select('club_id")
      );

      expect(roleFiltered.length, 'expected a role-filtered membership query').toBeGreaterThan(0);
      for (const query of roleFiltered) {
        expect(query, 'the staff-membership fallback must be ordered').toContain('order(');
      }
    });

    it(`${page} picks deterministically rather than taking mems[0]`, () => {
      const source = blankNonCode(read(page));
      expect(source).toContain('pickPreferredClubId');
      expect(source).not.toMatch(/mems\[0\]\.club_id/);
    });
  }

  it('pickPreferredClubId prefers the club last visited, else the first of the caller order', () => {
    vi.mocked(readLastClubId).mockReturnValue('b');
    expect(pickPreferredClubId(['a', 'b', 'c'])).toBe('b');
    vi.mocked(readLastClubId).mockReturnValue('zzz');
    expect(pickPreferredClubId(['a', 'b', 'c'])).toBe('a');
    vi.mocked(readLastClubId).mockReturnValue(null);
    expect(pickPreferredClubId([null, undefined, 'c'])).toBe('c');
    expect(pickPreferredClubId([])).toBeNull();
  });
});

describe('LAW: the per-club chip balance names its club', () => {
  it('FlashPoolPage filters every balance read by club_id', () => {
    /* `club_members.chip_balance` is PER CLUB. This page read it twice with
       limit(1) and no order, so a multi-club player saw an arbitrary club's
       chips on a page where those chips get spent - and the two copies could
       disagree with each other. */
    const reads = statementsContaining(read('src/pages/FlashPoolPage.tsx'), CLUB_MEMBERS);
    expect(reads.length, 'expected the chip-balance read').toBeGreaterThan(0);
    for (const chain of reads) expect(chain).toContain("eq('club_id'");
  });
});
