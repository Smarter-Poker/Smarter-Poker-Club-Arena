import { describe, expect, it } from 'vitest';
import type { HorseDecision } from '../../types.js';
import { HorsePolicyGraph, HORSE_POLICY_ORDER } from '../HorsePolicyGraph.js';
import { HorseLogic } from '../HorseLogic.js';
import { seedFastRandom } from '../HorseEval.js';
import { jointPolicyFixture } from '../multiway/JointRangeFixture.test-support.js';
import { horseDecisionReceiptIsValid } from './responseValidation.js';

function receipt(): HorseDecision {
  const graph = new HorsePolicyGraph(() => 0);
  let decision: HorseDecision = { action: 'raise', amount: 20, thinkTime: 1 };
  for (const node of HORSE_POLICY_ORDER) {
    decision = graph.run(node, node === 'reference' ? null : decision, () => ({
      decision,
    })).decision;
  }
  return graph.finish(decision);
}

describe('bounded Horse response receipt validation', () => {
  it('accepts a structured clone of an executable graph without mutating it', () => {
    const d = structuredClone(receipt());
    const before = JSON.stringify(d);
    expect(horseDecisionReceiptIsValid(d)).toBe(true);
    expect(JSON.stringify(d)).toBe(before);
  });
  it('preserves legacy graph absence without inventing a graph receipt', () => {
    const d = { action: 'fold', thinkTime: 0 };
    expect(horseDecisionReceiptIsValid(d)).toBe(true);
    expect(d).not.toHaveProperty('policyGraph');
  });
  it.each(['check', 'fold'] as const)('accepts explicit caught-brain %s fallback', (action) => {
    expect(
      horseDecisionReceiptIsValid({ action, thinkTime: 1500, policyFallback: 'brain_exception' })
    ).toBe(true);
  });
  it.each([
    null,
    [],
    {},
    { action: 'discard', thinkTime: 1 },
    { action: 'unknown', thinkTime: 1 },
    { action: 'call', thinkTime: -1 },
    { action: 'call', thinkTime: NaN },
    { action: 'call', thinkTime: Infinity },
    { action: 'raise', thinkTime: 0, amount: -1 },
    { action: 'raise', thinkTime: 0, amount: NaN },
    { action: 'raise', thinkTime: 0, amount: Infinity },
    { action: 'call', thinkTime: 0, policyFallback: 'unknown' },
    { action: 'raise', amount: 20, thinkTime: 0, policyFallback: 'brain_exception' },
    { action: 'fold', amount: 0, thinkTime: 0, policyFallback: 'brain_exception' },
    { action: 'fold', thinkTime: 0, policyFallback: 'brain_exception', policyGraph: {} },
    { action: 'fold', thinkTime: 0, policyGraph: null },
  ])('rejects malformed decision %j', (value) => {
    expect(horseDecisionReceiptIsValid(value)).toBe(false);
  });
  it.each(HORSE_POLICY_ORDER.map((node, index) => ({ node, index })))(
    'checks continuity, owner, fields and duration at $node',
    ({ index }) => {
      for (const fault of [
        'owner',
        'before',
        'after',
        'changed',
        'negative_time',
        'nan_time',
        'private',
      ]) {
        const d = receipt();
        const t = d.policyGraph!.transitions[index] as any;
        if (fault === 'owner') t.node = 'unknown';
        if (fault === 'before') t.before = index === 0 ? { action: 'raise', amount: 20 } : null;
        if (fault === 'after') t.after = { action: 'invalid', amount: null };
        if (fault === 'changed') t.changed = true;
        if (fault === 'negative_time') t.elapsedMs = -1;
        if (fault === 'nan_time') t.elapsedMs = NaN;
        if (fault === 'private') t.cards = ['private'];
        expect(horseDecisionReceiptIsValid(d), `${index}:${fault}`).toBe(false);
      }
    }
  );
  it.each([
    'version',
    'missing',
    'extra',
    'array',
    'root_private',
    'action_private',
    'final_action',
    'final_size',
    'selected_size',
    'timing_override',
  ] as const)('rejects graph %s', (fault) => {
    const d = receipt();
    const g = d.policyGraph! as any;
    if (fault === 'version') g.version = 'unrecognized';
    if (fault === 'missing') g.transitions.pop();
    if (fault === 'extra') g.transitions.push(g.transitions[7]);
    if (fault === 'array') g.transitions = {};
    if (fault === 'root_private') g.seed = 123;
    if (fault === 'action_private') g.transitions[0].after.cards = ['private'];
    if (fault === 'final_action') g.finalAction.action = 'fold';
    if (fault === 'final_size') g.finalAction.amount = 19;
    if (fault === 'selected_size') d.amount = 19;
    if (fault === 'timing_override') {
      g.transitions[7].after.amount = 19;
      g.transitions[7].changed = true;
      g.finalAction.amount = 19;
      d.amount = 19;
    }
    expect(horseDecisionReceiptIsValid(d)).toBe(false);
  });
  it('accepts an honestly recorded action change before the timing owner', () => {
    const graph = new HorsePolicyGraph(() => 0);
    let d: HorseDecision | null = null;
    for (const node of HORSE_POLICY_ORDER) {
      const next: HorseDecision =
        node === 'reference'
          ? { action: 'raise', amount: 20, thinkTime: 1 }
          : { action: 'call', amount: 2, thinkTime: 1 };
      d = graph.run(node, d, () => ({ decision: next })).decision;
    }
    expect(horseDecisionReceiptIsValid(graph.finish(d!))).toBe(true);
  });
  it.each([
    'nlh',
    'plo4',
    'plo5',
    'plo6',
    'plo8',
    'flh',
    'flo8',
    'pineapple',
    'short_deck',
  ] as const)('%s actual brain output validates on every betting street', (variant) => {
    for (const street of ['preflop', 'flop', 'turn', 'river'] as const) {
      const { hero, state } = jointPolicyFixture(variant, 1, 'cash', street);
      seedFastRandom(1500921);
      const d = HorseLogic.decide(
        hero,
        state,
        'balanced',
        {},
        { mind: false, telemetry: false, decisionTimeMs: 0 }
      );
      expect(d.policyFallback).toBeUndefined();
      expect(d.policyGraph?.transitions).toHaveLength(8);
      expect(horseDecisionReceiptIsValid(d), `${variant}:${street}`).toBe(true);
    }
  });
});
