import { captureHorseHandJournalContext } from '../HorseDecisionHandBinding.js';
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
vi.mock('node:os', async (load) => ({
  ...(await load<typeof import('node:os')>()),
  availableParallelism: () => 8,
}));
import { LiveHorseDecisionWorkerPool, horseDecisionShard } from './lane.js';
import type { WorkerLike } from './client.js';
import type {
  HorseDecisionWorkerRequest,
  HorseDecisionWorkerResponse,
  CompletedHandObservation,
} from './protocol.js';
import { buildHorseDecisionKey } from './protocol.js';
import {
  workerHarness,
  requestAt,
  inspectObserverReads,
  heroId,
  opponentId,
  lease,
} from '../../testing/horseRegression/plan/fixture.js';
import { HorseMind } from '../HorseMind.js';

class LocalWorker extends EventEmitter implements WorkerLike {
  readonly h = workerHarness({}, (m: HorseDecisionWorkerResponse) =>
    queueMicrotask(() => this.emit('message', structuredClone(m)))
  );
  postMessage(m: HorseDecisionWorkerRequest) {
    this.h.runtime.receive(structuredClone(m));
  }
  async terminate() {
    await this.h.close();
    return 0;
  }
}
it.each(['validated', 'rejected'] as const)(
  'routes only the %s original observer across table shards, with no other horse inheriting reads',
  async (caseName) => {
    const transports: LocalWorker[] = [];
    const pool = new LiveHorseDecisionWorkerPool({
      workers: 2,
      journalCapacity: { shards: 2 },
      workerFactory: () => {
        const w = new LocalWorker();
        transports.push(w);
        return w;
      },
    });
    const tables = Array.from(
      { length: 50 },
      (_, i) => `33333333-3333-4333-8333-${String(i + 1).padStart(12, '0')}`
    );
    const aTable = tables.find((t) => horseDecisionShard(`${t}:1000100:1:${lease}:100`, 2) === 0)!;
    const bTable = tables.find((t) => horseDecisionShard(`${t}:1000100:1:${lease}:100`, 2) === 1)!;
    const a = requestAt(1, aTable, 1000100),
      b = requestAt(2, bTable, 1000101),
      c = requestAt(3, bTable, 1000102);
    c.player.user_id = '77777777-7777-4777-8777-777777777777';
    c.gameState.players[0].user_id = c.player.user_id;
    c.gameState.pots![0].eligiblePlayers[0] = c.player.user_id;
    c.gameState.actionHistory![0].userId = c.player.user_id;
    // Each turn is an original synthetic participant snapshot, not a DB/natural-use claim.
    for (const r of [a, b, c]) {
      r.handJournalContext = captureHorseHandJournalContext(r.gameState.actionHistory!);
      r.decisionTimeMs = Date.now() + 100000;
      r.decisionKey = buildHorseDecisionKey(r);
    }
    try {
      await Promise.all(transports.map((t) => t.h.runtime.start()));
      await pool.ready();
      await pool.decideFast(b);
      await pool.decideFast(c);
      if (caseName === 'rejected') {
        a.player.cards = [];
        a.decisionKey = buildHorseDecisionKey(a);
        await expect(pool.decideFast(a)).rejects.toThrow();
      } else await pool.decideFast(a);
      const observation: CompletedHandObservation = {
        generation: 1000100,
        fence: `${aTable}:1000100:${lease}:observe`,
        handKey: `${aTable}:1000100`,
        committedHandId: '55555555-5555-4555-8555-555555555555',
        bigBlind: 2,
        scope: 'holdem:hu',
        showdown: null,
        actions: [
          ...a.gameState.actionHistory!,
          {
            seat: 1,
            userId: heroId,
            action: 'bet',
            amount: 2,
            stage: 'flop',
            timestamp: 1700009000020,
          },
          {
            seat: 2,
            userId: opponentId,
            action: 'fold',
            amount: 0,
            stage: 'flop',
            timestamp: 1700009000030,
          },
        ],
        results: [
          { user_id: heroId, net: 2 },
          { user_id: opponentId, net: -2 },
        ],
        // Caller-supplied enrollment is ignored; the pool owns original presence.
        observerParticipants: {
          version: 1,
          handKey: `${aTable}:1000100:${lease}`,
          status: 'bound',
          contexts: [
            {
              version: 1,
              observerId: c.player.user_id,
              variant: 'nlh',
              format: 'cash',
              dealtCount: 2,
            },
          ],
        },
      };
      await pool.observeCompletedHand(observation);
      await Promise.all(transports.map((t) => t.h.runtime.drain()));
      if (caseName === 'validated')
        expect(
          inspectObserverReads(
            transports[0].h.runtime,
            a,
            () => HorseMind.getStats(opponentId)?.folds
          )
        ).toBe(1);
      expect(
        inspectObserverReads(
          transports[1].h.runtime,
          b,
          () => HorseMind.getStats(opponentId)?.folds ?? 0
        )
      ).toBe(caseName === 'validated' ? 1 : 0);
      await pool.observeCompletedHand(observation);
      await Promise.all(transports.map((t) => t.h.runtime.drain()));
      expect(
        inspectObserverReads(
          transports[1].h.runtime,
          b,
          () => HorseMind.getStats(opponentId)?.folds ?? 0
        )
      ).toBe(caseName === 'validated' ? 1 : 0);
      expect(
        inspectObserverReads(
          transports[1].h.runtime,
          c,
          () => HorseMind.getStats(opponentId)?.folds ?? 0
        )
      ).toBe(0);
      expect(HorseMind.getStats(opponentId)).toBeUndefined();
    } finally {
      await pool.stop();
      HorseMind.reset();
    }
  }
);
