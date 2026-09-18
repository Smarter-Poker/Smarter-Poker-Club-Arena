/**
 * FULLY PAID BUT NEVER STARTED — the watchdog gap the 2026-08-24 audit
 * recorded as P2-7.
 *
 * Every other recovery sweep in GameServer proves a game is broken by finding
 * evidence it PLAYED: the played-but-REGISTERING sweep needs an
 * eliminated/winner/finished row, the decided-but-RUNNING sweep needs an
 * elimination. A game that never dealt a card cannot produce either. A
 * heads-up that sold both its seats and then stopped was therefore invisible
 * to all of them for 85 minutes with the money already taken.
 *
 * The evidence this watchdog runs on is the only evidence such a game has:
 * every seat it sells is sold, and it is still REGISTERING.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seatFirstStartStalled, SEAT_FIRST_START_STALL_MS } from './TournamentRecurringService.js';

const GAME_SERVER = readFileSync(join(__dirname, '..', 'GameServer.ts'), 'utf8');
const T0 = 1_700_000_000_000;

describe('seatFirstStartStalled', () => {
  it('is not a stall while the game is still filling', () => {
    expect(
      seatFirstStartStalled({ paidSeats: 2, maxPlayers: 3, fullSinceMs: T0, now: T0 + 60 * 60_000 })
    ).toBe(false);
  });

  it('is not a stall the moment the last seat is sold', () => {
    expect(seatFirstStartStalled({ paidSeats: 3, maxPlayers: 3, fullSinceMs: T0, now: T0 })).toBe(
      false
    );
  });

  it('is a stall once the window has passed with every seat sold', () => {
    expect(
      seatFirstStartStalled({
        paidSeats: 3,
        maxPlayers: 3,
        fullSinceMs: T0,
        now: T0 + SEAT_FIRST_START_STALL_MS,
      })
    ).toBe(true);
    // The 85-minute heads-up.
    expect(
      seatFirstStartStalled({
        paidSeats: 2,
        maxPlayers: 2,
        fullSinceMs: T0,
        now: T0 + 85 * 60_000,
      })
    ).toBe(true);
  });

  it('never fires on a game it has not yet watched go full', () => {
    // A fresh process must spend one window observing the board before it
    // force-starts anything on it.
    expect(
      seatFirstStartStalled({
        paidSeats: 3,
        maxPlayers: 3,
        fullSinceMs: null,
        now: T0 + 10 * 60 * 60_000,
      })
    ).toBe(false);
    expect(
      seatFirstStartStalled({ paidSeats: 3, maxPlayers: 3, fullSinceMs: undefined, now: T0 })
    ).toBe(false);
  });

  it('never fires on a game with no seats to sell', () => {
    expect(
      seatFirstStartStalled({ paidSeats: 0, maxPlayers: 0, fullSinceMs: T0, now: T0 + 1e9 })
    ).toBe(false);
  });

  it('treats nonsense as not-a-stall rather than force-starting a board', () => {
    expect(
      seatFirstStartStalled({
        paidSeats: Number.NaN,
        maxPlayers: 3,
        fullSinceMs: T0,
        now: T0 + 1e9,
      })
    ).toBe(false);
    expect(
      seatFirstStartStalled({ paidSeats: 3, maxPlayers: 3, fullSinceMs: T0, now: Number.NaN })
    ).toBe(false);
  });

  it('holds the window at three minutes, which is ~36 discovery passes', () => {
    expect(SEAT_FIRST_START_STALL_MS).toBe(3 * 60 * 1000);
  });
});

describe('GameServer wiring for the stall watchdog', () => {
  it('runs the watchdog from the pinned rule', () => {
    expect(GAME_SERVER).toContain('seatFirstStartStalled({');
    expect(GAME_SERVER).toContain('GameServer.seat_first_fully_paid_never_started');
  });

  it('frees a tournamentEngines slot held by a manager that is not running', () => {
    // That slot IS the failure: the top of the discovery loop skips every id
    // in the map, so such a game is never looked at again by anything.
    const start = GAME_SERVER.indexOf('FULLY PAID BUT NEVER STARTED');
    expect(start).toBeGreaterThan(-1);
    const block = GAME_SERVER.slice(start, GAME_SERVER.indexOf('Find RUNNING tournaments', start));
    expect(block).toMatch(/!held\.isRunning\(\)/);
    expect(block).toContain('await this.stopTournamentManagerIfOwned(');
    expect(block).toContain("'GameServer.seat_first_stalled_manager_stop_failed'");
    expect(block).toContain('if (this.tournamentEngines.has(id)) continue;');
  });

  it('re-arms its clock after an attempt rather than retrying every pass', () => {
    const start = GAME_SERVER.indexOf('FULLY PAID BUT NEVER STARTED');
    const block = GAME_SERVER.slice(start, GAME_SERVER.indexOf('Find RUNNING tournaments', start));
    expect(block).toContain('this.seatFirstFullSince.set(id, stallNow)');
  });
});

describe('GameServer discovery reads - unreadable is UNKNOWN, never empty', () => {
  it('does not read a failed REGISTERING query as an empty board', () => {
    // Discarding it stopped every start, ramp and top-up on the platform for
    // as long as the failure lasted, silently.
    expect(GAME_SERVER).toMatch(/error:\s*registeringErr/);
    expect(GAME_SERVER).toContain('GameServer.registering_board_read_failed');
  });

  it('does not read a failed RUNNING query as nothing to resume', () => {
    expect(GAME_SERVER).toMatch(/error:\s*runningErr/);
    expect(GAME_SERVER).toContain('GameServer.running_board_read_failed');
  });

  it('still reports the seat-first batch reads it was given in the audit', () => {
    // P2-6, already fixed before this pass. Pinned so it stays fixed.
    expect(GAME_SERVER).toContain('GameServer.seat_first_table_read_failed');
    expect(GAME_SERVER).toContain('GameServer.seat_first_seat_read_failed');
  });
});

describe('the seat-first definition agrees everywhere (P1-2)', () => {
  it('both seat-first gates use the recorded fixed-format authority', () => {
    // The old `any sng` reading made every 3+ seat SNG a structural deadlock:
    // fn_take_seat_and_buy_in refused its seat sales as not_a_seat_first_game
    // while this gate waited for seats forever.
    const matches = GAME_SERVER.match(/isPersistedSeatFirst\(t(?:ournament)?\)/g);
    expect(matches?.length ?? 0, 'both the batch filter and the start gate').toBeGreaterThanOrEqual(
      2
    );
  });
});
