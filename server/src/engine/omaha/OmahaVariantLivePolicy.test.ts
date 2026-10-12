import { describe, expect, it } from 'vitest';
import { HorseLogic } from '../HorseLogic.js';
import { saveFastRandom, seedFastRandom } from '../HorseEval.js';
import {
  occupiedButtonBlinds,
  omahaVariantSpot,
  variantCards,
} from '../../benchmark/OmahaVariantPolicyEvidence.js';
import { evaluateOmahaVariantPolicy } from './OmahaVariantLivePolicy.js';
import { omahaVariantSeatCap } from './OmahaVariantPolicyPack.js';
import { sampleOmahaVariantEquity } from './OmahaVariantSampler.js';
import { horseJournalJson } from '../../services/horseDecisionJournal/record.js';
import type { HorseDecision } from '../../types.js';

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
  it.each(variants)(
    '%s names an unavailable depth when every live opponent is away, journal-safe',
    (variant) => {
      // Reachability 2026-10-08: a -Infinity depth made the decision record unjournalable.
      const s = omahaVariantSpot(variant, 'turn', 2);
      s.state.players[1].is_sitting_out = true;
      const r = evaluateOmahaVariantPolicy(s.hero, s.state, s.baseline, null, 'shadow', () => 0);
      expect(r.receipt.reason).toBe('depth_or_ante_outside_pack');
      expect(r.receipt.depthBB).toBeNull();
      expect(() => horseJournalJson(r.receipt)).not.toThrow();
      const decision = HorseLogic.decide(s.hero, s.state, 'balanced', {}, { mind: false });
      expect(decision.policyFallback).toBeUndefined();
      expect(decision.omahaVariantPolicy?.depthBB).toBeNull();
      expect(() => horseJournalJson(decision)).not.toThrow();
    }
  );
  it.each(variants)('%s keeps a sitting-out dealer in the dealt ring', (variant) => {
    const s = omahaVariantSpot(variant, 'preflop', 3, 'tournament');
    s.state.dealerSeat = 3;
    s.state.blindSeats = occupiedButtonBlinds(3, [1, 2, 3]);
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

describe('Round 3: the reference-anchored packs deviate only heads-up', () => {
  type Spot = ReturnType<typeof omahaVariantSpot>;
  const run = (s: Spot, baseline: HorseDecision) =>
    evaluateOmahaVariantPolicy(s.hero, s.state, baseline, null, 'candidate', () => 0);
  const fold: HorseDecision = { action: 'fold', thinkTime: 0 };
  const check: HorseDecision = { action: 'check', thinkTime: 0 };
  const checkedTo = (s: Spot) => {
    for (const p of s.state.players) p.bet = 0;
    s.hero.bet = 0;
    Object.assign(s.state, {
      currentBet: 0,
      toCall: 0,
      minRaise: 2,
      lastRaise: 0,
      minRaiseTo: 2,
      maxRaiseTo: s.state.pot,
      legalActions: ['check', 'bet'],
      actionHistory: [],
    });
    return s;
  };

  it.each(variants)(
    '%s opens the heads-up button the reference folds, at the minimum raise',
    (variant) => {
      const s = omahaVariantSpot(variant, 'preflop', 2);
      const open = run(s, fold);
      expect(open.receipt).toMatchObject({
        reason: 'heads_up_button_open',
        role: 'rfi',
        position: 'button',
        applied: true,
      });
      expect(open.decision).toMatchObject({ action: 'raise', amount: s.state.minRaiseTo });
      // A reference limp or raise is the decision.
      const limp: HorseDecision = { action: 'call', amount: 1, thinkTime: 0 };
      expect(run(s, limp)).toMatchObject({
        decision: limp,
        receipt: { reason: 'reference_retained' },
      });
    }
  );

  it.each(variants)(
    "%s retains the heads-up big blind's reference fold (no three-bet since v2)",
    (variant) => {
      const s = omahaVariantSpot(variant, 'preflop', 2);
      // The opponent on the button raised to 6; hero has the big blind in.
      s.hero.bet = s.hero.totalInvested = 2;
      s.state.players[0] = { ...s.hero, cards: [] };
      Object.assign(s.state.players[1], { bet: 6, totalInvested: 6 });
      Object.assign(s.state, {
        dealerSeat: 2,
        blindSeats: { smallBlind: 2, bigBlind: 1 },
        pot: 8,
        currentBet: 6,
        minRaise: 4,
        lastRaise: 4,
        toCall: 4,
        minRaiseTo: 10,
        maxRaiseTo: 18,
        actionHistory: [
          {
            userId: 'v2',
            seat: 2,
            action: 'raise',
            amount: 6,
            stage: 'preflop',
            timestamp: 1,
            isFullRaise: true,
          },
        ],
      });
      // v2: the big blind three-bet won only against horses that over-fold;
      // at the human-calibrated table it lost on every variant. The fold stands.
      const kept = run(s, fold);
      expect(kept.receipt).toMatchObject({
        reason: 'reference_retained',
        role: 'defense',
        position: 'big_blind',
        applied: false,
      });
      expect(kept.decision).toBe(fold);
      // The pot-limit raise-to is still recorded: 6 + (8 + 4) = 18.
      expect(kept.receipt.inputs!.geometry).toMatchObject({ potLimitRaiseTo: 18 });
    }
  );

  it.each(variants)(
    '%s bets the pot in position when checked to on the turn and river',
    (variant) => {
      for (const street of ['turn', 'river'] as const) {
        const s = checkedTo(omahaVariantSpot(variant, street, 2));
        const stab = run(s, check);
        expect(stab.receipt).toMatchObject({
          reason: 'heads_up_position_stab',
          role: 'checked_to',
          position: 'button',
        });
        expect(stab.decision).toMatchObject({ action: 'bet', amount: s.state.pot });
      }
      // The flop is not a stab street.
      expect(run(checkedTo(omahaVariantSpot(variant, 'flop', 2)), check).decision).toEqual(check);
    }
  );

  it.each(variants)('%s retains the reference everywhere else', (variant) => {
    // Three dealt seats: never a heads-up deviation.
    const ring = checkedTo(omahaVariantSpot(variant, 'turn', 3));
    expect(run(ring, check)).toMatchObject({
      decision: check,
      receipt: { reason: 'reference_retained', applied: false },
    });
    // Out of position heads-up (hero in the big blind) on the turn.
    const oop = checkedTo(omahaVariantSpot(variant, 'turn', 2));
    Object.assign(oop.state, { dealerSeat: 2, blindSeats: { smallBlind: 2, bigBlind: 1 } });
    expect(run(oop, check).receipt).toMatchObject({ reason: 'reference_retained' });
    // Facing a bet: the reference answers it, whatever the sampled equity.
    const facing = omahaVariantSpot(variant, 'river', 2);
    for (const baseline of [fold, { action: 'call', amount: 20, thinkTime: 0 } as HorseDecision])
      expect(run(facing, baseline)).toMatchObject({
        decision: baseline,
        receipt: { reason: 'reference_retained', fired: true },
      });
    // A reference wager is never resized.
    const bet: HorseDecision = { action: 'bet', amount: 7, thinkTime: 0 };
    expect(run(checkedTo(omahaVariantSpot(variant, 'river', 2)), bet).decision).toBe(bet);
  });
});
