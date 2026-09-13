import { afterEach, describe, expect, it } from 'vitest';
import type { Card } from '../types.js';
import {
  restoreFastRandom,
  saveFastRandom,
  seedFastRandom,
  simulateEquity,
  variantInfo,
  type HorseEquityOutcomeCollector,
} from './HorseEval.js';

const saved = saveFastRandom();
afterEach(() => restoreFastRandom(saved));
const cards = (text: string): Card[] =>
  text.split(' ').map((s) => ({
    rank: s.slice(0, -1),
    suit: ({ s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' } as const)[
      s.at(-1)! as 's' | 'h' | 'd' | 'c'
    ],
  })) as Card[];

describe('known Pineapple discards never return to the sampled deck', () => {
  it('preserves existing equity and random work when no dead cards are supplied', () => {
    const run = (explicit: boolean) => {
      seedFastRandom(1200912);
      const outcomes: HorseEquityOutcomeCollector = { maxSamples: 128, samples: [] };
      const result = simulateEquity(
        cards('As Kd'),
        cards('7c 8h Qd'),
        3,
        variantInfo('nlh'),
        128,
        undefined,
        false,
        undefined,
        undefined,
        outcomes,
        explicit ? [] : undefined
      );
      return { result, outcomes, randomState: saveFastRandom() };
    };
    expect(run(true)).toEqual(run(false));
  });
  it('cannot draw the fourth nine after the hero discarded it', () => {
    const oldPopulation: HorseEquityOutcomeCollector = { maxSamples: 2048, samples: [] };
    seedFastRandom(1200911);
    simulateEquity(
      cards('9s 9d'),
      cards('9c Kd Qh Jh'),
      1,
      variantInfo('nlh'),
      2048,
      undefined,
      false,
      undefined,
      undefined,
      oldPopulation
    );
    expect(oldPopulation.samples.some((s) => Math.floor(s.heroHigh / 2 ** 20) === 8)).toBe(true);
    const outcomes: HorseEquityOutcomeCollector = { maxSamples: 2048, samples: [] };
    seedFastRandom(1200911);
    simulateEquity(
      cards('9s 9d'),
      cards('9c Kd Qh Jh'),
      1,
      variantInfo('nlh'),
      2048,
      undefined,
      false,
      undefined,
      undefined,
      outcomes,
      cards('9h')
    );
    expect(outcomes.samples.length).toBeGreaterThan(100);
    // The runtime's category eight is four of a kind.
    // No unseen river can make four nines when all four are already known.
    expect(outcomes.samples.some((s) => Math.floor(s.heroHigh / 2 ** 20) === 8)).toBe(false);
  });
});
