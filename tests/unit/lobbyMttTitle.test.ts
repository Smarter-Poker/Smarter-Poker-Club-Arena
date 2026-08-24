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

  it('level window ticks from the blind structure', () => {
    // In level 2 of 4/4/3-minute levels, late reg through level 3:
    // rest of level 2 (4 min from its start) + level 3 (3 min).
    const t = tournamentRow({
      status: 'RUNNING',
      started_at: iso(-5 * 60000),
      late_reg_mins: 0,
      late_reg_levels: 3,
      current_level: 2,
      level_started_at: iso(-60000),
      blind_structure: JSON.stringify([
        { level: 1, durationMinutes: 4 },
        { level: 2, durationMinutes: 4 },
        { level: 3, durationMinutes: 3 },
      ]),
    });
    expect(lateRegEndMs(t)).toBe(NOW - 60000 + (4 + 3) * 60000);
  });

  it('with both windows the LATER close wins — the countdown never lies short', () => {
    const t = tournamentRow({
      status: 'RUNNING',
      started_at: iso(-9 * 60000),
      late_reg_mins: 10,
      late_reg_levels: 2,
      current_level: 1,
      level_started_at: iso(0),
      blind_structure: JSON.stringify([
        { level: 1, durationMinutes: 4 },
        { level: 2, durationMinutes: 4 },
      ]),
    });
    const end = lateRegEndMs(t);
    expect(end).toBe(NOW + 8 * 60000); // levels keep it open longer
    expect(end!).toBeGreaterThan(NOW + 60000); // the minutes-only close
  });

  it('returns null when the row proves nothing', () => {
    expect(lateRegEndMs(tournamentRow({ late_reg_mins: 0, late_reg_levels: 0 }))).toBeNull();
  });

  it('survives a malformed blind structure via the minutes window', () => {
    const t = tournamentRow({
      status: 'RUNNING',
      started_at: iso(-60000),
      late_reg_mins: 5,
      late_reg_levels: 3,
      blind_structure: 'not json at all',
    });
    expect(lateRegEndMs(t)).toBe(NOW + 4 * 60000);
  });
});

describe('mttPhaseText — the live phrase on line 2', () => {
  it('counts down to a future start', () => {
    const e = entry({ startTime: iso(30 * 1000) });
    expect(mttPhaseText(e, NOW)).toBe('Starting In 0:30...');
  });
  it('an overdue start is Starting Soon, not a negative clock', () => {
    const e = entry({ startTime: iso(-30 * 1000) });
    expect(mttPhaseText(e, NOW)).toBe('Starting Soon');
  });
  it('late reg counts down its remaining time', () => {
    const e = entry(
      { status: 'late_reg' },
      { status: 'RUNNING', started_at: iso(-5 * 60000), late_reg_mins: 10 }
    );
    expect(mttPhaseText(e, NOW)).toBe('Late Reg 5:00 Left');
  });
  it('an expired window says Closing, an unknowable one says Open', () => {
    const closing = entry(
      { status: 'late_reg' },
      { status: 'RUNNING', started_at: iso(-11 * 60000), late_reg_mins: 10 }
    );
    expect(mttPhaseText(closing, NOW)).toBe('Late Reg Closing');
    const open = entry(
      { status: 'late_reg' },
      { status: 'RUNNING', late_reg_mins: 0, late_reg_levels: 0 }
    );
    expect(mttPhaseText(open, NOW)).toBe('Late Reg Open');
  });
  it('running and terminal states', () => {
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
