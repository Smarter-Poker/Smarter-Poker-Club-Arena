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
  it('the three rate constants are identical in both copies (Dan 2026-08-25)', () => {
    // SNG_RAKE_RATE was replaced on 2026-08-27: it named a FORMAT, and the
    // format label is exactly the thing that varied between the six writers.
    // The rate is keyed on seats now, and lives in both copies identically.
    expect(server.HEADS_UP_RAKE_RATE).toBe(0.05);
    expect(client.HEADS_UP_RAKE_RATE).toBe(server.HEADS_UP_RAKE_RATE);
    expect(server.DEFAULT_RAKE_RATE).toBe(0.1);
    expect(client.DEFAULT_RAKE_RATE).toBe(server.DEFAULT_RAKE_RATE);
    // A Spin's rake is engineered into its multiplier table, so its buy_in_fee
    // is 0 and a database constraint refuses anything else.
    expect(server.SPIN_RAKE_RATE).toBe(0);
    expect(client.SPIN_RAKE_RATE).toBe(server.SPIN_RAKE_RATE);

    // A Heads-Up 50 is 47.50 + 2.50, never 45 + 5 — the split every creator
    // (recurring, scheduled, fn_create_tournament) must produce.
    expect(server.splitBuyIn(50, server.HEADS_UP_RAKE_RATE)).toEqual({
      total: 50,
      prize: 47.5,
      fee: 2.5,
    });
    // Dan's worked example: 1-chip duel -> 0.95 in, 0.05 to the house, twice.
    expect(server.splitBuyIn(1, server.HEADS_UP_RAKE_RATE)).toEqual({
      total: 1,
      prize: 0.95,
      fee: 0.05,
    });
  });

  it('rakeRateFor agrees and only fixed formats use heads-up seats', () => {
    const subjects = [
      { tournamentType: 'SNG', maxPlayers: 2 },
      { tournamentType: 'MTT', maxPlayers: 2 },
      { tournamentType: 'SATELLITE', variant: 'sng', maxPlayers: 2 },
      { tournamentType: 'SNG', variant: 'sng', maxPlayers: 2, satellite_target_id: 'target' },
      { tournamentType: 'sng', maxPlayers: 9 },
      { tournamentType: 'MTT', maxPlayers: 180 },
      { tournamentType: 'SPIN', maxPlayers: 3 },
      { variant: 'spin', maxPlayers: 3 },
      // The label says duel, the seat count says otherwise. Seats win.
      { variant: 'Heads-Up', maxPlayers: 9 },
      // Unknown / unlimited field size falls to the DEFAULT rate, never the
      // cheaper one: a misconfigured writer must not hand away margin.
      { tournamentType: 'SNG' },
      { tournamentType: 'MTT', maxPlayers: 0 },
      { tournamentType: 'MTT', maxPlayers: null },
    ];
    for (const s of subjects) {
      expect(client.rakeRateFor(s), JSON.stringify(s)).toBe(server.rakeRateFor(s));
    }
    expect(server.rakeRateFor({ tournamentType: 'MTT', maxPlayers: 2 })).toBe(0.1);
    expect(server.rakeRateFor({ variant: 'Heads-Up', maxPlayers: 9 })).toBe(0.1);
    expect(server.rakeRateFor({ tournamentType: 'SNG' })).toBe(0.1);
    expect(server.rakeRateFor({ tournamentType: 'MTT', maxPlayers: 0 })).toBe(0.1);
    expect(server.rakeRateFor({ tournamentType: 'SPIN', maxPlayers: 3 })).toBe(0);
  });

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
