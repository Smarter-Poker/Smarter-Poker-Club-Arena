import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HorsePolicyGraph, HORSE_POLICY_ORDER } from './HorsePolicyGraph.js';
import { drainDecisionLatency, drainFires, enableBrainTelemetry } from './BrainTelemetry.js';
import { HorseLogic } from './HorseLogic.js';
import { seedFastRandom, saveFastRandom } from './HorseEval.js';
import { jointPolicyFixture } from './multiway/JointRangeFixture.test-support.js';
import type { HorseDecision } from '../types.js';

const counts = () => Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
const check = (): HorseDecision => ({ action: 'check', thinkTime: 0 });
beforeEach(() => {
  enableBrainTelemetry();
  drainFires();
  drainDecisionLatency();
});

describe('Horse graph component execution accounting', () => {
  it('counts actual entries and outcomes without calling a no-op node an evaluated candidate', () => {
    const graph = new HorsePolicyGraph(() => 10, true);
    let decision: HorseDecision | null = null;
    for (const node of HORSE_POLICY_ORDER) {
      decision = graph.run(node, decision, () => ({
        decision: node === 'reference' ? check() : { action: 'bet', amount: 2, thinkTime: 0 },
      })).decision;
    }
    graph.finish(decision!);
    const rows = counts();
    expect(rows.phase15_graph_started).toBe(1);
    expect(rows.phase15_graph_completed).toBe(1);
    for (const node of HORSE_POLICY_ORDER) {
      expect(rows[`phase15_node_${node}_entered`]).toBe(1);
      expect(rows[`phase15_node_${node}_completed`]).toBe(1);
      const outcome =
        node === 'reference' ? 'produced' : node === 'reference_legality' ? 'changed' : 'retained';
      expect(rows[`phase15_node_${node}_${outcome}`]).toBe(1);
      expect(rows[`phase15_node_${node}_failed`]).toBeUndefined();
    }
    expect(drainDecisionLatency()).toEqual(
      HORSE_POLICY_ORDER.map((node) => ({
        scope: `phase15_node_${node}`,
        samples: 1,
        totalMs: 0,
        maxMs: 0,
        buckets: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      }))
    );
  });
  it('records the owner that failed and never invents successor completion', () => {
    const graph = new HorsePolicyGraph(() => 10, true);
    const first = graph.run('reference', null, () => ({ decision: check() })).decision;
    expect(() =>
      graph.run('reference_legality', first, () => {
        throw Error('owner failure');
      })
    ).toThrow('owner failure');
    expect(() => graph.finish(first)).toThrow('incomplete');
    expect(() => graph.run('reference_legality', first, () => ({ decision: first }))).toThrow(
      'out of order'
    );
    const rows = counts();
    expect(rows.phase15_graph_failed).toBe(1);
    expect(rows.phase15_node_reference_legality_entered).toBe(1);
    expect(rows.phase15_node_reference_legality_failed).toBe(1);
    expect(rows.phase15_node_reference_legality_completed).toBeUndefined();
    expect(rows.phase15_node_variant_policy_entered).toBeUndefined();
    expect(rows.phase15_graph_completed).toBeUndefined();
    expect(drainDecisionLatency().map((r) => r.scope)).toEqual(['phase15_node_reference']);
  });
  it('contains a clock failure and reports no fabricated latency', () => {
    const graph = new HorsePolicyGraph(() => {
      throw Error('clock unavailable');
    }, true);
    expect(() => graph.run('reference', null, () => ({ decision: check() }))).toThrow(
      'clock unavailable'
    );
    expect(counts()).toEqual({
      phase15_graph_started: 1,
      phase15_node_reference_entered: 1,
      phase15_node_reference_failed: 1,
      phase15_graph_failed: 1,
    });
    expect(drainDecisionLatency()).toEqual([]);
    expect(() => graph.finish(check())).toThrow('incomplete');
  });
  it('keeps a failed real reference owner visible when HorseLogic returns its safety fallback', () => {
    const { hero, state } = jointPolicyFixture('nlh', 1, 'cash', 'preflop');
    const broken = vi.spyOn(HorseLogic as any, 'decidePreflopV7Glue').mockImplementationOnce(() => {
      throw Error('reference owner failure');
    });
    try {
      const decision = HorseLogic.decide(
        hero,
        state,
        'balanced',
        {},
        { mind: false, telemetry: true, decisionTimeMs: 0 }
      );
      expect(decision.policyFallback).toBe('brain_exception');
      const rows = counts();
      expect(rows.phase15_node_reference_entered).toBe(1);
      expect(rows.phase15_node_reference_failed).toBe(1);
      expect(rows.phase15_graph_failed).toBe(1);
      expect(rows.phase15_graph_completed).toBeUndefined();
      expect(rows.phase15_node_reference_legality_entered).toBeUndefined();
      expect(drainDecisionLatency().filter((r) => r.scope.startsWith('phase15_node_'))).toEqual([]);
    } finally {
      broken.mockRestore();
    }
  });
  it.each([false, true])(
    'real HorseLogic publishes only opted-in live component accounting (telemetry=%s)',
    (telemetry) => {
      const { hero, state } = jointPolicyFixture('nlh', 1, 'cash', 'preflop');
      const opts = {
        mind: false,
        telemetry,
        decisionTimeMs: 0,
        phase8Postflop: 'off',
        phase10Plo4: 'off',
        phase11Omaha: 'off',
        phase12Remaining: 'off',
        phase13Joint: 'off',
      } as const;
      seedFastRandom(15007101);
      const first = HorseLogic.decide(hero, state, 'balanced', {}, opts);
      const rng = saveFastRandom();
      const rows = counts();
      const componentLatency = drainDecisionLatency().filter((r) =>
        r.scope.startsWith('phase15_node_')
      );
      if (telemetry) {
        expect(rows.phase15_graph_completed).toBe(1);
        expect(componentLatency.map((r) => r.scope)).toEqual(
          HORSE_POLICY_ORDER.map((node) => `phase15_node_${node}`)
        );
      } else {
        expect(
          Object.keys(rows).filter(
            (key) => key.startsWith('phase15_node_') || key.startsWith('phase15_graph_')
          )
        ).toEqual([]);
        expect(componentLatency).toEqual([]);
      }
      seedFastRandom(15007101);
      const second = HorseLogic.decide(
        hero,
        state,
        'balanced',
        {},
        { ...opts, telemetry: !telemetry }
      );
      expect([second.action, second.amount, second.thinkTime, saveFastRandom()]).toEqual([
        first.action,
        first.amount,
        first.thinkTime,
        rng,
      ]);
    }
  );
});
