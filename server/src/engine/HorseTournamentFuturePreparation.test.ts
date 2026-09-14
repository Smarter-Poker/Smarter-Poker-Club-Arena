import { describe, expect, it, vi } from 'vitest';
import type { SeatPlayer } from '../types.js';

describe('worker preparation of the fixed future-hand population', () => {
  it('prepares every supported draw once and preserves lazy settlements and caller ownership', async () => {
    vi.resetModules();
    const lazy = await import('./HorseTournamentFutureHand.js');
    const cases = [];
    for (let sampleIndex = 0; sampleIndex < 32; sampleIndex++) {
      for (let seats = 2; seats <= 10; seats++) {
        for (const anteType of ['none', 'per_player', 'big_blind'] as const) {
          const players: SeatPlayer[] = Array.from({ length: seats }, (_, i) => ({
            user_id: `seat-${i}`,
            username: `seat-${i}`,
            seat: i + 1,
            stack: i === 1 ? 7 : 101 + i * 39,
            cards: [],
            bet: 0,
            totalInvested: 0,
            is_folded: false,
            is_all_in: false,
            is_sitting_out: false,
          }));
          cases.push({
            players,
            vector: players.map((p) => p.stack),
            localIndex: new Map(players.map((p, i) => [p.user_id, i])),
            heroId: 'seat-0',
            dealerSeat: (sampleIndex % seats) + 1,
            sampleIndex,
            level: { smallBlind: 5, bigBlind: 10, ante: 3, anteType },
          });
        }
      }
    }
    const expected = cases.map((args) => lazy.simulateTournamentFutureHands(args));
    expect(expected.every((result) => result !== null && result.conservationError <= 0.005)).toBe(
      true
    );

    vi.resetModules();
    const prepared = await import('./HorseTournamentFutureHand.js');
    const evaluator = await import('./HorseEval.js');
    const score = vi.spyOn(evaluator, 'scoreHoldem');
    try {
      prepared.prepareTournamentFutureHandFacts();
      // 32 draws * (2 + ... + 10 seats) * three street scores and showdown.
      expect(score).toHaveBeenCalledTimes(32 * 54 * 4);
      prepared.prepareTournamentFutureHandFacts();
      expect(score).toHaveBeenCalledTimes(32 * 54 * 4);
      score.mockClear();
      cases.forEach((args, index) => {
        const original = structuredClone(args);
        const result = prepared.simulateTournamentFutureHands(args);
        expect(result).toEqual(expected[index]);
        expect(args).toEqual(original);
      });
      expect(score).not.toHaveBeenCalled();

      // Preparation does not absorb unsupported indices into a growing cache.
      const outside = { ...cases[0], sampleIndex: 32 };
      expect(prepared.simulateTournamentFutureHands(outside)).toEqual(
        lazy.simulateTournamentFutureHands(outside)
      );
      const firstCalls = score.mock.calls.length;
      expect(firstCalls).toBeGreaterThan(0);
      prepared.simulateTournamentFutureHands(outside);
      expect(score).toHaveBeenCalledTimes(firstCalls * 2);
    } finally {
      score.mockRestore();
    }
  });
});
