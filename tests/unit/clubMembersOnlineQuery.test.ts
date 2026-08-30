/**
 * REGRESSION: "Online Now" undercounting on the Players tab.
 *
 * THIS HAS NOW BROKEN TWICE, FOR TWO DIFFERENT REASONS, AND THE SECOND ONE HID
 * BEHIND THE FIX FOR THE FIRST.
 *
 * 2026-08-19 - the count read 1 while ~133 members were seated. The lookup
 * filtered `tables` on `.eq('is_active', true)`; that column does not exist, so
 * PostgREST returned an error, and because supabase-js RETURNS errors rather
 * than throwing, the try/catch never fired and the seated set stayed empty.
 * Fixed by filtering on `status` and inspecting the error.
 *
 * 2026-08-23 - the count read 1 again, with 289 members seated. The repaired
 * query was correct and still returned nothing, because it asked the wrong
 * table. It looked for LIVE TABLES OWNED BY THIS CLUB: Club JAQK owns 34,138
 * table rows and every single one is closed, since the live tables belong to
 * Midway Union, the union above it. Zero tables came back, the function returned
 * before it ever reached the seats, and the count fell through to browser
 * presence: one, the person reading the screen.
 *
 * `table_seats.club_id` is the seat's HOME club and is the only row that knows a
 * player belongs to Club JAQK while sitting at a union table. The lookup now
 * starts from the seat and consults the table only for whether it is alive.
 *
 * WHERE THE INVARIANT LIVES NOW. In Postgres, inside
 * ca_club_members_overview - because the same question is asked by the roster,
 * by Member Management and by the union view, and three copies on the client is
 * how the two bugs above diverged in the first place. So these are assertions
 * against the migration SQL and against the page's use of the RPC, not against a
 * mocked client: both defects were shape mismatches that a mock accepting any
 * column would have happily passed.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'fs';
import { resolve } from 'path';

const PAGE = readFileSync(resolve(__dirname, '../../src/pages/ClubMembersPage.tsx'), 'utf8');
const CSS = readFileSync(resolve(__dirname, '../../src/pages/ClubMembersPage.css'), 'utf8');
/**
 * The stylesheet MINUS its comments.
 *
 * The palette assertions below are about what the browser paints, and a CSS
 * comment paints nothing. This matters concretely: ClubMembersPage.css opens
 * with a decision record naming the four colours that were REMOVED, so a naive
 * scan of the whole file finds the banned hexes in the very sentence explaining
 * that they are gone, and the test fails on its own documentation. Strip the
 * comments and the assertion means what it says.
 */
const CSS_RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');
const SERVICE = readFileSync(resolve(__dirname, '../../src/services/ClubRosterService.ts'), 'utf8');
const ROSTER_VAULT_ART = resolve(__dirname, '../../public/images/club-members/roster-vault.webp');
const MIGRATION = readFileSync(
  resolve(__dirname, '../../supabase/migrations/20260823_03_club_members_overview.sql'),
  'utf8'
);

/** Source with comment lines stripped - the comments deliberately name the bug. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    })
    .join('\n');
}

const PAGE_CODE = codeOnly(PAGE);

/** The CTE that decides who is online. */
const seatedBlock = MIGRATION.slice(
  MIGRATION.indexOf('seated AS ('),
  MIGRATION.indexOf('wal AS (')
);

describe('seated-online lookup (ca_club_members_overview)', () => {
  it('exists', () => {
    expect(seatedBlock.length).toBeGreaterThan(120);
    expect(seatedBlock).toContain('public.table_seats');
    expect(seatedBlock).toContain('public.tables');
  });

  it('never filters tables on the non-existent is_active column', () => {
    expect(MIGRATION).not.toContain('is_active');
    expect(PAGE_CODE).not.toContain('is_active');
  });

  it('filters tables by live status', () => {
    expect(seatedBlock).toMatch(/status\s+IN\s*\(\s*'waiting'\s*,\s*'running'\s*\)/i);
  });

  it('excludes closed tables so stale seats do not count as online', () => {
    expect(seatedBlock).not.toMatch(/'closed'/);
  });

  it('only counts seats that have not been left', () => {
    expect(seatedBlock).toMatch(/left_at\s+IS\s+NULL/i);
  });

  /**
   * The 2026-08-23 fix itself. Matching ONLY on tables.club_id is the bug: it
   * silently returns nothing for every club whose tables are owned by its union.
   */
  it('resolves membership from the seat, not only from the table', () => {
    expect(seatedBlock).toMatch(/ts\.club_id\s*=\s*ANY\(v_scope\)/);
    expect(seatedBlock).toMatch(/OR\s+t\.club_id\s*=\s*ANY\(v_scope\)/);
  });

  /** A union roster must reach every club beneath it, or the count undercounts again. */
  it('scopes through fn_club_scope_ids so a union sees all of its clubs', () => {
    expect(MIGRATION).toContain('fn_club_scope_ids');
    expect(MIGRATION).toMatch(/union_id\s*=\s*p_club_id/);
  });
});

describe('ClubMembersPage reads the roster from one RPC', () => {
  it('asks the service rather than assembling the roster itself', () => {
    expect(PAGE_CODE).toContain('ClubRosterService');
    expect(SERVICE).toContain('ca_club_members_overview');
  });

  /**
   * The five-round-trip assembly is what drifted out of step with the schema
   * twice. If any of it comes back to the page, so does the bug.
   */
  it('no longer queries tables or table_seats from the client', () => {
    expect(PAGE_CODE).not.toContain("from('tables')");
    expect(PAGE_CODE).not.toContain("from('table_seats')");
  });

  it('surfaces errors rather than swallowing them', () => {
    expect(SERVICE).toMatch(/if\s*\(error\)\s*throw error/);
  });
});

describe('ClubMembersPage horse anonymity', () => {
  it('exposes no horse flag, badge or filter to the client', () => {
    expect(PAGE_CODE).not.toContain('is_horse');
    expect(PAGE_CODE).not.toContain('HORSE');
    expect(PAGE_CODE).not.toMatch(/'horses'/);
  });
});

/**
 * Dan 2026-08-23: "remove the green and purple and use smarter.poker color
 * schemas." Locked here because a palette rule in a document is one paste away
 * from being undone, and these four values are the exact ones that were removed.
 */
describe('Players tab palette', () => {
  const BANNED = [
    '#10b981', // emerald, the old Online card and presence dot
    '#00c853', // the old Export CSV pill
    '#a855f7', // violet, the old Agents card
    '#38bdf8', // sky, the old sub-agent glyph
  ];

  it('contains no green or purple', () => {
    const css = CSS_RULES.toLowerCase();
    for (const hex of BANNED) expect(css).not.toContain(hex);
  });

  it('draws presence as a ring rather than a dot', () => {
    expect(CSS_RULES).toContain('.member-row--online .member-avatar');
    expect(CSS_RULES).not.toContain('.online-dot');
  });
});

describe('Players tab #smarterCasinoRealism presentation', () => {
  it('ships the purpose-built roster vault as an optimized local asset', () => {
    expect(existsSync(ROSTER_VAULT_ART)).toBe(true);
    expect(statSync(ROSTER_VAULT_ART).size).toBeLessThan(180_000);
    expect(PAGE).toContain('images/club-members/roster-vault.webp');
    expect(PAGE).toContain('fetchPriority="high"');
  });

  it('keeps the artwork decorative and the live roster data in HTML', () => {
    expect(PAGE).toContain('alt=""');
    expect(PAGE).toContain('Club Personnel Vault');
    expect(PAGE).toContain('members-summary');
  });

  it('does not put a blur compositor on every roster row', () => {
    expect(CSS_RULES).not.toContain('backdrop-filter');
    expect(CSS_RULES).toContain('content-visibility: auto');
  });
});

describe('Players tab large-roster performance and cache integrity', () => {
  it('defers expensive search filtering so typing stays responsive', () => {
    expect(PAGE_CODE).toContain('useDeferredValue(searchQuery)');
    expect(PAGE_CODE).toContain('deferredSearchQuery.trim()');
  });

  it('never presents a truncated roster cache as the complete club', () => {
    expect(PAGE_CODE).not.toMatch(/roster\.slice\(0,\s*300\)/);
    expect(PAGE_CODE).toContain('ROSTER_CACHE_MAX_CHARACTERS');
    expect(PAGE_CODE).toContain('sessionStorage.removeItem(swrKey)');
  });

  it('keeps export locked until the live roster replaces cached data', () => {
    expect(PAGE).toMatch(/className="members-export"[\s\S]*disabled=\{loading \|\| isRefreshing\}/);
  });
});

/**
 * The brief's numbered asks, pinned so a later refactor cannot quietly drop one.
 */
describe('Players tab shows what the brief asked for', () => {
  it('shows the player number beside the role', () => {
    expect(PAGE).toContain('member.player_number');
    expect(PAGE).toContain('member-number');
  });

  it('leads with the Club Arena alias and follows with the username', () => {
    expect(PAGE).toContain('member.alias');
    expect(PAGE).toContain('member.username');
  });

  it('carries downlines, both wallets and fees on every row', () => {
    expect(PAGE).toContain('member.downline_total');
    expect(PAGE).toContain('member.agent_wallet');
    expect(PAGE).toContain('member.player_wallet');
    expect(PAGE).toContain('member.total_fees');
  });

  it('offers every sort the brief listed, hierarchy first', () => {
    expect(PAGE).toMatch(
      /'hierarchy'\s*\|\s*'name'\s*\|\s*'downlines'\s*\|\s*'wallet'\s*\|\s*'fees'/
    );
    expect(PAGE).toContain("useState<SortKey>('hierarchy')");
  });

  it('title-cases the search placeholder rather than hard-coding it', () => {
    expect(PAGE).toMatch(/placeholder=\{titleCase\(/);
  });
});
