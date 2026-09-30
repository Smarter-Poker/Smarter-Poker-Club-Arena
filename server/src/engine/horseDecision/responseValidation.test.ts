import { describe, expect, it } from 'vitest';
import type { HorseDecision } from '../../types.js';
import { HorsePolicyGraph, HORSE_POLICY_ORDER } from '../HorsePolicyGraph.js';
import { HorseLogic } from '../HorseLogic.js';
import { seedFastRandom } from '../HorseEval.js';
import { jointPolicyFixture } from '../multiway/JointRangeFixture.test-support.js';
import type { HorseTournamentJointSamplerProvenance } from '../HorseTournamentUtilityEvidence.js';
import {
  horseDecisionReceiptIsValid,
  horseTournamentUtilityReceiptIsValid,
} from './responseValidation.js';

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

let capturedUtilityDecision: HorseDecision | undefined;
function utilityReceipt(): HorseDecision {
  if (!capturedUtilityDecision) {
    const { hero, state } = jointPolicyFixture('nlh', 1, 'tournament', 'river');
    seedFastRandom(1500921);
    capturedUtilityDecision = HorseLogic.decide(
      hero,
      state,
      'balanced',
      {},
      {
        mind: false,
        telemetry: false,
        decisionTimeMs: 0,
        phase8Postflop: 'off',
        phase13Joint: 'off',
      }
    );
    expect(capturedUtilityDecision.tournamentUtility?.evidence).toBeDefined();
  }
  return structuredClone(capturedUtilityDecision);
}

describe('Phase 7B joint population receipt admission', () => {
  // This deliberately exercises the structured-clone admission boundary.
  // Physical joint acquisition and action economics have separate connected tests.
  function jointReceipt(): HorseDecision {
    const decision = utilityReceipt(),
      ledger = decision.tournamentUtility!;
    const sampler: HorseTournamentJointSamplerProvenance = {
      version: 'horse-joint-sampler-provenance-v1',
      samplerVersion: 'joint-public-range-round1-v1',
      stateKey: `phase5-v1:${'a'.repeat(64)}`,
      layout: 'independent',
      sharedPrefixLength: 0,
      boardCount: 2,
      requestedSamples: 16,
      completedSamples: 16,
      sampleBudgetExhausted: false,
      uniformEscapes: 1,
      physicalCardsPerSample: 14,
      unknownDealtCardsPerSample: 2,
      rangeModel: {
        version: 'joint-public-range-round1-v1',
        source: 'explicit_public_line_heuristic',
        confidence: 'heuristic_uncalibrated',
      },
    };
    ledger.evidence = { ...ledger.evidence!, sampler };
    ledger.equitySampleSize = 16;
    ledger.utilityOutcomeSamples = 16;
    ledger.effectiveOutcomeSamples = Math.min(ledger.effectiveOutcomeSamples, 16);
    for (const candidate of ledger.candidates) {
      candidate.outcomeCount = 16;
      candidate.resultingStackVectors = Math.min(candidate.resultingStackVectors, 16);
    }
    return decision;
  }

  it('admits a bounded independent-board receipt without requiring provenance from legacy callers', () => {
    const value = jointReceipt();
    expect(horseTournamentUtilityReceiptIsValid(value.tournamentUtility, value)).toBe(true);
    expect(
      horseTournamentUtilityReceiptIsValid(utilityReceipt().tournamentUtility, utilityReceipt())
    ).toBe(true);
  });

  it.each(['equity_population', 'utility_population'] as const)(
    'rejects a sampler that describes a different %s than the selected utility',
    (fault) => {
      const value = jointReceipt(),
        ledger = value.tournamentUtility!;
      if (fault === 'equity_population') ledger.equitySampleSize = 320;
      else {
        ledger.utilityOutcomeSamples = 15;
        ledger.effectiveOutcomeSamples = Math.min(ledger.effectiveOutcomeSamples, 15);
        for (const candidate of ledger.candidates) {
          candidate.outcomeCount = 15;
          candidate.resultingStackVectors = Math.min(candidate.resultingStackVectors, 15);
        }
      }
      expect(horseTournamentUtilityReceiptIsValid(ledger, value)).toBe(false);
    }
  );

  it('refuses marginal/shared-runout relabeling and incomplete populations before witness construction', () => {
    for (const fault of [
      { layout: 'marginal_zipped' },
      { sharedPrefixLength: 3 },
      { requestedSamples: 160 },
      { completedSamples: 7, sampleBudgetExhausted: true },
      { stateKey: `phase5-v1:${'z'.repeat(64)}` },
    ]) {
      const value = jointReceipt(),
        ledger = value.tournamentUtility!;
      ledger.evidence = {
        ...ledger.evidence!,
        sampler: { ...ledger.evidence!.sampler!, ...fault } as any,
      };
      expect(horseTournamentUtilityReceiptIsValid(ledger, value)).toBe(false);
    }
  });
});

describe('bounded Horse response receipt validation', () => {
  it('accepts the real single-board tournament utility and its private read-frame binding', () => {
    const d = utilityReceipt();
    expect(horseDecisionReceiptIsValid(d)).toBe(true);
    d.tournamentUtility!.readFrameSha256 = 'a'.repeat(64);
    expect(horseDecisionReceiptIsValid(d)).toBe(true);
    d.tournamentUtility!.readFrameSha256 = null;
    expect(horseDecisionReceiptIsValid(d)).toBe(true);
  });
  it('preserves historical utility without fabricating input or observation provenance', () => {
    const d = utilityReceipt();
    delete d.tournamentUtility!.evidence;
    expect(horseDecisionReceiptIsValid(d)).toBe(true);
    expect(d.tournamentUtility).not.toHaveProperty('evidence');
  });
  it('reconciles a call through its actual investment while candidate amount remains null', () => {
    const ledger = utilityReceipt().tournamentUtility!;
    const candidate = ledger.candidates[0];
    candidate.id = 'call';
    candidate.action = 'call';
    candidate.amount = null;
    candidate.investment = 7;
    ledger.candidates = [candidate];
    ledger.selectedAction = 'call';
    ledger.selectedAmount = 7;
    expect(horseTournamentUtilityReceiptIsValid(ledger, { action: 'call', amount: 7 })).toBe(true);
    candidate.investment = 8;
    expect(horseTournamentUtilityReceiptIsValid(ledger, { action: 'call', amount: 7 })).toBe(false);
  });
  it.each([
    'evidence',
    'calibration',
    'window',
    'model',
    'unit',
    'action',
    'selected_size',
    'read_frame',
    'candidate_probability',
    'candidate_component',
    'candidate_private',
    'candidate_duplicate',
    'candidate_overflow',
    'candidate_nan',
    'candidate_amount',
    'field',
    'players_behind',
    'ranges',
    'execution',
  ] as const)('rejects malformed or overstated utility %s before witness construction', (fault) => {
    const d = utilityReceipt(),
      ledger = d.tournamentUtility! as any;
    if (fault === 'evidence') ledger.evidence = null;
    if (fault === 'calibration') ledger.evidence.responseModel.calibration = 'calibrated';
    if (fault === 'window') ledger.evidence.observations.window.to = 123;
    if (fault === 'model') ledger.model = 'unrecognized';
    if (fault === 'unit') ledger.utilityUnit = 'dollars';
    if (fault === 'action') ledger.selectedAction = 'discard';
    if (fault === 'selected_size') ledger.selectedAmount = 9_999;
    if (fault === 'read_frame') ledger.readFrameSha256 = 'not-a-sha256';
    if (fault === 'candidate_probability') ledger.candidates[0].winProbability = 2;
    if (fault === 'candidate_component') ledger.candidates[0].combinedUtility += 1;
    if (fault === 'candidate_private') ledger.candidates[0].cards = ['As'];
    if (fault === 'candidate_duplicate')
      ledger.candidates.push(structuredClone(ledger.candidates[0]));
    if (fault === 'candidate_overflow')
      ledger.candidates = Array.from({ length: 17 }, () => ledger.candidates[0]);
    if (fault === 'candidate_nan') ledger.candidates[0].optionEv = NaN;
    if (fault === 'candidate_amount') {
      ledger.candidates[0].action = 'call';
      ledger.candidates[0].amount = 1;
    }
    if (fault === 'field') ledger.fieldPlayersModeled++;
    if (fault === 'players_behind') ledger.playersBehind.push('unrelated-actor');
    if (fault === 'ranges') ledger.conditionedOpponentRanges = 9;
    if (fault === 'execution') ledger.executedAction = 'check';
    expect(horseDecisionReceiptIsValid(d)).toBe(false);
  });
  it('rejects a brain-exception fallback carrying a stale utility receipt', () => {
    const d = utilityReceipt();
    expect(
      horseDecisionReceiptIsValid({
        action: 'fold',
        thinkTime: 0,
        policyFallback: 'brain_exception',
        tournamentUtility: d.tournamentUtility,
      })
    ).toBe(false);
  });
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
