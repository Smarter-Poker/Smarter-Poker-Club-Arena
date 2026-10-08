import { describe, expect, it, vi } from 'vitest';
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
import { horseJournalJson } from '../../services/horseDecisionJournal/record.js';

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
    // Three-handed from the occupied button 1: the walk posts from seats 2 and 3.
    input.state.blindSeats = { smallBlind: 2, bigBlind: 3 };
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
  it('retains the reference facing a river bet, whatever the sampled equity (round 3)', () => {
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
    // Round 3: a bet faced is never re-priced against the unconditioned
    // range sample; the reference action is the decision.
    expect(result.receipt.fired).toBe(true);
    expect(result.receipt.equity).toMatchObject({ equity: 0 });
    expect(result.receipt.reason).toBe('reference_retained');
    expect(result.decision).toBe(input.baseline);
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
    expect(receipt.decision).toBe(input.baseline);
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
    input.state.blindSeats = { smallBlind: 2, bigBlind: 3 };
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
      // Round 3: the features are recorded; facing a bet the reference acts.
      expect(facing.receipt.reason).toBe('reference_retained');
      expect(facing.decision).toBe(input.baseline);
      input.state.currentBet = input.state.toCall = input.state.players[1].bet = 0;
      input.state.legalActions = ['check', 'bet'];
      input.state.minRaiseTo = 2;
      input.state.maxRaiseTo = 60;
      input.baseline = { action: 'check', thinkTime: 0 };
      // Checked to on the river heads-up on the button: the position stab.
      const checked = evaluatePlo4LivePolicy(
        input.hero,
        input.state,
        input.baseline,
        null,
        'candidate',
        () => 0
      );
      expect(checked.receipt.reason).toBe('heads_up_position_stab');
      expect(checked.decision).toMatchObject({ action: 'bet', amount: 60 });
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
    input.state.blindSeats = { smallBlind: 2, bigBlind: 3 };
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
    // Round 3: eight dealt seats are never a heads-up deviation.
    expect(result.receipt.reason).toBe('reference_retained');
    expect(result.decision).toBe(input.baseline);
  });
  it('round 3: deviates only heads-up, from a reference fold or check, and retains it elsewhere', () => {
    const input = plo4ReferenceSpot('royal_flush');
    input.state.currentBet = input.state.toCall = input.state.players[1].bet = 0;
    input.state.legalActions = ['check', 'bet'];
    input.state.minRaiseTo = 2;
    input.state.maxRaiseTo = 60;
    input.state.actionHistory = [];
    input.baseline = { action: 'check', thinkTime: 0 };
    // Heads-up, hero on the button, checked to on the river: a pot bet,
    // whatever the hand (the rule reads no hand strength).
    const strong = run(input, evidence);
    expect(strong.receipt.reason).toBe('heads_up_position_stab');
    expect(strong.decision).toMatchObject({ action: 'bet', amount: 60 });
    input.hero.cards = plo4Cards('2c 3c 4h 5h');
    const weak = run(input, { equity: 0.05, samples: 200, standardError: 0.01 });
    expect(weak.decision).toMatchObject({ action: 'bet', amount: 60 });
    // The reference already bets: retained, size included.
    const betting = { action: 'bet', amount: 20, thinkTime: 0 } as HorseDecision;
    const kept = evaluatePlo4LivePolicy(
      input.hero,
      input.state,
      betting,
      null,
      'candidate',
      () => 0
    );
    expect(kept.receipt.reason).toBe('reference_retained');
    expect(kept.decision).toBe(betting);
    // The flop is not a stab street.
    const flop = plo4ReferenceSpot('royal_flush');
    Object.assign(flop.state, {
      stage: 'flop',
      communityCards: plo4Cards('As Ks Ts'),
      currentBet: 0,
      toCall: 0,
      legalActions: ['check', 'bet'],
      minRaiseTo: 2,
      maxRaiseTo: 60,
      actionHistory: [],
    });
    flop.state.players[1].bet = 0;
    flop.baseline = { action: 'check', thinkTime: 0 };
    expect(run(flop).receipt.reason).toBe('reference_retained');
    // Three dealt seats: never a heads-up deviation.
    const three = plo4ReferenceSpot('royal_flush');
    Object.assign(three.state, {
      currentBet: 0,
      toCall: 0,
      legalActions: ['check', 'bet'],
      minRaiseTo: 2,
      maxRaiseTo: 60,
      actionHistory: [],
    });
    three.state.players[1].bet = 0;
    three.state.players.push({
      ...three.state.players[1],
      user_id: 'third',
      seat: 3,
      is_folded: true,
      totalInvested: 0,
    });
    three.state.blindSeats = { smallBlind: 2, bigBlind: 3 };
    three.baseline = { action: 'check', thinkTime: 0 };
    const multi = run(three);
    expect(multi.receipt.reason).toBe('reference_retained');
    expect(multi.decision).toBe(three.baseline);
    // Facing a raise: the reference's answer stands.
    const losing = plo4ReferenceSpot('non_nut_flush');
    losing.state.actionHistory!.push({
      ...losing.state.actionHistory![0],
      action: 'raise',
      timestamp: 2,
    });
    const facing = run(losing, { equity: 0, samples: 200, standardError: 0 });
    expect(facing.receipt.role).toBe('facing_raise');
    expect(facing.receipt.reason).toBe('reference_retained');
    expect(facing.decision).toBe(losing.baseline);
  });
  it('round 3: opens the heads-up button the reference folds, at the minimum raise', () => {
    const input = plo4ReferenceSpot('premium_open');
    input.hero.cards = plo4Cards('2c 7d 9h Ks');
    input.baseline = { action: 'fold', thinkTime: 0 };
    const open = run(input);
    expect(open.receipt.role).toBe('rfi');
    expect(open.receipt.position).toBe('button');
    expect(open.receipt.reason).toBe('heads_up_button_open');
    expect(open.decision).toMatchObject({ action: 'raise', amount: 4 });
    // A reference limp or raise is retained.
    const limp = { action: 'call', amount: 1, thinkTime: 0 } as HorseDecision;
    expect(
      evaluatePlo4LivePolicy(input.hero, input.state, limp, null, 'candidate', () => 0).decision
    ).toBe(limp);
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
/** Heads-up preflop: the opponent on the button raised to 6, hero in the big
 * blind with 2 in, pot 8, and the reference folds. */
function bigBlindDefenseSpot() {
  const input = plo4ReferenceSpot('premium_open');
  input.hero.cards = plo4Cards('2c 7d 9h Ks');
  setHero(input, { bet: 2, totalInvested: 2 });
  Object.assign(input.state.players[1], { bet: 6, totalInvested: 6 });
  Object.assign(input.state, {
    dealerSeat: 2,
    blindSeats: { smallBlind: 2, bigBlind: 1 },
    pot: 8,
    currentBet: 6,
    minRaise: 4,
    lastRaise: 4,
    toCall: 4,
    minRaiseTo: 10,
    maxRaiseTo: 18,
    legalActions: ['fold', 'call', 'raise'],
    actionHistory: [
      {
        userId: 'opponent',
        seat: 2,
        action: 'raise',
        amount: 6,
        stage: 'preflop',
        timestamp: 1,
        isFullRaise: true,
      },
    ],
  });
  input.baseline = { action: 'fold', thinkTime: 0 };
  return input;
}
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
  // The occupied button 1 walks its blinds to seats 2 and 3.
  input.state.blindSeats = { smallBlind: 2, bigBlind: 3 };
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
      blindSeats: { smallBlind: 2, bigBlind: 3 },
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

  it("records the exact pot-limit raise-to geometry, and retains the big blind's reference fold", () => {
    // Heads-up preflop, hero in the big blind facing a raise to 6 (pot 8):
    // call 4, then raise the pot of 8 + 4 = 12, so the pot-limit raise-to is
    // 6 + 12 = 18. Round 3 v2 never three-bets the big blind (it won only
    // against horses that over-fold), so the reference fold is the decision.
    const input = bigBlindDefenseSpot();
    setHero(input, { stack: 400 });
    input.state.players[1].stack = 400;
    input.state.maxRaiseTo = 400; // a looser engine bound must not lift the pot limit
    const loose = run(input);
    expect(loose.receipt.role).toBe('defense');
    expect(loose.receipt.reason).toBe('reference_retained');
    expect(loose.decision).toBe(input.baseline);
    expect(loose.receipt.inputs!.geometry).toMatchObject({
      potLimitRaiseTo: 18,
      stackRaiseTo: 402,
      wagerCap: 18,
      callCost: 4,
      chipUnit: 0.01,
    });
    // A tighter engine bound is the cap, inside the pot limit.
    input.state.maxRaiseTo = 16;
    expect(run(input).receipt.inputs!.geometry).toMatchObject({ stackRaiseTo: 402, wagerCap: 16 });
    // The heads-up button open is the controller's minimum raise, inside the cap.
    const open = plo4ReferenceSpot('premium_open');
    open.hero.cards = plo4Cards('2c 7d 9h Ks');
    open.baseline = { action: 'fold', thinkTime: 0 };
    const opened = run(open);
    expect(opened.receipt.reason).toBe('heads_up_button_open');
    expect(opened.decision).toMatchObject({ action: 'raise', amount: 4 });
    expect(opened.receipt.inputs!.geometry).toMatchObject({ potLimitRaiseTo: 6, wagerCap: 6 });
  });

  it.each([
    ['cash', 61.5],
    ['tournament', 61],
  ] as const)(
    'sizes the heads-up position stab (a pot bet) in %s units exactly',
    (mode, amount) => {
      // Checked to on the river with 61.5 in the pot. Cash keeps cents;
      // tournament chips floor to whole chips.
      const input = plo4ReferenceSpot('royal_flush');
      setHero(input, { stack: 400, totalInvested: 21.5 });
      Object.assign(input.state.players[1], { stack: 400, bet: 0 });
      Object.assign(input.state, {
        pot: 61.5,
        currentBet: 0,
        toCall: 0,
        legalActions: ['check', 'bet'],
        minRaiseTo: 2,
        maxRaiseTo: 61.5,
      });
      input.state.actionHistory = [];
      input.baseline = { action: 'check', thinkTime: 0 };
      if (mode === 'tournament') tournament(input);
      const result = run(input);
      expect(result.receipt.reason).toBe('heads_up_position_stab');
      expect(result.decision).toMatchObject({ action: 'bet', amount });
      expect(result.receipt.inputs!.geometry).toMatchObject({
        potLimitRaiseTo: 61.5,
        wagerCap: 61.5,
        chipUnit: mode === 'tournament' ? 1 : 0.01,
      });
    }
  );

  it('records the side-pot eligible price that the proposal consumed', () => {
    // Hero has 20 behind and 10 in; two opponents are in for 50 with 30 bet.
    // A 20 call reaches 30 in, so hero can win 30 x 3 = 90 (main pot); the
    // 40 above that is a side pot hero cannot win. 10% of the 130 in play is
    // 13, charged proportionally to the eligible 90: 90 - 9 = 81.
    const input = plo4ReferenceSpot('non_nut_flush');
    setHero(input, { stack: 20, totalInvested: 10 });
    Object.assign(input.state.players[1], { bet: 30, totalInvested: 50 });
    input.state.players.push({ ...input.state.players[1], user_id: 'third', seat: 3 });
    input.state.blindSeats = { smallBlind: 2, bigBlind: 3 };
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

  it('names an unavailable depth when every live opponent is away, and the decision stays journal-safe', () => {
    // Reachability 2026-10-08: the only unfolded opponent sat out mid-hand (not
    // all-in). No seat can cover, the depth is undefined and the pack refuses
    // it; the receipt used to carry -Infinity, which the private journal
    // cannot represent, so the whole decision record was lost.
    const input = plo4ReferenceSpot('premium_open');
    input.state.players[1].is_sitting_out = true;
    const { receipt } = run(input);
    expect(receipt.reason).toBe('depth_or_ante_outside_pack');
    expect(receipt.depthBB).toBeNull();
    expect(() => horseJournalJson(receipt)).not.toThrow();
    const decision = HorseLogic.decide(input.hero, input.state, 'balanced', {}, { mind: false });
    expect(decision.policyFallback).toBeUndefined();
    expect(decision.plo4Policy?.reason).toBe('depth_or_ante_outside_pack');
    expect(decision.plo4Policy?.depthBB).toBeNull();
    expect(() => horseJournalJson(decision)).not.toThrow();
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
        blindSeats: controller.getBlindSeatsSnapshot?.() ?? null,
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
    const act = (action: 'call' | 'check' | 'raise' | 'bet' | 'fold', amount?: number) => {
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

  it('computes a dead button and a dead small blind in the same hand from the posted blinds', () => {
    // The same dealer seat and the same dealt seats, two different hands,
    // both refused by #5992 as dead_button_blinds_unproven:
    // A: seats 5 (small blind) and 6 (big blind) both busted last hand: the
    //    small blind is DEAD and seat 7 posts the big blind (engine rule 2).
    // B: seat 6 was already empty; seat 7 posted the big blind last hand and
    //    now posts a live small blind, seat 8 the big blind.
    // The census cannot tell them apart; the posted blind seats can.
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
    // Expected positions from the engine's postings and action order: in A
    // seat 7 posts the only blind and seat 8 opens; in B seat 1 opens.
    const cases = [
      {
        hand: deadSmall,
        blindSeats: { smallBlind: null, bigBlind: 7 },
        preflop: [8, 1, 2, 4, 7],
        flop: [7, 8, 1, 2, 4],
        expected: {
          7: ['big_blind', 1],
          8: ['early', 2],
          1: ['middle', 3],
          2: ['cutoff', 4],
          4: ['button', 0],
        } as Record<number, [string, number]>,
      },
      {
        hand: liveSmall,
        blindSeats: { smallBlind: 7, bigBlind: 8 },
        preflop: [1, 2, 4, 7, 8],
        flop: [7, 8, 1, 2, 4],
        expected: {
          7: ['small_blind', 1],
          8: ['big_blind', 2],
          1: ['early', 3],
          2: ['cutoff', 4],
          4: ['button', 0],
        } as Record<number, [string, number]>,
      },
    ];
    for (const { hand, blindSeats, preflop, flop, expected } of cases) {
      const order: number[] = [];
      for (const street of ['preflop', 'flop'] as const) {
        for (let i = 0; i < 5; i++) {
          const { actor, s, menu, baseline, result } = hand.view();
          order.push(actor.seat);
          expect(s.dealerSeat).toBe(5);
          expect(s.dealtSeatIds).toEqual([1, 2, 4, 7, 8]);
          expect(s.stage).toBe(street);
          const [position, offset] = expected[actor.seat];
          expect(result.receipt).toMatchObject({ eligible: true, fired: true, position });
          expect(result.decision).toBe(baseline);
          expect(ownership(result.receipt)).toMatchObject({ outcome: 'computed' });
          const inputs = result.receipt.inputs!;
          expect(inputs.version).toBe('plo4-input-binding-v2');
          expect(inputs.census).toMatchObject({ dealerSeat: 5, blindSeats });
          expect(inputs.positions).toMatchObject({ hero: position, heroOffset: offset });
          const state = hand.controller.getState();
          expect(inputs.geometry.potLimitRaiseTo).toBe(state.currentBet + state.pot + menu.toCall);
          expect(live.plo4InputBindingIsValid(structuredClone(inputs))).toBe(true);
          hand.act(menu.toCall > 0 ? 'call' : 'check');
        }
      }
      expect(order).toEqual([...preflop, ...flop]);
    }
  });

  // P10.1 F3: last hand seat 3 held the small blind and seat 4 the big blind,
  // and seat 4 has busted. Rule 2: the small blind is DEAD. Rule 3: seat 3,
  // still seated, holds the button. Seat 5 posts the big blind.
  const DEAD_SB = { seats: [1, 2, 3, 5, 6], last: { smallBlind: 3, bigBlind: 4 } };
  // Derived from the engine's postings and action order below: seat 5 posts
  // the only blind, seat 6 opens, seat 2 acts last before the button, seat 3.
  // The dealer-offset formula labelled seat 5 the small blind and seat 6 the
  // big blind.
  const DEAD_SB_EXPECTED: Record<number, [string, number]> = {
    5: ['big_blind', 1],
    6: ['early', 2],
    1: ['middle', 3],
    2: ['cutoff', 4],
    3: ['button', 0],
  };

  it('labels an occupied button with a dead small blind from the posted blinds, preflop', () => {
    const hand = deadButtonHand(DEAD_SB.seats, DEAD_SB.last);
    // The engine's own rule and postings, independently of the policy.
    expect(hand.blinds).toEqual({ button: 3, smallBlindSeat: 4, smallBlind: null, bigBlind: 5 });
    expect(hand.controller.getState().dealerSeat).toBe(3);
    expect(posted(hand.controller)).toEqual({ 5: BB });
    const order: number[] = [];
    for (let i = 0; i < 5; i++) {
      const { actor, menu, s, baseline, result } = hand.view();
      order.push(actor.seat);
      const [position, offset] = DEAD_SB_EXPECTED[actor.seat];
      expect(result.receipt).toMatchObject({ eligible: true, fired: true, position });
      expect(result.receipt.aggressorPosition).toBe(i === 0 ? null : 'early');
      expect(result.decision).toBe(baseline);
      expect(ownership(result.receipt)).toMatchObject({ outcome: 'computed' });
      const inputs = result.receipt.inputs!;
      expect(live.plo4InputBindingIsValid(structuredClone(inputs))).toBe(true);
      expect(inputs.census).toMatchObject({
        source: 'dealt_seat_ids',
        dealerSeat: 3,
        heroSeat: actor.seat,
        dealtSeats: [1, 2, 3, 5, 6],
        blindSeats: { smallBlind: null, bigBlind: 5 },
        contestingOpponentSeats: [1, 2, 3, 5, 6].filter((seat) => seat !== actor.seat),
      });
      expect(inputs.positions).toMatchObject({
        hero: position,
        heroOffset: offset,
        aggressor: i === 0 ? null : 'early',
        aggressorSeat: i === 0 ? null : 6,
      });
      // The pot-limit raise-to is the engine's own maximum: no small blind is
      // in the pot, so the first raise is capped at 3 BB, not 3.5 BB.
      const state = hand.controller.getState();
      expect(inputs.geometry.potLimitRaiseTo).toBe(state.currentBet + state.pot + menu.toCall);
      expect(inputs.geometry.potLimitRaiseTo).toBe(menu.maxRaiseTo);
      if (i === 0) {
        expect(s.pot).toBe(BB);
        expect(inputs.geometry.potLimitRaiseTo).toBe(3 * BB);
        expect(result.receipt.role).toBe('rfi');
        hand.act('raise', menu.minRaiseTo!);
      } else hand.act('call');
    }
    expect(order).toEqual([6, 1, 2, 3, 5]);
    expect(hand.controller.getState().stage).toBe('flop');
    // The seats the hand posted from, recorded once when it posted them.
    expect(hand.controller.getBlindSeatsSnapshot()).toEqual({ smallBlind: null, bigBlind: 5 });
  });

  it('chooses the dead-small-blind preflop node from the posted blinds', () => {
    const hand = deadButtonHand(DEAD_SB.seats, DEAD_SB.last);
    // One second between actions, as at a table: the node counts callers by
    // action time, and a synchronous test would stamp every action alike.
    vi.useFakeTimers({ toFake: ['Date'] });
    let clock = Date.UTC(2026, 9, 3, 12);
    const act = (...args: Parameters<typeof hand.act>) => {
      vi.setSystemTime((clock += 1000));
      hand.act(...args);
    };
    try {
      act('call'); // seat 6 limps
      const raiser = hand.view();
      expect(raiser.actor.seat).toBe(1);
      expect(raiser.result.receipt).toMatchObject({ position: 'middle', role: 'isolation' });
      act('raise', raiser.menu.minRaiseTo!);
      for (const seat of [2, 3, 5]) {
        expect(hand.controller.getState().currentPlayerSeat).toBe(seat);
        act('fold');
      }
    } finally {
      vi.useRealTimers();
    }
    // Seat 6 faces one raise and no caller since. Only a blind defends; the
    // first seat after the big blind three-bets. The offset formula made
    // seat 6 the big blind and this node a defense.
    const { actor, result } = hand.view();
    expect(actor.seat).toBe(6);
    expect(result.receipt).toMatchObject({
      fired: true,
      position: 'early',
      aggressorPosition: 'middle',
      role: 'three_bet',
    });
    expect(result.receipt.inputs!.positions).toMatchObject({
      hero: 'early',
      role: 'three_bet',
      aggressor: 'middle',
      aggressorSeat: 1,
    });
  });

  it('labels the dead-small-blind hand postflop from the same posted blinds', () => {
    const hand = deadButtonHand(DEAD_SB.seats, DEAD_SB.last);
    for (let i = 0; i < 5; i++) hand.act(hand.view().menu.toCall > 0 ? 'call' : 'check');
    expect(hand.controller.getState().stage).toBe('flop');
    // The first dealt seat after the button acts first postflop: the big blind.
    const first = hand.view();
    expect(first.actor.seat).toBe(5);
    expect(first.result.receipt).toMatchObject({
      fired: true,
      position: 'big_blind',
      role: 'checked_to',
    });
    hand.act('bet', first.menu.minRaiseTo!);
    for (const seat of [6, 1, 2, 3]) {
      const { actor, menu, result } = hand.view();
      expect(actor.seat).toBe(seat);
      expect(result.receipt).toMatchObject({
        fired: true,
        position: DEAD_SB_EXPECTED[seat][0],
        role: 'facing_bet',
        aggressorPosition: 'big_blind',
      });
      const inputs = result.receipt.inputs!;
      expect(inputs.positions).toMatchObject({
        heroOffset: DEAD_SB_EXPECTED[seat][1],
        aggressor: 'big_blind',
        aggressorSeat: 5,
      });
      expect(inputs.census).toMatchObject({
        blindSeats: { smallBlind: null, bigBlind: 5 },
        contestingOpponentSeats: [1, 2, 3, 5, 6].filter((other) => other !== seat),
      });
      const state = hand.controller.getState();
      expect(inputs.geometry.potLimitRaiseTo).toBe(state.currentBet + state.pot + menu.toCall);
      expect(inputs.geometry.potLimitRaiseTo).toBe(menu.maxRaiseTo);
      expect(live.plo4InputBindingIsValid(structuredClone(inputs))).toBe(true);
      expect(ownership(result.receipt).outcome).toBe('computed');
      hand.act('call');
    }
  });

  it('computes a dead button on the top seat of a nine-seat table, wrapping to seat 1', () => {
    // A nine-seat table, the MTT default: seat 9 held the small blind and
    // busted; seat 1 posted the big blind and now posts the small blind.
    const hand = deadButtonHand([1, 2, 4, 6, 8], { smallBlind: 9, bigBlind: 1 });
    expect(hand.blinds).toEqual({ button: 9, smallBlindSeat: 1, smallBlind: 1, bigBlind: 2 });
    expect(posted(hand.controller)).toEqual({ 1: SB, 2: BB });
    const expected: Record<number, [string, number]> = {
      4: ['early', 3],
      6: ['cutoff', 4],
      8: ['button', 0],
      1: ['small_blind', 1],
      2: ['big_blind', 2],
    };
    const order: number[] = [];
    for (let i = 0; i < 5; i++) {
      const { actor, menu, result } = hand.view();
      order.push(actor.seat);
      expect(result.receipt).toMatchObject({ fired: true, position: expected[actor.seat][0] });
      const inputs = result.receipt.inputs!;
      expect(inputs.positions.heroOffset).toBe(expected[actor.seat][1]);
      expect(inputs.census).toMatchObject({
        dealerSeat: 9,
        blindSeats: { smallBlind: 1, bigBlind: 2 },
      });
      expect(live.plo4InputBindingIsValid(structuredClone(inputs))).toBe(true);
      hand.act(menu.toCall > 0 ? 'call' : 'check');
    }
    expect(order).toEqual([4, 6, 8, 1, 2]);
  });

  it('refuses by name a state that does not carry the posted blind seats', () => {
    const { hero, s, baseline } = deadButtonHand(DEAD_SB.seats, DEAD_SB.last).view();
    const missing = { ...s } as HorseGameStateV2;
    delete missing.blindSeats;
    for (const state of [missing, { ...s, blindSeats: null }]) {
      const { receipt, decision } = evaluatePlo4LivePolicy(
        hero,
        state,
        baseline,
        null,
        'shadow',
        () => 0
      );
      expect(receipt).toMatchObject({
        reason: 'blind_seats_unavailable',
        eligible: false,
        fired: false,
        inputs: null,
        position: null,
      });
      expect(decision).toBe(baseline);
      expect(ownership(receipt)).toMatchObject({
        outcome: 'unavailable',
        reason: 'blind_seats_unavailable',
      });
    }
    // Blind seats the engine could not have posted with this button and
    // census are a malformed canonical state, never relabelled.
    for (const blindSeats of [
      { smallBlind: 4, bigBlind: 5 }, // an undealt small blind seat
      { smallBlind: null, bigBlind: 6 }, // the first seat after the button skipped
      { smallBlind: 5, bigBlind: 5 },
      { smallBlind: 3, bigBlind: 5 }, // the button posting a three-handed small blind
    ]) {
      expect(
        evaluatePlo4LivePolicy(hero, { ...s, blindSeats }, baseline, null, 'shadow', () => 0)
          .receipt.reason
      ).toBe('canonical_state_unavailable');
    }
    // A dead small blind exists only at a tournament table.
    const cash = { ...s, gameMode: 'cash', format: 'cash' } as HorseGameStateV2;
    delete cash.tournament;
    expect(
      evaluatePlo4LivePolicy(hero, cash, baseline, null, 'shadow', () => 0).receipt.reason
    ).toBe('canonical_state_unavailable');
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

  // The pre-#5992 formula, written out independently.
  const before = (seat: number, dealer: number, seats: number[]) => {
    const sorted = [...seats].sort((a, b) => a - b);
    const offset = (sorted.indexOf(seat) - sorted.indexOf(dealer) + sorted.length) % sorted.length;
    if (offset === 0) return 'button';
    if (sorted.length === 2 || offset === 2) return 'big_blind';
    if (offset === 1) return 'small_blind';
    if (offset === sorted.length - 1) return 'cutoff';
    return offset === 3 ? 'early' : 'middle';
  };
  it('leaves every occupied-button position exactly as before', () => {
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

  it('labels every occupied-button, live-small-blind hand from its posted blinds exactly as before', () => {
    // Every set of two to eight of ten physical seats and every dealt button.
    // HandController posts from its own walk, as on every cash table and in
    // the league (neither passes config.blindSeats): the button is occupied
    // and the small blind live. The posted blinds then give exactly the
    // offset formula's labels, so nothing the league or a cash table records
    // or decides moves.
    let checked = 0;
    for (let mask = 0; mask < 1 << 10; mask++) {
      const seats = Array.from({ length: 10 }, (_, i) => i + 1).filter(
        (s) => mask & (1 << (s - 1))
      );
      if (seats.length < 2 || seats.length > 8) continue;
      for (const dealer of seats) {
        const controller = new HandController(
          {
            tableId: 'p10-1-occupied-button',
            handNumber: 1,
            gameVariant: 'plo4',
            smallBlind: 1,
            bigBlind: 2,
            ante: 0,
            rakeConfig: { percent: 5, cap: 3, noFlopNoDrop: true },
          },
          seats.map((seat) => ({
            seat,
            user_id: `u${seat}`,
            username: `U${seat}`,
            stack: 200,
            bet: 0,
            totalInvested: 0,
            cards: [],
            is_folded: false,
            is_all_in: false,
            is_sitting_out: false,
          })),
          dealer
        );
        controller.start();
        expect(controller.getState().dealerSeat).toBe(dealer);
        const blinds = controller.getBlindSeatsSnapshot()!;
        expect(blinds.smallBlind).not.toBeNull();
        expect(live.plo4BlindSeatsStatus(dealer, seats, blinds, false)).toBe('valid');
        for (const seat of seats) {
          expect(live.plo4CanonicalPosition(seat, dealer, seats, blinds)).toBe(
            before(seat, dealer, seats)
          );
          checked++;
        }
      }
    }
    expect(checked).toBe(27_240);
  });

  it.each([
    ['a tampered hero offset', (b: any) => (b.positions.heroOffset = 4)],
    ['a dead dealer its posted blinds do not follow', (b: any) => (b.census.dealerSeat = 9)],
    ['a dealer outside the physical seats', (b: any) => (b.census.dealerSeat = 11)],
  ])('rejects a dead-button binding with %s', (_label, mutate) => {
    const { result } = deadButtonHand(PRODUCTION.seats, PRODUCTION.last).view();
    const binding = structuredClone(result.receipt.inputs) as any;
    expect(live.plo4InputBindingIsValid(binding)).toBe(true);
    mutate(binding);
    expect(live.plo4InputBindingIsValid(binding)).toBe(false);
  });

  it.each([
    // Seat 1 (middle) facing seat 6's (early) raise: the offset formula's labels.
    ["the offset formula's hero label", (b: any) => (b.positions.hero = 'early')],
    ["the offset formula's aggressor label", (b: any) => (b.positions.aggressor = 'big_blind')],
    // Consistent with the button and census, but not the blinds the
    // positions were derived from: seat 1 would be early.
    [
      'a live small blind claimed for the dead one',
      (b: any) => (b.census.blindSeats = { smallBlind: 5, bigBlind: 6 }),
    ],
    [
      'blind seats skipping the seat after the button',
      (b: any) => (b.census.blindSeats = { smallBlind: null, bigBlind: 6 }),
    ],
    ['one seat posting both blinds', (b: any) => (b.census.blindSeats.smallBlind = 5)],
    ['an undealt blind seat', (b: any) => (b.census.blindSeats.smallBlind = 4)],
    ['no blind seats', (b: any) => delete b.census.blindSeats],
    ['null blind seats', (b: any) => (b.census.blindSeats = null)],
    ['an extra blind-seat field', (b: any) => (b.census.blindSeats.button = 3)],
    ['a dead small blind in cent chips', (b: any) => (b.geometry.chipUnit = 0.01)],
    ['a v1 label on a v2 census', (b: any) => (b.version = 'plo4-input-binding-v1')],
  ])('rejects a dead-small-blind binding with %s', (_label, mutate) => {
    const hand = deadButtonHand(DEAD_SB.seats, DEAD_SB.last);
    hand.act('raise', hand.view().menu.minRaiseTo!);
    const { actor, result } = hand.view();
    expect(actor.seat).toBe(1);
    const binding = structuredClone(result.receipt.inputs) as any;
    expect(binding.positions).toMatchObject({ hero: 'middle', aggressor: 'early' });
    expect(live.plo4InputBindingIsValid(binding)).toBe(true);
    mutate(binding);
    expect(live.plo4InputBindingIsValid(binding)).toBe(false);
    expect(
      live.plo4LiveReceiptBindingIsValid({ ...structuredClone(result.receipt), inputs: binding })
    ).toBe(false);
  });

  it('still reads a retained v1 binding with v1 checks only', () => {
    // Receipts retained before the blind seats were recorded: no census
    // field, positions inferred from the button. They stay readable.
    const { result } = deadButtonHand(PRODUCTION.seats, PRODUCTION.last).view();
    const v1 = structuredClone(result.receipt.inputs) as any;
    v1.version = 'plo4-input-binding-v1';
    delete v1.census.blindSeats;
    expect(live.plo4InputBindingIsValid(v1)).toBe(true);
    // ...with v1's own checks: the hero offset, and an empty dealer only in
    // whole tournament chips.
    expect(
      live.plo4InputBindingIsValid({ ...v1, positions: { ...v1.positions, heroOffset: 4 } })
    ).toBe(false);
    expect(
      live.plo4InputBindingIsValid({ ...v1, geometry: { ...v1.geometry, chipUnit: 0.01 } })
    ).toBe(false);
  });
});
