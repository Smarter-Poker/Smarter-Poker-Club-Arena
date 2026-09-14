import { describe, expect, it, vi } from 'vitest';

import type {
  FastHorseDecisionResult,
  HorseDecisionWorkerReady,
  HorseDecisionWorkerResponse,
  LiveHorseDecisionSnapshot,
} from './protocol.js';
import { buildHorseDecisionKey } from './protocol.js';
import { HorsePolicyGraph, HORSE_POLICY_ORDER } from '../HorsePolicyGraph.js';
import {
  HorseDecisionAbortedError,
  HorseDecisionExpiredError,
  LiveHorseDecisionWorkerClient,
  type WorkerLike,
} from './client.js';

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

  emitMessage(message: HorseDecisionWorkerResponse): void {
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
  requestId,
  generation: 7,
  fence,
  decision: { action: 'fold' as const, thinkTime: 1500 },
  rngBefore: 11,
  rngAfter: 22,
  computeMs: 4,
  governorScale: 0.35,
  effects: [],
});

describe('LiveHorseDecisionWorkerClient', () => {
  it.each([10, 11])(
    'accepts plans only for the original reference wager (final amount %s)',
    async (amount) => {
      const worker = new FakeWorker();
      const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
      worker.emitMessage(ready);
      const input = snapshot('effect-reference');
      input.gameState.stage = 'flop';
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
      reply.effects = [
        { type: 'plan', handKey: '12:poster', userId: 'horse-1', barrelIntent: true },
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
      reply.effects = [
        {
          type: 'raise_plan',
          handKey: '12:poster',
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
      expect(worker.sent.at(-1)).toEqual({ type: 'CANCEL', requestId: 2 });
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

  it('orders an accepted action effect after older work and before synchronous successors', async () => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({
      workerFactory: () => worker,
      maxInFlight: 1,
    });
    worker.emitMessage(ready);
    const active = client.decideFast(snapshot('active'));
    const older = client.decideFast(snapshot('older'));
    let successor!: ReturnType<typeof client.decideFast>;
    let committed!: ReturnType<typeof client.commitDecisionEffects>;

    client.runWithDispatchBarrier(() => {
      successor = client.decideFast(snapshot('successor'));
      committed = client.commitDecisionEffects({ generation: 7, fence: 'accepted-action' }, [
        { type: 'plan', handKey: 'h', userId: 'horse-1', barrelIntent: true },
      ]);
    });

    worker.emitMessage(fastResult(1, 'active'));
    await active;
    expect(worker.sent.at(-1)).toMatchObject({ type: 'DECIDE_FAST', requestId: 2 });
    worker.emitMessage(fastResult(2, 'older'));
    await older;
    expect(worker.sent.at(-1)).toMatchObject({
      type: 'COMMIT_DECISION_EFFECTS',
      requestId: 4,
      fence: 'accepted-action',
    });
    worker.emitMessage({
      type: 'ACK',
      requestId: 4,
      generation: 7,
      fence: 'accepted-action',
      operation: 'COMMIT_DECISION_EFFECTS',
    });
    await committed;
    expect(worker.sent.at(-1)).toMatchObject({ type: 'DECIDE_FAST', requestId: 3 });
    worker.emitMessage(fastResult(3, 'successor'));
    await successor;
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
      expect(worker.sent.at(-1)).toEqual({ type: 'CANCEL', requestId: 2 });
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
    const running = client.decideFast(snapshot('running'));
    const older = client.decideFast(snapshot('older'));
    const olderStill = client.decideFast(snapshot('older-still'));
    expect(requestIds(worker)).toEqual([1, 2]);
    let successor!: ReturnType<typeof client.decideFast>;
    let committed!: ReturnType<typeof client.commitDecisionEffects>;

    client.runWithDispatchBarrier(() => {
      successor = client.decideFast(snapshot('successor'));
      committed = client.commitDecisionEffects({ generation: 7, fence: 'accepted-action' }, [
        { type: 'plan', handKey: 'h', userId: 'horse-1', barrelIntent: true },
      ]);
    });
    expect(requestIds(worker)).toEqual([1, 2]);

    worker.emitMessage(fastResult(1, 'running'));
    await running;
    worker.emitMessage(fastResult(2, 'older'));
    await older;
    // Older work first (3), then the commit (5), then its causal successor (4).
    expect(requestIds(worker)).toEqual([1, 2, 3, 5]);
    worker.emitMessage(fastResult(3, 'older-still'));
    await olderStill;
    expect(requestIds(worker)).toEqual([1, 2, 3, 5, 4]);
    worker.emitMessage({
      type: 'ACK',
      requestId: 5,
      generation: 7,
      fence: 'accepted-action',
      operation: 'COMMIT_DECISION_EFFECTS',
    });
    await committed;
    worker.emitMessage(fastResult(4, 'successor'));
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
