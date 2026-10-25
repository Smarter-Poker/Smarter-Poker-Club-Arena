import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: () => {
      throw Error('Unexpected database access');
    },
    rpc: () => {
      throw Error('Unexpected database RPC');
    },
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import {
  HorseDecisionJournalPublisher,
  type HorseJournalWorker,
} from '../services/HorseDecisionJournal.js';
import { HorseDecisionJournalStore } from '../services/horseDecisionJournal/store.js';
import { runtimeHorseJournalArchiveOptions } from '../services/horseDecisionJournal/config.js';
import { readHorseJournalHand } from '../services/horseDecisionJournal/review.js';
import { journalHash } from '../services/horseDecisionJournal/record.js';
import {
  anchorHorseDecisionHand,
  horseHandAnchorKey,
  horseCompletedHandKey,
} from '../engine/HorseDecisionHandBinding.js';
import { LiveHorseDecisionWorkerPool } from '../engine/horseDecision/lane.js';
import {
  HorseDecisionWorkerRuntime,
  defaultHorseDecisionWorkerDependencies as defaults,
} from '../engine/horseDecision/workerRuntime.js';
import type {
  HorseDecisionWorkerRequest,
  CompletedHandObservation,
} from '../engine/horseDecision/protocol.js';
import { HorseMind } from '../engine/HorseMind.js';
import { DeadlineScheduler } from '../engine/DeadlineScheduler.js';
import { PreciseActionTimer } from '../engine/PreciseActionTimer.js';
import { bindLightningHorseObservationIdentity } from '../engine/HorseObservationIdentity.js';
import { resetWinnerReads, winnerReadout } from '../engine/HorseWinnerRead.js';
import { buildHost, formedHand, flush, uid, HOST_TABLE } from '../testing/lightningHostTestKit.js';
import type { LightningCallOutcome } from './LightningHandBackend.js';
const folders: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  HorseMind.reset();
  resetWinnerReads();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const turn = (x: any) =>
  JSON.stringify([x.generation, x.fence, x.requestId, x.decisionKey, x.decisionTimeMs]);
class StoreTransport extends EventEmitter implements HorseJournalWorker {
  constructor(readonly store: HorseDecisionJournalStore) {
    super();
  }
  postMessage(message: Parameters<HorseJournalWorker['postMessage']>[0]) {
    if (message.type === 'APPEND') {
      const results = this.store.appendBatch(message.records);
      queueMicrotask(() =>
        this.emit('message', {
          type: 'ACK',
          receipts: message.records.map((r, i) => ({
            eventId: r.eventId,
            sha256: r.sha256,
            status: results[i],
          })),
        })
      );
    } else if (message.type === 'STOP')
      queueMicrotask(() => this.emit('message', { type: 'STOPPED' }));
  }
  async terminate() {
    return 0;
  }
}
function connectedLane(
  publisher: HorseDecisionJournalPublisher,
  observations: CompletedHandObservation[],
  requests: string[] = []
) {
  const runtimes: HorseDecisionWorkerRuntime[] = [];
  class ComputeTransport extends EventEmitter {
    readonly runtime: HorseDecisionWorkerRuntime;
    constructor() {
      super();
      this.runtime = new HorseDecisionWorkerRuntime(
        (message) => queueMicrotask(() => this.emit('message', structuredClone(message))),
        {
          ...defaults,
          startServices: async () => defaults.workerReadiness(),
          stopServices: async () => {},
          journalEnabled: () => true,
          ownsCompletedHand: () => true,
          noteFeature: () => {},
          noteDecision: () => {},
          journalLifecycle: (request, lifecycle) => publisher.requestLifecycle(request, lifecycle),
          journalDecision: (request, capture) => {
            const a = anchorHorseDecisionHand(request);
            publisher.record(
              'decision',
              a.status === 'anchored' ? horseHandAnchorKey(a) : null,
              turn(request),
              capture
            );
          },
          journalExecution: (w) =>
            publisher.record(
              'execution',
              w.handAnchor.status === 'anchored' ? horseHandAnchorKey(w.handAnchor) : null,
              turn(w.identity),
              w
            ),
          journalAcceptedHand: (hand) => {
            observations.push(hand);
            const key = horseCompletedHandKey(hand);
            publisher.record('accepted_hand', key, key ?? 'unavailable', hand);
          },
          journalPlanReceipt: (request, receipt) => {
            const a = anchorHorseDecisionHand(request);
            publisher.record(
              'plan_receipt',
              a.status === 'anchored' ? horseHandAnchorKey(a) : null,
              turn(request),
              receipt
            );
          },
        }
      );
      runtimes.push(this.runtime);
      queueMicrotask(() => void this.runtime.start());
    }
    postMessage(message: HorseDecisionWorkerRequest) {
      if (message.type === 'DECIDE_FAST') requests.push(message.fence);
      this.runtime.receive(structuredClone(message));
    }
    async terminate() {
      this.emit('exit', 0);
      return 0;
    }
  }
  const lane = new LiveHorseDecisionWorkerPool({
    workers: 1,
    journalCapacity: { shards: 1 },
    workerFactory: () => new ComputeTransport(),
    readyTimeoutMs: 5000,
    jobTimeoutMs: 10000,
  });
  return { lane, runtimes };
}
it.each([
  { replay: false, legacy: false, noFacts: false, count: 2 },
  { replay: true, legacy: false, noFacts: false, count: 2 },
  { replay: true, legacy: true, noFacts: false, count: 2 },
  { replay: true, legacy: true, noFacts: true, count: 2 },
  { replay: false, legacy: false, noFacts: false, count: 6 },
])(
  'actual Lightning Host -> worker -> controller -> durable journal (replay=$replay legacy=$legacy noFacts=$noFacts)',
  async ({ replay, legacy, noFacts, count }) => {
    const dir = mkdtempSync(join(tmpdir(), 'lightning-journal-'));
    folders.push(dir);
    vi.stubEnv('HORSE_DECISION_JOURNAL_DIR', dir);
    const store = new HorseDecisionJournalStore(dir, {
      archive: runtimeHorseJournalArchiveOptions(dir, {}),
    });
    const writer = new StoreTransport(store),
      publisher = new HorseDecisionJournalPublisher(writer, () => {});
    writer.emit('message', { type: 'READY' });
    const observed: CompletedHandObservation[] = [];
    const requests: string[] = [];
    const { lane, runtimes } = connectedLane(publisher, observed, requests);
    await lane.ready();
    // Host and PreciseActionTimer capture their clock at construction. Keep
    // them and the scheduler on one isolated clock before constructing either.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const clock = () => Date.now();
    const scheduler = new DeadlineScheduler({ now: clock });
    const timer = new PreciseActionTimer(undefined, scheduler, clock);
    const formed = formedHand(count, 81000),
      original = uid(4242);
    let generation = original;
    const host = buildHost(formed, Array(count).fill(40), {
      horses: new Set(formed.players),
      rules: noFacts ? {} : { club_id: uid(91000) },
      lease: () => ({ instance: 'test-instance', generation }),
      deps: { horseLane: () => lane, random: () => 0.5, now: clock, timer },
    });
    const settle = host.backend.settle.bind(host.backend);
    let accepted:
      | LightningCallOutcome<{
          handHistoryId: string;
          receiptHash: string | null;
          acceptedLeaseGeneration?: string | null;
        }>
      | undefined;
    let forged = false;
    const factsFor = (host.host as any).statsFactsFor.bind(host.host);
    (host.host as any).statsFactsFor = async (...args: any[]) => {
      const facts = await factsFor(...args);
      for (const action of (host.host as any).actions) {
        if (!action.publicNode) continue;
        action.observationIdentity = {
          version: 1,
          status: 'bound',
          observationId: 'forged-observation',
          sessionKey: 'forged-session',
        };
        forged = true;
      }
      return facts;
    };
    host.backend.settle = async (args) => {
      if (accepted) return structuredClone(accepted);
      const out = await settle(args);
      if (!out.ok) return out;
      const acceptedActions = args.handRow.actions as any[];
      for (const [ordinal, action] of acceptedActions.entries()) {
        if (!action.publicNode) continue;
        const identity = action.observationIdentity;
        expect(identity).not.toMatchObject({
          observationId: 'forged-observation',
          sessionKey: 'forged-session',
        });
        if (noFacts) {
          expect(identity.status).toBe('unavailable');
          continue;
        }
        if (identity.status === 'unavailable') {
          expect(identity.reason).toMatch(
            /non_voluntary_origin|action_node_mismatch|unavailable_public_node/
          );
          continue;
        }
        expect(identity.observationId).toBe(`${formed.handId}:${ordinal}`);
        const expected = journalHash(
          JSON.stringify([
            'horse-lightning-observation-session-v1',
            HOST_TABLE,
            action.userId,
            uid(5000 + formed.players.indexOf(action.userId)),
          ])
        );
        if (!noFacts) expect(identity.sessionKey).toBe(expected);
      }
      if (!noFacts)
        expect(
          (args.handRow._accepted_post_commit_facts as any)?.stats_facts?.facts[0]?.hand_id
        ).toBe(formed.handId);
      out.value.handHistoryId = noFacts ? uid(7777) : formed.handId;
      if (legacy) out.value.acceptedLeaseGeneration = null;
      accepted = out;
      if (!replay) return out;
      generation = uid(4243);
      return { ok: false, reason: 'unknown_after_original_commit', transport: true };
    };
    try {
      const clockBefore = (host.host as any).now();
      await vi.advanceTimersByTimeAsync(25);
      expect((host.host as any).now()).toBe(clockBefore + 25);
      expect((timer as any).now()).toBe(clockBefore + 25);
      await host.host.start();
      for (let i = 0; i < 4000 && host.host.lifecycle !== 'complete'; i++) {
        await flush(8);
        await vi.advanceTimersByTimeAsync(25);
      }
      expect(host.host.lifecycle).toBe('complete');
      for (const runtime of runtimes) await runtime.drain();
      await flush(20);
      expect(observed).toHaveLength(1);
      if (legacy) {
        expect(observed[0]!.fence).toContain(':unleased:observe');
        expect(horseCompletedHandKey(observed[0]!)).toBeNull();
        expect(formed.players.some((id) => (winnerReadout(id)?.effectiveHands ?? 0) > 0)).toBe(
          true
        );
      } else {
        expect(observed[0]!.fence).toContain(`:${original}:observe`);
        const key = journalHash(horseCompletedHandKey(observed[0]!)!);
        const review = readHorseJournalHand(dir, key);
        expect(
          review,
          JSON.stringify(
            observed[0]!.actions!.map(({ action, origin, stage, amount }) => ({
              action,
              origin,
              stage,
              amount,
            }))
          )
        ).toMatchObject({ status: 'reconciled', gaps: [] });
        expect(review.matchedActions).toBeGreaterThan(0);
        expect(review.matchedActions).toBe(review.acceptedHorseActions);
      }
      expect(host.scoreboard).toHaveLength(1);
      expect(forged).toBe(true);
      if (count === 6) {
        expect(requests.some((fence) => fence.endsWith(':early'))).toBe(true);
        const action = observed[0]!.actions!.find(
          (a: any) => a.observationIdentity?.status === 'bound'
        ) as any;
        expect(action).toBeDefined();
        const ordinal = observed[0]!.actions!.indexOf(action);
        const originalIdentity = bindLightningHorseObservationIdentity(action, ordinal, {
          handId: formed.handId,
          tableId: HOST_TABLE,
          poolSessionId: uid(5000 + formed.players.indexOf(action.userId)),
        });
        expect(originalIdentity).toEqual(action.observationIdentity);
        const later = bindLightningHorseObservationIdentity(action, ordinal, {
          handId: formed.handId,
          tableId: HOST_TABLE,
          poolSessionId: uid(6999),
        });
        expect(later).toMatchObject({ observationId: action.observationIdentity.observationId });
        expect(later).not.toEqual(originalIdentity);
      }
      expect(JSON.stringify(host.hub.frames)).not.toContain('accepted_lease_generation');
    } finally {
      scheduler.stop();
      await lane.stop();
      await publisher.stop();
      store.close();
    }
  },
  30000
);

// Request identity changes; the authored policy stream must not change.
import { decisionRequest } from '../testing/horseRegression/plan/fixture.js';
import {
  buildHorseDecisionKey,
  validatedHorsePolicySamplingKey,
} from '../engine/horseDecision/protocol.js';
import { captureHorseHandJournalContext } from '../engine/HorseDecisionHandBinding.js';
it('journal-only Lightning owner context preserves exact policy key, real action/amount and RNG receipts', async () => {
  const clean = decisionRequest();
  const physical = clean.fence.split(':');
  clean.fence = [physical[0], physical[1], clean.player.seat, clean.generation].join(':');
  clean.handJournalContext = captureHorseHandJournalContext(clean.gameState.actionHistory!);
  clean.decisionKey = buildHorseDecisionKey(clean);
  const bound = {
    ...clean,
    handJournalContext: {
      ...clean.handJournalContext!,
      lightningIdentity: { version: 1 as const, leaseGeneration: physical[3]! },
    },
  };
  bound.decisionKey = buildHorseDecisionKey(bound);
  expect(bound.decisionKey).not.toBe(clean.decisionKey);
  expect(Buffer.from(validatedHorsePolicySamplingKey(bound))).toEqual(
    Buffer.from(validatedHorsePolicySamplingKey(clean))
  );
  const answers: any[] = [];
  for (const request of [clean, bound]) {
    const messages: any[] = [];
    const runtime = new HorseDecisionWorkerRuntime((m) => messages.push(m), {
      ...defaults,
      startServices: async () => defaults.workerReadiness(),
      stopServices: async () => {},
      journalEnabled: () => false,
      journalLifecycle: undefined,
      journalDecision: undefined,
      noteFeature: () => {},
      noteDecision: () => {},
    });
    await runtime.start();
    runtime.receive({ ...request, type: 'DECIDE_FAST', requestId: 1 });
    await runtime.drain();
    const fast = messages.find((m) => m.type === 'FAST_RESULT');
    expect(fast).toBeDefined();
    answers.push({
      action: fast.decision.action,
      amount: fast.decision.amount,
      rngBefore: fast.rngBefore,
      rngAfter: fast.rngAfter,
    });
  }
  expect(answers[1]).toEqual(answers[0]);
  expect(anchorHorseDecisionHand(bound)).toMatchObject({
    status: 'anchored',
    leaseGeneration: physical[3],
  });
  const early = { ...bound, fence: bound.fence + ':early' };
  expect(anchorHorseDecisionHand(early).status).toBe('anchored');
  const bad: any[] = [
    undefined,
    null,
    { version: 2, leaseGeneration: physical[3] },
    { version: 1, leaseGeneration: null },
    { version: 1, leaseGeneration: 'forged' },
    { version: 1, leaseGeneration: physical[3], forged: true },
  ];
  for (const identity of bad) {
    const candidate = {
      ...bound,
      handJournalContext: { ...bound.handJournalContext, lightningIdentity: identity },
    };
    expect(anchorHorseDecisionHand(candidate).status).toBe('unavailable');
  }
  expect(anchorHorseDecisionHand({ ...bound, fence: bound.fence + ':wrong-tag' }).status).toBe(
    'unavailable'
  );
  expect(
    anchorHorseDecisionHand({
      ...bound,
      handJournalContext: { ...bound.handJournalContext, extra: true },
    } as any).status
  ).toBe('unavailable');
});

it('an accepted off-turn fold captures its actual legal public menu without moving the current actor', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const formed = formedHand(6, 82000);
  const host = buildHost(formed, Array(6).fill(40));
  await host.host.start();
  const controller = (host.host as any).hc;
  const state = controller.getState();
  const originalTurn = state.currentPlayerSeat;
  const actor = state.players.find(
    (p: any) => p.seat !== originalTurn && !p.is_folded && p.stack > 0 && state.currentBet > p.bet
  );
  const accepted: any[] = [];
  expect(
    controller.performImmediateFold(actor.seat, 'horse_policy', (record: any) =>
      accepted.push(record)
    )
  ).toBe(true);
  expect(accepted).toHaveLength(1);
  expect(accepted[0]).toMatchObject({
    action: 'fold',
    amount: 0,
    seat: actor.seat,
    publicNode: {
      status: 'captured',
      actorSeat: actor.seat,
      legalActions: expect.arrayContaining(['fold']),
    },
  });
  expect(controller.getState().currentPlayerSeat).toBe(originalTurn);
  expect(controller.getState().players.find((p: any) => p.seat === actor.seat).is_folded).toBe(
    true
  );
  expect(JSON.stringify(accepted[0].publicNode)).not.toContain('cards');
  await (host.host as any).abandon('isolated_metadata_test_complete');
});
