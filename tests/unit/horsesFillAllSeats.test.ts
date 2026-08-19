/**
 * POLICY (Dan, 2026-08-19): HORSES FILL EVERY SEAT — SNG, Spin and MTT.
 *
 * "FOR NOW, TOURNAMENTS CAN ALWAYS BE SEATED BY ALL HORSES, RIGHT NOW WE HAVE
 *  ZERO REAL USERS... SO ALLOW HORSES TO FILL ALL SEATS FOR SIT N GO'S AND MTT
 *  AND SPINS"
 *
 * The old rule held ONE seat open for a human on 9 of every 10 SNG/Spins (only
 * every 10th was a full-horse game). With no real users that seat was never
 * taken, so nine in ten games sat one short until a timer cancelled them —
 * 557 of 562 cancellations over two days were exactly one player short.
 *
 * SAFETY INVARIANT that makes full-field filling possible: registerHorses must
 * exclude horses already sitting at an open table. `horse_status` is never
 * flipped when a horse takes a CASH seat — measured at the time of the fix:
 * 574 horses existed, 329 were seated at open tables, and all 574 still read
 * horse_status='available'. Without the seat check, filling every seat would
 * pull horses out of hands they were already playing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const RECURRING = readFileSync(
  resolve(__dirname, '../../server/src/services/TournamentRecurringService.ts'),
  'utf8'
);
const GAME_SERVER = readFileSync(resolve(__dirname, '../../server/src/GameServer.ts'), 'utf8');

const seatPlanFn = RECURRING.slice(
  RECURRING.indexOf('function horsesForSeatHeldGame'),
  RECURRING.indexOf('const SNG_CONFIGS')
);

describe('SNG and Spin fill every seat', () => {
  it('no seat is held back for a human while the flag is off', () => {
    expect(RECURRING).toMatch(/const HOLD_SEAT_FOR_HUMAN = false;/);
  });

  it('the seat plan returns a full field, not maxPlayers - 1', () => {
    expect(seatPlanFn).toMatch(/return \{ horses: maxPlayers, isSim: true \}/);
  });

  it('the every-10th-game workaround is gone', () => {
    // A sampling counter cannot be the thing that decides whether a game runs.
    expect(RECURRING).not.toContain('FULL_HORSE_SIM_EVERY_N');
    expect(RECURRING).not.toContain('sngSpinCreationCounter');
  });

  it('the reserved seat can be restored by flipping one flag', () => {
    expect(seatPlanFn).toMatch(/if \(!HOLD_SEAT_FOR_HUMAN\)/);
    expect(seatPlanFn).toMatch(/maxPlayers - 1/);
  });
});

describe('MTTs seed a full field too', () => {
  it('creation targets maxPlayers, not just horsesToRegister', () => {
    expect(RECURRING).toMatch(/Math\.max\(config\.horsesToRegister,\s*config\.maxPlayers\)/);
  });

  it('the runtime top-up aims at max_players for every format', () => {
    const fill = GAME_SERVER.slice(
      GAME_SERVER.indexOf('const isPastStart'),
      GAME_SERVER.indexOf('// SNG / Spin: start ONLY when max_players reached')
    );
    expect(fill).toMatch(/tournament\.max_players > 0 \? tournament\.max_players : minPlayers/);
    // The old SNG-only branch must be gone.
    expect(fill).not.toContain('isSngOrSpinFill');
  });
});

describe('filling seats cannot strip live cash tables', () => {
  const start = RECURRING.indexOf('private async registerHorses');
  const registerFn = RECURRING.slice(start, start + 3000);

  it('excludes horses already seated at an open table', () => {
    expect(registerFn).toContain("from('table_seats')");
    expect(registerFn).toContain("is('left_at', null)");
    expect(registerFn).toMatch(
      /\.in\(\s*'tables\.status'\s*,\s*\[[^\]]*'waiting'[^\]]*'running'[^\]]*\]/
    );
  });

  it('merges seated horses into the same busy set used to filter the pool', () => {
    expect(registerFn).toMatch(/busyIds\.add\(/);
    expect(registerFn).toMatch(/filter\(\(h\) => !busyIds\.has\(h\.id\)\)/);
  });

  it('still excludes horses busy in another live tournament', () => {
    expect(registerFn).toContain("from('tournament_players')");
    expect(registerFn).toMatch(/\.in\(\s*'tournaments\.status'\s*,/);
  });
});
