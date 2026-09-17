import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retireHorseExecutionWitness } from '../../../engine/HorseExecutionWitness.js';
import { HorseMind } from '../../../engine/HorseMind.js';
import { HandController } from '../../../engine/HandController.js';
import {
  LiveHorseDecisionWorkerClient,
  type WorkerLike,
} from '../../../engine/horseDecision/client.js';
import {
  buildHorseDecisionKey,
  type HorseDecisionWorkerRequest,
  type HorseDecisionWorkerResponse,
  type FastHorseDecisionRequest,
} from '../../../engine/horseDecision/protocol.js';
import { horsePlanHandKey } from '../../../engine/HorseDecisionEffects.js';
import { captureHorseHandJournalContext } from '../../../engine/HorseDecisionHandBinding.js';
import { seedFastRandom } from '../../../engine/HorseEval.js';
import type { ActionRecord } from '../../../types.js';
import { workerHarness, requestAt, tableId, heroId, wager } from './fixture.js';

class LocalTransport extends EventEmitter implements WorkerLike {
  readonly sent: HorseDecisionWorkerRequest[] = [];
  readonly harness: ReturnType<typeof workerHarness>;
  constructor(transform?: (message: HorseDecisionWorkerResponse) => HorseDecisionWorkerResponse) {
    super();
    this.harness = workerHarness({}, (message) => {
      const cloned = structuredClone(message);
      queueMicrotask(() => this.emit('message', transform ? transform(cloned) : cloned));
    });
  }
  postMessage(message: HorseDecisionWorkerRequest): void {
    this.sent.push(structuredClone(message));
    this.harness.runtime.receive(structuredClone(message));
  }
  async terminate(): Promise<number> {
    await this.harness.close();
    return 0;
  }
}

/** Real deal and accepted preflop actions; no post-deal state/payout injection.
 * Synthetic IDs/deck/outcomes do not establish DB acceptance or natural use. */
function dealtFlop() {
  const template = requestAt();
  const hc = new HandController(
    {
      tableId,
      handNumber: 1000100,
      gameVariant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    },
    template.gameState.players.map((p) => ({
      ...p,
      stack: 100,
      bet: 0,
      totalInvested: 0,
      cards: [],
    })),
    2
  );
  hc.start();
  for (let n = 0; n < 4 && hc.getState().stage === 'preflop'; n++) {
    const state = hc.getState(),
      actor = state.players.find((p) => p.seat === state.currentPlayerSeat)!;
    const legal = hc.getAuthoritativeActionState(actor.user_id)!;
    expect(
      hc.performAction(
        actor.seat,
        legal.toCall > 0 ? 'call' : 'check',
        legal.toCall > 0 ? state.currentBet : undefined
      )
    ).toBe(true);
  }
  const state = hc.getState();
  expect(state.stage).toBe('flop');
  expect(state.currentPlayerSeat).toBe(1);
  const player = state.players.find((p) => p.seat === 1)!,
    legal = hc.getAuthoritativeActionState(player.user_id)!;
  const contestablePot = hc.getContestablePotForCall(player.user_id);
  if (contestablePot === null) throw Error('Actual controller contestable pot unavailable');
  const request: FastHorseDecisionRequest = {
    ...template,
    player,
    handJournalContext: captureHorseHandJournalContext(state.actionHistory),
    gameState: {
      ...template.gameState,
      ...state,
      players: state.players.map((p) => ({ ...p, cards: [] })),
      heroSeat: player.seat,
      currentPlayerSeat: state.currentPlayerSeat,
      stateSchemaVersion: 1 as const,
      legalActions: legal.legalActions,
      toCall: legal.toCall,
      minRaiseTo: legal.minRaiseTo,
      maxRaiseTo: legal.maxRaiseTo,
      bettingStructure: legal.structure,
      fixedBetSize: legal.fixedBetSize,
      wagersCapped: legal.wagersCapped,
      commitmentCapRemaining: null,
      pots: hc.computeLivePots(),
      contestablePot,
    },
  };
  request.decisionKey = buildHorseDecisionKey(request);
  return { hc, request };
}
beforeEach(() => {
  HorseMind.reset();
  seedFastRandom(1111);
});
afterEach(() => {
  vi.restoreAllMocks();
  HorseMind.reset();
});
describe('actual local client/worker and controller acceptance composition', () => {
  it.each([false, true])(
    'retires unused finalized ownership with journal enabled=%s',
    async (journal) => {
      vi.stubEnv('HORSE_DECISION_JOURNAL_DIR', journal ? '/unused-fixture-journal' : '');
      const transport = new LocalTransport();
      const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => transport });
      try {
        await transport.harness.runtime.start();
        await client.ready();
        const fast = await client.decideFast(requestAt());
        retireHorseExecutionWitness(fast.decision.executionWitness, 'turn_abandoned');
        await transport.harness.runtime.drain();
        expect(transport.sent.filter((m) => m.type === 'RETIRE_DECISION_EFFECTS')).toHaveLength(1);
        expect(transport.harness.messages).toContainEqual(
          expect.objectContaining({
            type: 'ACK',
            operation: 'RETIRE_DECISION_EFFECTS',
            planDisposition: 'retired',
          })
        );
        expect(transport.sent.filter((m) => m.type === 'OBSERVE_EXECUTION')).toHaveLength(
          journal ? 1 : 0
        );
        await expect(client.commitDecisionEffects(fast)).rejects.toThrow(
          'no available client ownership'
        );
        expect(transport.harness.applied()).toBe(0);
      } finally {
        await client.stop();
        await transport.harness.close();
        vi.unstubAllEnvs();
      }
    }
  );
  it('transfers accepted ownership before witness finalization and completed FAST cancellation', async () => {
    const transport = new LocalTransport();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => transport });
    const abort = new AbortController();
    try {
      await transport.harness.runtime.start();
      await client.ready();
      const fast = await client.decideFast(requestAt(), abort.signal);
      abort.abort();
      const commit = client.runWithDispatchBarrier(() => {
        const pending = client.commitDecisionEffects(fast);
        retireHorseExecutionWitness(fast.decision.executionWitness, 'turn_abandoned');
        return pending;
      });
      await expect(commit).resolves.toMatchObject({ planDisposition: 'applied_volatile' });
      expect(transport.sent.filter((m) => m.type === 'RETIRE_DECISION_EFFECTS')).toHaveLength(0);
      await expect(client.commitDecisionEffects(fast)).resolves.toMatchObject({
        planDisposition: 'already_applied_volatile',
      });
      expect(transport.harness.applied()).toBe(1);
    } finally {
      await client.stop();
      await transport.harness.close();
    }
  });
  it.each([undefined, ['issued'], 'unknown', 'no_effects'])(
    'rejects malformed or contradictory issue disposition %s',
    async (disposition) => {
      const transport = new LocalTransport((m) =>
        m.type === 'FAST_RESULT' ? ({ ...m, planIssueDisposition: disposition } as any) : m
      );
      const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => transport });
      try {
        await transport.harness.runtime.start();
        await client.ready();
        await expect(client.decideFast(requestAt())).rejects.toThrow('invalid decision effects');
        expect(transport.harness.applied()).toBe(0);
      } finally {
        await client.stop();
        await transport.harness.close();
      }
    }
  );
  it.each(['empty_fast_pressure', 'elapsed_compute_ttl'] as const)(
    'keeps the original plan applicable after a real accepted wager despite %s',
    async (interleaving) => {
      const { hc, request } = dealtFlop();
      const transport = new LocalTransport();
      const client = new LiveHorseDecisionWorkerClient({
        workerFactory: () => transport,
        jobTimeoutMs: 5000,
      });
      try {
        await transport.harness.runtime.start();
        await client.ready();
        const fast = await client.decideFast(request);
        const key = fast.effects[0]!.handKey;
        if (interleaving === 'empty_fast_pressure') {
          transport.harness.deps.decide = () => wager();
          for (let n = 1; n <= 128; n++) {
            const unrelated = await client.decideFast(requestAt(n + 1, undefined, 1000100 + n));
            expect(unrelated.effects).toEqual([]);
          }
        } else transport.harness.advance(60001);
        const accepted: Readonly<ActionRecord>[] = [];
        expect(
          hc.performAction(
            1,
            fast.decision.action,
            fast.decision.amount,
            'horse_policy',
            (record) => accepted.push(record)
          )
        ).toBe(true);
        expect(accepted).toHaveLength(1);
        expect(accepted[0]).toMatchObject({
          action: fast.decision.action,
          amount: fast.decision.amount,
        });
        expect(HorseMind.getPlan(key, heroId)).toBeUndefined();
        await expect(
          client.runWithDispatchBarrier(() => client.commitDecisionEffects(fast))
        ).resolves.toMatchObject({ type: 'ACK', operation: 'COMMIT_DECISION_EFFECTS' });
        expect(transport.harness.applied()).toBe(1);
        expect(HorseMind.getPlan(key, heroId)).toBe(true);
      } finally {
        await client.stop();
        await transport.harness.close();
      }
    }
  );
  it.each(['exact', 'wrong_actor', 'coerced', 'mutated_batch'] as const)(
    'retains exact-wager authority and issued ownership for %s',
    async (mode) => {
      const { hc, request } = dealtFlop(),
        transport = new LocalTransport();
      if (mode === 'coerced')
        transport.harness.deps.decide = (player, gs, _s, _m, opts) => {
          HorseMind.notePlan(
            horsePlanHandKey(gs.actionHistory, opts?.mindPlanContext),
            player.user_id,
            true
          );
          return wager('bet', 6.009);
        };
      const client = new LiveHorseDecisionWorkerClient({
        workerFactory: () => transport,
        jobTimeoutMs: 5000,
      });
      try {
        await transport.harness.runtime.start();
        await client.ready();
        const fast = await client.decideFast(request),
          key = fast.effects[0]!.handKey;
        expect(HorseMind.getPlan(key, heroId)).toBeUndefined();
        const accepted: Readonly<ActionRecord>[] = [];
        const applied = hc.performAction(
          mode === 'wrong_actor' ? 2 : 1,
          fast.decision.action,
          fast.decision.amount,
          'horse_policy',
          (r) => accepted.push(r)
        );
        const exact =
          applied &&
          accepted.length === 1 &&
          accepted[0]!.action === fast.decision.action &&
          accepted[0]!.amount === fast.decision.amount;
        if (mode === 'mutated_batch') (fast.effects[0] as any).barrelIntent = false;
        // This is an explicit fixture composition of the accepted-record gate.
        // Actual Turns invocation remains covered by its separately migrated suite.
        if (exact) {
          const commit = client.runWithDispatchBarrier(() => client.commitDecisionEffects(fast));
          if (mode === 'mutated_batch') await expect(commit).rejects.toThrow('effects_mismatch');
          else
            await expect(commit).resolves.toMatchObject({
              type: 'ACK',
              operation: 'COMMIT_DECISION_EFFECTS',
            });
        }
        expect(transport.harness.applied()).toBe(mode === 'exact' ? 1 : 0);
        expect(HorseMind.getPlan(key, heroId)).toBe(mode === 'exact' ? true : undefined);
        const commitRequest = transport.sent.find((m) => m.type === 'COMMIT_DECISION_EFFECTS');
        if (mode === 'exact' || mode === 'mutated_batch')
          expect(commitRequest).toMatchObject({ requestId: 2, planBinding: { fastRequestId: 1 } });
        else expect(commitRequest).toBeUndefined();
      } finally {
        await client.stop();
        await transport.harness.close();
      }
    }
  );
  it.each(['missing', 'other_actor', 'other_table'] as const)(
    'rejects the altered %s FAST binding at the actual client before it becomes a witness',
    async (fault) => {
      const transport = new LocalTransport((message) => {
        if (message.type !== 'FAST_RESULT') return message;
        const altered: any = message;
        if (fault === 'missing') delete altered.planBinding;
        if (fault === 'other_actor') altered.planBinding.actorId = 'unissued';
        if (fault === 'other_table')
          altered.planBinding.planContext.hand.tableId = '66666666-6666-4666-8666-666666666666';
        return altered;
      });
      const client = new LiveHorseDecisionWorkerClient({
        workerFactory: () => transport,
        jobTimeoutMs: 5000,
      });
      try {
        await transport.harness.runtime.start();
        await client.ready();
        await expect(client.decideFast(requestAt())).rejects.toThrow('invalid decision effects');
        expect(client.status().phase).toBe('failed');
        expect(transport.harness.applied()).toBe(0);
      } finally {
        await client.stop();
        await transport.harness.close();
      }
    }
  );
});
