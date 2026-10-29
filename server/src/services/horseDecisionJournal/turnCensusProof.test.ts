import { afterAll, afterEach, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  vi.stubEnv('SUPABASE_URL', 'https://supabase.invalid');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'unit-test-placeholder-key');
});
afterAll(() => vi.unstubAllEnvs());
import * as recordsApi from './record.js';
import * as bindingApi from '../../engine/HorseDecisionHandBinding.js';
import * as reviewApi from './review.js';
import * as effectsApi from './effects.js';
import * as discardApi from './discard.js';
import type {
  DecidePineappleDiscardRequest,
  CompletedHandObservation,
} from '../../engine/horseDecision/protocol.js';
import type { ActionRecord } from '../../types.js';
import type { HorseDiscardDecisionCapture, HorseDiscardExecutionObservation } from './discard.js';
import * as planApi from '../../engine/HorseDecisionEffects.js';
import { HorseFleetPhaseInterpreter } from './phaseProof.js';
import { decisionRequest } from '../../testing/horseRegression/plan/fixture.js';
import { jointPolicyFixture } from '../../engine/multiway/JointRangeFixture.test-support.js';
import { HorseLogic } from '../../engine/HorseLogic.js';
import { HorseMind } from '../../engine/HorseMind.js';
import { seedFastRandom, saveFastRandom, restoreFastRandom } from '../../engine/HorseEval.js';
import { encodeHorseDecisionReads } from '../../engine/HorseDecisionReadFrame.js';
import {
  horsePlanContextFromDecision,
  horsePlanBatchBindingFromRequest,
} from '../../engine/HorsePlanHandIdentity.js';
import {
  createHorseExecutionWitness,
  settleHorseExecutionWitness,
  expectedHorseExecutionAmount,
} from '../../engine/HorseExecutionWitness.js';
import { buildHorseDecisionKey } from '../../engine/horseDecision/protocol.js';

// @ts-expect-error Fixed host-executed JavaScript has no generated declaration.
import * as censusApi from '../../../../scripts/ci/horse-turn-census-proof.mjs';
const {
  inspectHorseTurnCensus,
  validateHorseTurnCensusPacket,
  sanitizeHorseTurnCensusResult,
  readInstalledTurnCensusBatch,
} = censusApi;
import * as readFrameApi from '../../engine/HorseDecisionReadFrame.js';
import * as historyContextApi from '../../engine/HorseObserverReadContext.js';
import * as observerApi from '../../engine/HorseObserverReadEvidence.js';
const api = {
  ...recordsApi,
  ...bindingApi,
  ...reviewApi,
  ...effectsApi,
  ...discardApi,
  ...planApi,
  ...readFrameApi,
  ...observerApi,
  ...historyContextApi,
  buildHorseDecisionKey,
  HorseFleetPhaseInterpreter,
};
const source = 'a'.repeat(40),
  handId = '32345678-abcd-4321-abcd-123456789abc';
function fixture(probe: 'matched_risk' | 'phase7_allocated' = 'matched_risk') {
  const snapshot = decisionRequest();
  if (probe === 'matched_risk') {
    const p = snapshot.player,
      g = snapshot.gameState;
    Object.assign(p, {
      stack: 1000,
      bet: 0,
      totalInvested: 10,
      cards: [
        { rank: 'A', suit: 'clubs' },
        { rank: 'Q', suit: 'diamonds' },
      ],
    });
    Object.assign(g, {
      pot: 40,
      contestablePot: 40,
      currentBet: 20,
      minRaise: 20,
      lastRaise: 20,
      toCall: 20,
      legalActions: ['fold', 'call', 'raise', 'all_in'],
      minRaiseTo: 40,
      maxRaiseTo: 1000,
      communityCards: [
        { rank: 'Q', suit: 'spades' },
        { rank: '8', suit: 'hearts' },
        { rank: '3', suit: 'diamonds' },
      ],
      players: [
        { ...p, cards: [] },
        { ...g.players[1], stack: 15, bet: 20, totalInvested: 30 },
      ],
      actionHistory: [
        { stage: 'flop', seat: 1, userId: p.user_id, action: 'check', amount: 0, timestamp: 1 },
        {
          stage: 'flop',
          seat: 2,
          userId: g.players[1].user_id,
          action: 'bet',
          amount: 20,
          timestamp: 2,
        },
      ],
    });
  } else {
    const f = JSON.parse(
      JSON.stringify(jointPolicyFixture('nlh', 1, 'tournament', 'preflop')),
      (_k, v) =>
        typeof v === 'string' && /^p[0-9]$/.test(v)
          ? `20000000-0000-4000-8000-00000000000${Number(v.slice(1)) + 1}`
          : v
    );
    Object.assign(f.state, {
      toCall: 0,
      legalActions: ['check'],
      minRaiseTo: null,
      maxRaiseTo: null,
      actionHistory: snapshot.gameState.actionHistory,
    });
    f.state.tournament.stackByUser = Object.fromEntries(
      f.state.players.map((p: any) => [p.user_id, p.stack + p.totalInvested])
    );
    snapshot.player = f.hero;
    snapshot.gameState = f.state;
  }
  snapshot.gameState.actionHistory = snapshot.gameState.actionHistory!.map((a) => ({
    ...a,
    origin: 'player' as const,
  }));
  const opts: NonNullable<typeof snapshot.opts> = {
    mind: false,
    v7AdaptiveMC: false,
    v27GtoCharts: false,
    phase8Postflop: 'off',
    phase13Joint: 'off',
  };
  if (probe === 'phase7_allocated') delete opts.v7AdaptiveMC;
  snapshot.opts = opts;
  snapshot.handJournalContext = bindingApi.captureHorseHandJournalContext(
    snapshot.gameState.actionHistory!
  );
  snapshot.decisionKey = buildHorseDecisionKey(snapshot);
  const before = saveFastRandom();
  let decision;
  try {
    seedFastRandom(probe === 'matched_risk' ? 1 : 7300930);
    decision = HorseLogic.decide(
      snapshot.player,
      snapshot.gameState,
      'balanced',
      {},
      { ...opts, telemetry: false, decisionTimeMs: snapshot.decisionTimeMs }
    );
  } finally {
    restoreFastRandom(before);
  }
  const context = horsePlanContextFromDecision(snapshot);
  const readFrame = encodeHorseDecisionReads(
    HorseMind.createSandbox(),
    snapshot.gameState.players,
    planApi.horsePlanHandKey(snapshot.gameState.actionHistory, context),
    context
  );
  if (decision.tournamentUtility) decision.tournamentUtility.readFrameSha256 = readFrame.sha256;
  const capture = {
    snapshot,
    decision,
    readFrame,
    effects: [],
    rngBefore: 1,
    rngAfter: 2,
    computeMs: 1,
    governorScale: 1,
    planContext: context,
    planBinding: horsePlanBatchBindingFromRequest(snapshot),
  };
  const witness = createHorseExecutionWitness(snapshot, decision, {
    requestId: snapshot.requestId,
    lane: 'fast',
    computeMs: 1,
    governorScale: 1,
  });
  const action = {
    seat: snapshot.player.seat,
    userId: snapshot.player.user_id,
    stage: snapshot.gameState.stage,
    action: decision.action,
    amount: expectedHorseExecutionAmount(snapshot, decision) ?? 0,
    timestamp: snapshot.decisionTimeMs + 1,
  };
  settleHorseExecutionWitness(witness, {
    applied: true,
    acceptedActions: [{ record: action, intended: true }],
  });
  const ordinal = snapshot.gameState.actionHistory!.length;
  const anchor = bindingApi.anchorHorseDecisionHand(snapshot);
  if (anchor.status !== 'anchored') throw Error('fixture anchor');
  const coordinate = bindingApi.horseHandAnchorKey(anchor),
    handKey = recordsApi.journalHash(coordinate);
  const hand = {
    generation: anchor.handNumber,
    fence: `${anchor.tableId}:${anchor.handNumber}:${anchor.leaseGeneration}:observe`,
    handKey: `${anchor.tableId}:${anchor.handNumber}`,
    committedHandId: handId,
    bigBlind: snapshot.gameState.bigBlind,
    actions: [
      ...snapshot.gameState.actionHistory!,
      {
        ...action,
        origin: 'horse_policy',
        publicNode: {
          version: 1,
          status: 'captured',
          actorSeat: action.seat,
          street: action.stage,
        },
        observationIdentity: {
          version: 1,
          status: 'bound',
          handId,
          actionOrdinal: ordinal,
          observationId: `${handId}:${ordinal}`,
          sessionKey: 'a'.repeat(64),
        },
      },
    ],
  };
  const turnKey = recordsApi.journalHash(
    JSON.stringify([
      snapshot.generation,
      snapshot.fence,
      snapshot.requestId,
      snapshot.decisionKey,
      snapshot.decisionTimeMs,
    ])
  );
  const make = (kind: any, sequence: number, body: unknown) =>
    recordsApi.makeHorseJournalRecord(
      {
        producerId: '40000000-0000-4000-8000-000000000001',
        sequence,
        atMs: 2000,
        sourceRelease: source,
        kind,
        handKey,
        turnKey: kind === 'accepted_hand' ? handKey : turnKey,
      },
      body
    );
  const rows = () => [
    make('decision', 1, capture),
    make('execution', 2, witness),
    make('accepted_hand', 3, hand),
  ];
  const input = {
    version: 4,
    sourceRelease: source,
    probe,
    cases: [
      {
        handKey,
        tableId: anchor.tableId,
        handId,
        handNumber: anchor.handNumber,
        leaseGeneration: anchor.leaseGeneration,
        decisionRecordSha256: null as string | null,
        actionOrdinal: ordinal,
      },
    ],
  };
  const batch = () => ({
    status: 'canonical_journal_export',
    sourceRelease: source,
    recordsByHand: [{ handKey, records: rows() }],
  });
  return { input, batch, capture, witness, hand, rows };
}
afterEach(() => HorseMind.reset());
function census() {
  const f = fixture();
  // Include every roster actor in the hand, including prior public actions.
  const ids = Array.from(
    { length: 998 },
    (_, i) => `90000000-0000-4000-8000-${i.toString().padStart(12, '0')}`
  );
  ids.push(f.capture.snapshot.player.user_id, f.capture.snapshot.gameState.players[1]!.user_id);
  ids.sort();
  const committedAtMs = f.capture.snapshot.decisionTimeMs + 5000;
  const packet = {
    version: 2,
    sourceSha: source,
    window: {
      startUtc: new Date(committedAtMs - 1).toISOString(),
      endUtc: new Date(committedAtMs + 1).toISOString(),
    },
    horseIds: ids,
    hands: [
      {
        handKey: f.input.cases[0]!.handKey,
        committedAtMs,
        actions: f.hand.actions.map((a, actionOrdinal) => ({
          actorIndex: ids.indexOf(a.userId),
          actionOrdinal,
          stage: a.stage,
          action: a.action,
          origin: a.origin ?? 'unknown',
          amount: a.amount ?? null,
          seat: a.seat ?? null,
          timestamp: a.timestamp ?? null,
        })),
      },
    ],
  };
  return {
    f,
    packet,
    batch: () => ({
      sourceRelease: source,
      recordsByHand: [{ handKey: packet.hands[0]!.handKey, records: f.rows() }],
    }),
  };
}
it('joins actual original records at full ordinal and preserves prior missing turns across commit boundary', () => {
  const x = census();
  expect(reviewApi.reconcileHorseJournalHand(x.f.rows(), x.packet.hands[0]!.handKey).status).toBe(
    'reconciled'
  );
  const r = inspectHorseTurnCensus(x.packet, x.batch(), api);
  expect(r).toMatchObject({
    status: 'unknown',
    expectedTurns: 3,
    missingTurns: 2,
    boundReached: false,
    inspectedHands: 1,
  });
  expect(r.turns[2]).toMatchObject({
    actionOrdinal: 2,
    expectedBinding: 'matched',
    capture: 'present',
    execution: 'intended',
    selection: 'matched',
    inputBinding: 'canonical_digest_and_read_frame',
    handReconciliation: 'reconciled',
  });
  expect(r.turns[0]).toMatchObject({
    actionOrdinal: 0,
    capture: 'missing',
    expectedBinding: 'matched',
  });
  expect(sanitizeHorseTurnCensusResult(r)).toEqual(r);
  const encoded = JSON.stringify(r);
  for (const id of x.packet.horseIds) expect(encoded).not.toContain(id);
  expect(encoded).not.toContain('cards');
});
it('refuses omitted expected domain, wrong actor, amount, source and malformed original hash', () => {
  for (const mode of ['omitted', 'actor', 'amount', 'source', 'hash']) {
    const x = census(),
      b = x.batch();
    if (mode === 'omitted') x.packet.hands[0]!.actions.shift();
    if (mode === 'actor') x.packet.hands[0]!.actions[2]!.actorIndex = 999;
    if (mode === 'amount') x.packet.hands[0]!.actions[2]!.amount!++;
    if (mode === 'source') b.sourceRelease = 'b'.repeat(40);
    if (mode === 'hash')
      b.recordsByHand[0]!.records[0] = {
        ...b.recordsByHand[0]!.records[0]!,
        sha256: '0'.repeat(64),
      };
    const r = inspectHorseTurnCensus(x.packet, b, api);
    expect(r.status).toBe('unknown');
    expect(r.turns.every((t: any) => t.inputBinding === 'unknown')).toBe(true);
  }
});
it('retains forced and fallback expected rows when their decision capture is absent', () => {
  const x = census();
  x.packet.hands[0]!.actions[0]!.origin = 'forced';
  x.packet.hands[0]!.actions[1]!.origin = 'horse_fallback';
  const r = inspectHorseTurnCensus(
    x.packet,
    {
      sourceRelease: source,
      recordsByHand: [{ handKey: x.packet.hands[0]!.handKey, records: [] }],
    },
    api
  );
  expect(r.turns).toHaveLength(3);
  expect(r.missingTurns).toBe(3);
  expect(r.turns.map((t: any) => t.origin)).toEqual(['forced', 'horse_fallback', 'horse_policy']);
});
it('refuses unknown/private output fields and contradictory row/phase/counter shapes', () => {
  const x = census(),
    good = inspectHorseTurnCensus(x.packet, x.batch(), api);
  for (const mutate of [
    (r: any) => (r.raw = 'private'),
    (r: any) => (r.turns[0].cards = ['As']),
    (r: any) => (r.turns[0].phases.phase1.reason = 'private'),
    (r: any) => (r.replayVerified = true),
    (r: any) => r.expectedTurns--,
    (r: any) => r.turns.push(r.turns[0]),
  ]) {
    const r = structuredClone(good);
    mutate(r);
    expect(() => sanitizeHorseTurnCensusResult(r)).toThrow();
  }
});
it('strict packet refuses unknown fields, duplicate ordinal, unsorted roster and out-of-window commit', () => {
  for (const mutate of [
    (p: any) => (p.cards = []),
    (p: any) => (p.hands[0].actions[1].actionOrdinal = 0),
    (p: any) => p.horseIds.reverse(),
    (p: any) => (p.hands[0].committedAtMs = Date.parse(p.window.endUtc)),
    (p: any) => (p.hands = Array(65).fill(p.hands[0])),
  ]) {
    const x = census();
    mutate(x.packet);
    expect(() => validateHorseTurnCensusPacket(x.packet)).toThrow();
  }
});
it('preserves all expected rows when deadline, per-hand or global byte budget refuses', () => {
  const x = census();
  let n = 0;
  const timed = inspectHorseTurnCensus(x.packet, x.batch(), api, () => (n++ === 0 ? 0 : 30000));
  expect(timed).toMatchObject({ boundReached: true, missingTurns: 3, remainingHands: 1 });
  const many = x.batch();
  many.recordsByHand[0]!.records = Array(257).fill(many.recordsByHand[0]!.records[0]);
  expect(inspectHorseTurnCensus(x.packet, many, api).missingTurns).toBe(3);
  const exhausted = {
    ...x.batch(),
    readBudget: { validatedBytes: 64 * 1024 * 1024 + 1, elapsedMs: 1, boundReached: true },
  };
  expect(inspectHorseTurnCensus(x.packet, exhausted, api)).toMatchObject({
    boundReached: true,
    missingTurns: 3,
  });
});
it('read helper closes opened stores on failure, charges duplicate reads and retains missing hands', () => {
  const x = census(),
    closed: string[] = [];
  const fake = {
    ...api,
    horseJournalArchiveDirectoryNames: () => ['archive', 'archive2'],
    readonlyHorseJournalStoreOptions: (_d: string, n: string) => n,
    HorseDecisionJournalStore: class {
      constructor(
        _d: string,
        readonly name: string
      ) {}
      readHand() {
        return x.f.rows();
      }
      close() {
        closed.push(this.name);
      }
    },
  };
  const b = readInstalledTurnCensusBatch(x.packet, fake);
  expect(closed).toEqual(['archive', 'archive2']);
  expect(b.recordsByHand[0].records).toHaveLength(3);
  const once = x.f
    .rows()
    .reduce((n, r) => n + Buffer.byteLength(recordsApi.horseJournalJson(r)), 0);
  expect(b.readBudget.validatedBytes).toBe(once * 2);
  expect(() => readInstalledTurnCensusBatch(x.packet, fake, '/tmp')).toThrow('mount_refused');
});
it('reports original pending and unavailable history explicitly without upgrading presence to reads', () => {
  for (const state of ['pending', 'unavailable'] as const) {
    const x = census();
    x.f.capture.snapshot.ownPublicHistoryState = state;
    const r = inspectHorseTurnCensus(x.packet, x.batch(), api);
    expect(r.turns[2]).toMatchObject({
      capture: 'present',
      inputBinding: 'canonical_digest_and_read_frame',
      historicalRead: state,
      publicRead: 'unqualified',
    });
    expect(r.strategyCorrectnessVerified).toBe(false);
  }
});
it('charges actual validated record bytes and refuses an over-eight-MiB original hand', () => {
  const x = census(),
    b = x.batch(),
    template = b.recordsByHand[0]!.records[0]!;
  b.recordsByHand[0]!.records = Array.from({ length: 18 }, (_, i) =>
    recordsApi.makeHorseJournalRecord(
      {
        producerId: template.producerId,
        sequence: i + 1,
        atMs: template.atMs,
        sourceRelease: source,
        kind: 'decision',
        handKey: template.handKey,
        turnKey: template.turnKey,
      },
      { bounded: 'x'.repeat(500000) }
    )
  );
  const r = inspectHorseTurnCensus(x.packet, b, api);
  expect(r.missingTurns).toBe(3);
  expect(r.validatedBytes).toBeGreaterThan(8 * 1024 * 1024);
  expect(r.status).toBe('unknown');
});
it('retains independently selected empty actor domains without inventing horse observations', () => {
  const x = census();
  x.packet.hands[0]!.actions = [];
  expect(() => validateHorseTurnCensusPacket(x.packet)).not.toThrow();
  const r = inspectHorseTurnCensus(
    x.packet,
    {
      sourceRelease: source,
      recordsByHand: [{ handKey: x.packet.hands[0]!.handKey, records: [] }],
    },
    api
  );
  expect(r).toMatchObject({
    status: 'unknown',
    expectedTurns: 0,
    missingTurns: 0,
    inspectedHands: 1,
    remainingHands: 0,
    completePopulation: false,
    turns: [],
  });
  expect(sanitizeHorseTurnCensusResult(r)).toEqual(r);
  expect(() => sanitizeHorseTurnCensusResult({ ...r, status: 'observed' })).toThrow();
});

function discardFixture(lane: 'choice' | 'forced_runout' = 'choice') {
  const stage = lane === 'choice' ? 'pineapple_discard' : 'flop';
  const table = '10000000-0000-4000-8000-000000000001',
    actor = '20000000-0000-4000-8000-000000000001',
    committed = '30000000-0000-4000-8000-000000000001';
  const captureHorseHandJournalContext = bindingApi.captureHorseHandJournalContext;
  const coordinate = `${table}:12:9`;
  const prefix: ActionRecord[] = [
    {
      seat: 1,
      userId: '70000000-0000-4000-8000-000000000001',
      action: 'check',
      amount: 0,
      timestamp: 900,
      stage: 'flop',
      origin: 'player',
    },
  ];

  const cards = [
    { rank: 'A', suit: 'hearts' },
    { rank: 'K', suit: 'hearts' },
    { rank: '2', suit: 'clubs' },
  ] as DecidePineappleDiscardRequest['cards'];
  const board = [
    { rank: '7', suit: 'hearts' },
    { rank: '8', suit: 'hearts' },
    { rank: '3', suit: 'clubs' },
  ] as DecidePineappleDiscardRequest['cards'];
  const request: DecidePineappleDiscardRequest = {
    type: 'DECIDE_DISCARD',
    requestId: 11,
    generation: 4,
    fence: [
      table,
      12,
      'pineapple-discard',
      10,
      '9',
      4,
      cards.map((c) => `${c.rank}:${c.suit}`).join('|'),
      board.map((c) => `${c.rank}:${c.suit}`).join('|'),
    ].join(':'),
    cards,
    communityCards: board,
    gameVariant: 'pineapple',
    journalContext: {
      version: 1,
      tableId: table,
      handNumber: 12,
      leaseGeneration: '9',
      actorId: actor,
      seat: 10,
      requestedAtMs: 1000,
      lane,
      priorActions: captureHorseHandJournalContext(prefix)!,
    },
  };
  const acceptedRecord: ActionRecord = {
    seat: 10,
    userId: actor,
    action: 'discard',
    amount: 0,
    timestamp: 1001,
    stage,
  };
  const d: HorseDiscardDecisionCapture = {
    version: 1,
    snapshot: request,
    cardIndex: 2,
    rngBefore: 31,
    rngAfter: 62,
    computeMs: 4,
    governorScale: 0.5,
    runtimePins: 'incomplete',
  };
  const e: HorseDiscardExecutionObservation = {
    version: 1,
    request,
    selectedIndex: 2,
    controller: {
      seat: 10,
      actorId: actor,
      chosenIndex: 2,
      originalCards: structuredClone(cards),
      discardedCard: cards[2]!,
      retainedCards: cards.slice(0, 2),
      communityCards: structuredClone(board),
      acceptedRecord,
    },
    acceptedActionOrdinal: 1,
    priorActions: captureHorseHandJournalContext(prefix)!,
  };
  const hand: CompletedHandObservation = {
    generation: 12,
    fence: `${coordinate}:observe`,
    handKey: `${table}:12`,
    committedHandId: committed,
    bigBlind: 2,
    actions: [...prefix, { ...acceptedRecord, origin: 'horse_policy' }],
  };
  const ids = Array.from(
    { length: 999 },
    (_, i) => `90000000-0000-4000-8000-${i.toString().padStart(12, '0')}`
  );
  ids.push(actor);
  ids.sort();
  const handKey = recordsApi.journalHash(coordinate);
  const packet = {
    version: 2,
    sourceSha: source,
    window: { startUtc: '1970-01-01T00:00:01.999Z', endUtc: '1970-01-01T00:00:02.001Z' },
    horseIds: ids,
    hands: [
      {
        handKey,
        committedAtMs: 2000,
        actions: [
          {
            actorIndex: ids.indexOf(actor),
            actionOrdinal: 1,
            stage,
            action: 'discard',
            origin: 'horse_policy',
            amount: 0,
            seat: 10,
            timestamp: 1001,
          },
        ],
      },
    ],
  };
  const rows = () =>
    [
      ['discard_decision', d],
      ['discard_execution', e],
      ['accepted_hand', hand],
    ].map(([kind, payload], i) =>
      recordsApi.makeHorseJournalRecord(
        {
          producerId: '40000000-0000-4000-8000-000000000001',
          sequence: i + 1,
          sourceRelease: source,
          atMs: 1003 + i,
          kind: kind as any,
          handKey,
          turnKey:
            kind === 'accepted_hand'
              ? handKey
              : recordsApi.journalHash(discardApi.horseDiscardTurnKey(request)),
        },
        payload
      )
    );
  const batch = () => ({ sourceRelease: source, recordsByHand: [{ handKey, records: rows() }] });
  return { request, d, e, hand, packet, rows, batch };
}

it('binds actual private discard request/controller at original full ordinal without exporting cards', () => {
  const x = discardFixture();
  expect(reviewApi.reconcileHorseJournalHand(x.rows(), x.packet.hands[0]!.handKey)).toMatchObject({
    status: 'reconciled',
    gaps: [],
    matchedHorseDiscards: 1,
  });
  const r = inspectHorseTurnCensus(x.packet, x.batch(), api);
  expect(r).toMatchObject({
    status: 'observed',
    missingTurns: 0,
    expectedTurns: 1,
    turns: [
      {
        actionOrdinal: 1,
        stage: 'pineapple_discard',
        capture: 'present',
        execution: 'intended',
        selection: 'matched',
        inputBinding: 'original_discard_request_and_controller',
        publicRead: 'not_applicable',
        historicalRead: 'not_applicable',
      },
    ],
  });
  expect(r.turns[0].phases.phase7).toMatchObject({
    status: 'outside-domain',
    capability: 'captured',
    eligibility: 'outside-domain',
    qualification: 'unknown',
    application: 'not-applicable',
  });
  expect(sanitizeHorseTurnCensusResult(r)).toEqual(r);
  expect(JSON.stringify(r)).not.toMatch(
    /originalCards|discardedCard|retainedCards|chosenIndex|cardIndex|hearts|clubs|20000000-0000/
  );
});
it('refuses forged physical discard requests, wrong full ordinal, changed source and missing execution', () => {
  for (const mode of ['request', 'ordinal', 'source', 'execution', 'choice']) {
    const x = discardFixture();
    if (mode === 'request') x.d.snapshot.fence += ':forged';
    if (mode === 'ordinal') x.e.acceptedActionOrdinal = 0;
    if (mode === 'choice') x.d.cardIndex = 1;
    const b = x.batch();
    if (mode === 'source')
      b.recordsByHand[0]!.records[1] = {
        ...b.recordsByHand[0]!.records[1]!,
        sourceRelease: 'b'.repeat(40),
      };
    if (mode === 'execution') b.recordsByHand[0]!.records.splice(1, 1);
    const r = inspectHorseTurnCensus(x.packet, b, api);
    expect(r.status).toBe('unknown');
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0].inputBinding).toBe('unknown');
    expect(r.rawRecordsExported).toBe(false);
  }
});
it('reports an original forced action as a nondecision without claiming consumed strategy or missing policy failure', () => {
  const x = discardFixture();
  x.packet.hands[0]!.actions[0]!.origin = 'forced';
  x.hand.actions![1]!.origin = 'forced';
  const rows = x.rows().filter((r) => r.kind === 'accepted_hand');
  const r = inspectHorseTurnCensus(
    x.packet,
    {
      sourceRelease: source,
      recordsByHand: [{ handKey: x.packet.hands[0]!.handKey, records: rows }],
    },
    api
  );
  expect(r.turns[0]).toMatchObject({
    origin: 'forced',
    expectedBinding: 'matched',
    capture: 'missing',
    selection: 'unknown',
    inputBinding: 'unknown',
    publicRead: 'not_applicable',
    historicalRead: 'not_applicable',
  });
  expect(r.turns[0].phases.phase7).toMatchObject({
    status: 'outside-domain',
    capability: 'unobserved',
    application: 'not-applicable',
  });
  expect(r.strategyCorrectnessVerified).toBe(false);
  expect(sanitizeHorseTurnCensusResult(r)).toEqual(r);
});

it('accepts the maintained forced-runout flop discard contract and rejects a betting action disguised as discard input', () => {
  const x = discardFixture('forced_runout');
  const r = inspectHorseTurnCensus(x.packet, x.batch(), api);
  expect(r).toMatchObject({
    status: 'observed',
    turns: [
      { action: 'discard', stage: 'flop', inputBinding: 'original_discard_request_and_controller' },
    ],
  });
  expect(sanitizeHorseTurnCensusResult(r)).toEqual(r);
  for (const mutate of [
    (t: any) => (t.action = 'bet'),
    (t: any) => (t.stage = 'river'),
    (t: any) => (t.capture = 'missing'),
    (t: any) => (t.handReconciliation = 'incomplete'),
  ]) {
    const altered = structuredClone(r);
    mutate(altered.turns[0]);
    expect(() => sanitizeHorseTurnCensusResult(altered)).toThrow();
  }
});

it('v3 binds original DB variant and cash context to actual reconciled decision snapshot', () => {
  const x = census();
  const packet: any = x.packet;
  packet.version = 3;
  packet.hands[0].context = {
    variant: 'nlh',
    format: 'cash',
    provenance: 'retained_submission_and_committed_history',
  };
  const r = inspectHorseTurnCensus(packet, x.batch(), api);
  expect(r.turns[2]).toMatchObject({
    contextBinding: 'matched',
    inputBinding: 'canonical_digest_and_read_frame',
  });
  expect(r.turns[0]).toMatchObject({ capture: 'missing', contextBinding: 'unknown' });
  expect(sanitizeHorseTurnCensusResult(r)).toEqual(r);
  for (const change of [{ variant: 'plo8' }, { format: 'tournament' }]) {
    packet.hands[0].context = {
      variant: 'nlh',
      format: 'cash',
      provenance: 'retained_submission_and_committed_history',
      ...change,
    };
    const refused = inspectHorseTurnCensus(packet, x.batch(), api);
    expect(refused.expectedTurns).toBe(3);
    expect(refused.turns[2]).toMatchObject({
      capture: 'present',
      expectedBinding: 'matched',
      contextBinding: 'contradictory',
      inputBinding: 'unknown',
      publicRead: 'unknown',
    });
    expect(sanitizeHorseTurnCensusResult(refused)).toEqual(refused);
  }
});

it('v3 history reason binds original observer partition, state and decision cutoff without private export', () => {
  const x = census();
  const packet: any = x.packet;
  packet.version = 3;
  packet.hands[0].context = {
    variant: 'nlh',
    format: 'cash',
    provenance: 'retained_submission_and_committed_history',
  };
  const s: any = x.f.capture.snapshot;
  s.gameState.dealtSeatIds = s.gameState.players.map((p: any) => p.seat);
  s.gameState.format = 'cash';
  const context = historyContextApi.horseObserverReadContextFromRequest(s);
  expect(context).not.toBeNull();
  s.ownPublicHistoryState = 'unavailable';
  s.ownPublicHistoryProvenance = {
    version: 1,
    context,
    decisionTimeMs: s.decisionTimeMs,
    state: 'unavailable',
    reason: 'provider_deadline',
  };
  const r = inspectHorseTurnCensus(packet, x.batch(), api);
  expect(r.turns[2]).toMatchObject({
    inputBinding: 'canonical_digest_and_read_frame',
    historyReason: 'provider_deadline',
  });
  expect(sanitizeHorseTurnCensusResult(r)).toEqual(r);
  const good = structuredClone(s.ownPublicHistoryProvenance);
  for (const invalid of [
    { ...good, decisionTimeMs: good.decisionTimeMs + 1 },
    { ...good, state: 'pending' },
    { ...good, reason: 'private provider text' },
    { ...good, extra: true },
    { ...good, context: { ...good.context, observerId: '90000000-0000-4000-8000-000000000999' } },
    { ...good, context: { ...good.context, variant: 'plo8' } },
    { ...good, context: { ...good.context, format: 'mtt' } },
  ]) {
    s.ownPublicHistoryProvenance = invalid;
    expect(inspectHorseTurnCensus(packet, x.batch(), api).turns[2].historyReason).toBe('unknown');
  }
  delete s.ownPublicHistoryProvenance;
  expect(inspectHorseTurnCensus(packet, x.batch(), api).turns[2].historyReason).toBe('unknown');
});
