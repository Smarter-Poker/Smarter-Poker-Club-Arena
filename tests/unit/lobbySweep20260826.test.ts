/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LOBBY SWEEP, 2026-08-26 — every defect a line-by-line audit turned up
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan: "go through it all line by line, check for any bugs, stubs, gaps, errors,
 * regressions or wiring issues."
 *
 * Each block below is one finding. The comment says what a player saw; the
 * assertion is what stops it coming back. Where the defect was a column missing
 * from a SELECT, the test reads the select string itself — that class of bug is
 * invisible to every other kind of test, because the code compiles, the types
 * check, and the field is simply undefined at runtime.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  cashEntry,
  mttTitleLine,
  seatsTakenLabel,
  tournamentMedallions,
  type LobbyEntry,
  type LobbyTableRow,
  type LobbyTournamentRow,
} from '../../src/components/lobby/lobbyEntries';
import {
  rowPassesFilter,
  variantKey,
  FILTER_SPECS,
} from '../../src/components/lobby/advancedFilterSpec';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const CLUB_HOME = read('src/pages/ClubHomePage.tsx');
const TABLE_TSX = read('src/components/lobby/LobbyTable.tsx');
const TABLE_CSS = read('src/components/lobby/LobbyTable.css');
const PANEL = read('src/components/lobby/GameLobbyPanel.tsx');

/** Every `.select('...')` string in ClubHomePage, as one haystack per query. */
function selects(): string[] {
  return [...CLUB_HOME.matchAll(/\.select\(\s*'([^']+)'/g)].map((m) => m[1]);
}
const selectContaining = (needle: string) => selects().filter((s) => s.includes(needle));

// ─────────────────────────────────────────────────────────────────────────────
describe('a column the lobby READS is a column the query must SELECT', () => {
  /* The fast path (get_club_home) shipped these; the authoritative query that
     overwrites it 300ms later did not. So every badge and medallion painted on
     the first frame and then vanished, and a featured table jumped out of the
     pinned block at the same instant. */
  it('fetches every cash flag and medallion column lobbyEntries reads', () => {
    const cash = selectContaining('bomb_pot_enabled');
    expect(cash.length, 'the cash table select was not found').toBe(1);
    for (const col of [
      'is_featured',
      'is_vip_only',
      'label_as_new',
      'hide_club_name',
      'cap_enabled',
      'cap_bb',
      'no_rathole',
      'pineapple_holdem',
      'is_anonymous',
      'restrict_observers',
      'nit_game',
      'career_percent_min',
      'maintain_percent_min',
      'maintain_hands',
    ]) {
      expect(cash[0].includes(col), `cash select is missing ${col}`).toBe(true);
    }
  });

  it('fetches every tournament flag, on the club query and the union query alike', () => {
    const tourneys = selectContaining('guaranteed_prize');
    expect(tourneys.length, 'expected at least one tournament select').toBeGreaterThanOrEqual(1);
    for (const sel of tourneys) {
      for (const col of ['is_pinned', 'is_vip_only', 'label_as_new', 'hide_club_name']) {
        expect(sel.includes(col), `a tournament select is missing ${col}`).toBe(true);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a range sitting at its default is not a filter', () => {
  const spec = FILTER_SPECS.HOLDEM!;
  const atDefault = {
    games: [],
    statuses: [],
    mustHave: [],
    hide: [],
    format: [],
    selectedRanges: [],
    rangeMin: spec.range.min,
    rangeMax: spec.range.max,
    seatMin: spec.seats!.min,
    seatMax: spec.seats!.max,
  };

  it('keeps a table whose big blind is 0 or null when the slider was never touched', () => {
    /* Callers pass `Number(table.big_blind) || 0`, and 0 is below the slider's
       0.02 floor, so an untouched slider deleted every such row while the
       filter dot stayed dark and the empty state offered nothing to clear.
       Verbatim the Shark Club / Midway bug, fixed for seats and not for price. */
    expect(rowPassesFilter(spec, atDefault, { price: 0, seats: 6, variant: 'nlh' } as never)).toBe(
      true
    );
  });

  it('still narrows once the player actually moves the slider', () => {
    const moved = { ...atDefault, rangeMin: 1, rangeMax: 5 };
    expect(rowPassesFilter(spec, moved, { price: 0.5, seats: 6, variant: 'nlh' } as never)).toBe(
      false
    );
    expect(rowPassesFilter(spec, moved, { price: 2, seats: 6, variant: 'nlh' } as never)).toBe(
      true
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the board says what is true about a tournament', () => {
  const t = (over: Partial<LobbyTournamentRow> = {}): LobbyTournamentRow =>
    ({
      id: 't1',
      name: 'Sunday Special',
      game_type: 'NLH',
      buy_in_amount: 50,
      buy_in_fee: 5,
      guaranteed_prize: 0,
      start_time: new Date().toISOString(),
      status: 'REGISTERING',
      current_players: 4,
      max_players: 100,
      starting_chips: 10000,
      ...over,
    }) as LobbyTournamentRow;

  const keys = (row: LobbyTournamentRow) => tournamentMedallions(row).map((r) => r.key);

  it('reads is_pko, is_bounty and is_mystery_bounty instead of guessing from the title', () => {
    expect(keys(t({ is_pko: true }))).toContain('pko');
    expect(keys(t({ is_mystery_bounty: true }))).toContain('mystery');
    expect(keys(t({ is_bounty: true }))).toContain('bounty');
  });

  it('never calls a bounty event a freezeout', () => {
    /* The exact inversion: a PKO named "Sunday Special" carried FREEZEOUT,
       and with the Rules column gone the panel is the only place that says so. */
    for (const flag of ['is_pko', 'is_bounty', 'is_mystery_bounty'] as const) {
      expect(
        keys(t({ [flag]: true } as never)),
        `${flag} still reads as a freezeout`
      ).not.toContain('freezeout');
    }
  });

  it('still honours the name convention when no flag was set', () => {
    expect(keys(t({ name: 'Friday PKO Turbo' }))).toContain('pko');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the lobby says nothing rather than saying something false', () => {
  const cashRow = (over: Partial<LobbyTableRow> = {}): LobbyTableRow =>
    ({
      id: 'c1',
      name: 'Table One',
      game_variant: 'nlh',
      current_players: 3,
      max_players: 9,
      status: 'ACTIVE',
      small_blind: 1,
      big_blind: 2,
      ...over,
    }) as LobbyTableRow;

  it('does not print "0/0" for a table whose blinds are missing', () => {
    expect(cashEntry(cashRow({ small_blind: 0, big_blind: 0 })).stakesLabel).toBeNull();
  });

  it('does not print a nameless tournament as " (NLH)"', () => {
    const entry = { name: '', gameLabel: 'NLH' } as LobbyEntry;
    expect(mttTitleLine(entry)).toBe('NLH');
    expect(mttTitleLine(entry).startsWith(' ')).toBe(false);
  });

  it('formats both halves of the seat label the same way', () => {
    expect(seatsTakenLabel({ kind: 'mtt', players: 1234, capacity: 0 } as LobbyEntry)).toBe(
      '1,234'
    );
    expect(seatsTakenLabel({ kind: 'spin', players: 1234, capacity: 3 } as LobbyEntry)).toBe(
      '1,234/3'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a variant the database ships is a variant the lobby can name and filter', () => {
  it('normalises the OFC_PINEAPPLE enum tournaments actually store', () => {
    /* The retirement migration touched public.tables only, so tournaments still
       ship it. Without a key it printed as the raw enum, and the games filter
       deleted the row the moment any chip was ticked. */
    expect(variantKey('OFC_PINEAPPLE')).toBe('pineapple');
    expect(variantKey('pineapple')).toBe('pineapple');
  });

  it('offers a chip for it on every tab that can show one', () => {
    for (const tab of ['MTT', 'HOLDEM'] as const) {
      const games = (FILTER_SPECS[tab]?.games ?? []).map((g) => g.key);
      expect(games, `${tab} has no Pineapple chip`).toContain('pineapple');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the keyboard does one thing at a time', () => {
  it('ignores keys that started on a header, a star or an action button', () => {
    /* preventDefault in a child does not stop the bubble: Enter on a column
       header sorted the board AND navigated the player out of the lobby. */
    expect(TABLE_TSX).toContain('if (e.target !== e.currentTarget) return;');
  });

  it('persists the sort without depending on React running an updater eagerly', () => {
    const handler = TABLE_TSX.slice(
      TABLE_TSX.indexOf('const handleHeaderClick'),
      TABLE_TSX.indexOf('const handleKeyDown')
    );
    expect(handler).toContain('const prev = sort;');
    expect(handler).not.toContain('let committed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('what the board sorts is what the board shows', () => {
  it('sorts a cash row on its headline, not on the table name behind it', () => {
    const col = TABLE_TSX.slice(
      TABLE_TSX.indexOf('const COL_NAME'),
      TABLE_TSX.indexOf('const COL_TNAME')
    );
    expect(col).toContain('cashTitleLines(e).headline');
  });

  it('sorts Type on the word it prints', () => {
    const start = TABLE_TSX.indexOf('const COL_KIND');
    const col = TABLE_TSX.slice(start, TABLE_TSX.indexOf('const COL_', start + 20));
    expect(col).toContain('sortValue: (e) => kindLabel(e)');
    // ...and one helper produces the word, so the cell cannot drift from it.
    expect(TABLE_TSX).toContain('function kindLabel(');
  });

  it('sinks an empty Guarantee instead of floating it above every real one', () => {
    const col = TABLE_TSX.slice(
      TABLE_TSX.indexOf('const COL_GTD'),
      TABLE_TSX.indexOf('const COL_STARTS')
    );
    expect(col).toContain('Infinity');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('nothing is left that nothing can reach', () => {
  it('has no hideOnMobile flag, readers or stylesheet rule', () => {
    expect(TABLE_TSX).not.toContain('col.hideOnMobile');
    expect(TABLE_TSX).not.toContain('hideOnMobile?:');
    expect(TABLE_CSS).not.toMatch(/^\s*\.hide-on-mobile\s*\{/m);
  });

  it('does not fetch the Spin ladder for a board that cannot draw the badge', () => {
    expect(TABLE_TSX).toContain(
      "useSpinTierAvailability(category === 'SPIN' ? clubId : undefined)"
    );
  });

  it('silences the row animation for a player who asked for reduced motion', () => {
    /* Same selector, same specificity, and a media query adds none - so the
       block only wins if it is written after the animation it silences. */
    const reduce = TABLE_CSS.indexOf('@media (prefers-reduced-motion: reduce)');
    const anim = TABLE_CSS.indexOf('animation: rowFadeIn');
    expect(reduce).toBeGreaterThan(-1);
    expect(anim).toBeGreaterThan(-1);
    expect(reduce, 'the reduce block is still declared before the animation').toBeGreaterThan(anim);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the grid keeps its rows, and the panel keeps its tags', () => {
  it('names both row groups, which the card layout strips the implicit role from', () => {
    expect(TABLE_TSX).toContain('<thead role="rowgroup">');
    expect(TABLE_TSX).toContain('role="rowgroup"');
    expect(TABLE_TSX).toContain('<tbody ref={bodyRef} role="rowgroup">');
  });

  it('puts the active-descendant cursor on a role that honours it', () => {
    const wrap = TABLE_TSX.slice(
      TABLE_TSX.indexOf('className="lobby-table-wrap"'),
      TABLE_TSX.indexOf('<table className="lobby-table"')
    );
    expect(wrap).toContain('role="grid"');
    // the attribute, not the comment that records what it used to be
    expect(wrap).not.toMatch(/\n\s*role="region"/);
    expect(wrap).toContain('aria-activedescendant');
  });

  it('renders the rules on every tab, because no other surface carries them now', () => {
    const gate = PANEL.slice(
      PANEL.indexOf('entry.rules.length > 0'),
      PANEL.indexOf('entry.rules.length > 0') + 120
    );
    expect(gate).not.toContain("tab === 'overview'");
  });

  it('wires the tournament tabs to the panels they control', () => {
    for (const bit of [
      'aria-controls={`glp-panel-',
      'role="tabpanel"',
      'tabIndex={tab === t ? 0 : -1}',
    ]) {
      expect(PANEL, `tabs are missing ${bit}`).toContain(bit);
    }
  });

  it('says a fetch failed instead of loading forever', () => {
    expect(PANEL).toContain('The Structure Could Not Be Loaded');
    expect(PANEL).toContain('The Payouts Could Not Be Loaded');
  });

  it('does not report "Waiting 0" from a failed waitlist read', () => {
    expect(PANEL).toContain('waitlistError');
    expect(PANEL).toContain("{waitlistError ? '-' : waitlist.length}");
  });

  it('records the average-pot failure instead of swallowing it', () => {
    expect(PANEL).toContain("reportError(e, 'GameLobbyPanel.loadAveragePot')");
    expect(PANEL).not.toContain('.catch(() => undefined)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the page tells the truth when it has nothing to show', () => {
  it('does not claim nothing is running while Spins and running MTTs are one tab away', () => {
    expect(CLUB_HOME).toContain('Nothing On This Tab Right Now');
    expect(CLUB_HOME).toContain('Spins And Heads Up Have Their Own Tabs');
  });

  it('stops filtering by Favorites on the one tab that hides the Favorites control', () => {
    expect(CLUB_HOME).toContain("if (favoritesOnly && gameType !== 'ALL')");
  });

  it('does not toast a raw PostgREST sentence at a player', () => {
    expect(CLUB_HOME).not.toContain("toast.error(error.message || 'Failed to load club data')");
    expect(CLUB_HOME).toContain("toast.error('Failed to load club data')");
  });

  it('does not use browser storage to control club-level correctness', () => {
    expect(CLUB_HOME).not.toContain('levelRecomputeKey');
    expect(CLUB_HOME).not.toContain("rpc('recompute_club_levels'");
  });

  it('opens Filters and Create Game on a slug route the resolver never answered', () => {
    expect(CLUB_HOME).toContain('{filtersOpen && (resolvedClubId || club?.id) && (');
    expect(CLUB_HOME).toContain('{showCreateTournament && (resolvedClubId || club?.id) && (');
  });
});
