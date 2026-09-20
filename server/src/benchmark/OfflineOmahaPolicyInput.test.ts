import { describe, expect, it } from 'vitest';
import { evaluatePlo4Policy, type Plo4PolicyInput } from './Plo4PolicyProgram.js';
import { evaluateOmahaVariantProgram } from './OmahaVariantPolicyProgram.js';
import { plo4ReferenceSpot } from './Plo4PolicyEvidence.js';
import { omahaVariantReferenceSpots } from './OmahaVariantPolicyEvidence.js';

const variants = ['plo4', 'plo5', 'plo6', 'plo8'] as const;
type Variant = (typeof variants)[number];
function inputFor(variant: Variant): Plo4PolicyInput {
  if (variant === 'plo4') return plo4ReferenceSpot('royal_flush');
  return structuredClone(
    omahaVariantReferenceSpots().find(
      (spot) =>
        spot.name === (variant === 'plo8' ? 'plo8-no-low-whole-high' : `${variant}-royal-value`)
    )!.input
  );
}
function evaluate(input: Plo4PolicyInput, shouldContinue?: () => boolean) {
  return input.state.gameVariant === 'plo4'
    ? evaluatePlo4Policy(input, shouldContinue)
    : evaluateOmahaVariantProgram(input, shouldContinue);
}
function withoutClocks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutClocks);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'elapsedMs')
        .map(([key, item]) => [key, withoutClocks(item)])
    );
  return value;
}

describe('offline Omaha policy owns an admitted public projection', () => {
  it.each(variants)(
    '%s cannot combine oracle evidence with caller-mutated later policy inputs',
    async (variant) => {
      const input = inputFor(variant);
      const expected = await evaluate(structuredClone(input));
      let checks = 0;
      const result = await evaluate(input, () => {
        if (++checks === 2) {
          input.hero.cards[0].rank = '2';
          input.hero.stack = 1;
          input.state.communityCards[0].rank = '9';
          input.state.legalActions!.splice(0, input.state.legalActions!.length, 'fold');
          input.state.rakeConfig!.percent = 10;
          input.state.actionHistory![0].action = 'fold';
          input.baseline.action = 'fold';
          input.baseline.amount = 999;
          input.opponentRanges = undefined;
        }
        return true;
      });
      expect(checks).toBeGreaterThanOrEqual(2);
      expect(withoutClocks(result)).toEqual(withoutClocks(expected));
    }
  );

  it.each(variants)(
    '%s never reads unrelated opponent private cards or an opaque execution witness',
    async (variant) => {
      const input = inputFor(variant);
      const expected = await evaluate(structuredClone(input));
      const forbidden = () => {
        throw Error('private field was read');
      };
      for (const player of input.state.players) {
        Object.defineProperty(player, 'cards', { enumerable: true, get: forbidden });
        Object.defineProperty(player, 'knownDeadCards', { enumerable: true, get: forbidden });
        Object.defineProperty(player, 'unrelatedFunction', { enumerable: true, get: forbidden });
      }
      Object.defineProperty(input.baseline, 'executionWitness', {
        enumerable: true,
        get: forbidden,
      });
      Object.defineProperty(input.state, 'unrelatedPrivateState', {
        enumerable: true,
        get: forbidden,
      });
      Object.defineProperty(input.hero, 'unrelatedPrivateState', {
        enumerable: true,
        get: forbidden,
      });
      expect(withoutClocks(await evaluate(input))).toEqual(withoutClocks(expected));
    }
  );

  it.each(variants)(
    '%s off-mode baseline evidence stays detached after return',
    async (variant) => {
      const input = inputFor(variant);
      input.mode = 'off';
      const before = structuredClone(input.baseline);
      const result = await evaluate(input);
      expect(result.selected).toEqual(before);
      expect(result.selected).not.toBe(input.baseline);
      input.baseline.action = 'fold';
      input.baseline.amount = 999;
      expect(result.selected).toEqual(before);
    }
  );

  it.each(['plo4', 'plo5'] as const)(
    '%s captures seed/sample controls before even the first cancellation callback',
    async (variant) => {
      const input = inputFor(variant);
      const expected = await evaluate(structuredClone(input));
      const result = await evaluate(input, () => {
        input.seed = 0;
        input.samples = 129;
        return true;
      });
      expect(withoutClocks(result)).toEqual(withoutClocks(expected));
    }
  );

  it.each(['plo4', 'plo5'] as const)(
    '%s preserves existing off and unavailable-rake fallback behavior',
    async (variant) => {
      const input = inputFor(variant);
      (input.state as any).rakeConfig = null;
      expect((await evaluate(input)).reason).toBe('rake_schedule_unavailable');
      input.mode = 'off';
      (input.hero as any).cards = null;
      (input.state as any).communityCards = null;
      const result = await evaluate(input);
      expect(result.reason).toBe('off');
      expect(result.selected).toEqual(input.baseline);
      expect(result.selected).not.toBe(input.baseline);
    }
  );
});
