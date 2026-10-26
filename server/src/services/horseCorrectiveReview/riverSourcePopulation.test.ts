import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  createRiverSourcePopulationReviewer,
  isVerifiedRiverSourcePopulation,
} from './riverSourcePopulation.js';
import { correctiveFixture, TABLE } from './fixture.test-support.js';
import { riverReferenceFixture } from './riverReference.test-support.js';
import { acceptedSourceHandKey } from '../horseDailyCorrectiveReview/mapping.js';
import {
  horseJournalJson,
  journalHash,
  makeHorseJournalRecord,
} from '../horseDecisionJournal/record.js';
import { ACCEPTED_ROSTER_PRODUCER_VERSION } from '../horseAcceptedRoster/acceptance.js';
import { buildHorseDecisionKey } from '../../engine/horseDecision/protocol.js';
import { evidenceDigest } from './authority.js';
import { currentHorseDecisionRuntime } from '../../engine/horseDecision/replayState.js';
import type { CorrectivePredeclaration } from './kernelPredeclaration.js';
const state = vi.hoisted(() => ({
  trusted: new WeakSet<object>(),
  keys: [] as any[],
  source: new Map<string, any>(),
  journal: new Map<string, any>(),
  pages: [] as any[],
  windowCalls: [] as any[],
  gap: false,
  transportFault: '',
  oldKeys: new Set<string>(),
  journalCalls: [] as string[][],
}));
vi.mock('./kernelPredeclaration.js', () => ({
  isAuthenticatedCorrectivePredeclaration: (v: object) => state.trusted.has(v),
}));
vi.mock('./riverAcceptedWindow.js', () => ({
  createRiverAcceptedWindowReader: () => async (r: unknown) => {
    state.windowCalls.push(r);
    return state.pages.length
      ? state.pages.shift()
      : {
          status: 'accepted_window_page',
          ...(r as object),
          keys: state.keys,
          hasMore: false,
          next: null,
          pageDigest: 'd'.repeat(64),
        };
  },
}));
vi.mock('../horseDailyCorrectiveReview/source.js', () => ({
  createAcceptedSourceRowsReader: () => async (coords: any[]) =>
    new Map(
      coords
        .filter((c) => state.source.has(c.handId))
        .map((c) => [c.handId, state.source.get(c.handId)])
    ),
}));
vi.mock('./journalTransport.js', () => ({
  createAuthenticatedHorseJournalReader: () => async (keys: string[]) => {
    state.journalCalls.push([...keys]);
    return {
      status:
        state.transportFault === 'unbranded' || keys.some((k) => state.oldKeys.has(k))
          ? 'unavailable'
          : 'authenticated_journal_batch',
      sourceRelease: state.transportFault === 'source' ? 'b'.repeat(40) : 'a'.repeat(40),
      runtime:
        state.transportFault === 'runtime'
          ? { node: 'other', v8: 'other', arch: 'other' }
          : currentHorseDecisionRuntime(),
      recordsByHand: (state.transportFault === 'missing'
        ? keys.slice(1)
        : state.transportFault === 'reordered'
          ? [...keys].reverse()
          : keys
      ).map((handKey) => ({ handKey, records: state.journal.get(handKey) ?? [] })),
      batchDigest: 'c'.repeat(64),
    };
  },
  isAuthenticatedHorseJournalBatch: (v: any) => v.status === 'authenticated_journal_batch',
}));
// This suite tests the population join. Exact custody reconstruction and full
// journal reconciliation have their own actual-owner suites; no test result is
// exported as provider/source authority.
vi.mock('./kernelReviewInput.js', () => ({
  rebuildCorrectiveSourceCustody: () => ({
    status: 'reconstructed_unsigned',
    custodyDigest: 'c'.repeat(64),
  }),
}));
vi.mock('../horseDecisionJournal/review.js', () => ({
  reconcileHorseJournalHand: () => ({
    status: state.gap ? 'incomplete' : 'reconciled',
    gaps: state.gap ? ['execution_missing'] : [],
    requestLifecycleVerified: !state.gap,
  }),
}));
const LEASE = '90000000-0000-4000-8000-000000000009',
  SOURCE = 'a'.repeat(40),
  TIME = '2026-10-25T18:30:00.000Z';
function fixture(n: number) {
  const f = correctiveFixture(),
    ref = riverReferenceFixture(),
    players = f.snapshot.gameState.players;
  const handId = `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    number = 12 + n;
  ref.original.snapshot.player.user_id = players[0].user_id;
  ref.original.snapshot.player.seat = players[0].seat;
  ref.original.snapshot.gameState.players = ref.original.snapshot.gameState.players.map((p, i) => ({
    ...p,
    user_id: players[i].user_id,
    seat: players[i].seat,
  }));
  const coordinate = acceptedSourceHandKey(TABLE, String(number), LEASE);
  if ('reason' in coordinate) throw Error(coordinate.reason);
  const hand = {
    ...f.hand,
    generation: number,
    fence: `${TABLE}:${number}:${LEASE}:observe`,
    handKey: `${TABLE}:${number}`,
    committedHandId: handId,
  };
  const roster = {
    version: 1,
    basis: 'profiles_read_in_acceptance_transaction',
    tableId: TABLE,
    handId,
    handNumber: number,
    capturedAt: TIME,
    actors: players
      .map((p, i) => ({
        userId: p.user_id,
        seat: p.seat,
        seatId: `70000000-0000-4000-8000-00000000000${i + 1}`,
        seatJoinedAt: '2026-10-25T17:00:00.000000Z',
        classification: i === 0 ? 'horse' : 'human',
        status: 'canonical_boolean',
      }))
      .sort((a, b) => a.userId.localeCompare(b.userId)),
  };
  const payload = {
    accepted_hand_facts: {
      stats_facts: {
        version: 2,
        facts: players.map((p) => ({
          hand_id: handId,
          table_id: TABLE,
          user_id: p.user_id,
          seat: p.seat,
          game_variant: 'nlh',
          big_blind: 2,
          tournament_id: null,
          played_at: TIME,
        })),
      },
    },
  };
  const payloadText = JSON.stringify(payload),
    rosterText = JSON.stringify(roster);
  const raw = {
    hand_id: handId,
    table_id: TABLE,
    hand_number: String(number),
    atomic_hand_id: handId,
    atomic_table_id: TABLE,
    atomic_hand_number: String(number),
    payload_text: payloadText,
    payload_digest: journalHash(payloadText),
    core_payload_digest: 'b'.repeat(64),
    roster_text: rosterText,
    roster_status: 'captured',
    roster_producer_version: ACCEPTED_ROSTER_PRODUCER_VERSION,
    roster_payload_digest: journalHash(payloadText),
    committed_at: TIME,
    game_variant: 'nlh',
    tournament_id: null,
    big_blind: '2.00',
  };
  const key = {
    handId,
    tableId: TABLE,
    handNumber: String(number),
    committedAt: TIME,
    payloadDigest: raw.payload_digest,
    coreDigest: raw.core_payload_digest,
    rosterDigest: journalHash(rosterText),
    gaps: [],
  };
  const record = (kind: 'decision' | 'execution' | 'accepted_hand', seq: number, body: unknown) =>
    makeHorseJournalRecord(
      {
        producerId: '40000000-0000-4000-8000-000000000001',
        sequence: n * 3 + seq,
        atMs: 2000,
        sourceRelease: SOURCE,
        kind,
        handKey: coordinate.handKey,
        turnKey: kind === 'accepted_hand' ? coordinate.handKey : journalHash(['turn', n].join(':')),
      },
      body
    );
  ref.original.snapshot.decisionKey = buildHorseDecisionKey(ref.original.snapshot);
  const records = [
    record('decision', 1, {
      snapshot: ref.original.snapshot,
      readFrame: ref.original.readFrame,
      decision: { action: 'fold', thinkTime: 0 },
      rngBefore: 7,
    }),
    record('execution', 2, {
      executionStatus: 'intended',
      retirementReason: null,
      acceptedActions: [{}],
    }),
    record('accepted_hand', 3, hand),
  ];
  state.keys.push(key);
  state.source.set(handId, { row: raw, leaseGeneration: LEASE });
  state.journal.set(coordinate.handKey, records);
  return { key, raw, records, coordinate, payload, roster };
}
function declaration() {
  const p = {
    custodyDigest: 'e'.repeat(64),
    plan: {
      sourceRelease: SOURCE,
      producerDigest: 'f'.repeat(64),
      qualificationId: 'finite',
      evidenceClass: 'reviewed_reference',
      populationBasis: 'accepted-commit-and-immutable-played-v1',
      domain: { variant: 'nlh', mode: 'cash', format: 'cash' },
      familySize: 45,
      holdoutStartsAt: '2026-10-25T18:00:00.000Z',
      holdoutEndsAt: '2026-10-25T19:00:00.000Z',
      selectionHandKeys: [journalHash('training')],
      minimumSamples: 2,
    },
  } as unknown as CorrectivePredeclaration;
  state.trusted.add(p);
  return p;
}
const run = (p = declaration()) => createRiverSourcePopulationReviewer({})(p);
beforeEach(() => {
  state.keys = [];
  state.source.clear();
  state.journal.clear();
  state.pages = [];
  state.windowCalls = [];
  state.gap = false;
  state.transportFault = '';
  state.oldKeys.clear();
  state.journalCalls = [];
});
describe('actual acquired finite source population join', () => {
  it('brands every original eligible case from the full accepted-key window, including small pots', async () => {
    fixture(1);
    fixture(2);
    const result = await run();
    expect(result).toMatchObject({
      status: 'source_population_verified',
      acceptedHands: 2,
      eligibleCases: 2,
      sourcePopulationVerified: true,
      completePopulation: false,
      qualified: false,
    });
    expect(isVerifiedRiverSourcePopulation(result)).toBe(true);
    expect(isVerifiedRiverSourcePopulation(JSON.parse(JSON.stringify(result)))).toBe(false);
    if (result.status === 'source_population_verified') {
      expect(result.requests).toHaveLength(2);
      expect(Object.isFrozen(result.requests[0].input.original.snapshot)).toBe(true);
      expect(result.requests.map((r) => r.input.binding.sourceRelease)).toEqual([SOURCE, SOURCE]);
    }
  });
  it('refuses forged predeclaration before any source read', async () => {
    const p = declaration();
    expect(await run(JSON.parse(JSON.stringify(p)))).toMatchObject({ status: 'unavailable' });
    expect(state.windowCalls).toEqual([]);
  });
  it.each([
    'missing',
    'pin',
    'lease',
    'journal',
    'reconcile',
    'stats',
    'duplicate',
    'gap',
    'overflow',
    'training',
  ] as const)(
    'retains %s as unavailable rather than silently selecting remaining cases',
    async (fault) => {
      const a = fixture(1);
      fixture(2);
      const p = declaration();
      if (fault === 'missing') state.source.delete(a.key.handId);
      if (fault === 'pin') a.raw.payload_text += ' ';
      if (fault === 'lease') state.source.get(a.key.handId).leaseGeneration = null;
      if (fault === 'journal') state.journal.delete(a.coordinate.handKey);
      if (fault === 'reconcile') state.gap = true;
      if (fault === 'stats') {
        a.payload.accepted_hand_facts.stats_facts.facts[0].seat = 99;
        const text = JSON.stringify(a.payload);
        a.raw.payload_text = text;
        a.raw.payload_digest = journalHash(text);
        a.raw.roster_payload_digest = journalHash(text);
        a.key.payloadDigest = journalHash(text);
      }
      if (fault === 'duplicate') state.keys.push(a.key);
      if (fault === 'gap') (a.key.gaps as string[]).push('accepted_payload_missing');
      if (fault === 'overflow')
        state.pages = Array.from({ length: 79 }, () => ({ status: 'unavailable' }));
      if (fault === 'training') p.plan.selectionHandKeys.push(a.coordinate.handKey);
      const result = await run(p);
      expect(result).toMatchObject({
        status: 'unavailable',
        qualified: false,
        completePopulation: false,
      });
      expect(isVerifiedRiverSourcePopulation(result)).toBe(false);
      expect(result).not.toHaveProperty('requests');
    }
  );
  it.each(['unbranded', 'source', 'runtime', 'missing', 'reordered'])(
    'refuses authenticated transport %s gaps',
    async (fault) => {
      fixture(1);
      fixture(2);
      state.transportFault = fault;
      expect(await run()).toMatchObject({ status: 'unavailable' });
    }
  );
  it.each(['inside', 'outside'])(
    'refuses a missing accepted-actor fact before %s played-time classification',
    async (interval) => {
      const a = fixture(1);
      fixture(2);
      a.payload.accepted_hand_facts.stats_facts.facts.pop();
      if (interval === 'outside')
        a.payload.accepted_hand_facts.stats_facts.facts[0].played_at = '2026-10-25T17:59:00.000Z';
      const text = JSON.stringify(a.payload);
      a.raw.payload_text = text;
      a.raw.payload_digest = journalHash(text);
      a.raw.roster_payload_digest = journalHash(text);
      a.key.payloadDigest = journalHash(text);
      const result = await run();
      expect(result).toMatchObject({
        status: 'unavailable',
        reason: 'population_stats_actor_coverage_gap',
        eligibleCases: 0,
      });
      expect(result).not.toHaveProperty('requests');
      expect(state.journalCalls).toEqual([]);
    }
  );
  it('authenticates played-time exclusions before requesting old or missing private journals', async () => {
    fixture(1);
    fixture(2);
    const outside = fixture(3);
    for (const fact of outside.payload.accepted_hand_facts.stats_facts.facts)
      fact.played_at = '2026-10-25T17:59:00.000Z';
    const text = JSON.stringify(outside.payload);
    outside.raw.payload_text = text;
    outside.raw.payload_digest = journalHash(text);
    outside.raw.roster_payload_digest = journalHash(text);
    outside.key.payloadDigest = journalHash(text);
    state.oldKeys.add(outside.coordinate.handKey);
    state.journal.delete(outside.coordinate.handKey);
    expect(await run()).toMatchObject({
      status: 'source_population_verified',
      acceptedHands: 3,
      eligibleCases: 2,
      exclusions: { outside_immutable_played_interval: 1 },
    });
    expect(state.journalCalls.flat()).not.toContain(outside.coordinate.handKey);
  });
  it('counts a validated large wrapped journal body without applying the single-record JSON cap again', async () => {
    const a = fixture(1);
    fixture(2);
    const prior = a.records[1];
    const { version, eventId, body, sha256, bytes, ...header } = prior;
    const large = makeHorseJournalRecord(header, {
      opaque: '"'.repeat(150000),
      executionStatus: 'intended',
      retirementReason: null,
      acceptedActions: [{}],
    });
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(512 * 1024);
    state.journal.set(a.coordinate.handKey, [a.records[0], large, a.records[2]]);
    expect(await run()).toMatchObject({ status: 'source_population_verified', eligibleCases: 2 });
  });
  it('uses accepted DEEP with unique retained FAST original and excludes retired FAST', async () => {
    const a = fixture(1);
    fixture(2);
    const fast = a.records[0],
      fastCapture = JSON.parse(fast.body),
      deepSnapshot = {
        ...fastCapture.snapshot,
        type: 'DECIDE_DEEP',
        requestId: fastCapture.snapshot.requestId + 1,
        rngBefore: 7,
        deepEquity: 2,
      };
    const header = (
      record: typeof fast,
      sequence: number,
      kind: typeof fast.kind,
      turnKey: string
    ) => ({
      producerId: record.producerId,
      sequence,
      atMs: record.atMs,
      sourceRelease: record.sourceRelease,
      kind,
      handKey: record.handKey,
      turnKey,
    });
    const retired = makeHorseJournalRecord(
      header(a.records[1], fast.sequence + 1, 'execution', fast.turnKey),
      {
        executionStatus: 'not_executed',
        retirementReason: 'second_look_replaced',
        acceptedActions: [],
        executedAction: null,
        executedAmount: null,
      }
    );
    const deepTurn = journalHash('actual-accepted-deep');
    const deep = makeHorseJournalRecord(header(fast, fast.sequence + 2, 'decision', deepTurn), {
      ...fastCapture,
      snapshot: deepSnapshot,
      originalFastBinding: {
        inputDigest: evidenceDigest(fastCapture.snapshot),
        readFrameDigest: evidenceDigest(fastCapture.readFrame),
      },
    });
    const execution = makeHorseJournalRecord(
      header(fast, fast.sequence + 3, 'execution', deepTurn),
      { executionStatus: 'intended', retirementReason: null, acceptedActions: [{}] }
    );
    const accepted = makeHorseJournalRecord(
      header(a.records[2], fast.sequence + 4, 'accepted_hand', a.coordinate.handKey),
      JSON.parse(a.records[2].body)
    );
    state.journal.set(a.coordinate.handKey, [fast, retired, deep, execution, accepted]);
    const result = await run();
    expect(result).toMatchObject({
      status: 'source_population_verified',
      eligibleCases: 2,
      exclusions: { retired_not_executed_decision: 1 },
    });
    if (result.status === 'source_population_verified') {
      const request = result.requests.find((r) => r.handKey === a.coordinate.handKey)!;
      expect(request.input.original.snapshot.type).toBe('DECIDE_FAST');
      expect(request.input.binding.decisionDigest).toBe(deep.sha256);
      expect((request.input.binding as any).kernelOriginal.decisionDigest).toBe(fast.sha256);
    }
  });
  it.each(['asset', 'dealt-seats'])(
    'refuses missing original %s metadata instead of excluding the hand',
    async (field) => {
      const a = fixture(1);
      fixture(2);
      const prior = a.records[0],
        capture = JSON.parse(prior.body);
      if (field === 'asset') delete capture.snapshot.gameState.asset;
      else delete capture.snapshot.gameState.dealtSeatIds;
      capture.snapshot.decisionKey = buildHorseDecisionKey(capture.snapshot);
      const { version, eventId, body, sha256, bytes, ...header } = prior;
      const changed = makeHorseJournalRecord(header, capture);
      state.journal.set(a.coordinate.handKey, [changed, ...a.records.slice(1)]);
      const result = await run();
      expect(result).toMatchObject({
        status: 'unavailable',
        reason: 'population_original_model_gap',
        eligibleCases: 0,
      });
      expect(result).not.toHaveProperty('requests');
    }
  );
  it('counts authenticated human and other-variant exclusions without missing eligible cases', async () => {
    fixture(1);
    fixture(2);
    const human = fixture(3);
    for (const actor of human.roster.actors) actor.classification = 'human';
    human.raw.roster_text = JSON.stringify(human.roster);
    human.key.rosterDigest = journalHash(human.raw.roster_text);
    const other = fixture(4);
    other.raw.game_variant = 'plo5';
    const result = await run();
    expect(result).toMatchObject({
      status: 'source_population_verified',
      acceptedHands: 4,
      eligibleCases: 2,
      exclusions: { human_only_hand: 1, other_variant: 1 },
    });
  });
  it('follows actual reader cursors and binds the full page chain', async () => {
    fixture(1);
    fixture(2);
    const keys = [...state.keys],
      p = declaration(),
      next = { committedAt: TIME, handId: keys[0].handId };
    state.pages = [
      {
        status: 'accepted_window_page',
        startsAt: p.plan.holdoutStartsAt,
        endsAt: p.plan.holdoutEndsAt,
        after: null,
        keys: [keys[0]],
        hasMore: true,
        next,
        pageDigest: '1'.repeat(64),
      },
      {
        status: 'accepted_window_page',
        startsAt: p.plan.holdoutStartsAt,
        endsAt: p.plan.holdoutEndsAt,
        after: next,
        keys: [keys[1]],
        hasMore: false,
        next: null,
        pageDigest: '2'.repeat(64),
      },
    ];
    expect(await run(p)).toMatchObject({ status: 'source_population_verified', acceptedHands: 2 });
    expect(state.windowCalls[1].after).toEqual(next);
  });
});
