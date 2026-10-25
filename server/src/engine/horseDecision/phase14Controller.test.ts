import { EventEmitter } from 'node:events';
import { LiveHorseDecisionWorkerClient, type WorkerLike } from './client.js';
import type { HorseDecisionWorkerRequest } from './protocol.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { HandController } from '../HandController.js';
import { Deck, calculateContestablePot } from '../PokerEngine.js';
import type { HandConfig, Card } from '../../types.js';
import { cards } from '../../services/horseCorrectiveReview/riverReference.test-support.js';
import { harness, request, run } from './phase14Worker.test-support.js';
import { now } from '../../services/horseCorrectiveReview/kernelApproval.test-support.js';
import { buildHorseDecisionKey } from './protocol.js';
import {
  createHorseExecutionWitness,
  settleHorseExecutionWitness,
  type HorseAcceptedAction,
} from '../HorseExecutionWitness.js';
import { HorsePhase8AuthorityGate } from '../HorseQualifiedAuthority.js';
import {
  horsePhase14ContinuationVersion,
  liveHorsePhase14Authorities,
} from '../HorsePhase14Authority.js';
import { CORRECTIVE_KERNEL_CATALOG_VERSION } from '../../services/horseCorrectiveReview/kernelCatalog.js';
import { recheckHorsePhase14BeforeAcceptance } from '../HorsePhase14Acceptance.js';
import { fastRandom } from '../HorseEval.js';
import { randomUUID } from 'node:crypto';
import { journalHash, makeHorseJournalRecord } from '../../services/horseDecisionJournal/record.js';
import { exactReplayHorseDecisionRecord } from './replay/exactReplay.js';
import { qualifiedReplayAdmissions } from './replay/qualifiedAuthority.js';
afterEach(() => vi.restoreAllMocks());
describe('Phase14 through an actual controller hand', () => {
  it.each([false, true])(
    'accepts only the authority-selected real controller action after pending IPC withdrawal=%s with chips conserved',
    async (withdrawPending) => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const prefix = cards('6s 6h 2s 3s Ac Kd 7h 8d 9c'),
        key = (c: Card) => c.rank + ':' + c.suit,
        used = new Set(prefix.map(key));
      // Only the synthetic deal is fixed; all betting, pot rights and acceptance
      // are the real HandController, not a mocked legalizer or answer.
      vi.spyOn(Deck.prototype, 'shuffle').mockImplementation(function (this: Deck) {
        Reflect.set(this, 'cards', [
          ...prefix,
          ...this.getRemainingCards().filter((c) => !used.has(key(c))),
        ]);
      });
      const source = request(),
        players = source.gameState.players.map((p) => ({
          ...p,
          stack: p.seat === 1 ? 200 : 75,
          bet: 0,
          totalInvested: 0,
          cards: [],
          is_all_in: false,
        }));
      const rakeConfig = { percent: 0, cap: 0, noFlopNoDrop: true };
      const hc = new HandController(
        {
          tableId: 'phase14-local-controller',
          handNumber: 1,
          gameVariant: 'nlh',
          smallBlind: 1,
          bigBlind: 2,
          rakeConfig,
        } as HandConfig,
        players,
        1
      );
      hc.start();
      expect(hc.performAction(1, 'raise', 25)).toBe(true);
      expect(hc.performAction(2, 'call')).toBe(true);
      for (let n = 0; n < 8 && hc.getState().stage !== 'river'; n++) {
        const s = hc.getState(),
          p = s.players.find((p) => p.seat === s.currentPlayerSeat)!,
          menu = hc.getAuthoritativeActionState(p.user_id)!;
        expect(hc.performAction(p.seat, menu.toCall > 0 ? 'call' : 'check')).toBe(true);
      }
      expect(hc.getState().stage).toBe('river');
      expect(hc.performAction(2, 'all_in')).toBe(true);
      const state = hc.getState(),
        hero = state.players.find((p) => p.seat === 1)!,
        menu = hc.getAuthoritativeActionState(hero.user_id)!;
      source.player = hero;
      source.gameState = {
        ...source.gameState,
        players: state.players.map((p) => ({ ...p, cards: [] })),
        stage: state.stage,
        communityCards: state.communityCards,
        communityCards2: state.communityCards2,
        communityCards3: state.communityCards3,
        actionHistory: state.actionHistory,
        legalActions: menu.legalActions,
        toCall: menu.toCall,
        minRaiseTo: menu.minRaiseTo,
        maxRaiseTo: menu.maxRaiseTo,
        currentBet: state.currentBet,
        pot: state.pot,
        pots: hc.computeLivePots(),
        contestablePot: calculateContestablePot(
          state.players,
          hero.user_id,
          Math.min(menu.toCall, hero.stack)
        ),
        rakeConfig,
        heroSeat: hero.seat,
        currentPlayerSeat: state.currentPlayerSeat,
        blindSeats: hc.getBlindSeatsSnapshot(),
        bettingStructure: menu.structure,
        fixedBetSize: menu.fixedBetSize,
        wagersCapped: menu.wagersCapped,
      };
      // Fixed synthetic fence selected once for a natural (<5%) sampler draw.
      // The test itself neither searches seeds nor overrides the actual RNG.
      source.fence = 'rollback-natural-1';
      source.decisionKey = buildHorseDecisionKey(source);
      const baseline = await run(harness(false), structuredClone(source));
      expect(baseline.decision.action).toBe('fold');
      const h = harness();
      h.deps.correctiveDraw = fastRandom;
      const gate = new HorsePhase8AuthorityGate(
        () => h.attachment.admission,
        undefined,
        horsePhase14ContinuationVersion('nlh-cash', CORRECTIVE_KERNEL_CATALOG_VERSION)
      );
      gate.refresh();

      vi.spyOn(liveHorsePhase14Authorities['nlh-cash'], 'check').mockImplementation((...args) =>
        gate.check(...args)
      );
      vi.spyOn(liveHorsePhase14Authorities['nlh-cash'], 'mainAuthority').mockImplementation(() =>
        gate.mainAuthority()
      );
      vi.spyOn(liveHorsePhase14Authorities['nlh-cash'], 'observeWorker').mockImplementation(
        (receipt) => gate.observeWorker(receipt)
      );
      vi.spyOn(liveHorsePhase14Authorities['nlh-cash'], 'stamp').mockImplementation((receipt) =>
        gate.stamp(receipt)
      );
      let candidateObserved = false;
      class PendingRuntimeTransport extends EventEmitter implements WorkerLike {
        private read = 0;
        constructor() {
          super();
          void h.runtime.start().then(() => this.flush());
        }
        private flush() {
          while (this.read < h.messages.length) {
            const message = structuredClone(h.messages[this.read++]);
            if (message.type === 'FAST_RESULT') {
              expect(message.decision.correctivePolicy?.applied).toBe(true);
              expect(message.decision.action).toBe('call');
              candidateObserved = true;
              // Result exists in native runtime but has not crossed IPC/main acceptance.
              if (withdrawPending) gate.withdraw('pending-ipc-controller-rollback');
            }
            this.emit('message', message);
          }
        }
        postMessage(message: HorseDecisionWorkerRequest) {
          h.runtime.receive(structuredClone(message));
          void h.runtime.drain().then(() => this.flush());
        }
        async terminate() {
          return 0;
        }
      }
      const transport = new PendingRuntimeTransport(),
        client = new LiveHorseDecisionWorkerClient({ workerFactory: () => transport });
      try {
        const fast = await client.decideFast(source);
        expect(candidateObserved).toBe(true);
        const selected = recheckHorsePhase14BeforeAcceptance(fast.decision),
          accepted: HorseAcceptedAction[] = [];
        const applied = hc.performAction(
          hero.seat,
          selected.action,
          selected.amount,
          'horse_policy',
          (record) => accepted.push({ record, intended: true })
        );
        settleHorseExecutionWitness(selected.executionWitness, {
          applied,
          acceptedActions: accepted,
        });
        expect(selected.executionWitness).toMatchObject({
          executionStatus: 'intended',
          phase14Authority: withdrawPending
            ? { selection: 'withdrawn_before_acceptance' }
            : { selection: 'controller_accepted', verdict: 'usable' },
        });
        expect(accepted).toHaveLength(1);
        expect(accepted[0].record).toMatchObject({
          action: withdrawPending ? 'fold' : 'call',
          amount: withdrawPending ? 0 : menu.toCall,
        });
        if (withdrawPending) {
          expect(selected.correctivePolicy).toMatchObject({
            applied: false,
            reason: 'withdrawn_before_acceptance',
          });
          expect(selected.executionWitness).toMatchObject({
            selected: { action: 'fold', amount: 0 },
            expectedExecutionAmount: 0,
          });
          expect(accepted.some((a) => a.record.action === 'call')).toBe(false);
        }
        expect(hc.getState().players.reduce((n, p) => n + p.stack, 0)).toBe(275);
        expect(fast.effects).toEqual([]);
        if (withdrawPending) {
          // Replay the immutable worker decision; the later main withdrawal is
          // an execution fact, not permission to rewrite the original answer.
          const runningSource = '5'.repeat(40),
            producerId = randomUUID();
          const handKey = journalHash('phase14-withdrawn-controller:' + source.decisionKey);
          const turnKey = journalHash(
            JSON.stringify([
              source.generation,
              source.fence,
              source.requestId,
              source.decisionKey,
              source.decisionTimeMs,
            ])
          );
          expect(h.records).toHaveLength(1);
          const original = makeHorseJournalRecord(
            {
              producerId,
              sequence: 1,
              atMs: now,
              sourceRelease: runningSource,
              kind: 'decision',
              handKey,
              turnKey,
            },
            h.records[0]
          );
          const execution = makeHorseJournalRecord(
            {
              producerId,
              sequence: 2,
              atMs: now + 1,
              sourceRelease: runningSource,
              kind: 'execution',
              handKey,
              turnKey,
            },
            selected.executionWitness
          );
          vi.spyOn(qualifiedReplayAdmissions, 'admitPhase14Attachment').mockImplementation(
            (domain) =>
              domain === 'nlh-cash'
                ? h.attachment
                : {
                    admission: { status: 'refused', reason: 'unselected', transient: false },
                    catalog: null,
                  }
          );
          const replayed = await exactReplayHorseDecisionRecord(original, {
            runningSource,
            execution,
            planReceipt: null,
          });
          expect(replayed, JSON.stringify(replayed)).toMatchObject({
            outcome: 'replayed_exact',
            replayVerified: true,
            original: { action: 'call', effects: 0 },
            replayed: { action: 'call', effects: 0 },
            acceptance: {
              status: 'joined',
              executionStatus: 'intended',
              selectedEqualsDecision: false,
              executed: { action: 'fold', amount: null },
              acceptedActions: 1,
              durableEffectReceipt: 'no_effects',
            },
          });
          expect(replayed.replayed?.rngAfter).toBe(replayed.original?.rngAfter);
        }
      } finally {
        await client.stop();
      }
    }
  );
});
