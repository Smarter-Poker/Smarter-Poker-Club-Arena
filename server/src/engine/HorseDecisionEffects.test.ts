import { describe, expect, it } from 'vitest';
import {
  horseDecisionEffectsAreValid,
  horseDecisionEffectsMatchRequest,
  horseMindHandKey,
} from './HorseDecisionEffects.js';
import { HorseMind } from './HorseMind.js';
import { horseReferenceWagerWasRetained } from './HorseDecisionEffects.js';
import { HorsePolicyGraph, HORSE_POLICY_ORDER } from './HorsePolicyGraph.js';
import type { HorseDecision } from '../types.js';
import type { ActionRecord } from '../types.js';

const plan = { type: 'plan', handKey: '12:poster', userId: 'horse-1', barrelIntent: true };
const outlook = {
  type: 'outlook',
  handKey: '12:poster',
  userId: 'horse-1',
  street: 'flop',
  good: ['Ah'],
  scare: ['Ks'],
};
const context = {
  userId: 'horse-1',
  history: [{ timestamp: 12, userId: 'poster' } as ActionRecord],
  street: 'flop',
  brainFallback: false,
};
describe('bounded Horse decision effect batches', () => {
  it.each(['bet', 'raise'] as const)(
    'retains %s plans only while the exact reference wager survives',
    (action) => {
      function decision(finalAction: HorseDecision['action'], finalAmount: number | undefined) {
        const graph = new HorsePolicyGraph(() => 0);
        let value: HorseDecision | null = null;
        for (const node of HORSE_POLICY_ORDER) {
          value = graph.run(node, value, () => ({
            decision:
              node === 'reference' || node === 'reference_legality'
                ? { action, amount: 10, thinkTime: 0 }
                : {
                    action: finalAction,
                    ...(finalAmount === undefined ? {} : { amount: finalAmount }),
                    thinkTime: 0,
                  },
          })).decision;
        }
        return graph.finish(value!);
      }
      expect(horseReferenceWagerWasRetained(decision(action, 10))).toBe(true);
      expect(horseReferenceWagerWasRetained(decision(action, 11))).toBe(false);
      expect(horseReferenceWagerWasRetained(decision('call', 10))).toBe(false);
      expect(horseReferenceWagerWasRetained(decision('check', undefined))).toBe(false);
      expect(
        horseReferenceWagerWasRetained({
          ...decision(action, 10),
          policyFallback: 'brain_exception',
        })
      ).toBe(false);
      expect(horseReferenceWagerWasRetained({ action, amount: 10, thinkTime: 0 })).toBe(false);
    }
  );
  it.each([
    null,
    {},
    [null],
    [{ ...plan, barrelIntent: 'true' }],
    [{ ...plan, handKey: '' }],
    [{ ...plan, userId: 'x'.repeat(257) }],
    [{ ...plan, privateCards: ['Ah'] }],
    [{ ...plan, type: 'unknown' }],
    [{ ...outlook, street: 'preflop' }],
    [{ ...outlook, street: 'river;drop' }],
    [{ ...outlook, good: ['XX'] }],
    [{ ...outlook, scare: ['Ah', 'Ah'] }],
    [{ ...outlook, good: null }],
    [{ ...outlook, good: Array(53).fill('Ah') }],
    [
      {
        type: 'raise_plan',
        handKey: '12:poster',
        userId: 'horse-1',
        street: 'flop',
        plan: 'raiseMore',
      },
    ],
    Array.from({ length: 17 }, () => plan),
  ])('refuses invalid writes before mutation: %j', (value) => {
    expect(horseDecisionEffectsAreValid(value)).toBe(false);
  });
  it('accepts the complete card universe, repeated valid plan updates and the exact batch ceiling', () => {
    const allCards = [...'23456789TJQKA'].flatMap((rank) => [...'cdhs'].map((suit) => rank + suit));
    expect(horseDecisionEffectsAreValid([{ ...outlook, good: allCards, scare: allCards }])).toBe(
      true
    );
    expect(horseDecisionEffectsAreValid(Array.from({ length: 16 }, () => plan))).toBe(true);
    expect(horseDecisionEffectsAreValid([])).toBe(true);
  });
  it('shares the actual plan reader hand key and binds every effect to its original request', () => {
    expect(horseMindHandKey(context.history)).toBe(HorseMind.handKeyOf(context.history));
    expect(horseDecisionEffectsMatchRequest([plan, outlook], context)).toBe(true);
    for (const changed of [
      { userId: 'horse-2' },
      { history: [] },
      { street: 'turn' },
      { brainFallback: true },
    ]) {
      expect(horseDecisionEffectsMatchRequest([plan, outlook], { ...context, ...changed })).toBe(
        false
      );
    }
    expect(
      horseDecisionEffectsMatchRequest([], { ...context, history: [], brainFallback: true })
    ).toBe(true);
  });
});
