/**
 * LAW: the decision deadline is the turn clock.
 *
 * A horse decision job lives for what is left of the seat's action clock,
 * less the engine's margin to act on the answer - never a fixed 8 s that
 * gives up with half the clock unused. The worker-integrity (execution)
 * window armed at dispatch is a different number and does not move.
 *
 * Measured 2026-09-17 16:20-16:50 UTC on engine-01: 23.5 fallbacks a minute
 * and 27,548 expired decisions since boot while the worker computed in 12 ms;
 * the 8 s caller deadline, not the decision, was the failure.
 *
 * See docs/laws.d/server-src-engine-horseDecision-theDecisionDeadlineIsTheTurnClock.md
 */
import { describe, expect, it, vi } from 'vitest';

import {
  HORSE_DECISION_DEADLINE_MARGIN_MS,
  HORSE_DECISION_MAX_DEADLINE_MS,
  HORSE_DECISION_MIN_DEADLINE_MS,
  horseDecisionDeadlineMs,
} from './decisionDeadline.js';
import {
  HorseDecisionExpiredError,
  LiveHorseDecisionWorkerClient,
  type WorkerLike,
} from './client.js';
import type {
  FastHorseDecisionResult,
  HorseDecisionWorkerReady,
  HorseDecisionWorkerResponse,
  LiveHorseDecisionSnapshot,
} from './protocol.js';
import { buildHorseDecisionKey } from './protocol.js';
import { horsePlanBatchBindingFromRequest } from '../HorsePlanHandIdentity.js';

describe('the decision deadline is the turn clock: the number', () => {
  it('is the action clock less the margin on a fresh turn', () => {
    expect(horseDecisionDeadlineMs({ actionTimeSeconds: 15, elapsedMs: 0 })).toBe(
      15_000 - HORSE_DECISION_DEADLINE_MARGIN_MS
    );
    expect(horseDecisionDeadlineMs({ actionTimeSeconds: 20, elapsedMs: 0 })).toBe(
      20_000 - HORSE_DECISION_DEADLINE_MARGIN_MS
    );
  });

  it('is what is left of the clock when the turn is already under way', () => {
    expect(horseDecisionDeadlineMs({ actionTimeSeconds: 15, elapsedMs: 4_000 })).toBe(
      15_000 - 4_000 - HORSE_DECISION_DEADLINE_MARGIN_MS
    );
  });

  it('never drops below the floor on a short or nearly spent clock', () => {
    expect(horseDecisionDeadlineMs({ actionTimeSeconds: 3, elapsedMs: 0 })).toBe(
      HORSE_DECISION_MIN_DEADLINE_MS
    );
    expect(horseDecisionDeadlineMs({ actionTimeSeconds: 15, elapsedMs: 14_900 })).toBe(
      HORSE_DECISION_MIN_DEADLINE_MS
    );
  });

  it('never exceeds the ceiling on a generous clock', () => {
    expect(horseDecisionDeadlineMs({ actionTimeSeconds: 120, elapsedMs: 0 })).toBe(
      HORSE_DECISION_MAX_DEADLINE_MS
    );
  });

  it('reads a missing, non-finite or non-positive clock as the engine default of 15 s', () => {
    const fresh = horseDecisionDeadlineMs({ actionTimeSeconds: 15, elapsedMs: 0 });
    expect(horseDecisionDeadlineMs({ actionTimeSeconds: undefined, elapsedMs: 0 })).toBe(fresh);
    expect(horseDecisionDeadlineMs({ actionTimeSeconds: null, elapsedMs: 0 })).toBe(fresh);
    expect(horseDecisionDeadlineMs({ actionTimeSeconds: 0, elapsedMs: 0 })).toBe(fresh);
    expect(horseDecisionDeadlineMs({ actionTimeSeconds: Number.NaN, elapsedMs: 0 })).toBe(fresh);
  });

  it('reads a negative or non-finite elapsed time as a fresh turn', () => {
    const fresh = horseDecisionDeadlineMs({ actionTimeSeconds: 15, elapsedMs: 0 });
    expect(horseDecisionDeadlineMs({ actionTimeSeconds: 15, elapsedMs: -500 })).toBe(fresh);
    expect(horseDecisionDeadlineMs({ actionTimeSeconds: 15, elapsedMs: Number.NaN })).toBe(fresh);
  });

  it('is longer than the fixed 8 s window on the default clock, which is the point', () => {
    expect(horseDecisionDeadlineMs({ actionTimeSeconds: 15, elapsedMs: 0 })).toBeGreaterThan(8_000);
  });
});

// ── the client honours a per-job deadline ──────────────────────────────────
class FakeWorker implements WorkerLike {
  readonly sent: unknown[] = [];
  private messageListener: ((message: HorseDecisionWorkerResponse) => void) | null = null;
  postMessage(message: unknown): void {
    this.sent.push(message);
  }
  on(event: 'message', listener: (message: HorseDecisionWorkerResponse) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  on(event: 'message' | 'error' | 'exit', listener: unknown): this {
    if (event === 'message')
      this.messageListener = listener as (message: HorseDecisionWorkerResponse) => void;
    return this;
  }
  terminate(): Promise<number> {
    return Promise.resolve(0);
  }
  emitMessage(message: HorseDecisionWorkerResponse): void {
    this.messageListener?.(message);
  }
  emitFastResult(requestId: number, fence: string): void {
    const request = [...this.sent]
      .reverse()
      .find(
        (item) =>
          (item as { requestId?: number; type?: string }).requestId === requestId &&
          (item as { type?: string }).type === 'DECIDE_FAST'
      );
    const result: FastHorseDecisionResult = {
      type: 'FAST_RESULT',
      planIssueDisposition: 'no_effects',
      requestId,
      planBinding: horsePlanBatchBindingFromRequest(request as never),
      generation: 7,
      fence,
      decision: { action: 'fold', thinkTime: 1500 },
      rngBefore: 11,
      rngAfter: 22,
      computeMs: 4,
      governorScale: 0.35,
      effects: [],
    };
    this.messageListener?.(result);
  }
}

const ready: HorseDecisionWorkerReady = {
  type: 'READY',
  solverStores: {
    charts: 1,
    postflop: 2,
    postflopV31: 3,
    postflopV31Dataset: { id: '11111111-1111-4111-8111-111111111111', checksum: 'a'.repeat(64) },
  },
  solverPolicyArtifact: { totalPolicies: 4 } as HorseDecisionWorkerReady['solverPolicyArtifact'],
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
} as HorseDecisionWorkerReady;

const snapshot = (fence: string): LiveHorseDecisionSnapshot => {
  const seat = (n: number, user: string, stack: number, bet: number) => ({
    seat: n,
    user_id: user,
    username: user,
    stack,
    bet,
    totalInvested: bet,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  });
  const value: LiveHorseDecisionSnapshot = {
    generation: 7,
    fence,
    decisionKey: '',
    decisionTimeMs: 1_800_000,
    player: {
      ...seat(1, 'horse-1', 100, 0),
      cards: [
        { rank: 'A', suit: 'spades' },
        { rank: 'K', suit: 'spades' },
      ],
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
      players: [seat(1, 'horse-1', 100, 0), seat(2, 'horse-2', 98, 2)],
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
    } as LiveHorseDecisionSnapshot['gameState'],
  } as LiveHorseDecisionSnapshot;
  value.decisionKey = buildHorseDecisionKey(value);
  return value;
};

describe('the decision deadline is the turn clock: the client', () => {
  // The production shape: the worker answers in milliseconds, the wait is the
  // queue in front of a slow main loop. One in-flight slot, a first job that
  // occupies it for seven seconds, and a second job queued behind it.
  it('lets a job with a turn-clock deadline outlive the fixed window in the queue and answer', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const client = new LiveHorseDecisionWorkerClient({
        workerFactory: () => worker,
        jobTimeoutMs: 8_000,
        maxInFlight: 1,
      });
      worker.emitMessage(ready);
      const first = client.decideFast(snapshot('first'), undefined, { deadlineMs: 13_500 });
      const second = client.decideFast(snapshot('second'), undefined, { deadlineMs: 13_500 });
      let settled: 'answered' | 'expired' | null = null;
      void second.then(
        () => (settled = 'answered'),
        () => (settled = 'expired')
      );
      // Seven seconds in the queue behind the first job.
      await vi.advanceTimersByTimeAsync(7_000);
      worker.emitFastResult(1, 'first');
      await first;
      // The fixed window has passed for the second job: still alive, now posted.
      await vi.advanceTimersByTimeAsync(1_500);
      expect(settled).toBeNull();
      expect(client.status().lastExpiredRequestType).not.toBe('DECIDE_FAST');
      // Its answer lands inside the turn clock and is delivered.
      worker.emitFastResult(2, 'second');
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe('answered');
      expect(client.status().completedJobs).toBe(2);
      expect(client.status().lastExpiredRequestType).not.toBe('DECIDE_FAST');
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires a queued job at its own turn-clock deadline, and says which deadline it was', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const client = new LiveHorseDecisionWorkerClient({
        workerFactory: () => worker,
        jobTimeoutMs: 8_000,
        maxInFlight: 1,
      });
      worker.emitMessage(ready);
      const first = client.decideFast(snapshot('first'), undefined, { deadlineMs: 13_500 });
      const second = client.decideFast(snapshot('second'), undefined, { deadlineMs: 13_500 });
      const rejection = expect(second).rejects.toThrow(/expired after 13500ms/);
      await vi.advanceTimersByTimeAsync(7_000);
      worker.emitFastResult(1, 'first');
      await first;
      // 13.5 s from enqueue, still unanswered: the caller deadline, not the
      // fixed window and not the worker-integrity window, retires it.
      await vi.advanceTimersByTimeAsync(6_500);
      await rejection;
      await expect(second).rejects.toBeInstanceOf(HorseDecisionExpiredError);
      // (The client's own periodic STATUS jobs queue and expire behind the
      // occupied slot too, so the count is not asserted; the type is.)
      expect(client.status()).toMatchObject({
        lastExpiredRequestType: 'DECIDE_FAST',
        lastExpiredPhase: 'active',
      });
      // The posted-but-expired job is cancelled at the worker, not failed.
      expect(worker.sent.some((m) => (m as { type?: string }).type === 'CANCEL')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the fixed window for a caller that passes no deadline', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const client = new LiveHorseDecisionWorkerClient({
        workerFactory: () => worker,
        jobTimeoutMs: 8_000,
      });
      worker.emitMessage(ready);
      const pending = client.decideFast(snapshot('fixed-window'));
      const rejection = expect(pending).rejects.toThrow(/expired after 8000ms/);
      await vi.advanceTimersByTimeAsync(8_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a non-positive or non-finite deadline and keeps the fixed window', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const client = new LiveHorseDecisionWorkerClient({
        workerFactory: () => worker,
        jobTimeoutMs: 8_000,
      });
      worker.emitMessage(ready);
      const pending = client.decideFast(snapshot('bad-deadline'), undefined, {
        deadlineMs: Number.NaN,
      });
      const rejection = expect(pending).rejects.toThrow(/expired after 8000ms/);
      await vi.advanceTimersByTimeAsync(8_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
