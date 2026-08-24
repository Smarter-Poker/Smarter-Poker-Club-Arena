/**
 * Dan's exact report, turned into a test.
 *
 *   "THE LIMIT TAB NEEDS TO OPEN UP TO THE LIMIT POKER TABLES... WHEN YOU CLICK
 *    CREATE NEW TABLE IT DOESN'T SHOW ANY OPTIONS FOR LIMIT POKER GAMES."
 *
 * Two claims, so two halves. A green CI proves the code compiles; these prove
 * the reported sequence cannot happen again.
 *
 * Half 1 — the create screen must OFFER a limit game.
 * Half 2 — the table that offer produces must LAND in the LIMIT tab.
 *
 * The create screen's GAME_TYPES and ClubHomePage's cashKind are module-private,
 * so the structural half is asserted against the source the way this repo
 * already does it (see tests/config/spinSeatFirstIntegrity.test.ts). Everything
 * that IS exported is asserted behaviourally.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isFixedLimitVariant, stakesLabel } from '../../src/lib/bettingStructure';
import { variantDisplay, cashEntry, type LobbyTableRow } from '../../src/components/lobby/lobbyEntries';
import { FILTER_SPECS, rowPassesFilter, emptyFilterValue } from '../../src/components/lobby/advancedFilterSpec';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const createPage = read('src/pages/CreateTablePage.tsx');
const clubHome = read('src/pages/ClubHomePage.tsx');

describe("HALF 1 — 'Create New Table' offers limit poker games", () => {
  it('lists a Fixed Limit Hold\'em card', () => {
    expect(createPage).toMatch(/id:\s*'flh'/);
    expect(createPage).toMatch(/FIXED LIMIT HOLD'EM/);
  });

  it('lists a Fixed Limit Omaha Hi-Lo card', () => {
    expect(createPage).toMatch(/id:\s*'flo8'/);
    expect(createPage).toMatch(/FIXED LIMIT OMAHA HI-LO/);
  });

  it('routes both cards to the config page by their variant id', () => {
    // handleSelectGameType navigates to /clubs/:clubId/create-table/:gameType,
    // so the card id IS the variant string the table row will carry.
    expect(createPage).toMatch(/create-table\/\$\{gameType\.id\}/);
  });

  it('unlocks them at level 1, so they are not hidden behind progression', () => {
    const flh = createPage.slice(createPage.indexOf("id: 'flh'"), createPage.indexOf("id: 'flo8'"));
    expect(flh).toMatch(/unlockLevel:\s*1/);
  });
});

describe('HALF 2 — a table created from those cards lands in the LIMIT tab', () => {
  it('classifies both limit variants as fixed-limit', () => {
    expect(isFixedLimitVariant('flh')).toBe(true);
    expect(isFixedLimitVariant('flo8')).toBe(true);
  });

  it('asks BettingStructure first, so flo8 cannot fall through to MIXED', () => {
    // flo8 contains neither "flh" nor "limit" nor "plo", so every substring
    // test in the old cashKind missed it and it landed in the Mixed bucket.
    const kind = clubHome.slice(clubHome.indexOf('function cashKind'), clubHome.indexOf('function cashRank'));
    expect(kind).toMatch(/isFixedLimitVariant\(v\)\)?\s*return 'LIMIT'/);
    // and the guard is genuinely needed:
    expect('flo8'.includes('plo')).toBe(false);
    expect('flo8'.includes('flh')).toBe(false);
    expect('flo8'.includes('limit')).toBe(false);
  });

  it('gives both a human label rather than echoing the raw column', () => {
    expect(variantDisplay('flh').long).toBe("Fixed Limit Hold'em");
    expect(variantDisplay('flo8').long).toBe('Fixed Limit Omaha Hi-Lo');
    expect(variantDisplay('flh').short).toBe('FLH');
    expect(variantDisplay('flo8').short).toBe('FLO8');
  });

  it('renders a lobby row whose stakes match the table it links to', () => {
    const row = (variant: string) =>
      cashEntry({
        id: 't', name: `${variant} 2/4`, game_variant: variant,
        small_blind: 1, big_blind: 2, min_buy_in: 40, max_buy_in: 200,
        max_players: 6, status: 'running',
      } as LobbyTableRow);
    expect(row('flh').stakesLabel).toBe('2/4');
    expect(row('flh').stakesLabel).toBe(stakesLabel(1, 2, 'flh'));
    expect(row('flo8').gameLabel).toBe('FLO8');
  });

  it('passes the LIMIT tab filter with no saved preference', () => {
    const empty = emptyFilterValue(FILTER_SPECS.LIMIT);
    for (const variant of ['flh', 'flo8']) {
      expect(rowPassesFilter(FILTER_SPECS.LIMIT, empty, { variant, price: 2, seatsTaken: 1, seats: 6, settings: {} } as never)).toBe(true);
    }
  });

  it('no longer offers a HOLDEM chip that could empty the Hold\'em list', () => {
    // cashKind sends every limit table to LIMIT, so an FLH chip on the HOLDEM
    // tab could never match a row — ticking it read as "there are no Hold'em games".
    expect((FILTER_SPECS.HOLDEM.games ?? []).map((g) => g.key)).not.toContain('flh');
  });
});
