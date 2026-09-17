import { describe, expect, it, vi } from 'vitest';
import { HorsePolicyGraph, HORSE_POLICY_ORDER } from './HorsePolicyGraph.js';
import { HorseLogic } from './HorseLogic.js';
import { seedFastRandom, saveFastRandom } from './HorseEval.js';
import { jointPolicyFixture } from './multiway/JointRangeFixture.test-support.js';
import type { HorseDecision } from '../types.js';

const check = (): HorseDecision => ({ action: 'check', thinkTime: 0 });
function completed() {
  const graph = new HorsePolicyGraph(() => 0);
  let decision: HorseDecision | null = null;
  for (const node of HORSE_POLICY_ORDER) {
    const selected: HorseDecision = node === 'reference' ? check() : decision!;
    decision = graph.run(node, decision, () => ({ decision: selected })).decision;
  }
  return { graph, decision: decision! };
}

describe('executable Horse policy order', () => {
  it('invokes each owner once and seals a bounded action-only trace', () => {
    const graph = new HorsePolicyGraph(() => 0);
    let decision: HorseDecision | null = null;
    let calls = 0;
    for (const node of HORSE_POLICY_ORDER) {
      decision = graph.run(node, decision, () => {
        calls++;
        return { decision: check() };
      }).decision;
    }
    const result = graph.finish(decision!);
    expect(calls).toBe(8);
    expect(result.policyGraph?.transitions.map((t) => t.node)).toEqual(HORSE_POLICY_ORDER);
    expect(result.policyGraph?.transitions.every((t) => t.elapsedMs === 0 && !t.changed)).toBe(
      true
    );
    expect(result.policyGraph?.finalAction).toEqual({ action: 'check', amount: null });
    expect(() => graph.finish(decision!)).toThrow('incomplete');
    expect(() => graph.run('reference', null, () => ({ decision: check() }))).toThrow(
      'out of order'
    );
  });
  it.each(HORSE_POLICY_ORDER.slice(1))('refuses to enter %s before its predecessors', (node) => {
    const execute = vi.fn(() => ({ decision: check() }));
    expect(() => new HorsePolicyGraph().run(node, null, execute)).toThrow('out of order');
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects a changed predecessor rather than accepting an unrecorded overwrite', () => {
    const graph = new HorsePolicyGraph();
    const decision = graph.run('reference', null, () => ({ decision: check() })).decision;
    decision.action = 'bet';
    decision.amount = 50;
    const execute = vi.fn(() => ({ decision }));
    expect(() => graph.run('reference_legality', decision, execute)).toThrow('predecessor');
    expect(execute).not.toHaveBeenCalled();
  });
  it('records an action-changing transition without retaining its mutable decision', () => {
    const graph = new HorsePolicyGraph(() => 0);
    const reference = check();
    graph.run('reference', null, () => ({ decision: reference }));
    let selected: HorseDecision = { action: 'bet', amount: 5, thinkTime: 0 };
    graph.run('reference_legality', reference, () => ({ decision: selected }));
    for (const node of HORSE_POLICY_ORDER.slice(2))
      selected = graph.run(node, selected, () => ({ decision: selected })).decision;
    const result = graph.finish(selected);
    reference.action = 'fold';
    selected.amount = 100;
    expect(result.policyGraph?.transitions[1]).toMatchObject({
      before: { action: 'check', amount: null },
      after: { action: 'bet', amount: 5 },
      changed: true,
    });
    expect(result.policyGraph?.finalAction).toEqual({ action: 'bet', amount: 5 });
  });
  it('prevents timing from reopening the chosen action', () => {
    const graph = new HorsePolicyGraph(() => 0);
    let decision: HorseDecision | null = null;
    for (const node of HORSE_POLICY_ORDER.slice(0, -1))
      decision = graph.run(node, decision, () => ({ decision: check() })).decision;
    expect(() =>
      graph.run('timing', decision, () => ({ decision: { action: 'all_in', thinkTime: 1 } }))
    ).toThrow('timing changed');
    expect(() => graph.finish(decision!)).toThrow('incomplete');
  });
  it('does not retry a failed owner or produce a completed receipt', () => {
    const graph = new HorsePolicyGraph(() => 0);
    expect(() =>
      graph.run('reference', null, () => {
        throw Error('owner failure');
      })
    ).toThrow('owner failure');
    expect(() => graph.run('reference', null, () => ({ decision: check() }))).toThrow(
      'out of order'
    );
    expect(() => graph.finish(check())).toThrow('incomplete');
  });
  it('rejects an unrecorded action after the final node', () => {
    const { graph, decision } = completed();
    expect(() => graph.finish({ ...decision, action: 'fold' })).toThrow('final action');
  });
  it('does not invent a duration after the clock regresses', () => {
    const now = vi.fn().mockReturnValueOnce(2).mockReturnValueOnce(1);
    expect(() =>
      new HorsePolicyGraph(now).run('reference', null, () => ({ decision: check() }))
    ).toThrow('clock');
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
  ] as const)(
    '%s real decision traverses the graph without changing its seeded action',
    (variant) => {
      const { hero, state } = jointPolicyFixture(variant, 1, 'cash', 'preflop');
      const opts = {
        mind: false,
        telemetry: false,
        decisionTimeMs: 0,
        phase7Utility: false,
        phase8Postflop: 'off',
        phase10Plo4: 'off',
        phase11Omaha: 'off',
        phase12Remaining: 'off',
        phase13Joint: 'off',
      } as const;
      seedFastRandom(15007101);
      const first = HorseLogic.decide(hero, state, 'balanced', {}, opts);
      const rng = saveFastRandom();
      seedFastRandom(15007101);
      const second = HorseLogic.decide(hero, state, 'balanced', {}, opts);
      expect(second.action).toBe(first.action);
      expect(second.amount).toBe(first.amount);
      expect(second.thinkTime).toBe(first.thinkTime);
      expect(saveFastRandom()).toBe(rng);
      expect(first.policyGraph?.transitions.map((t) => t.node)).toEqual(HORSE_POLICY_ORDER);
      expect(first.policyGraph?.finalAction).toEqual({
        action: first.action,
        amount: first.amount ?? null,
      });
      expect(JSON.stringify(first.policyGraph)).not.toMatch(/cards|rng|seed|user_id/);
    }
  );
});
