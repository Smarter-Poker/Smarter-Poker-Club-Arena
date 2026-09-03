import { describe, it, expect } from 'vitest';
import {
  detectBots,
  computeTimingStats,
  binnedEntropyBits,
  stdDev,
  extractDecisionLatencies,
} from './BotDetector.js';
import type { NormalizedAction, NormalizedHand } from './types.js';

function mkAction(userId: string, latencyMs: number, i: number): NormalizedAction {
  return {
    handId: `h${i}`,
    tableId: 't1',
    userId,
    seat: 0,
    street: 'flop',
    action: 'call',
    amount: 10,
    timestamp: 1000 + i,
    latencyMs,
    forced: false,
  };
}

/** Build one hand per action to keep it simple; detector aggregates by user. */
function handsFromLatencies(userId: string, latencies: number[]): NormalizedHand[] {
  return latencies.map((lat, i) => ({
    handId: `h${userId}${i}`,
    tableId: 't1',
    gameVariant: 'nlhe',
    smallBlind: 5,
    bigBlind: 10,
    potSize: 100,
    rake: 0,
    communityCards: [],
    startedAt: 0,
    endedAt: 0,
    players: [{ userId, seat: 0, startingStack: 1000, cards: [] }],
    winners: [],
    actions: [mkAction(userId, lat, i)],
  }));
}

describe('math helpers', () => {
  it('stdDev of constant list is 0', () => {
    expect(stdDev([5, 5, 5, 5])).toBe(0);
  });
  it('binnedEntropy: single bin => 0 entropy', () => {
    const { entropy, occupiedBins } = binnedEntropyBits([100, 110, 120], 250);
    expect(occupiedBins).toBe(1);
    expect(entropy).toBe(0);
  });
  it('binnedEntropy: two equal bins => 1 bit', () => {
    const { entropy, occupiedBins } = binnedEntropyBits([100, 100, 600, 600], 250);
    expect(occupiedBins).toBe(2);
    expect(entropy).toBeCloseTo(1);
  });
});

describe('detectBots', () => {
  it('flags a metronomic bot (low entropy + low variance + fixed cadence)', () => {
    // 20 near-identical latencies around 2000ms
    const botLat = Array.from({ length: 20 }, (_, i) => 2000 + (i % 3) - 1); // 1999..2001
    const flags = detectBots(handsFromLatencies('bot1', botLat));
    expect(flags).toHaveLength(1);
    expect(flags[0].userIds).toEqual(['bot1']);
    expect(flags[0].score).toBeGreaterThan(0.8);
    expect(flags[0].severity).toBe('high');
  });

  it('does NOT flag a human with varied timing', () => {
    // wide spread, human-like
    const humanLat = [
      800, 3200, 1500, 6000, 900, 12000, 2100, 450, 8000, 1700, 5400, 300, 9500, 2800, 640, 4100,
      11000, 1200, 7300, 520,
    ];
    const flags = detectBots(handsFromLatencies('human1', humanLat));
    expect(flags).toHaveLength(0);
  });

  it('respects minSamples gating', () => {
    const flags = detectBots(handsFromLatencies('few', [2000, 2000, 2000]));
    expect(flags).toHaveLength(0);
  });

  it('computeTimingStats reports normalized entropy near 0 for a bot', () => {
    const stats = computeTimingStats(
      'b',
      Array.from({ length: 30 }, () => 2000)
    );
    expect(stats.cv).toBe(0);
    expect(stats.normalizedEntropy).toBe(0);
    expect(stats.modalCadenceFraction).toBe(1);
  });

  it('extractDecisionLatencies skips forced and zero-latency actions', () => {
    const hands: NormalizedHand[] = [
      {
        handId: 'h1',
        tableId: 't1',
        gameVariant: 'nlhe',
        smallBlind: 5,
        bigBlind: 10,
        potSize: 0,
        rake: 0,
        communityCards: [],
        startedAt: 0,
        endedAt: 0,
        players: [{ userId: 'u', seat: 0, startingStack: 0, cards: [] }],
        winners: [],
        actions: [
          { ...mkAction('u', 0, 0), action: 'post_blind', forced: true, latencyMs: 0 },
          { ...mkAction('u', 0, 1) }, // latency 0 -> skipped
          { ...mkAction('u', 1500, 2) },
        ],
      },
    ];
    const map = extractDecisionLatencies(hands);
    expect(map.get('u')).toEqual([1500]);
  });
});
