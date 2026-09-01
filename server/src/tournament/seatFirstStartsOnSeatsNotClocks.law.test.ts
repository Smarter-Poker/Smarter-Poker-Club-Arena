import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isSeatFirstFormat } from '../services/TournamentRecurringService.js';
import { SPIN_SEATS } from '../config/spinSpec.js';
import { HEADS_UP_SEATS } from '../config/headsUpSpec.js';

/**
 * ═════════════════════════════════════════════════════════════════════════
 *  A SPIN OR A DUEL STARTS ON SEATS SOLD, NEVER ON A CLOCK
 * ═════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-01, verbatim: "SPINS AND HEADS UP DO NOT HAVE 'SCHEDULED
 * TIMES' THEY START WHEN 3 PLAYERS HAVE BOUGHT IN AND PAID FOR SPINS, AND
 * WHEN TWO PLAYERS FOR HEADS UP!"
 *
 * The engine already works this way, and production says so: over the six
 * hours to 12:50 UTC, 833 Spins and 358 heads-up games started, every single
 * one within a minute of its last seat being sold, none more than two minutes
 * after being full, and none sitting full and unstarted. This file exists so
 * that stays true. It was a property of one ternary in the discovery loop and
 * nothing was pinning it, so folding seat-first games into the scheduled-start
 * branch would have regressed silently.
 *
 * Two clocks DO legitimately touch these games, and neither is a start gate:
 *
 *   - the past-start horse top-up, which BUYS SEATS on a board that is not
 *     filling. It fills the game; it does not start it. The game still starts
 *     because the seats were paid for;
 *   - the stall watchdog (SEAT_FIRST_START_STALL_MS), which fires when a game
 *     is FULL and has not started, i.e. when this law has been broken.
 */

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('a seat-first game starts on seats, not on a clock', () => {
  it('knows a Spin and a duel by their shape', () => {
    expect(SPIN_SEATS).toBe(3);
    expect(HEADS_UP_SEATS).toBe(2);

    // A Spin is seat-first at any seat count; a duel is seat-first because it
    // is two-handed. Neither has a scheduled start.
    expect(isSeatFirstFormat('spin', SPIN_SEATS)).toBe(true);
    expect(isSeatFirstFormat('nlh', HEADS_UP_SEATS)).toBe(true);
    expect(isSeatFirstFormat('plo4', HEADS_UP_SEATS)).toBe(true);

    // A full-ring SNG and an MTT are not seat-first and are not covered here.
    expect(isSeatFirstFormat('nlh', 9)).toBe(false);
    expect(isSeatFirstFormat('nlh', 500)).toBe(false);
  });

  it('gates the start of a Spin or a duel on paid seats alone', () => {
    const src = read('src/GameServer.ts');

    // The whole law, in one line of the discovery loop.
    expect(src).toContain(
      'const shouldStart = isSngOrSpin ? seatFirstReady : maxReached || timeReached;'
    );

    // And `seatFirstReady` counts MONEY IN SEATS, not registrations:
    // current_players is a counter that is incremented on registration and
    // never decremented, and the live lobby has carried spins reading 3/3 with
    // two seats actually sold.
    const readySlice = src.slice(
      src.indexOf('const seatFirstReady ='),
      src.indexOf('const maxReached =')
    );
    expect(readySlice).toContain('paidSeats >= tournament.max_players');
    expect(readySlice).not.toContain('current_players');
    expect(readySlice).not.toContain('startTime');
  });

  it('never lets a scheduled start time reach a seat-first game', () => {
    const src = read('src/GameServer.ts');

    // `timeReached` may only be consulted on the non-seat-first side of the
    // ternary above. If a future change wires it into the seat-first branch,
    // this is the test that says so.
    const timeReachedUses = src.split('timeReached').length - 1;
    expect(timeReachedUses).toBe(2); // its declaration, and the MTT branch
    const seatFirstBranch = src.slice(
      src.indexOf('const seatFirstReady ='),
      src.indexOf('const shouldStart =')
    );
    expect(seatFirstBranch).not.toMatch(/isSngOrSpin[^\n]*timeReached/);
  });
});
