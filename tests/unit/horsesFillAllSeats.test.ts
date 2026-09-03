/**
 * POLICY (Dan, 2026-08-21 — supersedes 2026-08-19's "fill every seat"):
 * "the tables just stay open until players sit down, they don't need to be
 * scheduled just always running."
 *
 * SNG and Spin games are created with a HELD SEAT (field minus one horse) and
 * genuinely wait — OPEN_TABLE_WAIT_MS, not the old 60s — for a human to take
 * it. The 2026-08-19 policy this file used to pin ("no seat held back") was a
 * response to 557 cancellations of one-short games; that hazard is gone
 * because the cancel path itself was removed ("TOURNAMENTS RUN. THEY DO NOT
 * CANCEL") and GameServer's past-start top-up fills any short game once its
 * start time passes. Open first, churn second.
 *
 * This test pins the CURRENT policy so a stray revert of the flag (or of the
 * wait window, or of the top-up safety valve) fails loudly with this context
 * attached.
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

describe('SNG and Spin hold a seat for a human (open-board policy)', () => {
  it('the hold-seat flag is ON', () => {
    expect(RECURRING).toMatch(/const HOLD_SEAT_FOR_HUMAN = true;/);
  });

  it('the seat plan holds exactly one seat when the flag is on', () => {
    // horsesForSeatHeldGame: flag on -> maxPlayers - 1 horses, not a full field.
    expect(seatPlanFn).toMatch(/Math\.max\(1,\s*maxPlayers\s*-\s*1\)/);
  });

  it('an open table waits minutes, not seconds', () => {
    // 60s was "a scheduled game with extra steps". The wait is a named
    // constant of at least several minutes.
    const m = RECURRING.match(/const OPEN_TABLE_WAIT_MS = (\d+) \* 60 \* 1000;/);
    expect(m, 'OPEN_TABLE_WAIT_MS missing').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(5);
  });

  it('the safety valve stands: past-start games are topped up, never cancelled', () => {
    expect(GAME_SERVER).toMatch(/topUpWithHorses\(/);
    // The cancel-short-games branch must never return: its removal is the
    // reason holding a seat is safe.
    expect(GAME_SERVER).not.toMatch(/cancelTournament\(.+short/i);
  });

  it('SAFETY INVARIANT: horse fill still excludes horses already seated at open tables', () => {
    // Without the seat check, filling would pull horses out of live cash hands.
    expect(RECURRING).toMatch(/left_at/);
  });
});
