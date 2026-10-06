/**
 * HORSE BRAIN PHASE 13, P13.1: a joint multiway proposal records the inputs
 * it actually consumed (`joint-input-binding-v1`), modeled on the Phase 12
 * binding: the census, the controller's action order from the posted blinds,
 * the structure-specific wager geometry, depth, board counts (never cards),
 * the sampler's work and uniform escapes, the units and the objective. The
 * binding is lazy (assembled after the canonical checks), detached, frozen,
 * and refused at the worker boundary when it does not cohere.
 */
import { describe, expect, it } from 'vitest';
import type { HandConfig, SeatPlayer } from '../../types.js';
import { HandController } from '../HandController.js';
import { deadButtonPositions } from '../deadButton.js';
import { seedFastRandom } from '../HorseEval.js';
import { HorseLogic, type HorseDecideOpts } from '../HorseLogic.js';
import { controllerDecisionState } from '../remainingVariants/RemainingVariantControllerSpots.test-support.js';
import { jointPolicyFixture } from './JointRangeFixture.test-support.js';
import {
  evaluateJointLivePolicy,
  jointInputBindingIsValid,
  jointInputBindingSha256,
  jointReceiptBindingIsValid,
  JOINT_LIVE_DOMAIN,
  type JointPolicyReceipt,
} from './JointLivePolicy.js';
import { JOINT_ACTION_PACK } from './JointActionModel.js';
import { JOINT_RANGE_PACK } from './JointRangeSampler.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const opts: HorseDecideOpts = {
  telemetry: false,
  mind: false,
  decisionTimeMs: 0,
  phase10Plo4: 'off',
  phase11Omaha: 'off',
  phase12Remaining: 'off',
  phase13EvidenceMode: true,
};

function shadow(variant: Parameters<typeof jointPolicyFixture>[0] = 'nlh', boards = 2) {
  const s = jointPolicyFixture(variant, boards, 'cash', 'flop');
  const r = evaluateJointLivePolicy(
    s.hero,
    s.state,
    s.baseline,
    'shadow',
    () => 0,
    undefined,
    (d) => d
  );
  return { ...s, ...r };
}

describe('P13.1 the joint input binding', () => {
  it('pins the fixed identities', () => {
    expect(JOINT_LIVE_DOMAIN.version).toBe('joint-multiway-round1-v4');
    const { receipt } = shadow();
    expect(receipt.inputs).toMatchObject({
      version: 'joint-input-binding-v1',
      packs: {
        domain: 'joint-multiway-round1-v4',
        range: JOINT_RANGE_PACK.version,
        action: JOINT_ACTION_PACK.version,
      },
      approximation: { calibratedConfidence: null, solverInput: false },
      objective: { kind: 'cash_net_chips', asset: 'chips' },
    });
    expect(receipt.rangePackVersion).toBe(JOINT_RANGE_PACK.version);
    expect(receipt.actionPackVersion).toBe(JOINT_ACTION_PACK.version);
    expect(receipt.uniformEscapes).toBe(receipt.inputs!.ranges.provenance.uniformEscapes);
    expect(receipt.selectionRefusal).toBeNull();
  });

  it.each(['nlh', 'plo4', 'plo8', 'flh', 'flo8', 'pineapple', 'short_deck'] as const)(
    '%s: copies what the proposal consumed, frozen, detached, with no card value',
    (variant) => {
      const { receipt, state, hero } = shadow(variant, 2);
      const inputs = receipt.inputs!;
      expect(receipt.eligible).toBe(true);
      expect(jointInputBindingIsValid(clone(inputs))).toBe(true);
      expect(jointReceiptBindingIsValid(clone(receipt))).toBe(true);
      expect(Object.isFrozen(inputs)).toBe(true);
      expect(Object.isFrozen(inputs.census.dealtSeats)).toBe(true);
      expect(Object.isFrozen(inputs.ranges.provenance.opponents)).toBe(true);
      const text = JSON.stringify(inputs);
      expect(text).not.toMatch(/"rank"|"suit"/);
      expect(inputs.census).toMatchObject({
        dealerSeat: 4,
        heroSeat: 1,
        dealtSeats: [1, 2, 3, 4],
        dealtPlayers: 4,
        liveOpponents: 2,
        contestingOpponentSeats: [2, 3],
        foldedSeats: [4],
        awaySeats: [4],
        foldedCount: 1,
        awayCount: 1,
        boardCount: 2,
        bombPot: true,
      });
      expect(inputs.census.physicalCardsPerSample).toBeGreaterThan(0);
      expect(inputs.boards).toEqual({
        street: 'flop',
        count: 2,
        cardsPerBoard: 3,
        cardValues: 'not_recorded',
      });
      expect(inputs.positions).toMatchObject({
        blindSeats: null,
        actionOrder: [1, 2, 3, 4],
        firstToActSeat: 1,
        heroOffset: 1,
        playersBehindSeats: [2, 3],
      });
      expect(inputs.ranges).toMatchObject({ status: 'consumed', acquisition: 'fresh' });
      expect(inputs.ranges.provenance.completed).toBe(receipt.completedSamples);
      expect(inputs.ranges.provenance.opponents.map((r) => r.seat)).toEqual([2, 3, 4]);
      expect(inputs.geometry.settlementUnit).toBe(0.01);
      expect(inputs.geometry.legalChipStep).toBe(1);
      expect(inputs.geometry.legalForm).toBe('horse_legalizer');
      const structure = state.bettingStructure!;
      expect(inputs.geometry.bettingStructure).toBe(structure);
      expect(inputs.geometry.noLimit !== null).toBe(structure === 'no_limit');
      expect(inputs.geometry.potLimit !== null).toBe(structure === 'pot_limit');
      expect(inputs.geometry.fixedLimit !== null).toBe(structure === 'fixed_limit');
      // Detached: mutating the request afterwards cannot reach the receipt.
      const before = JSON.stringify(inputs);
      hero.stack = 1;
      state.players.forEach((p) => (p.stack = 7));
      state.rakeConfig!.percent = 9;
      state.dealtSeatIds!.push(9);
      state.actionHistory!.push({
        seat: 2,
        userId: 'p1',
        action: 'raise',
        amount: 40,
        timestamp: 1,
        stage: 'flop',
      });
      expect(JSON.stringify(inputs)).toBe(before);
    }
  );

  it('is a canonical commitment: equal for a JSON copy, different for any change', () => {
    const { receipt } = shadow();
    const inputs = receipt.inputs!;
    expect(jointInputBindingSha256(clone(inputs))).toBe(jointInputBindingSha256(inputs));
    const changed = clone(inputs) as { geometry: { pot: number } };
    changed.geometry.pot += 0.01;
    expect(jointInputBindingSha256(changed as never)).not.toBe(jointInputBindingSha256(inputs));
  });

  it('refuses a binding that does not cohere', () => {
    const { receipt } = shadow('plo4');
    const base = clone(receipt.inputs!);
    const forged: [string, (b: any) => void][] = [
      ['extra key', (b) => (b.extra = 1)],
      ['stale action pack', (b) => (b.packs.action = 'joint-action-response-round0')],
      ['stale domain', (b) => (b.packs.domain = 'joint-multiway-round1-v3')],
      ['solver claim', (b) => (b.approximation.solverInput = true)],
      ['calibration claim', (b) => (b.approximation.calibratedConfidence = 0.9)],
      ['card value', (b) => (b.boards.cardValues = [{ rank: 'A', suit: 'spades' }])],
      ['board count', (b) => (b.boards.count = 3)],
      ['cards per board', (b) => (b.boards.cardsPerBoard = 4)],
      ['order not a ring', (b) => (b.positions.actionOrder = [1, 3, 2, 4])],
      ['first seat', (b) => (b.positions.firstToActSeat = 2)],
      ['hero behind itself', (b) => b.positions.playersBehindSeats.push(1)],
      ['folded seat contesting', (b) => b.census.contestingOpponentSeats.push(4)],
      ['live count', (b) => (b.census.liveOpponents = 3)],
      ['settlement unit', (b) => (b.geometry.settlementUnit = 1)],
      ['legal chip step', (b) => (b.geometry.legalChipStep = 0.01)],
      ['wrong structure', (b) => (b.geometry.bettingStructure = 'no_limit')],
      [
        'cap block',
        (b) => ((b.geometry.noLimit = b.geometry.potLimit), (b.geometry.potLimit = null)),
      ],
      ['call cost', (b) => (b.geometry.callCost += 1)],
      ['depth', (b) => (b.depth.effectiveBB += 1)],
      ['depth ceiling', (b) => (b.depth.maxStackBB = 1000)],
      ['consumed without samples', (b) => (b.ranges.provenance.completed = 0)],
      ['impossible escapes', (b) => (b.ranges.provenance.uniformEscapes = 10_000)],
      ['range status', (b) => (b.ranges.status = 'calibrated')],
      ['opponent row', (b) => (b.ranges.provenance.opponents[0].seat = 1)],
      ['objective', (b) => (b.objective.kind = 'tournament_phase7_utility')],
      ['diamond Omaha', (b) => (b.objective.asset = 'diamonds')],
    ];
    expect(jointInputBindingIsValid(clone(base))).toBe(true);
    for (const [name, mutate] of forged) {
      const b = clone(base);
      mutate(b);
      expect(jointInputBindingIsValid(b), name).toBe(false);
    }
  });

  it('binds the receipt: eligibility, packs, escapes and a named refusal', () => {
    const { receipt } = shadow();
    const r = clone(receipt) as JointPolicyReceipt & Record<string, unknown>;
    expect(jointReceiptBindingIsValid(r)).toBe(true);
    const cases: [string, (x: any) => void][] = [
      ['ineligible with a binding', (x) => (x.eligible = false)],
      ['eligible without a binding', (x) => (x.inputs = null)],
      ['another variant', (x) => (x.variant = 'plo4')],
      ['another domain', (x) => (x.version = 'joint-multiway-round1-v3')],
      ['range pack', (x) => (x.rangePackVersion = 'joint-public-range-round0')],
      ['action pack', (x) => (x.actionPackVersion = 'joint-action-response-round0')],
      ['escapes', (x) => (x.uniformEscapes += 1)],
      ['samples', (x) => (x.completedSamples += 1)],
      ['unknown refusal', (x) => (x.selectionRefusal = 'tired')],
      [
        'applied and refused',
        (x) => ((x.applied = true), (x.selectionRefusal = 'illegal_candidate')),
      ],
    ];
    for (const [name, mutate] of cases) {
      const x = clone(r);
      mutate(x);
      expect(jointReceiptBindingIsValid(x), name).toBe(false);
    }
    // A receipt retained before P13.1 carries none of the fields and claims
    // no binding.
    const retained = clone(r) as Record<string, unknown>;
    for (const key of [
      'inputs',
      'rangePackVersion',
      'actionPackVersion',
      'uniformEscapes',
      'selectionRefusal',
    ])
      delete retained[key];
    expect(jointReceiptBindingIsValid(retained)).toBe(true);
  });

  it('records no binding for a refused proposal, and refuses an unreadable action order', () => {
    const heads = jointPolicyFixture('nlh', 1, 'cash', 'flop');
    heads.state.players[2].is_folded = true;
    const refused = evaluateJointLivePolicy(
      heads.hero,
      heads.state,
      heads.baseline,
      'shadow',
      () => 0
    );
    expect(refused.receipt).toMatchObject({
      eligible: false,
      reason: 'heads_up_owned_by_variant_policy',
      inputs: null,
    });
    expect(jointReceiptBindingIsValid(clone(refused.receipt))).toBe(true);
    // A tournament hand is always told its blinds; without them the
    // controller order cannot be read and nothing is bound.
    const t = jointPolicyFixture('nlh', 1, 'tournament', 'preflop');
    t.state.blindSeats = null;
    const r = evaluateJointLivePolicy(t.hero, t.state, t.baseline, 'shadow', () => 0);
    expect(r.receipt).toMatchObject({
      eligible: false,
      fired: false,
      reason: 'joint_action_blind_seats_unavailable',
      inputs: null,
    });
    expect(jointReceiptBindingIsValid(clone(r.receipt))).toBe(true);
  });

  it('records the Phase 7 population the tournament owner reused', () => {
    const s = jointPolicyFixture('nlh', 2, 'tournament', 'river');
    seedFastRandom(130999);
    const d = HorseLogic.decide(
      s.hero,
      s.state,
      'balanced',
      {},
      { ...opts, phase13Joint: 'shadow' }
    );
    expect(d.jointPolicy?.inputs?.ranges.acquisition).toBe('reused_phase7');
    expect(d.jointPolicy?.inputs?.objective.kind).toBe('tournament_phase7_utility');
    expect(d.jointPolicy?.inputs?.geometry.settlementUnit).toBe(1);
    expect(jointReceiptBindingIsValid(clone(d.jointPolicy))).toBe(true);
  });

  it('a dead small blind binds the engine order from the posted big blind', () => {
    // Seat 3 posted the big blind last hand and busted: the small blind is
    // dead and the button (seat 2) is occupied. The engine asks 5, 1, 2, 4.
    const blinds = deadButtonPositions([1, 2, 4, 5], { smallBlind: 2, bigBlind: 3 })!;
    const players: SeatPlayer[] = [1, 2, 4, 5].map((seat) => ({
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
      tableId: 'p13-1-binding',
      handNumber: 4,
      gameVariant: 'nlh',
      smallBlind: 10,
      bigBlind: 20,
      ante: 0,
      isTournament: true,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      blindSeats: { smallBlind: blinds.smallBlind, bigBlind: blinds.bigBlind },
    };
    const controller = new HandController(config, players, blinds.button);
    controller.start();
    const spot = controllerDecisionState(controller, 'nlh' as never, 'tournament', config)!;
    expect(spot.hero.seat).toBe(5);
    const r = evaluateJointLivePolicy(spot.hero, spot.state, spot.baseline, 'shadow', () => 0);
    expect(r.receipt.inputs?.positions).toMatchObject({
      blindSeats: { smallBlind: null, bigBlind: 4 },
      actionOrder: [5, 1, 2, 4],
      firstToActSeat: 5,
      playersBehindSeats: [1, 2, 4],
    });
    expect(r.receipt.actionModel?.playersBehind).toEqual(['p1', 'p2', 'p4']);
    expect(jointReceiptBindingIsValid(clone(r.receipt))).toBe(true);
  });
});

describe('P13.1 over P13-A: the response identity, limits and tree summary', () => {
  const river = () => {
    const s = jointPolicyFixture('nlh', 2, 'cash', 'river');
    return evaluateJointLivePolicy(
      s.hero,
      s.state,
      s.baseline,
      'shadow',
      () => 0,
      undefined,
      (d) => d
    ).receipt;
  };

  it('records the round-2 tree on the river and the one-response model on the flop', () => {
    const r = river();
    expect(r.fired).toBe(true);
    expect(r).toMatchObject({
      responseVersion: JOINT_ACTION_PACK.version,
      responseModel: 'bounded_raise_tree',
      responseLimits: {
        raiseStreets: ['turn', 'river'],
        raisesPerTree: 1,
        maxRaiseBranchOpponents: 1,
        maxTerminalBranchesPerCandidate: 32,
        riverRounds: 1,
      },
    });
    expect(Object.keys(r.responseTree!).sort()).toEqual(
      [
        'heroCallsRaiseProbability',
        'heroFoldsToRaiseProbability',
        'raiseBranches',
        'raiseLimitedResponders',
        'raiseProbability',
        'riverBetProbability',
        'riverRoundProbability',
        'terminalBranches',
      ].sort()
    );
    expect(r.responseTree!.riverRoundProbability).toBeNull();
    expect(r.inputs!.response.model).toBe('bounded_raise_tree');
    expect(jointReceiptBindingIsValid(clone(r))).toBe(true);
    const flop = shadow('nlh').receipt;
    expect(flop).toMatchObject({ responseModel: 'one_response_then_showdown', responseTree: null });
    expect(flop.inputs!.response.model).toBe('one_response_then_showdown');
    expect(jointReceiptBindingIsValid(clone(flop))).toBe(true);
  });

  it('refuses response fields that disagree with the pack or the model', () => {
    const r = clone(river()) as any;
    const cases: [string, (x: any) => void][] = [
      ['limits', (x) => (x.responseLimits.maxTerminalBranchesPerCandidate = 64)],
      ['version', (x) => (x.responseVersion = 'joint-action-response-round1-v2')],
      ['model', (x) => (x.responseModel = 'one_response_then_showdown')],
      ['tree missing', (x) => (x.responseTree = null)],
      ['tree branches', (x) => (x.responseTree.terminalBranches = 33)],
      ['tree mass', (x) => (x.responseTree.heroCallsRaiseProbability = 2)],
      ['binding model', (x) => (x.inputs.response.model = 'one_response_then_showdown')],
      ['binding limits', (x) => (x.inputs.response.riverRounds = 2)],
    ];
    for (const [name, mutate] of cases) {
      const x = clone(r);
      mutate(x);
      expect(jointReceiptBindingIsValid(x), name).toBe(false);
    }
  });

  it.each([
    'joint_response_branch_unavailable',
    'joint_response_street_unavailable',
    'joint_response_street_not_modeled',
    'joint_response_illegal_simulated_action',
    'joint_response_branch_mass',
  ])('admits the named refusal %s with its binding and no response model', (reason) => {
    const r = clone(river()) as any;
    Object.assign(r, {
      fired: false,
      changed: false,
      reason,
      confidence: 'unavailable',
      actionModel: null,
      responseVersion: null,
      responseModel: null,
      responseTree: null,
    });
    expect(jointReceiptBindingIsValid(r)).toBe(true);
  });
});
