/** Synthetic real-component controls, never original production/source proof. */
import { describe, it, expect, vi } from 'vitest';
import { HorseLogic } from '../../HorseLogic.js';
import { HorseMind } from '../../HorseMind.js';
import { equityGovernor } from '../../EquityLoadGovernor.js';
import { saveFastRandom, restoreFastRandom } from '../../HorseEval.js';
import { enableBrainTelemetry, noteFire, drainFires, restoreFires } from '../../BrainTelemetry.js';
import { jointPolicyFixture } from '../../multiway/JointRangeFixture.test-support.js';
import { currentReplaySolverStores } from './references.js';
import { solverPolicyArtifactStatus } from '../../../gto/SolverPolicyArtifactLoader.js';
import { qualifiedReplayAdmissions } from './qualifiedAuthority.js';
import { prepareTournamentFutureHandFacts } from '../../HorseTournamentFutureHand.js';
import {
  HorseDecisionWorkerRuntime,
  type HorseDecisionWorkerDependencies,
} from '../workerRuntime.js';
import {
  buildHorseDecisionKey,
  type FastHorseDecisionRequest,
  type FastHorseDecisionResult,
  type HorseDecisionWorkerResponse,
} from '../protocol.js';
import { captureHorseHandJournalContext } from '../../HorseDecisionHandBinding.js';
import {
  createHorseExecutionWitness,
  settleHorseExecutionWitness,
  expectedHorseExecutionAmount,
} from '../../HorseExecutionWitness.js';
import {
  journalHash,
  makeHorseJournalRecord,
  horseJournalJson,
  type HorseJournalRecord,
} from '../../../services/horseDecisionJournal/record.js';
import { reconcileHorseJournalHand } from '../../../services/horseDecisionJournal/review.js';
import { exactReplayHorseDecisionRecord, withFrozenHorseReplayClock } from './exactReplay.js';
import { reconstructHorseReplayInput } from './reconstruct.js';
import { replayThroughWorkerRuntime } from './runtimeReplay.js';
import * as runtimeReplayModule from './runtimeReplay.js';
import { horseDecisionReceiptIsValid } from '../responseValidation.js';
import { verifyV56CounterfactualCases } from './v56Counterfactual.js';
import pressureFixtures from '../../fixtures/horse-pressure-oct24.json';
import type { Card } from '../../../types.js';
import { calculatePots, calculateContestablePot } from '../../PokerEngine.js';
const SOURCE = '5'.repeat(40);
const TABLE = '10000000-0000-4000-8000-000000000001';
const HAND = '30000000-0000-4000-8000-000000000001';
const PRODUCER = '40000000-0000-4000-8000-000000000001';
async function original(v56Off = false, pressure: boolean | number = false) {
  let { hero, state } = JSON.parse(
    JSON.stringify(jointPolicyFixture('plo4', 1, 'cash', 'river')),
    (_k, v) =>
      typeof v === 'string' && /^p[0-9]$/.test(v)
        ? `20000000-0000-4000-8000-00000000000${Number(v.slice(1)) + 1}`
        : v
  );
  if (pressure) {
    // The original public pressure geometry is used only to create a NEW
    // synthetic worker control with new actor identities/provenance.
    const fixture = pressureFixtures[pressure === 2 ? 1 : 0]!,
      n = fixture.node;
    const id = (seat: number) => `20000000-0000-4000-8000-00000000000${seat}`;
    const players = n.seats.map(
      ([seat, stack, bet, totalInvested, deadInvested, individualAnteInvested, flags]) => ({
        seat,
        stack,
        bet,
        totalInvested,
        deadInvested,
        individualAnteInvested,
        user_id: id(seat),
        username: `Seat ${seat}`,
        cards: seat === fixture.heroSeat ? (fixture.heroCards as Card[]) : [],
        is_folded: !!(flags & 1),
        is_all_in: !!(flags & 2),
        is_sitting_out: !!(flags & 4),
        is_horse: true,
      })
    );
    hero = players.find((p) => p.seat === fixture.heroSeat)!;
    const board = (n.boards[0]!.match(/../g) ?? []).map(
      (v) =>
        ({
          rank: v[0],
          suit: ({ c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const)[v[1] as 'c'],
        }) as Card
    );
    state = {
      ...state,
      players: players.map((p) => ({ ...p, cards: [] })),
      dealtSeatIds: players.map((p) => p.seat),
      heroSeat: hero.seat,
      currentPlayerSeat: hero.seat,
      dealerSeat: n.dealerSeat,
      communityCards: board,
      communityCards2: [],
      communityCards3: [],
      pot: n.pot,
      currentBet: n.currentBet,
      minRaise: n.bigBlind,
      bigBlind: n.bigBlind,
      smallBlind: n.smallBlind,
      minRaiseTo: n.minRaiseTo,
      maxRaiseTo: n.maxRaiseTo,
      legalActions: n.legalActions,
      toCall: n.toCall,
      chipUnit: n.chipUnit,
      rakeConfig: {
        ...n.deductions.rake,
        playerCountCaps: n.deductions.rake.playerCountCaps.map(([players, cap]) => ({
          players,
          cap,
        })),
      },
      actionHistory: fixture.history.map((a) => ({ ...a, userId: id(a.seat), origin: 'player' })),
    };
    state.pots = calculatePots(players);
    state.contestablePot = calculateContestablePot(players, hero.user_id, n.toCall);
  }
  const request: FastHorseDecisionRequest = {
    type: 'DECIDE_FAST',
    requestId: 1,
    generation: 7,
    fence: `${TABLE}:12:${hero.seat}:9:7`,
    decisionTimeMs: 1000,
    decisionKey: '',
    player: hero,
    gameState: state,
    style: 'balanced',
    mods: {},
    opts: { mind: true, ...(v56Off ? { v56OmahaPressureRange: false } : {}) },
    handJournalContext: captureHorseHandJournalContext(state.actionHistory),
  };
  request.decisionKey = buildHorseDecisionKey(request);
  const handKey = journalHash(`${TABLE}:12:9`);
  const turn = journalHash(
    JSON.stringify([
      request.generation,
      request.fence,
      request.requestId,
      request.decisionKey,
      request.decisionTimeMs,
    ])
  );
  const records: HorseJournalRecord[] = [];
  let sequence = 0;
  const make = (kind: HorseJournalRecord['kind'], body: unknown) =>
    makeHorseJournalRecord(
      {
        producerId: PRODUCER,
        sequence: ++sequence,
        sourceRelease: SOURCE,
        atMs: 1000,
        kind,
        handKey,
        turnKey: kind === 'accepted_hand' ? handKey : turn,
      },
      body
    );
  const messages: HorseDecisionWorkerResponse[] = [];
  const readiness = () => {
    const { identity, charts, postflop, postflopV31, postflopV31Dataset } =
      currentReplaySolverStores();
    return {
      solverStores: { charts, postflop, postflopV31, postflopV31Dataset },
      solverStoreIdentity: identity,
      solverPolicyArtifact: solverPolicyArtifactStatus(),
      governor: equityGovernor.snapshot(),
    };
  };
  const deps: HorseDecisionWorkerDependencies = {
    ...qualifiedReplayAdmissions,
    journalEnabled: () => true,
    journalDecision: (_r, b) => {
      records.push(make('decision', b));
    },
    journalLifecycle: (_r, b) => {
      records.push(make('request_lifecycle', b));
    },
    async startServices() {
      prepareTournamentFutureHandFacts();
      return readiness();
    },
    async stopServices() {},
    decide: HorseLogic.decide.bind(HorseLogic),
    decideDiscard: HorseLogic.decideDiscard.bind(HorseLogic),
    captureDecisionEffects: (fn) => HorseMind.captureDecisionEffects(fn),
    applyDecisionEffects: () => {},
    saveRng: saveFastRandom,
    restoreRng: restoreFastRandom,
    governorScale: () => equityGovernor.current(),
    atGovernorScale: (fn) => equityGovernor.withDecisionScale(fn),
    workerReadiness: readiness,
    phase8SafetyDisabledReason: () => null,
    observeCompletedHand: () => {},
    noteDecision: () => {},
    noteFeature: () => {},
    now: () => 0,
  };
  enableBrainTelemetry();
  await withFrozenHorseReplayClock(1000, async () => {
    const runtime = new HorseDecisionWorkerRuntime((m) => messages.push(m), deps);
    await runtime.start();
    runtime.receive(request);
    await runtime.drain();
  });
  const result = messages.find((m): m is FastHorseDecisionResult => m.type === 'FAST_RESULT');
  if (!result)
    throw Error(
      'real worker refused synthetic fixture: ' +
        JSON.stringify(messages.filter((m) => m.type === 'ERROR'))
    );
  const witness = createHorseExecutionWitness(request, result.decision, {
    requestId: 1,
    lane: 'fast',
    computeMs: result.computeMs,
    governorScale: result.governorScale,
  });
  const accepted = {
    seat: hero.seat,
    userId: hero.user_id,
    action: result.decision.action,
    amount: expectedHorseExecutionAmount(request, result.decision) ?? 0,
    timestamp: 1001,
    stage: 'river' as const,
  };
  settleHorseExecutionWitness(witness, {
    applied: true,
    acceptedActions: [{ record: accepted, intended: true }],
  });
  records.push(make('execution', witness));
  const ordinal = state.actionHistory.length;
  records.push(
    make('accepted_hand', {
      generation: 12,
      fence: `${TABLE}:12:9:observe`,
      handKey: `${TABLE}:12`,
      committedHandId: HAND,
      bigBlind: state.bigBlind,
      actions: [
        ...state.actionHistory,
        {
          ...accepted,
          origin: 'horse_policy',
          publicNode: { version: 1, status: 'captured', actorSeat: hero.seat, street: 'river' },
          observationIdentity: {
            version: 1,
            status: 'bound',
            handId: HAND,
            actionOrdinal: ordinal,
            observationId: `${HAND}:${ordinal}`,
            sessionKey: 'a'.repeat(64),
          },
        },
      ],
    })
  );
  return { records, record: records.find((r) => r.kind === 'decision')!, request, result, handKey };
}
describe('private V56 counterfactual controls', () => {
  it('requires real exact replay, hand reconciliation and accepted binding before reporting zero', async () => {
    const f = await original();
    expect(reconcileHorseJournalHand(f.records, f.handKey)).toMatchObject({
      status: 'reconciled',
      requestLifecycleVerified: true,
    });
    const [out] = await verifyV56CounterfactualCases(
      [{ decisionSha256: f.record.sha256, records: f.records }],
      { runningSource: SOURCE }
    );
    expect(out).toMatchObject({
      reason: 'v56_not_observed',
      originalExact: true,
      originalAccepted: true,
      offComputed: false,
    });
    expect(JSON.stringify(out)).not.toContain(TABLE);
  });
  it('preserves default exact output shape and captures actual runtime telemetry opt in', async () => {
    const f = await original();
    const plain = await exactReplayHorseDecisionRecord(f.record, { runningSource: SOURCE });
    expect(plain.replayVerified).toBe(true);
    expect(plain).not.toHaveProperty('v56PressureRangeFires');
    const [out] = await verifyV56CounterfactualCases(
      [{ decisionSha256: f.record.sha256, records: f.records }],
      { runningSource: SOURCE }
    );
    expect(out).toMatchObject({
      reason: 'v56_not_observed',
      originalExact: true,
      originalAccepted: true,
    });
  });
  it('refuses other source, missing accepted hand, original off, and excessive cases', async () => {
    const f = await original();
    const run = (records = f.records, source = SOURCE) =>
      verifyV56CounterfactualCases([{ decisionSha256: f.record.sha256, records }], {
        runningSource: source,
      });
    expect((await run(f.records, '6'.repeat(40)))[0]?.reason).toBe('baseline_not_exact');
    expect((await run(f.records.filter((r) => r.kind !== 'accepted_hand')))[0]?.reason).toBe(
      'hand_not_reconciled'
    );
    const disabled = await original(true);
    expect(
      (
        await verifyV56CounterfactualCases(
          [{ decisionSha256: disabled.record.sha256, records: disabled.records }],
          { runningSource: SOURCE }
        )
      )[0]?.reason
    ).toBe('original_v56_off');
    expect(
      (
        await verifyV56CounterfactualCases(
          Array(7).fill({ decisionSha256: f.record.sha256, records: f.records }),
          { runningSource: SOURCE }
        )
      )[0]?.reason
    ).toBe('bounds');
  });
  it('compares an actually observed V56 on arm with only the private off switch', async () => {
    const f = await original(false, true);
    const review = reconcileHorseJournalHand(f.records, f.handKey);
    expect(review, JSON.stringify(review)).toMatchObject({ status: 'reconciled' });
    const [out] = await verifyV56CounterfactualCases(
      [{ decisionSha256: f.record.sha256, records: f.records }],
      { runningSource: SOURCE }
    );
    expect(out, JSON.stringify(out)).toMatchObject({
      originalExact: true,
      originalAccepted: true,
      v56Observed: true,
      offComputed: true,
      sameAdmissions: true,
      offAccepted: false,
    });
    expect(['causal_application_observed', 'executed_no_difference']).toContain(out?.reason);
    expect(out?.actionChanged).toBe(out?.reason === 'causal_application_observed');
  });
  it('rejects missing solver identity and altered accepted original binding', async () => {
    const f = await original();
    const body = JSON.parse(f.record.body);
    delete body.readiness.solverStoreIdentity;
    const changed = makeHorseJournalRecord(f.record, body);
    expect(
      (
        await verifyV56CounterfactualCases(
          [
            {
              decisionSha256: changed.sha256,
              records: f.records.map((r) => (r === f.record ? changed : r)),
            },
          ],
          { runningSource: SOURCE }
        )
      )[0]?.reason
    ).toBe('pins_missing');
    const accepted = f.records.find((r) => r.kind === 'accepted_hand')!;
    const hand = JSON.parse(accepted.body);
    hand.actions.at(-1).observationIdentity.handId = PRODUCER;
    const unbound = makeHorseJournalRecord(accepted, hand);
    expect(
      (
        await verifyV56CounterfactualCases(
          [
            {
              decisionSha256: f.record.sha256,
              records: f.records.map((r) => (r === accepted ? unbound : r)),
            },
          ],
          { runningSource: SOURCE }
        )
      )[0]?.reason
    ).toBe('hand_not_reconciled');
  });
  it('restores parked telemetry, RNG and clocks when worker startup throws', async () => {
    const f = await original(),
      input = reconstructHorseReplayInput(f.record);
    const rng = saveFastRandom(),
      dateNow = Date.now,
      parked = drainFires();
    noteFire('v56_failure_parked');
    const failure = vi
      .spyOn(HorseDecisionWorkerRuntime.prototype, 'start')
      .mockRejectedValueOnce(Error('synthetic startup failure'));
    try {
      await expect(
        withFrozenHorseReplayClock(1000, () =>
          replayThroughWorkerRuntime(input, {
            captureV56PressureWitness: true,
            v56PressureCounterfactual: 'off',
          })
        )
      ).rejects.toThrow('synthetic startup failure');
      expect(Date.now).toBe(dateNow);
      expect(saveFastRandom()).toBe(rng);
      expect(drainFires()).toEqual([{ feature: 'v56_failure_parked', fires: 1 }]);
    } finally {
      failure.mockRestore();
      restoreFires(parked);
      restoreFastRandom(rng);
    }
  });
  it.each(['malformed_action', 'legal_wager_over_cap'] as const)(
    'refuses only the corrupted off arm: %s',
    async (fault) => {
      const f = await original(false, fault === 'legal_wager_over_cap' ? 2 : true);
      const actualReplay = runtimeReplayModule.replayThroughWorkerRuntime;
      const injection = vi
        .spyOn(runtimeReplayModule, 'replayThroughWorkerRuntime')
        .mockImplementation(async (input, bindings) => {
          const outcome = await actualReplay(input, bindings);
          if (bindings?.v56PressureCounterfactual !== 'off' || !outcome.result) return outcome;
          const decision =
            fault === 'malformed_action'
              ? { action: 'invalid_action', thinkTime: 0 }
              : {
                  action: 'raise',
                  amount: input.request.gameState.maxRaiseTo! + 100,
                  thinkTime: 0,
                };
          if (fault === 'legal_wager_over_cap') {
            expect(input.request.gameState.legalActions).toContain('raise');
            expect(
              horseDecisionReceiptIsValid(decision, 'plo4', {
                player: input.request.player,
                gameState: input.request.gameState,
              })
            ).toBe(true);
          }
          return { ...outcome, result: { ...outcome.result, decision: decision as never } };
        });
      try {
        const [out] = await verifyV56CounterfactualCases(
          [{ decisionSha256: f.record.sha256, records: f.records }],
          { runningSource: SOURCE }
        );
        expect(out).toMatchObject({
          reason: 'off_arm_unavailable',
          originalExact: true,
          originalAccepted: true,
          v56Observed: true,
          offComputed: false,
          offActionSha256: null,
        });
      } finally {
        injection.mockRestore();
      }
    }
  );
  it('does not attribute an aggregate FAST plus DEEP counter to the selected DEEP branch', async () => {
    const f = await original(),
      input = reconstructHorseReplayInput(f.record);
    const replay = await withFrozenHorseReplayClock(1000, () =>
      replayThroughWorkerRuntime(
        { ...input, deepRequest: { type: 'DECIDE_DEEP', requestId: 2 } as never },
        { captureV56PressureWitness: true }
      )
    );
    expect(replay.v56PressureRangeFires).toBeNull();
  });
  it('refuses DEEP counterfactuals before touching process state', async () => {
    const f = await original(),
      input = reconstructHorseReplayInput(f.record);
    const rng = saveFastRandom();
    await expect(
      replayThroughWorkerRuntime(
        { ...input, deepRequest: { type: 'DECIDE_DEEP' } as never },
        { v56PressureCounterfactual: 'off' }
      )
    ).rejects.toThrow('original FAST only');
    expect(saveFastRandom()).toBe(rng);
  });
  it('computes private off arm without mutating request, RNG, telemetry or admissions', async () => {
    const f = await original();
    const input = reconstructHorseReplayInput(f.record);
    const before = horseJournalJson(input),
      rng = saveFastRandom(),
      parked = drainFires();
    noteFire('v56_test_parked');
    try {
      const off = await withFrozenHorseReplayClock(1000, () =>
        replayThroughWorkerRuntime(input, {
          phase8SafetyDisabledReason: null,
          v56PressureCounterfactual: 'off',
          captureV56PressureWitness: true,
        })
      );
      expect(off.result).not.toBeNull();
      expect(off.v56PressureRangeFires).toBe(0);
      expect(off.admission).toEqual(JSON.parse(f.record.body).replayState.admission);
      expect(horseJournalJson(input)).toBe(before);
      expect(saveFastRandom()).toBe(rng);
      expect(drainFires()).toEqual([{ feature: 'v56_test_parked', fires: 1 }]);
    } finally {
      restoreFires(parked);
      restoreFastRandom(rng);
    }
  });
});
