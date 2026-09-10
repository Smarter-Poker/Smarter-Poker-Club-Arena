import { describe, expect, it, vi } from 'vitest';

import type {
  HorseDecisionWorkerReady,
  HorseDecisionWorkerResponse,
  LiveHorseDecisionSnapshot,
} from './protocol.js';
import { buildHorseDecisionKey } from './protocol.js';
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

const fastResult = (requestId: number, fence: string) => ({
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
  it('holds work behind READY and posts exactly one FIFO job at a time', async () => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
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
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
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
    worker.emitMessage(fastResult(1, 'active'));
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
      worker.emitMessage(fastResult(2, 'near-deadline'));
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
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
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
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker, onFatal });
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
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
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
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
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
