/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  COMMUNITY SEARCH OWNS ITS CLASSES, AND ITS NUMBERS ARE MEASURED — LAW
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-04, on /search?q=MIDWAY: "BUTTONS ARE COVERED, AND THE BUTTONS
 * ON THE PAGE DON'T WORK ... ITS DISPLAYING MIDWAY UNION WITH ONLY 328 MEMBERS,
 * INSTEAD OF THE REAL TOTAL, ITS NOT PULLING REAL CLUB IMAGES ... LIVE INDESES
 * DEAD, CURRET SCOPE DEAD".
 *
 * Every pin below is one of those, as it actually shipped:
 *
 *   1. The page's stylesheet used GLOBAL class names. `components/common/
 *      Search.css` - loaded by the header on every page - also defines
 *      `.search-results { position: absolute; top: 100% }` and
 *      `.search-clear { width: 20px }`. The result list left the panel and
 *      landed under the footer; the Clear button was clipped to twenty pixels
 *      under Search. A page stylesheet is a CSS module here, full stop.
 *   2. A union's member count was read from the union HOUSE row's stale
 *      `member_count` column (328) instead of every club's members added up
 *      (1,177), which is the rule Dan set on 2026-08-24 and which the union
 *      lobby already follows. The server computes it now, through the same
 *      RPC the lobby uses, and this page never reads `clubs.member_count`.
 *   3. Club images were read from `avatar_url` only. Logos live in `logo_url`.
 *      The server resolves the image; the page never picks a column.
 *   4. Players were searched with a raw `ilike` on profiles, bypassing
 *      `fn_search_players` and the discoverable / privacy preferences it
 *      enforces. Two owners of one rule is the bug shape 10.5 warns about.
 *   5. "Live Indexes" was the literal number 4. It is measured now.
 *
 * If a pin goes red you are re-shipping one of those. Fix the change.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const PAGE = read('src/pages/SearchPage.tsx');
const MODULE = read('src/pages/SearchPage.module.css');
const HEADER_SEARCH_CSS = read('src/components/common/Search.css');

/** Class selectors a stylesheet declares at top level, e.g. `.search-results`. */
function declaredClasses(css: string): Set<string> {
  const out = new Set<string>();
  // Comments explain the collision by name; only selectors count.
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of code.matchAll(/(?:^|[\s,}])\.([a-zA-Z_][\w-]*)/g)) out.add(match[1]);
  return out;
}

describe('the search page owns its classes', () => {
  it('styles itself through a CSS module, never a global stylesheet', () => {
    expect(PAGE).toContain("import styles from './SearchPage.module.css'");
    expect(PAGE).not.toMatch(/import '\.\/SearchPage\.css'/);
    expect(existsSync(resolve(process.cwd(), 'src/pages/SearchPage.css'))).toBe(false);
  });

  it('shares no class name with the header search stylesheet that used to cover it', () => {
    const headerClasses = declaredClasses(HEADER_SEARCH_CSS);
    // The two that actually broke the page, named so the failure reads.
    expect(headerClasses.has('search-results')).toBe(true);
    expect(headerClasses.has('search-clear')).toBe(true);
    const overlap = [...declaredClasses(MODULE)].filter((name) => headerClasses.has(name));
    expect(overlap).toEqual([]);
  });

  it('never hand-writes a global class onto a result element', () => {
    expect(PAGE).not.toMatch(/className="search-/);
    expect(PAGE).not.toMatch(/className=\{`search-/);
  });
});

describe('the numbers on the page are measured, not assumed', () => {
  it('reads clubs, tables and tournaments from fn_community_search only', () => {
    expect(PAGE).toContain("supabase.rpc('fn_community_search'");
    expect(PAGE).not.toContain(".from('clubs')");
    expect(PAGE).not.toContain(".from('tables')");
    expect(PAGE).not.toContain(".from('tournaments')");
    expect(PAGE).not.toContain(".from('profiles')");
    // The stale column and the wrong image column never reach this page.
    expect(PAGE).not.toContain('club.member_count ||');
    expect(PAGE).not.toContain('avatar_url:arena_avatar_url');
  });

  it('searches players through fn_search_players, which owns fuzzy matching and privacy', () => {
    expect(PAGE).toContain('PlayerSearchService.search({');
    expect(PAGE).not.toMatch(/\.ilike\(/);
    expect(PAGE).not.toMatch(/username\.ilike/);
  });

  it('measures Live Indexes from which indexes answered, never a literal', () => {
    expect(PAGE).not.toMatch(/label: 'Live Indexes',\s*value: 4/);
    expect(PAGE).toContain("indexStatus[key] === 'live'");
    expect(PAGE).toContain("indexStatus[key] === 'failed'");
    expect(PAGE).toContain('index_health');
  });

  it('shows a union as a union and its members as the whole union', () => {
    expect(PAGE).toContain('club.is_union');
    expect(PAGE).toContain('formatCount(club.member_count)');
  });

  it('revalidates table access at click time rather than trusting the search row', () => {
    expect(PAGE).toContain('PlayerSearchService.getTableWatchAccess(table.id)');
  });
});

describe('the server rule behind the page', () => {
  const MIGRATION = read(
    'supabase/migrations/20260905040000_community_search_is_one_ranked_union_aware_index.sql'
  );

  it('sums a union from its clubs and resolves the logo column', () => {
    expect(MIGRATION).toContain('fn_batch_union_realtime_member_counts(ARRAY[r.id])');
    expect(MIGRATION).toContain('fn_batch_club_realtime_member_counts(ARRAY[r.id])');
    expect(MIGRATION).toContain(
      "coalesce(nullif(p.logo_url, ''), nullif(p.avatar_url, ''), nullif(p.logo, ''))"
    );
  });

  it('is one transaction, fuzzy through pg_trgm, and authenticated only', () => {
    expect(MIGRATION.trim().startsWith('-- =')).toBe(true);
    expect(MIGRATION).toContain('\nBEGIN;\n');
    expect(MIGRATION.trim().endsWith('COMMIT;')).toBe(true);
    expect(MIGRATION).toContain('word_similarity(t, h)');
    expect(MIGRATION).toContain("RAISE EXCEPTION 'Authentication required'");
    expect(MIGRATION).toContain('FROM public, anon');
  });

  it('re-applies the table and tournament visibility rules a SECURITY DEFINER bypasses', () => {
    expect(MIGRATION).toContain('public.is_club_member(t.club_id, v_uid)');
    expect(MIGRATION).toContain('public.fn_union_oversees_club(t.club_id, v_uid)');
    expect(MIGRATION).toContain("t.status IN ('ANNOUNCED', 'REGISTERING', 'RUNNING')");
  });
});
