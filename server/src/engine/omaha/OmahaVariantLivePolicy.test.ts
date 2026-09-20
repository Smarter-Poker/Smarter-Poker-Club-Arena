import { describe, expect, it } from 'vitest';
import { HorseLogic } from '../HorseLogic.js';
import { saveFastRandom, seedFastRandom } from '../HorseEval.js';
import { omahaVariantSpot, variantCards } from '../../benchmark/OmahaVariantPolicyEvidence.js';
import { evaluateOmahaVariantPolicy } from './OmahaVariantLivePolicy.js';
import { omahaVariantSeatCap } from './OmahaVariantPolicyPack.js';
import { sampleOmahaVariantEquity } from './OmahaVariantSampler.js';

const variants = ['plo5', 'plo6', 'plo8'] as const;
describe('Phase 11 real variant policy', () => {
  it.each(variants)('%s excludes an explicitly undealt seat from the sampled deck', (variant) => {
    const s = omahaVariantSpot(variant, 'turn', 2);
    s.state.dealtSeatIds = [1, 2];
    seedFastRandom(220913);
    const before = sampleOmahaVariantEquity(variant, s.hero, s.state, () => true);
    s.state.players.push({
      ...s.state.players[1],
      user_id: 'undealt',
      seat: 3,
      bet: 0,
      totalInvested: 0,
      is_sitting_out: true,
    });
    seedFastRandom(220913);
    const after = sampleOmahaVariantEquity(variant, s.hero, s.state, () => true);
    expect(before).not.toBeNull();
    expect({ ...after, analysisMs: 0 }).toEqual({ ...before, analysisMs: 0 });
  });
  it.each(variants)('%s retains a sitting-out all-in opponent at showdown', (variant) => {
    const s = omahaVariantSpot(variant, 'turn', 3);
    s.state.players[2].stack = 0;
    s.state.players[2].is_all_in = true;
    seedFastRandom(220913);
    const before = sampleOmahaVariantEquity(variant, s.hero, s.state, () => true);
    s.state.players[2].is_sitting_out = true;
    seedFastRandom(220913);
    const after = sampleOmahaVariantEquity(variant, s.hero, s.state, () => true);
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect({ ...after, analysisMs: 0 }).toEqual({ ...before, analysisMs: 0 });
  });
  it.each(variants)('%s keeps a sitting-out dealer in the dealt ring', (variant) => {
    const s = omahaVariantSpot(variant, 'preflop', 3, 'tournament');
    s.state.dealerSeat = 3;
    s.state.players[2].is_sitting_out = true;
    s.state.players[2].is_folded = true;
    const r = evaluateOmahaVariantPolicy(s.hero, s.state, s.baseline, null, 'shadow', () => 0);
    expect(r.receipt.fired).toBe(true);
    expect(r.receipt.position).toBe('small_blind');
    expect(r.decision).toBe(s.baseline);
  });
  it.each(variants)('%s retains the actual aggressor after an all-in call', (variant) => {
    const s = omahaVariantSpot(variant, 'river', 3);
    s.state.players[2].stack = 0;
    s.state.players[2].is_all_in = true;
    s.state.players[2].bet = 20;
    s.state.actionHistory!.push({
      userId: 'v3',
      seat: 3,
      action: 'all_in',
      amount: 20,
      stage: 'river',
      timestamp: 2,
    });
    const r = evaluateOmahaVariantPolicy(s.hero, s.state, s.baseline, null, 'shadow', () => 0);
    expect(r.receipt.fired).toBe(true);
    expect(r.receipt.aggressorPosition).toBe('small_blind');
  });
  it.each(variants)('%s keeps a folded seat in the sampled deck when it sits out', (variant) => {
    const s = omahaVariantSpot(variant, 'turn', 3);
    s.state.players[2].is_folded = true;
    seedFastRandom(220913);
    const before = sampleOmahaVariantEquity(variant, s.hero, s.state, () => true);
    s.state.players[2].is_sitting_out = true;
    seedFastRandom(220913);
    const after = sampleOmahaVariantEquity(variant, s.hero, s.state, () => true);
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect({ ...after, analysisMs: 0 }).toEqual({ ...before, analysisMs: 0 });
  });
  it.each(variants)(
    '%s covers each street and the actual cash/tournament seat limits',
    (variant) => {
      for (const mode of ['cash', 'tournament'] as const)
        for (const street of ['preflop', 'flop', 'turn', 'river'] as const) {
          const spot = omahaVariantSpot(variant, street, omahaVariantSeatCap(variant, mode), mode);
          const before = JSON.stringify(spot);
          const r = evaluateOmahaVariantPolicy(
            spot.hero,
            spot.state,
            spot.baseline,
            null,
            'shadow',
            () => 0
          );
          expect(r.receipt.eligible, JSON.stringify(r.receipt)).toBe(true);
          expect(r.receipt.fired).toBe(true);
          expect(r.decision).toBe(spot.baseline);
          expect(spot.state.legalActions).toContain(r.proposal.action);
          if (r.proposal.action === 'raise' || r.proposal.action === 'bet') {
            expect(r.proposal.amount).toBeGreaterThanOrEqual(spot.state.minRaiseTo!);
            expect(r.proposal.amount).toBeLessThanOrEqual(spot.state.maxRaiseTo!);
          }
          if (street !== 'preflop') expect(r.receipt.equity?.samples).toBeGreaterThan(0);
          expect(JSON.stringify(spot)).toBe(before);
        }
    }
  );
  it.each(variants)(
    '%s shadow preserves baseline actions and random stream at wide tables',
    (variant) => {
      for (const mode of ['cash', 'tournament'] as const)
        for (const street of ['preflop', 'river'] as const) {
          const spot = omahaVariantSpot(variant, street, omahaVariantSeatCap(variant, mode), mode);
          const opts = { telemetry: false, mind: false, decisionTimeMs: 0 };
          seedFastRandom(711001);
          const off = HorseLogic.decide(
            spot.hero,
            spot.state,
            'balanced',
            {},
            { ...opts, phase11Omaha: 'off' }
          );
          const afterOff = saveFastRandom();
          seedFastRandom(711001);
          const shadow = HorseLogic.decide(
            spot.hero,
            spot.state,
            'balanced',
            {},
            { ...opts, phase11Omaha: 'shadow', phase11EvidenceMode: true }
          );
          expect({
            action: shadow.action,
            amount: shadow.amount,
            thinkTime: shadow.thinkTime,
          }).toEqual({ action: off.action, amount: off.amount, thinkTime: off.thinkTime });
          expect(saveFastRandom()).toBe(afterOff);
          expect(shadow.omahaVariantPolicy?.fired).toBe(true);
          expect(shadow.omahaVariantPolicy?.applied).toBe(false);
          expect(shadow.omahaVariantPolicy?.executionStatus).toBe('pending');
        }
    }
  );
  it.each(variants)('%s retains Phase 7 tournament utility ownership', (variant) => {
    const s = omahaVariantSpot(variant, 'river', 2, 'tournament');
    seedFastRandom(11001);
    const result = HorseLogic.decide(
      s.hero,
      s.state,
      'balanced',
      {},
      { telemetry: false, mind: false, decisionTimeMs: 0, phase11EvidenceMode: true }
    );
    expect(result.omahaVariantPolicy?.utilityOwner).toBe('phase7_evaluated');
    expect(result.omahaVariantPolicy?.shadowUtility?.candidates.length).toBeGreaterThan(1);
  });
  it('keeps the local range stream isolated and ignores opponent private cards', () => {
    const s = omahaVariantSpot('plo6', 'turn', 6);
    seedFastRandom(22);
    const before = saveFastRandom();
    const first = sampleOmahaVariantEquity('plo6', s.hero, s.state, () => true)!;
    expect(saveFastRandom()).toBe(before);
    s.state.players[1].cards = variantCards('2c 3c 4c 5c 6c 7c');
    const again = sampleOmahaVariantEquity('plo6', s.hero, s.state, () => true)!;
    expect({ ...again, analysisMs: 0 }).toEqual({ ...first, analysisMs: 0 });
    s.state.actionHistory = [];
    const noPressure = sampleOmahaVariantEquity('plo6', s.hero, s.state, () => true)!;
    expect({ ...noPressure, analysisMs: 0 }).not.toEqual({ ...first, analysisMs: 0 });
  });
  it('rejects malformed equity evidence without authorizing a candidate action', () => {
    const s = omahaVariantSpot('plo8');
    const evidence = sampleOmahaVariantEquity('plo8', s.hero, s.state, () => true)!;
    evidence.analysisMs = 0;
    for (const override of [
      { samples: NaN },
      { equity: Infinity },
      { confidence99: undefined },
      { perPot: [] },
      { distribution: [] },
      { expectedChips: -1 },
      { standardError: NaN },
      { eligiblePot: evidence.eligiblePot + 1 },
    ]) {
      const invalid = { ...evidence, ...override } as typeof evidence;
      const r = evaluateOmahaVariantPolicy(
        s.hero,
        s.state,
        s.baseline,
        invalid,
        'candidate',
        () => 0
      );
      expect(r.receipt.reason).toBe('invalid_equity_evidence');
      expect(r.receipt.fired).toBe(false);
      expect(r.decision).toBe(s.baseline);
    }
  });
  it('declares private-state, multiboard and fixed-limit boundaries and stops at the work deadline', () => {
    const s = omahaVariantSpot('plo8');
    const run = () =>
      evaluateOmahaVariantPolicy(s.hero, s.state, s.baseline, null, 'candidate', () => 0);
    s.state.players[1].cards = variantCards('2c 3c 4c 5c');
    expect(run().receipt.reason).toBe('private_state_rejected');
    s.state.players[1].cards = [];
    s.state.boardCount = 2;
    expect(run().receipt.reason).toBe('multiboard_owned_by_phase13');
    s.state.boardCount = 1;
    s.state.bettingStructure = 'fixed_limit';
    expect(run().receipt.eligible).toBe(false);
    s.state.bettingStructure = 'pot_limit';
    let clock = 0;
    const exhausted = evaluateOmahaVariantPolicy(
      s.hero,
      s.state,
      s.baseline,
      null,
      'candidate',
      () => (clock += 5)
    );
    expect(exhausted.receipt.reason).toBe('work_budget');
    expect(exhausted.receipt.fired).toBe(false);
    expect(exhausted.decision).toBe(s.baseline);
  });
});
