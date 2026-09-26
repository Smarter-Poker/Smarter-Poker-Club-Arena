/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MTT TWO-LINE TITLES, THE LATE-REG COUNTDOWN, AND THE ONE-TYPEFACE LOBBY
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-23 (verbatim): "if a mtt has a guarantee it needs to be
 * displayed in the title. For MTT's Title should be 2 lines. First line is the
 * name and variation. second line is Guarantee Starting Time Count down clock,
 * Starting in 17:33... (or if it already started how long is left for late
 * registration). change all the fonts on all the displays including the
 * numbers to all be the same font type on all the pages USING THE FONT
 * LOCATED UNDER 'TOURNAMENT NAME'."
 *
 * Dan, 2026-08-24: "REMOVE THE YELLOW THAT WAS JUST ADDED TO THE TITLES, WE
 * USE SMARTER.POKER COLOR SCHEMA ONLY! AND IT SHOULD HAVE A COUNTDOWN TIMER
 * ON THE LATE REG CLOSING. UNDER 'STAKES / BUY IN' JUST FOR THE 'ALL' TAB,
 * CHANGE 'STAKES / BUY IN' TO JUST 'STAKES'"
 *
 * What this pins:
 *   1. formatClock renders m:ss under an hour, h:mm:ss above, never negative.
 *   2. mttTitleLine guarantees the variation appears in line 1.
 *   3. lateRegEndMs knows BOTH windows — minutes and blind-structure levels —
 *      and reports the later close, so the countdown never lies short.
 *   4. mttPhaseText produces the live phrases the second line renders.
 *   5. The lobby stylesheet carries ONE typeface (no mono face anywhere) and
 *      the guarantee is Club Arena blue, not gold.
 *   6. The ALL tab's cost column is titled "Stakes".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  formatClock,
  lateRegEndMs,
  mttPhaseText,
  mttTitleLine,
  type LobbyEntry,
  type LobbyTournamentRow,
} from '../../src/components/lobby/lobbyEntries';

const CSS = readFileSync(resolve(__dirname, '../../src/components/lobby/LobbyTable.css'), 'utf8');
const TSX = readFileSync(resolve(__dirname, '../../src/components/lobby/LobbyTable.tsx'), 'utf8');

const NOW = Date.parse('2026-08-24T05:00:00Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function tournamentRow(overrides: Partial<LobbyTournamentRow> = {}): LobbyTournamentRow {
  return {
    id: 't1',
    name: 'Midnight Bounty',
    game_type: 'NLH',
    buy_in_amount: 5,
    buy_in_fee: 0,
    guaranteed_prize: 100,
    start_time: iso(0),
    status: 'REGISTERING',
    current_players: 10,
    max_players: 50,
    starting_chips: 10000,
    ...overrides,
  };
}

function entry(overrides: Partial<LobbyEntry> = {}, raw?: Partial<LobbyTournamentRow>): LobbyEntry {
  const r = tournamentRow(raw);
  return {
    id: r.id,
    kind: 'mtt',
    name: r.name,
    gameLabel: 'NLH',
    variantLabel: "No Limit Hold'em",
    stakesLabel: null,
    stakesValue: 5,
    buyInLabel: '5',
    buyInValue: 5,
    guaranteeLabel: '100 GTD',
    guaranteeValue: 100,
    players: 10,
    capacity: 50,
    startTime: r.start_time,
    startValue: new Date(r.start_time).getTime(),
    speedLabel: 'Standard',
    status: 'registering',
    statusLabel: 'Registering',
    live: false,
    rules: [],
    raw: r,
    ...overrides,
  };
}

describe('formatClock', () => {
  it('renders m:ss under an hour', () => {
    expect(formatClock((17 * 60 + 33) * 1000)).toBe('17:33');
    expect(formatClock(5 * 1000)).toBe('0:05');
  });
  it('renders h:mm:ss at an hour and above', () => {
    expect(formatClock((3600 + 2 * 60 + 33) * 1000)).toBe('1:02:33');
  });
  it('never goes negative', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(-5000)).toBe('0:00');
  });
});

describe('mttTitleLine — line 1 is name AND variation', () => {
  it('leaves a name that already carries the variation alone', () => {
    expect(mttTitleLine(entry({ name: 'Late Night Grind (NLH)' }))).toBe('Late Night Grind (NLH)');
  });
  it('appends the variation when the name lacks it', () => {
    expect(mttTitleLine(entry({ name: 'Midnight Special' }))).toBe('Midnight Special (NLH)');
  });
});

describe('lateRegEndMs — when does the door actually close', () => {
  it('minutes window: started_at + late_reg_mins', () => {
    const t = tournamentRow({
      status: 'RUNNING',
      started_at: iso(-2 * 60000),
      late_reg_mins: 10,
    });
    expect(lateRegEndMs(t)).toBe(NOW + 8 * 60000);
  });

  /**
   * RE-PINNED 2026-08-25: `current_level` is a 0-BASED INDEX.
   *
   * This case used to read it as a 1-based display number, which made
   * lateRegEndMs disagree with isInLateRegistration — the sibling function
   * that decides whether the door is open at all, and which documents the
   * convention explicitly: "current_level is a 0-BASED index into
   * blind_structure ... the cutoff is index N. Matches
   * TournamentManagerBase.isLateRegClosed: currentLevel >= cap."
   *
   * Confirmed against production the same day: a tournament with
   * `current_level = 8` indexes to a blind_structure element whose own `level`
   * field reads 9.
   *
   * So `current_level: 2` with `late_reg_levels: 3` is the LAST late-reg
   * level (indices 0, 1, 2), and what remains is the rest of that level
   * alone. The old expectation added a whole further level that registration
   * would never see, so the card counted down past the moment the RPC began
   * refusing entries.
   */
  it('level window ticks from the blind structure, in 0-based indices', () => {
    const t = tournamentRow({
      status: 'RUNNING',
      started_at: iso(-5 * 60000),
      late_reg_mins: 0,
      late_reg_levels: 3,
      current_level: 2, // index 2 = the third level, and the last one open
      level_started_at: iso(-60000),
      blind_structure: JSON.stringify([
        { level: 1, durationMinutes: 4 },
        { level: 2, durationMinutes: 4 },
        { level: 3, durationMinutes: 3 },
      ]),
    });
    // Only the remainder of index 2 (level 3, three minutes) is left.
    expect(lateRegEndMs(t)).toBe(NOW - 60000 + 3 * 60000);
  });

  /* Replaced 2026-09-26 (20260926035534): this pin read "uses the level
     window when both windows are configured" and expected the LATER level
     close. fn_tournament_late_registration_open now closes at whichever
     deadline passes first, so the countdown shows the earlier one. */
  it('uses whichever window closes first when both are configured', () => {
    const t = tournamentRow({
      status: 'RUNNING',
      started_at: iso(-9 * 60000),
      late_reg_mins: 10,
      late_reg_levels: 2,
      current_level: 1, // index 1 = the second level, the last one open
      level_started_at: iso(0),
      blind_structure: JSON.stringify([
        { level: 1, durationMinutes: 4 },
        { level: 2, durationMinutes: 4 },
      ]),
    });
    const end = lateRegEndMs(t);
    // Level 2 would run four more minutes; the ten-minute clock ends in one.
    expect(end).toBe(NOW + 60000);
    expect(end!).toBeLessThan(NOW + 4 * 60000); // the level window's later close
  });

  it('uses the level window when it closes before the clock', () => {
    const t = tournamentRow({
      status: 'RUNNING',
      started_at: iso(-9 * 60000),
      late_reg_mins: 60,
      late_reg_levels: 2,
      current_level: 1,
      level_started_at: iso(0),
      blind_structure: JSON.stringify([
        { level: 1, durationMinutes: 4 },
        { level: 2, durationMinutes: 4 },
      ]),
    });
    expect(lateRegEndMs(t)).toBe(NOW + 4 * 60000);
  });

  it('returns null when the row proves nothing', () => {
    expect(lateRegEndMs(tournamentRow({ late_reg_mins: 0, late_reg_levels: 0 }))).toBeNull();
  });

  it('does not invent a minutes deadline for a malformed level structure', () => {
    const t = tournamentRow({
      status: 'RUNNING',
      started_at: iso(-60000),
      late_reg_mins: 5,
      late_reg_levels: 3,
      blind_structure: 'not json at all',
    });
    expect(lateRegEndMs(t)).toBeNull();
  });
});

describe('mttPhaseText — the live phrase on line 2', () => {
  it('counts down to a future start', () => {
    const e = entry({ startTime: iso(30 * 1000) });
    expect(mttPhaseText(e, NOW)).toBe('Starts In 0:30');
  });
  /* RE-PINNED 2026-08-24. Dan: "keep the clock running at all times, don't
     switch back and forth from a clock to a phrase." An overdue start used to
     drop the clock entirely, so a card that had been counting down flipped to
     "Starting Soon" at the exact moment the number mattered most. Zero is a
     legitimate reading of a clock; a missing clock is not. A start time we
     cannot parse at all is still the one case with nothing to count. */
  it('an overdue start holds the clock at zero rather than dropping it', () => {
    const e = entry({ startTime: iso(-30 * 1000) });
    expect(mttPhaseText(e, NOW)).toBe('Starts In 0:00');
  });
  it('only an unparseable start time gives up the clock', () => {
    const e = entry({ startTime: null });
    expect(mttPhaseText(e, NOW)).toBe('Starting Soon');
  });
  it('late reg counts down its remaining time', () => {
    const e = entry(
      { status: 'late_reg' },
      { status: 'RUNNING', started_at: iso(-5 * 60000), late_reg_mins: 10 }
    );
    expect(mttPhaseText(e, NOW)).toBe('Late Reg 5:00 Left');
  });
  it('an expired window holds at zero, an unknowable one says Open', () => {
    const closing = entry(
      { status: 'late_reg' },
      { status: 'RUNNING', started_at: iso(-11 * 60000), late_reg_mins: 10 }
    );
    expect(mttPhaseText(closing, NOW)).toBe('Late Reg 0:00 Left');
    const open = entry(
      { status: 'late_reg' },
      { status: 'RUNNING', late_reg_mins: 0, late_reg_levels: 0 }
    );
    expect(mttPhaseText(open, NOW)).toBe('Late Reg Open');
  });
  it('a running tournament counts its level down when the structure says how', () => {
    const e = entry(
      { status: 'running' },
      {
        status: 'RUNNING',
        // index 1 = level 2, whose row the structure below carries
        current_level: 1,
        level_started_at: iso(-4 * 60000),
        blind_structure: JSON.stringify([
          { level: 1, smallBlind: 25, bigBlind: 50, durationMinutes: 10 },
          { level: 2, smallBlind: 50, bigBlind: 100, durationMinutes: 10 },
        ]),
      }
    );
    expect(mttPhaseText(e, NOW)).toBe('Level Ends In 6:00');
  });

  it('running and terminal states', () => {
    /* A running tournament with no blind structure to read has no level clock
       to show, so the word stands. With one, it counts the level down — see
       the case below. */
    expect(mttPhaseText(entry({ status: 'running' }), NOW)).toBe('Running');
    expect(mttPhaseText(entry({ status: 'completed', statusLabel: 'Completed' }), NOW)).toBe(
      'Completed'
    );
  });
});

describe('the lobby stylesheet and table (shipped invariants)', () => {
  it('one typeface: no mono face anywhere in the lobby table', () => {
    expect(CSS).not.toContain('JetBrains');
    expect(CSS).not.toContain('--font-mono');
  });
  it('the guarantee is Club Arena blue, never gold', () => {
    expect(CSS).toMatch(/\.lt-name__gtd\s*\{[^}]*--club-blue-light/);
    expect(CSS).not.toMatch(/\.lt-name__gtd\s*\{[^}]*gold/);
  });
  it('MTT rows render the two-line title', () => {
    expect(TSX).toContain('lt-name--mtt');
    expect(TSX).toContain('MttTitleMeta');
  });
  it('all countdowns share ONE interval', () => {
    expect(TSX).toContain('useSharedSecondTick');
    // Call sites only (type annotations like ReturnType<typeof setInterval>
    // don't count): the shared tick plus LiveCountdown's coarse minute one.
    expect(TSX.match(/= setInterval\(/g)!.length).toBeLessThanOrEqual(2);
  });
  it("the ALL tab's cost column is titled just Stakes", () => {
    expect(TSX).not.toContain("'Stakes / Buy-In'");
  });
});
