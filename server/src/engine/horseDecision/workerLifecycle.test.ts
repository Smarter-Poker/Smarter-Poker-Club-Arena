import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HorseLogic } from '../HorseLogic.js';
import {
  HorseDecisionWorkerRuntime,
  defaultHorseDecisionWorkerDependencies,
} from './workerRuntime.js';
import {
  LiveHorseDecisionWorkerClient,
  HorseDecisionAbortedError,
  HorseDecisionExpiredError,
  type WorkerLike,
} from './client.js';
import {
  buildHorseDecisionKey,
  type FastHorseDecisionRequest,
  type HorseDecisionWorkerResponse,
} from './protocol.js';
import { jointPolicyFixture } from '../multiway/JointRangeFixture.test-support.js';
import { captureHorseHandJournalContext } from '../HorseDecisionHandBinding.js';
import {
  createHorseExecutionWitness,
  retireHorseExecutionWitness,
} from '../HorseExecutionWitness.js';
import {
  HorseDecisionJournalPublisher,
  type HorseJournalWorker,
} from '../../services/HorseDecisionJournal.js';
import { HorseDecisionJournalStore } from '../../services/horseDecisionJournal/store.js';
import {
  horseLifecycleKeys,
  horseLifecycleRequestDigest,
} from '../../services/horseDecisionJournal/lifecycle.js';
import {
  journalHash,
  makeHorseJournalRecord,
  type HorseJournalRecord,
} from '../../services/horseDecisionJournal/record.js';
import {
  readHorseJournalHand,
  reconcileHorseJournalHand,
} from '../../services/horseDecisionJournal/review.js';

const table = '10000000-0000-4000-8000-000000000001';
const handKey = journalHash(`${table}:12:9`);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
function snapshot(): FastHorseDecisionRequest {
  const { hero, state } = JSON.parse(
    JSON.stringify(jointPolicyFixture('nlh', 1, 'cash', 'preflop')),
    (_key, v) =>
      typeof v === 'string' && /^p[0-9]$/.test(v)
        ? `20000000-0000-4000-8000-00000000000${Number(v.slice(1)) + 1}`
        : v
  );
  const request: FastHorseDecisionRequest = {
    type: 'DECIDE_FAST',
    requestId: 1,
    generation: 7,
    fence: `${table}:12:1:9:7`,
    decisionTimeMs: 1000,
    decisionKey: '',
    player: hero,
    gameState: state,
    opts: {
      phase8Postflop: 'off',
      phase10Plo4: 'off',
      phase11Omaha: 'off',
      phase12Remaining: 'off',
      phase13Joint: 'off',
    },
    handJournalContext: captureHorseHandJournalContext(state.actionHistory),
  };
  request.decisionKey = buildHorseDecisionKey(request);
  return request;
}

/** Real publisher and native SQLite, with an in-process transport adapter.
 * Does not claim a deployed writer thread, full replay or natural game proof. */
class LocalWriter implements HorseJournalWorker {
  listeners = new Map<string, (message: any) => void>();
  constructor(readonly store: HorseDecisionJournalStore) {}
  on(event: string, fn: (message: any) => void) {
    this.listeners.set(event, fn);
  }
  emit(message: unknown) {
    this.listeners.get('message')?.(message);
  }
  async terminate() {
    return 0;
  }
  postMessage(message: Parameters<HorseJournalWorker['postMessage']>[0]) {
    if (message.type === 'STOP') {
      queueMicrotask(() => this.emit({ type: 'STOPPED' }));
      return;
    }
    const statuses = this.store.appendBatch(message.records);
    queueMicrotask(() =>
      this.emit({
        type: 'ACK',
        receipts: message.records.map((r, i) => ({
          eventId: r.eventId,
          sha256: r.sha256,
          status: statuses[i],
        })),
      })
    );
  }
}
function harness(decide = HorseLogic.decide.bind(HorseLogic)) {
  const directory = mkdtempSync(join(tmpdir(), 'horse-lifecycle-'));
  const store = new HorseDecisionJournalStore(directory);
  const writer = new LocalWriter(store),
    notes: string[] = [];
  const publisher = new HorseDecisionJournalPublisher(writer, (s) => notes.push(s));
  writer.emit({ type: 'READY' });
  const messages: HorseDecisionWorkerResponse[] = [];
  const deps = {
    ...defaultHorseDecisionWorkerDependencies,
    startServices: async () => defaultHorseDecisionWorkerDependencies.workerReadiness(),
    stopServices: async () => {
      await publisher.stop();
    },
    journalEnabled: () => true,
    journalLifecycle: publisher.requestLifecycle.bind(publisher),
    journalDecision: (s: any, payload: unknown) => {
      const keys = horseLifecycleKeys(s);
      publisher.record('decision', keys.hand, keys.turn, payload);
    },
    journalDiscard: (capture: any) => {
      const keys = horseLifecycleKeys(capture.snapshot);
      publisher.record('discard_decision', keys.hand, keys.turn, capture);
    },
    journalExecution: (w: any) =>
      publisher.record(
        'execution',
        `${table}:12:9`,
        JSON.stringify([
          w.identity.generation,
          w.identity.fence,
          w.identity.requestId,
          w.identity.decisionKey,
          w.identity.decisionTimeMs,
        ]),
        w
      ),
    journalAcceptedHand: (h: any) =>
      publisher.record('accepted_hand', `${table}:12:9`, `${table}:12:9`, h),
    observeCompletedHand: () => {},
    noteFeature: (s: string) => notes.push(s),
    noteDecision: () => {},
    decide,
  };
  let listener: ((message: HorseDecisionWorkerResponse) => void) | undefined;
  const runtime = new HorseDecisionWorkerRuntime((message) => {
    messages.push(message);
    listener?.(message);
  }, deps);
  cleanup.push(async () => {
    await publisher.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const rows = () => store.readHand(handKey);
  const accepted = async () => {
    runtime.receive({
      type: 'OBSERVE_COMPLETED_HAND',
      requestId: 100,
      generation: 12,
      fence: `${table}:12:9:observe`,
      handKey: `${table}:12`,
      committedHandId: '30000000-0000-4000-8000-000000000001',
      actions: [],
      bigBlind: 2,
    });
    await runtime.drain();
    await Promise.resolve();
  };
  return {
    runtime,
    deps,
    messages,
    directory,
    store,
    publisher,
    rows,
    accepted,
    notes,
    subscribe: (fn: typeof listener) => {
      listener = fn;
    },
  };
}
const lifecycle = (rows: readonly HorseJournalRecord[]) =>
  rows.filter((r) => r.kind === 'request_lifecycle').map((r) => JSON.parse(r.body));

describe('valid private Horse request lifecycle', () => {
  it('bounds undispatched retirement capture without retaining an unlimited second queue', async () => {
    // This fake worker only checks whether capture is configured; it opens no path.
    vi.stubEnv('HORSE_DECISION_JOURNAL_DIR', join(tmpdir(), 'horse-client-configured-marker'));
    let messageListener: ((message: HorseDecisionWorkerResponse) => void) | undefined;
    const sent: any[] = [];
    const worker = {
      postMessage: (message: any) => sent.push(message),
      on: (event: string, fn: any) => {
        if (event === 'message') messageListener = fn;
        return worker;
      },
      terminate: async () => 0,
    } as WorkerLike;
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    const results = [];
    for (let i = 0; i < 65; i++) {
      const controller = new AbortController();
      results.push(client.decideFast(snapshot(), controller.signal).catch((error) => error));
      controller.abort();
    }
    expect(
      (await Promise.all(results)).every((error) => error instanceof HorseDecisionAbortedError)
    ).toBe(true);
    expect(client.status().queueDepth).toBe(64);
    expect(sent).toEqual([]);
    // Starting was never acknowledged; normal client stop retires its own queue.
    await client.stop();
    expect(client.status().queueDepth).toBe(0);
    expect(messageListener).toBeTypeOf('function');
  });
  it.each(['cancelled', 'expired'] as const)(
    'routes actual client queue %s through validation, publisher, disk and reader',
    async (outcome) => {
      const h = harness(),
        sent: any[] = [],
        onFatal = vi.fn();
      vi.stubEnv('HORSE_DECISION_JOURNAL_DIR', h.directory);
      let clientListener: ((message: HorseDecisionWorkerResponse) => void) | undefined;
      const worker = {
        postMessage: (message: any) => {
          sent.push(structuredClone(message));
          h.runtime.receive(structuredClone(message));
        },
        on: (event: string, fn: any) => {
          if (event === 'message') {
            clientListener = fn;
            h.subscribe(fn);
          }
          return worker;
        },
        terminate: async () => 0,
      } as WorkerLike;
      const client = new LiveHorseDecisionWorkerClient({
        workerFactory: () => worker,
        jobTimeoutMs: 50,
        onFatal,
      });
      const controller = new AbortController();
      const decision = client.decideFast(snapshot(), controller.signal);
      const rejected = decision.catch((e) => e);
      if (outcome === 'cancelled') controller.abort();
      else await new Promise((resolve) => setTimeout(resolve, 60));
      expect(await rejected).toBeInstanceOf(
        outcome === 'cancelled' ? HorseDecisionAbortedError : HorseDecisionExpiredError
      );
      expect(sent).toEqual([]);
      await h.runtime.start();
      await h.runtime.drain();
      await Promise.resolve();
      expect(sent[0]).toMatchObject({
        type: 'OBSERVE_REQUEST_RETIREMENT',
        outcome,
        retiredRequest: { requestId: 1, type: 'DECIDE_FAST' },
      });
      expect(sent.some((m) => m.type === 'DECIDE_FAST')).toBe(false);
      expect(onFatal).not.toHaveBeenCalled();
      h.subscribe(undefined);
      await h.accepted();
      expect(readHorseJournalHand(h.directory, handKey)).toMatchObject({
        status: 'reconciled',
        requestLifecycleVerified: true,
      });
      h.subscribe(clientListener);
      await client.stop();
      expect(onFatal).not.toHaveBeenCalled();
    }
  );
  it('runs a real policy and reconciles requested, computed, terminal and explicit retirement through native storage', async () => {
    const h = harness(),
      request = snapshot();
    h.runtime.receive(request);
    await h.runtime.drain();
    const result = h.messages.find((m) => m.type === 'FAST_RESULT');
    expect(result?.type).toBe('FAST_RESULT');
    if (result?.type !== 'FAST_RESULT') throw Error(JSON.stringify(h.messages));
    const witness = createHorseExecutionWitness(request, result.decision, {
      requestId: 1,
      lane: 'fast',
      computeMs: result.computeMs,
      governorScale: result.governorScale,
    });
    retireHorseExecutionWitness(witness, 'turn_abandoned');
    h.runtime.receive({
      type: 'OBSERVE_EXECUTION',
      requestId: 2,
      generation: 7,
      fence: request.fence,
      witness,
    });
    await h.runtime.drain();
    await h.accepted();
    const rows = h.rows();
    expect(lifecycle(rows).map((r) => (r.phase === 'terminal' ? r.outcome : r.phase))).toEqual([
      'requested',
      'success',
    ]);
    const before = readFileSync(join(h.directory, 'horse-decisions.sqlite'));
    expect(readHorseJournalHand(h.directory, handKey)).toMatchObject({
      status: 'reconciled',
      requestedRequests: 1,
      terminalRequests: 1,
      requestLifecycleVerified: true,
      retiredDecisions: 1,
      replayVerified: false,
      completePopulation: false,
      gtoVerified: false,
    });
    expect(readFileSync(join(h.directory, 'horse-decisions.sqlite'))).toEqual(before);
    const publicReplies = JSON.stringify(h.messages.filter((m) => m.type !== 'READY'));
    expect(publicReplies).not.toContain('requestDigest');
    expect(publicReplies).not.toContain('handJournalContext');
  });

  it.each(['cancelled', 'expired'] as const)(
    'records posted %s without calling a policy',
    async (outcome) => {
      const decide = vi.fn(HorseLogic.decide.bind(HorseLogic)),
        h = harness(decide),
        request = snapshot();
      h.runtime.receive(request);
      h.runtime.receive({ type: 'CANCEL', requestId: 1, reason: outcome });
      await h.runtime.drain();
      await h.accepted();
      expect(decide).not.toHaveBeenCalled();
      expect(lifecycle(h.rows())[1]).toEqual({
        version: 1,
        phase: 'terminal',
        outcome,
        requestDigest: horseLifecycleRequestDigest(request),
      });
      expect(readHorseJournalHand(h.directory, handKey)).toMatchObject({
        status: 'reconciled',
        requestLifecycleVerified: true,
      });
    }
  );

  it.each(['cancelled', 'expired'] as const)(
    'revalidates undispatched %s while never deciding the retired request',
    async (outcome) => {
      const decide = vi.fn(HorseLogic.decide.bind(HorseLogic)),
        h = harness(decide),
        request = snapshot();
      h.runtime.receive({
        type: 'OBSERVE_REQUEST_RETIREMENT',
        requestId: 2,
        generation: 7,
        fence: request.fence,
        retiredRequest: request,
        outcome,
      });
      await h.runtime.drain();
      await h.accepted();
      expect(decide).not.toHaveBeenCalled();
      expect(lifecycle(h.rows())[0].origin).toBe('client_not_dispatched');
      expect(lifecycle(h.rows())[1].outcome).toBe(outcome);
      expect(readHorseJournalHand(h.directory, handKey)).toMatchObject({
        status: 'reconciled',
        requestLifecycleVerified: true,
      });
    }
  );

  it('records a valid deep request refusal without fabricating decision output or original reads', async () => {
    const h = harness(),
      request = { ...snapshot(), type: 'DECIDE_DEEP' as const, rngBefore: 1, deepEquity: 2 };
    h.runtime.receive(request);
    await h.runtime.drain();
    await h.accepted();
    expect(lifecycle(h.rows())[1].outcome).toBe('refused');
    expect(h.rows().some((r) => r.kind === 'decision')).toBe(false);
    expect(readHorseJournalHand(h.directory, handKey)).toMatchObject({
      status: 'reconciled',
      requestLifecycleVerified: true,
    });
  });

  it('records an uncaught policy exception with a finite terminal label and original immutable request', async () => {
    const h = harness(() => {
        throw Error('private exception payload');
      }),
      request = snapshot();
    h.runtime.receive(request);
    await h.runtime.drain();
    await h.accepted();
    expect(lifecycle(h.rows())[1].outcome).toBe('exception');
    expect(h.rows().some((r) => r.body.includes('private exception payload'))).toBe(false);
    expect(lifecycle(h.rows())[0].request).toEqual(request);
    expect(readHorseJournalHand(h.directory, handKey)).toMatchObject({
      status: 'reconciled',
      requestLifecycleVerified: true,
    });
  });

  it('keeps a marked caught-brain fallback distinct from successful policy computation', async () => {
    const h = harness(() => ({
      action: 'check',
      thinkTime: 1500,
      policyFallback: 'brain_exception',
    }));
    h.runtime.receive(snapshot());
    await h.runtime.drain();
    expect(lifecycle(h.rows())[1].outcome).toBe('exception');
    expect(
      h.messages.some(
        (m) => m.type === 'FAST_RESULT' && m.decision.policyFallback === 'brain_exception'
      )
    ).toBe(true);
  });

  it('preserves a valid result when lifecycle capture fails and reports missing required capture', async () => {
    const h = harness();
    h.deps.journalLifecycle = () => {
      throw Error('private capture fault');
    };
    h.runtime.receive(snapshot());
    await h.runtime.drain();
    await h.accepted();
    expect(h.messages.some((m) => m.type === 'FAST_RESULT')).toBe(true);
    expect(h.notes).toContain('phase15_journal_capture_unavailable');
    expect(lifecycle(h.rows())).toEqual([]);
    expect(readHorseJournalHand(h.directory, handKey).gaps).toContain('request_lifecycle_missing');
  });

  it.each(['cancelled', 'expired', 'success'] as const)(
    'captures the attributed Pineapple discard %s lifecycle',
    async (outcome) => {
      const h = harness();
      const cards = [
        { rank: 'A', suit: 'spades' },
        { rank: 'K', suit: 'spades' },
        { rank: '2', suit: 'clubs' },
      ];
      const board = [
        { rank: 'Q', suit: 'hearts' },
        { rank: 'J', suit: 'diamonds' },
        { rank: 'T', suit: 'clubs' },
      ];
      const cardKey = (c: typeof cards) => c.map((x) => `${x.rank}:${x.suit}`).join('|');
      const request: any = {
        type: 'DECIDE_DISCARD',
        requestId: 1,
        generation: 7,
        fence: `${table}:12:pineapple-discard:1:9:7:${cardKey(cards)}:${cardKey(board)}`,
        cards,
        communityCards: board,
        gameVariant: 'pineapple',
        journalContext: {
          version: 1,
          tableId: table,
          handNumber: 12,
          leaseGeneration: '9',
          actorId: snapshot().player.user_id,
          seat: 1,
          requestedAtMs: 1000,
          lane: 'choice',
          priorActions: captureHorseHandJournalContext([]),
        },
      };
      h.runtime.receive(request);
      if (outcome !== 'success')
        h.runtime.receive({ type: 'CANCEL', requestId: 1, reason: outcome });
      await h.runtime.drain();
      await h.accepted();
      expect(lifecycle(h.rows())[1].outcome).toBe(outcome);
      if (outcome !== 'success')
        expect(readHorseJournalHand(h.directory, handKey)).toMatchObject({
          status: 'reconciled',
          requestLifecycleVerified: true,
        });
      else
        expect(readHorseJournalHand(h.directory, handKey).gaps).toContain(
          'discard_execution_missing'
        );
    }
  );

  it.each(['bad_key', 'no_anchor', 'private_cards', 'bad_deep', 'retirement_identity'])(
    'does not turn %s into attributed evidence',
    async (mode) => {
      const h = harness(),
        request: any = snapshot();
      if (mode === 'bad_key') request.decisionKey = 'bad';
      if (mode === 'no_anchor') {
        request.fence = 'legacy';
        request.decisionKey = buildHorseDecisionKey(request);
      }
      if (mode === 'private_cards') {
        request.gameState.players[1].cards = [{ rank: 'A', suit: 'clubs' }];
        request.decisionKey = buildHorseDecisionKey(request);
      }
      if (mode === 'bad_deep')
        Object.assign(request, { type: 'DECIDE_DEEP', rngBefore: 1, deepEquity: 0 });
      h.runtime.receive(
        mode === 'retirement_identity'
          ? {
              type: 'OBSERVE_REQUEST_RETIREMENT',
              requestId: 2,
              generation: 8,
              fence: request.fence,
              retiredRequest: request,
              outcome: 'expired',
            }
          : request
      );
      await h.runtime.drain();
      expect(lifecycle(h.rows())).toEqual([]);
    }
  );

  it('reports missing/conflicting terminal records and rejects invented success without computation', async () => {
    const h = harness(),
      request = snapshot();
    h.runtime.receive(request);
    h.runtime.receive({ type: 'CANCEL', requestId: 1 });
    await h.runtime.drain();
    await h.accepted();
    const rows = h.rows(),
      terminal = rows.find(
        (r) => r.kind === 'request_lifecycle' && JSON.parse(r.body).phase === 'terminal'
      )!;
    expect(
      reconcileHorseJournalHand(
        rows.filter((r) => r !== terminal),
        handKey
      ).gaps
    ).toContain('request_lifecycle_missing');
    const rewrite = (record: HorseJournalRecord, body: unknown, sequence = record.sequence) =>
      makeHorseJournalRecord(
        {
          producerId: record.producerId,
          sequence,
          atMs: record.atMs,
          sourceRelease: record.sourceRelease,
          kind: record.kind,
          handKey: record.handKey,
          turnKey: record.turnKey,
        },
        body
      );
    const invented = rewrite(terminal, { ...JSON.parse(terminal.body), outcome: 'success' });
    expect(
      reconcileHorseJournalHand(
        rows.map((r) => (r === terminal ? invented : r)),
        handKey
      ).gaps
    ).toContain('request_lifecycle_mismatch');
    expect(
      reconcileHorseJournalHand(
        [...rows, rewrite(terminal, JSON.parse(terminal.body), 99)],
        handKey
      ).gaps
    ).toContain('request_lifecycle_conflict');
    const wrong = rewrite(terminal, {
      ...JSON.parse(terminal.body),
      requestDigest: 'f'.repeat(64),
    });
    expect(
      reconcileHorseJournalHand(
        rows.map((r) => (r === terminal ? wrong : r)),
        handKey
      ).requestLifecycleVerified
    ).toBe(false);
    const mixedSource = makeHorseJournalRecord(
      {
        producerId: terminal.producerId,
        sequence: terminal.sequence,
        atMs: terminal.atMs,
        sourceRelease: 'a'.repeat(40),
        kind: terminal.kind,
        handKey: terminal.handKey,
        turnKey: terminal.turnKey,
      },
      JSON.parse(terminal.body)
    );
    expect(
      reconcileHorseJournalHand(
        rows.map((r) => (r === terminal ? mixedSource : r)),
        handKey
      ).gaps
    ).toContain('request_lifecycle_mismatch');
    const mixedProducer = makeHorseJournalRecord(
      {
        producerId: '40000000-0000-4000-8000-000000000099',
        sequence: terminal.sequence,
        atMs: terminal.atMs,
        sourceRelease: terminal.sourceRelease,
        kind: terminal.kind,
        handKey: terminal.handKey,
        turnKey: terminal.turnKey,
      },
      JSON.parse(terminal.body)
    );
    expect(
      reconcileHorseJournalHand(
        rows.map((r) => (r === terminal ? mixedProducer : r)),
        handKey
      ).gaps
    ).toContain('request_lifecycle_missing');
  });
});
