/** The accepted-hand transaction is the sole hand-history persistence owner. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServerTableEngineBase } from '../../engine/ServerTableEngineBase.js';
import type { CompletedHandObservation } from '../../engine/horseDecision/protocol.js';

// ── A minimal chainable PostgREST double ────────────────────────────────────
interface Call {
  table: string;
}

const calls: Call[] = [];
const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
const retentionCalls: Record<string, unknown>[] = [];
/** Ordered replies for the accepted-hand transaction. */
let atomicRpcResults: Array<{ data: unknown; error: unknown }> = [];

vi.mock('./client.js', () => ({
  supabase: {
    from: (table: string) => {
      calls.push({ table });
      throw new Error(`unexpected legacy table write: ${table}`);
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'fn_ca_retain_hand_submission') {
        retentionCalls.push(args.p_request as Record<string, unknown>);
        return {
          data: {
            retained: true,
            submission_id: (args.p_request as any).p_hand_row.id,
            request_hash: 'b'.repeat(64),
          },
          error: null,
        };
      }
      rpcCalls.push({ fn, args });
      if (fn === 'fn_ca_commit_hand_settlement' || fn === 'fn_ca_commit_hand_submission') {
        const result = atomicRpcResults.shift() ?? {
          data: { success: false, reason: 'missing_test_reply' },
          error: null,
        };
        return fn === 'fn_ca_commit_hand_submission' && result.data
          ? {
              ...result,
              data: {
                submission_id: args.p_submission_id,
                submission_hash: 'b'.repeat(64),
                snapshot_completed: true,
                ...(result.data as object),
              },
            }
          : result;
      }
      return { data: null, error: null };
    },
  },
}));

const mockWakeHandProjection = vi.fn(async () => ({
  projected: 0,
  alreadyCompleted: 0,
  deferred: 0,
  failed: 0,
}));
vi.mock('./handProjection.js', () => ({
  wakeHandProjection: () => mockWakeHandProjection(),
}));

const mockReportError = vi.fn();
vi.mock('../errorReporter.js', () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
}));

interface CompletedHandObservationPayload {
  generation: number;
  fence: string;
  handKey: string;
  committedHandId?: string;
  actions: CompletedHandObservation['actions'];
  bigBlind: number;
  showdown: unknown;
  scope: string | null | undefined;
}

const mockObserveCompletedHand = vi.fn(async (observation: CompletedHandObservationPayload) => ({
  type: 'ACK' as const,
  requestId: 1,
  generation: observation.generation,
  fence: observation.fence,
  operation: 'OBSERVE_COMPLETED_HAND' as const,
}));
const mockGetLiveHorseDecisionWorker = vi.fn(() => ({
  observeCompletedHand: mockObserveCompletedHand,
}));
vi.mock('../../engine/horseDecision/index.js', () => ({
  getLiveHorseDecisionWorker: () => mockGetLiveHorseDecisionWorker(),
}));

import { logHandHistory, buildHandHistoryTiers } from './handHistory.js';
import { persistedKnockoutEvidence } from '../../tournament/bountyAttributionGate.js';
import type { HorsePublicActionNode } from '../../engine/HorsePublicActionNode.js';
import { captureHandSeatGenerations } from '../../engine/handSeatGeneration.js';
import { horseCompletedHandKey } from '../../engine/HorseDecisionHandBinding.js';

const GLOBAL_HAND = 1_400_001;
const historyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const leaseGeneration = 'bbbbbbbb-0000-4000-8000-000000000001';

function params(handNumber = GLOBAL_HAND) {
  return {
    tableId: '11111111-1111-1111-1111-111111111111',
    handNumber,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    potSize: 40,
    rakeAmount: 2,
    communityCards: ['As', 'Kd', '7c'],
    winners: [{ userId: 'u1', amount: 38 }],
    players: [
      { userId: 'u1', username: 'A', seat: 1, stack: 100, cards: [] },
      { userId: 'u2', username: 'B', seat: 2, stack: 100, cards: [] },
    ],
    actions: [
      { seat: 1, userId: 'u1', action: 'bet', amount: 20, stage: 'flop' },
      { seat: 2, userId: 'u2', action: 'fold', stage: 'flop' },
    ],
  };
}

const atomicParams = (handNumber = GLOBAL_HAND + 500) => ({
  ...params(handNumber),
  atomicCommit: {
    stacks: [
      { user_id: 'u1', stack: 118, stack_before: 100 },
      { user_id: 'u2', stack: 80, stack_before: 100 },
    ],
    rake: 2,
    bbj: 0,
    ref: `hand:${handNumber}`,
    inflow: 0,
    leaseInstanceId: 'engine-instance-1',
    leaseGeneration,
  },
});

function identityParams() {
  const userId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const publicNode: HorsePublicActionNode = Object.freeze({
    version: 1,
    status: 'captured',
    variant: 'nlh',
    mode: 'cash',
    asset: 'chips',
    chipUnit: 0.01,
    street: 'flop',
    dealerSeat: 2,
    actorSeat: 1,
    smallBlind: 1,
    bigBlind: 2,
    ante: 0,
    anteType: 'per_player',
    allInOrFold: false,
    bombPot: false,
    boardCount: 1,
    boards: Object.freeze(['AsKd7c']),
    pot: 20,
    currentBet: 0,
    toCall: 0,
    structure: 'no_limit',
    minRaiseTo: 2,
    maxRaiseTo: 100,
    fixedBetSize: null,
    wagersCapped: false,
    legalActions: Object.freeze(['fold', 'check', 'bet', 'all_in'] as const),
    seats: Object.freeze([
      Object.freeze([1, 100, 0, 10, 0, 0, 0] as const),
      Object.freeze([2, 100, 0, 10, 0, 0, 0] as const),
    ]),
  });
  return {
    ...atomicParams(),
    handId: historyId,
    seatGenerations: captureHandSeatGenerations([
      {
        user_id: userId,
        seat_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        seat_joined_at: '2026-09-12T10:00:00.123456+00:00',
      },
    ]),
    actions: [
      { seat: 1, userId, stage: 'flop', action: 'rit_board_2:AsKd7c' },
      { seat: 1, userId, stage: 'flop', action: 'check', publicNode, origin: 'forced' as const },
      {
        seat: 1,
        userId,
        stage: 'flop',
        action: 'bet',
        amount: 20,
        publicNode,
        origin: 'player' as const,
      },
    ],
  };
}

const obligationsParams = (handNumber = GLOBAL_HAND + 600) => {
  const input = atomicParams(handNumber);
  const assertLeaseAuthority = vi.fn();
  return {
    ...input,
    handId: historyId,
    atomicCommit: {
      ...input.atomicCommit,
      assertLeaseAuthority,
      acceptedPostCommitFacts: {
        contributions: { u1: 20, u2: 20 },
        returned_uncalled: {},
        insurance: [],
      },
      postCommitObligations: {
        version: 1 as const,
        time_banks: [
          { user_id: 'u1', uses_remaining: 1, seconds_remaining: 25 },
          { user_id: 'u2', uses_remaining: 0, seconds_remaining: 0 },
        ],
        rake: {
          club_id: 'cccccccc-0000-4000-8000-000000000001',
          amount: 2,
          bbj: 0,
          pot: 40,
          num_players: 2,
          contributions: { u1: 20, u2: 20 },
          returned_uncalled: {},
          tournament_id: null,
          method: 'WEIGHTED_CONTRIBUTED',
        },
        bbj_contribution: null,
        promo_playthrough: [
          {
            club_id: 'cccccccc-0000-4000-8000-000000000001',
            user_id: 'u1',
            wagered: 20,
          },
          {
            club_id: 'cccccccc-0000-4000-8000-000000000001',
            user_id: 'u2',
            wagered: 20,
          },
        ],
        insurance: [],
        pending_addons: { enabled: true as const, max_buy_in: 200 },
      },
    },
    assertLeaseAuthority,
  };
};

const acceptAtomicHand = () => {
  atomicRpcResults = [
    {
      data: { success: true, atomic_hand_commit: true, history_id: historyId },
      error: null,
    },
  ];
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  calls.length = 0;
  rpcCalls.length = 0;
  retentionCalls.length = 0;
  atomicRpcResults = [];
  mockReportError.mockReset();
  mockWakeHandProjection.mockClear();
  mockGetLiveHorseDecisionWorker.mockClear();
  mockObserveCompletedHand.mockReset();
  mockObserveCompletedHand.mockImplementation(async (observation) => ({
    type: 'ACK' as const,
    requestId: 1,
    generation: observation.generation,
    fence: observation.fence,
    operation: 'OBSERVE_COMPLETED_HAND' as const,
  }));
});

describe('logHandHistory - worker-owned completed-hand observation', () => {
  it('preserves forced-post and return provenance in the accepted JSON and observation without changing money or order', async () => {
    const input = identityParams();
    const userId = input.actions[1].userId;
    const actions = [
      {
        seat: 1,
        userId,
        action: 'sb',
        amount: 1,
        stage: 'preflop',
        timestamp: 1000,
        dead: false,
        origin: 'forced' as const,
      },
      ...input.actions,
      {
        seat: 1,
        userId,
        action: 'return',
        amount: 10,
        stage: 'flop',
        timestamp: 1002,
        historyEvent: 'uncalled_bet_returned' as const,
      },
    ];
    const before = structuredClone(actions);
    acceptAtomicHand();
    await logHandHistory({ ...input, actions });
    const row = rpcCalls[0].args.p_hand_row as Record<string, unknown>;
    const persisted = row.actions as Array<Record<string, unknown>>;
    expect(persisted[0]).toEqual(actions[0]);
    expect(persisted.at(-1)).toEqual(actions.at(-1));
    expect(persisted.at(-1)).not.toHaveProperty('origin');
    expect(persisted[3].observationIdentity).toMatchObject({
      status: 'bound',
      actionOrdinal: 3,
      observationId: `${historyId}:3`,
    });
    expect(persisted.map(({ action, amount }) => ({ action, amount }))).toEqual(
      actions.map(({ action, amount }) => ({ action, amount }))
    );
    expect(row.pot_size).toBe(input.potSize);
    expect(row.rake_amount).toBe(input.rakeAmount);
    expect(mockObserveCompletedHand.mock.calls[0][0].actions).toEqual(persisted);
    expect(actions).toEqual(before);
  });

  it('preserves action-node metadata in the accepted row and worker payload without adding player cards', async () => {
    acceptAtomicHand();
    const publicNode = Object.freeze({
      version: 1 as const,
      status: 'unavailable' as const,
      reason: 'private_discard_choice' as const,
    });
    const input = atomicParams(GLOBAL_HAND + 810);
    const actions = input.actions.map((action) => ({
      ...action,
      publicNode,
      origin: 'forced' as const,
    }));
    await logHandHistory({ ...input, actions });
    const persisted = (rpcCalls[0].args.p_hand_row as Record<string, unknown>).actions;
    expect(persisted).toEqual(
      actions.map((action) => ({
        ...action,
        observationIdentity: {
          version: 1,
          status: 'unavailable',
          reason: 'missing_hand_identity',
        },
      }))
    );
    expect(mockObserveCompletedHand.mock.calls[0][0].actions).toEqual(persisted);
    expect(JSON.stringify(mockObserveCompletedHand.mock.calls[0][0].actions)).not.toMatch(
      /hole_cards|username|private-name/
    );
  });

  it('persists original action ordinals and sends the same bound identities after acceptance', async () => {
    const input = identityParams();
    acceptAtomicHand();
    await logHandHistory(input);
    const actions = (rpcCalls[0].args.p_hand_row as Record<string, any>).actions;
    expect(actions[0]).not.toHaveProperty('observationIdentity');
    expect(actions[1].observationIdentity).toMatchObject({
      status: 'unavailable',
      reason: 'non_voluntary_origin',
    });
    expect(actions[2].observationIdentity).toMatchObject({
      status: 'bound',
      handId: historyId,
      observationId: `${historyId}:2`,
      actionOrdinal: 2,
      sessionKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(mockObserveCompletedHand.mock.calls[0][0].actions).toEqual(actions);
    expect(mockObserveCompletedHand.mock.calls[0][0].committedHandId).toBe(historyId);
    const serialized = JSON.stringify(actions);
    expect(serialized).not.toMatch(/seat_joined_at|seat_id|username|hole_cards/);
    // Re-entry with a different worker/lease fence must not mint new evidence.
    acceptAtomicHand();
    input.atomicCommit.leaseGeneration = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await logHandHistory(input);
    expect((rpcCalls[1].args.p_hand_row as Record<string, any>).actions).toEqual(actions);
    expect(mockObserveCompletedHand.mock.calls[1][0].committedHandId).toBe(historyId);
    expect(mockObserveCompletedHand.mock.calls[1][0].fence).not.toBe(
      mockObserveCompletedHand.mock.calls[0][0].fence
    );
  });

  it('keeps identities stable through lost-receipt retry and does not observe a pending hand', async () => {
    vi.useFakeTimers();
    try {
      const input = identityParams();
      atomicRpcResults = [
        { data: null, error: { message: 'response lost after commit' } },
        {
          data: { success: true, atomic_hand_commit: true, history_id: historyId, replay: true },
          error: null,
        },
      ];
      const pending = logHandHistory(input);
      await vi.advanceTimersByTimeAsync(0);
      const acceptedActions = structuredClone(
        (rpcCalls[0].args.p_hand_row as Record<string, any>).actions
      );
      expect(mockObserveCompletedHand).not.toHaveBeenCalled();
      input.seatGenerations.clear();
      input.actions[2].amount = 999;
      await vi.advanceTimersByTimeAsync(250);
      await expect(pending).resolves.toMatchObject({ settlementCommitted: true });
      expect(rpcCalls).toHaveLength(2);
      expect((rpcCalls[1].args.p_hand_row as Record<string, any>).actions).toEqual(acceptedActions);
      expect(mockObserveCompletedHand).toHaveBeenCalledTimes(1);
      expect(mockObserveCompletedHand.mock.calls[0][0].actions).toEqual(acceptedActions);
      expect(mockObserveCompletedHand.mock.calls[0][0].committedHandId).toBe(historyId);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never observes bound identities from a rejected or mismatched atomic receipt', async () => {
    const input = identityParams();
    atomicRpcResults = [
      {
        data: {
          success: true,
          atomic_hand_commit: true,
          history_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        },
        error: null,
      },
    ];
    await expect(logHandHistory(input)).rejects.toThrow('receipt_identity_mismatch');
    expect(mockObserveCompletedHand).not.toHaveBeenCalled();
    expect(mockWakeHandProjection).not.toHaveBeenCalled();
  });

  it('overwrites supplied lineage and strips it from historical actions without a captured node', async () => {
    const input = identityParams();
    const observationIdentity = {
      version: 1 as const,
      status: 'bound' as const,
      handId: 'forged-hand',
      observationId: 'forged-observation',
      actionOrdinal: 999,
      sessionKey: 'forged-session',
    };
    acceptAtomicHand();
    await logHandHistory({
      ...input,
      actions: input.actions.map((a) => ({ ...a, observationIdentity })),
    });
    const actions = (rpcCalls[0].args.p_hand_row as Record<string, any>).actions;
    expect(actions[0]).not.toHaveProperty('observationIdentity');
    expect(actions[2].observationIdentity.observationId).toBe(`${historyId}:2`);
    expect(JSON.stringify(actions)).not.toContain('forged');
  });

  it('sends the exact immutable hand payload and accepted authority fence', async () => {
    acceptAtomicHand();
    const showdownReveal = [
      { user_id: 'u1', seat: 1, reveal_order: 0, mucked: false, hand_name: 'Pair' },
    ];
    const input = { ...atomicParams(GLOBAL_HAND + 800), showdownReveal };

    await logHandHistory(input);

    expect(mockGetLiveHorseDecisionWorker).toHaveBeenCalledTimes(1);
    expect(mockObserveCompletedHand).toHaveBeenCalledTimes(1);
    expect(mockObserveCompletedHand).toHaveBeenCalledWith({
      generation: input.handNumber,
      fence: `${input.tableId}:${input.handNumber}:${leaseGeneration}:observe`,
      handKey: `${input.tableId}:${input.handNumber}`,
      committedHandId: historyId,
      actions: input.actions,
      bigBlind: input.bigBlind,
      showdown: showdownReveal,
      scope: 'holdem:hu',
    });
  });

  it('returns after enqueue without waiting behind older worker FIFO jobs', async () => {
    acceptAtomicHand();
    const ack = deferred<{
      type: 'ACK';
      requestId: number;
      generation: number;
      fence: string;
      operation: 'OBSERVE_COMPLETED_HAND';
    }>();
    mockObserveCompletedHand.mockReturnValueOnce(ack.promise);
    const input = atomicParams(GLOBAL_HAND + 801);
    const result = await logHandHistory(input);
    expect(rpcCalls).toHaveLength(1);
    expect(result).toMatchObject({ handId: historyId, settlementCommitted: true });
    expect(mockObserveCompletedHand).toHaveBeenCalledTimes(1);
    ack.resolve({
      type: 'ACK',
      requestId: 91,
      generation: input.handNumber,
      fence: `${input.tableId}:${input.handNumber}:${leaseGeneration}:observe`,
      operation: 'OBSERVE_COMPLETED_HAND',
    });
    await ack.promise;
  });

  it('reports a rejected observation without endangering the committed hand', async () => {
    acceptAtomicHand();
    const observationError = new Error('worker observation unavailable');
    mockObserveCompletedHand.mockRejectedValueOnce(observationError);

    const result = await logHandHistory(atomicParams(GLOBAL_HAND + 802));

    expect(result).toMatchObject({ handId: historyId, settlementCommitted: true });
    expect(mockObserveCompletedHand).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(mockReportError).toHaveBeenCalledWith(
        observationError,
        'HandHistory.horse_mind_observation_failed'
      )
    );
  });
});

describe('logHandHistory - accepted-hand transaction', () => {
  it('uses the one authoritative RPC and wakes projection only after its receipt is proved', async () => {
    atomicRpcResults = [
      {
        data: {
          success: true,
          atomic_hand_commit: true,
          history_id: historyId,
          replay: false,
        },
        error: null,
      },
    ];

    const input = { ...atomicParams(), handId: historyId.toUpperCase() };
    const result = await logHandHistory(input);

    expect(result).toMatchObject({
      handId: historyId,
      settlementCommitted: true,
    });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toMatchObject({
      fn: 'fn_ca_commit_hand_settlement',
      args: {
        p_table_id: input.tableId,
        p_hand_number: input.handNumber,
        p_stacks: input.atomicCommit.stacks,
        p_rake: 2,
        p_bbj: 0,
        p_ref: `hand:${input.handNumber}`,
        p_inflow: 0,
        p_instance_id: 'engine-instance-1',
        p_lease_generation: leaseGeneration,
      },
    });
    expect(rpcCalls[0].args.p_hand_row).toMatchObject({
      table_id: input.tableId,
      hand_number: input.handNumber,
    });
    expect(calls).toHaveLength(0);
    expect(mockObserveCompletedHand).toHaveBeenCalledTimes(1);
    expect(mockObserveCompletedHand).toHaveBeenCalledWith({
      generation: input.handNumber,
      fence: `${input.tableId}:${input.handNumber}:${leaseGeneration}:observe`,
      handKey: `${input.tableId}:${input.handNumber}`,
      committedHandId: historyId,
      actions: input.actions,
      bigBlind: input.bigBlind,
      showdown: null,
      scope: 'holdem:hu',
    });
    const emitted = mockObserveCompletedHand.mock.calls[0]![0];
    expect(
      horseCompletedHandKey({
        generation: emitted.generation,
        fence: emitted.fence,
        handKey: emitted.handKey,
        committedHandId: emitted.committedHandId,
        bigBlind: emitted.bigBlind,
        actions: emitted.actions,
      })
    ).toBe(`${input.tableId}:${input.handNumber}:${leaseGeneration}`);
    expect(mockWakeHandProjection).toHaveBeenCalledTimes(1);
  });

  it('replays one byte-identical obligations-aware request after a lost response', async () => {
    vi.useFakeTimers();
    try {
      const input = obligationsParams();
      atomicRpcResults = [
        { data: null, error: { message: 'response body timed out after commit' } },
        {
          data: {
            success: true,
            atomic_hand_commit: true,
            history_id: historyId,
            replay: true,
            post_commit_obligations: true,
          },
          error: null,
        },
      ];

      const pending = logHandHistory(input);
      await vi.advanceTimersByTimeAsync(250);
      const result = await pending;

      expect(result).toMatchObject({ handId: historyId, settlementCommitted: true });
      expect(rpcCalls).toHaveLength(2);
      expect(rpcCalls[1]).toEqual(rpcCalls[0]);
      expect(retentionCalls).toHaveLength(1);
      expect(retentionCalls[0]).toMatchObject({
        p_post_commit_obligations: input.atomicCommit.postCommitObligations,
        p_hand_row: {
          _accepted_post_commit_facts: input.atomicCommit.acceptedPostCommitFacts,
        },
      });
      expect(rpcCalls[0]).toEqual({
        fn: 'fn_ca_commit_hand_submission',
        args: {
          p_submission_id: historyId,
          p_instance_id: 'engine-instance-1',
          p_lease_generation: leaseGeneration,
        },
      });
      expect(input.assertLeaseAuthority).toHaveBeenCalledTimes(3);
      expect(mockObserveCompletedHand).toHaveBeenCalledTimes(1);
      expect(mockWakeHandProjection).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses an obligations request with no independently accepted facts before any RPC', async () => {
    const input = obligationsParams(GLOBAL_HAND + 601);
    delete (input.atomicCommit as { acceptedPostCommitFacts?: unknown }).acceptedPostCommitFacts;

    await expect(logHandHistory(input)).rejects.toThrow(
      /atomic hand commit refused \(post_commit_facts_missing\)/
    );
    expect(rpcCalls).toHaveLength(0);
    expect(mockWakeHandProjection).not.toHaveBeenCalled();
    expect(mockObserveCompletedHand).not.toHaveBeenCalled();
  });

  it('does not accept an ordinary hand receipt for the obligations-aware door', async () => {
    atomicRpcResults = [
      {
        data: {
          success: true,
          atomic_hand_commit: true,
          history_id: historyId,
          replay: false,
        },
        error: null,
      },
    ];

    await expect(logHandHistory(obligationsParams(GLOBAL_HAND + 602))).rejects.toThrow(
      /atomic hand commit refused \(missing_post_commit_receipt\)/
    );
    expect(rpcCalls).toHaveLength(1);
    expect(mockWakeHandProjection).not.toHaveBeenCalled();
  });

  it('fails closed on a semantic refusal without an alternate writer or projection wake', async () => {
    const input = atomicParams(GLOBAL_HAND + 501);
    atomicRpcResults = [
      {
        data: {
          success: false,
          reason: 'payload_mismatch',
          error: 'the accepted payload is immutable',
        },
        error: null,
      },
    ];

    await expect(logHandHistory(input)).rejects.toThrow(
      /atomic hand commit refused \(payload_mismatch\)/
    );

    expect(rpcCalls).toHaveLength(1);
    expect(calls).toHaveLength(0);
    expect(mockWakeHandProjection).not.toHaveBeenCalled();
  });

  it('rejects a malformed success response as a semantic refusal and never projects it', async () => {
    atomicRpcResults = [
      {
        data: {
          success: true,
          atomic_hand_commit: true,
          history_id: 'not-a-durable-receipt',
        },
        error: null,
      },
    ];

    await expect(logHandHistory(atomicParams(GLOBAL_HAND + 502))).rejects.toThrow(
      /atomic hand commit refused \(invalid_receipt\)/
    );
    expect(rpcCalls).toHaveLength(1);
    expect(mockWakeHandProjection).not.toHaveBeenCalled();
  });

  it('retries only an ambiguous transport response with the identical payload', async () => {
    atomicRpcResults = [
      { data: null, error: { message: 'connection reset after commit' } },
      {
        data: {
          success: true,
          atomic_hand_commit: true,
          history_id: historyId,
          replay: true,
        },
        error: null,
      },
    ];
    const input = atomicParams(GLOBAL_HAND + 503);

    const result = await logHandHistory(input);

    expect(result.settlementCommitted).toBe(true);
    expect(result.handId).toBe(historyId);
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[0].args).toEqual(rpcCalls[1].args);
    expect(mockWakeHandProjection).toHaveBeenCalledTimes(1);
  });

  it('holds an immutable purchase payload while a lost response is retried', async () => {
    vi.useFakeTimers();
    try {
      const input = obligationsParams();
      atomicRpcResults = [
        { data: null, error: { message: 'response lost after commit' } },
        {
          data: {
            success: true,
            atomic_hand_commit: true,
            history_id: historyId,
            post_commit_obligations: true,
            replay: true,
          },
          error: null,
        },
      ];
      const pending = logHandHistory(input);
      await vi.advanceTimersByTimeAsync(0);
      const accepted = structuredClone(retentionCalls[0]);
      input.atomicCommit.stacks[0].stack = 999;
      input.atomicCommit.acceptedPostCommitFacts.contributions.u1 = 999;
      input.atomicCommit.postCommitObligations.time_banks[0].uses_remaining = 999;
      await vi.advanceTimersByTimeAsync(250);
      await expect(pending).resolves.toMatchObject({ settlementCommitted: true });
      expect(rpcCalls).toHaveLength(2);
      expect(retentionCalls).toHaveLength(1);
      expect(retentionCalls[0]).toEqual(accepted);
      expect(rpcCalls[1].args).toEqual(rpcCalls[0].args);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not accept a valid receipt for a different requested hand UUID', async () => {
    atomicRpcResults = [
      {
        data: { success: true, atomic_hand_commit: true, history_id: historyId },
        error: null,
      },
    ];
    const input = { ...atomicParams(), handId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    await expect(logHandHistory(input)).rejects.toThrow(
      /atomic hand commit refused \(receipt_identity_mismatch\)/
    );
    expect(rpcCalls).toHaveLength(1);
    expect(mockWakeHandProjection).not.toHaveBeenCalled();
    expect(mockObserveCompletedHand).not.toHaveBeenCalled();
  });

  it('refuses incomplete or malformed generation authority before any RPC', async () => {
    const incomplete = atomicParams(GLOBAL_HAND + 504);
    delete (incomplete.atomicCommit as { leaseGeneration?: string }).leaseGeneration;
    await expect(logHandHistory(incomplete)).rejects.toThrow(
      /atomic hand commit refused \(incomplete_lease_authority\)/
    );

    const malformed = atomicParams(GLOBAL_HAND + 505);
    malformed.atomicCommit.leaseGeneration = 'not-a-uuid';
    await expect(logHandHistory(malformed)).rejects.toThrow(
      /atomic hand commit refused \(invalid_lease_authority\)/
    );
    expect(rpcCalls).toHaveLength(0);
  });

  it('persists Daily Missions facts inside the authoritative hand payload', async () => {
    acceptAtomicHand();
    const dailyMissionEvents = [
      {
        user_id: 'u1',
        amounts: { hands_played: 1, hands_won: 1 },
        magnitudes: { biggest_pot: 40 },
        values: { big_pots: [20, 40] },
      },
    ];

    await logHandHistory({
      ...atomicParams(GLOBAL_HAND + 506),
      dailyMissionEvents,
    });

    expect(rpcCalls).toHaveLength(1);
    expect((rpcCalls[0].args.p_hand_row as Record<string, unknown>).daily_mission_events).toEqual(
      dailyMissionEvents
    );
  });

  it('persists RIT boards in the same authoritative hand payload', async () => {
    acceptAtomicHand();
    const ritBoards = [
      ['2c', '3d', '4h', '5s', '6c'],
      ['7c', '8d', '9h', 'Ts', 'Jc'],
    ];

    await logHandHistory({ ...atomicParams(GLOBAL_HAND + 507), ritBoards });

    expect(rpcCalls).toHaveLength(1);
    expect((rpcCalls[0].args.p_hand_row as Record<string, unknown>).rit_boards).toEqual(ritBoards);
  });

  it('persists the kill_pot record in the same authoritative hand payload, and only when present', async () => {
    // KILL POTS (rule manifest kill-v1): the pending kill is restored from the
    // trigger hand's own row, so it must travel inside the atomic commit.
    acceptAtomicHand();
    const killPot = {
      rule_version: 'kill-v1' as const,
      kill_hand: null,
      next_kill: {
        killer_user_id: 'u1',
        killer_seat: 1,
        mode: 'full' as const,
        multiplier: '2/1',
        threshold_bb: 10,
        threshold_amount: 20,
        contested_total: 40,
        trigger_hand_id: historyId,
        trigger_hand_number: GLOBAL_HAND + 508,
        chained: false,
        scoop: { winner: 'u1', pots: 1, awards: 1, boards: [1], low_awards: 0 },
      },
      cancelled: null,
    };
    await logHandHistory({ ...atomicParams(GLOBAL_HAND + 508), killPot });
    expect(rpcCalls).toHaveLength(1);
    const row = rpcCalls[0].args.p_hand_row as Record<string, unknown>;
    expect(row.kill_pot).toEqual(killPot);
    // The base blinds stay on the row; the BBJ commit check requires them.
    expect(row.small_blind).toBe(1);
    expect(row.big_blind).toBe(2);

    rpcCalls.length = 0;
    acceptAtomicHand();
    await logHandHistory({ ...atomicParams(GLOBAL_HAND + 509), killPot: null });
    expect('kill_pot' in (rpcCalls[0].args.p_hand_row as Record<string, unknown>)).toBe(false);
  });
});

describe('buildHandHistoryTiers (Bible V8 §2.18, derived not stored)', () => {
  // It must consume a row exactly as hand_history STORES it (snake_case). The
  // first version took the settlement input shape (camelCase) while its own doc
  // said to call it with a stored row, so it could not be called the documented
  // way at all — and the test used the settlement shape too, baking the mistake
  // in where it could never be caught.
  const storedRow = {
    id: 'hh-1',
    table_id: '11111111-1111-1111-1111-111111111111',
    tournament_id: null,
    hand_number: GLOBAL_HAND,
    game_variant: 'nlh',
    small_blind: 1,
    big_blind: 2,
    pot_size: 40,
    rake_amount: 2,
    bbj_amount: 0,
    community_cards: ['As', 'Kd', '7c'],
    button_seat: 3,
    created_at: '2026-08-20T00:00:00.000Z',
    hole_cards: {
      u1: [
        { rank: 'A', suit: 'spades' },
        { rank: 'K', suit: 'hearts' },
      ],
    },
    winners: [{ userId: 'u1', amount: 38, hand: { name: 'Two Pair', ranking: 3 } }],
    // NOTE: stack here is the POST-settlement stack — u1 has already been paid.
    players: [
      { userId: 'u1', username: 'A', seat: 1, stack: 118 },
      { userId: 'u2', username: 'B', seat: 2, stack: 80 },
    ],
    actions: [
      { seat: 1, userId: 'u1', action: 'bet', amount: 20, stage: 'flop' },
      { seat: 2, userId: 'u2', action: 'call', amount: 20, stage: 'flop' },
      { seat: 2, userId: 'u2', action: 'fold', stage: 'river' },
    ],
  };

  it('produces all four tiers from a stored row', () => {
    const tiers = buildHandHistoryTiers(storedRow);

    expect(tiers.raw_events).toHaveLength(3);
    expect(tiers.raw_events[0]).toMatchObject({ seq: 0, seat: 1, action: 'bet', amount: 20 });
    expect(tiers.audit_log).toMatchObject({
      hand_number: GLOBAL_HAND,
      pot_size: 40,
      rake: 2,
      button_seat: 3,
    });
    expect(tiers.audit_log.went_to_showdown).toBe(true);
    expect(tiers.player_summaries).toHaveLength(2);
    // Tier 4 is the other three plus the showdown material — which is exactly
    // why storing it would have tripled the largest payload on the platform.
    expect(tiers.dispute_review.raw_events).toEqual(tiers.raw_events);
    expect(tiers.dispute_review.player_summaries).toEqual(tiers.player_summaries);
    expect(tiers.dispute_review.revealed_hole_cards).toHaveProperty('u1');
  });

  it('does NOT call the stored stack a starting stack - it is post-settlement', () => {
    const [winner] = buildHandHistoryTiers(storedRow).player_summaries;
    // Settlement mutates SeatedPlayer.stack in place before the row is written,
    // so 118 already includes the 38 that was just won.
    expect(winner.stackAfterSettlement).toBe(118);
    expect(winner.stackBeforePayout).toBe(80);
    expect(winner).not.toHaveProperty('startStack');
  });

  it('reports what a player won GROSS and what they actually netted', () => {
    const [winner, loser] = buildHandHistoryTiers(storedRow).player_summaries;
    // The old field was called netResult and held the gross award, with every
    // loser reading 0 rather than their loss.
    expect(winner.amountWon).toBe(38);
    expect(winner.contributed).toBe(20);
    expect(winner.net).toBe(18);
    expect(loser.amountWon).toBe(0);
    expect(loser.contributed).toBe(20);
    expect(loser.net).toBe(-20);
    // Blinds and antes are not in the action log, and it says so rather than
    // quietly pretending the number is complete.
    expect(winner.contributedIncludesBlinds).toBe(false);
  });

  it('treats a raise as a level, not as chips added', () => {
    // bet 10 then raise-to 30 on the same street is 30 in, not 40.
    const tiers = buildHandHistoryTiers({
      ...storedRow,
      winners: [],
      actions: [
        { seat: 1, userId: 'u1', action: 'bet', amount: 10, stage: 'flop' },
        { seat: 1, userId: 'u1', action: 'raise', amount: 30, stage: 'flop' },
      ],
    });
    expect(tiers.player_summaries[0].contributed).toBe(30);
  });

  it('survives a row with null player/action/winner columns', () => {
    const tiers = buildHandHistoryTiers({
      table_id: 't',
      hand_number: GLOBAL_HAND,
      game_variant: 'nlh',
      small_blind: 1,
      big_blind: 2,
      pot_size: 0,
      rake_amount: 0,
      players: null,
      actions: null,
      winners: null,
    });
    expect(tiers.raw_events).toEqual([]);
    expect(tiers.player_summaries).toEqual([]);
    expect(tiers.audit_log.player_count).toBe(0);
  });
});

describe('tournament bounty history keeps each winning pot', () => {
  it('persists the exact side-pot winner even when the paid total is merged into the main pot', async () => {
    const input = {
      ...atomicParams(),
      handId: historyId,
      winners: [{ userId: 'u1', amount: 600, potIndex: 0 }],
      players: [
        { userId: 'u1', username: 'Winner', seat: 1, stack: 600, cards: [] },
        { userId: 'u2', username: 'Short', seat: 2, stack: 0, cards: [] },
        { userId: 'u3', username: 'Busted', seat: 3, stack: 0, cards: [] },
      ],
      pots: [
        { index: 0, amount: 300, eligible: ['u1', 'u2', 'u3'] },
        { index: 1, amount: 300, eligible: ['u1', 'u3'] },
      ],
      perPotAwards: [
        { userId: 'u1', amount: 300, potIndex: 0, low: false },
        { userId: 'u1', amount: 300, potIndex: 1, low: false },
      ],
    };
    atomicRpcResults = [
      {
        data: { success: true, atomic_hand_commit: true, history_id: historyId, replay: false },
        error: null,
      },
    ];
    await logHandHistory(input);
    const row = rpcCalls[0].args.p_hand_row as any;
    expect(row.winners).toEqual(input.winners);
    expect(row.pots[1].awards).toEqual([input.perPotAwards[1]]);
    const result = persistedKnockoutEvidence(
      {
        success: true,
        table_id: input.tableId,
        hand_number: input.handNumber,
        written: { u1: 600, u2: 0, u3: 0 },
      },
      row,
      'u3'
    );
    expect(result).toMatchObject({
      ready: true,
      attribution: { potIndex: 1, claimants: [{ userId: 'u1', weight: 1 }] },
    });
  });
});

/** PREPARED / UNEXECUTED diagnostic prerequisite laws. Synthetic receipt
 * extensions below are NOT a new producer return contract. Existing scalar
 * reason/error/transport text remains outside this narrow redaction scope. */
abstract class PrivateReceiptRetryProbe extends ServerTableEngineBase {
  static rolledBackRetryable(error: unknown): boolean {
    return this.isRolledBackSerializationRefusal(error);
  }
}
async function rejectedPrivateReceipt(data: Record<string, unknown>): Promise<Error> {
  atomicRpcResults = [{ data, error: null }];
  return logHandHistory(atomicParams(GLOBAL_HAND + 900)).then(
    () => {
      throw new Error('fixture unexpectedly accepted');
    },
    (error) => {
      expect(error).toBeInstanceOf(Error);
      return error as Error;
    }
  );
}
const privateReceiptExtensions = [
  {
    name: 'hypothetical-roster',
    value: {
      acceptedActorRoster: {
        version: 1,
        roster: {
          actors: [
            {
              userId: 'SYNTHETIC_PRIVATE_ACTOR',
              classification: 'SYNTHETIC_PRIVATE_CLASSIFICATION',
            },
          ],
        },
      },
    },
  },
  {
    name: 'financial-request',
    value: {
      request: {
        stacks: [
          {
            user_id: 'SYNTHETIC_PRIVATE_PLAYER',
            stack: 123456.78,
            seat_joined_at: 'SYNTHETIC_PRIVATE_GENERATION',
          },
        ],
      },
      written: { SYNTHETIC_PRIVATE_PLAYER: 123456.78 },
    },
  },
  {
    name: 'arbitrary-nested-extension',
    value: {
      future: {
        nested: [
          {
            payloadText: 'SYNTHETIC_PRIVATE_PAYLOAD',
            profile: { secret: 'SYNTHETIC_PRIVATE_PROFILE' },
          },
        ],
      },
    },
  },
];
describe('prepared whole-receipt diagnostic redaction', () => {
  for (const extension of privateReceiptExtensions) {
    it(`invalid success never serializes nested ${extension.name}`, async () => {
      const error = await rejectedPrivateReceipt({
        success: true,
        atomic_hand_commit: true,
        history_id: 'invalid-history-id',
        ...extension.value,
      });
      expect(error.message).toBe('atomic hand commit refused (invalid_receipt)');
      expect(error.message).not.toContain('SYNTHETIC_PRIVATE');
      expect(rpcCalls).toHaveLength(1);
      expect(calls).toEqual([]);
      expect(mockWakeHandProjection).not.toHaveBeenCalled();
      expect(mockObserveCompletedHand).not.toHaveBeenCalled();
      expect(PrivateReceiptRetryProbe.rolledBackRetryable(error)).toBe(false);
    });
    it(`refusal without scalar error never serializes nested ${extension.name}`, async () => {
      const error = await rejectedPrivateReceipt({
        success: false,
        reason: 'payload_mismatch',
        ...extension.value,
      });
      expect(error.message).toBe(
        'atomic hand commit refused (payload_mismatch): receipt_detail_redacted'
      );
      expect(error.message).not.toContain('SYNTHETIC_PRIVATE');
      expect(rpcCalls).toHaveLength(1);
      expect(calls).toEqual([]);
      expect(mockWakeHandProjection).not.toHaveBeenCalled();
      expect(mockObserveCompletedHand).not.toHaveBeenCalled();
      expect(PrivateReceiptRetryProbe.rolledBackRetryable(error)).toBe(false);
    });
  }
  it('keeps the existing scalar SQL error text while omitting unrelated nested receipt details', async () => {
    const error = await rejectedPrivateReceipt({
      success: false,
      reason: 'payload_mismatch',
      error: 'the accepted payload is immutable',
      ...privateReceiptExtensions[0]!.value,
    });
    expect(error.message).toBe(
      'atomic hand commit refused (payload_mismatch): the accepted payload is immutable'
    );
    expect(error.message).not.toContain('SYNTHETIC_PRIVATE');
    expect(rpcCalls).toHaveLength(1);
  });
  for (const reason of ['rolled_back', 'atomic_hand_rolled_back']) {
    for (const cause of [
      'F06_RETRY_CANONICAL_LANE',
      'could not serialize access due to concurrent update',
      'deadlock detected',
    ]) {
      it(`preserves outer rollback retry classification for ${reason}/${cause}`, async () => {
        const error = await rejectedPrivateReceipt({
          success: false,
          reason,
          error: cause,
          ...privateReceiptExtensions[1]!.value,
        });
        expect(error.message).toBe(`atomic hand commit refused (${reason}): ${cause}`);
        expect(PrivateReceiptRetryProbe.rolledBackRetryable(error)).toBe(true);
        // The inner writer still throws the same semantic category immediately;
        // only the existing outer settlement lane owns retrying this rollback.
        expect(rpcCalls).toHaveLength(1);
        expect(mockObserveCompletedHand).not.toHaveBeenCalled();
      });
    }
  }
  it('does not turn a deterministic rollback into an outer retry', async () => {
    const error = await rejectedPrivateReceipt({
      success: false,
      reason: 'rolled_back',
      error: 'conservation violation',
    });
    expect(PrivateReceiptRetryProbe.rolledBackRetryable(error)).toBe(false);
    expect(rpcCalls).toHaveLength(1);
  });
  it('does not turn a nonrollback refusal with transient text into a rollback', async () => {
    const error = await rejectedPrivateReceipt({
      success: false,
      reason: 'payload_mismatch',
      error: 'deadlock detected',
    });
    expect(PrivateReceiptRetryProbe.rolledBackRetryable(error)).toBe(false);
    expect(rpcCalls).toHaveLength(1);
  });
  it('keeps the unknown refusal category when reason and scalar error are absent', async () => {
    const error = await rejectedPrivateReceipt({
      success: false,
      ...privateReceiptExtensions[2]!.value,
    });
    expect(error.message).toBe('atomic hand commit refused (unknown): receipt_detail_redacted');
    expect(rpcCalls).toHaveLength(1);
    expect(mockObserveCompletedHand).not.toHaveBeenCalled();
  });
  it('preserves accepted receipt data and the existing private observation shape', async () => {
    const receipt = {
      success: true,
      atomic_hand_commit: true,
      history_id: historyId,
      replay: true,
      ...privateReceiptExtensions[0]!.value,
      ...privateReceiptExtensions[1]!.value,
    };
    atomicRpcResults = [{ data: receipt, error: null }];
    const response = await logHandHistory(atomicParams(GLOBAL_HAND + 901));
    expect(response).toEqual({
      handId: historyId,
      settlementCommitted: true,
      stackResult: receipt,
    });
    expect(rpcCalls).toHaveLength(1);
    expect(mockWakeHandProjection).toHaveBeenCalledTimes(1);
    expect(mockObserveCompletedHand).toHaveBeenCalledTimes(1);
    // Adding a diagnostic repair must not accidentally activate the hypothetical
    // private roster transport used as an extension in this synthetic fixture.
    expect(mockObserveCompletedHand.mock.calls[0]![0]).not.toHaveProperty('acceptedActorRoster');
  });
});
