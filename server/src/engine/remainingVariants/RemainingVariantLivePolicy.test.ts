import { describe, expect, it } from 'vitest';
import {
  remainingVariantSpot,
  remainingCards,
} from '../../benchmark/RemainingVariantPolicyEvidence.js';
import { evaluateRemainingVariantPolicy } from './RemainingVariantLivePolicy.js';
import {
  remainingVariantSeatCap,
  remainingVariantHandShape,
  remainingVariantEntryBars,
  REMAINING_VARIANT_PACKS,
} from './RemainingVariantPolicyPack.js';
import {
  sampleRemainingVariantEquity,
  choosePineappleFlopPair,
} from './RemainingVariantSampler.js';
import { saveFastRandom, seedFastRandom } from '../HorseEval.js';
import { HorseLogic } from '../HorseLogic.js';

const variants = ['short_deck', 'pineapple', 'flh', 'flo8'] as const;
describe('remaining variant first-round core', () => {
  it.each(variants)('%s excludes an explicitly undealt seat from the sampled deck', (variant) => {
    const s = remainingVariantSpot(variant, 'turn', 2);
    s.state.dealtSeatIds = [1, 2];
    seedFastRandom(220913);
    const before = sampleRemainingVariantEquity(variant, s.hero, s.state, () => true);
    s.state.players.push({
      ...s.state.players[1],
      user_id: 'undealt',
      seat: 3,
      bet: 0,
      totalInvested: 0,
      is_sitting_out: true,
    });
    seedFastRandom(220913);
    const after = sampleRemainingVariantEquity(variant, s.hero, s.state, () => true);
    expect(before).not.toBeNull();
    expect({ ...after, analysisMs: 0 }).toEqual({ ...before, analysisMs: 0 });
  });
  it.each(variants)('%s retains a sitting-out all-in opponent at showdown', (variant) => {
    const s = remainingVariantSpot(variant, 'turn', 3);
    s.state.players[2].stack = 0;
    s.state.players[2].is_all_in = true;
    seedFastRandom(220913);
    const before = sampleRemainingVariantEquity(variant, s.hero, s.state, () => true);
    s.state.players[2].is_sitting_out = true;
    seedFastRandom(220913);
    const after = sampleRemainingVariantEquity(variant, s.hero, s.state, () => true);
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect({ ...after, analysisMs: 0 }).toEqual({ ...before, analysisMs: 0 });
  });
  it.each(variants)('%s keeps a sitting-out dealer in the dealt ring', (variant) => {
    const s = remainingVariantSpot(variant, 'preflop', 3);
    s.state.dealerSeat = 3;
    s.state.players[2].is_sitting_out = true;
    s.state.players[2].is_folded = true;
    const r = evaluateRemainingVariantPolicy(s.hero, s.state, s.baseline, null, 'shadow', () => 0);
    expect(r.receipt.fired).toBe(true);
    expect(r.receipt.position).toBe('small_blind');
    expect(r.decision).toBe(s.baseline);
  });
  it.each(variants)('%s retains the actual aggressor after an all-in call', (variant) => {
    const s = remainingVariantSpot(variant, 'river', 3);
    const caller = s.state.players[2];
    caller.stack = 0;
    caller.is_all_in = true;
    caller.bet = s.state.currentBet;
    s.state.actionHistory!.push({
      userId: caller.user_id,
      seat: caller.seat,
      action: 'all_in',
      amount: caller.bet,
      stage: 'river',
      timestamp: 2,
    });
    const r = evaluateRemainingVariantPolicy(s.hero, s.state, s.baseline, null, 'shadow', () => 0);
    expect(r.receipt.fired).toBe(true);
    expect(r.receipt.aggressorPosition).toBe('small_blind');
  });
  it.each(variants)('%s keeps a folded seat in the sampled deck when it sits out', (variant) => {
    const s = remainingVariantSpot(variant, 'turn', 3);
    s.state.players[2].is_folded = true;
    seedFastRandom(220913);
    const before = sampleRemainingVariantEquity(variant, s.hero, s.state, () => true);
    s.state.players[2].is_sitting_out = true;
    seedFastRandom(220913);
    const after = sampleRemainingVariantEquity(variant, s.hero, s.state, () => true);
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect({ ...after, analysisMs: 0 }).toEqual({ ...before, analysisMs: 0 });
  });
  it.each(variants)(
    '%s runs through HorseLogic in shadow with identical baseline actions and RNG',
    (variant) => {
      for (const mode of ['cash', 'tournament'] as const) {
        if (variant === 'pineapple' && mode === 'tournament') continue;
        for (const street of ['preflop', 'flop', 'turn', 'river'] as const) {
          const s = remainingVariantSpot(variant, street, 2, mode);
          const opts = { telemetry: false, mind: false, decisionTimeMs: 0 };
          seedFastRandom(121001);
          const off = HorseLogic.decide(
              s.hero,
              s.state,
              'balanced',
              {},
              { ...opts, phase12Remaining: 'off' }
            ),
            rng = saveFastRandom();
          seedFastRandom(121001);
          const shadow = HorseLogic.decide(
            s.hero,
            s.state,
            'balanced',
            {},
            { ...opts, phase12Remaining: 'shadow', phase12EvidenceMode: true }
          );
          expect({
            action: shadow.action,
            amount: shadow.amount,
            thinkTime: shadow.thinkTime,
          }).toEqual({ action: off.action, amount: off.amount, thinkTime: off.thinkTime });
          expect(saveFastRandom()).toBe(rng);
          expect(shadow.remainingVariantPolicy?.fired).toBe(true);
          expect(shadow.remainingVariantPolicy?.applied).toBe(false);
          expect(shadow.remainingVariantPolicy?.executionStatus).toBe('pending');
          if (mode === 'tournament')
            expect(shadow.remainingVariantPolicy?.utilityOwner).toBe('phase7_evaluated');
        }
      }
    }
  );
  it.each(variants)(
    '%s computes all supported seat, street and position cases without changing inputs',
    (variant) => {
      for (const mode of ['cash', 'tournament'] as const) {
        if (variant === 'pineapple' && mode === 'tournament') continue;
        for (let seats = 2; seats <= remainingVariantSeatCap(variant, mode); seats++)
          for (const street of ['preflop', 'flop', 'turn', 'river'] as const)
            for (let dealer = 1; dealer <= seats; dealer++) {
              const spot = remainingVariantSpot(variant, street, seats, mode);
              spot.state.dealerSeat = dealer;
              const before = JSON.stringify(spot);
              seedFastRandom(120011);
              const rng = saveFastRandom();
              const r = evaluateRemainingVariantPolicy(
                spot.hero,
                spot.state,
                spot.baseline,
                null,
                'shadow',
                () => 0
              );
              expect(r.receipt.eligible, JSON.stringify(r.receipt)).toBe(true);
              expect(r.receipt.fired, JSON.stringify(r.receipt)).toBe(true);
              expect(r.decision).toBe(spot.baseline);
              expect(saveFastRandom()).toBe(rng);
              expect(JSON.stringify(spot)).toBe(before);
              expect(spot.state.legalActions).toContain(r.proposal.action);
              if (['bet', 'raise'].includes(r.proposal.action)) {
                expect(r.proposal.amount).toBeGreaterThanOrEqual(spot.state.minRaiseTo!);
                expect(r.proposal.amount).toBeLessThanOrEqual(spot.state.maxRaiseTo!);
                if (REMAINING_VARIANT_PACKS[variant].structure === 'fixed_limit')
                  expect(r.proposal.amount).toBe(spot.state.minRaiseTo);
              }
              if (street !== 'preflop') expect(r.receipt.equity?.samples).toBeGreaterThan(0);
            }
      }
    }
  );
  it('uses separate high/low structure, short-deck connectivity and fixed-limit entry thresholds', () => {
    expect(
      remainingVariantHandShape('flo8', remainingCards('As 2s 3d Ac')).quality
    ).toBeGreaterThan(remainingVariantHandShape('flo8', remainingCards('Kh Qc Jd Ts')).quality);
    expect(
      remainingVariantHandShape('short_deck', remainingCards('9s Ts')).quality
    ).toBeGreaterThan(remainingVariantHandShape('short_deck', remainingCards('9s Th')).quality);
    const node = {
      position: 'button' as const,
      aggressorPosition: 'early' as const,
      role: 'three_bet' as const,
      seats: 6,
      depthBB: 100,
      rakePercent: 5,
      anteBB: 0,
      straddle: false,
    };
    expect(remainingVariantEntryBars('flh', node)).not.toEqual(
      remainingVariantEntryBars('short_deck', node)
    );
    expect(remainingVariantEntryBars('flo8', node)).not.toEqual(
      remainingVariantEntryBars('flh', node)
    );
  });
  it.each(['flh', 'flo8'] as const)(
    '%s obeys fixed-limit cap and short-all-in authority',
    (variant) => {
      const s = remainingVariantSpot(variant, 'preflop');
      s.state.wagersCapped = true;
      s.state.legalActions = ['fold', 'call'];
      s.state.minRaiseTo = null;
      s.state.maxRaiseTo = null;
      expect(
        evaluateRemainingVariantPolicy(s.hero, s.state, s.baseline, null, 'candidate', () => 0)
          .proposal.action
      ).toBe('call');
      s.state.legalActions.push('raise');
      s.state.minRaiseTo = 4;
      s.state.maxRaiseTo = 4;
      expect(
        evaluateRemainingVariantPolicy(s.hero, s.state, s.baseline, null, 'candidate', () => 0)
          .receipt.reason
      ).toBe('fixed_limit_geometry_unavailable');
      s.state.wagersCapped = false;
      s.state.fixedBetSize = 4;
      expect(
        evaluateRemainingVariantPolicy(s.hero, s.state, s.baseline, null, 'candidate', () => 0)
          .receipt.fired
      ).toBe(false);
    }
  );
  it('binds Pineapple discard choices to only the flop and validates all three card choices', () => {
    const cards = remainingCards('As Ks 2d'),
      flop = remainingCards('Qs Js 7c');
    expect(choosePineappleFlopPair(cards, flop)).toEqual(remainingCards('As Ks'));
    for (const order of [
      [0, 1, 2],
      [1, 2, 0],
      [2, 0, 1],
    ])
      expect(
        new Set(
          choosePineappleFlopPair(
            order.map((i) => cards[i]),
            flop
          ).map((c) => c.rank + ':' + c.suit)
        )
      ).toEqual(new Set(remainingCards('As Ks').map((c) => c.rank + ':' + c.suit)));
    expect(() => choosePineappleFlopPair(cards, [...flop, ...remainingCards('2c')])).toThrow();
    expect(() => choosePineappleFlopPair(cards, [cards[0], ...flop.slice(1)])).toThrow();
  });
  it.each(variants)(
    '%s isolates the private and baseline random streams while responding to public lines',
    (variant) => {
      const s = remainingVariantSpot(variant, 'turn', 4);
      seedFastRandom(12999);
      const rng = saveFastRandom();
      const run = () => {
        const r = sampleRemainingVariantEquity(variant, s.hero, s.state, () => true)!;
        return { ...r, analysisMs: 0 };
      };
      const first = run();
      expect(first.samples).toBeGreaterThan(0);
      expect(saveFastRandom()).toBe(rng);
      s.state.players[1].cards = remainingCards('2c 3c');
      s.state.players[1].knownDeadCards = remainingCards('4c');
      expect(run()).toEqual(first);
      s.state.actionHistory = Array.from({ length: 5 }, (_, i) => ({
        seat: 2,
        userId: 'v3',
        action: 'raise' as const,
        amount: 20,
        stage: 'turn' as const,
        timestamp: i,
      }));
      expect(run()).not.toEqual(first);
    }
  );
  it('excludes known Pineapple discards and fails closed when they are missing or impossible', () => {
    const s = remainingVariantSpot('pineapple');
    s.hero.cards = remainingCards('9s 9d');
    s.hero.knownDeadCards = remainingCards('9h');
    s.state.communityCards = remainingCards('9c 7h 3s 2d Ac');
    seedFastRandom(1222);
    const r = sampleRemainingVariantEquity('pineapple', s.hero, s.state, () => true);
    expect(r?.samples).toBeGreaterThan(0);
    s.hero.knownDeadCards = [];
    expect(sampleRemainingVariantEquity('pineapple', s.hero, s.state, () => true)).toBeNull();
    expect(
      evaluateRemainingVariantPolicy(s.hero, s.state, s.baseline, null, 'candidate', () => 0)
        .receipt.reason
    ).toBe('known_discard_unavailable');
    s.hero.knownDeadCards = remainingCards('9s');
    expect(sampleRemainingVariantEquity('pineapple', s.hero, s.state, () => true)).toBeNull();
  });
  it('preserves named launch, multiboard, malformed evidence and deadline boundaries', () => {
    const p = remainingVariantSpot('pineapple', 'preflop', 2, 'tournament');
    expect(
      evaluateRemainingVariantPolicy(p.hero, p.state, p.baseline, null, 'candidate', () => 0)
        .receipt.reason
    ).toBe('pineapple_tournament_unapproved');
    const s = remainingVariantSpot('short_deck');
    const run = () =>
      evaluateRemainingVariantPolicy(s.hero, s.state, s.baseline, null, 'candidate', () => 0);
    s.state.boardCount = 2;
    expect(run().receipt.reason).toBe('multiboard_owned_by_phase13');
    s.state.boardCount = 1;
    s.hero.cards = remainingCards('2s As');
    expect(run().receipt.reason).toBe('invalid_cards');
    s.hero.cards = remainingCards('As Ad');
    let clock = 0;
    const stopped = evaluateRemainingVariantPolicy(
      s.hero,
      s.state,
      s.baseline,
      null,
      'candidate',
      () => (clock += 5)
    );
    expect(stopped.receipt.reason).toBe('work_budget');
    expect(stopped.decision).toBe(s.baseline);
    expect(stopped.receipt.fired).toBe(false);
    const evidence = sampleRemainingVariantEquity('short_deck', s.hero, s.state, () => true)!;
    evidence.analysisMs = 0;
    evidence.distribution = [null as any];
    expect(
      evaluateRemainingVariantPolicy(s.hero, s.state, s.baseline, evidence, 'candidate', () => 0)
        .receipt.reason
    ).toBe('invalid_equity_evidence');
  });
});
