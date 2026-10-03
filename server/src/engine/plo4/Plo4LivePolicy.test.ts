import { describe, expect, it } from 'vitest';
import {
  evaluatePlo4LivePolicy,
  plo4EntryBars,
  plo4PreflopChoice,
  plo4Role,
  plo4Position,
} from './Plo4LivePolicy.js';
import { plo4CertificationCoordinates, plo4CoverageMatrix } from './Plo4PolicyPack.js';
import { plo4Cards, plo4ReferenceSpot } from '../../benchmark/Plo4PolicyEvidence.js';
import { HorseLogic } from '../HorseLogic.js';
import { calculateContestablePot, calculatePots } from '../PokerEngine.js';
import { seedFastRandom } from '../HorseEval.js';
import { plo4PublicRanges } from '../../benchmark/Plo4PublicRanges.js';
import * as live from './Plo4LivePolicy.js';
import { horsePolicyOwnership } from '../HorsePolicyRegistry.js';
import { HorseMind } from '../HorseMind.js';
import { HandController } from '../HandController.js';
import { deadButtonPositions } from '../deadButton.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import type { Plo4LiveReceipt } from './Plo4LivePolicy.js';
import type { Card, HandConfig, HorseDecision, SeatPlayer } from '../../types.js';

const evidence = { equity: 0.68, samples: 200, standardError: 0.025 };
const tournament = (input: ReturnType<typeof plo4ReferenceSpot>) => {
  input.state.gameMode = 'tournament';
  input.state.format = 'sng';
  input.state.pots = calculatePots(input.state.players);
  input.state.tournament = {
    schemaVersion: 1,
    contextStatus: 'complete',
    contextIssues: [],
    playersLeft: 2,
    spotsPaid: 1,
    payoutPct: [100],
    stacks: input.state.players.map((p) => p.stack + p.totalInvested),
    stackByUser: Object.fromEntries(
      input.state.players.map((p) => [p.user_id, p.stack + p.totalInvested])
    ),
    currentSmallBlind: 1,
    currentBigBlind: 2,
    currentAnte: 0,
    anteType: 'none',
    prizePoolCents: 10000,
    bountyPoolCents: 0,
    isPko: false,
    isBounty: false,
    isMysteryBounty: false,
    mysteryBountyStage: 'none',
    reentryOpen: false,
    rebuyOpen: false,
    addOnPeriodOpen: false,
    maxReentries: 0,
    maxRebuys: 0,
    reloadsUsed: 0,
    addOnTaken: false,
    rebuyAffordable: false,
    addOnAffordable: false,
  };
  return input;
};
describe('Phase 10 complete bounded PLO4 baseline', () => {
  it('uses the canonical dealt census for position and rake when an undealt seat is present', () => {
    const input = plo4ReferenceSpot('non_nut_flush');
    input.state.dealtSeatIds = [1, 2];
    input.state.players.push({
      ...input.state.players[1],
      user_id: 'undealt',
      seat: 3,
      bet: 0,
      totalInvested: 0,
      is_sitting_out: true,
    });
    expect(plo4Position(2, input.state)).toBe('big_blind');
    const r = evaluatePlo4LivePolicy(
      input.hero,
      input.state,
      input.baseline,
      null,
      'shadow',
      () => 0
    );
    expect(r.receipt.fired).toBe(true);
    expect(r.receipt.callPrice).toBeCloseTo(20 / 76, 12);
    input.state.dealtSeatIds = [1];
    expect(
      evaluatePlo4LivePolicy(input.hero, input.state, input.baseline, null, 'shadow', () => 0)
        .receipt.reason
    ).toBe('canonical_state_unavailable');
  });
  it('uses the dealt ring when the dealer or a blind has since sat out', () => {
    const input = plo4ReferenceSpot('premium_open');
    input.state.players.push({
      ...input.state.players[1],
      user_id: 'away',
      seat: 3,
      stack: 100,
      bet: 0,
      totalInvested: 0,
      is_sitting_out: true,
      is_folded: true,
    });
    input.state.dealerSeat = 3;
    expect(plo4Position(1, input.state)).toBe('small_blind');
    expect(plo4Position(2, input.state)).toBe('big_blind');
    const result = evaluatePlo4LivePolicy(
      input.hero,
      input.state,
      input.baseline,
      null,
      'shadow',
      () => 0
    );
    expect(result.receipt.fired).toBe(true);
    expect(result.receipt.position).toBe('small_blind');
    expect(result.decision).toBe(input.baseline);
  });
  it('retains the actual raiser when a later opponent calls all-in', () => {
    const input = plo4ReferenceSpot('premium_open');
    input.state.players[1].bet = input.state.players[1].totalInvested = 6;
    input.state.players.push({
      ...input.state.players[1],
      user_id: 'caller',
      seat: 3,
      stack: 0,
      is_all_in: true,
    });
    Object.assign(input.state, {
      currentBet: 6,
      toCall: 5,
      pot: 13,
      minRaiseTo: 10,
      maxRaiseTo: 24,
    });
    input.state.actionHistory = [
      {
        userId: 'opponent',
        seat: 2,
        stage: 'preflop',
        action: 'raise',
        amount: 6,
        timestamp: 1,
        isFullRaise: true,
      },
      { userId: 'caller', seat: 3, stage: 'preflop', action: 'all_in', amount: 6, timestamp: 2 },
    ];
    const result = evaluatePlo4LivePolicy(
      input.hero,
      input.state,
      input.baseline,
      null,
      'shadow',
      () => 0
    );
    expect(result.receipt.fired).toBe(true);
    expect(result.receipt.role).toBe('squeeze');
    expect(result.receipt.aggressorPosition).toBe('small_blind');
  });
  it.each([2, 3, 4])(
    'classifies %i accepted preflop raises at the correct reraising node',
    (count) => {
      const input = plo4ReferenceSpot('premium_open');
      input.state.actionHistory = Array.from({ length: count }, (_, i) => ({
        userId: i % 2 ? 'hero' : 'opponent',
        seat: i % 2 ? 1 : 2,
        stage: 'preflop',
        action: 'raise',
        amount: 6 * 2 ** i,
        timestamp: i + 1,
        isFullRaise: true,
      }));
      expect(plo4Role(input.hero, input.state)).toBe(count >= 3 ? 'five_bet_plus' : 'four_bet');
    }
  );
  it('refuses a mismatched hero snapshot before generating a proposal', () => {
    const input = plo4ReferenceSpot('premium_open');
    input.state.players[0].stack += 1;
    const result = evaluatePlo4LivePolicy(
      input.hero,
      input.state,
      input.baseline,
      null,
      'candidate',
      () => 0
    );
    expect(result.receipt.fired).toBe(false);
    expect(result.receipt.reason).toBe('canonical_state_unavailable');
    expect(result.decision).toBe(input.baseline);
  });
  it.each([NaN, Infinity])('refuses a non-finite wager bound %s', (amount) => {
    const input = plo4ReferenceSpot('premium_open');
    input.state.maxRaiseTo = amount;
    const result = evaluatePlo4LivePolicy(
      input.hero,
      input.state,
      input.baseline,
      null,
      'candidate',
      () => 0
    );
    expect(result.receipt.fired).toBe(false);
    expect(result.receipt.reason).toBe('invalid_wager_geometry');
    expect(result.decision).toBe(input.baseline);
  });
  it('does not mistake the best flush for the nuts on a straight-flush board', () => {
    const input = plo4ReferenceSpot('non_nut_flush');
    input.hero.cards = plo4Cards('As 2s Kc Qd');
    input.state.communityCards = plo4Cards('Js Ts 9s 2d 3h');
    const result = evaluatePlo4LivePolicy(
      input.hero,
      input.state,
      input.baseline,
      { equity: 0, samples: 100000, standardError: 0 },
      'candidate',
      () => 0
    );
    expect(result.receipt.reason).toBe('postflop_price_fold');
    expect(result.decision.action).toBe('fold');
  });
  it('charges rake to the complete eligible pot, including the new call', () => {
    const input = plo4ReferenceSpot('non_nut_flush');
    const receipt = evaluatePlo4LivePolicy(
      input.hero,
      input.state,
      input.baseline,
      { equity: 0.261, samples: 100000, standardError: 0 },
      'candidate',
      () => 0
    );
    // Heads-up ceiling is 5%: 60 existing + 20 call - 4 rake = 76.
    expect(receipt.receipt.callPrice).toBeCloseTo(20 / 76, 12);
    expect(receipt.decision.action).toBe('fold');
    input.state.rakeConfig!.cap = 2;
    expect(
      evaluatePlo4LivePolicy(input.hero, input.state, input.baseline, null, 'shadow', () => 0)
        .receipt.callPrice
    ).toBeCloseTo(20 / 78, 12);

    input.hero.stack = 20;
    input.hero.totalInvested = 10;
    input.state.players[0] = { ...input.hero, cards: [] };
    input.state.players[1].bet = 30;
    input.state.players[1].totalInvested = 50;
    input.state.players.push({ ...input.state.players[1], user_id: 'third', seat: 3 });
    input.state.pot = 110;
    input.state.currentBet = input.state.toCall = 30;
    input.state.rakeConfig!.cap = 100;
    // A 20 call can win only the 90 main pot. The 40 side pot is excluded;
    // 10% proportional rake leaves 81 eligible, not 117 from the whole pot.
    const sidePot = evaluatePlo4LivePolicy(
      input.hero,
      input.state,
      input.baseline,
      null,
      'shadow',
      () => 0
    );
    expect(sidePot.receipt.fired).toBe(true);
    expect(sidePot.receipt.callPrice).toBeCloseTo(20 / 81, 12);
  });
  it.each([
    ['Ac Kc Qd Js', 'As Ah Ad 3c 4h', 'quads'],
    ['Ac Kh Qd Js', 'As Ah Kc 3c 4h', 'full_house'],
  ])(
    'prices %s without requiring a pocket pair or a sampled-equity receipt',
    (hole, board, feature) => {
      const input = plo4ReferenceSpot('royal_flush');
      input.hero.cards = plo4Cards(hole);
      input.state.communityCards = plo4Cards(board);
      const facing = evaluatePlo4LivePolicy(
        input.hero,
        input.state,
        input.baseline,
        null,
        'candidate',
        () => 0
      );
      expect(facing.receipt.features).toContain(feature);
      expect(facing.decision.action).toBe('call');
      input.state.currentBet = input.state.toCall = input.state.players[1].bet = 0;
      input.state.legalActions = ['check', 'bet'];
      input.state.minRaiseTo = 2;
      input.state.maxRaiseTo = 60;
      input.baseline = { action: 'check', thinkTime: 0 };
      expect(
        evaluatePlo4LivePolicy(input.hero, input.state, input.baseline, null, 'candidate', () => 0)
          .decision.action
      ).toBe('bet');
    }
  );
  it('distinguishes all-in calls from short raises using the controller flag', () => {
    const input = plo4ReferenceSpot('premium_open');
    input.state.actionHistory = [
      { userId: 'opponent', seat: 2, stage: 'preflop', action: 'all_in', amount: 2, timestamp: 1 },
    ];
    expect(plo4Role(input.hero, input.state)).toBe('isolation');
    input.state.actionHistory[0].isFullRaise = false;
    expect(plo4Role(input.hero, input.state)).toBe('three_bet');
    input.state.actionHistory.push({
      userId: 'caller',
      seat: 3,
      stage: 'preflop',
      action: 'all_in',
      amount: 2,
      timestamp: 2,
    });
    expect(plo4Role(input.hero, input.state)).toBe('squeeze');
    input.state.actionHistory.push({
      userId: 'caller2',
      seat: 4,
      stage: 'preflop',
      action: 'call',
      amount: 2,
      timestamp: 3,
    });
    expect(plo4Role(input.hero, input.state)).toBe('overcall');
  });
  it('certifies every numeric preflop coordinate and continuous one-chip boundaries', () => {
    let count = 0;
    for (const node of plo4CertificationCoordinates()) {
      const bars = plo4EntryBars(node);
      const next = plo4EntryBars({ ...node, depthBB: node.depthBB + 0.001 });
      for (const key of ['open', 'call', 'raise', 'callOff'] as const) {
        if (
          !Number.isFinite(bars[key]) ||
          bars[key] < 0 ||
          bars[key] > 1.2 ||
          Math.abs(next[key] - bars[key]) > 0.0001
        )
          throw new Error(`Invalid atlas coordinate ${JSON.stringify(node)}`);
      }
      // Exercise the actual shared decision kernel at every coordinate, not
      // only finite matrix labels. Better quality cannot lower the chosen risk.
      const risk = { passive: 0, call: 1, wager: 2 };
      for (const callBB of [0.5, node.depthBB]) {
        let previous = -1;
        for (const quality of [0, 0.4, 0.6, 0.8, 1]) {
          const choice = plo4PreflopChoice(quality, bars, node.role, callBB, node.depthBB);
          if (
            !choice.reason.startsWith('preflop_') ||
            risk[choice.action] < previous ||
            (quality === 0 && choice.action !== 'passive') ||
            (choice.action === 'wager' && !(choice.fraction > 0 && choice.fraction <= 1))
          )
            throw new Error(`Invalid strategy at ${JSON.stringify(node)}`);
          previous = risk[choice.action];
        }
      }
      count++;
    }
    expect(count).toBe(plo4CoverageMatrix().preflopCoordinates);
  });
  it.each(['preflop', 'flop', 'turn', 'river'] as const)(
    'evaluates %s cash/tournament nodes with legal proposals and no input mutation',
    (street) => {
      for (const mode of ['cash', 'tournament'] as const) {
        const input = plo4ReferenceSpot(street === 'preflop' ? 'premium_open' : 'royal_flush');
        input.state.stage = street;
        input.state.communityCards = input.state.communityCards.slice(
          0,
          { preflop: 0, flop: 3, turn: 4, river: 5 }[street]
        );
        if (mode === 'tournament') tournament(input);
        const before = JSON.stringify(input);
        const result = evaluatePlo4LivePolicy(
          input.hero,
          input.state,
          input.baseline,
          evidence,
          'shadow',
          () => 0
        );
        expect(result.receipt.fired).toBe(true);
        expect(result.receipt.eligible).toBe(true);
        expect(result.decision).toBe(input.baseline);
        expect(input.state.legalActions).toContain(result.proposal.action);
        if (['raise', 'bet'].includes(result.proposal.action)) {
          expect(result.proposal.amount).toBeGreaterThanOrEqual(input.state.minRaiseTo!);
          expect(result.proposal.amount).toBeLessThanOrEqual(input.state.maxRaiseTo!);
        }
        expect(JSON.stringify(input)).toBe(before);
      }
    }
  );
  it('fires at eight seats and sub-five-BB effective depth', () => {
    const input = plo4ReferenceSpot('premium_open');
    input.hero.stack = input.state.players[0].stack = 3;
    for (let seat = 3; seat <= 8; seat++)
      input.state.players.push({
        ...input.state.players[1],
        seat,
        user_id: `v${seat}`,
        bet: 0,
        totalInvested: 0,
      });
    input.state.legalActions = ['fold', 'call', 'all_in'];
    input.state.minRaiseTo = null;
    input.state.maxRaiseTo = 4;
    const result = evaluatePlo4LivePolicy(
      input.hero,
      input.state,
      input.baseline,
      null,
      'candidate',
      () => 0
    );
    expect(result.receipt.fired).toBe(true);
    expect(result.decision.action).toBe('all_in');
  });
  it('supports a protected check, value bet, raise-facing fold and bounded call-off', () => {
    const input = plo4ReferenceSpot('royal_flush');
    input.state.currentBet = input.state.toCall = input.state.players[1].bet = 0;
    input.state.legalActions = ['check', 'bet'];
    input.state.minRaiseTo = 2;
    input.state.maxRaiseTo = 60;
    input.baseline = { action: 'check', thinkTime: 0 };
    const value = evaluatePlo4LivePolicy(
      input.hero,
      input.state,
      input.baseline,
      evidence,
      'candidate',
      () => 0
    );
    expect(value.decision.action).toBe('bet');
    input.hero.cards = plo4Cards('2c 3c 4h 5h');
    const weak = evaluatePlo4LivePolicy(
      input.hero,
      input.state,
      input.baseline,
      { equity: 0.05, samples: 200, standardError: 0.01 },
      'candidate',
      () => 0
    );
    expect(weak.decision.action).toBe('check');
    const losing = plo4ReferenceSpot('non_nut_flush');
    losing.state.actionHistory!.push({
      ...losing.state.actionHistory![0],
      action: 'raise',
      timestamp: 2,
    });
    const fold = evaluatePlo4LivePolicy(
      losing.hero,
      losing.state,
      losing.baseline,
      { equity: 0, samples: 200, standardError: 0 },
      'candidate',
      () => 0
    );
    expect(fold.receipt.role).toBe('facing_raise');
    expect(fold.decision.action).toBe('fold');
  });
  it('runs in HorseLogic and keeps Phase 7 the tournament utility owner', () => {
    const input = tournament(plo4ReferenceSpot('royal_flush'));
    seedFastRandom(100101);
    const baseline = HorseLogic.decide(
      input.hero,
      input.state,
      'balanced',
      {},
      { telemetry: false, mind: false, decisionTimeMs: 0, phase10Plo4: 'off' }
    );
    seedFastRandom(100101);
    const shadow = HorseLogic.decide(
      input.hero,
      input.state,
      'balanced',
      {},
      {
        telemetry: false,
        mind: false,
        decisionTimeMs: 0,
        phase10Plo4: 'shadow',
        phase10EvidenceMode: true,
      }
    );
    expect(shadow.action).toBe(baseline.action);
    expect(shadow.amount).toBe(baseline.amount);
    expect(shadow.plo4Policy?.fired).toBe(true);
    expect(shadow.plo4Policy?.utilityOwner).toBe('phase7_evaluated');
    expect(shadow.plo4Policy?.shadowUtility?.candidates.length).toBeGreaterThan(1);
    expect(shadow.plo4Policy?.finalAction).toBe(shadow.action);
    expect(shadow.plo4Policy?.executionStatus).toBe('pending');
  });
  it('rejects private cards and malformed state; falls back on exhausted time', () => {
    const input = plo4ReferenceSpot('royal_flush');
    input.state.players[1].cards = plo4Cards('Ah Ad 6c 7c');
    expect(
      evaluatePlo4LivePolicy(input.hero, input.state, input.baseline, evidence, 'shadow', () => 0)
        .receipt.reason
    ).toBe('private_state_rejected');
    input.state.players[1].cards = [];
    let clock = 0;
    const timeout = evaluatePlo4LivePolicy(
      input.hero,
      input.state,
      input.baseline,
      evidence,
      'candidate',
      () => (clock += 5)
    );
    expect(timeout.receipt.reason).toBe('work_budget');
    expect(timeout.decision).toBe(input.baseline);
  });
  it('conditions each independent prior on that opponent public line only', () => {
    const input = plo4ReferenceSpot('dominated_flop_draw');
    const first = plo4PublicRanges(input.hero, input.state, 100101);
    input.state.actionHistory = [];
    const unraised = plo4PublicRanges(input.hero, input.state, 100101);
    expect(first).not.toEqual(unraised);
    input.state.players[1].cards = plo4Cards('Ah Ad 6c 7c');
    expect(plo4PublicRanges(input.hero, input.state, 100101)).toEqual(unraised);
  });
});

/* ───────────────────────── P10.1 input binding ─────────────────────────
 * Every expected value below is derived by hand from the poker rules named
 * beside it (pot-limit raise-to, the dealt ring, rake tiers, main/side pot
 * eligibility), never by calling the production calculation under test. */
type Spot = ReturnType<typeof plo4ReferenceSpot>;
const run = (input: Spot, ev: Parameters<typeof evaluatePlo4LivePolicy>[3] = null) =>
  evaluatePlo4LivePolicy(input.hero, input.state, input.baseline, ev, 'candidate', () => 0);
const setHero = (input: Spot, patch: Partial<Spot['hero']>) => {
  Object.assign(input.hero, patch);
  input.state.players[0] = { ...input.hero, cards: [] };
};
/** River, hero on the button facing a 20 bet. Seat 3 folded with a deep
 * stack, seat 4 is away but all-in, seat 5 is away and folded, seat 6 was
 * never dealt. Hero covers everyone. */
function censusSpot() {
  const input = plo4ReferenceSpot('non_nut_flush');
  setHero(input, { stack: 1000 });
  const base = input.state.players[1];
  input.state.players.push(
    {
      ...base,
      user_id: 'folded_deep',
      seat: 3,
      stack: 1000,
      bet: 0,
      totalInvested: 20,
      is_folded: true,
    },
    {
      ...base,
      user_id: 'away_all_in',
      seat: 4,
      stack: 0,
      bet: 0,
      totalInvested: 20,
      is_all_in: true,
      is_sitting_out: true,
    },
    {
      ...base,
      user_id: 'away_folded',
      seat: 5,
      stack: 300,
      bet: 0,
      totalInvested: 0,
      is_folded: true,
      is_sitting_out: true,
    },
    {
      ...base,
      user_id: 'spectator',
      seat: 6,
      stack: 500,
      bet: 0,
      totalInvested: 0,
      is_sitting_out: true,
    }
  );
  input.state.dealtSeatIds = [1, 2, 3, 4, 5];
  input.state.pot = 100; // 20 + 40 + 20 + 20
  input.state.maxRaiseTo = 140;
  input.state.rakeConfig = {
    percent: 10,
    cap: 10,
    noFlopNoDrop: true,
    playerCountCaps: [
      { players: 2, cap: 2 },
      { players: 5, cap: 3 },
      { players: 6, cap: 9 },
    ],
  };
  return input;
}
const provenanceFor = (userIds: string[]) => ({
  version: 'plo4-range-provenance-v1' as const,
  source: 'horse_mind_public_line' as const,
  calibration: 'uncalibrated' as const,
  solverInput: false as const,
  publicLine: { window: 'full_hand' as const, actions: 1, sizeReads: true, boardContact: false },
  equity: {
    basis: 'horse_monte_carlo_after_structural_caps' as const,
    structuralCapApplied: false,
    samples: 'adaptive_first_checkpoint' as const,
  },
  scope: 'omaha:short' as const,
  window: { version: 1 as const, coverage: 'complete' as const, fromMs: 1000, toMs: 2000 },
  opponents: userIds.map((userId, i) => ({
    userId,
    band: i === 0 ? ([0.2, 0.7] as [number, number]) : null,
    statistics: (i === 0 ? 'pooled' : 'unavailable') as 'pooled' | 'unavailable',
    scope: null,
    sourceWindow:
      i === 0
        ? { version: 1 as const, coverage: 'complete' as const, fromMs: 1000, toMs: 2000 }
        : { version: 1 as const, coverage: 'unknown' as const, fromMs: null, toMs: null },
  })),
});
const deepFrozen = (value: unknown): boolean =>
  value === null ||
  typeof value !== 'object' ||
  (Object.isFrozen(value) && Object.values(value as object).every(deepFrozen));

describe('P10.1 binds the facts the PLO4 proposal consumed', () => {
  it('records the dealt census and separates folded and away seats from contesting opponents', () => {
    const input = censusSpot();
    const { receipt } = run(input);
    expect(receipt.reason).not.toBe('depth_or_ante_outside_pack');
    expect(receipt.fired).toBe(true);
    const inputs = receipt.inputs!;
    expect(inputs.census).toEqual({
      source: 'dealt_seat_ids',
      dealerSeat: 1,
      heroSeat: 1,
      dealtSeats: [1, 2, 3, 4, 5],
      contestingOpponentSeats: [2, 4],
      actingOpponentSeats: [2],
      foldedSeats: [3, 5],
      awaySeats: [4, 5],
      allInSeats: [4],
    });
    // Five dealt seats, dealer seat 1: hero offset 0 is the button; the seat-2
    // bettor sits one to its left, the small blind.
    expect(inputs.positions).toEqual({
      hero: 'button',
      heroOffset: 0,
      role: 'facing_bet',
      aggressor: 'small_blind',
      aggressorSeat: 2,
      straddle: 'none',
    });
    // Hero covers 1000 (500 BB). The folded 1000 stack cannot be played
    // against; the deepest contesting cover is seat 2's 100 + 20 = 120.
    expect(inputs.depth).toEqual({
      effectiveBB: 60,
      heroCoverBB: 500,
      deepestOpponentCoverBB: 60,
      basis: 'stack_plus_street_bet_vs_deepest_contesting_opponent',
    });
    // Rake tier for five dealt players is the 5-player cap of 3, not 9 (six
    // seated) or 2 (three contesting): 10% of 120 = 12, capped at 3. Hero
    // covers everyone, so the whole 120 after the call is eligible.
    expect(inputs.geometry.rake.dealtCount).toBe(5);
    expect(inputs.geometry.postflop).toEqual({
      contestablePot: 100,
      eligibleAfterCall: 120,
      chargedRake: 3,
      netPotAfterCall: 117,
      callPrice: 20 / 117,
      spr: 10,
    });
    expect(receipt.callPrice).toBe(20 / 117);
    expect(inputs.board).toMatchObject({
      street: 'river',
      cards: 5,
      paired: false,
      flushBoard: true,
    });
    expect(inputs.board.features).toEqual(receipt.features);
    expect(inputs.board.features).toContain('multiway');
    expect(inputs.range.status).toBe('unavailable');
    expect(live.plo4InputBindingIsValid(inputs)).toBe(true);
  });

  it('enforces the exact pot-limit raise-to and records the geometry it used', () => {
    // River royal flush facing 20 into 60: call 20, then raise the pot of
    // 60 + 20 + 20 = 100, so the pot-limit raise-to is 20 + 80 = 100.
    const input = plo4ReferenceSpot('royal_flush');
    setHero(input, { stack: 400 });
    input.state.players[1].stack = 400;
    input.state.maxRaiseTo = 400; // a looser engine bound must not lift the pot limit
    const loose = run(input);
    expect(loose.receipt.reason).toBe('postflop_nut_raise');
    expect(loose.decision).toMatchObject({ action: 'raise', amount: 100 });
    expect(loose.receipt.inputs!.geometry).toMatchObject({
      potLimitRaiseTo: 100,
      stackRaiseTo: 400,
      wagerCap: 100,
      callCost: 20,
      chipUnit: 0.01,
    });
    // A 70 stack caps the raise at the stack, still inside the pot limit.
    setHero(input, { stack: 70 });
    input.state.maxRaiseTo = 70;
    const short = run(input);
    expect(short.decision).toMatchObject({ action: 'raise', amount: 70 });
    expect(short.receipt.inputs!.geometry).toMatchObject({ stackRaiseTo: 70, wagerCap: 70 });
  });

  it.each([
    ['cash', 40.26],
    ['tournament', 40],
  ] as const)('sizes a two-thirds pot bet in %s units exactly', (mode, amount) => {
    // Checked to on the river with 61 in the pot: 0.66 x 61 = 40.26. Cash
    // keeps cents; tournament chips floor to whole chips.
    const input = plo4ReferenceSpot('royal_flush');
    setHero(input, { stack: 400, totalInvested: 21 });
    Object.assign(input.state.players[1], { stack: 400, bet: 0 });
    Object.assign(input.state, {
      pot: 61,
      currentBet: 0,
      toCall: 0,
      legalActions: ['check', 'bet'],
      minRaiseTo: 2,
      maxRaiseTo: 61,
    });
    input.state.actionHistory = [];
    input.baseline = { action: 'check', thinkTime: 0 };
    if (mode === 'tournament') tournament(input);
    const result = run(input);
    expect(result.receipt.reason).toBe('postflop_value');
    expect(result.decision).toMatchObject({ action: 'bet', amount });
    expect(result.receipt.inputs!.geometry).toMatchObject({
      potLimitRaiseTo: 61,
      wagerCap: 61,
      chipUnit: mode === 'tournament' ? 1 : 0.01,
    });
  });

  it('records the side-pot eligible price that the proposal consumed', () => {
    // Hero has 20 behind and 10 in; two opponents are in for 50 with 30 bet.
    // A 20 call reaches 30 in, so hero can win 30 x 3 = 90 (main pot); the
    // 40 above that is a side pot hero cannot win. 10% of the 130 in play is
    // 13, charged proportionally to the eligible 90: 90 - 9 = 81.
    const input = plo4ReferenceSpot('non_nut_flush');
    setHero(input, { stack: 20, totalInvested: 10 });
    Object.assign(input.state.players[1], { bet: 30, totalInvested: 50 });
    input.state.players.push({ ...input.state.players[1], user_id: 'third', seat: 3 });
    Object.assign(input.state, { pot: 110, currentBet: 30, toCall: 30 });
    input.state.rakeConfig!.cap = 100;
    const { receipt } = run(input);
    expect(receipt.fired).toBe(true);
    expect(receipt.inputs!.geometry.postflop).toEqual({
      contestablePot: 70,
      eligibleAfterCall: 90,
      chargedRake: 13,
      netPotAfterCall: 81,
      callPrice: 20 / 81,
      spr: 20 / 70,
    });
    // 30 + 110 + 20 = 160 by pot limit, but hero holds only 20: no raise exists.
    expect(receipt.inputs!.geometry).toMatchObject({
      potLimitRaiseTo: 160,
      stackRaiseTo: 20,
      wagerCap: 20,
    });
  });

  it.each([
    ['both covers at 500', 499, 498, 'fires'],
    ['hero deeper, opponent at 500', 5000, 498, 'fires'],
    ['both one cent past the endpoint', 499.01, 498.01, 'refuses'],
    ['hero deeper, opponent one cent past', 5000, 498.01, 'refuses'],
  ] as const)('applies the 250 BB depth endpoint: %s', (_label, heroStack, villainStack, want) => {
    // Preflop heads-up, big blind 2: covers are stack + street bet, so 499 + 1
    // and 498 + 2 are both 500 chips = 250 BB effective.
    const input = plo4ReferenceSpot('premium_open');
    setHero(input, { stack: heroStack });
    input.state.players[1].stack = villainStack;
    const { receipt } = run(input);
    if (want === 'fires') {
      expect(receipt.fired).toBe(true);
      expect(receipt.inputs!.depth.effectiveBB).toBe(250);
      return;
    }
    expect(receipt.reason).toBe('depth_or_ante_outside_pack');
    expect(receipt.inputs).toBeNull();
    expect(
      horsePolicyOwnership('plo4', { action: 'call', thinkTime: 0, plo4Policy: receipt }, true)
    ).toMatchObject({ outcome: 'outside_domain', reason: 'depth_or_ante_outside_pack' });
  });

  it('accepts an ante of exactly 1 BB and the table straddle, and refuses a larger ante by name', () => {
    const input = plo4ReferenceSpot('premium_open');
    input.state.ante = 2;
    input.state.straddleActive = true;
    const { receipt } = run(input);
    expect(receipt.fired).toBe(true);
    expect(receipt.inputs!.geometry).toMatchObject({ ante: 2, anteBB: 1 });
    expect(receipt.inputs!.positions.straddle).toBe('table_enabled_utg_2bb');
    expect(receipt.inputs!.range.status).toBe('not_consumed_preflop');
    input.state.ante = 2.01;
    expect(run(input).receipt.reason).toBe('depth_or_ante_outside_pack');
  });

  it.each([
    [10, 'fires'],
    [10.01, 'rake_schedule_unavailable'],
    [null, 'rake_schedule_unavailable'],
  ] as const)('applies the rake domain at %s percent', (percent, want) => {
    const input = plo4ReferenceSpot('non_nut_flush');
    if (percent === null) delete input.state.rakeConfig;
    else input.state.rakeConfig!.percent = percent;
    const { receipt } = run(input);
    if (want === 'fires') {
      expect(receipt.fired).toBe(true);
      expect(receipt.inputs!.geometry.rake).toMatchObject({ percent: 10, cap: 10 });
    } else {
      expect(receipt.reason).toBe(want);
      expect(receipt.inputs).toBeNull();
    }
  });

  it('names a nine-handed dealt census as outside the pack, not as unavailable state', () => {
    // PLO4 tournament tables may seat up to the deck limit of 11; the pack
    // declares 2-8 dealt seats.
    const input = plo4ReferenceSpot('premium_open');
    for (let seat = 3; seat <= 9; seat++)
      input.state.players.push({
        ...input.state.players[1],
        seat,
        user_id: `v${seat}`,
        bet: 0,
        totalInvested: 0,
      });
    const { receipt } = run(input);
    expect(receipt.reason).toBe('seat_count_outside_pack');
    expect(receipt.fired).toBe(false);
    expect(receipt.inputs).toBeNull();
    expect(
      horsePolicyOwnership('plo4', { action: 'call', thinkTime: 0, plo4Policy: receipt }, true)
    ).toMatchObject({ outcome: 'outside_domain', reason: 'seat_count_outside_pack' });
  });

  it('rejects private dead cards on an opponent seat', () => {
    const input = plo4ReferenceSpot('non_nut_flush');
    input.state.players[1].knownDeadCards = plo4Cards('2c');
    expect(run(input).receipt).toMatchObject({ reason: 'private_state_rejected', inputs: null });
  });

  it('never records a malformed equity sample as consumed evidence', () => {
    for (const bad of [
      { equity: NaN, samples: 10, standardError: 0.1 },
      { equity: 1.5, samples: 10, standardError: 0.1 },
      { equity: 0.5, samples: 0, standardError: 0.1 },
    ]) {
      const input = plo4ReferenceSpot('non_nut_flush');
      const withBad = run(input, bad);
      const without = run(input, null);
      expect(withBad.receipt.equity).toBeNull();
      expect(withBad.receipt.confidence).toBe('explicit_heuristic');
      expect(withBad.receipt.inputs!.range).toEqual({
        status: 'rejected_malformed',
        equity: null,
        samples: null,
        standardError: null,
        provenance: null,
      });
      expect(withBad.receipt.inputs!.approximation.status).toBe('explicit_heuristic');
      expect(withBad.decision).toEqual(without.decision);
    }
  });

  it.each([
    ['a folded seat', ['opponent', 'away_all_in', 'folded_deep']],
    ['a missing contesting opponent', ['opponent']],
    ['a player from another table', ['opponent', 'elsewhere']],
  ])('refuses an equity sampled against %s', (_label, ids) => {
    const input = censusSpot();
    const evidence = { equity: 0.9, samples: 500, standardError: 0.01 };
    const unattributed = run(input, evidence);
    expect(unattributed.receipt.inputs!.range.status).toBe('consumed_unattributed');
    const consumed = run(input, { ...evidence, range: provenanceFor(['opponent', 'away_all_in']) });
    expect(consumed.receipt.inputs!.range.status).toBe('consumed');
    const foreign = run(input, { ...evidence, range: provenanceFor(ids) });
    expect(foreign.receipt.inputs!.range.status).toBe('rejected_population');
    expect(foreign.receipt.equity).toBeNull();
    expect(foreign.decision).toEqual(run(input, null).decision);
  });

  it.each([
    ['calibration', (p: any) => (p.calibration = 'calibrated')],
    ['solver input', (p: any) => (p.solverInput = true)],
    ['a band with no public line', (p: any) => (p.source = 'uniform_no_public_read')],
    ['a scoped row outside the decision scope', (p: any) => (p.opponents[0].scope = 'holdem:hu')],
    ['an unmerged window', (p: any) => (p.window = { ...p.window, toMs: 9999 })],
  ])('refuses a range provenance that misstates %s', (_label, mutate) => {
    const input = censusSpot();
    const range = provenanceFor(['opponent', 'away_all_in']);
    mutate(range);
    const result = run(input, { equity: 0.9, samples: 500, standardError: 0.01, range });
    expect(result.receipt.inputs!.range.status).toBe('rejected_population');
    expect(result.receipt.equity).toBeNull();
  });

  it('detaches and freezes the binding against later asynchronous mutation', () => {
    const input = censusSpot();
    const range = provenanceFor(['opponent', 'away_all_in']);
    const evidence = { equity: 0.9, samples: 500, standardError: 0.01, range };
    const { receipt } = run(input, evidence);
    const before = JSON.stringify({ inputs: receipt.inputs, equity: receipt.equity });
    expect(deepFrozen(receipt.inputs)).toBe(true);
    expect(deepFrozen(receipt.equity)).toBe(true);
    // The table moves on and the equity owner reuses its objects.
    input.state.players[1].stack = 1;
    input.state.dealtSeatIds!.push(6);
    input.state.communityCards[0].rank = '2';
    input.state.rakeConfig!.percent = 0;
    input.state.rakeConfig!.playerCountCaps![1].cap = 99;
    input.state.actionHistory!.length = 0;
    evidence.equity = 0.01;
    range.opponents[0].band![0] = 0.99;
    range.opponents[0].userId = 'someone_else';
    range.window.toMs = 1;
    expect(JSON.stringify({ inputs: receipt.inputs, equity: receipt.equity })).toBe(before);
    expect(() => {
      (receipt.inputs!.geometry as { pot: number }).pot = 0;
    }).toThrow(TypeError);
  });

  it('binds HorseMind public-line ranges and their observation window from the live equity pass', () => {
    const input = plo4ReferenceSpot('dominated_flop_draw');
    input.state.actionHistory = [
      {
        userId: 'opponent',
        seat: 2,
        stage: 'preflop',
        action: 'raise',
        amount: 6,
        timestamp: 1,
        isFullRaise: true,
      },
      { userId: 'hero', seat: 1, stage: 'preflop', action: 'call', amount: 5, timestamp: 2 },
      ...input.state.actionHistory!,
    ];
    const window = { version: 1 as const, coverage: 'complete' as const, fromMs: 1000, toMs: 2000 };
    const decide = (mind: boolean, observeMind = false) => {
      const reads = HorseMind.createSandbox();
      return HorseMind.runInSandbox(reads, () => {
        HorseMind.importStats([
          {
            user_id: 'opponent',
            hands: 30,
            vpip: 12,
            pfr: 8,
            folds: 10,
            facedAggr: 15,
            sourceWindow: window,
          },
        ]);
        seedFastRandom(100101);
        return HorseLogic.decide(
          input.hero,
          input.state,
          'balanced',
          {},
          {
            telemetry: false,
            mind,
            observeMind,
            decisionTimeMs: 0,
            phase10Plo4: 'shadow',
            phase10EvidenceMode: true,
            phase13Joint: 'off',
          }
        );
      });
    };
    const withMind = decide(true).plo4Policy!;
    expect(withMind.inputs!.range.status).toBe('consumed');
    const provenance = withMind.inputs!.range.provenance!;
    expect(provenance).toMatchObject({
      source: 'horse_mind_public_line',
      calibration: 'uncalibrated',
      solverInput: false,
      scope: 'omaha:hu',
      window,
      publicLine: { window: 'full_hand', actions: 3 },
    });
    expect(provenance.opponents).toHaveLength(1);
    expect(provenance.opponents[0]).toMatchObject({
      userId: 'opponent',
      statistics: 'pooled', // 30 scoped hands would be below the 40-hand scope floor
      scope: null,
      sourceWindow: window,
    });
    expect(provenance.opponents[0].band).not.toBeNull();
    expect(withMind.inputs!.approximation.status).toBe(
      'explicit_heuristic_with_uncalibrated_range_sample'
    );
    expect(withMind.equity).toEqual({
      equity: withMind.inputs!.range.equity,
      samples: withMind.inputs!.range.samples,
      standardError: withMind.inputs!.range.standardError,
    });
    // With observation on, the opponent's public raise (timestamp 1) enters the
    // pooled row before the equity pass, so the bound envelope widens to 1..2000.
    const observed = decide(true, true).plo4Policy!.inputs!.range.provenance!;
    expect(observed.opponents[0].sourceWindow).toEqual({ ...window, fromMs: 1 });
    expect(observed.window).toEqual({ ...window, fromMs: 1 });
    const withoutMind = decide(false).plo4Policy!;
    expect(withoutMind.inputs!.range.provenance).toMatchObject({
      source: 'uniform_mind_disabled',
      opponents: [{ userId: 'opponent', band: null, statistics: 'disabled', scope: null }],
    });
    // The canonical journal JSON round trip keeps the same commitment.
    const sha = live.plo4InputBindingSha256(withMind.inputs!);
    expect(sha).toMatch(/^[a-f0-9]{64}$/);
    expect(live.plo4InputBindingSha256(JSON.parse(JSON.stringify(withMind.inputs)))).toBe(sha);
    expect(live.plo4InputBindingIsValid(structuredClone(withMind.inputs))).toBe(true);
  });

  it.each([
    [
      'heuristic shape relabeled as a probability',
      (b: any) => (b.approximation.handShape.probability = true),
    ],
    ['a solver-input claim', (b: any) => (b.approximation.solverInput = true)],
    ['a calibrated pack', (b: any) => (b.pack.calibratedConfidence = 0.9)],
    ['a range sample claimed without consumption', (b: any) => (b.range.status = 'unavailable')],
    ['a contesting folded seat', (b: any) => (b.census.foldedSeats = [2, 3, 5])],
    ['depth beyond the pack', (b: any) => (b.depth.effectiveBB = 250.5)],
    [
      'a census beyond eight seats',
      (b: any) => (b.census.dealtSeats = [1, 2, 3, 4, 5, 6, 7, 8, 9]),
    ],
  ])('rejects a returned binding with %s', (_label, mutate) => {
    const input = censusSpot();
    const { receipt } = run(input, {
      equity: 0.9,
      samples: 500,
      standardError: 0.01,
      range: provenanceFor(['opponent', 'away_all_in']),
    });
    const binding = structuredClone(receipt.inputs) as any;
    expect(live.plo4InputBindingIsValid(binding)).toBe(true);
    mutate(binding);
    expect(live.plo4InputBindingIsValid(binding)).toBe(false);
    expect(
      live.plo4LiveReceiptBindingIsValid({ ...structuredClone(receipt), inputs: binding })
    ).toBe(false);
  });
});

/**
 * P10.1 DEFECT 3: THE TOURNAMENT DEAD BUTTON (natural evidence, engine 46bb9cf6).
 *
 * Every hand here is a real engine hand: the button and the blind seats come
 * from the engine's own rule (deadButtonPositions, TDA Rule 30, the one
 * definition ServerTableEngineDealing applies to tournament tables), and
 * HandController posts and deals it from `config.blindSeats` exactly as the
 * dealing loop tells it. The expected positions are derived from what the
 * engine actually did (which seats posted the blinds, who acts first), never
 * from the policy's own arithmetic.
 */
describe('P10.1 defect 3: tournament dead button', () => {
  const SB = 10;
  const BB = 20;
  const DECK = 'AKQJT98765432'
    .split('')
    .flatMap((rank) => ['s', 'h', 'd', 'c'].map((suit) => rank + suit))
    .join(' ');

  function deadButtonHand(
    seatsNow: number[],
    lastBlinds: { smallBlind: number; bigBlind: number }
  ) {
    const blinds = deadButtonPositions(seatsNow, lastBlinds)!;
    const players: SeatPlayer[] = seatsNow.map((seat) => ({
      seat,
      user_id: `p${seat}`,
      username: `P${seat}`,
      stack: 2000,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      is_horse: true,
    }));
    const config: HandConfig = {
      tableId: 'p10-1-dead-button',
      handNumber: 7,
      gameVariant: 'plo4',
      smallBlind: SB,
      bigBlind: BB,
      ante: 0,
      isTournament: true,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      // ServerTableEngineDealing: `blindSeats: isTournamentTable() ? {...} : undefined`
      blindSeats: { smallBlind: blinds.smallBlind, bigBlind: blinds.bigBlind },
    };
    const controller = new HandController(config, players, blinds.button);
    const deck = plo4Cards(DECK);
    const instance = controller.getState().deck as unknown as {
      deal(n?: number): Card[];
      dealOne(): Card;
      remaining(): number;
      getRemainingCards(): Card[];
    };
    instance.deal = (n = 1) => deck.splice(0, n);
    instance.dealOne = () => instance.deal(1)[0];
    instance.remaining = () => deck.length;
    instance.getRemainingCards = () => deck.slice();
    controller.start();
    /** The decision request for the seat to act, shaped like the live builder's. */
    const view = () => {
      const state = controller.getState();
      const actor = state.players.find((p) => p.seat === state.currentPlayerSeat)!;
      const menu = controller.getAuthoritativeActionState(actor.user_id)!;
      const s: HorseGameStateV2 = {
        stateSchemaVersion: 1,
        dealtSeatIds: state.players
          .filter((p) => p.cards.length > 0)
          .map((p) => p.seat)
          .sort((a, b) => a - b),
        ...controller.getChipRulesSnapshot(),
        heroSeat: actor.seat,
        currentPlayerSeat: actor.seat,
        legalActions: [...menu.legalActions],
        toCall: menu.toCall,
        minRaiseTo: menu.minRaiseTo,
        maxRaiseTo: menu.maxRaiseTo,
        bettingStructure: menu.structure,
        pots: controller.computeLivePots(),
        contestablePot: calculateContestablePot(state.players, actor.user_id, menu.toCall),
        rakeConfig: config.rakeConfig,
        players: state.players.map((p) => ({ ...p, cards: [] })),
        communityCards: [...state.communityCards],
        communityCards2: [],
        communityCards3: [],
        bombPot: false,
        boardCount: 1,
        pot: state.pot,
        currentBet: state.currentBet,
        minRaise: state.minRaise,
        stage: state.stage,
        gameVariant: 'plo4',
        bigBlind: BB,
        dealerSeat: state.dealerSeat,
        lastRaise: state.lastRaise,
        actionHistory: state.actionHistory.map((a) => ({ ...a })),
        gameMode: 'tournament',
        format: 'mtt',
        ante: 0,
        straddleActive: false,
        tournament: {
          schemaVersion: 1,
          contextStatus: 'complete',
          contextIssues: [],
          currentSmallBlind: SB,
          currentBigBlind: BB,
          currentAnte: 0,
          anteType: 'none',
          playersLeft: 40,
          spotsPaid: 6,
          payoutPct: [40, 25, 15, 10, 6, 4],
          stacks: state.players.map((p) => p.stack + p.totalInvested),
          stackByUser: Object.fromEntries(
            state.players.map((p) => [p.user_id, p.stack + p.totalInvested])
          ),
        },
      } as HorseGameStateV2;
      const hero = { ...actor, cards: [...actor.cards] };
      const baseline: HorseDecision = {
        action: menu.toCall > 0 ? 'call' : 'check',
        ...(menu.toCall > 0 ? { amount: menu.toCall } : {}),
        thinkTime: 0,
      };
      const result = evaluatePlo4LivePolicy(hero, s, baseline, null, 'shadow', () => 0);
      return { state, actor, menu, s, hero, baseline, result };
    };
    const act = (action: 'call' | 'check' | 'raise' | 'bet', amount?: number) => {
      const seat = controller.getState().currentPlayerSeat;
      expect(controller.performAction(seat, action, amount)).toBe(true);
    };
    return { blinds, controller, view, act };
  }
  const posted = (controller: HandController) =>
    Object.fromEntries(
      controller
        .getState()
        .players.filter((p) => p.bet > 0)
        .map((p) => [p.seat, p.bet])
    );
  const ownership = (receipt: Plo4LiveReceipt) =>
    horsePolicyOwnership('plo4', { action: 'call', thinkTime: 0, plo4Policy: receipt }, true);

  // The production record (eventId 008571cc..., 15:09:37Z): dealt seats
  // 1, 2, 4, 6, 7, 8 and dealer seat 5, empty. Last hand seat 5 held the
  // small blind and seat 6 the big blind; seat 5 has since busted.
  const PRODUCTION = { seats: [1, 2, 4, 6, 7, 8], last: { smallBlind: 5, bigBlind: 6 } };
  // Derived from the engine's postings below: seat 6 posts the small blind,
  // seat 7 the big blind, seat 8 opens the action, and seat 4 is the last
  // seat to act before the blinds preflop and the last to act postflop, the
  // button's action slot. Offsets count clockwise from the dead button.
  const EXPECTED: Record<number, [string, number]> = {
    6: ['small_blind', 1],
    7: ['big_blind', 2],
    8: ['early', 3],
    1: ['middle', 4],
    2: ['cutoff', 5],
    4: ['button', 0],
  };

  it('computes every preflop decision of the production hand, positions counted from the dead button', () => {
    const hand = deadButtonHand(PRODUCTION.seats, PRODUCTION.last);
    // The engine's own rule and postings, independently of the policy.
    expect(hand.blinds).toEqual({ button: 5, smallBlindSeat: 6, smallBlind: 6, bigBlind: 7 });
    expect(hand.controller.getState().dealerSeat).toBe(5);
    expect(posted(hand.controller)).toEqual({ 6: SB, 7: BB });
    const order: number[] = [];
    for (let i = 0; i < 6; i++) {
      const { actor, menu, baseline, result } = hand.view();
      order.push(actor.seat);
      const [position, offset] = EXPECTED[actor.seat];
      expect(result.receipt.reason).not.toBe('canonical_state_unavailable');
      expect(result.receipt).toMatchObject({ eligible: true, fired: true, position });
      // Shadow: the decision the table receives is the baseline.
      expect(result.receipt.applied).toBe(false);
      expect(result.decision).toBe(baseline);
      expect(ownership(result.receipt)).toMatchObject({ outcome: 'computed' });
      const inputs = result.receipt.inputs!;
      expect(live.plo4InputBindingIsValid(structuredClone(inputs))).toBe(true);
      expect(inputs.census).toMatchObject({
        source: 'dealt_seat_ids',
        dealerSeat: 5,
        heroSeat: actor.seat,
        dealtSeats: [1, 2, 4, 6, 7, 8],
      });
      expect(inputs.positions).toMatchObject({
        hero: position,
        heroOffset: offset,
        straddle: 'none',
        aggressor: i === 0 ? null : 'early',
        aggressorSeat: i === 0 ? null : 8,
      });
      // Pot-limit geometry comes from the engine's pot, not from positions.
      const callCost = Math.max(0, menu.toCall);
      expect(inputs.geometry.callCost).toBe(callCost);
      expect(inputs.geometry.potLimitRaiseTo).toBe(
        hand.controller.getState().currentBet + hand.controller.getState().pot + callCost
      );
      if (i === 0) {
        expect(result.receipt.role).toBe('rfi');
        hand.act('raise', menu.minRaiseTo!);
      } else hand.act('call');
    }
    expect(order).toEqual([8, 1, 2, 4, 6, 7]);
    expect(hand.controller.getState().stage).toBe('flop');
  });

  it('computes flop and turn decisions with the same dead-button positions', () => {
    const hand = deadButtonHand(PRODUCTION.seats, PRODUCTION.last);
    for (let i = 0; i < 6; i++) hand.act(hand.view().menu.toCall > 0 ? 'call' : 'check');
    expect(hand.controller.getState().stage).toBe('flop');
    const flopOrder: number[] = [];
    for (let i = 0; i < 6; i++) {
      const { actor, result } = hand.view();
      flopOrder.push(actor.seat);
      expect(result.receipt).toMatchObject({
        fired: true,
        position: EXPECTED[actor.seat][0],
        role: 'checked_to',
      });
      expect(result.receipt.inputs!.positions.heroOffset).toBe(EXPECTED[actor.seat][1]);
      expect(result.receipt.inputs!.census.dealerSeat).toBe(5);
      hand.act('check');
    }
    // Postflop the first dealt seat after the dead button acts first and
    // seat 4 acts last: the engine's order, not a guess.
    expect(flopOrder).toEqual([6, 7, 8, 1, 2, 4]);
    expect(hand.controller.getState().stage).toBe('turn');
    hand.act('bet', hand.view().menu.minRaiseTo!);
    for (const seat of [7, 8, 1, 2, 4]) {
      const { actor, result } = hand.view();
      expect(actor.seat).toBe(seat);
      expect(result.receipt).toMatchObject({
        fired: true,
        position: EXPECTED[seat][0],
        role: 'facing_bet',
        aggressorPosition: 'small_blind',
      });
      expect(result.receipt.inputs!.positions).toMatchObject({
        heroOffset: EXPECTED[seat][1],
        aggressor: 'small_blind',
        aggressorSeat: 6,
      });
      expect(ownership(result.receipt).outcome).toBe('computed');
      hand.act('call');
    }
  });

  it('computes a dead button on the highest physical seat, wrapping to seat 1', () => {
    // Seat 10 held the small blind and busted; seat 1 posted the big blind.
    const hand = deadButtonHand([1, 2, 3, 5, 7, 9], { smallBlind: 10, bigBlind: 1 });
    expect(hand.blinds).toEqual({ button: 10, smallBlindSeat: 1, smallBlind: 1, bigBlind: 2 });
    expect(posted(hand.controller)).toEqual({ 1: SB, 2: BB });
    const { actor, result } = hand.view();
    expect(actor.seat).toBe(3);
    expect(result.receipt).toMatchObject({ fired: true, position: 'early' });
    expect(result.receipt.inputs!.positions.heroOffset).toBe(3);
    expect(result.receipt.inputs!.census.dealerSeat).toBe(10);
  });

  it('refuses by name when the public census cannot establish a live small blind', () => {
    // The same dealer seat and the same dealt seats, two different hands.
    // A: seats 5 (small blind) and 6 (big blind) both busted last hand: the
    //    small blind is DEAD and seat 7 posts the big blind (engine rule 2).
    // B: seat 6 was already empty; seat 7 posted the big blind last hand and
    //    now posts a live small blind, seat 8 the big blind.
    const deadSmall = deadButtonHand([1, 2, 4, 7, 8], { smallBlind: 5, bigBlind: 6 });
    const liveSmall = deadButtonHand([1, 2, 4, 7, 8], { smallBlind: 5, bigBlind: 7 });
    expect(deadSmall.blinds).toEqual({
      button: 5,
      smallBlindSeat: 6,
      smallBlind: null,
      bigBlind: 7,
    });
    expect(liveSmall.blinds).toEqual({ button: 5, smallBlindSeat: 7, smallBlind: 7, bigBlind: 8 });
    expect(posted(deadSmall.controller)).toEqual({ 7: BB });
    expect(posted(liveSmall.controller)).toEqual({ 7: SB, 8: BB });
    for (const hand of [deadSmall, liveSmall]) {
      const { s, baseline, result } = hand.view();
      expect(s.dealerSeat).toBe(5);
      expect(s.dealtSeatIds).toEqual([1, 2, 4, 7, 8]);
      // Labeling seat 7 the small blind would be wrong in A; nothing in the
      // census tells A from B, so neither is computed.
      expect(result.receipt).toMatchObject({
        reason: 'dead_button_blinds_unproven',
        eligible: false,
        fired: false,
        inputs: null,
        position: null,
      });
      expect(result.decision).toBe(baseline);
      expect(ownership(result.receipt)).toMatchObject({
        outcome: 'unavailable',
        reason: 'dead_button_blinds_unproven',
      });
    }
  });

  it('keeps an empty dealer seat unavailable where the engine never deals one', () => {
    // Cash: tournamentDeadButtonSeats returns null off a tournament table and
    // the moving button only ever lands on a dealt seat.
    const cash = deadButtonHand(PRODUCTION.seats, PRODUCTION.last).view();
    const cashState = { ...cash.s, gameMode: 'cash', format: 'cash' } as HorseGameStateV2;
    delete cashState.tournament;
    expect(
      evaluatePlo4LivePolicy(cash.hero, cashState, cash.baseline, null, 'shadow', () => 0).receipt
        .reason
    ).toBe('canonical_state_unavailable');
    // Heads-up: the button is the small blind and HandController moves an
    // undealt button to a live seat, so an empty dealer is malformed.
    const hu = tournament(plo4ReferenceSpot('premium_open'));
    hu.state.dealerSeat = 3;
    expect(run(hu).receipt.reason).toBe('canonical_state_unavailable');
    // A dealer outside the physical seats is never a dead button.
    const production = deadButtonHand(PRODUCTION.seats, PRODUCTION.last).view();
    for (const dealerSeat of [0, 11, 5.5]) {
      expect(
        evaluatePlo4LivePolicy(
          production.hero,
          { ...production.s, dealerSeat },
          production.baseline,
          null,
          'shadow',
          () => 0
        ).receipt.reason
      ).toBe('canonical_state_unavailable');
    }
  });

  it('leaves every occupied-button position exactly as before', () => {
    // The pre-fix formula, written out independently.
    const before = (seat: number, dealer: number, seats: number[]) => {
      const sorted = [...seats].sort((a, b) => a - b);
      const offset =
        (sorted.indexOf(seat) - sorted.indexOf(dealer) + sorted.length) % sorted.length;
      if (offset === 0) return 'button';
      if (sorted.length === 2 || offset === 2) return 'big_blind';
      if (offset === 1) return 'small_blind';
      if (offset === sorted.length - 1) return 'cutoff';
      return offset === 3 ? 'early' : 'middle';
    };
    let checked = 0;
    for (let mask = 0; mask < 1 << 10; mask++) {
      const seats = Array.from({ length: 10 }, (_, i) => i + 1).filter(
        (s) => mask & (1 << (s - 1))
      );
      if (seats.length < 2 || seats.length > 8) continue;
      const state = {
        players: seats.map((seat) => ({ seat, user_id: `u${seat}`, cards: [] })),
        dealtSeatIds: seats,
      } as unknown as HorseGameStateV2;
      for (const dealer of seats)
        for (const seat of seats) {
          state.dealerSeat = dealer;
          expect(plo4Position(seat, state)).toBe(before(seat, dealer, seats));
          checked++;
        }
    }
    expect(checked).toBe(27_240);
  });

  it.each([
    ['a tampered hero offset', (b: any) => (b.positions.heroOffset = 4)],
    ['a dead dealer with no proven small blind', (b: any) => (b.census.dealerSeat = 9)],
    ['a dealer outside the physical seats', (b: any) => (b.census.dealerSeat = 11)],
  ])('rejects a dead-button binding with %s', (_label, mutate) => {
    const { result } = deadButtonHand(PRODUCTION.seats, PRODUCTION.last).view();
    const binding = structuredClone(result.receipt.inputs) as any;
    expect(live.plo4InputBindingIsValid(binding)).toBe(true);
    mutate(binding);
    expect(live.plo4InputBindingIsValid(binding)).toBe(false);
  });
});
