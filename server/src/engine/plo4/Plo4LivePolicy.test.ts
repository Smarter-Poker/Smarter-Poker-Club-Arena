import { describe, expect, it } from 'vitest';
import {
  evaluatePlo4LivePolicy,
  plo4EntryBars,
  plo4PreflopChoice,
  plo4Role,
} from './Plo4LivePolicy.js';
import { plo4CertificationCoordinates, plo4CoverageMatrix } from './Plo4PolicyPack.js';
import { plo4Cards, plo4ReferenceSpot } from '../../benchmark/Plo4PolicyEvidence.js';
import { HorseLogic } from '../HorseLogic.js';
import { calculatePots } from '../PokerEngine.js';
import { seedFastRandom } from '../HorseEval.js';
import { plo4PublicRanges } from '../../benchmark/Plo4PublicRanges.js';

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
      evaluatePlo4LivePolicy(input.hero, input.state, input.baseline, evidence).receipt.reason
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
