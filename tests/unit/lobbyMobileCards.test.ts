/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE PHONE LOBBY CARD — nothing clipped, nothing invented, nothing hidden
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-25, with six photographs:
 *   1. "the mtt cards are cut off in the middle, it doesn't show all the
 *      'details' of the MTT like freezeout Deepstack ... all attributes must be
 *      shown, the cards need to dynamically expand to show them all."
 *   2. "for MTT the 'current level' is cut off ... it looks like we have two
 *      different cards, one for 'all field' and one for 'MTT' field ...
 *      optimize this one and use it for both fields."
 *   3. "for No Limit, the 2nd line below the game type and stakes is for the
 *      table name, make sure it doesn't get cut off by the other fields, the
 *      min and max buy in's are wrong, almost all of them say you can buy in
 *      for more then whats actually allowed at the table ... you need to add
 *      any special table features like vpip, insurance, run it twice, rathole."
 *   4. Same, for PLO.
 *   5. "for spins, it needs to show the 'max payout' 'Win Up To 100x' ... the
 *      game type, deep stack or turbo, and the default starting stacks ... the
 *      level times to '3 Min Levels' and the amount of players registered.
 *      0/3, 1/3, 2/3 3/3. once a spin is running, it must show the status as
 *      running, where users can click and watch."
 *   6. "Heads Up, needs to have the amount of players registered 0/2, 1/2,
 *      2/2 ... the type, turbo or deep stack ... the starting stack and blind
 *      speed."
 *   7. "if a player is 'already at a table' it should say that on the lobby
 *      card, or it should be outlined."
 *
 * The clipping (1, 2, and half of 3 and 4) was ONE line of CSS, so one of the
 * assertions here is against the stylesheet: a card that grew back to 36px
 * would fail every visual promise above and no unit test of a pure function
 * would notice.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  cashEntry,
  cashTitleLines,
  levelRemainingMs,
  levelSpeedLabel,
  seatFirstJoinable,
  seatsTakenLabel,
  spinPayoutLabel,
  spinPrizeLabel,
  stackDepthLabel,
  tournamentEntry,
  tournamentStatus,
  SPIN_MAX_MULTIPLIER,
  type LobbyTableRow,
  type LobbyTournamentRow,
} from '../../src/components/lobby/lobbyEntries';
import { cashBuyInLabel, cashBuyInRange } from '../../src/lib/cashBuyIn';
import { FILTER_SPECS, variantKey } from '../../src/components/lobby/advancedFilterSpec';
import { blindLevelMinutes } from '../../src/components/lobby/tournamentFigures';

const CSS = readFileSync(resolve(__dirname, '../../src/components/lobby/LobbyTable.css'), 'utf8');
const TSX = readFileSync(resolve(__dirname, '../../src/components/lobby/LobbyTable.tsx'), 'utf8');
const PLAYER_STATE_SOURCE = readFileSync(
  resolve(__dirname, '../../src/components/lobby/lobbyCardContext.ts'),
  'utf8'
);

/** The phone card block, so an assertion cannot accidentally match a desktop rule. */
const PHONE_BLOCK = (() => {
  /* 900, not 640, since 2026-08-25: the card is the layout for phones AND
     tablets. The band above it used to run a stripped table that had shed
     Payout, Starting Stack and Level Time on the way down and never got them
     back — strictly less than the phone showed. */
  const start = CSS.indexOf('@media (max-width: 900px)');
  expect(start).toBeGreaterThan(-1);
  const end = CSS.indexOf('@media (max-width: 380px)');
  expect(end).toBeGreaterThan(start);
  return CSS.slice(start, end);
})();

function tableRow(overrides: Partial<LobbyTableRow> = {}): LobbyTableRow {
  return {
    id: 't1',
    name: 'NLH 10/25',
    game_variant: 'nlh',
    small_blind: 10,
    big_blind: 25,
    min_buy_in: 1000,
    max_buy_in: 5000,
    current_players: 4,
    max_players: 6,
    status: 'active',
    ...overrides,
  };
}

function tournRow(overrides: Partial<LobbyTournamentRow> = {}): LobbyTournamentRow {
  return {
    id: 'g1',
    name: '10 Chip Spin NLH',
    game_type: 'NLH',
    buy_in_amount: 10,
    buy_in_fee: 0,
    guaranteed_prize: 0,
    start_time: new Date().toISOString(),
    status: 'REGISTERING',
    current_players: 2,
    max_players: 3,
    starting_chips: 300,
    variant: 'spin',
    ...overrides,
  } as LobbyTournamentRow;
}

/** The blind structure a Spin actually carries: `duration`, in SECONDS. */
const SPIN_BLINDS = JSON.stringify([
  { level: 1, smallBlind: 10, bigBlind: 20, ante: 0, duration: 180 },
  { level: 2, smallBlind: 15, bigBlind: 30, ante: 0, duration: 180 },
]);

/** The blind structure an MTT / Heads-Up carries: `durationMinutes`. */
const MTT_BLINDS = JSON.stringify([
  { level: 1, smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 10 },
  { level: 2, smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 10 },
]);

// ─────────────────────────────────────────────────────────────────────────────
describe('the card is allowed to grow (Dan 1, 2)', () => {
  it('releases the 36px row height and the clip on a phone', () => {
    // `.lt-row td` sets height/overflow/white-space for the desktop table and
    // the phone block never restated them, so the card silently kept a 36px
    // window. If this assertion fails, the medallions are being cut in half
    // again.
    const rule = PHONE_BLOCK.match(
      /\.lobby-table \.lt-row td,\s*\n\s*\.lobby-table td \{([^}]*)\}/
    );
    expect(rule, 'phone block must override .lt-row td').not.toBeNull();
    expect(rule![1]).toContain('height: auto');
    expect(rule![1]).toContain('overflow: visible');
    expect(rule![1]).toContain('white-space: normal');
  });

  it('drops a cell with nothing in it rather than drawing an empty well', () => {
    expect(PHONE_BLOCK).toMatch(/\.lobby-table td:empty \{\s*display: none/);
  });
});

describe('one card for every tab (Dan 2)', () => {
  it('gives the ALL tab the same wells the dedicated tabs have', () => {
    const all = TSX.slice(TSX.indexOf("case 'ALL':"));
    for (const col of ['COL_TSTACK', 'COL_TLEVEL', 'COL_PAYOUT', 'COL_LEVELTIME', 'COL_FORMAT'])
      expect(all, `ALL tab must render ${col}`).toContain(col);
  });

  it('names the two tournament wells the same on both tabs', () => {
    expect(TSX).toContain("label: 'Starting Stack'");
    expect(TSX).toContain("label: 'Current Level'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('cash buy-in is what the player can ACTUALLY bring (Dan 3, 4)', () => {
  it('no longer clamps a 200bb row, trusting the DB bounds instead', () => {
    expect(cashBuyInRange({ big_blind: 25, min_buy_in: 1000, max_buy_in: 5000 })).toEqual({
      min: 1000,
      max: 5000,
    });
    expect(cashBuyInLabel(tableRow())).toBe('1,000 - 5,000');
  });

  it('does the same for PLO, returning the true DB bounds', () => {
    expect(
      cashBuyInLabel(
        tableRow({
          game_variant: 'plo4',
          small_blind: 5,
          big_blind: 10,
          min_buy_in: 400,
          max_buy_in: 2000,
        })
      )
    ).toBe('400 - 2,000');
  });

  it('honors a floor below the standard 40bb minimum if specified in DB', () => {
    expect(cashBuyInRange({ big_blind: 10, min_buy_in: 100, max_buy_in: 1000 })).toEqual({
      min: 100,
      max: 1000,
    });
  });

  it('reports the row itself when the row sits outside the band entirely', () => {
    // NLH 25/50 INSURANCE TEST: min 100 / max 200 on a 50 big blind. The
    // intersection is empty, and the row is what atomic_table_buyin enforces —
    // printing 2,000 there would advertise a buy-in certain to be rejected.
    expect(cashBuyInRange({ big_blind: 50, min_buy_in: 100, max_buy_in: 200 })).toEqual({
      min: 100,
      max: 200,
    });
  });

  it('falls back to 40-200bb when the columns are missing', () => {
    expect(cashBuyInRange({ big_blind: 2 })).toEqual({ min: 80, max: 400 });
  });

  it('is the number the lobby card prints', () => {
    expect(cashEntry(tableRow()).buyInLabel).toBe('1,000 - 5,000');
  });
});

describe('a cash card is two lines and the second one is the table name (Dan 3, 4)', () => {
  const lines = (name: string, row: Partial<LobbyTableRow> = {}) =>
    cashTitleLines(cashEntry(tableRow({ name, ...row })));

  it('splits the game and stakes from the name the host chose', () => {
    expect(lines('NLH 25/50 INSURANCE TEST', { small_blind: 25, big_blind: 50 })).toEqual({
      headline: 'NLH 25/50',
      subtitle: 'INSURANCE TEST',
    });
  });

  it('strips PLO6, which the character class used to miss', () => {
    // The class was plo[458]? — so "PLO6 1/2" kept its whole name as the
    // subtitle and the card printed it twice, once per line.
    expect(lines('PLO6 1/2', { game_variant: 'plo6', small_blind: 1, big_blind: 2 })).toEqual({
      headline: 'PLO6 1/2',
      subtitle: null,
    });
  });

  it('handles a variant token the headline abbreviates differently', () => {
    expect(
      lines('PLO4 1/2 (audit)', { game_variant: 'plo4', small_blind: 1, big_blind: 2 })
    ).toEqual({ headline: 'PLO 1/2', subtitle: '(audit)' });
  });

  it('gives no second line to a table with no name of its own', () => {
    expect(lines('NLH 10/25').subtitle).toBeNull();
  });

  it('never loses the name entirely', () => {
    expect(lines('Friday Night Game').subtitle).toBe('Friday Night Game');
  });
});

describe('cash tables show what makes them different from each other (Dan 3, 4)', () => {
  /* The medallions used to be pinned HERE, on the card. Dan moved them on
     2026-08-25: "FOR RULES, REMOVE IT FROM THE MAIN SCREEN BUT MAKE SURE ALL
     RULES AND TAGS ARE ON THE LOBBY SCREEN WHEN YOU CLICK THE GAME." What
     still has to be true is that they are COMPUTED - the tests below read
     cashRuleMedallions directly - and that the panel renders them. Where they
     are rendered is pinned by lobbyTitleColumn.test.ts. */

  it('reads the COLUMNS the host actually set, not the empty settings blob', () => {
    // All 46 live cash tables carry `settings = {}` — TableConfigPage writes
    // the host's choices to top-level columns. Reading the blob is why not one
    // table showed a single tag.
    const rules = cashEntry(
      tableRow({
        settings: {},
        insurance_enabled: true,
        straddle_enabled: true,
        bomb_pot_enabled: true,
        bomb_pot_frequency: 10,
        time_bank_enabled: true,
        all_in_or_fold: true,
      })
    ).rules.map((r) => r.key);
    expect(rules).toEqual(
      expect.arrayContaining(['insurance', 'straddle', 'bomb', 'time_bank', 'all_in_or_fold'])
    );
  });

  it('does not promise run it twice at an insurance table', () => {
    // ServerTableEngineBase: `ritEnabled && !insurance_enabled`. Insurance
    // silently switches RIT off, so a card offering both lies about one.
    const rules = cashEntry(
      tableRow({ insurance_enabled: true, run_it_twice: true, allow_run_it_twice: true })
    ).rules.map((r) => r.key);
    expect(rules).toContain('insurance');
    expect(rules).not.toContain('rit');
  });

  it('shows run it twice on the 43 tables that really have it', () => {
    const rules = cashEntry(
      tableRow({ run_it_twice: true, run_it_twice_enabled: true, allow_run_it_twice: true })
    ).rules.map((r) => r.key);
    expect(rules).toContain('rit');
  });

  it('ignores the club-level straddle spellings the engine never loads', () => {
    // Live shape: straddle_enabled=false while allow_straddle/enable_straddle
    // are true. Only straddle_enabled gates a straddle at the table.
    expect(cashEntry(tableRow({ straddle_enabled: false })).rules.map((r) => r.key)).not.toContain(
      'straddle'
    );
  });

  it('does not claim bomb pots when the frequency is zero', () => {
    // The engine needs `bomb_pot_enabled && bomb_pot_frequency > 0`.
    expect(
      cashEntry(tableRow({ bomb_pot_enabled: true, bomb_pot_frequency: 0 })).rules.map((r) => r.key)
    ).not.toContain('bomb');
  });

  /* BOMB POT STANDARDIZATION 2026-08-27 (spec §15.1): each trigger mode
     carries its own cadence, so the medallion must not depend on the
     every-N-hands frequency once another mode is live — and it must SAY the
     mode and board count before the player sits. */
  it('a once-per-orbit bomb table shows its medallion with frequency 0', () => {
    const rules = cashEntry(
      tableRow({
        bomb_pot_enabled: true,
        bomb_pot_frequency: 0,
        bomb_pot_trigger_mode: 'once_per_orbit',
        bomb_pot_board_count: 2,
      })
    ).rules;
    const bomb = rules.find((r) => r.key === 'bomb');
    expect(bomb).toBeTruthy();
    expect(bomb!.detail).toBe('EVERY ORBIT');
    expect(bomb!.tip).toContain('two boards');
  });

  it('a timed bomb table prints the interval in minutes', () => {
    const bomb = cashEntry(
      tableRow({
        bomb_pot_enabled: true,
        bomb_pot_frequency: 0,
        bomb_pot_trigger_mode: 'timed',
        bomb_pot_interval_seconds: 1800,
        bomb_pot_board_count: 3,
      })
    ).rules.find((r) => r.key === 'bomb');
    expect(bomb).toBeTruthy();
    expect(bomb!.detail).toBe('EVERY 30 MIN');
    expect(bomb!.tip).toContain('three boards');
  });

  it('a bomb-pot-only table wears its identity as the label', () => {
    const bomb = cashEntry(
      tableRow({
        bomb_pot_enabled: true,
        bomb_pot_frequency: 0,
        bomb_pot_trigger_mode: 'bomb_pot_only',
        bomb_pot_board_count: 3,
      })
    ).rules.find((r) => r.key === 'bomb');
    expect(bomb).toBeTruthy();
    expect(bomb!.label).toBe('BOMB POT ONLY');
    expect(bomb!.detail).toBe('TRIPLE BOARD');
  });

  it('a timed mode with no interval set stays silent rather than lying', () => {
    expect(
      cashEntry(
        tableRow({
          bomb_pot_enabled: true,
          bomb_pot_frequency: 0,
          bomb_pot_trigger_mode: 'timed',
          bomb_pot_interval_seconds: 0,
        })
      ).rules.map((r) => r.key)
    ).not.toContain('bomb');
  });

  it('prints no chip for a rule the platform does not enforce', () => {
    // VPIP has no column at all; maintain_hands, no_rathole and calltime are
    // written by the config page and read by nothing.
    const all = cashEntry(
      tableRow({ settings: { vpip_display: true, no_rathole: true, call_time_enabled: true } })
    ).rules.map((r) => r.key);
    expect(all).not.toContain('vpip');
    expect(all).not.toContain('no_rathole');
    expect(all).not.toContain('call_time');
  });

  it('does not guess a feature from the table name', () => {
    // "NLH 25/50 INSURANCE TEST" with insurance_enabled false is a
    // misconfigured table, not an insurance table.
    expect(
      cashEntry(tableRow({ name: 'NLH 25/50 INSURANCE TEST', insurance_enabled: false })).rules.map(
        (r) => r.key
      )
    ).not.toContain('insurance');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('spins say what they pay and how they play (Dan 5)', () => {
  const spin = (o: Partial<LobbyTournamentRow> = {}) =>
    tournamentEntry(tournRow({ blind_structure: SPIN_BLINDS, ...o }), 'spin');

  it('advertises the ceiling of the ladder before the wheel turns', () => {
    expect(SPIN_MAX_MULTIPLIER).toBe(100);
    expect(spinPayoutLabel(spin())).toBe('Win Up To 100x');
  });

  it('will not print a drawn multiplier while the Spin is still filling', () => {
    // THE DRAW IS THE PRODUCT. utils/spinReveal exists because five surfaces
    // once printed it independently; a lobby card is not allowed to become the
    // sixth. A row that somehow carries a multiplier before the wheel turns
    // still advertises the ladder.
    expect(spinPayoutLabel(spin({ spin_multiplier: 25 }))).toBe('Win Up To 100x');
  });

  it('shows it once the game is actually under way', () => {
    expect(spinPayoutLabel(spin({ spin_multiplier: 25, status: 'RUNNING' }))).toBe('25x');
  });

  it('never sorts the board by a number it is hiding', () => {
    // Sorting by an unrevealed multiplier would leak the draw through the
    // ORDER of the rows, which is the same leak by another route.
    const col = TSX.slice(TSX.indexOf('const COL_PAYOUT'), TSX.indexOf('const COL_LEVELTIME'));
    expect(col).not.toContain('sortValue');
    expect(col).not.toContain('spin_multiplier');
  });

  it('says nothing about payout on a game that is not a spin', () => {
    expect(spinPayoutLabel(tournamentEntry(tournRow({ variant: 'sng' }), 'sng'))).toBeNull();
  });

  it('reads the level clock out of the SECONDS key a spin actually writes', () => {
    expect(levelSpeedLabel(tournRow({ blind_structure: SPIN_BLINDS }))).toBe('3 Min');
  });

  it('counts the three seats as a fraction', () => {
    expect(seatsTakenLabel(spin({ current_players: 0 }))).toBe('0/3');
    expect(seatsTakenLabel(spin({ current_players: 2 }))).toBe('2/3');
    expect(seatsTakenLabel(spin({ current_players: 3 }))).toBe('3/3');
  });

  /**
   * RESTORED 2026-09-02. This briefly asserted that an UNDRAWN spin has no
   * depth label, because `starting_chips` was a 300-chip seed rewritten at
   * draw time and "Turbo" derived from a placeholder was a lie.
   *
   * Dan's ruling landed while that was in flight and removed the premise:
   * `SpinTierSpec.startingStack` is gone, the 5,000 band is retired, and the
   * stack is a property of the BOARD - 300 for a Turbo, 1,000 for a Deep
   * Stack, known at buy-in and never depending on the draw. So the column is
   * trustworthy before the wheel turns, and reading it is right again.
   */
  it('calls a 300-chip spin a turbo and a 1,000-chip spin a deepstack', () => {
    expect(stackDepthLabel(spin({ starting_chips: 300 }))).toBe('Turbo');
    expect(stackDepthLabel(spin({ starting_chips: 1000 }))).toBe('Deepstack');
    expect(stackDepthLabel(spin({ starting_chips: 5000 }))).toBe('Deepstack');
  });

  it('offers Watch, not Sit Down, once there is no seat to buy', () => {
    const spinAction = TSX.slice(TSX.indexOf("if (e.kind === 'spin' || e.kind === 'sng')"));
    expect(spinAction).toContain('noSeatLeft');
    expect(spinAction).toContain("e.status === 'running'");
    expect(spinAction).toContain('Watch');
    expect(spinAction).toContain('Return To Game');
  });

  it('keeps the status badge on a seat-first card', () => {
    expect(PHONE_BLOCK).toMatch(/tr\[data-kind='spin'\] td\.lt-col-status \{\s*display: block/);
  });

  it('reports Running for a spin that has started', () => {
    expect(tournamentStatus(tournRow({ status: 'RUNNING' })).key).toBe('running');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('heads-up says how many seats are gone and how deep it starts (Dan 6)', () => {
  const hu = (o: Partial<LobbyTournamentRow> = {}) =>
    tournamentEntry(
      tournRow({
        name: 'NLH Heads-Up 10',
        variant: 'sng',
        max_players: 2,
        starting_chips: 1500,
        blind_structure: MTT_BLINDS,
        ...o,
      }),
      'sng'
    );

  it('counts the two seats as a fraction', () => {
    expect(seatsTakenLabel(hu({ current_players: 0 }))).toBe('0/2');
    expect(seatsTakenLabel(hu({ current_players: 1 }))).toBe('1/2');
    expect(seatsTakenLabel(hu({ current_players: 2 }))).toBe('2/2');
  });

  it('reads the level clock out of the MINUTES key an SNG writes', () => {
    expect(levelSpeedLabel(hu().raw as LobbyTournamentRow)).toBe('10 Min');
  });

  it('measures the format off the stack rather than guessing from the name', () => {
    // 1,500 into a 50 big blind is 30bb — neither a turbo nor a deep stack.
    expect(stackDepthLabel(hu())).toBe('Standard');
    expect(stackDepthLabel(hu({ starting_chips: 3000 }))).toBe('Deepstack');
    expect(stackDepthLabel(hu({ starting_chips: 500 }))).toBe('Turbo');
  });

  it('still lets a name that says Turbo say Turbo', () => {
    expect(stackDepthLabel(hu({ name: 'NLH Heads-Up 10 Turbo' }))).toBe('Turbo');
  });

  it('keeps its status badge, which is the only thing describing the game', () => {
    expect(PHONE_BLOCK).toMatch(
      /tr\[data-kind='sng'\] td\.lt-col-status[,\s]+[^{]*\{\s*display: block/
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('an MTT keeps its bare enrolled count', () => {
  it('never invents a denominator out of max_players', () => {
    // Dan 2026-08-24: "THERE ARE NO LIMITATIONS ON THE AMOUNT OF PLAYERS THAT
    // CAN REGISTER, IT SHOULDN'T DEFAULT TO /500."
    const mtt = tournamentEntry(
      tournRow({ name: 'Monday Grind', variant: 'mtt', max_players: 500, current_players: 21 }),
      'mtt'
    );
    expect(seatsTakenLabel(mtt)).toBe('21');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('both blind-structure shapes drive the same clocks', () => {
  it('reads seconds and minutes out of the one reader in the folder', () => {
    // tournamentFigures is the folder's only blind-structure parser. It knew
    // duration_minutes and durationMinutes; `duration` in SECONDS is the third
    // spelling, and the only one a Spin ever writes.
    expect(blindLevelMinutes(JSON.parse(SPIN_BLINDS), 1)).toBe(3);
    expect(blindLevelMinutes(JSON.parse(MTT_BLINDS), 1)).toBe(10);
    expect(blindLevelMinutes([], 1)).toBe(0);
  });

  it('gives a running spin a live level countdown, which it never had', () => {
    // levelRemainingMs only ever read `durationMinutes`, so it returned null
    // for every spin on the platform and the level clock was silently dead.
    const now = Date.parse('2026-08-25T12:00:00Z');
    const left = levelRemainingMs(
      tournRow({
        status: 'RUNNING',
        blind_structure: SPIN_BLINDS,
        current_level: 1,
        level_started_at: new Date(now - 60_000).toISOString(),
      }),
      now
    );
    expect(left).toBe(120_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('no card claims a clock it does not have', () => {
  it('gives a cash table no Starting Time well at all', () => {
    const cell = TSX.slice(TSX.indexOf('function StartsCell'), TSX.indexOf('function SeatsMeter'));
    expect(cell).toMatch(/e(ntry)?\.kind === 'cash'\) return null/);
  });

  it('tells a seat-first game it starts When Full, not at 1:00 PM', () => {
    const cell = TSX.slice(TSX.indexOf('function StartsCell'), TSX.indexOf('function SeatsMeter'));
    expect(cell).toContain("entry.kind === 'spin' || entry.kind === 'sng'");
    expect(cell).toContain('When Full');
  });

  it('has no second countdown left to disagree with the title', () => {
    // LiveCountdown printed whole minutes into the status cell of a game that
    // does not start on a clock — "Starts In 29 Min..." beside a badge reading
    // Filling. Deleted rather than conditioned, so it cannot come back quietly.
    expect(TSX).not.toContain('function LiveCountdown');
    expect(TSX).not.toContain('<LiveCountdown');
  });

  it('has no medallion cell at all - the rules live in the game panel now', () => {
    expect(TSX).not.toContain('function RulesCell');
    expect(TSX).not.toContain('<RulesCell');
    expect(CSS).not.toContain('lt-col-rules');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a game the player is already in (Dan 7)', () => {
  it('renders the chip in the title, which no breakpoint hides', () => {
    const nameCol = TSX.slice(TSX.indexOf('const COL_NAME'), TSX.indexOf('const COL_TNAME'));
    expect(nameCol).toContain('PlayerStateChip');
    // ...on every kind of card, not just cash.
    expect(nameCol.match(/PlayerStateChip/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('no longer hides it inside the status cell that MTT cards drop', () => {
    const statusCol = TSX.slice(TSX.indexOf('const COL_STATUS'), TSX.indexOf('const COL_KIND'));
    expect(statusCol).not.toContain('<PlayerStateChip');
  });

  it('outlines the row as well as labelling it', () => {
    expect(TSX).toContain("mine ? ' is-mine' : ''");
    expect(PHONE_BLOCK).toMatch(/tr\.is-mine \{[^}]*border-left-color: #2ed573/);
  });

  it('counts a seat, a registration or a waitlist place on any game kind', () => {
    // The shared state classifier moved out of LobbyTable so both the list row
    // and the image-card renderer consume one answer. Pin the owning module,
    // rather than silently slicing from -1 when the implementation moves.
    const start = PLAYER_STATE_SOURCE.indexOf('export function lobbyPlayerStateOf');
    expect(start).toBeGreaterThan(-1);
    const fn = PLAYER_STATE_SOURCE.slice(start);
    expect(fn).toContain('seatedIds');
    expect(fn).toContain('registeredIds');
    expect(fn).toContain('waitlistedIds');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUND TWO — Dan 2026-08-25, second pass over the same six screenshots
// ═══════════════════════════════════════════════════════════════════════════

describe('a seat-first game with every seat gone', () => {
  const seatFirst = (o: Partial<LobbyTournamentRow>, kind: 'spin' | 'sng') =>
    tournamentEntry(tournRow({ blind_structure: SPIN_BLINDS, ...o }), kind);

  it('says Running, not Starting (Dan: "IT NEEDS TO SAY RUNNING NOT STARTING")', () => {
    const full = seatFirst({ current_players: 3, max_players: 3 }, 'spin');
    expect(full.status).toBe('running');
    expect(full.statusLabel).toBe('Running');
  });

  it('is not joinable, so the board sinks it', () => {
    expect(seatFirstJoinable(seatFirst({ current_players: 3, max_players: 3 }, 'spin'))).toBe(
      false
    );
    expect(seatFirstJoinable(seatFirst({ current_players: 1, max_players: 2 }, 'sng'))).toBe(true);
  });

  it('never sinks a cash table or an MTT — they have their own rules', () => {
    expect(seatFirstJoinable(cashEntry(tableRow({ current_players: 6, max_players: 6 })))).toBe(
      true
    );
    expect(
      seatFirstJoinable(tournamentEntry(tournRow({ variant: 'mtt', status: 'RUNNING' }), 'mtt'))
    ).toBe(true);
  });

  it('is applied AFTER the chosen sort, and not as a column', () => {
    // A sort by buy-in must not be able to float a sold-out game back up
    // between two joinable ones at the same price.
    expect(TSX).toContain('const sink = useCallback');
    const payout = TSX.slice(TSX.indexOf('const COL_PAYOUT'), TSX.indexOf('const COL_LEVELTIME'));
    expect(payout).not.toContain('sortValue');
  });
});

describe('what a Spin pays, in chips (Dan 4)', () => {
  const spin = (o: Partial<LobbyTournamentRow> = {}) =>
    tournamentEntry(tournRow({ blind_structure: SPIN_BLINDS, buy_in_amount: 10, ...o }), 'spin');

  it('turns "Win Up To 100x" into money at THIS buy-in', () => {
    // Dan: "SHOW WHAT THE TOP PRIZE IS (BUY IN AMOUNT X 100 = 100 TOP PRIZE)".
    expect(spinPrizeLabel(spin())).toBe('Top Prize 1,000');
    expect(spinPrizeLabel(spin({ buy_in_amount: 1 }))).toBe('Top Prize 100');
  });

  it('shows the real pool once the wheel has turned', () => {
    expect(spinPrizeLabel(spin({ status: 'RUNNING', spin_multiplier: 25, prize_pool: 250 }))).toBe(
      'Prize Pool 250'
    );
  });

  it('derives the pool when the row has not been re-read since the draw', () => {
    expect(spinPrizeLabel(spin({ status: 'RUNNING', spin_multiplier: 5, prize_pool: 0 }))).toBe(
      'Prize Pool 50'
    );
  });

  it('leaks nothing before the draw, even from a row that carries a pool', () => {
    // prize_pool IS buy_in x multiplier, so printing it early gives the draw
    // away by division. Same gate as the multiplier itself.
    expect(spinPrizeLabel(spin({ spin_multiplier: 100, prize_pool: 1000 }))).toBe(
      'Top Prize 1,000'
    );
  });

  it('says nothing at all on a game that is not a Spin', () => {
    expect(spinPrizeLabel(tournamentEntry(tournRow({ variant: 'sng' }), 'sng'))).toBeNull();
  });
});

describe('the Omaha tab is four games, not one (Dan 3)', () => {
  it('offers a chip for every PLO variant', () => {
    const keys = (FILTER_SPECS.OMAHA.games ?? []).map((g) => g.key);
    expect(keys).toEqual(['plo4', 'plo5', 'plo6', 'plo8']);
  });

  it('offers only chips variantKey can actually produce', () => {
    // The precedent this file records twice: a chip whose key can never be
    // returned empties the tab instead of narrowing it.
    for (const key of FILTER_SPECS.OMAHA.games ?? []) {
      expect(variantKey(key.key), key.key).toBe(key.key);
    }
  });

  it('keeps hi-lo out of the four-card bucket', () => {
    expect(variantKey('plo8')).toBe('plo8');
    expect(variantKey('PLO6')).toBe('plo6');
    expect(variantKey('plo')).toBe('plo4');
  });
});
