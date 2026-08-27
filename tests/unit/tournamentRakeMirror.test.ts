/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT RAKE — the two buyIn copies must agree, in cents
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-26 settlement-integrity audit: the client copy of clampRakeToCap
 * (src/utils/buyIn.ts) moved to CENTS on 2026-08-25 with Dan's fractional-fee
 * rule ("1 buy in ... should be .10 rake"), but the server copy
 * (server/src/config/buyIn.ts) kept rounding the fee to a whole chip — so any
 * server-side pass silently stripped the 0.10 off a 1-chip game. The same
 * whole-chip cap survived in ScheduledTournamentService's restart re-cut,
 * which un-fee'd every restarted micro-stakes event.
 *
 * These tests pin the two copies to each other across the whole ladder, so
 * the next mirror drift is a red test instead of a slow revenue leak.
 */
import { describe, it, expect } from 'vitest';
import * as client from '../../src/utils/buyIn';
import * as server from '../../server/src/config/buyIn';

describe('server buyIn mirrors client buyIn', () => {
  it('splitBuyIn agrees on every ladder rung', () => {
    for (const total of client.BUY_IN_LADDER) {
      expect(server.splitBuyIn(total)).toEqual(client.splitBuyIn(total));
    }
  });

  it('clampRakeToCap agrees, cents included', () => {
    const cases: Array<[number, number]> = [
      [0.9, 0.1], // the 1-chip game the server copy used to strip to 0 fee
      [4.5, 0.5], // 5-chip game, 0.50 fee
      [13, 2], // over-cap 15 game -> re-cut to 13.5 + 1.5
      [18, 2], // exact 10% passes through
      [22, 3], // legacy 12% split -> re-cut
      [0, 0],
    ];
    for (const [prize, fee] of cases) {
      expect(server.clampRakeToCap(prize, fee)).toEqual(client.clampRakeToCap(prize, fee));
    }
  });

  it('micro fees survive the server clamp (Dan 2026-08-25: fractional fees allowed)', () => {
    expect(server.clampRakeToCap(0.9, 0.1)).toEqual({ prize: 0.9, fee: 0.1 });
    expect(server.clampRakeToCap(4.5, 0.5)).toEqual({ prize: 4.5, fee: 0.5 });
  });

  it('the clamp never changes what the player pays and never exceeds 10%', () => {
    for (const [prize, fee] of [
      [0.9, 0.1],
      [13, 2],
      [22, 3],
      [95, 15],
    ] as Array<[number, number]>) {
      const out = server.clampRakeToCap(prize, fee);
      expect(Math.round((out.prize + out.fee) * 100) / 100).toBe(Math.round(prize + fee));
      expect(server.isRakeWithinCap(out.prize, out.fee)).toBe(true);
    }
  });
});
