import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import { LiveHorseDecisionWorkerClient, type WorkerLike } from './client.js';
import { HORSE_HISTORY_RETRY_COOLDOWN_MS } from './ownPublicHistory.js';
import { horseJournalJson } from '../../services/horseDecisionJournal/record.js';
import type {
  HorseDecisionWorkerRequest,
  HorseDecisionWorkerResponse,
  CompletedHandObservation,
} from './protocol.js';
import { buildHorseDecisionKey } from './protocol.js';
import { captureHorseHandJournalContext } from '../HorseDecisionHandBinding.js';
import { horseObserverReadContextFromRequest } from '../HorseObserverReadContext.js';
import { horseObserverReadsWereIndependent } from '../HorseObserverReadEvidence.js';
import { HorseLogic } from '../HorseLogic.js';
import { HorseMind } from '../HorseMind.js';
import { winnerReadout } from '../HorseWinnerRead.js';
import {
  workerHarness,
  requestAt,
  heroId,
  opponentId,
  tableId,
  lease,
} from '../../testing/horseRegression/plan/fixture.js';

it.each([
  { overlap: false, failed: false },
  { overlap: true, failed: false },
  { overlap: false, failed: true },
  { overlap: true, failed: true },
])(
  'restores only own public history before real HorseLogic, preserves live tails and deduplicates case=%j',
  async ({ overlap, failed }) => {
    const reads: Array<{ hands: number; folds: number; wins: number; recentFolds: number }> = [];
    class LocalWorker extends EventEmitter implements WorkerLike {
      readonly sent: HorseDecisionWorkerRequest[] = [];
      readonly h = workerHarness(
        {
          decide: (...args) => {
            const decision = HorseLogic.decide(...args);
            reads.push({
              hands: HorseMind.getStats(opponentId)?.hands ?? 0,
              folds: HorseMind.getStats(opponentId)?.folds ?? 0,
              wins: winnerReadout(opponentId)?.effectiveHands ?? 0,
              recentFolds: HorseMind.getStats(opponentId)?.rFolds ?? 0,
            });
            return decision;
          },
        },
        (m) => queueMicrotask(() => this.emit('message', structuredClone(m)))
      );
      postMessage(m: HorseDecisionWorkerRequest) {
        this.sent.push(structuredClone(m));
        this.h.runtime.receive(structuredClone(m));
      }
      async terminate() {
        await this.h.close();
        return 0;
      }
    }
    const worker = new LocalWorker();
    let resolve!: (v: unknown) => void;
    const pending = new Promise<unknown>((r) => {
      resolve = r;
    });
    let loads = 0;
    const client = new LiveHorseDecisionWorkerClient({
      workerFactory: () => worker,
      ownPublicHistory: () =>
        ++loads === 1 && failed ? Promise.reject(Error('temporary read failure')) : pending,
      jobTimeoutMs: 5000,
    });
    const first = requestAt(1, tableId, 1000100);
    const t = Date.now() - 1000;
    first.gameState.actionHistory!.forEach((a, i) => {
      a.timestamp = t + i;
    });
    first.handJournalContext = captureHorseHandJournalContext(first.gameState.actionHistory!);
    // A load can settle after its original decision snapshot under CPU load.
    // Keep failed cases behind the real clock to exercise that ordering.
    first.decisionTimeMs = Date.now() + (failed ? -200 : 100);
    first.decisionKey = buildHorseDecisionKey(first);
    const context = horseObserverReadContextFromRequest(first)!;
    const completed: CompletedHandObservation = {
      generation: 1000100,
      fence: `${tableId}:1000100:${lease}:observe`,
      handKey: `${tableId}:1000100`,
      committedHandId: '55555555-5555-4555-8555-555555555555',
      bigBlind: 2,
      scope: 'holdem:hu',
      showdown: null,
      actions: [
        ...first.gameState.actionHistory!,
        { seat: 1, userId: heroId, action: 'bet', amount: 2, stage: 'flop', timestamp: t + 2 },
        { seat: 2, userId: opponentId, action: 'fold', amount: 0, stage: 'flop', timestamp: t + 3 },
      ],
      results: [
        { user_id: heroId, net: 2 },
        { user_id: opponentId, net: -2 },
      ],
    };
    const historic = {
      handId: '66666666-6666-4666-8666-666666666666',
      tableId,
      handNumber: 1000099,
      observerId: heroId,
      observerSeat: 1,
      position: 'BTN',
      playersDealt: 2,
      variant: 'nlh',
      format: 'cash',
      playedAtMs: t - 1000,
      bigBlind: 2,
      actions: [
        {
          seat: 1,
          userId: heroId,
          action: 'raise',
          amount: 6,
          stage: 'preflop',
          timestamp: t - 2000,
          isFullRaise: true,
        },
        {
          seat: 2,
          userId: opponentId,
          action: 'fold',
          amount: 0,
          stage: 'preflop',
          timestamp: t - 1999,
        },
      ],
      results: completed.results,
    };
    const histories = Array.from({ length: 32 }, (_, i) => ({
      ...historic,
      handId: `66666666-6666-4666-8666-${String(i + 1).padStart(12, '0')}`,
      handNumber: 1000060 + i,
      playedAtMs: t - 1000 + i * 10,
      actions: [
        {
          seat: 1,
          userId: heroId,
          action: 'raise',
          amount: 6,
          stage: 'preflop',
          timestamp: t - 1005 + i * 10,
          isFullRaise: true,
        },
        {
          seat: 2,
          userId: opponentId,
          action: i < 16 ? 'fold' : 'call',
          amount: i < 16 ? 0 : 6,
          stage: 'preflop',
          timestamp: t - 1004 + i * 10,
        },
      ],
    }));
    try {
      await worker.h.runtime.start();
      await client.ready();
      await client.decideFast(first);
      const firstCapture = JSON.parse(horseJournalJson(worker.h.captures.at(-1)!));
      expect(firstCapture.snapshot.ownPublicHistoryProvenance).toMatchObject({
        version: 1,
        context,
        decisionTimeMs: first.decisionTimeMs,
        state: 'pending',
        reason: 'loading',
      });
      expect(reads[0]).toMatchObject({ hands: 1, folds: 0, wins: 0 });
      let latestDecisionTimeMs = first.decisionTimeMs;
      if (failed) {
        await new Promise<void>((r) => setImmediate(r));
        const unavailable = { ...first, requestId: 10, decisionTimeMs: first.decisionTimeMs + 1 };
        unavailable.decisionKey = buildHorseDecisionKey(unavailable);
        await client.decideFast(unavailable);
        expect(loads).toBe(1);
        expect(worker.sent.filter((m) => m.type === 'DECIDE_FAST').at(-1)).toMatchObject({
          ownPublicHistoryState: 'unavailable',
        });
        // The cache's cooldown starts when the failed load settles, not at
        // the earlier snapshot. This request observes that settled state.
        const retry = {
          ...first,
          requestId: 11,
          decisionTimeMs: Date.now() + HORSE_HISTORY_RETRY_COOLDOWN_MS,
        };
        latestDecisionTimeMs = retry.decisionTimeMs;
        retry.decisionKey = buildHorseDecisionKey(retry);
        await client.decideFast(retry);
        expect(loads).toBe(2);
      }
      await client.observeCompletedHand(completed);
      resolve({
        version: 1,
        source: 'original_dealt_public_v1',
        context,
        capped: false,
        hands: [
          ...histories,
          ...(overlap
            ? [
                {
                  ...historic,
                  handId: completed.committedHandId,
                  handNumber: 1000100,
                  playedAtMs: t + 4,
                  actions: completed.actions,
                  results: completed.results,
                },
              ]
            : []),
        ],
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      const next = requestAt(3, tableId, 1000101);
      next.gameState.actionHistory!.forEach((a, i) => {
        a.timestamp = t + 100 + i;
      });
      next.handJournalContext = captureHorseHandJournalContext(next.gameState.actionHistory!);
      next.decisionTimeMs = Math.max(latestDecisionTimeMs + 1, Date.now() + 100);
      next.decisionKey = buildHorseDecisionKey(next);
      const result = await client.decideFast(next);
      expect(reads[failed ? 3 : 1]).toMatchObject({ hands: 34, folds: 17, recentFolds: 9 });
      expect(reads[failed ? 3 : 1].wins).toBeGreaterThan(32);
      expect(reads[failed ? 3 : 1].wins).toBeLessThanOrEqual(33);
      const capture = worker.h.captures.at(-1)!;
      const retainedCapture = JSON.parse(horseJournalJson(capture));
      expect(retainedCapture.snapshot.ownPublicHistoryProvenance).toMatchObject({
        version: 1,
        context,
        decisionTimeMs: next.decisionTimeMs,
        state: 'available',
        reason: 'packet_ready',
      });
      expect(firstCapture.snapshot.ownPublicHistoryProvenance.reason).toBe('loading');
      expect(capture.observerReads).toMatchObject({
        version: 2,
        history: 'own_public_window',
        historyHands: overlap ? 33 : 32,
        historyCapped: false,
      });
      expect(horseObserverReadsWereIndependent(capture.observerReads, next)).toBe(true);
      expect(result.observerHistoryAckDigest).toMatch(/^[a-f0-9]{64}$/);
      next.requestId++;
      await client.decideFast(next);
      expect(reads[failed ? 4 : 2]).toMatchObject({ hands: 34, folds: 17, recentFolds: 9 });
      expect(
        worker.sent
          .filter((m) => m.type === 'DECIDE_FAST')
          .map((m) => (m as any).ownPublicHistory !== undefined)
      ).toEqual(failed ? [false, false, false, true, false] : [false, true, false]);
      expect(HorseMind.getStats(opponentId)).toBeUndefined();
    } finally {
      await client.stop();
      await worker.h.close();
      HorseMind.reset();
    }
  }
);
