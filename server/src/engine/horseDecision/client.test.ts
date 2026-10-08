import {
  horsePlanBatchBindingFromRequest,
  horsePlanContextFromDecision,
} from '../HorsePlanHandIdentity.js';
import { describe, expect, it, vi } from 'vitest';
import { horsePlanAcceptanceFromController } from '../HorsePlanEffectReceipt.js';

import type {
  FastHorseDecisionResult,
  HorseDecisionWorkerReady,
  HorseDecisionWorkerResponse,
  LiveHorseDecisionSnapshot,
} from './protocol.js';
import { buildHorseDecisionKey } from './protocol.js';
import { captureHorseHandJournalContext } from '../HorseDecisionHandBinding.js';
import { settleHorseExecutionWitness } from '../HorseExecutionWitness.js';
import { HorsePolicyGraph, HORSE_POLICY_ORDER } from '../HorsePolicyGraph.js';
import { HorseLogic } from '../HorseLogic.js';
import { seedFastRandom } from '../HorseEval.js';
import { drainFires, enableBrainTelemetry } from '../BrainTelemetry.js';
import { plo4Cards, plo4ReferenceSpot } from '../../benchmark/Plo4PolicyEvidence.js';
import { omahaVariantSpot, variantCards } from '../../benchmark/OmahaVariantPolicyEvidence.js';
import { remainingVariantSpot } from '../../benchmark/RemainingVariantPolicyEvidence.js';
import { horseDecisionReceiptIsValid } from './responseValidation.js';
import { jointPolicyFixture } from '../multiway/JointRangeFixture.test-support.js';
import type { HorseDiscardExecutionObservation } from '../../services/horseDecisionJournal/discard.js';
import { horseDecisionJournalHealth } from '../../services/HorseDecisionJournal.js';
import {
  HorseQualifiedAuthorityHolder,
  liveHorsePhase8Authority,
  type HorseAuthorityAdmission,
} from '../HorseQualifiedAuthority.js';
import { qualifiedTestAdmission } from '../HorseQualifiedAuthority.test-support.js';
import { liveHorsePhase11Authorities } from '../HorsePhase11Authority.js';
import { qualifiedPhase11TestAdmission } from '../HorsePhase11Authority.test-support.js';
import { OMAHA_VARIANT_PACKS } from '../omaha/OmahaVariantPolicyPack.js';
import { liveHorsePhase12Authorities } from '../HorsePhase12Authority.js';
import { qualifiedPhase12TestAdmission } from '../HorsePhase12Authority.test-support.js';
import {
  horsePhase13ContinuationVersion,
  HORSE_PHASE13_VARIANTS,
  liveHorsePhase13Authorities,
} from '../HorsePhase13Authority.js';
import { qualifiedPhase13TestAdmission } from '../HorsePhase13Authority.test-support.js';
import type { JointVariant } from '../multiway/JointInputBinding.js';
import {
  REMAINING_VARIANT_PACKS,
  type RemainingPolicyVariant,
} from '../remainingVariants/RemainingVariantPolicyPack.js';
import {
  HorseDecisionAbortedError,
  HORSE_CAPTURE_LANE_MAX_QUEUED,
  HorseDecisionExpiredError,
  LiveHorseDecisionWorkerClient,
  type WorkerLike,
} from './client.js';
import { doorRosterTransport } from '../../services/horseAcceptedRoster/fixture.test-support.js';

// The process-wide main gate admits only the committed release selection,
// which is null today. These tests replace that one export with a gate whose
// admission they control; every other test keeps the unselected default.

/** The exact wager a controller accepting this FAST decision records. */
function acceptanceOf(result: FastHorseDecisionResult) {
  return horsePlanAcceptanceFromController(
    null,
    { action: result.decision.action, amount: result.decision.amount ?? null },
    { requestId: result.requestId, decisionKey: result.planBinding.decisionKey }
  );
}

const phase8Main = vi.hoisted(() => ({ admission: null as unknown }));
vi.mock('../HorseQualifiedAuthority.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../HorseQualifiedAuthority.js')>();
  return {
    ...actual,
    liveHorsePhase8Authority: new actual.HorsePhase8AuthorityGate(
      () =>
        (phase8Main.admission as HorseAuthorityAdmission | null) ?? {
          status: 'refused',
          reason: 'unselected',
          transient: false,
        },
      'client-test-main'
    ),
  };
});

// P11.3: the three Phase 11 main gates, each replaced the same way.
const phase11Main = vi.hoisted(() => ({
  admission: { plo5: null, plo6: null, plo8: null } as Record<string, unknown>,
}));
vi.mock('../HorsePhase11Authority.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../HorsePhase11Authority.js')>();
  const { HorsePhase8AuthorityGate } = await import('../HorseQualifiedAuthority.js');
  const { OMAHA_VARIANT_PACKS } = await import('../omaha/OmahaVariantPolicyPack.js');
  const gate = (variant: 'plo5' | 'plo6' | 'plo8') =>
    new HorsePhase8AuthorityGate(
      () =>
        (phase11Main.admission[variant] as HorseAuthorityAdmission | null) ?? {
          status: 'refused',
          reason: 'unselected',
          transient: false,
        },
      `client-test-phase11-main-${variant}`,
      OMAHA_VARIANT_PACKS[variant].version
    );
  return {
    ...actual,
    liveHorsePhase11Authorities: Object.freeze({
      plo5: gate('plo5'),
      plo6: gate('plo6'),
      plo8: gate('plo8'),
    }),
  };
});

// P12.3: the four Phase 12 main gates, each replaced the same way.
const phase12Main = vi.hoisted(() => ({
  admission: { short_deck: null, pineapple: null, flh: null, flo8: null } as Record<
    string,
    unknown
  >,
}));
vi.mock('../HorsePhase12Authority.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../HorsePhase12Authority.js')>();
  const { HorsePhase8AuthorityGate } = await import('../HorseQualifiedAuthority.js');
  const { REMAINING_VARIANT_PACKS } =
    await import('../remainingVariants/RemainingVariantPolicyPack.js');
  const gate = (variant: 'short_deck' | 'pineapple' | 'flh' | 'flo8') =>
    new HorsePhase8AuthorityGate(
      () =>
        (phase12Main.admission[variant] as HorseAuthorityAdmission | null) ?? {
          status: 'refused',
          reason: 'unselected',
          transient: false,
        },
      `client-test-phase12-main-${variant}`,
      REMAINING_VARIANT_PACKS[variant].version
    );
  return {
    ...actual,
    liveHorsePhase12Authorities: Object.freeze({
      short_deck: gate('short_deck'),
      pineapple: gate('pineapple'),
      flh: gate('flh'),
      flo8: gate('flo8'),
    }),
  };
});

// P13.3: the nine Phase 13 main gates, each replaced the same way.
const phase13Main = vi.hoisted(() => ({
  admission: {} as Record<string, unknown>,
}));
vi.mock('../HorsePhase13Authority.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../HorsePhase13Authority.js')>();
  const { HorsePhase8AuthorityGate } = await import('../HorseQualifiedAuthority.js');
  return {
    ...actual,
    liveHorsePhase13Authorities: Object.freeze(
      Object.fromEntries(
        actual.HORSE_PHASE13_VARIANTS.map((variant) => [
          variant,
          new HorsePhase8AuthorityGate(
            () =>
              (phase13Main.admission[variant] as HorseAuthorityAdmission | null | undefined) ?? {
                status: 'refused',
                reason: 'unselected',
                transient: false,
              },
            `client-test-phase13-main-${variant}`,
            actual.horsePhase13ContinuationVersion(variant)
          ),
        ])
      )
    ),
  };
});

class FakeWorker implements WorkerLike {
  readonly sent: unknown[] = [];
  terminateCalls = 0;
  private messageListener: ((message: HorseDecisionWorkerResponse) => void) | null = null;
  private errorListener: ((error: Error) => void) | null = null;
  private exitListener: ((code: number) => void) | null = null;
  throwOnPost: Error | null = null;

  postMessage(message: unknown): void {
    if (this.throwOnPost) throw this.throwOnPost;
    this.sent.push(message);
  }

  on(event: 'message', listener: (message: HorseDecisionWorkerResponse) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  on(
    event: 'message' | 'error' | 'exit',
    listener:
      | ((message: HorseDecisionWorkerResponse) => void)
      | ((error: Error) => void)
      | ((code: number) => void)
  ): this {
    if (event === 'message') {
      this.messageListener = listener as (message: HorseDecisionWorkerResponse) => void;
    } else if (event === 'error') {
      this.errorListener = listener as (error: Error) => void;
    } else {
      this.exitListener = listener as (code: number) => void;
    }
    return this;
  }

  terminate(): Promise<number> {
    this.terminateCalls++;
    return Promise.resolve(0);
  }

  emitMessage(message: any): void {
    // Fixture-only producer migration: derive new metadata from the exact sent
    // job. This fake ACK/transport harness does not prove worker issue ownership.
    // CANCEL reuses the request ID but carries no producer snapshot. A late
    // valid result must retain the binding from its original decision request.
    const requestType =
      message?.type === 'FAST_RESULT'
        ? 'DECIDE_FAST'
        : message?.type === 'DEEP_RESULT'
          ? 'DECIDE_DEEP'
          : null;
    const request = [...this.sent]
      .reverse()
      .find(
        (item: any) => item?.requestId === message?.requestId && item?.type === requestType
      ) as any;
    if (
      message?.type === 'FAST_RESULT' &&
      request?.type === 'DECIDE_FAST' &&
      message.planBinding === undefined
    )
      message = { ...message, planBinding: horsePlanBatchBindingFromRequest(request) };
    if (
      message?.type === 'DEEP_RESULT' &&
      request?.type === 'DECIDE_DEEP' &&
      message.planContext === undefined
    )
      message = { ...message, planContext: horsePlanContextFromDecision(request) };
    this.messageListener?.(message);
  }

  emitError(error: Error): void {
    this.errorListener?.(error);
  }

  emitExit(code: number): void {
    this.exitListener?.(code);
  }
}

const snapshot = (fence: string): LiveHorseDecisionSnapshot => {
  const value: LiveHorseDecisionSnapshot = {
    generation: 7,
    fence,
    decisionKey: '',
    decisionTimeMs: 1_800_000,
    player: {
      seat: 1,
      user_id: 'horse-1',
      username: 'Horse One',
      stack: 100,
      bet: 0,
      totalInvested: 0,
      cards: [
        { rank: 'A', suit: 'spades' },
        { rank: 'K', suit: 'spades' },
      ],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    },
    gameState: {
      stateSchemaVersion: 1,
      heroSeat: 1,
      currentPlayerSeat: 1,
      legalActions: ['fold', 'call', 'raise', 'all_in'],
      toCall: 2,
      minRaiseTo: 4,
      maxRaiseTo: 100,
      bettingStructure: 'no_limit',
      fixedBetSize: null,
      wagersCapped: false,
      commitmentCapRemaining: null,
      players: [
        {
          seat: 1,
          user_id: 'horse-1',
          username: 'Horse One',
          stack: 100,
          bet: 0,
          totalInvested: 0,
          cards: [],
          is_folded: false,
          is_all_in: false,
          is_sitting_out: false,
        },
        {
          seat: 2,
          user_id: 'horse-2',
          username: 'Horse Two',
          stack: 98,
          bet: 2,
          totalInvested: 2,
          cards: [],
          is_folded: false,
          is_all_in: false,
          is_sitting_out: false,
        },
      ],
      communityCards: [],
      communityCards2: [],
      communityCards3: [],
      pot: 2,
      contestablePot: 2,
      currentBet: 2,
      minRaise: 2,
      stage: 'preflop',
      gameVariant: 'nlh',
      bigBlind: 2,
      actionHistory: [],
      pots: [{ amount: 2, eligiblePlayers: ['horse-2'] }],
      rakeConfig: { percent: 10, cap: 5, noFlopNoDrop: true },
      variantRules: {
        holeCardsDealt: 2,
        holeCardsUse: 'any',
        boardCardsUse: 'any',
        deckSize: 52,
        splitLow8OrBetter: false,
      },
    },
  };
  value.decisionKey = buildHorseDecisionKey(value);
  return value;
};

const V31_DATASET = {
  id: '11111111-1111-4111-8111-111111111111',
  checksum: 'a'.repeat(64),
};

const ready = {
  type: 'READY' as const,
  solverStores: {
    charts: 1,
    postflop: 2,
    postflopV31: 3,
    postflopV31Dataset: V31_DATASET,
  },
  solverPolicyArtifact: {
    totalPolicies: 4,
  } as HorseDecisionWorkerReady['solverPolicyArtifact'],
  governor: {
    enabled: true,
    scale: 0.35,
    p50Ms: 180,
    p99Ms: 240,
    sampledAt: 123,
    throttledForS: 4,
    stale: false,
    timerLateMs: 25,
  },
};

const fastResult = (requestId: number, fence: string): FastHorseDecisionResult => ({
  type: 'FAST_RESULT' as const,
  planIssueDisposition: 'no_effects',
  requestId,
  planBinding: undefined as any, // Filled by the actual sent-job fixture adapter above.
  generation: 7,
  fence,
  decision: { action: 'fold' as const, thinkTime: 1500 },
  rngBefore: 11,
  rngAfter: 22,
  computeMs: 4,
  governorScale: 0.35,
  effects: [],
});

// These ordering controls obtain an actual client-owned result from the fake
// worker transport. Application/table authority is covered by the real chain.
async function transportOnlyCommitFixture(
  client: LiveHorseDecisionWorkerClient,
  worker: FakeWorker
): Promise<FastHorseDecisionResult> {
  const input = snapshot(
    '33333333-3333-4333-8333-333333333333:1000100:1:44444444-4444-4444-8444-444444444444:7'
  );
  input.gameState.stage = 'flop';
  input.gameState.actionHistory = [
    { seat: 2, userId: 'horse-2', timestamp: 12, stage: 'preflop', action: 'call', amount: 2 },
  ];
  input.decisionKey = buildHorseDecisionKey(input);
  const pending = client.decideFast(input);
  const graph = new HorsePolicyGraph(() => 0);
  let decision: FastHorseDecisionResult['decision'] | null = null;
  for (const node of HORSE_POLICY_ORDER)
    decision = graph.run(node, decision, () => ({
      decision: { action: 'bet', amount: 10, thinkTime: 0 },
    })).decision;
  worker.emitMessage({
    ...fastResult(1, input.fence),
    planIssueDisposition: 'issued',
    decision: graph.finish(decision!),
    effects: [
      {
        type: 'plan',
        handKey: 'plan-hand-v1:33333333-3333-4333-8333-333333333333:1000100',
        userId: 'horse-1',
        barrelIntent: true,
      },
    ],
  });
  return pending;
}

describe('LiveHorseDecisionWorkerClient', () => {
  it.each([true, false])(
    'transports private accepted-discard evidence only when journal configured=%s',
    async (configured) => {
      const worker = new FakeWorker();
      const prior = process.env.HORSE_DECISION_JOURNAL_DIR;
      if (configured) process.env.HORSE_DECISION_JOURNAL_DIR = '/synthetic-horse-journal';
      else delete process.env.HORSE_DECISION_JOURNAL_DIR;
      let client: LiveHorseDecisionWorkerClient;
      try {
        client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
      } finally {
        if (prior === undefined) delete process.env.HORSE_DECISION_JOURNAL_DIR;
        else process.env.HORSE_DECISION_JOURNAL_DIR = prior;
      }
      worker.emitMessage(ready);
      const tableId = '11111111-1111-4111-8111-111111111111';
      const actorId = '22222222-2222-4222-8222-222222222222';
      const request: HorseDiscardExecutionObservation['request'] = {
        type: 'DECIDE_DISCARD',
        requestId: 44,
        generation: 7,
        fence: '',
        gameVariant: 'pineapple',
        cards: [
          { rank: 'A', suit: 'spades' },
          { rank: 'K', suit: 'spades' },
          { rank: 'Q', suit: 'hearts' },
        ],
        communityCards: [
          { rank: '2', suit: 'clubs' },
          { rank: '3', suit: 'clubs' },
          { rank: '4', suit: 'clubs' },
        ],
        journalContext: {
          version: 1,
          tableId,
          actorId,
          handNumber: 12,
          seat: 1,
          leaseGeneration: '99',
          requestedAtMs: 900,
          lane: 'choice',
          priorActions: captureHorseHandJournalContext([])!,
        },
      };
      request.fence = [
        tableId,
        12,
        'pineapple-discard',
        1,
        '99',
        7,
        request.cards.map((c) => `${c.rank}:${c.suit}`).join('|'),
        request.communityCards.map((c) => `${c.rank}:${c.suit}`).join('|'),
      ].join(':');
      const execution: HorseDiscardExecutionObservation = {
        version: 1,
        request,
        selectedIndex: 2,
        acceptedActionOrdinal: 0,
        priorActions: captureHorseHandJournalContext([])!,
        controller: {
          seat: 1,
          actorId,
          chosenIndex: 2,
          originalCards: structuredClone(request.cards),
          discardedCard: { ...request.cards[2] },
          retainedCards: structuredClone(request.cards.slice(0, 2)),
          communityCards: structuredClone(request.communityCards),
          acceptedRecord: {
            seat: 1,
            userId: actorId,
            action: 'discard',
            amount: 0,
            stage: 'pineapple_discard',
            timestamp: 1000,
          },
        },
      };
      client.observeDiscardExecution(execution);
      expect(worker.sent).toHaveLength(configured ? 1 : 0);
      if (configured) {
        expect(worker.sent[0]).toEqual({
          type: 'OBSERVE_DISCARD_EXECUTION',
          requestId: 1,
          generation: 7,
          fence: request.fence,
          execution,
        });
        request.cards[0].rank = '2';
        execution.selectedIndex = 0;
        expect((worker.sent[0] as any).execution.request.cards[0].rank).toBe('A');
        expect((worker.sent[0] as any).execution.selectedIndex).toBe(2);
        worker.emitMessage({
          type: 'ACK',
          requestId: 1,
          generation: 7,
          fence: request.fence,
          operation: 'OBSERVE_DISCARD_EXECUTION',
        });
        expect(client.status().phase).toBe('ready');
      }
      const stop = client.stop();
      worker.emitMessage({ type: 'STOPPED' });
      await stop;
    }
  );
  it('queues one immutable finalized execution for the configured private journal', async () => {
    const worker = new FakeWorker();
    const prior = process.env.HORSE_DECISION_JOURNAL_DIR;
    process.env.HORSE_DECISION_JOURNAL_DIR = '/synthetic-horse-journal';
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    if (prior === undefined) delete process.env.HORSE_DECISION_JOURNAL_DIR;
    else process.env.HORSE_DECISION_JOURNAL_DIR = prior;
    worker.emitMessage(ready);
    const input = snapshot('journal-fence'),
      pending = client.decideFast(input);
    worker.emitMessage(fastResult(1, input.fence));
    const result = await pending;
    settleHorseExecutionWitness(result.decision.executionWitness, {
      applied: true,
      acceptedActions: [
        {
          record: {
            seat: 1,
            userId: 'horse-1',
            action: 'fold',
            amount: 0,
            stage: input.gameState.stage,
            timestamp: 1000,
          },
          intended: true,
        },
      ],
    });
    expect(worker.sent[1]).toMatchObject({
      type: 'OBSERVE_EXECUTION',
      requestId: 2,
      fence: input.fence,
      witness: { executionStatus: 'intended', identity: { requestId: 1 } },
    });
    result.decision.executionWitness!.committedHand = {
      status: 'unavailable',
      reason: 'tracking_expired',
    };
    expect((worker.sent[1] as any).witness.committedHand).not.toEqual(
      result.decision.executionWitness!.committedHand
    );
    settleHorseExecutionWitness(result.decision.executionWitness, {
      applied: false,
      acceptedActions: [],
    });
    expect(worker.sent).toHaveLength(2);
    worker.emitMessage({
      type: 'ACK',
      requestId: 2,
      generation: 7,
      fence: input.fence,
      operation: 'OBSERVE_EXECUTION',
    });
    const stop = client.stop();
    worker.emitMessage({ type: 'STOPPED' });
    await stop;
  });
  it('joins the actual returned and settled witness when the committed producer enters the FIFO', async () => {
    const table = '11111111-1111-4111-8111-111111111111';
    const horse = '22222222-2222-4222-8222-222222222222';
    const hand = '33333333-3333-4333-8333-333333333333';
    const input = snapshot(`${table}:12:1:99:7`);
    input.player.user_id = horse;
    input.handJournalContext = captureHorseHandJournalContext([]);
    input.decisionKey = buildHorseDecisionKey(input);
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    worker.emitMessage(ready);
    const pending = client.decideFast(input);
    worker.emitMessage(fastResult(1, input.fence));
    const result = await pending;
    const record = {
      seat: 1,
      userId: horse,
      action: 'fold' as const,
      amount: 0,
      timestamp: 1_800_001,
      stage: input.gameState.stage,
    };
    settleHorseExecutionWitness(result.decision.executionWitness, {
      applied: true,
      acceptedActions: [{ record, intended: true }],
    });
    const observation = client.observeCompletedHand({
      generation: 12,
      fence: `${table}:12:99:observe`,
      handKey: `${table}:12`,
      committedHandId: hand,
      bigBlind: 2,
      actions: [
        {
          ...record,
          origin: 'horse_policy',
          publicNode: {
            version: 1,
            status: 'captured',
            actorSeat: 1,
            street: record.stage,
          } as never,
          observationIdentity: {
            version: 1,
            status: 'bound',
            handId: hand,
            observationId: `${hand}:0`,
            actionOrdinal: 0,
            sessionKey: 'a'.repeat(64),
          },
        },
      ],
    });
    expect(result.decision.executionWitness?.committedHand).toEqual({
      status: 'bound',
      committedHandId: hand,
      observationId: `${hand}:0`,
      actionOrdinal: 0,
      sessionKey: 'a'.repeat(64),
    });
    expect(worker.sent[1]).toMatchObject({ type: 'OBSERVE_COMPLETED_HAND', committedHandId: hand });
    worker.emitMessage({
      type: 'ACK',
      requestId: 2,
      generation: 12,
      fence: `${table}:12:99:observe`,
      operation: 'OBSERVE_COMPLETED_HAND',
    });
    await observation;
    const stopped = client.stop();
    worker.emitMessage({ type: 'STOPPED' });
    await stopped;
  });
  it.each([10, 11])(
    'accepts plans only for the original reference wager (final amount %s)',
    async (amount) => {
      const worker = new FakeWorker();
      const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
      worker.emitMessage(ready);
      const input = snapshot('effect-reference');
      input.gameState.stage = 'flop';
      input.fence =
        '33333333-3333-4333-8333-333333333333:1000100:1:44444444-4444-4444-8444-444444444444:7';
      input.gameState.actionHistory = [
        {
          timestamp: 12,
          userId: 'poster',
          stage: 'preflop',
          seat: 2,
          action: 'post_bb',
          amount: 2,
        } as any,
      ];
      input.decisionKey = buildHorseDecisionKey(input);
      const pending = client.decideFast(input);
      void pending.catch(() => undefined);
      const reply = fastResult(1, input.fence);
      const graph = new HorsePolicyGraph(() => 0);
      let value: typeof reply.decision | null = null;
      for (const node of HORSE_POLICY_ORDER)
        value = graph.run(node, value, () => ({
          decision: {
            action: 'bet' as const,
            amount: node === 'reference' ? 10 : amount,
            thinkTime: 0,
          },
        })).decision;
      reply.decision = graph.finish(value!);
      reply.planIssueDisposition = 'issued';
      reply.effects = [
        {
          type: 'plan',
          handKey: 'plan-hand-v1:33333333-3333-4333-8333-333333333333:1000100',
          userId: 'horse-1',
          barrelIntent: true,
        },
      ];
      worker.emitMessage(reply);
      if (amount === 10) {
        expect(await pending).toMatchObject({
          effects: reply.effects,
          decision: { action: 'bet', amount: 10 },
        });
        const stopping = client.stop();
        worker.emitMessage({ type: 'STOPPED' });
        await stopping;
      } else {
        expect(client.status().phase).toBe('failed');
        await expect(pending).rejects.toThrow('invalid decision effects');
      }
    }
  );
  it.each([
    'other_horse',
    'other_hand',
    'other_street',
    'missing',
    'malformed',
    'brain_fallback',
  ] as const)(
    'refuses speculative effects with %s provenance before table execution',
    async (fault) => {
      const worker = new FakeWorker();
      const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
      worker.emitMessage(ready);
      const input = snapshot('effect-owner');
      input.gameState.stage = 'flop';
      input.fence =
        '33333333-3333-4333-8333-333333333333:1000100:1:44444444-4444-4444-8444-444444444444:7';
      input.gameState.actionHistory = [
        {
          timestamp: 12,
          userId: 'poster',
          stage: 'preflop',
          seat: 2,
          action: 'post_bb',
          amount: 2,
        } as any,
      ];
      input.decisionKey = buildHorseDecisionKey(input);
      const pending = client.decideFast(input);
      void pending.catch(() => undefined);
      const reply = fastResult(1, input.fence);
      const originGraph = new HorsePolicyGraph(() => 0);
      let originDecision: typeof reply.decision | null = null;
      for (const node of HORSE_POLICY_ORDER)
        originDecision = originGraph.run(node, originDecision, () => ({
          decision: { action: 'bet' as const, amount: 10, thinkTime: 0 },
        })).decision;
      reply.decision = originGraph.finish(originDecision!);
      reply.planIssueDisposition = 'issued';
      reply.effects = [
        {
          type: 'raise_plan',
          handKey: 'plan-hand-v1:33333333-3333-4333-8333-333333333333:1000100',
          userId: 'horse-1',
          street: 'flop',
          plan: 'callOnce',
        },
      ];
      if (fault === 'other_horse') reply.effects[0].userId = 'horse-2';
      if (fault === 'other_hand') reply.effects[0].handKey = '13:poster';
      if (fault === 'other_street') (reply.effects[0] as any).street = 'turn';
      if (fault === 'missing') reply.effects = undefined as any;
      if (fault === 'malformed') reply.effects.push(null as any);
      if (fault === 'brain_fallback') reply.decision.policyFallback = 'brain_exception';
      worker.emitMessage(reply);
      expect(client.status().phase).toBe('failed');
      await expect(pending).rejects.toThrow('invalid decision effects');
      expect(client.status().completedJobs).toBe(0);
    }
  );
  it.each([null, undefined, 3, 'FAST_RESULT', [], {}])(
    'contains a malformed response envelope: %j',
    async (message) => {
      const worker = new FakeWorker();
      const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
      worker.emitMessage(ready);
      const pending = client.decideFast(snapshot('bad-envelope'));
      void pending.catch(() => undefined);
      expect(() => worker.emitMessage(message as any)).not.toThrow();
      await expect(pending).rejects.toThrow('invalid response envelope');
      expect(client.status()).toMatchObject({ phase: 'failed', completedJobs: 0, queueDepth: 0 });
    }
  );
  it('preserves zero compute time, full uint32 states and stale but valid governor readings', async () => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    worker.emitMessage({
      ...ready,
      governor: {
        ...ready.governor,
        enabled: false,
        stale: true,
        scale: 1,
        sampledAt: 0,
        p50Ms: 0,
        p99Ms: 0,
        timerLateMs: 0,
        throttledForS: 0,
      },
    });
    const pending = client.decideFast(snapshot('valid-boundaries'));
    worker.emitMessage({
      ...fastResult(1, 'valid-boundaries'),
      rngBefore: 0,
      rngAfter: 0xffffffff,
      computeMs: 0,
      governorScale: 1,
    });
    expect(await pending).toMatchObject({ rngBefore: 0, rngAfter: 0xffffffff, computeMs: 0 });
    expect(client.status()).toMatchObject({
      phase: 'ready',
      completedJobs: 1,
      governor: { stale: true, enabled: false, scale: 1 },
    });
    const stopping = client.stop();
    worker.emitMessage({ type: 'STOPPED' });
    await stopping;
  });
  it.each(['fast', 'deep', 'discard'] as const)(
    'rejects invalid %s compute metadata before recording completion',
    async (lane) => {
      for (const [key, bad] of [
        ['computeMs', NaN],
        ['computeMs', Infinity],
        ['computeMs', -1],
        ['governorScale', NaN],
        ['governorScale', 0],
        ['governorScale', 1.01],
      ] as const) {
        const worker = new FakeWorker();
        const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
        worker.emitMessage(ready);
        const input = snapshot('bad-metadata');
        const pending =
          lane === 'fast'
            ? client.decideFast(input)
            : lane === 'deep'
              ? client.decideDeep({ ...input, rngBefore: 11, deepEquity: 6 })
              : client.decideDiscard({
                  ...input,
                  cards: [],
                  communityCards: [],
                  gameVariant: 'pineapple',
                });
        void pending.catch(() => undefined);
        const reply: any =
          lane === 'discard'
            ? {
                type: 'DISCARD_RESULT',
                requestId: 1,
                generation: 7,
                fence: input.fence,
                cardIndex: 1,
                computeMs: 4,
                governorScale: 0.35,
              }
            : {
                ...fastResult(1, input.fence),
                type: lane === 'fast' ? 'FAST_RESULT' : 'DEEP_RESULT',
              };
        reply[key] = bad;
        worker.emitMessage(reply);
        expect(client.status().phase, `${lane}:${key}:${bad}`).toBe('failed');
        await expect(pending).rejects.toThrow('invalid compute metadata');
        expect(client.status().completedJobs).toBe(0);
        expect(worker.terminateCalls).toBe(1);
      }
    }
  );
  it.each(['rngBefore', 'rngAfter'] as const)(
    'rejects an invalid %s before a fast result reaches the table',
    async (key) => {
      for (const bad of [-1, 0.5, 4294967296, NaN, undefined]) {
        const worker = new FakeWorker();
        const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
        worker.emitMessage(ready);
        const pending = client.decideFast(snapshot('bad-rng'));
        void pending.catch(() => undefined);
        const reply: any = fastResult(1, 'bad-rng');
        reply[key] = bad;
        worker.emitMessage(reply);
        expect(client.status().phase).toBe('failed');
        await expect(pending).rejects.toThrow('invalid sampling state');
      }
    }
  );
  it.each([-1, 3, 0.5, NaN, undefined])(
    'rejects discard index %s at the client boundary',
    async (cardIndex) => {
      const worker = new FakeWorker();
      const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
      worker.emitMessage(ready);
      const pending = client.decideDiscard({
        generation: 7,
        fence: 'discard',
        cards: [],
        communityCards: [],
        gameVariant: 'pineapple',
      });
      void pending.catch(() => undefined);
      worker.emitMessage({
        type: 'DISCARD_RESULT',
        requestId: 1,
        generation: 7,
        fence: 'discard',
        cardIndex,
        computeMs: 0,
        governorScale: 1,
      } as any);
      expect(client.status().phase).toBe('failed');
      await expect(pending).rejects.toThrow('invalid discard index');
    }
  );
  it('rejects the active status promise before removing corrupt status from the queue', async () => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    worker.emitMessage(ready);
    const pending: Promise<unknown> = (client as any).enqueue(
      { type: 'STATUS', requestId: 1, generation: 0, fence: 'worker:status' },
      'STATUS_RESULT'
    );
    let terminal = 'pending';
    void pending.then(
      () => {
        terminal = 'resolved';
      },
      () => {
        terminal = 'rejected';
      }
    );
    worker.emitMessage({
      ...ready,
      type: 'STATUS_RESULT',
      requestId: 1,
      generation: 0,
      fence: 'worker:status',
      solverStores: { ...ready.solverStores, postflopV31Dataset: null },
    });
    await Promise.resolve();
    expect(client.status().phase).toBe('failed');
    expect(terminal).toBe('rejected');
    expect(client.status().completedJobs).toBe(0);
  });
  it.each(['ready', 'status'] as const)('refuses corrupt governor fields in %s', async (kind) => {
    for (const [key, bad] of [
      ['scale', NaN],
      ['scale', 0],
      ['p99Ms', -1],
      ['p50Ms', Infinity],
      ['sampledAt', NaN],
      ['throttledForS', -1],
      ['timerLateMs', -1],
      ['stale', undefined],
      ['enabled', 'true'],
    ] as const) {
      const worker = new FakeWorker();
      const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
      let pending: Promise<unknown>;
      if (kind === 'ready') pending = client.ready();
      else {
        worker.emitMessage(ready);
        pending = (client as any).enqueue(
          { type: 'STATUS', requestId: 1, generation: 0, fence: 'worker:status' },
          'STATUS_RESULT'
        );
      }
      void pending.catch(() => undefined);
      const message =
        kind === 'ready'
          ? { ...ready }
          : {
              ...ready,
              type: 'STATUS_RESULT',
              requestId: 1,
              generation: 0,
              fence: 'worker:status',
            };
      message.governor = { ...ready.governor, [key]: bad };
      worker.emitMessage(message as any);
      expect(client.status().phase, `${kind}:${key}`).toBe('failed');
      await expect(pending).rejects.toThrow('invalid governor');
    }
  });

  it('rejects internally consistent policy ownership for the wrong request variant', async () => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    worker.emitMessage(ready);
    const input = snapshot('wrong-owner');
    input.gameState.gameVariant = 'plo4';
    const pending = client.decideFast(input);
    void pending.catch(() => undefined);
    const reply = fastResult(1, 'wrong-owner');
    reply.decision.policyOwnership = {
      version: 'horse-policy-ownership-v1',
      variant: 'nlh',
      owner: 'reference',
      packVersion: null,
      mode: 'reference',
      outcome: 'reference',
      reason: null,
    };
    expect(() => worker.emitMessage(reply)).not.toThrow();
    await expect(pending).rejects.toThrow('invalid policy receipt');
    expect(client.status().phase).toBe('failed');
  });
  it('refuses a Phase 7 receipt whose evidence is not bound to the request it answers', async () => {
    // A real, structurally valid utility receipt computed for another table.
    const { hero, state } = jointPolicyFixture('nlh', 1, 'tournament', 'river');
    seedFastRandom(1500921);
    const foreign = structuredClone(
      HorseLogic.decide(
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
      )
    );
    expect(foreign.tournamentUtility?.evidence).toBeDefined();
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    worker.emitMessage(ready);
    const pending = client.decideFast(snapshot('phase7-foreign'));
    void pending.catch(() => undefined);
    const reply = fastResult(1, 'phase7-foreign');
    reply.decision = foreign;
    expect(() => worker.emitMessage(reply)).not.toThrow();
    await expect(pending).rejects.toThrow('invalid policy receipt: phase7_foreign_opponent');
    expect(client.status().phase).toBe('failed');
  });
  it.each(['fast', 'deep'] as const)(
    'rejects malformed %s policy graphs inside the failure boundary',
    async (lane) => {
      const worker = new FakeWorker();
      const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
      worker.emitMessage(ready);
      const input = snapshot('invalid-graph');
      const pending =
        lane === 'fast'
          ? client.decideFast(input)
          : client.decideDeep({ ...input, rngBefore: 11, deepEquity: 6 });
      void pending.catch(() => undefined);
      const reply = fastResult(1, 'invalid-graph');
      reply.decision.policyGraph = { version: 'horse-policy-order-v1', transitions: null } as any;
      expect(() =>
        worker.emitMessage(lane === 'fast' ? reply : { ...reply, type: 'DEEP_RESULT' })
      ).not.toThrow();
      await expect(pending).rejects.toThrow('invalid policy receipt');
      expect(client.status().phase).toBe('failed');
      expect(worker.terminateCalls).toBe(1);
    }
  );
  it.each([
    'discontinuity',
    'wrong_final',
    'private_field',
    'invalid_action',
    'invalid_clock',
  ] as const)('rejects a returned decision with %s', async (fault) => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    worker.emitMessage(ready);
    const pending = client.decideFast(snapshot('invalid-receipt'));
    void pending.catch(() => undefined);
    const reply = fastResult(1, 'invalid-receipt');
    const graph = new HorsePolicyGraph(() => 0);
    for (const node of HORSE_POLICY_ORDER)
      graph.run(node, node === 'reference' ? null : reply.decision, () => ({
        decision: reply.decision,
      }));
    reply.decision = graph.finish(reply.decision);
    if (fault === 'discontinuity')
      reply.decision.policyGraph!.transitions[2].before!.action = 'raise';
    if (fault === 'wrong_final') reply.decision.action = 'check';
    if (fault === 'private_field')
      Object.assign(reply.decision.policyGraph!.transitions[1], { cards: ['private-input'] });
    if (fault === 'invalid_action') reply.decision.action = 'invalid' as any;
    if (fault === 'invalid_clock') reply.decision.thinkTime = NaN;
    expect(() => worker.emitMessage(reply)).not.toThrow();
    await expect(pending).rejects.toThrow('invalid policy receipt');
    expect(client.status().phase).toBe('failed');
  });
  it('keeps the brain failure provenance in the exact private execution witness', async () => {
    const worker = new FakeWorker(),
      client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    worker.emitMessage(ready);
    const pending = client.decideFast(snapshot('brain-exception'));
    const reply = fastResult(1, 'brain-exception');
    reply.decision.policyFallback = 'brain_exception';
    worker.emitMessage(reply);
    const result = await pending;
    expect(result.decision.executionWitness).toMatchObject({
      policyFallback: 'brain_exception',
      identity: { lane: 'fast' },
    });
  });
  it.each([
    null,
    [],
    { action: 'fold', thinkTime: 1, policyFallback: 'unknown' },
    { action: 'fold', thinkTime: 1, policyFallback: true },
  ])(
    'rejects malformed decision provenance without throwing from the message handler: %j',
    async (decision) => {
      const worker = new FakeWorker(),
        client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
      worker.emitMessage(ready);
      const pending = client.decideFast(snapshot('bad-provenance'));
      const rejected = expect(pending).rejects.toThrow('invalid fallback provenance');
      expect(() =>
        worker.emitMessage({ ...fastResult(1, 'bad-provenance'), decision } as any)
      ).not.toThrow();
      await rejected;
      expect(client.status().phase).toBe('failed');
    }
  );

  it.each(['fast', 'deep'] as const)(
    'binds the %s response to its canonical request without copying private inputs',
    async (lane) => {
      const worker = new FakeWorker();
      const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
      worker.emitMessage(ready);
      const input = snapshot('witness');
      const pending =
        lane === 'fast'
          ? client.decideFast(input)
          : client.decideDeep({ ...input, rngBefore: 11, deepEquity: 6 });
      const reply = fastResult(1, 'witness');
      worker.emitMessage(lane === 'fast' ? reply : { ...reply, type: 'DEEP_RESULT' });
      const result = await pending;
      expect(result.decision.executionWitness).toMatchObject({
        identity: {
          decisionKey: input.decisionKey,
          requestId: 1,
          generation: input.generation,
          fence: input.fence,
          decisionTimeMs: input.decisionTimeMs,
          lane,
          variant: 'nlh',
          stage: 'preflop',
        },
        selected: { action: 'fold', amount: null },
        executionStatus: 'pending',
        executedAction: null,
        executedAmount: null,
        retirementReason: null,
        computeMs: 4,
        governorScale: 0.35,
      });
      const encoded = JSON.stringify(result.decision.executionWitness);
      for (const forbidden of ['cards', 'spades', 'horse-1', 'rngBefore', 'rngAfter']) {
        expect(encoded).not.toContain(forbidden);
      }
    }
  );
  it('holds work behind READY and, pinned to a window of one, posts exactly one FIFO job at a time', async () => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({
      workerFactory: () => worker,
      maxInFlight: 1,
    });
    const first = client.decideFast(snapshot('hand-1:seat-1'));
    const second = client.decideFast(snapshot('hand-2:seat-2'));

    expect(worker.sent).toEqual([]);
    worker.emitMessage(ready);
    expect(worker.sent).toHaveLength(1);
    expect(worker.sent[0]).toMatchObject({ type: 'DECIDE_FAST', requestId: 1 });

    worker.emitMessage(fastResult(1, 'hand-1:seat-1'));
    await expect(first).resolves.toMatchObject({ rngBefore: 11, rngAfter: 22 });
    expect(worker.sent).toHaveLength(2);
    expect(worker.sent[1]).toMatchObject({ type: 'DECIDE_FAST', requestId: 2 });

    worker.emitMessage(fastResult(2, 'hand-2:seat-2'));
    await expect(second).resolves.toMatchObject({ fence: 'hand-2:seat-2' });
    expect(client.status()).toMatchObject({ phase: 'ready', queueDepth: 0 });
  });

  it('removes queued aborts and stale-discards an active aborted result', async () => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({
      workerFactory: () => worker,
      maxInFlight: 1,
    });
    worker.emitMessage(ready);

    const activeAbort = new AbortController();
    const queuedAbort = new AbortController();
    const active = client.decideFast(snapshot('active'), activeAbort.signal);
    const queued = client.decideFast(snapshot('queued'), queuedAbort.signal);
    queuedAbort.abort();
    activeAbort.abort();

    await expect(queued).rejects.toBeInstanceOf(HorseDecisionAbortedError);
    await expect(active).rejects.toBeInstanceOf(HorseDecisionAbortedError);
    expect(worker.sent).toEqual([
      expect.objectContaining({ type: 'DECIDE_FAST', requestId: 1 }),
      { type: 'CANCEL', requestId: 1 },
    ]);

    // The synchronous worker may finish before it sees CANCEL. Its result is
    // consumed only to release the lane and can never resolve the stale job.
    const discarded = fastResult(1, 'active');
    worker.emitMessage(discarded);
    expect(discarded.decision.executionWitness).toMatchObject({
      executionStatus: 'not_executed',
      retirementReason: 'caller_settled',
      executedAction: null,
    });
    expect(client.status()).toMatchObject({ phase: 'ready', queueDepth: 0 });
  });

  it('does not respawn and calls onFatal exactly once after terminal failure', async () => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker);
    const onFatal = vi.fn();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: factory, onFatal });
    worker.emitMessage(ready);
    const pending = client.decideFast(snapshot('authority'));

    worker.emitError(new Error('worker core lost'));
    worker.emitExit(9);

    await expect(pending).rejects.toThrow('worker core lost');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(worker.terminateCalls).toBe(1);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledWith(expect.objectContaining({ message: 'worker core lost' }));
    expect(client.status()).toMatchObject({
      phase: 'failed',
      lastError: 'worker core lost',
    });
    await client.stop();
    expect(worker.terminateCalls).toBe(1);
  });

  it('fails closed when the sole worker never reaches READY', async () => {
    const worker = new FakeWorker();
    const onFatal = vi.fn();
    const client = new LiveHorseDecisionWorkerClient({
      workerFactory: () => worker,
      onFatal,
      readyTimeoutMs: 5,
    });

    await expect(client.ready()).rejects.toThrow('READY timed out');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(client.status()).toMatchObject({ phase: 'failed' });
    expect(worker.terminateCalls).toBe(1);
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('rejects a positive V31 store that omits its promoted dataset identity', async () => {
    const worker = new FakeWorker();
    const onFatal = vi.fn();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker, onFatal });

    worker.emitMessage({
      ...ready,
      solverStores: {
        charts: 1,
        postflop: 2,
        postflopV31: 3,
        postflopV31Dataset: null,
      },
    });

    await expect(client.ready()).rejects.toThrow(/invalid solver-store identity/);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(client.status()).toMatchObject({ phase: 'failed' });
    expect(worker.terminateCalls).toBe(1);
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('terminal-fails a posted job that never returns after its full execution budget', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const onFatal = vi.fn();
      const client = new LiveHorseDecisionWorkerClient({
        workerFactory: () => worker,
        onFatal,
        jobTimeoutMs: 5,
      });
      worker.emitMessage(ready);
      const pending = client.decideFast(snapshot('wedged'));
      const rejection = expect(pending).rejects.toBeInstanceOf(HorseDecisionExpiredError);

      await vi.advanceTimersByTimeAsync(5);
      await vi.runOnlyPendingTimersAsync();
      await rejection;
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(client.status()).toMatchObject({
        phase: 'failed',
        activeRequestId: null,
        expiredJobs: 1,
        lastExpiredPhase: 'active',
      });
      expect(worker.terminateCalls).toBe(1);
      expect(onFatal).toHaveBeenCalledTimes(1);
      expect(onFatal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('execution deadline after dispatch'),
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts an on-time worker response already waiting when the execution timer becomes runnable', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const onFatal = vi.fn();
      const client = new LiveHorseDecisionWorkerClient({
        workerFactory: () => worker,
        onFatal,
        jobTimeoutMs: 50,
      });
      worker.emitMessage(ready);
      const pending = client.decideFast(snapshot('deadline-edge'));
      const rejection = expect(pending).rejects.toBeInstanceOf(HorseDecisionExpiredError);

      // Registration order mirrors a timer becoming runnable before a worker
      // message already posted to its port. The caller expires, but the poll
      // turn consumes the valid response before the integrity recheck.
      setTimeout(() => worker.emitMessage(fastResult(1, 'deadline-edge')), 50);
      await vi.advanceTimersByTimeAsync(50);
      await rejection;
      expect(client.status()).toMatchObject({
        phase: 'ready',
        activeRequestId: null,
        completedJobs: 1,
        expiredJobs: 1,
        lastError: null,
      });
      expect(worker.terminateCalls).toBe(0);
      expect(onFatal).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires near-deadline work after dispatch without poisoning the healthy FIFO', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const onFatal = vi.fn();
      const client = new LiveHorseDecisionWorkerClient({
        workerFactory: () => worker,
        onFatal,
        jobTimeoutMs: 50,
      });
      worker.emitMessage(ready);
      const first = client.decideFast(snapshot('first'));
      const nearDeadline = client.decideFast(snapshot('near-deadline'));
      const nearDeadlineRejection =
        expect(nearDeadline).rejects.toBeInstanceOf(HorseDecisionExpiredError);

      await vi.advanceTimersByTimeAsync(49);
      worker.emitMessage(fastResult(1, 'first'));
      await first;
      expect(worker.sent.at(-1)).toMatchObject({ type: 'DECIDE_FAST', requestId: 2 });

      // Request 2 has used its table deadline, but only 1 ms of worker time.
      // It takes the fail-safe action while the sole deterministic worker
      // remains authoritative and drains the already-posted request.
      await vi.advanceTimersByTimeAsync(1);
      await nearDeadlineRejection;
      expect(client.status()).toMatchObject({
        phase: 'ready',
        activeRequestId: 2,
        expiredJobs: 1,
        lastExpiredRequestType: 'DECIDE_FAST',
        lastExpiredPhase: 'active',
        lastError: null,
      });
      expect(worker.sent.at(-1)).toEqual({ type: 'CANCEL', requestId: 2, reason: 'expired' });
      expect(worker.terminateCalls).toBe(0);
      expect(onFatal).not.toHaveBeenCalled();

      const successor = client.decideFast(snapshot('successor'));
      const expired = fastResult(2, 'near-deadline');
      worker.emitMessage(expired);
      expect(expired.decision.executionWitness).toMatchObject({
        executionStatus: 'not_executed',
        retirementReason: 'caller_settled',
        executedAction: null,
      });
      expect(worker.sent.at(-1)).toMatchObject({ type: 'DECIDE_FAST', requestId: 3 });
      worker.emitMessage(fastResult(3, 'successor'));
      await expect(successor).resolves.toMatchObject({ fence: 'successor' });
      expect(client.status()).toMatchObject({
        phase: 'ready',
        queueDepth: 0,
        completedJobs: 3,
        expiredJobs: 1,
      });
      expect(onFatal).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives a near-deadline dispatch its complete worker-integrity window before failing a wedge', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const onFatal = vi.fn();
      const client = new LiveHorseDecisionWorkerClient({
        workerFactory: () => worker,
        onFatal,
        jobTimeoutMs: 50,
      });
      worker.emitMessage(ready);
      const first = client.decideFast(snapshot('first'));
      const wedged = client.decideFast(snapshot('late-wedge'));
      const wedgedRejection = expect(wedged).rejects.toBeInstanceOf(HorseDecisionExpiredError);

      await vi.advanceTimersByTimeAsync(49);
      worker.emitMessage(fastResult(1, 'first'));
      await first;
      expect(client.status()).toMatchObject({ phase: 'ready', activeRequestId: 2 });

      // The caller's original queue-plus-compute budget ends after only 1 ms
      // of execution. That expires the table action, but does not condemn the
      // sole worker before its independently measured 50 ms integrity budget.
      await vi.advanceTimersByTimeAsync(1);
      await wedgedRejection;
      await vi.advanceTimersByTimeAsync(48);
      expect(client.status()).toMatchObject({
        phase: 'ready',
        activeRequestId: 2,
        expiredJobs: 1,
        lastError: null,
      });
      expect(worker.terminateCalls).toBe(0);
      expect(onFatal).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await vi.runOnlyPendingTimersAsync();
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(client.status()).toMatchObject({
        phase: 'failed',
        activeRequestId: null,
        expiredJobs: 1,
      });
      expect(worker.terminateCalls).toBe(1);
      expect(onFatal).toHaveBeenCalledTimes(1);
      expect(onFatal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('execution deadline after dispatch'),
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires queued work against enqueue time without dispatching it or killing a healthy worker', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const onFatal = vi.fn();
      const client = new LiveHorseDecisionWorkerClient({
        workerFactory: () => worker,
        onFatal,
        readyTimeoutMs: 1_000,
        jobTimeoutMs: 50,
      });
      const queued = client.decideFast(snapshot('queued-before-ready'));
      const queuedRejection = expect(queued).rejects.toBeInstanceOf(HorseDecisionExpiredError);

      await vi.advanceTimersByTimeAsync(50);
      await queuedRejection;
      expect(worker.sent).toEqual([]);
      expect(client.status()).toMatchObject({
        phase: 'starting',
        queueDepth: 0,
        expiredJobs: 1,
        lastExpiredPhase: 'queued',
      });
      expect(onFatal).not.toHaveBeenCalled();

      worker.emitMessage(ready);
      const next = client.decideFast(snapshot('after-ready'));
      expect(worker.sent.at(-1)).toMatchObject({ type: 'DECIDE_FAST', requestId: 2 });
      worker.emitMessage(fastResult(2, 'after-ready'));
      await expect(next).resolves.toMatchObject({ fence: 'after-ready' });
      const stopped = client.stop();
      expect(worker.sent.at(-1)).toEqual({ type: 'SHUTDOWN' });
      worker.emitMessage({ type: 'STOPPED' });
      await stopped;
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminal-fails a synchronous postMessage exception without stranding active work', async () => {
    const worker = new FakeWorker();
    const onFatal = vi.fn();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker, onFatal });
    worker.emitMessage(ready);
    worker.throwOnPost = new Error('closed worker port');

    const pending = client.decideFast(snapshot('post-throw'));
    await expect(pending).rejects.toThrow('closed worker port');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(client.status().phase).toBe('failed');
    expect(worker.terminateCalls).toBe(1);
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('posts the exact accepted wager with the commit and refuses a missing or unbound acceptance before post', async () => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    try {
      worker.emitMessage(ready);
      const owned = await transportOnlyCommitFixture(client, worker);
      const exactAcceptance = acceptanceOf(owned);
      const forged = [
        undefined,
        { ...exactAcceptance, action: 'call' },
        { ...exactAcceptance, amount: Number.NaN },
        {
          ...exactAcceptance,
          witness: { requestId: owned.requestId + 1, decisionKey: owned.planBinding.decisionKey },
        },
        { ...exactAcceptance, witness: { requestId: owned.requestId, decisionKey: 'other' } },
        { ...exactAcceptance, extra: true },
      ];
      for (const acceptance of forged)
        await expect(client.commitDecisionEffects(owned, acceptance as never)).rejects.toThrow(
          'exact acceptance'
        );
      expect(worker.sent.filter((m: any) => m.type === 'COMMIT_DECISION_EFFECTS')).toHaveLength(0);
      const commit = client.commitDecisionEffects(owned, exactAcceptance);
      expect(worker.sent.at(-1)).toMatchObject({
        type: 'COMMIT_DECISION_EFFECTS',
        planBinding: owned.planBinding,
        acceptance: {
          version: 'horse-plan-acceptance-v1',
          action: 'bet',
          amount: 10,
          witness: { requestId: owned.requestId, decisionKey: owned.planBinding.decisionKey },
        },
      });
      worker.emitMessage({
        type: 'ACK',
        requestId: (worker.sent.at(-1) as any).requestId,
        generation: owned.generation,
        fence: owned.fence,
        operation: 'COMMIT_DECISION_EFFECTS',
        planDisposition: 'applied_volatile',
      });
      await expect(commit).resolves.toMatchObject({ planDisposition: 'applied_volatile' });
    } finally {
      const stopping = client.stop();
      worker.emitMessage({ type: 'STOPPED' });
      await stopping;
    }
  });

  it('keeps an expired commit unknown and retires only after its late exact ACK, without replay', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({
      workerFactory: () => worker,
      maxInFlight: 1,
      jobTimeoutMs: 10,
    });
    try {
      worker.emitMessage(ready);
      const owned = await transportOnlyCommitFixture(client, worker);
      const commit = client.commitDecisionEffects(owned, acceptanceOf(owned));
      const rejected = expect(commit).rejects.toBeInstanceOf(HorseDecisionExpiredError);
      vi.advanceTimersByTime(10);
      await rejected;
      expect(worker.sent.filter((m: any) => m.type === 'COMMIT_DECISION_EFFECTS')).toHaveLength(1);
      expect(worker.sent.filter((m: any) => m.type === 'RETIRE_DECISION_EFFECTS')).toHaveLength(0);
      worker.emitMessage({
        type: 'ACK',
        requestId: 2,
        generation: owned.generation,
        fence: owned.fence,
        operation: 'COMMIT_DECISION_EFFECTS',
        planDisposition: 'applied_volatile',
      });
      expect(worker.sent.at(-1)).toMatchObject({
        type: 'RETIRE_DECISION_EFFECTS',
        requestId: 3,
        planBinding: owned.planBinding,
      });
      worker.emitMessage({
        type: 'ACK',
        requestId: 3,
        generation: owned.generation,
        fence: owned.fence,
        operation: 'RETIRE_DECISION_EFFECTS',
        planDisposition: 'already_applied_volatile',
      });
      await expect(client.commitDecisionEffects(owned, acceptanceOf(owned))).rejects.toThrow(
        'no available client ownership'
      );
      expect(client.status().phase).toBe('ready');
      expect(worker.sent.filter((m: any) => m.type === 'COMMIT_DECISION_EFFECTS')).toHaveLength(1);
    } finally {
      const stopping = client.stop();
      worker.emitMessage({ type: 'STOPPED' });
      await stopping;
      vi.useRealTimers();
    }
  });

  it('orders an accepted action effect after older work and before synchronous successors', async () => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({
      workerFactory: () => worker,
      maxInFlight: 1,
    });
    worker.emitMessage(ready);
    const owned = await transportOnlyCommitFixture(client, worker);
    const active = client.decideFast(snapshot('active'));
    const older = client.decideFast(snapshot('older'));
    let successor!: ReturnType<typeof client.decideFast>;
    let committed!: ReturnType<typeof client.commitDecisionEffects>;

    client.runWithDispatchBarrier(() => {
      successor = client.decideFast(snapshot('successor'));
      committed = client.commitDecisionEffects(owned, acceptanceOf(owned));
    });

    worker.emitMessage(fastResult(2, 'active'));
    await active;
    expect(worker.sent.at(-1)).toMatchObject({ type: 'DECIDE_FAST', requestId: 3 });
    worker.emitMessage(fastResult(3, 'older'));
    await older;
    expect(worker.sent.at(-1)).toMatchObject({
      type: 'COMMIT_DECISION_EFFECTS',
      requestId: 5,
      fence: owned.fence,
    });
    worker.emitMessage({
      type: 'ACK',
      requestId: 5,
      generation: 7,
      fence: owned.fence,
      operation: 'COMMIT_DECISION_EFFECTS',
      planDisposition: 'applied_volatile',
    });
    await committed;
    expect(worker.sent.at(-1)).toMatchObject({ type: 'DECIDE_FAST', requestId: 4 });
    worker.emitMessage(fastResult(4, 'successor'));
    await successor;
  });

  describe('the capture lane (2026-09-29, engine c0c986ad: capture_unavailable was queue expiry)', () => {
    // A journal-configured client, because OBSERVE_EXECUTION exists only there.
    const journalClient = (worker: FakeWorker, options: { jobTimeoutMs?: number } = {}) => {
      const prior = process.env.HORSE_DECISION_JOURNAL_DIR;
      process.env.HORSE_DECISION_JOURNAL_DIR = '/synthetic-horse-journal';
      try {
        return new LiveHorseDecisionWorkerClient({
          workerFactory: () => worker,
          maxInFlight: 1,
          ...options,
        });
      } finally {
        if (prior === undefined) delete process.env.HORSE_DECISION_JOURNAL_DIR;
        else process.env.HORSE_DECISION_JOURNAL_DIR = prior;
      }
    };
    const settleFold = (result: FastHorseDecisionResult, input: LiveHorseDecisionSnapshot) =>
      settleHorseExecutionWitness(result.decision.executionWitness, {
        applied: true,
        acceptedActions: [
          {
            record: {
              seat: 1,
              userId: 'horse-1',
              action: 'fold',
              amount: 0,
              stage: input.gameState.stage,
              timestamp: 1000,
            },
            intended: true,
          },
        ],
      });
    const ack = (requestId: number, fence: string, operation: string) =>
      ({ type: 'ACK', requestId, generation: 7, fence, operation }) as const;

    it('posts a finalized execution ahead of every unposted decision, not behind them', async () => {
      const worker = new FakeWorker();
      const client = journalClient(worker);
      worker.emitMessage(ready);
      const first = snapshot('cap-first');
      const firstPending = client.decideFast(first);
      worker.emitMessage(fastResult(1, first.fence));
      const firstResult = await firstPending;
      const active = client.decideFast(snapshot('cap-active')); // 2, posted
      const waitingA = client.decideFast(snapshot('cap-a')); // 3, queued
      const waitingB = client.decideFast(snapshot('cap-b')); // 4, queued
      settleFold(firstResult, first); // 5, the record of a decision already made

      worker.emitMessage(fastResult(2, 'cap-active'));
      await active;
      expect(worker.sent.at(-1)).toMatchObject({ type: 'OBSERVE_EXECUTION', requestId: 5 });
      worker.emitMessage(ack(5, first.fence, 'OBSERVE_EXECUTION'));
      expect(worker.sent.at(-1)).toMatchObject({ type: 'DECIDE_FAST', requestId: 3 });
      worker.emitMessage(fastResult(3, 'cap-a'));
      await waitingA;
      expect(worker.sent.at(-1)).toMatchObject({ type: 'DECIDE_FAST', requestId: 4 });
      worker.emitMessage(fastResult(4, 'cap-b'));
      await waitingB;
    });

    it('keeps capture jobs in their own order and puts a barrier commit where it was', async () => {
      const worker = new FakeWorker();
      const client = journalClient(worker);
      worker.emitMessage(ready);
      const owned = await transportOnlyCommitFixture(client, worker);
      const active = client.decideFast(snapshot('order-active')); // 2, posted
      const older = client.decideFast(snapshot('order-older')); // 3, queued
      const enqueue = (request: object) =>
        (client as any).enqueue(request, 'ACK', undefined, true) as Promise<unknown>;
      void enqueue({ type: 'OBSERVE_EXECUTION', requestId: 100, generation: 7, fence: 'x' });
      let successor!: ReturnType<typeof client.decideFast>;
      let committed!: ReturnType<typeof client.commitDecisionEffects>;
      client.runWithDispatchBarrier(() => {
        successor = client.decideFast(snapshot('order-successor')); // 4
        void enqueue({ type: 'OBSERVE_EXECUTION', requestId: 101, generation: 7, fence: 'x' });
        committed = client.commitDecisionEffects(owned, acceptanceOf(owned)); // 5
      });
      const queued = ((client as any).queue as Array<{ request: { requestId: number } }>).map(
        (job) => job.request.requestId
      );
      // captures 100 and 101 first, in the order they arrived; then the work
      // queued before the barrier (3), the commit (5) and its successor (4).
      expect(queued).toEqual([100, 101, 3, 5, 4]);
      void active;
      void older;
      void successor;
      void committed;
    });

    it('holds the lane to its bound and queues the job past it at the tail', async () => {
      const worker = new FakeWorker();
      const client = journalClient(worker);
      worker.emitMessage(ready);
      void client.decideFast(snapshot('bound-active')); // 1, posted
      void client.decideFast(snapshot('bound-waiting')); // 2, queued
      const enqueue = (requestId: number) =>
        (client as any).enqueue(
          { type: 'OBSERVE_EXECUTION', requestId: requestId + 1000, generation: 7, fence: 'x' },
          'ACK',
          undefined,
          true
        ) as Promise<unknown>;
      for (let i = 0; i <= HORSE_CAPTURE_LANE_MAX_QUEUED; i++)
        void enqueue(i).catch(() => undefined);
      const queued = ((client as any).queue as Array<{ request: { requestId: number } }>).map(
        (job) => job.request.requestId
      );
      expect(queued).toHaveLength(HORSE_CAPTURE_LANE_MAX_QUEUED + 2);
      expect(queued[0]).toBe(1000);
      expect(queued[HORSE_CAPTURE_LANE_MAX_QUEUED - 1]).toBe(
        1000 + HORSE_CAPTURE_LANE_MAX_QUEUED - 1
      );
      expect(queued[HORSE_CAPTURE_LANE_MAX_QUEUED]).toBe(2);
      expect(queued[HORSE_CAPTURE_LANE_MAX_QUEUED + 1]).toBe(1000 + HORSE_CAPTURE_LANE_MAX_QUEUED);
    });

    it('does not expire a finalized execution on the decision deadline while decisions are ahead of the worker', async () => {
      vi.useFakeTimers();
      try {
        const worker = new FakeWorker();
        const client = journalClient(worker, { jobTimeoutMs: 1_000 });
        worker.emitMessage(ready);
        const first = snapshot('exp-first');
        const firstPending = client.decideFast(first);
        worker.emitMessage(fastResult(1, first.fence));
        const firstResult = await firstPending;
        const wait = { deadlineMs: 10_000 };
        const active = client.decideFast(snapshot('exp-active'), undefined, wait); // 2
        const second = client.decideFast(snapshot('exp-second'), undefined, wait); // 3
        settleFold(firstResult, first); // 4

        await vi.advanceTimersByTimeAsync(900);
        worker.emitMessage(fastResult(2, 'exp-active'));
        await active;
        await vi.advanceTimersByTimeAsync(200); // past the 1,000 ms decision deadline
        // On the tail of the FIFO it was 1,100 ms old and expired unposted,
        // which is what counted phase15_journal_capture_unavailable.
        expect(client.status().expiredJobs).toBe(0);
        expect(worker.sent.at(-1)).toMatchObject({ type: 'OBSERVE_EXECUTION', requestId: 4 });
        worker.emitMessage(ack(4, first.fence, 'OBSERVE_EXECUTION'));
        worker.emitMessage(fastResult(3, 'exp-second'));
        await second;
      } finally {
        vi.useRealTimers();
      }
    });

    it('gives the completed-hand observation the observation deadline, not the decision deadline', async () => {
      vi.useFakeTimers();
      try {
        const worker = new FakeWorker();
        const client = journalClient(worker, { jobTimeoutMs: 1_000 });
        worker.emitMessage(ready);
        const wait = { deadlineMs: 10_000 };
        const active = client.decideFast(snapshot('hand-active'), undefined, wait); // 1
        const second = client.decideFast(snapshot('hand-second'), undefined, wait); // 2
        const observed = client.observeCompletedHand({
          generation: 7,
          fence: 'hand-observed',
          handKey: 'hand-key',
          committedHandId: 'hand-id',
          bigBlind: 2,
          actions: [],
        } as never); // 3, behind both

        await vi.advanceTimersByTimeAsync(900);
        worker.emitMessage(fastResult(1, 'hand-active'));
        await active;
        await vi.advanceTimersByTimeAsync(200);
        expect(client.status().expiredJobs).toBe(0);
        worker.emitMessage(fastResult(2, 'hand-second'));
        await second;
        expect(worker.sent.at(-1)).toMatchObject({ type: 'OBSERVE_COMPLETED_HAND', requestId: 3 });
        worker.emitMessage(ack(3, 'hand-observed', 'OBSERVE_COMPLETED_HAND'));
        await observed;
      } finally {
        vi.useRealTimers();
      }
    });

    it('still expires a decision on the decision deadline', async () => {
      vi.useFakeTimers();
      try {
        const worker = new FakeWorker();
        const client = journalClient(worker, { jobTimeoutMs: 1_000 });
        worker.emitMessage(ready);
        const active = client.decideFast(snapshot('dl-active'), undefined, { deadlineMs: 10_000 });
        const waiting = client.decideFast(snapshot('dl-waiting'));
        const rejection = expect(waiting).rejects.toBeInstanceOf(HorseDecisionExpiredError);
        await vi.advanceTimersByTimeAsync(900);
        worker.emitMessage(fastResult(1, 'dl-active'));
        await active;
        await vi.advanceTimersByTimeAsync(200);
        await rejection;
        expect(client.status().expiredJobs).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('refreshes worker-owned governor and solver health after READY', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
      worker.emitMessage(ready);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(worker.sent.at(-1)).toMatchObject({
        type: 'STATUS',
        requestId: 1,
        generation: 0,
        fence: 'worker:status',
      });
      worker.emitMessage({
        type: 'STATUS_RESULT',
        requestId: 1,
        generation: 0,
        fence: 'worker:status',
        solverStores: {
          charts: 11,
          postflop: 12,
          postflopV31: 13,
          postflopV31Dataset: V31_DATASET,
        },
        solverPolicyArtifact: {
          totalPolicies: 14,
        } as HorseDecisionWorkerReady['solverPolicyArtifact'],
        governor: { ...ready.governor, scale: 0.08, sampledAt: 456 },
      });

      expect(client.status()).toMatchObject({
        solverStores: {
          charts: 11,
          postflop: 12,
          postflopV31: 13,
          postflopV31Dataset: V31_DATASET,
        },
        solverPolicyArtifact: { totalPolicies: 14 },
        governor: { scale: 0.08, sampledAt: 456 },
        queueDepth: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminal-fails if a status refresh loses the V31 dataset identity', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const onFatal = vi.fn();
      const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker, onFatal });
      worker.emitMessage(ready);
      await vi.advanceTimersByTimeAsync(1_000);
      const status = worker.sent.at(-1) as { requestId: number };

      worker.emitMessage({
        type: 'STATUS_RESULT',
        requestId: status.requestId,
        generation: 0,
        fence: 'worker:status',
        solverStores: {
          charts: 1,
          postflop: 2,
          postflopV31: 3,
          postflopV31Dataset: null,
        },
        solverPolicyArtifact: ready.solverPolicyArtifact,
        governor: ready.governor,
      });

      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(client.status()).toMatchObject({ phase: 'failed' });
      expect(onFatal).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a mismatched generation or fence as terminal protocol corruption', async () => {
    const worker = new FakeWorker();
    const onFatal = vi.fn();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker, onFatal });
    worker.emitMessage(ready);
    const pending = client.decideFast(snapshot('owned-turn'));

    worker.emitMessage({ ...fastResult(1, 'other-turn'), generation: 8 });

    await expect(pending).rejects.toThrow('mismatched lifecycle fence');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(worker.terminateCalls).toBe(1);
  });

  it('terminal-fails the client when a typed production job returns ERROR', async () => {
    const worker = new FakeWorker();
    const onFatal = vi.fn();
    const client = new LiveHorseDecisionWorkerClient({
      workerFactory: () => worker,
      maxInFlight: 1,
      onFatal,
    });
    worker.emitMessage(ready);
    const active = client.decideFast(snapshot('runtime-error'));
    const queued = client.decideFast(snapshot('must-not-run'));

    worker.emitMessage({
      type: 'ERROR',
      requestId: 1,
      generation: 7,
      fence: 'runtime-error',
      message: 'worker invariant failed',
    });

    await expect(active).rejects.toThrow('worker invariant failed');
    await expect(queued).rejects.toThrow('worker invariant failed');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(client.status()).toMatchObject({ phase: 'failed', queueDepth: 0 });
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(worker.terminateCalls).toBe(1);
    expect(worker.sent).toHaveLength(1);
  });

  it('isolates a recoverable request validation error and keeps FIFO running', async () => {
    const worker = new FakeWorker();
    const onFatal = vi.fn();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker, onFatal });
    worker.emitMessage(ready);
    const active = client.decideFast(snapshot('invalid-snapshot'));
    const queued = client.decideFast(snapshot('healthy-successor'));

    worker.emitMessage({
      type: 'ERROR',
      requestId: 1,
      generation: 7,
      fence: 'invalid-snapshot',
      message: 'horse state hero card count does not match variant/street rules',
      recoverable: true,
    });

    await expect(active).rejects.toThrow(
      'horse state hero card count does not match variant/street rules'
    );
    expect(worker.sent.at(-1)).toMatchObject({ type: 'DECIDE_FAST', requestId: 2 });
    expect(client.status()).toMatchObject({
      phase: 'ready',
      queueDepth: 1,
      recoverableRequestErrors: 1,
      lastRecoverableRequestErrorType: 'DECIDE_FAST',
      lastRecoverableRequestError:
        'horse state hero card count does not match variant/street rules',
      lastError: null,
    });
    worker.emitMessage(fastResult(2, 'healthy-successor'));
    await expect(queued).resolves.toMatchObject({ type: 'FAST_RESULT', requestId: 2 });
    expect(client.status()).toMatchObject({ phase: 'ready', queueDepth: 0, completedJobs: 1 });
    expect(onFatal).not.toHaveBeenCalled();
    expect(worker.terminateCalls).toBe(0);
  });

  it('terminal-fails an ACK that certifies the wrong durable operation', async () => {
    const worker = new FakeWorker();
    const onFatal = vi.fn();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker, onFatal });
    worker.emitMessage(ready);
    const observation = client.observeCompletedHand({
      generation: 7,
      fence: 'observe-hand',
      handKey: 'table:hand',
      actions: [],
      bigBlind: 2,
    });

    worker.emitMessage({
      type: 'ACK',
      requestId: 1,
      generation: 7,
      fence: 'observe-hand',
      operation: 'COMMIT_DECISION_EFFECTS',
    });

    await expect(observation).rejects.toThrow('ACK operation mismatch');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(client.status().phase).toBe('failed');
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(worker.terminateCalls).toBe(1);
  });

  it('keeps an accepted hand observation ahead of the table next decision', async () => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({
      workerFactory: () => worker,
      maxInFlight: 1,
    });
    worker.emitMessage(ready);
    const observation = client.observeCompletedHand({
      generation: 7,
      fence: 'observe-hand',
      handKey: 'table:hand',
      actions: [],
      bigBlind: 2,
    });
    const nextDecision = client.decideFast(snapshot('next-hand'));

    expect(worker.sent).toHaveLength(1);
    expect(worker.sent[0]).toMatchObject({ type: 'OBSERVE_COMPLETED_HAND', requestId: 1 });
    worker.emitMessage({
      type: 'ACK',
      requestId: 1,
      generation: 7,
      fence: 'observe-hand',
      operation: 'OBSERVE_COMPLETED_HAND',
    });
    await observation;

    expect(worker.sent).toHaveLength(2);
    expect(worker.sent[1]).toMatchObject({ type: 'DECIDE_FAST', requestId: 2 });
    worker.emitMessage(fastResult(2, 'next-hand'));
    await nextDecision;
  });

  it('P14.2: posts the private accepted roster unchanged with the completed-hand observation', async () => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    worker.emitMessage(ready);
    const table = '10000000-0000-4000-8000-000000000001';
    const committed = '30000000-0000-4000-8000-000000000001';
    const transport = doorRosterTransport(table, 7, committed);
    const observation = client.observeCompletedHand({
      generation: 7,
      fence: `${table}:7:9:observe`,
      handKey: `${table}:7`,
      committedHandId: committed,
      actions: [],
      bigBlind: 2,
      acceptedActorRoster: transport,
    });
    expect(worker.sent[0]).toMatchObject({ type: 'OBSERVE_COMPLETED_HAND', requestId: 1 });
    expect((worker.sent[0] as { acceptedActorRoster?: unknown }).acceptedActorRoster).toEqual(
      transport
    );
    worker.emitMessage({
      type: 'ACK',
      requestId: 1,
      generation: 7,
      fence: `${table}:7:9:observe`,
      operation: 'OBSERVE_COMPLETED_HAND',
    });
    await observation;
  });

  it('drains accepted jobs before graceful service shutdown', async () => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({
      workerFactory: () => worker,
      maxInFlight: 1,
    });
    worker.emitMessage(ready);
    const first = client.decideFast(snapshot('first'));
    const second = client.decideFast(snapshot('second'));
    const stopped = client.stop();

    expect(client.status().phase).toBe('stopping');
    expect(worker.sent).toHaveLength(1);
    worker.emitMessage(fastResult(1, 'first'));
    await first;
    expect(worker.sent[1]).toMatchObject({ type: 'DECIDE_FAST', requestId: 2 });
    worker.emitMessage(fastResult(2, 'second'));
    await second;
    expect(worker.sent[2]).toEqual({ type: 'SHUTDOWN' });

    worker.emitMessage({ type: 'STOPPED' });
    // Node can emit this before terminate() settles; STOPPED already proves
    // it is the expected graceful exit.
    worker.emitExit(0);
    await stopped;
    expect(worker.terminateCalls).toBe(1);
    expect(client.status().phase).toBe('stopped');
  });

  it('cancels a never-ready startup instead of crossing the process shutdown deadline', async () => {
    const worker = new FakeWorker();
    const onFatal = vi.fn();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker, onFatal });
    const accepted = client.decideFast(snapshot('boot-queued'));
    const readiness = client.ready();
    const stopped = client.stop();

    expect(worker.sent).toEqual([]);
    expect(client.status()).toMatchObject({ phase: 'stopping', activeRequestId: null });
    worker.throwOnPost = new Error('worker port already closed');
    worker.emitMessage(ready);
    worker.emitError(new Error('late termination error'));
    worker.emitExit(1);
    await expect(accepted).rejects.toBeInstanceOf(HorseDecisionAbortedError);
    await expect(readiness).rejects.toBeInstanceOf(HorseDecisionAbortedError);
    await stopped;
    expect(worker.terminateCalls).toBe(1);
    expect(worker.sent).toEqual([]);
    expect(onFatal).not.toHaveBeenCalled();
    expect(client.status()).toMatchObject({ phase: 'stopped', queueDepth: 0 });
  });
});

/*
 * Production keeps a window of posted jobs (client.ts, "ONE LANE, NOT ONE
 * MESSAGE AT A TIME"). The tests above pin a window of one where they prove an
 * exact wire sequence; these prove the same guarantees with a real window.
 */
describe('LiveHorseDecisionWorkerClient pipelined lane', () => {
  const requestIds = (worker: FakeWorker) =>
    worker.sent.map((message) => (message as { requestId?: number }).requestId ?? null);

  it('the default window is deep enough to decouple the lane from the main loop', () => {
    // THE DEPTH IS THE LANE'S THROUGHPUT (2026-09-11, evening). Every job pays
    // a round trip through the MAIN event loop, so the lane finishes about
    // `maxInFlight / mainLoopRoundTrip` jobs a second. Measured on engine-01
    // with 470 tables dealing: main loop p50 309 ms, the decision worker's own
    // loop 22 ms, the queue 520 deep with its head pinned at the 8-second
    // caller deadline, ~49 decisions a second EXPIRING into a blind check or
    // fold, 13,973 of them in total. Four in flight is ~13 jobs a second
    // against that; the worker was never the constraint.
    //
    // This pins the ORDER OF MAGNITUDE, not the exact number - the depth may
    // be retuned - so that nobody quietly returns it to a single-digit window
    // and re-serialises the lane behind a saturated loop.
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => new FakeWorker() });
    expect(client.status().maxInFlight).toBeGreaterThanOrEqual(32);
  });

  it('keeps its whole window posted, refills as each answer lands, and reports both queues', async () => {
    const worker = new FakeWorker();
    // An explicit window of four: the exact wire sequence below is what is
    // being proved, and it is the same proof at any depth.
    const client = new LiveHorseDecisionWorkerClient({
      workerFactory: () => worker,
      maxInFlight: 4,
    });
    const jobs = Array.from({ length: 6 }, (_, index) =>
      client.decideFast(snapshot(`turn-${index + 1}`))
    );

    expect(worker.sent).toEqual([]);
    worker.emitMessage(ready);
    expect(requestIds(worker)).toEqual([1, 2, 3, 4]);
    expect(client.status()).toMatchObject({ queueDepth: 6, inFlightJobs: 4, activeRequestId: 1 });

    worker.emitMessage(fastResult(1, 'turn-1'));
    await expect(jobs[0]).resolves.toMatchObject({ fence: 'turn-1' });
    expect(requestIds(worker)).toEqual([1, 2, 3, 4, 5]);
    expect(client.status()).toMatchObject({ queueDepth: 5, inFlightJobs: 4, activeRequestId: 2 });

    for (const id of [2, 3, 4, 5, 6]) {
      worker.emitMessage(fastResult(id, `turn-${id}`));
      await expect(jobs[id - 1]).resolves.toMatchObject({ fence: `turn-${id}` });
    }
    expect(requestIds(worker)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(client.status()).toMatchObject({
      phase: 'ready',
      queueDepth: 0,
      inFlightJobs: 0,
      activeRequestId: null,
      completedJobs: 6,
    });
  });

  it('treats an answer for any posted job but the oldest as terminal FIFO corruption', async () => {
    const worker = new FakeWorker();
    const onFatal = vi.fn();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker, onFatal });
    worker.emitMessage(ready);
    const first = client.decideFast(snapshot('first'));
    const second = client.decideFast(snapshot('second'));
    expect(requestIds(worker)).toEqual([1, 2]);

    worker.emitMessage(fastResult(2, 'second'));

    await expect(first).rejects.toThrow('broke FIFO: expected 1, received 2');
    await expect(second).rejects.toThrow('broke FIFO: expected 1, received 2');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(worker.terminateCalls).toBe(1);
    expect(client.status()).toMatchObject({ phase: 'failed', queueDepth: 0, inFlightJobs: 0 });
  });

  it('cancels an aborted job that is already posted and keeps its slot until the worker answers', async () => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({
      workerFactory: () => worker,
      maxInFlight: 2,
    });
    worker.emitMessage(ready);
    const head = client.decideFast(snapshot('head'));
    const abort = new AbortController();
    const posted = client.decideFast(snapshot('posted'), abort.signal);
    const waiting = client.decideFast(snapshot('waiting'));
    expect(requestIds(worker)).toEqual([1, 2]);

    abort.abort();
    await expect(posted).rejects.toBeInstanceOf(HorseDecisionAbortedError);
    expect(worker.sent.at(-1)).toEqual({ type: 'CANCEL', requestId: 2 });
    // The cancelled job still owns its slot, so nothing overtakes it on the wire.
    expect(client.status()).toMatchObject({ queueDepth: 3, inFlightJobs: 2, activeRequestId: 1 });

    worker.emitMessage(fastResult(1, 'head'));
    await expect(head).resolves.toMatchObject({ fence: 'head' });
    expect(worker.sent.at(-1)).toMatchObject({ type: 'DECIDE_FAST', requestId: 3 });

    worker.emitMessage({ type: 'CANCELLED', requestId: 2, generation: 7, fence: 'posted' });
    worker.emitMessage(fastResult(3, 'waiting'));
    await expect(waiting).resolves.toMatchObject({ fence: 'waiting' });
    expect(client.status()).toMatchObject({ phase: 'ready', queueDepth: 0, inFlightJobs: 0 });
  });

  it('starts the integrity clock when a posted job reaches the head, not when it was posted', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const onFatal = vi.fn();
      const client = new LiveHorseDecisionWorkerClient({
        workerFactory: () => worker,
        onFatal,
        jobTimeoutMs: 50,
      });
      worker.emitMessage(ready);
      const slow = client.decideFast(snapshot('slow'));
      const behind = client.decideFast(snapshot('behind'));
      const behindExpired = expect(behind).rejects.toBeInstanceOf(HorseDecisionExpiredError);
      expect(requestIds(worker)).toEqual([1, 2]);

      // The head takes 45 ms. 'behind' was posted at 0 ms and only now runs.
      await vi.advanceTimersByTimeAsync(45);
      worker.emitMessage(fastResult(1, 'slow'));
      await slow;
      expect(client.status()).toMatchObject({ phase: 'ready', activeRequestId: 2 });

      // 90 ms after it was posted and 45 ms after it reached the head: the
      // caller's budget is spent, so the table takes its fail-safe action, but
      // a worker that has run it for only 45 ms is not wedged.
      await vi.advanceTimersByTimeAsync(45);
      await behindExpired;
      expect(worker.sent.at(-1)).toEqual({ type: 'CANCEL', requestId: 2, reason: 'expired' });
      expect(onFatal).not.toHaveBeenCalled();
      expect(client.status()).toMatchObject({
        phase: 'ready',
        activeRequestId: 2,
        lastError: null,
      });

      // A full 50 ms at the head with no answer is still a wedge.
      await vi.advanceTimersByTimeAsync(5);
      await vi.runOnlyPendingTimersAsync();
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(client.status()).toMatchObject({ phase: 'failed' });
      expect(onFatal).toHaveBeenCalledTimes(1);
      expect(onFatal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('execution deadline after dispatch'),
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds every post across a dispatch barrier so a priority commit still precedes its successors', async () => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({
      workerFactory: () => worker,
      maxInFlight: 2,
    });
    worker.emitMessage(ready);
    const owned = await transportOnlyCommitFixture(client, worker);
    const running = client.decideFast(snapshot('running'));
    const older = client.decideFast(snapshot('older'));
    const olderStill = client.decideFast(snapshot('older-still'));
    expect(requestIds(worker)).toEqual([1, 2, 3]);
    let successor!: ReturnType<typeof client.decideFast>;
    let committed!: ReturnType<typeof client.commitDecisionEffects>;

    client.runWithDispatchBarrier(() => {
      successor = client.decideFast(snapshot('successor'));
      committed = client.commitDecisionEffects(owned, acceptanceOf(owned));
    });
    expect(requestIds(worker)).toEqual([1, 2, 3]);

    worker.emitMessage(fastResult(2, 'running'));
    await running;
    worker.emitMessage(fastResult(3, 'older'));
    await older;
    // Older work first (4), then the commit (6), then its causal successor (5).
    expect(requestIds(worker)).toEqual([1, 2, 3, 4, 6]);
    worker.emitMessage(fastResult(4, 'older-still'));
    await olderStill;
    expect(requestIds(worker)).toEqual([1, 2, 3, 4, 6, 5]);
    worker.emitMessage({
      type: 'ACK',
      requestId: 6,
      generation: 7,
      fence: owned.fence,
      operation: 'COMMIT_DECISION_EFFECTS',
      planDisposition: 'applied_volatile',
    });
    await committed;
    worker.emitMessage(fastResult(5, 'successor'));
    await successor;
  });

  it('retires a recoverable validation error at the head and keeps the window moving', async () => {
    const worker = new FakeWorker();
    const onFatal = vi.fn();
    const client = new LiveHorseDecisionWorkerClient({
      workerFactory: () => worker,
      onFatal,
      maxInFlight: 2,
    });
    worker.emitMessage(ready);
    const bad = client.decideFast(snapshot('bad'));
    const good = client.decideFast(snapshot('good'));
    const later = client.decideFast(snapshot('later'));

    worker.emitMessage({
      type: 'ERROR',
      requestId: 1,
      generation: 7,
      fence: 'bad',
      message: 'invalid snapshot',
      recoverable: true,
    });
    await expect(bad).rejects.toThrow('invalid snapshot');
    expect(requestIds(worker)).toEqual([1, 2, 3]);
    worker.emitMessage(fastResult(2, 'good'));
    worker.emitMessage(fastResult(3, 'later'));
    await expect(good).resolves.toMatchObject({ fence: 'good' });
    await expect(later).resolves.toMatchObject({ fence: 'later' });
    expect(onFatal).not.toHaveBeenCalled();
    expect(client.status()).toMatchObject({ recoverableRequestErrors: 1, queueDepth: 0 });
  });

  it('drains the posted window and the queue before asking the worker to shut down', async () => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({
      workerFactory: () => worker,
      maxInFlight: 2,
    });
    worker.emitMessage(ready);
    const jobs = ['a', 'b', 'c'].map((fence) => client.decideFast(snapshot(fence)));
    const stopped = client.stop();
    expect(requestIds(worker)).toEqual([1, 2]);

    worker.emitMessage(fastResult(1, 'a'));
    await jobs[0];
    expect(requestIds(worker)).toEqual([1, 2, 3]);
    worker.emitMessage(fastResult(2, 'b'));
    await jobs[1];
    expect(worker.sent).toHaveLength(3);
    worker.emitMessage(fastResult(3, 'c'));
    await jobs[2];
    expect(worker.sent.at(-1)).toEqual({ type: 'SHUTDOWN' });

    worker.emitMessage({ type: 'STOPPED' });
    worker.emitExit(0);
    await stopped;
    expect(client.status().phase).toBe('stopped');
  });
});

describe('/health shows the journal the Horse worker owns, not an empty main-thread copy', () => {
  // 2026-09-25/26: the publisher failed at 19:34:05 UTC inside the Horse
  // decision worker, and /health, served by the main thread, kept answering
  // `starting` with every figure null for seven hours: the main thread's copy
  // of the module never had a publisher. The worker's STATUS reply now carries
  // the journal's own report across the thread boundary.
  it('relays the worker journal report from STATUS_RESULT to horseDecisionJournalHealth', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HORSE_DECISION_JOURNAL_DIR', '/unused-fixture-horse-journal');
    try {
      const worker = new FakeWorker();
      const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
      worker.emitMessage(ready);
      const reply = (horseJournal: unknown) => {
        const status = worker.sent.at(-1) as { requestId: number };
        worker.emitMessage({
          type: 'STATUS_RESULT',
          requestId: status.requestId,
          generation: 0,
          fence: 'worker:status',
          solverStores: ready.solverStores,
          solverPolicyArtifact: ready.solverPolicyArtifact,
          governor: ready.governor,
          horseJournal,
        });
      };
      const journal = {
        mode: 'failed',
        lastFailureReason: 'ack_mismatch',
        pausedReason: null,
        pausedSince: null,
        failedSince: '2026-09-25T19:34:05.000Z',
        queued: 64,
        appliedMaxCatalogBytes: 6 * 1024 * 1024 * 1024,
        maxCatalogBytes: 6 * 1024 * 1024 * 1024,
        catalogBytes: 5_000_000_000,
        pendingSegments: 0,
        records: 7_999_990,
        maxRecords: 8_000_000,
        maxRowid: 7_999_990,
        statsAgeMs: 1_000,
        reportAgeMs: null,
      };
      await vi.advanceTimersByTimeAsync(1_000);
      reply(journal);
      expect(horseDecisionJournalHealth()).toMatchObject({
        ...journal,
        statsAgeMs: expect.any(Number),
        reportAgeMs: expect.any(Number),
      });
      await vi.advanceTimersByTimeAsync(1_000);
      reply({
        ...journal,
        mode: 'paused',
        lastFailureReason: null,
        failedSince: null,
        pausedReason: 'archive_segments',
        pausedSince: '2026-09-25T19:34:05.000Z',
      });
      expect(horseDecisionJournalHealth()).toMatchObject({
        mode: 'paused',
        pausedReason: 'archive_segments',
        records: 7_999_990,
      });
      // A malformed journal report is a diagnostics gap, never a worker failure.
      await vi.advanceTimersByTimeAsync(1_000);
      reply({ mode: 'bogus' });
      expect(client.status().phase).toBe('ready');
      expect(horseDecisionJournalHealth()).toMatchObject({ mode: 'paused' });
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });
});

describe('Phase 8.3 qualified authority at the client boundary', () => {
  let approval = 100;
  function lane() {
    approval += 1;
    phase8Main.admission = qualifiedTestAdmission(approval);
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    worker.emitMessage(ready);
    const workerAuthority = new HorseQualifiedAuthorityHolder(`client-test-worker-${approval}`);
    workerAuthority.apply(qualifiedTestAdmission(approval));
    return { worker, client, workerAuthority };
  }
  const candidateLedger = (authority: unknown) => ({
    version: 'horse-tournament-postflop-round2-v1',
    mode: 'candidate',
    eligible: true,
    fired: true,
    completed: true,
    changed: true,
    applied: true,
    selection: 'selected',
    authority,
    authorityVerdict: null,
    reason: 'candidate_changed',
    reasons: [],
    baselineAction: 'call',
    baselineAmount: 4,
    candidateAction: 'fold',
    candidateAmount: null,
    executionStatus: 'pending',
    executedAction: null,
    executedAmount: null,
  });
  function request(client: LiveHorseDecisionWorkerClient, fence: string) {
    const input = snapshot(fence);
    input.decisionKey = buildHorseDecisionKey(input);
    return client.decideFast(input);
  }

  it('binds worker authority to the ledger and witness, and a worker exit restarts it', async () => {
    const { worker, client, workerAuthority } = lane();
    const pending = request(client, 'phase8-fence-1');
    worker.emitMessage({
      ...fastResult(1, 'phase8-fence-1'),
      decision: {
        action: 'fold',
        thinkTime: 1500,
        tournamentPostflop: candidateLedger(workerAuthority.receipt()),
      },
      phase8Authority: workerAuthority.receipt(),
    });
    const result = await pending;
    const ledger = result.decision.tournamentPostflop!;
    expect(ledger.authority).toMatchObject({
      state: 'usable',
      generation: workerAuthority.currentGeneration(),
      mainGeneration: liveHorsePhase8Authority.mainGeneration(),
      continuationVersion: 'horse-tournament-postflop-round2-v1',
    });
    expect(result.decision.executionWitness?.phase8Authority).toMatchObject({
      continuationVersion: 'horse-tournament-postflop-round2-v1',
      mode: 'candidate',
      selection: 'selected',
      verdict: null,
      candidate: { action: 'fold', amount: null },
      reference: { action: 'call', amount: 4 },
      authority: { generation: workerAuthority.currentGeneration() },
    });
    expect(liveHorsePhase8Authority.check(ledger.authority)).toBe('usable');
    worker.emitExit(1);
    expect(liveHorsePhase8Authority.check(ledger.authority)).toBe('restarted');
    void client;
  });

  it('a withdrawal reported by a later result stales already returned work', async () => {
    const { worker, client, workerAuthority } = lane();
    const first = request(client, 'phase8-fence-2');
    worker.emitMessage({
      ...fastResult(1, 'phase8-fence-2'),
      decision: {
        action: 'fold',
        thinkTime: 1500,
        tournamentPostflop: candidateLedger(workerAuthority.receipt()),
      },
      phase8Authority: workerAuthority.receipt(),
    });
    const returned = (await first).decision.tournamentPostflop!;
    expect(liveHorsePhase8Authority.check(returned.authority)).toBe('usable');
    workerAuthority.withdraw('safety_critical_commitment_increase');
    const second = request(client, 'phase8-fence-3');
    worker.emitMessage({
      ...fastResult(2, 'phase8-fence-3'),
      phase8Authority: workerAuthority.receipt(),
    });
    await second;
    expect(liveHorsePhase8Authority.check(returned.authority)).toBe('withdrawn');
    expect(liveHorsePhase8Authority.mainState()).toBe('withdrawn');
  });

  it.each(['missing', 'withdrawn'] as const)(
    'refuses a candidate ledger whose worker authority is %s',
    async (mode) => {
      const { worker, client, workerAuthority } = lane();
      if (mode === 'withdrawn') workerAuthority.withdraw('test');
      const pending = request(client, `phase8-fence-${mode}`);
      worker.emitMessage({
        ...fastResult(1, `phase8-fence-${mode}`),
        decision: {
          action: 'fold',
          thinkTime: 1500,
          tournamentPostflop: candidateLedger(
            mode === 'missing' ? null : workerAuthority.receipt()
          ),
        },
      });
      await expect(pending).rejects.toThrow('invalid policy receipt');
      expect(client.status().phase).toBe('failed');
    }
  );
});

describe('P11.1: a PLO5/PLO6/PLO8 receipt whose input binding fails validation', () => {
  /** A real Phase 11 cash decision from the brain, with its frozen input binding. */
  const variantDecision = (mode: 'shadow' | 'candidate') => {
    // Round 3: a heads-up button hand the reference folds; the candidate
    // opens it at the minimum raise.
    const spot = omahaVariantSpot('plo8', 'preflop', 2);
    spot.hero.cards = variantCards('Kc 7d 9h 9s');
    seedFastRandom(100104);
    return structuredClone(
      HorseLogic.decide(
        spot.hero,
        spot.state,
        'balanced',
        {},
        {
          telemetry: false,
          mind: false,
          decisionTimeMs: 0,
          phase11Omaha: mode,
          phase11EvidenceMode: true,
        }
      )
    );
  };
  const corruptBinding = (decision: ReturnType<typeof variantDecision>) => {
    (decision.omahaVariantPolicy!.inputs!.approximation as { solverInput: unknown }).solverInput =
      true;
    return decision;
  };
  const send = (decision: ReturnType<typeof variantDecision>, fence: string) => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    worker.emitMessage(ready);
    const input = snapshot(fence);
    input.gameState.gameVariant = 'plo8';
    const pending = client.decideFast(input);
    void pending.catch(() => undefined);
    const reply = fastResult(1, fence);
    reply.decision = decision;
    expect(() => worker.emitMessage(reply)).not.toThrow();
    return { worker, client, pending };
  };

  it('drops a shadow-only receipt, keeps the actual action and the worker, and counts it by name', async () => {
    const valid = variantDecision('shadow');
    expect(valid.omahaVariantPolicy).toMatchObject({
      mode: 'shadow',
      applied: false,
      eligible: true,
    });
    expect(valid.policyOwnership).toMatchObject({ owner: 'phase11', mode: 'shadow' });
    expect(horseDecisionReceiptIsValid(structuredClone(valid), 'plo8')).toBe(true);
    const forged = corruptBinding(structuredClone(valid));
    expect(horseDecisionReceiptIsValid(structuredClone(forged), 'plo8')).toBe(false);
    enableBrainTelemetry();
    drainFires();
    const { worker, client, pending } = send(forged, 'p11-1-shadow');
    const result = await pending;
    expect({ action: result.decision.action, amount: result.decision.amount }).toEqual({
      action: valid.action,
      amount: valid.amount,
    });
    expect(result.decision.omahaVariantPolicy).toBeUndefined();
    expect(result.decision.policyOwnership).toBeUndefined();
    expect(result.decision.executionWitness).not.toHaveProperty('phase11Inputs');
    expect(result.decision.executionWitness).toMatchObject({ policyOwnership: null });
    expect(client.status().phase).not.toBe('failed');
    expect(worker.terminateCalls).toBe(0);
    expect(drainFires()).toContainEqual({
      feature: 'phase11_shadow_receipt_binding_dropped',
      fires: 1,
    });
  });

  it('still fails closed for an applied receipt', async () => {
    const applied = variantDecision('candidate');
    expect(applied.omahaVariantPolicy).toMatchObject({ mode: 'candidate', applied: true });
    enableBrainTelemetry();
    drainFires();
    const { worker, client, pending } = send(corruptBinding(applied), 'p11-1-applied');
    await expect(pending).rejects.toThrow('invalid policy receipt');
    expect(client.status().phase).toBe('failed');
    expect(worker.terminateCalls).toBe(1);
    expect(drainFires().map((row) => row.feature)).not.toContain(
      'phase11_shadow_receipt_binding_dropped'
    );
  });
});

describe('P11.3 per-pack authority at the client boundary', () => {
  let approval = 200;
  /** A fresh lane whose PLO8 main gate admits a usable test-fixture authority. */
  function lane() {
    approval += 1;
    phase11Main.admission.plo8 = qualifiedPhase11TestAdmission('plo8', approval);
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    worker.emitMessage(ready);
    // One worker epoch shared by its three pack holders, as workerRuntime builds them.
    const epoch = `client-test-p11-worker-${approval}`;
    const holders = {
      plo5: new HorseQualifiedAuthorityHolder(epoch, OMAHA_VARIANT_PACKS.plo5.version),
      plo6: new HorseQualifiedAuthorityHolder(epoch, OMAHA_VARIANT_PACKS.plo6.version),
      plo8: new HorseQualifiedAuthorityHolder(epoch, OMAHA_VARIANT_PACKS.plo8.version),
    };
    holders.plo8.apply(qualifiedPhase11TestAdmission('plo8', approval));
    const receipts = () => ({
      plo5: holders.plo5.receipt(),
      plo6: holders.plo6.receipt(),
      plo8: holders.plo8.receipt(),
    });
    return { worker, client, holders, receipts };
  }
  /** A real PLO8 cash candidate (the heads-up button open the worker would
   * select; the reference folds the hand). */
  const selectedPlo8 = (authority: unknown) => {
    const spot = omahaVariantSpot('plo8', 'preflop', 2);
    spot.hero.cards = variantCards('Kc 7d 9h 9s');
    seedFastRandom(100104);
    const decision = structuredClone(
      HorseLogic.decide(
        spot.hero,
        spot.state,
        'balanced',
        {},
        {
          telemetry: false,
          mind: false,
          decisionTimeMs: 0,
          phase11Omaha: 'candidate',
          phase11EvidenceMode: true,
        }
      )
    );
    decision.omahaVariantPolicy!.authority = authority as never;
    return decision;
  };
  function request(client: LiveHorseDecisionWorkerClient, fence: string) {
    const input = snapshot(fence);
    input.gameState.gameVariant = 'plo8';
    input.decisionKey = buildHorseDecisionKey(input);
    return client.decideFast(input);
  }

  it('stamps the receipt at its own pack gate, binds the witness, and a worker exit restarts it', async () => {
    const { worker, client, holders, receipts } = lane();
    const pending = request(client, 'p11-3-fence-1');
    const decision = selectedPlo8(holders.plo8.receipt());
    expect(decision.omahaVariantPolicy).toMatchObject({ applied: true, selection: 'selected' });
    worker.emitMessage({
      ...fastResult(1, 'p11-3-fence-1'),
      decision,
      phase11Authority: receipts(),
    });
    const result = await pending;
    const receipt = result.decision.omahaVariantPolicy!;
    const plo8 = liveHorsePhase11Authorities.plo8;
    expect(receipt.authority).toMatchObject({
      state: 'usable',
      generation: holders.plo8.currentGeneration(),
      mainGeneration: plo8.mainGeneration(),
      continuationVersion: OMAHA_VARIANT_PACKS.plo8.version,
    });
    expect(result.decision.executionWitness?.phase11Authority).toMatchObject({
      continuationVersion: OMAHA_VARIANT_PACKS.plo8.version,
      mode: 'candidate',
      selection: 'selected',
      verdict: null,
      candidate: { action: receipt.proposalAction, amount: receipt.proposalAmount },
      reference: { action: receipt.baselineAction, amount: receipt.baselineAmount },
    });
    expect(plo8.check(receipt.authority)).toBe('usable');
    // The PLO5 gate is unselected and refuses the same receipt.
    expect(liveHorsePhase11Authorities.plo5.check(receipt.authority)).toBe('unselected');
    worker.emitExit(1);
    expect(plo8.check(receipt.authority)).toBe('restarted');
    void client;
  });

  it('a PLO8 withdrawal reported by a later result stales already returned PLO8 work', async () => {
    const { worker, client, holders, receipts } = lane();
    const first = request(client, 'p11-3-fence-2');
    worker.emitMessage({
      ...fastResult(1, 'p11-3-fence-2'),
      decision: selectedPlo8(holders.plo8.receipt()),
      phase11Authority: receipts(),
    });
    const returned = (await first).decision.omahaVariantPolicy!;
    const plo8 = liveHorsePhase11Authorities.plo8;
    expect(plo8.check(returned.authority)).toBe('usable');
    holders.plo8.withdraw('controller_fallback_candidate');
    const second = request(client, 'p11-3-fence-3');
    worker.emitMessage({ ...fastResult(2, 'p11-3-fence-3'), phase11Authority: receipts() });
    await second;
    expect(plo8.check(returned.authority)).toBe('withdrawn');
    expect(plo8.mainState()).toBe('withdrawn');
  });

  it.each([
    ['plo6', 'no authority', 'missing_receipt'],
    ['plo6', 'a usable PLO6 worker receipt at an unselected gate', 'unselected'],
    ['plo4', 'no authority', 'mismatched'],
  ] as const)(
    'an effect commit beside an applied %s Phase 11 receipt with %s is refused (%s) and retired',
    async (variant, authorityCase, verdict) => {
      const worker = new FakeWorker();
      const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
      worker.emitMessage(ready);
      phase11Main.admission.plo6 = null;
      liveHorsePhase11Authorities.plo6.refresh();
      const owned = await transportOnlyCommitFixture(client, worker);
      const holder = new HorseQualifiedAuthorityHolder(
        'client-test-p11-commit',
        OMAHA_VARIANT_PACKS.plo6.version
      );
      holder.apply(qualifiedPhase11TestAdmission('plo6'));
      // The receipt as it would stand if an applied candidate reached the commit.
      (owned.decision as { omahaVariantPolicy?: unknown }).omahaVariantPolicy = {
        variant,
        applied: true,
        authority: authorityCase === 'no authority' ? null : holder.receipt(),
      };
      enableBrainTelemetry();
      drainFires();
      await expect(client.commitDecisionEffects(owned, acceptanceOf(owned))).rejects.toThrow(
        `Horse plan commit refused: Phase 11 authority ${verdict}`
      );
      expect(worker.sent.filter((m: any) => m.type === 'COMMIT_DECISION_EFFECTS')).toHaveLength(0);
      expect(worker.sent.at(-1)).toMatchObject({ type: 'RETIRE_DECISION_EFFECTS' });
      expect(drainFires().map((row) => row.feature)).toContain(
        `phase11_authority_effects_${verdict}`
      );
    }
  );

  it.each(['missing', 'withdrawn', 'another pack'] as const)(
    'refuses an applied PLO8 receipt whose worker authority is %s',
    async (mode) => {
      const { worker, client, holders, receipts } = lane();
      if (mode === 'withdrawn') holders.plo8.withdraw('test');
      const authority =
        mode === 'missing'
          ? null
          : mode === 'another pack'
            ? { ...holders.plo8.receipt(), continuationVersion: OMAHA_VARIANT_PACKS.plo5.version }
            : holders.plo8.receipt();
      const pending = request(client, `p11-3-fence-${mode.replace(' ', '-')}`);
      worker.emitMessage({
        ...fastResult(1, `p11-3-fence-${mode.replace(' ', '-')}`),
        decision: selectedPlo8(authority),
        phase11Authority: receipts(),
      });
      await expect(pending).rejects.toThrow('invalid policy receipt');
      expect(client.status().phase).toBe('failed');
    }
  );
});

describe('P12-A: a duplicate or stale Pineapple discard answer at the client boundary', () => {
  const discardRequest = (client: LiveHorseDecisionWorkerClient, fence: string) =>
    client.decideDiscard({
      generation: 7,
      fence,
      cards: [],
      communityCards: [],
      gameVariant: 'pineapple',
    });
  const discardResult = (requestId: number, fence: string, cardIndex = 1) =>
    ({
      type: 'DISCARD_RESULT',
      requestId,
      generation: 7,
      fence,
      cardIndex,
      computeMs: 1,
      governorScale: 1,
    }) as any;

  it('resolves the first answer once and refuses a duplicate of it', async () => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    worker.emitMessage(ready);
    const pending = discardRequest(client, 'p12a-dup');
    worker.emitMessage(discardResult(1, 'p12a-dup', 1));
    await expect(pending).resolves.toMatchObject({ cardIndex: 1 });
    // The same answer again, now with no job that owns it: refused, never
    // delivered a second time.
    worker.emitMessage(discardResult(1, 'p12a-dup', 2));
    expect(client.status().phase).toBe('failed');
    await expect(pending).resolves.toMatchObject({ cardIndex: 1 });
  });

  it('refuses a duplicate answer that would land on the next queued discard', async () => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    worker.emitMessage(ready);
    const first = discardRequest(client, 'p12a-seat-1');
    const second = discardRequest(client, 'p12a-seat-2');
    void second.catch(() => undefined);
    worker.emitMessage(discardResult(1, 'p12a-seat-1', 0));
    await expect(first).resolves.toMatchObject({ cardIndex: 0 });
    worker.emitMessage(discardResult(1, 'p12a-seat-1', 0));
    await expect(second).rejects.toThrow('broke FIFO: expected 2, received 1');
  });

  it("refuses an answer carrying another hand's fence (stale hand)", async () => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    worker.emitMessage(ready);
    const pending = discardRequest(client, 'p12a-hand-2');
    void pending.catch(() => undefined);
    worker.emitMessage(discardResult(1, 'p12a-hand-1'));
    await expect(pending).rejects.toThrow('mismatched lifecycle fence');
  });
});

describe('P12.1: a Short Deck/Pineapple/FLH/FLO8 receipt whose input binding fails validation', () => {
  /** A real Phase 12 cash decision from the brain, with its frozen input binding. */
  const variantDecision = (mode: 'shadow' | 'candidate') => {
    // A FLO8 flop with the nut low and a pair of aces: the candidate raises
    // the canonical fixed amount where the reference calls.
    const spot = remainingVariantSpot('flo8', 'flop', 2);
    seedFastRandom(100105);
    return structuredClone(
      HorseLogic.decide(
        spot.hero,
        spot.state,
        'balanced',
        {},
        {
          telemetry: false,
          mind: false,
          decisionTimeMs: 0,
          phase12Remaining: mode,
          phase12EvidenceMode: true,
        }
      )
    );
  };
  const corruptBinding = (decision: ReturnType<typeof variantDecision>) => {
    (
      decision.remainingVariantPolicy!.inputs!.approximation as { solverInput: unknown }
    ).solverInput = true;
    return decision;
  };
  const send = (decision: ReturnType<typeof variantDecision>, fence: string) => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    worker.emitMessage(ready);
    const input = snapshot(fence);
    input.gameState.gameVariant = 'flo8';
    const pending = client.decideFast(input);
    void pending.catch(() => undefined);
    const reply = fastResult(1, fence);
    reply.decision = decision;
    expect(() => worker.emitMessage(reply)).not.toThrow();
    return { worker, client, pending };
  };

  it('drops a shadow-only receipt, keeps the actual action and the worker, and counts it by name', async () => {
    const valid = variantDecision('shadow');
    expect(valid.remainingVariantPolicy).toMatchObject({
      mode: 'shadow',
      applied: false,
      eligible: true,
    });
    expect(valid.policyOwnership).toMatchObject({ owner: 'phase12', mode: 'shadow' });
    expect(horseDecisionReceiptIsValid(structuredClone(valid), 'flo8')).toBe(true);
    const forged = corruptBinding(structuredClone(valid));
    expect(horseDecisionReceiptIsValid(structuredClone(forged), 'flo8')).toBe(false);
    enableBrainTelemetry();
    drainFires();
    const { worker, client, pending } = send(forged, 'p12-1-shadow');
    const result = await pending;
    expect({ action: result.decision.action, amount: result.decision.amount }).toEqual({
      action: valid.action,
      amount: valid.amount,
    });
    expect(result.decision.remainingVariantPolicy).toBeUndefined();
    expect(result.decision.policyOwnership).toBeUndefined();
    expect(result.decision.executionWitness).not.toHaveProperty('phase12Inputs');
    expect(result.decision.executionWitness).toMatchObject({ policyOwnership: null });
    expect(client.status().phase).not.toBe('failed');
    expect(worker.terminateCalls).toBe(0);
    expect(drainFires()).toContainEqual({
      feature: 'phase12_shadow_receipt_binding_dropped',
      fires: 1,
    });
  });

  it('still fails closed for an applied receipt', async () => {
    const applied = variantDecision('candidate');
    expect(applied.remainingVariantPolicy).toMatchObject({ mode: 'candidate', applied: true });
    enableBrainTelemetry();
    drainFires();
    const { worker, client, pending } = send(corruptBinding(applied), 'p12-1-applied');
    await expect(pending).rejects.toThrow('invalid policy receipt');
    expect(client.status().phase).toBe('failed');
    expect(worker.terminateCalls).toBe(1);
    expect(drainFires().map((row) => row.feature)).not.toContain(
      'phase12_shadow_receipt_binding_dropped'
    );
  });
});

describe('P13.1: a joint multiway receipt whose input binding fails validation', () => {
  /** A real Phase 13 cash bomb-pot decision from the brain, with its binding. */
  const jointDecision = (mode: 'shadow' | 'candidate') => {
    const spot = jointPolicyFixture('nlh', 2, 'cash', 'flop');
    seedFastRandom(130999);
    return structuredClone(
      HorseLogic.decide(
        spot.hero,
        spot.state,
        'balanced',
        {},
        {
          telemetry: false,
          mind: false,
          decisionTimeMs: 0,
          phase13Joint: mode,
          phase13EvidenceMode: true,
        }
      )
    );
  };
  const corruptBinding = (decision: ReturnType<typeof jointDecision>) => {
    (decision.jointPolicy!.inputs!.approximation as { solverInput: unknown }).solverInput = true;
    return decision;
  };
  const send = (decision: ReturnType<typeof jointDecision>, fence: string) => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    worker.emitMessage(ready);
    const input = snapshot(fence);
    input.gameState.gameVariant = 'nlh';
    const pending = client.decideFast(input);
    void pending.catch(() => undefined);
    const reply = fastResult(1, fence);
    reply.decision = decision;
    expect(() => worker.emitMessage(reply)).not.toThrow();
    return { worker, client, pending };
  };

  it('drops a shadow-only receipt, keeps the actual action and the worker, and counts it by name', async () => {
    const valid = jointDecision('shadow');
    expect(valid.jointPolicy).toMatchObject({ mode: 'shadow', applied: false, eligible: true });
    expect(horseDecisionReceiptIsValid(structuredClone(valid), 'nlh')).toBe(true);
    const forged = corruptBinding(structuredClone(valid));
    expect(horseDecisionReceiptIsValid(structuredClone(forged), 'nlh')).toBe(false);
    enableBrainTelemetry();
    drainFires();
    const { worker, client, pending } = send(forged, 'p13-1-shadow');
    const result = await pending;
    expect({ action: result.decision.action, amount: result.decision.amount }).toEqual({
      action: valid.action,
      amount: valid.amount,
    });
    expect(result.decision.jointPolicy).toBeUndefined();
    expect(result.decision.executionWitness).not.toHaveProperty('phase13Inputs');
    expect(client.status().phase).not.toBe('failed');
    expect(worker.terminateCalls).toBe(0);
    expect(drainFires()).toContainEqual({
      feature: 'phase13_shadow_receipt_binding_dropped',
      fires: 1,
    });
  });

  it('commits the valid shadow binding to the execution witness', async () => {
    const valid = jointDecision('shadow');
    const { pending } = send(valid, 'p13-1-valid');
    const result = await pending;
    expect(result.decision.executionWitness?.phase13Inputs).toMatchObject({
      version: 'horse-phase13-input-binding-v1',
      variant: 'nlh',
      rangeStatus: 'consumed',
    });
  });

  it('still fails closed for an applied receipt', async () => {
    const applied = jointDecision('candidate');
    expect(applied.jointPolicy).toMatchObject({ mode: 'candidate', applied: true });
    // P13.3: an applied receipt is well formed only with usable worker
    // authority for its own variant; give it one so only the binding fails.
    const holder = new HorseQualifiedAuthorityHolder(
      'p131-applied',
      horsePhase13ContinuationVersion('nlh')
    );
    holder.apply(qualifiedPhase13TestAdmission('nlh'));
    applied.jointPolicy!.authority = holder.receipt();
    expect(horseDecisionReceiptIsValid(structuredClone(applied), 'nlh')).toBe(true);
    enableBrainTelemetry();
    drainFires();
    const { worker, client, pending } = send(corruptBinding(applied), 'p13-1-applied');
    await expect(pending).rejects.toThrow('invalid policy receipt');
    expect(client.status().phase).toBe('failed');
    expect(worker.terminateCalls).toBe(1);
    expect(drainFires().map((row) => row.feature)).not.toContain(
      'phase13_shadow_receipt_binding_dropped'
    );
  });
});

describe('P10 audit F8: a PLO4 receipt whose input binding fails validation', () => {
  /** A real PLO4 cash decision from the brain, with its frozen input binding. */
  const plo4Decision = (spot: 'non_nut_flush' | 'premium_open', mode: 'shadow' | 'candidate') => {
    const input = plo4ReferenceSpot(spot);
    // Round 3: the heads-up button opens a hand the reference folds.
    if (spot === 'premium_open') input.hero.cards = plo4Cards('2c 7d 3h 8s');
    seedFastRandom(100101);
    return structuredClone(
      HorseLogic.decide(
        input.hero,
        input.state,
        'balanced',
        {},
        // Fixed-work evaluation: the policy reads an injected zero clock, so
        // its 4 ms live work budget cannot turn this fixture into a
        // `work_budget` fallback on a loaded CI runner. The P11.1 and P12.1
        // siblings below build theirs the same way. Without it this test
        // failed inside the required Server Engine check whenever the box was
        // slow (reproduced with a clock that advances 7 ms per read).
        {
          telemetry: false,
          mind: false,
          decisionTimeMs: 0,
          phase10Plo4: mode,
          phase10EvidenceMode: true,
        }
      )
    );
  };
  const corruptBinding = (decision: ReturnType<typeof plo4Decision>) => {
    (decision.plo4Policy!.inputs!.approximation as { solverInput: unknown }).solverInput = true;
    return decision;
  };
  const send = (decision: ReturnType<typeof plo4Decision>, fence: string) => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    worker.emitMessage(ready);
    const input = snapshot(fence);
    input.gameState.gameVariant = 'plo4';
    const pending = client.decideFast(input);
    void pending.catch(() => undefined);
    const reply = fastResult(1, fence);
    reply.decision = decision;
    expect(() => worker.emitMessage(reply)).not.toThrow();
    return { worker, client, pending };
  };

  it('drops a shadow-only receipt, keeps the actual action and the worker, and counts it by name', async () => {
    const valid = plo4Decision('non_nut_flush', 'shadow');
    expect(valid.plo4Policy).toMatchObject({ mode: 'shadow', applied: false, eligible: true });
    expect(valid.policyOwnership).toMatchObject({ owner: 'phase10', mode: 'shadow' });
    expect(horseDecisionReceiptIsValid(structuredClone(valid), 'plo4')).toBe(true);
    const forged = corruptBinding(structuredClone(valid));
    expect(horseDecisionReceiptIsValid(structuredClone(forged), 'plo4')).toBe(false);
    enableBrainTelemetry();
    drainFires();
    const { worker, client, pending } = send(forged, 'p10-f8-shadow');
    const result = await pending;
    expect({ action: result.decision.action, amount: result.decision.amount }).toEqual({
      action: valid.action,
      amount: valid.amount,
    });
    expect(result.decision.plo4Policy).toBeUndefined();
    expect(result.decision.policyOwnership).toBeUndefined();
    expect(result.decision.executionWitness).toMatchObject({
      phase10Inputs: null,
      policyOwnership: null,
    });
    expect(client.status().phase).not.toBe('failed');
    expect(worker.terminateCalls).toBe(0);
    expect(drainFires()).toContainEqual({
      feature: 'phase10_shadow_receipt_binding_dropped',
      fires: 1,
    });
  });

  // The cause of the flake, pinned: a box where every clock read costs 7 ms
  // (far past the 4 ms live budget) must still build the same applied fixture.
  it('builds its applied fixture on an injected clock, so machine load cannot change it', () => {
    const real = performance.now.bind(performance);
    let skew = 0;
    const slow = vi.spyOn(performance, 'now').mockImplementation(() => {
      skew += 7;
      return real() + skew;
    });
    try {
      const applied = plo4Decision('premium_open', 'candidate');
      expect(applied.plo4Policy).toMatchObject({ applied: true, selection: 'selected' });
      expect(applied.plo4Policy!.reason).not.toBe('work_budget');
      expect(slow).toHaveBeenCalled();
    } finally {
      slow.mockRestore();
    }
  });

  it('still fails closed for an applied receipt', async () => {
    const applied = plo4Decision('premium_open', 'candidate');
    expect(applied.plo4Policy).toMatchObject({ applied: true, selection: 'selected' });
    // Usable worker authority, so only the binding below makes it invalid.
    applied.plo4Policy!.authority = {
      version: 'horse-qualified-authority-receipt-v1',
      epoch: 'p10-f8-epoch',
      generation: 1,
      state: 'usable',
      reason: 'admitted',
      continuationVersion: applied.plo4Policy!.version,
      approvalGeneration: 1,
      authorityKey: 'k'.repeat(64),
      evidenceSha256: null,
      sourceSha: null,
      expiresAt: null,
      mainGeneration: null,
    };
    expect(horseDecisionReceiptIsValid(structuredClone(applied), 'plo4')).toBe(true);
    enableBrainTelemetry();
    drainFires();
    const { worker, client, pending } = send(corruptBinding(applied), 'p10-f8-applied');
    await expect(pending).rejects.toThrow('invalid policy receipt');
    expect(client.status().phase).toBe('failed');
    expect(worker.terminateCalls).toBe(1);
    expect(drainFires().map((row) => row.feature)).not.toContain(
      'phase10_shadow_receipt_binding_dropped'
    );
  });
});

describe('P12.3 per-pack authority at the client boundary', () => {
  let approval = 300;
  /** A fresh lane whose FLH main gate admits a usable test-fixture authority. */
  function lane() {
    approval += 1;
    phase12Main.admission.flh = qualifiedPhase12TestAdmission('flh', approval);
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    worker.emitMessage(ready);
    // One worker epoch shared by its four pack holders, as workerRuntime builds them.
    const epoch = `client-test-p12-worker-${approval}`;
    const holders = Object.fromEntries(
      (['short_deck', 'pineapple', 'flh', 'flo8'] as const).map((v) => [
        v,
        new HorseQualifiedAuthorityHolder(epoch, REMAINING_VARIANT_PACKS[v].version),
      ])
    ) as Record<RemainingPolicyVariant, HorseQualifiedAuthorityHolder>;
    holders.flh.apply(qualifiedPhase12TestAdmission('flh', approval));
    const receipts = () => ({
      short_deck: holders.short_deck.receipt(),
      pineapple: holders.pineapple.receipt(),
      flh: holders.flh.receipt(),
      flo8: holders.flo8.receipt(),
    });
    return { worker, client, holders, receipts };
  }
  /** A real FLH cash candidate (a turn value raise the worker would select). */
  const selectedFlh = (authority: unknown) => {
    const spot = remainingVariantSpot('flh', 'turn', 2);
    seedFastRandom(100101);
    const decision = structuredClone(
      HorseLogic.decide(
        spot.hero,
        spot.state,
        'balanced',
        {},
        {
          telemetry: false,
          mind: false,
          decisionTimeMs: 0,
          phase12Remaining: 'candidate',
          phase12EvidenceMode: true,
        }
      )
    );
    decision.remainingVariantPolicy!.authority = authority as never;
    return decision;
  };
  function request(client: LiveHorseDecisionWorkerClient, fence: string) {
    const input = snapshot(fence);
    input.gameState.gameVariant = 'flh';
    input.decisionKey = buildHorseDecisionKey(input);
    return client.decideFast(input);
  }

  it('stamps the receipt at its own pack gate, binds the witness, and a worker exit restarts it', async () => {
    const { worker, client, holders, receipts } = lane();
    const pending = request(client, 'p12-3-fence-1');
    const decision = selectedFlh(holders.flh.receipt());
    expect(decision.remainingVariantPolicy).toMatchObject({ applied: true, selection: 'selected' });
    worker.emitMessage({
      ...fastResult(1, 'p12-3-fence-1'),
      decision,
      phase12Authority: receipts(),
    });
    const result = await pending;
    const receipt = result.decision.remainingVariantPolicy!;
    const flh = liveHorsePhase12Authorities.flh;
    expect(receipt.authority).toMatchObject({
      state: 'usable',
      generation: holders.flh.currentGeneration(),
      mainGeneration: flh.mainGeneration(),
      continuationVersion: REMAINING_VARIANT_PACKS.flh.version,
    });
    expect(result.decision.executionWitness?.phase12Authority).toMatchObject({
      continuationVersion: REMAINING_VARIANT_PACKS.flh.version,
      mode: 'candidate',
      selection: 'selected',
      verdict: null,
      candidate: { action: receipt.proposalAction, amount: receipt.proposalAmount },
      reference: { action: receipt.baselineAction, amount: receipt.baselineAmount },
    });
    expect(result.decision.executionWitness?.phase11Authority).toBeUndefined();
    expect(flh.check(receipt.authority)).toBe('usable');
    // The FLO8 gate is unselected and refuses the same receipt; no Phase 11
    // gate accepts it either, whatever that gate's own state.
    expect(liveHorsePhase12Authorities.flo8.check(receipt.authority)).toBe('unselected');
    expect(liveHorsePhase11Authorities.plo8.check(receipt.authority)).not.toBe('usable');
    worker.emitExit(1);
    expect(flh.check(receipt.authority)).toBe('restarted');
    void client;
  });

  it('an FLH withdrawal reported by a later result stales already returned FLH work', async () => {
    const { worker, client, holders, receipts } = lane();
    const first = request(client, 'p12-3-fence-2');
    worker.emitMessage({
      ...fastResult(1, 'p12-3-fence-2'),
      decision: selectedFlh(holders.flh.receipt()),
      phase12Authority: receipts(),
    });
    const returned = (await first).decision.remainingVariantPolicy!;
    const flh = liveHorsePhase12Authorities.flh;
    expect(flh.check(returned.authority)).toBe('usable');
    holders.flh.withdraw('controller_fallback_candidate');
    const second = request(client, 'p12-3-fence-3');
    worker.emitMessage({ ...fastResult(2, 'p12-3-fence-3'), phase12Authority: receipts() });
    await second;
    expect(flh.check(returned.authority)).toBe('withdrawn');
    expect(flh.mainState()).toBe('withdrawn');
  });

  it.each([
    ['flo8', 'no authority', 'missing_receipt'],
    ['flo8', 'a usable FLO8 worker receipt at an unselected gate', 'unselected'],
    ['plo8', 'no authority', 'mismatched'],
  ] as const)(
    'an effect commit beside an applied %s Phase 12 receipt with %s is refused (%s) and retired',
    async (variant, authorityCase, verdict) => {
      const worker = new FakeWorker();
      const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
      worker.emitMessage(ready);
      phase12Main.admission.flo8 = null;
      liveHorsePhase12Authorities.flo8.refresh();
      const owned = await transportOnlyCommitFixture(client, worker);
      const holder = new HorseQualifiedAuthorityHolder(
        'client-test-p12-commit',
        REMAINING_VARIANT_PACKS.flo8.version
      );
      holder.apply(qualifiedPhase12TestAdmission('flo8'));
      // The receipt as it would stand if an applied candidate reached the commit.
      (owned.decision as { remainingVariantPolicy?: unknown }).remainingVariantPolicy = {
        variant,
        applied: true,
        authority: authorityCase === 'no authority' ? null : holder.receipt(),
      };
      enableBrainTelemetry();
      drainFires();
      await expect(client.commitDecisionEffects(owned, acceptanceOf(owned))).rejects.toThrow(
        `Horse plan commit refused: Phase 12 authority ${verdict}`
      );
      expect(worker.sent.filter((m: any) => m.type === 'COMMIT_DECISION_EFFECTS')).toHaveLength(0);
      expect(worker.sent.at(-1)).toMatchObject({ type: 'RETIRE_DECISION_EFFECTS' });
      expect(drainFires().map((row) => row.feature)).toContain(
        `phase12_authority_effects_${verdict}`
      );
    }
  );

  it.each(['missing', 'withdrawn', 'another pack', 'a Phase 11 pack'] as const)(
    'refuses an applied FLH receipt whose worker authority is %s',
    async (mode) => {
      const { worker, client, holders, receipts } = lane();
      if (mode === 'withdrawn') holders.flh.withdraw('test');
      const authority =
        mode === 'missing'
          ? null
          : mode === 'another pack'
            ? {
                ...holders.flh.receipt(),
                continuationVersion: REMAINING_VARIANT_PACKS.flo8.version,
              }
            : mode === 'a Phase 11 pack'
              ? { ...holders.flh.receipt(), continuationVersion: OMAHA_VARIANT_PACKS.plo8.version }
              : holders.flh.receipt();
      const fence = `p12-3-fence-${mode.replaceAll(' ', '-')}`;
      const pending = request(client, fence);
      worker.emitMessage({
        ...fastResult(1, fence),
        decision: selectedFlh(authority),
        phase12Authority: receipts(),
      });
      await expect(pending).rejects.toThrow('invalid policy receipt');
      expect(client.status().phase).toBe('failed');
    }
  );
});

describe('P13.3 per-variant joint authority at the client boundary', () => {
  let approval = 400;
  /** A fresh lane whose NLH main gate admits a usable test-fixture authority. */
  function lane() {
    approval += 1;
    phase13Main.admission.nlh = qualifiedPhase13TestAdmission('nlh', approval);
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    worker.emitMessage(ready);
    // One worker epoch shared by its nine variant holders, as workerRuntime builds them.
    const epoch = `client-test-p13-worker-${approval}`;
    const holders = Object.fromEntries(
      HORSE_PHASE13_VARIANTS.map((v) => [
        v,
        new HorseQualifiedAuthorityHolder(epoch, horsePhase13ContinuationVersion(v)),
      ])
    ) as Record<JointVariant, HorseQualifiedAuthorityHolder>;
    holders.nlh.apply(qualifiedPhase13TestAdmission('nlh', approval));
    const receipts = () =>
      Object.fromEntries(HORSE_PHASE13_VARIANTS.map((v) => [v, holders[v].receipt()])) as Record<
        JointVariant,
        ReturnType<HorseQualifiedAuthorityHolder['receipt']>
      >;
    return { worker, client, holders, receipts };
  }
  /** A real NLH cash joint candidate (a bomb-pot flop the worker would select). */
  const selectedJoint = (authority: unknown) => {
    const spot = jointPolicyFixture('nlh', 2, 'cash', 'flop');
    seedFastRandom(130999);
    const decision = structuredClone(
      HorseLogic.decide(
        spot.hero,
        spot.state,
        'balanced',
        {},
        {
          telemetry: false,
          mind: false,
          decisionTimeMs: 0,
          phase13Joint: 'candidate',
          phase13EvidenceMode: true,
        }
      )
    );
    decision.jointPolicy!.authority = authority as never;
    return decision;
  };
  function request(client: LiveHorseDecisionWorkerClient, fence: string) {
    const input = snapshot(fence);
    input.gameState.gameVariant = 'nlh';
    input.decisionKey = buildHorseDecisionKey(input);
    return client.decideFast(input);
  }

  it('stamps the receipt at its own variant gate, binds the witness, and a worker exit restarts it', async () => {
    const { worker, client, holders, receipts } = lane();
    const pending = request(client, 'p13-3-fence-1');
    const decision = selectedJoint(holders.nlh.receipt());
    expect(decision.jointPolicy).toMatchObject({ applied: true, selection: 'selected' });
    worker.emitMessage({
      ...fastResult(1, 'p13-3-fence-1'),
      decision,
      phase13Authority: receipts(),
    });
    const result = await pending;
    const receipt = result.decision.jointPolicy!;
    const nlh = liveHorsePhase13Authorities.nlh;
    expect(receipt.authority).toMatchObject({
      state: 'usable',
      generation: holders.nlh.currentGeneration(),
      mainGeneration: nlh.mainGeneration(),
      continuationVersion: horsePhase13ContinuationVersion('nlh'),
    });
    expect(result.decision.executionWitness?.phase13Authority).toMatchObject({
      continuationVersion: receipt.version,
      mode: 'candidate',
      selection: 'selected',
      verdict: null,
      candidate: { action: receipt.proposalAction, amount: receipt.proposalAmount },
      reference: { action: receipt.baselineAction, amount: receipt.baselineAmount },
    });
    expect(result.decision.executionWitness?.phase12Authority).toBeUndefined();
    expect(nlh.check(receipt.authority)).toBe('usable');
    // Every other variant's gate refuses the same receipt, and no Phase 12
    // gate accepts it either.
    for (const other of HORSE_PHASE13_VARIANTS.filter((v) => v !== 'nlh'))
      expect(liveHorsePhase13Authorities[other].check(receipt.authority), other).not.toBe('usable');
    expect(liveHorsePhase12Authorities.flh.check(receipt.authority)).not.toBe('usable');
    worker.emitExit(1);
    expect(nlh.check(receipt.authority)).toBe('restarted');
    void client;
  });

  it('an NLH withdrawal reported by a later result stales already returned NLH work', async () => {
    const { worker, client, holders, receipts } = lane();
    const first = request(client, 'p13-3-fence-2');
    worker.emitMessage({
      ...fastResult(1, 'p13-3-fence-2'),
      decision: selectedJoint(holders.nlh.receipt()),
      phase13Authority: receipts(),
    });
    const returned = (await first).decision.jointPolicy!;
    const nlh = liveHorsePhase13Authorities.nlh;
    expect(nlh.check(returned.authority)).toBe('usable');
    holders.nlh.withdraw('controller_fallback_candidate');
    const second = request(client, 'p13-3-fence-3');
    worker.emitMessage({ ...fastResult(2, 'p13-3-fence-3'), phase13Authority: receipts() });
    await second;
    expect(nlh.check(returned.authority)).toBe('withdrawn');
    expect(nlh.mainState()).toBe('withdrawn');
  });

  it.each([
    ['plo4', 'no authority', 'missing_receipt'],
    ['plo4', 'a usable PLO4 worker receipt at an unselected gate', 'unselected'],
    ['stud', 'no authority', 'mismatched'],
  ] as const)(
    'an effect commit beside an applied %s joint receipt with %s is refused (%s) and retired',
    async (variant, authorityCase, verdict) => {
      const worker = new FakeWorker();
      const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
      worker.emitMessage(ready);
      phase13Main.admission.plo4 = null;
      liveHorsePhase13Authorities.plo4.refresh();
      const owned = await transportOnlyCommitFixture(client, worker);
      const holder = new HorseQualifiedAuthorityHolder(
        'client-test-p13-commit',
        horsePhase13ContinuationVersion('plo4')
      );
      holder.apply(qualifiedPhase13TestAdmission('plo4'));
      (owned.decision as { jointPolicy?: unknown }).jointPolicy = {
        variant,
        applied: true,
        authority: authorityCase === 'no authority' ? null : holder.receipt(),
      };
      enableBrainTelemetry();
      drainFires();
      await expect(client.commitDecisionEffects(owned, acceptanceOf(owned))).rejects.toThrow(
        `Horse plan commit refused: Phase 13 authority ${verdict}`
      );
      expect(worker.sent.filter((m: any) => m.type === 'COMMIT_DECISION_EFFECTS')).toHaveLength(0);
      expect(worker.sent.at(-1)).toMatchObject({ type: 'RETIRE_DECISION_EFFECTS' });
      expect(drainFires().map((row) => row.feature)).toContain(
        `phase13_authority_effects_${verdict}`
      );
    }
  );

  it.each(['missing', 'withdrawn', 'another variant', 'a Phase 12 pack'] as const)(
    'refuses an applied NLH joint receipt whose worker authority is %s',
    async (mode) => {
      const { worker, client, holders, receipts } = lane();
      if (mode === 'withdrawn') holders.nlh.withdraw('test');
      const authority =
        mode === 'missing'
          ? null
          : mode === 'another variant'
            ? {
                ...holders.nlh.receipt(),
                continuationVersion: horsePhase13ContinuationVersion('plo4'),
              }
            : mode === 'a Phase 12 pack'
              ? {
                  ...holders.nlh.receipt(),
                  continuationVersion: REMAINING_VARIANT_PACKS.flh.version,
                }
              : holders.nlh.receipt();
      const fence = `p13-3-fence-${mode.replaceAll(' ', '-')}`;
      const pending = request(client, fence);
      worker.emitMessage({
        ...fastResult(1, fence),
        decision: selectedJoint(authority),
        phase13Authority: receipts(),
      });
      await expect(pending).rejects.toThrow('invalid policy receipt');
      expect(client.status().phase).toBe('failed');
    }
  );
});
