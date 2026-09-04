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
import {
  variantDisplay,
  cashEntry,
  type LobbyTableRow,
} from '../../src/components/lobby/lobbyEntries';
import {
  FILTER_SPECS,
  rowPassesFilter,
  emptyFilterValue,
} from '../../src/components/lobby/advancedFilterSpec';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const createPage = read('src/pages/CreateTablePage.tsx');
const clubHome = read('src/pages/ClubHomePage.tsx');

describe("HALF 1 — 'Create New Table' offers limit poker games", () => {
  it("lists a Fixed Limit Hold'em card", () => {
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
    const kind = clubHome.slice(
      clubHome.indexOf('function cashKind'),
      clubHome.indexOf('function cashRank')
    );
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
        id: 't',
        name: `${variant} 2/4`,
        game_variant: variant,
        small_blind: 1,
        big_blind: 2,
        min_buy_in: 40,
        max_buy_in: 200,
        max_players: 6,
        status: 'running',
      } as LobbyTableRow);
    expect(row('flh').stakesLabel).toBe('2/4');
    expect(row('flh').stakesLabel).toBe(stakesLabel(1, 2, 'flh'));
    expect(row('flo8').gameLabel).toBe('FLO8');
  });

  it('passes the LIMIT tab filter with no saved preference', () => {
    const empty = emptyFilterValue(FILTER_SPECS.LIMIT);
    for (const variant of ['flh', 'flo8']) {
      expect(
        rowPassesFilter(FILTER_SPECS.LIMIT, empty, {
          variant,
          price: 2,
          seatsTaken: 1,
          seats: 6,
          settings: {},
        } as never)
      ).toBe(true);
    }
  });

  it("no longer offers a HOLDEM chip that could empty the Hold'em list", () => {
    // cashKind sends every limit table to LIMIT, so an FLH chip on the HOLDEM
    // tab could never match a row — ticking it read as "there are no Hold'em games".
    expect((FILTER_SPECS.HOLDEM.games ?? []).map((g) => g.key)).not.toContain('flh');
  });
});

describe('HALF 2b — the LIMIT tab can be sub-divided now that the keys exist', () => {
  it('offers exactly the two limit variants as chips', () => {
    // The row was withheld originally because "inventing sub-variant chips
    // risks hiding real tables behind keys variantKey has not learnt". Both
    // keys are learnt now, which is what makes the chips safe.
    expect((FILTER_SPECS.LIMIT.games ?? []).map((g) => g.key)).toEqual(['flh', 'flo8']);
  });

  it('shows a table when its own chip is ticked', () => {
    const spec = FILTER_SPECS.LIMIT;
    const pick = (games: string[]) => ({ ...emptyFilterValue(spec), games });
    const rowFor = (variant: string) =>
      ({ variant, price: 2, seatsTaken: 2, seats: 6, settings: {} }) as never;
    expect(rowPassesFilter(spec, pick(['flh']), rowFor('flh'))).toBe(true);
    expect(rowPassesFilter(spec, pick(['flo8']), rowFor('flo8'))).toBe(true);
  });

  it('hides the other limit variant when only one chip is ticked', () => {
    const spec = FILTER_SPECS.LIMIT;
    const pick = (games: string[]) => ({ ...emptyFilterValue(spec), games });
    const rowFor = (variant: string) =>
      ({ variant, price: 2, seatsTaken: 2, seats: 6, settings: {} }) as never;
    expect(rowPassesFilter(spec, pick(['flh']), rowFor('flo8'))).toBe(false);
    expect(rowPassesFilter(spec, pick(['flo8']), rowFor('flh'))).toBe(false);
  });

  it('does not hide the legacy spellings behind the new chips', () => {
    // Rows written before the variant union existed spell it limit_holdem /
    // limit_omaha. variantKey folds both into the same two keys, so a chip must
    // still match them — otherwise adding the chips HIDES real tables, which is
    // exactly what the original comment was afraid of.
    const spec = FILTER_SPECS.LIMIT;
    const pick = (games: string[]) => ({ ...emptyFilterValue(spec), games });
    const rowFor = (variant: string) =>
      ({ variant, price: 2, seatsTaken: 2, seats: 6, settings: {} }) as never;
    expect(rowPassesFilter(spec, pick(['flh']), rowFor('limit_holdem'))).toBe(true);
    expect(rowPassesFilter(spec, pick(['flo8']), rowFor('limit_omaha'))).toBe(true);
  });

  it('shows both when no chip is ticked', () => {
    const spec = FILTER_SPECS.LIMIT;
    const empty = emptyFilterValue(spec);
    for (const v of ['flh', 'flo8', 'limit_holdem', 'limit_omaha']) {
      expect(
        rowPassesFilter(spec, empty, {
          variant: v,
          price: 2,
          seatsTaken: 2,
          seats: 6,
          settings: {},
        } as never)
      ).toBe(true);
    }
  });
});

describe('the Pineapple control tracks whether the engine honours it', () => {
  /**
   * PIN DELIBERATELY REVERSED 2026-08-31 (CLAUDE.md rule 8).
   *
   * It read "no longer offers a Pineapple toggle on the config screen", and
   * its reason was stated in the body: "Nothing in server/src has ever read
   * `pineapple_holdem`". That was true when it was written on 2026-08-24. It
   * stopped being true on 2026-08-25, when #840 taught
   * ServerTableEngineBase.dealtGameVariant to deal a Hold'em table carrying
   * the flag as pineapple.
   *
   * So the pin outlived its reason by six days and then held a working
   * feature shut for a week: the engine deals it, BettingStructure has the
   * discard street, lobbyEntries badges it, and the only live cash-creation
   * path had no way to set it. Removing the control was right in a world
   * where nothing read the column; it is wrong in this one.
   */
  /**
   * 2026-09-04 (Operation Table Stakes, Slice 1): the toggle became a
   * VARIANT. The New Cash Game flow offers Pineapple as its own card
   * (game_variant = 'pineapple'), which ServerTableEngineBase.dealtGameVariant
   * deals outright, and fn_cash_game_create admits it by name. The
   * pineapple_holdem flag is no longer written by any create path, so it
   * cannot go stale on a PLO row.
   */
  it('offers it as a variant now that the engine deals it', () => {
    const vocab = read('src/config/cashGames.ts');
    expect(vocab).toMatch(/\{ id: 'pineapple', label: 'Pineapple', family: 'pineapple' \}/);
    const sql = read('supabase/migrations/20260904160500_cash_games_slice_1.sql');
    expect(sql).toMatch(
      /variant IN \('nlh','plo4','plo5','plo6','plo8','flo8','flh','short_deck','pineapple'\)/
    );
  });

  it('offers it only where dealtGameVariant will honour it', () => {
    // "Pineapple PLO is not a game and a stray flag must not silently turn a
    // PLO table into one" — ServerTableEngineBase. There is no flag now.
    const engine = read('server/src/engine/ServerTableEngineBase.ts');
    expect(engine).toContain("if (variant === 'pineapple') return 'pineapple';");
    const flow = read('src/components/cash/CashGameCreateFlow.tsx');
    expect(flow).not.toContain('pineapple_holdem');
    expect(read('src/pages/TableConfigPage.tsx')).not.toContain("updateConfig('pineappleHoldem'");
  });

  it('the engine still reads the column this switch writes', () => {
    const engine = read('server/src/engine/ServerTableEngineBase.ts');
    expect(engine).toContain('pineapple_holdem');
    expect(engine).toMatch(/variant === 'nlh' \|\| variant === 'nlhe'/);
  });

  it('still offers Pineapple where it actually works — the variant card', () => {
    expect(createPage).toMatch(/id:\s*'pineapple'/);
  });
});
