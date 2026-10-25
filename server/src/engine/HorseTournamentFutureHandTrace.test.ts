/**
 * The Phase 8 future-hand trace (2026-10-24) is a speed change only: a hand in
 * which no stack bounded any amount is replayed for a deeper start instead of
 * re-dealt. These tests prove it returns exactly the result, bit for bit, the
 * full rollout returns for the same inputs, across stacks that do and do not
 * qualify, every ante type, both seat orders and every declared sample.
 */
import { describe, expect, it } from 'vitest';
import type { SeatPlayer } from '../types.js';
import {
  simulateTournamentFutureHands,
  prepareTournamentFutureHandFacts,
  type FutureBlindLevel,
  type FutureHandTraceCache,
} from './HorseTournamentFutureHand.js';
import { CONTINUATION_POLICY } from './HorseTournamentContinuation.js';

const seat = (i: number, seatNumber: number): SeatPlayer => ({
  user_id: `p${i}`,
  username: `p${i}`,
  seat: seatNumber,
  stack: 0,
  cards: [],
  bet: 0,
  totalInvested: 0,
  is_folded: false,
  is_all_in: false,
  is_sitting_out: false,
});

/** Bit-exact comparison: Object.is on every number, key order included. */
const bits = (value: unknown) =>
  JSON.stringify(value, (_k, v) =>
    typeof v === 'number' ? (Object.is(v, -0) ? '-0' : `${v}`) : v
  );

function random(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

describe('Phase 8 future-hand trace replay', () => {
  prepareTournamentFutureHandFacts();
  const levels: FutureBlindLevel[] = [
    { smallBlind: 5, bigBlind: 10, ante: 0, anteType: 'none' },
    { smallBlind: 10, bigBlind: 20, ante: 3, anteType: 'per_player' },
    { smallBlind: 25, bigBlind: 50, ante: 50, anteType: 'big_blind' },
  ];

  it('returns the full rollout result exactly, for every stack, level and sample', () => {
    const next = random(8101101);
    let replayed = 0;
    let compared = 0;
    for (const seats of [2, 3]) {
      for (const shuffled of [false, true]) {
        const numbers = Array.from({ length: seats }, (_, i) => i + 1);
        if (shuffled) numbers.reverse();
        const players = numbers.map((n, i) => seat(i, n));
        const localIndex = new Map(players.map((p, i) => [p.user_id, i + 2]));
        for (const level of levels) {
          for (let dealer = 1; dealer <= seats; dealer++) {
            // One decision-local cache per (players, level set) as the utility
            // owns one per action; stacks vary from all-in-short to very deep.
            const traceCache: FutureHandTraceCache = new Map();
            for (let trial = 0; trial < 60; trial++) {
              const sampleIndex = Math.floor(next() * CONTINUATION_POLICY.maxOutcomeSamples);
              const vector = [1234, 5678];
              for (let i = 0; i < seats; i++)
                vector.push(
                  next() < 0.2
                    ? Math.floor(next() * level.bigBlind * 4)
                    : Math.floor(level.bigBlind * (5 + next() * 300))
                );
              const args = {
                players,
                vector,
                localIndex,
                heroId: 'p0',
                dealerSeat: dealer,
                level,
                sampleIndex,
              };
              const before = traceCache.size;
              const cold = simulateTournamentFutureHands({ ...args, drawCache: new Map() });
              const warm = simulateTournamentFutureHands({
                ...args,
                drawCache: new Map(),
                traceCache,
              });
              expect(bits(warm)).toBe(bits(cold));
              // A second call may replay the trace the first one recorded.
              const again = simulateTournamentFutureHands({ ...args, traceCache });
              expect(bits(again)).toBe(bits(cold));
              if (traceCache.size === before) replayed++;
              compared++;
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
    expect(replayed).toBeGreaterThan(100);
  });

  it('never records a hand a stack bounded (short stack, all in, bust)', () => {
    const players = [seat(0, 1), seat(1, 2), seat(2, 3)];
    const localIndex = new Map(players.map((p, i) => [p.user_id, i]));
    const level = levels[0];
    for (let sampleIndex = 0; sampleIndex < CONTINUATION_POLICY.maxOutcomeSamples; sampleIndex++) {
      const traceCache: FutureHandTraceCache = new Map();
      const args = {
        players,
        vector: [3, 10_000, 10_000],
        localIndex,
        heroId: 'p0',
        dealerSeat: 1,
        level,
        sampleIndex,
        traceCache,
      };
      const first = simulateTournamentFutureHands(args)!;
      // The 3-chip seat cannot fund a full blind or open: never a trace.
      expect(traceCache.size).toBe(0);
      expect(bits(simulateTournamentFutureHands({ ...args, traceCache: undefined }))).toBe(
        bits(first)
      );
    }
  });

  it('is not used under an optional deadline', () => {
    const players = [seat(0, 1), seat(1, 2)];
    const traceCache: FutureHandTraceCache = new Map();
    simulateTournamentFutureHands({
      players,
      vector: [5000, 5000],
      localIndex: new Map(players.map((p, i) => [p.user_id, i])),
      heroId: 'p0',
      dealerSeat: 1,
      level: levels[0],
      sampleIndex: 3,
      withinBudget: () => true,
      traceCache,
    });
    expect(traceCache.size).toBe(0);
  });
});
