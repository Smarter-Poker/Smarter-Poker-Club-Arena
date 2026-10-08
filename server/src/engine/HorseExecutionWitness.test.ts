import { beforeEach, describe, expect, it } from 'vitest';
import type { ActionType, HorseDecision } from '../types.js';
import type { LiveHorseDecisionSnapshot } from './horseDecision/protocol.js';
import { HorsePolicyGraph, HORSE_POLICY_ORDER } from './HorsePolicyGraph.js';
import {
  createHorseExecutionWitness,
  retireHorseExecutionWitness,
  settleHorseExecutionWitness,
  type HorseAcceptedAction,
} from './HorseExecutionWitness.js';
import { drainFires, enableBrainTelemetry } from './BrainTelemetry.js';
import { horsePolicyOwnership } from './HorsePolicyRegistry.js';
import { HorseLogic } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { encodeHorseDecisionReads } from './HorseDecisionReadFrame.js';
import { saveFastRandom, restoreFastRandom, seedFastRandom } from './HorseEval.js';
import { jointPolicyFixture } from './multiway/JointRangeFixture.test-support.js';
import { jointInputBindingSha256 } from './multiway/JointLivePolicy.js';
import { omahaVariantSpot, variantCards } from '../benchmark/OmahaVariantPolicyEvidence.js';
import { remainingVariantSpot } from '../benchmark/RemainingVariantPolicyEvidence.js';
import { createHash } from 'node:crypto';
import { horseJournalJson } from '../services/horseDecisionJournal/record.js';

const input = {
  decisionKey: `phase5-v1:${'1'.repeat(64)}`,
  generation: 1,
  requestId: 1,
  fence: 'turn',
  decisionTimeMs: 1000,
  player: { seat: 1 },
  gameState: { gameVariant: 'plo4', gameMode: 'cash', stage: 'flop', boardCount: 2 },
} as unknown as LiveHorseDecisionSnapshot;
const make = (
  decision: HorseDecision = { action: 'bet', amount: 20, thinkTime: 1 },
  lane: 'fast' | 'worker_fallback' = 'fast'
) =>
  createHorseExecutionWitness(input, decision, {
    requestId: 1,
    lane,
    computeMs: 2,
    governorScale: 1,
  });

const accepted = (
  action: ActionType,
  amount: number | null,
  intended = true
): HorseAcceptedAction[] => [
  { record: { seat: 1, action, amount: amount ?? 0, stage: 'flop' as const }, intended },
];

beforeEach(() => {
  enableBrainTelemetry();
  drainFires();
});

describe('private execution witness', () => {
  it('owns a compact immutable commitment to the Phase 13 input binding (P13.1)', () => {
    const { hero, state } = jointPolicyFixture('plo6', 2, 'cash', 'turn');
    seedFastRandom(7301301);
    const decision = HorseLogic.decide(
      hero,
      state,
      'balanced',
      {},
      {
        telemetry: false,
        mind: false,
        decisionTimeMs: 0,
        phase11Omaha: 'off',
        phase13Joint: 'shadow',
        phase13EvidenceMode: true,
      }
    );
    const inputs = decision.jointPolicy!.inputs!;
    const witness = createHorseExecutionWitness(
      { ...input, player: hero, gameState: state },
      decision,
      { requestId: 1, lane: 'fast', computeMs: 1, governorScale: 1 }
    );
    const expected = {
      version: 'horse-phase13-input-binding-v1',
      variant: 'plo6',
      inputSha256: jointInputBindingSha256(inputs),
      rangeStatus: 'consumed',
    };
    expect(witness.phase13Inputs).toEqual(expected);
    expect(Object.isFrozen(witness.phase13Inputs)).toBe(true);
    // The witness carries the commitment, never the binding or a card.
    expect(JSON.stringify(witness)).not.toMatch(/"rank"|"suit"|actionOrder/);
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: [
        {
          record: { seat: hero.seat, action: decision.action, amount: 0, stage: 'turn' },
          intended: true,
        },
      ],
    });
    expect(witness.phase13Inputs).toEqual(expected);
    // A refused proposal commits to null; a retained receipt to nothing.
    const refused = make({
      action: 'check',
      thinkTime: 1,
      jointPolicy: { ...decision.jointPolicy!, eligible: false, inputs: null },
    });
    expect(refused.phase13Inputs).toBeNull();
    const { inputs: _drop, ...retainedReceipt } = decision.jointPolicy!;
    const retained = make({ action: 'check', thinkTime: 1, jointPolicy: retainedReceipt });
    expect(retained).not.toHaveProperty('phase13Inputs');
    expect(make()).not.toHaveProperty('phase13Inputs');
  });

  it('owns a compact immutable commitment to actual utility evidence and its original read frame', () => {
    const { hero, state } = jointPolicyFixture('nlh', 1, 'tournament', 'preflop');
    state.legalActions = ['check'];
    state.minRaiseTo = null;
    state.maxRaiseTo = null;
    const rng = saveFastRandom();
    let decision: HorseDecision;
    try {
      seedFastRandom(7300930);
      decision = HorseLogic.decide(
        hero,
        state,
        'balanced',
        {},
        {
          telemetry: false,
          mind: false,
          decisionTimeMs: 1000,
          v27GtoCharts: false,
          phase8Postflop: 'off',
          phase13Joint: 'off',
        }
      );
    } finally {
      restoreFastRandom(rng);
    }
    const utility = decision.tournamentUtility;
    if (!utility?.evidence) throw Error('Phase 7 fixture did not evaluate utility');
    const frame = encodeHorseDecisionReads(
      HorseMind.createSandbox(),
      state.players,
      HorseMind.handKeyOf(state.actionHistory)
    );
    utility.readFrameSha256 = frame.sha256;
    const witness = createHorseExecutionWitness(
      { ...input, player: hero, gameState: state },
      decision,
      {
        requestId: 1,
        lane: 'fast',
        computeMs: 1,
        governorScale: 1,
      }
    );
    const expected = {
      version: 'horse-phase7-accepted-evidence-v1',
      inputSha256: utility.evidence.inputSha256,
      evidenceSha256: createHash('sha256').update(horseJournalJson(utility.evidence)).digest('hex'),
      readFrameSha256: frame.sha256,
      selectedAction: utility.selectedAction,
      selectedAmount: utility.selectedAmount,
    };
    expect(witness.phase7Evidence).toEqual(expected);
    expect(Object.isFrozen(witness.phase7Evidence)).toBe(true);
    utility.evidence = { ...utility.evidence, inputSha256: 'f'.repeat(64) };
    utility.readFrameSha256 = 'e'.repeat(64);
    utility.selectedAction = 'fold';
    expect(witness.phase7Evidence).toEqual(expected);
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: [
        {
          record: { seat: hero.seat, action: 'check', amount: 0, stage: 'preflop' },
          intended: true,
        },
      ],
    });
    expect(witness.executionStatus).toBe('intended');
    expect(witness.phase7Evidence).toEqual(expected);
  });

  it('owns a compact immutable commitment to the Phase 10 input binding and its read frame', () => {
    const { hero, state } = jointPolicyFixture('plo4', 1, 'cash', 'preflop');
    // The fixture's button is seat 4: the walk posts the blinds from seats 1 and 2.
    state.blindSeats = { smallBlind: 1, bigBlind: 2 };
    const rng = saveFastRandom();
    let decision: HorseDecision;
    try {
      seedFastRandom(7300930);
      decision = HorseLogic.decide(
        hero,
        state,
        'balanced',
        {},
        {
          telemetry: false,
          mind: false,
          decisionTimeMs: 1000,
          phase10EvidenceMode: true,
          phase8Postflop: 'off',
          phase13Joint: 'off',
        }
      );
    } finally {
      restoreFastRandom(rng);
    }
    const receipt = decision.plo4Policy!;
    expect(receipt.inputs).not.toBeNull();
    receipt.readFrameSha256 = 'a'.repeat(64);
    const witness = createHorseExecutionWitness(
      { ...input, player: hero, gameState: state },
      decision,
      { requestId: 1, lane: 'fast', computeMs: 1, governorScale: 1 }
    );
    const expected = {
      version: 'horse-phase10-input-binding-v1',
      inputSha256: createHash('sha256').update(horseJournalJson(receipt.inputs)).digest('hex'),
      readFrameSha256: 'a'.repeat(64),
      rangeStatus: 'not_consumed_preflop',
    };
    expect(witness.phase10Inputs).toEqual(expected);
    expect(Object.isFrozen(witness.phase10Inputs)).toBe(true);
    receipt.readFrameSha256 = 'b'.repeat(64);
    decision.plo4Policy = { ...receipt, inputs: null, eligible: false };
    expect(witness.phase10Inputs).toEqual(expected);
    // A refused proposal binds nothing, and a legacy receipt is not upgraded.
    expect(make({ ...decision }).phase10Inputs).toBeNull();
    expect(make({ action: 'check', thinkTime: 1 }).phase10Inputs).toBeNull();
  });

  it.each(['short_deck', 'pineapple', 'flh', 'flo8'] as const)(
    'owns a compact immutable commitment to the %s Phase 12 input binding (P12.1)',
    (variant) => {
      const spot = remainingVariantSpot(variant, 'river', 3);
      const rng = saveFastRandom();
      let decision: HorseDecision;
      try {
        seedFastRandom(7301205);
        decision = HorseLogic.decide(
          spot.hero,
          spot.state,
          'balanced',
          {},
          { telemetry: false, mind: false, decisionTimeMs: 1000, phase12EvidenceMode: true }
        );
      } finally {
        restoreFastRandom(rng);
      }
      const receipt = decision.remainingVariantPolicy!;
      expect(receipt.inputs).not.toBeNull();
      const snapshot = { ...input, player: spot.hero, gameState: spot.state };
      const witness = createHorseExecutionWitness(snapshot, decision, {
        requestId: 1,
        lane: 'fast',
        computeMs: 1,
        governorScale: 1,
      });
      const expected = {
        version: 'horse-phase12-input-binding-v1',
        variant,
        inputSha256: createHash('sha256').update(horseJournalJson(receipt.inputs)).digest('hex'),
        rangeStatus: receipt.inputs!.range.status,
      };
      expect(witness.phase12Inputs).toEqual(expected);
      expect(Object.isFrozen(witness.phase12Inputs)).toBe(true);
      // The witness commits to a value, not to the receipt object.
      decision.remainingVariantPolicy = { ...receipt, inputs: null, eligible: false };
      expect(witness.phase12Inputs).toEqual(expected);
      // A refused proposal binds null; a retained receipt without the field,
      // and every other variant, carry no Phase 12 commitment at all.
      expect(
        createHorseExecutionWitness(snapshot, decision, {
          requestId: 1,
          lane: 'fast',
          computeMs: 1,
          governorScale: 1,
        }).phase12Inputs
      ).toBeNull();
      const legacy = { ...receipt };
      delete legacy.inputs;
      expect(make({ ...decision, remainingVariantPolicy: legacy })).not.toHaveProperty(
        'phase12Inputs'
      );
      expect(make({ action: 'check', thinkTime: 1 })).not.toHaveProperty('phase12Inputs');
      expect(witness).not.toHaveProperty('phase11Inputs');
    }
  );

  it('owns a compact immutable commitment to the Phase 11 input binding (P11.1)', () => {
    const spot = omahaVariantSpot('plo8', 'river', 3);
    const rng = saveFastRandom();
    let decision: HorseDecision;
    try {
      seedFastRandom(7301004);
      decision = HorseLogic.decide(
        spot.hero,
        spot.state,
        'balanced',
        {},
        { telemetry: false, mind: false, decisionTimeMs: 1000, phase11EvidenceMode: true }
      );
    } finally {
      restoreFastRandom(rng);
    }
    const receipt = decision.omahaVariantPolicy!;
    expect(receipt.inputs).not.toBeNull();
    const snapshot = { ...input, player: spot.hero, gameState: spot.state };
    const witness = createHorseExecutionWitness(snapshot, decision, {
      requestId: 1,
      lane: 'fast',
      computeMs: 1,
      governorScale: 1,
    });
    const expected = {
      version: 'horse-phase11-input-binding-v1',
      variant: 'plo8',
      inputSha256: createHash('sha256').update(horseJournalJson(receipt.inputs)).digest('hex'),
      rangeStatus: receipt.inputs!.range.status,
    };
    expect(witness.phase11Inputs).toEqual(expected);
    expect(Object.isFrozen(witness.phase11Inputs)).toBe(true);
    decision.omahaVariantPolicy = { ...receipt, inputs: null, eligible: false };
    expect(witness.phase11Inputs).toEqual(expected);
    // A refused proposal binds null; a retained receipt without the field,
    // and every other variant, carry no Phase 11 commitment at all.
    expect(
      createHorseExecutionWitness(snapshot, decision, {
        requestId: 1,
        lane: 'fast',
        computeMs: 1,
        governorScale: 1,
      }).phase11Inputs
    ).toBeNull();
    const legacy = { ...receipt };
    delete legacy.inputs;
    expect(make({ ...decision, omahaVariantPolicy: legacy })).not.toHaveProperty('phase11Inputs');
    expect(make({ action: 'check', thinkTime: 1 })).not.toHaveProperty('phase11Inputs');
  });

  it('P10.3 binds the PLO4 selection: selected proposal, shadow baseline and the accepted action', () => {
    const { hero, state } = jointPolicyFixture('plo4', 1, 'cash', 'preflop');
    const rng = saveFastRandom();
    let decision: HorseDecision;
    try {
      seedFastRandom(7300930);
      decision = HorseLogic.decide(
        hero,
        state,
        'balanced',
        {},
        {
          telemetry: false,
          mind: false,
          decisionTimeMs: 1000,
          phase10EvidenceMode: true,
          phase8Postflop: 'off',
          phase13Joint: 'off',
        }
      );
    } finally {
      restoreFastRandom(rng);
    }
    const receipt = decision.plo4Policy!;
    expect(receipt.mode).toBe('shadow');
    expect(receipt.selection).toBe(receipt.changed ? 'shadow_change' : 'none');
    const witness = createHorseExecutionWitness(
      { ...input, player: hero, gameState: state },
      decision,
      { requestId: 1, lane: 'fast', computeMs: 1, governorScale: 1 }
    );
    const expected = {
      continuationVersion: 'plo4-policy-round3-v2',
      mode: 'shadow',
      selection: receipt.selection,
      authority: null,
      verdict: null,
      candidate: { action: receipt.proposalAction, amount: receipt.proposalAmount },
      reference: { action: receipt.baselineAction, amount: receipt.baselineAmount },
    };
    expect(witness.phase10Authority).toEqual(expected);
    expect(Object.isFrozen(witness.phase10Authority!.candidate)).toBe(true);
    expect(Object.isFrozen(witness.phase10Authority!.reference)).toBe(true);
    // Later changes to the returned receipt never reach the witness.
    receipt.proposalAction = 'all_in';
    receipt.baselineAction = 'fold';
    expect(witness.phase10Authority).toEqual(expected);
    // The accepted action is the witness's own controller record.
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: [
        {
          record: {
            seat: hero.seat,
            action: decision.action,
            amount: decision.amount ?? 0,
            stage: 'preflop',
          },
          intended: true,
        },
      ],
    });
    expect(witness.acceptedActions[0].record.action).toBe(decision.action);
    expect(witness.phase10Authority!.selection).toBe(expected.selection);
    // A receipt retained before P10.3 (no selection) claims no binding.
    const legacy = { ...receipt } as Partial<typeof receipt>;
    delete legacy.selection;
    expect(
      make({ ...decision, plo4Policy: legacy as typeof receipt }).phase10Authority
    ).toBeUndefined();
    expect(make({ action: 'check', thinkTime: 1 }).phase10Authority).toBeUndefined();
  });

  it.each(['plo5', 'plo6', 'plo8'] as const)(
    'P11.3 binds the %s selection: selected proposal, shadow baseline and the accepted action',
    (variant) => {
      const spot = omahaVariantSpot(variant, 'preflop', 2);
      // Round 3: a heads-up button hand the reference folds, which the pack
      // opens (a real shadow change).
      spot.hero.cards = variantCards(
        { plo5: '2c 7d 3h 8s Jc', plo6: '2c 2d 7h 7s Kc 4d', plo8: 'Kc 7d 9h 9s' }[variant]
      );
      const rng = saveFastRandom();
      let decision: HorseDecision;
      try {
        seedFastRandom(7301004);
        decision = HorseLogic.decide(
          spot.hero,
          spot.state,
          'balanced',
          {},
          { telemetry: false, mind: false, decisionTimeMs: 1000, phase11EvidenceMode: true }
        );
      } finally {
        restoreFastRandom(rng);
      }
      const receipt = decision.omahaVariantPolicy!;
      expect(receipt).toMatchObject({ mode: 'shadow', changed: true, selection: 'shadow_change' });
      const snapshot = { ...input, player: spot.hero, gameState: spot.state };
      const witness = createHorseExecutionWitness(snapshot, decision, {
        requestId: 1,
        lane: 'fast',
        computeMs: 1,
        governorScale: 1,
      });
      const expected = {
        continuationVersion: receipt.version,
        mode: 'shadow',
        selection: 'shadow_change',
        authority: null,
        verdict: null,
        candidate: { action: receipt.proposalAction, amount: receipt.proposalAmount },
        reference: { action: receipt.baselineAction, amount: receipt.baselineAmount },
      };
      expect(witness.phase11Authority).toEqual(expected);
      expect(witness).not.toHaveProperty('phase10Authority');
      expect(Object.isFrozen(witness.phase11Authority!.candidate)).toBe(true);
      expect(Object.isFrozen(witness.phase11Authority!.reference)).toBe(true);
      // Later changes to the returned receipt never reach the witness.
      receipt.proposalAction = 'all_in';
      receipt.baselineAction = 'fold';
      expect(witness.phase11Authority).toEqual(expected);
      settleHorseExecutionWitness(witness, {
        applied: true,
        acceptedActions: [
          {
            record: {
              seat: spot.hero.seat,
              action: decision.action,
              amount: decision.amount ?? 0,
              stage: 'preflop',
            },
            intended: true,
          },
        ],
      });
      expect(witness.acceptedActions[0].record.action).toBe(decision.action);
      expect(witness.phase11Authority!.selection).toBe('shadow_change');
      // A receipt retained before P11.3 (no selection), and every other
      // variant, claim no Phase 11 binding: no existing witness changes shape.
      const legacy = { ...receipt } as Partial<typeof receipt>;
      delete legacy.selection;
      expect(
        make({ ...decision, omahaVariantPolicy: legacy as typeof receipt })
      ).not.toHaveProperty('phase11Authority');
      expect(make({ action: 'check', thinkTime: 1 })).not.toHaveProperty('phase11Authority');
    }
  );

  it.each([
    ['short_deck', 'preflop'],
    ['pineapple', 'preflop'],
    ['flh', 'turn'],
    ['flo8', 'flop'],
  ] as const)(
    'P12.3 binds the %s %s selection: selected proposal, shadow baseline and the accepted action',
    (variant, street) => {
      const spot = remainingVariantSpot(variant, street, 2);
      const rng = saveFastRandom();
      let decision: HorseDecision;
      try {
        seedFastRandom(100101);
        decision = HorseLogic.decide(
          spot.hero,
          spot.state,
          'balanced',
          {},
          { telemetry: false, mind: false, decisionTimeMs: 0, phase12EvidenceMode: true }
        );
      } finally {
        restoreFastRandom(rng);
      }
      const receipt = decision.remainingVariantPolicy!;
      expect(receipt).toMatchObject({ mode: 'shadow', changed: true, selection: 'shadow_change' });
      const snapshot = { ...input, player: spot.hero, gameState: spot.state };
      const witness = createHorseExecutionWitness(snapshot, decision, {
        requestId: 1,
        lane: 'fast',
        computeMs: 1,
        governorScale: 1,
      });
      const expected = {
        continuationVersion: receipt.version,
        mode: 'shadow',
        selection: 'shadow_change',
        authority: null,
        verdict: null,
        candidate: { action: receipt.proposalAction, amount: receipt.proposalAmount },
        reference: { action: receipt.baselineAction, amount: receipt.baselineAmount },
      };
      expect(witness.phase12Authority).toEqual(expected);
      expect(witness).not.toHaveProperty('phase10Authority');
      expect(witness).not.toHaveProperty('phase11Authority');
      expect(Object.isFrozen(witness.phase12Authority!.candidate)).toBe(true);
      expect(Object.isFrozen(witness.phase12Authority!.reference)).toBe(true);
      // Later changes to the returned receipt never reach the witness.
      receipt.proposalAction = 'all_in';
      receipt.baselineAction = 'fold';
      expect(witness.phase12Authority).toEqual(expected);
      settleHorseExecutionWitness(witness, {
        applied: true,
        acceptedActions: [
          {
            record: {
              seat: spot.hero.seat,
              action: decision.action,
              amount: decision.amount ?? 0,
              stage: street,
            },
            intended: true,
          },
        ],
      });
      expect(witness.acceptedActions[0].record.action).toBe(decision.action);
      expect(witness.phase12Authority!.selection).toBe('shadow_change');
      // A receipt retained before P12.3 (no selection), and every other
      // variant, claim no Phase 12 binding: no existing witness changes shape.
      const legacy = { ...receipt } as Partial<typeof receipt>;
      delete legacy.selection;
      expect(
        make({ ...decision, remainingVariantPolicy: legacy as typeof receipt })
      ).not.toHaveProperty('phase12Authority');
      expect(make({ action: 'check', thinkTime: 1 })).not.toHaveProperty('phase12Authority');
    }
  );

  it.each([
    ['nlh', 2, 'flop'],
    ['plo4', 1, 'turn'],
    ['flo8', 1, 'river'],
    ['short_deck', 2, 'flop'],
  ] as const)(
    'P13.3 binds the %s joint selection (%i boards, %s): proposal, shadow baseline and the accepted action',
    (variant, boards, street) => {
      const spot = jointPolicyFixture(variant, boards, 'cash', street);
      const rng = saveFastRandom();
      let decision: HorseDecision;
      try {
        seedFastRandom(10_301_204);
        decision = HorseLogic.decide(
          spot.hero,
          spot.state,
          'balanced',
          {},
          { telemetry: false, mind: false, decisionTimeMs: 0, phase13EvidenceMode: true }
        );
      } finally {
        restoreFastRandom(rng);
      }
      const receipt = decision.jointPolicy!;
      expect(receipt).toMatchObject({ mode: 'shadow', changed: true, selection: 'shadow_change' });
      const snapshot = { ...input, player: spot.hero, gameState: spot.state };
      const witness = createHorseExecutionWitness(snapshot, decision, {
        requestId: 1,
        lane: 'fast',
        computeMs: 1,
        governorScale: 1,
      });
      const expected = {
        continuationVersion: receipt.version,
        mode: 'shadow',
        selection: 'shadow_change',
        authority: null,
        verdict: null,
        candidate: { action: receipt.proposalAction, amount: receipt.proposalAmount },
        reference: { action: receipt.baselineAction, amount: receipt.baselineAmount },
      };
      expect(witness.phase13Authority).toEqual(expected);
      for (const key of ['phase10Authority', 'phase11Authority', 'phase12Authority'])
        if (Object.hasOwn(witness, key))
          expect((witness as unknown as Record<string, { mode: string }>)[key].mode).toBe('shadow');
      expect(Object.isFrozen(witness.phase13Authority!.candidate)).toBe(true);
      expect(Object.isFrozen(witness.phase13Authority!.reference)).toBe(true);
      receipt.proposalAction = 'all_in';
      receipt.baselineAction = 'fold';
      expect(witness.phase13Authority).toEqual(expected);
      settleHorseExecutionWitness(witness, {
        applied: true,
        acceptedActions: [
          {
            record: {
              seat: spot.hero.seat,
              action: decision.action,
              amount: decision.amount ?? 0,
              stage: street,
            },
            intended: true,
          },
        ],
      });
      expect(witness.acceptedActions[0].record.action).toBe(decision.action);
      expect(witness.phase13Authority!.selection).toBe('shadow_change');
      // A receipt retained before P13.3 (no selection), and a decision the
      // joint owner never saw, claim no Phase 13 binding.
      const legacy = { ...receipt } as Partial<typeof receipt>;
      delete legacy.selection;
      expect(make({ ...decision, jointPolicy: legacy as typeof receipt })).not.toHaveProperty(
        'phase13Authority'
      );
      expect(make({ action: 'check', thinkTime: 1 })).not.toHaveProperty('phase13Authority');
    }
  );

  it.each([10, 20])(
    'reconciles a sized call against its selected amount, not just its name (%s)',
    (amount) => {
      const witness = make({ action: 'call', amount: 10, thinkTime: 1 });
      settleHorseExecutionWitness(witness, {
        applied: true,
        acceptedActions: accepted('call', amount),
      });
      expect(witness.executionStatus).toBe(amount === 10 ? 'intended' : 'coerced');
      expect(witness.executedAmount).toBe(amount);
    }
  );

  it.each([100.3, 100.31])('binds all-in intent to the original street total (%s)', (amount) => {
    const snapshot = { ...input, player: { ...input.player, stack: 100.1, bet: 0.2 } };
    const witness = createHorseExecutionWitness(
      snapshot as never,
      { action: 'all_in', thinkTime: 1 },
      { requestId: 1, lane: 'fast', computeMs: 1, governorScale: 1 }
    );
    snapshot.player.stack = 999;
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: accepted('all_in', amount),
    });
    expect(witness.executionStatus).toBe(amount === 100.3 ? 'intended' : 'coerced');
    expect(witness.executedAmount).toBe(amount);
  });

  it.each(['call', 'all_in'] as const)(
    'leaves an unsized %s amount unverified without its original canonical price',
    (action) => {
      const witness = make({ action, thinkTime: 1 });
      settleHorseExecutionWitness(witness, {
        applied: true,
        acceptedActions: accepted(action, 20),
      });
      expect(witness.executionStatus).toBe('unverified');
      expect(witness.retirementReason).toBe('accepted_amount_unverifiable');
      expect(witness.acceptedActions[0].record.amount).toBe(20);
    }
  );
  it.each([
    { seat: 2, stage: 'flop' as const },
    { seat: 1, stage: 'turn' as const },
  ])('does not certify a matching wager from the wrong execution context %j', (over) => {
    const witness = make();
    const records = accepted('bet', 20);
    records[0] = { ...records[0], record: { ...records[0].record, ...over } };
    settleHorseExecutionWitness(witness, { applied: true, acceptedActions: records });
    expect(witness.executionStatus).toBe('unverified');
    expect(witness.retirementReason).toBe('accepted_context_mismatch');
    expect(witness.executedAction).toBeNull();
    expect(witness.acceptedActions[0].record).toMatchObject(over);
    settleHorseExecutionWitness(witness, { applied: true, acceptedActions: accepted('bet', 20) });
    expect(drainFires()).toEqual([
      { feature: 'phase15_execution_unverified', fires: 1 },
      { feature: 'phase15_fast_execution_unverified', fires: 1 },
    ]);
  });
  it('does not certify execution when a malformed fallback snapshot omitted the actor', () => {
    const snapshot = { ...input, player: undefined } as unknown as LiveHorseDecisionSnapshot;
    const witness = createHorseExecutionWitness(
      snapshot,
      { action: 'check', thinkTime: 0 },
      {
        requestId: 1,
        lane: 'worker_fallback',
        computeMs: 0,
        governorScale: 1,
      }
    );
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: accepted('check', null),
    });
    expect(witness.identity.heroSeat).toBeNull();
    expect(witness.executionStatus).toBe('unverified');
    expect(witness.retirementReason).toBe('accepted_context_mismatch');
  });
  it('copies immutable policy ownership independently of the returned decision', () => {
    const decision: HorseDecision = { action: 'check', thinkTime: 0 };
    decision.policyOwnership = horsePolicyOwnership('plo4', decision, false);
    const witness = make(decision);
    decision.policyOwnership.outcome = 'computed';
    expect(witness.policyOwnership?.outcome).toBe('disabled');
    expect(Object.isFrozen(witness.policyOwnership)).toBe(true);
  });
  it('does not infer execution from a boolean without the controller record', () => {
    const witness = make();
    settleHorseExecutionWitness(witness, { applied: true, acceptedActions: [] });
    expect(witness).toMatchObject({
      executionStatus: 'unverified',
      retirementReason: 'accepted_without_record',
      executedAction: null,
    });
  });

  it('keeps a record emitted before a later callback error instead of claiming nothing happened', () => {
    const witness = make();
    settleHorseExecutionWitness(witness, { applied: false, acceptedActions: accepted('bet', 20) });
    expect(witness).toMatchObject({
      executionStatus: 'intended',
      executedAction: 'bet',
      executedAmount: 20,
    });
  });

  it('retains conflicting accepted actions without certifying a single result', () => {
    const witness = make();
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: [...accepted('bet', 20), ...accepted('check', null, false)],
    });
    expect(witness).toMatchObject({
      executionStatus: 'unverified',
      retirementReason: 'multiple_accepted_actions',
      executedAction: null,
    });
    expect(witness.acceptedActions).toHaveLength(2);
  });
  it('snapshots the selected action and complete outer graph before later objects can change', () => {
    const graph = new HorsePolicyGraph(() => 0);
    let decision: HorseDecision = { action: 'bet', amount: 20, thinkTime: 1 };
    for (const node of HORSE_POLICY_ORDER) {
      decision = graph.run(node, node === 'reference' ? null : decision, () => ({
        decision,
      })).decision;
    }
    decision = graph.finish(decision);
    const witness = make(decision);
    const recorded = JSON.stringify(witness);
    decision.action = 'fold';
    decision.amount = undefined;
    decision.policyGraph!.transitions[0].after.action = 'fold';
    decision.policyGraph!.finalAction.action = 'fold';
    expect(JSON.stringify(witness)).toBe(recorded);
    expect(witness.policyGraph?.transitions).toHaveLength(8);
    expect(Object.isFrozen(witness.identity)).toBe(true);
    expect(Object.isFrozen(witness.selected)).toBe(true);
  });

  it.each([
    { action: 'bet' as const, amount: 20, intendedApplied: true, status: 'intended' },
    { action: 'bet' as const, amount: 30, intendedApplied: true, status: 'coerced' },
    { action: 'all_in' as const, amount: 100, intendedApplied: true, status: 'coerced' },
    { action: 'check' as const, amount: null, intendedApplied: false, status: 'fallback' },
  ])('records $status once after the actual $action attempt', ({ status, ...result }) => {
    const witness = make();
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: accepted(result.action, result.amount, result.intendedApplied),
    });
    const recorded = JSON.stringify(witness);
    retireHorseExecutionWitness(witness, 'turn_abandoned');
    settleHorseExecutionWitness(witness, {
      applied: false,
      acceptedActions: [],
    });
    expect(JSON.stringify(witness)).toBe(recorded);
    expect(witness.executionStatus).toBe(status);
    expect(witness.executedAction).toBe(result.action);
    expect(witness.executedAmount).toBe(result.amount);
    expect(drainFires()).toEqual([
      { feature: `phase15_execution_${status}`, fires: 1 },
      { feature: `phase15_fast_execution_${status}`, fires: 1 },
    ]);
  });

  it('does not mislabel an unsized call when the executor supplies its canonical price', () => {
    const witness = createHorseExecutionWitness(
      {
        ...input,
        player: { ...input.player, stack: 20 },
        gameState: { ...input.gameState, toCall: 50 },
      } as never,
      { action: 'call', thinkTime: 1 },
      { requestId: 1, lane: 'fast', computeMs: 1, governorScale: 1 }
    );
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: accepted('call', 20),
    });
    expect(witness.executionStatus).toBe('intended');
    expect(witness.executedAmount).toBe(20);
  });

  it('records a worker failure liveness action as fallback even when that exact action lands', () => {
    const witness = make({ action: 'check', thinkTime: 0 }, 'worker_fallback');
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: accepted('check', null),
    });
    expect(witness.executionStatus).toBe('fallback');
    expect(witness.policyGraph).toBeNull();
  });

  it('counts an accepted brain-exception decision as fallback instead of normal policy intent', () => {
    const witness = make({ action: 'fold', thinkTime: 1500, policyFallback: 'brain_exception' });
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: accepted('fold', null),
    });
    expect(witness).toMatchObject({
      executionStatus: 'fallback',
      policyFallback: 'brain_exception',
      executedAction: 'fold',
    });
  });

  it('leaves no executed action when every attempted action was rejected', () => {
    const witness = make();
    settleHorseExecutionWitness(witness, {
      applied: false,
      acceptedActions: [],
    });
    expect(witness).toMatchObject({
      executionStatus: 'not_executed',
      executedAction: null,
      executedAmount: null,
      retirementReason: 'action_rejected',
    });
  });

  it('never resurrects a retired decision or counts its later callback twice', () => {
    const witness = make();
    retireHorseExecutionWitness(witness, 'second_look_replaced');
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: accepted('bet', 20),
    });
    retireHorseExecutionWitness(witness, 'turn_abandoned');
    expect(witness).toMatchObject({
      executionStatus: 'not_executed',
      executedAction: null,
      retirementReason: 'second_look_replaced',
    });
    expect(drainFires()).toEqual([
      { feature: 'phase15_execution_not_executed', fires: 1 },
      { feature: 'phase15_fast_execution_not_executed', fires: 1 },
    ]);
  });
});
