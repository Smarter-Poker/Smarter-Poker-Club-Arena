import { beforeEach, describe, expect, it } from 'vitest';
import type { HorseDecision } from '../types.js';
import { drainFires, enableBrainTelemetry } from './BrainTelemetry.js';
import { HorsePolicyGraph, HORSE_POLICY_ORDER } from './HorsePolicyGraph.js';
import {
  classifyHorsePolicyDecision,
  observeHorsePolicyDecision,
} from './HorsePolicyLedgerObserver.js';
import {
  alwaysOnRegistry,
  horsePolicyDecisionsTotal,
  horseReferenceAgreementTotal,
} from '../observability/engineInstruments.js';

/** A sealed graph whose nodes return the given actions in order. */
function graphed(
  actions: Array<{ action: HorseDecision['action']; amount?: number }>,
  outcome: string | null = 'computed'
): HorseDecision {
  const graph = new HorsePolicyGraph(() => 0);
  let decision: HorseDecision | null = null;
  HORSE_POLICY_ORDER.forEach((node, i) => {
    const step = actions[Math.min(i, actions.length - 1)];
    decision = graph.run(node, decision, () => ({
      decision: { action: step.action, amount: step.amount, thinkTime: 0 } as HorseDecision,
    })).decision;
  });
  const sealed = graph.finish(decision!);
  return outcome === null
    ? sealed
    : ({ ...sealed, policyOwnership: { outcome } } as unknown as HorseDecision);
}

const cash = (gameVariant: string) => ({ gameVariant, gameMode: 'cash' });

beforeEach(() => {
  enableBrainTelemetry();
  drainFires();
});

describe('Phase 15 policy ledger observer', () => {
  it('classifies exact, sizing-only and action disagreement with the reference node', () => {
    expect(classifyHorsePolicyDecision(cash('plo4'), graphed([{ action: 'check' }]))).toEqual({
      variant: 'plo4',
      format: 'cash',
      outcome: 'computed',
      agreement: 'exact',
      divergedAt: null,
    });
    // variant_policy (third node) resizes the bet: same action, other amount.
    expect(
      classifyHorsePolicyDecision(
        cash('plo5'),
        graphed([
          { action: 'bet', amount: 10 },
          { action: 'bet', amount: 10 },
          { action: 'bet', amount: 14 },
        ])
      )
    ).toMatchObject({ agreement: 'action', divergedAt: 'variant_policy' });
    // tournament_utility (fourth node) folds a reference call.
    expect(
      classifyHorsePolicyDecision(
        { gameVariant: 'nlh', gameMode: 'tournament' },
        graphed(
          [
            { action: 'call', amount: 4 },
            { action: 'call', amount: 4 },
            { action: 'call', amount: 4 },
            { action: 'fold' },
          ],
          'reference'
        )
      )
    ).toMatchObject({
      variant: 'nlh',
      format: 'tournament',
      outcome: 'reference',
      agreement: 'differ',
      divergedAt: 'tournament_utility',
    });
  });

  it('never invents a reference: a missing or partial graph is unrecorded, a missing receipt unregistered', () => {
    expect(
      classifyHorsePolicyDecision(cash('flh'), {
        action: 'fold',
        thinkTime: 0,
      } as HorseDecision)
    ).toMatchObject({ outcome: 'unregistered', agreement: 'unrecorded', divergedAt: null });
    const partial = graphed([{ action: 'check' }]);
    partial.policyGraph!.transitions.pop();
    expect(classifyHorsePolicyDecision(cash('flh'), partial)).toMatchObject({
      agreement: 'unrecorded',
    });
    expect(
      classifyHorsePolicyDecision(cash('flh'), graphed([{ action: 'check' }], null))
    ).toMatchObject({ outcome: 'unregistered', agreement: 'exact' });
  });

  it('keeps every label in its closed set', () => {
    const odd = classifyHorsePolicyDecision(
      { gameVariant: '__proto__', gameMode: 'sng' },
      graphed([{ action: 'check' }], 'made_up')
    );
    expect(odd).toMatchObject({ variant: 'other', format: 'tournament', outcome: 'unregistered' });
    expect(classifyHorsePolicyDecision(null, null)).toMatchObject({
      variant: 'nlh',
      outcome: 'unregistered',
      agreement: 'unrecorded',
    });
  });

  it('counts the Prometheus series the alarms read and the daily telemetry the report reads', () => {
    const decisions = horsePolicyDecisionsTotal.get({ variant: 'plo8', outcome: 'outside_domain' });
    const differ = horseReferenceAgreementTotal.get({
      variant: 'plo8',
      format: 'cash',
      agreement: 'differ',
    });
    observeHorsePolicyDecision(
      cash('plo8'),
      graphed(
        [
          { action: 'raise', amount: 30 },
          { action: 'raise', amount: 30 },
          { action: 'call', amount: 10 },
        ],
        'outside_domain'
      )
    );
    expect(horsePolicyDecisionsTotal.get({ variant: 'plo8', outcome: 'outside_domain' })).toBe(
      decisions + 1
    );
    expect(
      horseReferenceAgreementTotal.get({ variant: 'plo8', format: 'cash', agreement: 'differ' })
    ).toBe(differ + 1);
    expect(drainFires()).toEqual([
      { feature: 'phase15_reference_agreement_plo8_cash_differ', fires: 1 },
      { feature: 'phase15_reference_divergence_plo8_variant_policy', fires: 1 },
    ]);
  });

  it('exposes every alarm series before the first decision (seeded at zero)', () => {
    const text = alwaysOnRegistry.renderPrometheus();
    for (const variant of [
      'nlh',
      'plo4',
      'plo5',
      'plo6',
      'plo8',
      'short_deck',
      'pineapple',
      'flh',
      'flo8',
    ])
      for (const outcome of [
        'outside_domain',
        'unavailable',
        'unregistered',
        'computed',
        'reference',
      ])
        expect(text).toContain(
          `poker_horse_policy_decisions_total{outcome="${outcome}",variant="${variant}"} `
        );
    expect(text).toContain('poker_horse_reference_agreement_total');
  });

  it('never throws into the decision lane', () => {
    expect(() =>
      observeHorsePolicyDecision({ gameVariant: 'nlh' }, { policyGraph: 7 } as never)
    ).not.toThrow();
  });
});
