/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE LINE-BY-LINE SWEEP, PINNED
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25: "go through it all line by line, check for any bugs, stubs,
 * gaps, errors, regressions or wiring issues."
 *
 * A full read of the lobby surface found 53. The ones with a behavioural
 * consequence are fixed and pinned here. Two findings were NOT bugs and are
 * pinned as rules instead, so the next sweep does not "fix" them back:
 * the frozen "Starts In 0:00" (Dan re-pinned it on 2026-08-24) and the
 * Seven-Deuce Hold'em gate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  cashEntry,
  cashTitleLines,
  classifyTournament,
  formatChipTotal,
  lateRegEndMs,
  stackDepthBB,
  stackDepthLabel,
  stackFormatRank,
  tournamentEntry,
  tournamentStatus,
  type LobbyTableRow,
  type LobbyTournamentRow,
} from '../../src/components/lobby/lobbyEntries';
import { tournamentLevel } from '../../src/components/lobby/tournamentFigures';
import { cashBuyInLabel, cashBuyInRange } from '../../src/lib/cashBuyIn';
import { sliceStatement } from '../helpers/sourceWindow';
import {
  FILTER_SPECS,
  rowPassesFilter,
  emptyFilterValue,
} from '../../src/components/lobby/advancedFilterSpec';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const PANEL = read('src/components/lobby/GameLobbyPanel.tsx');
const TABLE = read('src/components/lobby/LobbyTable.tsx');
const CSS = read('src/components/lobby/LobbyTable.css');

const tRow = (o: Partial<LobbyTournamentRow> = {}): LobbyTournamentRow =>
  ({
    id: 't',
    name: 'Game',
    game_type: 'NLH',
    buy_in_amount: 10,
    buy_in_fee: 0,
    guaranteed_prize: 0,
    start_time: new Date().toISOString(),
    status: 'REGISTERING',
    current_players: 1,
    max_players: 100,
    starting_chips: 10000,
    ...o,
  }) as LobbyTournamentRow;

const cRow = (o: Partial<LobbyTableRow> = {}): LobbyTableRow => ({
  id: 'c',
  name: 'NLH 1/2',
  game_variant: 'nlh',
  small_blind: 1,
  big_blind: 2,
  min_buy_in: 80,
  max_buy_in: 400,
  current_players: 0,
  max_players: 6,
  status: 'active',
  ...o,
});

describe('current_level is a 0-based index', () => {
  it('adds the one, so the card is not a level behind', () => {
    // Verified on production: current_level 8 indexes an element whose own
    // `level` field reads 9.
    expect(tournamentLevel({ current_level: 8 })).toBe(9);
    expect(tournamentLevel({ current_level: 0 })).toBe(1);
    expect(tournamentLevel({ current_level: null })).toBe(1);
  });

  it('closes late reg on the index the engine closes it on', () => {
    // isInLateRegistration: open while `current_level < late_reg_levels`.
    // index 2 with a cap of 3 is the LAST open level, so only its remainder
    // is left — not a further whole level.
    const now = Date.now();
    const t = tRow({
      status: 'RUNNING',
      late_reg_mins: 0,
      late_reg_levels: 3,
      current_level: 2,
      level_started_at: new Date(now).toISOString(),
      started_at: new Date(now - 300000).toISOString(),
      blind_structure: JSON.stringify([
        { level: 1, durationMinutes: 4 },
        { level: 2, durationMinutes: 4 },
        { level: 3, durationMinutes: 3 },
      ]),
    });
    expect(lateRegEndMs(t)! - now).toBe(3 * 60000);
  });
});

describe('money is not rounded away', () => {
  it('prints a fractional total to the cent', () => {
    // Fees became fractional the same day: a 1-chip game is 0.90 + 0.10.
    expect(formatChipTotal(1.1)).toBe('1.10');
    expect(formatChipTotal(5.5)).toBe('5.50');
    expect(formatChipTotal(100)).toBe('100');
    expect(formatChipTotal(1000)).toBe('1,000');
  });

  it('a fee-bearing game still advertises its WHOLE price', () => {
    /* The fee is cut OUT of the total, so 0.90 + 0.10 is a 1-chip game and the
       card should say 1. This is the invariant splitBuyIn maintains, and it is
       why the old Math.round looked harmless. */
    const e = tournamentEntry(tRow({ buy_in_amount: 0.9, buy_in_fee: 0.1 }), 'mtt');
    expect(e.buyInLabel).toBe('1');
  });

  it('...but a total that really does carry cents is not rounded away', () => {
    /* ~9.8k pre-2026-08-20 rows are settled history carrying 19.8 / 5.5 / 13.5.
       Math.round printed 20 for a seat that cost 19.80. */
    const e = tournamentEntry(tRow({ buy_in_amount: 19.8, buy_in_fee: 0 }), 'mtt');
    expect(e.buyInLabel).toBe('19.80');
  });

  it('a row that cannot say a buy-in says so instead of saying zero', () => {
    expect(cashBuyInRange({ big_blind: 0 }).unknown).toBe(true);
    expect(cashBuyInLabel({ big_blind: 0 })).toBe('-');
  });
});

describe('a missing field cap is not a heads-up', () => {
  it('an unlimited MTT stays an MTT', () => {
    expect(classifyTournament(tRow({ variant: 'mtt', max_players: null } as never))).toBe('mtt');
    expect(classifyTournament(tRow({ name: 'Sunday Major', max_players: null } as never))).toBe(
      'mtt'
    );
  });
  it('a real small cap is still a heads-up', () => {
    expect(classifyTournament(tRow({ variant: 'sng', max_players: 2 }))).toBe('sng');
  });
});

describe('the statuses the query fetches all have a branch', () => {
  it('LATE_REG is late reg, not "Registering"', () => {
    expect(
      tournamentStatus(
        tRow({
          status: 'LATE_REG',
          variant: 'mtt',
          max_players: 500,
          late_reg_levels: 3,
          current_level: 1,
        })
      ).key
    ).toBe('late_reg');
  });
  it('a seat-first game in STARTING_SOON still reads its seats', () => {
    const st = tournamentStatus(
      tRow({ status: 'STARTING_SOON', variant: 'spin', max_players: 3, current_players: 2 })
    );
    expect(st.label).toBe('Filling');
  });
});

describe('the cash title strips every variant spelling', () => {
  const lines = (name: string, o: Partial<LobbyTableRow> = {}) =>
    cashTitleLines(cashEntry(cRow({ name, ...o })));

  it('handles 6+, which the word boundary could never match', () => {
    expect(lines('6+ 1/2 Deep', { game_variant: 'short_deck' }).subtitle).toBe('Deep');
  });
  it('handles the stakes coming first', () => {
    expect(lines('1/2 NLH Late Night').subtitle).toBe('Late Night');
  });
  it('handles a spelled-out variant', () => {
    expect(lines("No Limit Hold'em 1/2 Big One").subtitle).toBe('Big One');
  });
});

describe('Format sorts on the RENDERED bucket, not the alphabet and not raw depth', () => {
  /* ITEM E audit 2026-08-26: raw-depth sorting disagreed with the rendered
     word whenever the NAME carried a speed keyword ("Sunday Turbo" at 60bb
     rendered Turbo, sorted Deepstack). stackFormatRank derives the rank from
     stackDepthLabel itself, so the two cannot diverge. */
  it('gives a cash row Infinity so it sinks in both directions', () => {
    expect(stackDepthBB(cashEntry(cRow()))).toBe(0);
    expect(stackFormatRank(cashEntry(cRow()))).toBe(Infinity);
    const col = TABLE.slice(TABLE.indexOf('const COL_FORMAT'), TABLE.indexOf('const COL_ACTIONS'));
    expect(col).toContain('stackFormatRank');
  });
  it('the real MTT clock determines both its label and sort rank despite its name', () => {
    const named = tournamentEntry(
      tRow({
        name: 'Sunday Turbo Special',
        starting_chips: 6000,
        blind_structure: JSON.stringify([
          { level: 1, smallBlind: 50, bigBlind: 100, ante: 0, durationMinutes: 10 },
        ]),
      }),
      'mtt'
    ); // 60 BB and a Turbo name cannot relabel the actual ten-minute clock.
    expect(stackDepthLabel(named)).toBe('Regular');
    expect(stackFormatRank(named)).toBe(3);
  });
});

describe('the filter chips can all match something', () => {
  it('every cash chip names a column the lobby query selects', () => {
    const selected = read('src/pages/ClubHomePage.tsx');
    for (const f of FILTER_SPECS.HOLDEM.features) {
      for (const key of f.match) {
        expect(selected.includes(key), `${f.key} matches on ${key}, which is not selected`).toBe(
          true
        );
      }
    }
  });

  it('a Pineapple table survives ticking NLH', () => {
    const spec = FILTER_SPECS.HOLDEM;
    const v = { ...emptyFilterValue(spec), games: ['nlh', 'pineapple'] };
    const row = {
      variant: 'pineapple',
      price: 2,
      seats: 6,
      seatsTaken: 0,
      name: 'Pineapple 1/2',
      row: {},
      settings: {},
    };
    expect(rowPassesFilter(spec, v, row)).toBe(true);
  });

  it('Saturday is not a satellite', () => {
    const spec = FILTER_SPECS.SNG;
    const v = { ...emptyFilterValue(spec), format: ['regular'] };
    const sat = {
      variant: 'nlh',
      price: 5,
      seats: 2,
      seatsTaken: 0,
      name: 'Saturday Night Turbo',
      row: {},
      settings: {},
    };
    expect(rowPassesFilter(spec, v, sat)).toBe(true);
  });
});

describe('the panel no longer crashes on the Structure tab', () => {
  it('parses blind_structure instead of calling .map on a string', () => {
    // It is a TEXT column holding JSON; the Tournament type lies about it.
    expect(PANEL).toContain('parseBlindStructure');
    expect(PANEL).toContain('panelBlindLevels');
    expect(PANEL).not.toContain('tournament.blind_structure.map');
  });

  it('reads Ante from the column the card reads', () => {
    expect(PANEL).toContain('cashRaw?.ante_enabled === true');
  });

  it('never renders the literal "Invalid Date"', () => {
    expect(PANEL).toContain('Number.isFinite(new Date(entry.startTime).getTime())');
  });
});

describe('keyboard navigation does not navigate', () => {
  it('moves a cursor rather than selecting, because selecting can route away', () => {
    expect(TABLE).toContain('setKeyboardFocusId');
    expect(TABLE).toContain('aria-activedescendant');
    const handler = sliceStatement(TABLE, 'const handleKeyDown');
    expect(handler).not.toContain('onSelect(sorted[next])');
  });
});

describe('the player-state chip is visibly three states', () => {
  it('has exactly one .lt-mine definition', () => {
    // A second block at the same specificity, later in source, silently made
    // seated and waitlisted render identically.
    const defs = CSS.match(/^\.lt-mine \{/gm) ?? [];
    expect(defs.length).toBe(1);
  });
  // REPLACED 2026-08-28, in the commit that removed the behaviour it pinned.
  // This used to assert `.lt-row.is-mine:hover` existed, so that a row you are
  // seated at still lit up under the pointer like every other row. Dan then
  // removed hover from the lobby outright: "REMOVE ANY AND ALL HOVER EFFECT
  // FROM THE ALL, MTT, NLH, PLO, LIMIT, SPINS, AND HEADS UP LOBBY PAGES."
  //
  // The original worry has not gone away, it has changed shape. It was never
  // really about hover; it was that a seated row must not end up looking
  // DIFFERENT from its neighbours by accident. So the assertion now pins the
  // rule that actually matters after the removal: no row in the lobby has a
  // hover state, seated or not, and the seated row is therefore still exactly
  // as consistent with its neighbours as the day this test was written.
  it('has no hover state on any lobby row, seated or not', () => {
    const withoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments).not.toContain(':hover');
  });
  it('gives the primary action a 44px target', () => {
    expect(CSS).toMatch(/\.lt-act \{[^}]*min-height: 44px/);
  });
});
