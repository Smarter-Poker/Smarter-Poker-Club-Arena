import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureHorseHandJournalContext } from '../../engine/HorseDecisionHandBinding.js';
import type {
  CompletedHandObservation,
  DecidePineappleDiscardRequest,
} from '../../engine/horseDecision/protocol.js';
import type { ActionRecord } from '../../types.js';
import {
  bindHorseDiscardExecutionToHand,
  horseDiscardHandKey,
  horseDiscardTurnKey,
  validateHorseDiscardDecision,
  validateHorseDiscardExecution,
  type HorseDiscardDecisionCapture,
  type HorseDiscardExecutionObservation,
} from './discard.js';
import { journalHash, makeHorseJournalRecord, type HorseJournalKind } from './record.js';
import { reconcileHorseJournalHand, readHorseJournalHand } from './review.js';
import { HorseDecisionJournalStore } from './store.js';

const table = '10000000-0000-4000-8000-000000000001';
const actor = '20000000-0000-4000-8000-000000000001';
const committed = '30000000-0000-4000-8000-000000000001';
const producer = '40000000-0000-4000-8000-000000000001';
const coordinate = `${table}:12:9`;
const handKey = journalHash(coordinate);
function fixture() {
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
      lane: 'choice',
      priorActions: captureHorseHandJournalContext([])!,
    },
  };
  const acceptedRecord: ActionRecord = {
    seat: 10,
    userId: actor,
    action: 'discard',
    amount: 0,
    timestamp: 1001,
    stage: 'pineapple_discard',
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
    acceptedActionOrdinal: 0,
    priorActions: captureHorseHandJournalContext([])!,
  };
  const hand: CompletedHandObservation = {
    generation: 12,
    fence: `${coordinate}:observe`,
    handKey: `${table}:12`,
    committedHandId: committed,
    bigBlind: 2,
    actions: [{ ...acceptedRecord, origin: 'unknown' }],
  };
  return { request, d, e, hand };
}
function record(kind: HorseJournalKind, payload: unknown, sequence: number) {
  const request =
    kind === 'discard_decision'
      ? (payload as HorseDiscardDecisionCapture).snapshot
      : (payload as HorseDiscardExecutionObservation).request;
  return makeHorseJournalRecord(
    {
      producerId: producer,
      sequence,
      sourceRelease: 'a'.repeat(40),
      atMs: 1002 + sequence,
      kind,
      handKey,
      turnKey: kind === 'accepted_hand' ? handKey : journalHash(horseDiscardTurnKey(request)),
    },
    payload
  );
}
const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
);

describe('private Pineapple discard lineage', () => {
  it('anchors exact physical-card fence at canonical seat10 without parsing card delimiters', () => {
    const { request, d, e, hand } = fixture();
    expect(horseDiscardHandKey(request)).toBe(coordinate);
    expect(() => validateHorseDiscardDecision(d)).not.toThrow();
    expect(() => validateHorseDiscardExecution(e)).not.toThrow();
    expect(bindHorseDiscardExecutionToHand(e, hand)).toBe(0);
    expect(hand.actions![0]!.observationIdentity).toBeUndefined();
  });
  it.each([
    'context',
    'actor',
    'seat0',
    'seat11',
    'lease0',
    'lease_overflow',
    'hand',
    'clock',
    'prefix',
    'fence',
    'variant',
    'duplicate',
    'future_board',
  ])('refuses forged request attribution: %s', (fault) => {
    const { request } = fixture();
    const c = request.journalContext!;
    if (fault === 'context') request.journalContext = null;
    if (fault === 'actor') c.actorId = 'not-an-actor';
    if (fault === 'seat0') c.seat = 0;
    if (fault === 'seat11') c.seat = 11;
    if (fault === 'lease0') c.leaseGeneration = '0';
    if (fault === 'lease_overflow') c.leaseGeneration = '9223372036854775808';
    if (fault === 'hand') c.handNumber = 13;
    if (fault === 'clock') c.requestedAtMs = NaN;
    if (fault === 'prefix')
      c.priorActions = { version: 1, actionCount: -1, actionsDigest: 'a'.repeat(64) };
    if (fault === 'fence') request.fence += ':unverified';
    if (fault === 'variant') request.gameVariant = 'plo4';
    if (fault === 'duplicate') request.cards[1] = request.cards[0]!;
    if (fault === 'future_board') request.communityCards.push({ rank: '4', suit: 'clubs' });
    expect(horseDiscardHandKey(request)).toBeNull();
  });
  it.each([
    'choice',
    'discarded',
    'retained',
    'original',
    'board',
    'actor',
    'seat',
    'record_actor',
    'record_time',
    'record_stage',
    'ordinal',
    'prefix',
  ])('independently rejects altered private controller evidence: %s', (fault) => {
    const { e, hand } = fixture();
    const c = e.controller as any;
    if (fault === 'choice') e.selectedIndex = 1;
    if (fault === 'discarded') c.discardedCard = c.originalCards[0];
    if (fault === 'retained') c.retainedCards.reverse();
    if (fault === 'original') c.originalCards.reverse();
    if (fault === 'board') c.communityCards.reverse();
    if (fault === 'actor') c.actorId = table;
    if (fault === 'seat') c.seat = 9;
    if (fault === 'record_actor') c.acceptedRecord.userId = table;
    if (fault === 'record_time') c.acceptedRecord.timestamp = 999;
    if (fault === 'record_stage') c.acceptedRecord.stage = 'preflop';
    if (fault === 'ordinal') e.acceptedActionOrdinal = 1;
    if (fault === 'prefix')
      e.priorActions = { version: 1, actionCount: 0, actionsDigest: 'invalid' };
    expect(() => validateHorseDiscardExecution(e)).toThrow();
    expect(bindHorseDiscardExecutionToHand(e, hand)).toBeNull();
  });
  it('checks actual commit prefix independently from the earlier request prefix', () => {
    const { e, hand } = fixture();
    const other: ActionRecord = {
      seat: 1,
      userId: table,
      action: 'discard',
      amount: 0,
      timestamp: 1000,
      stage: 'flop',
    };
    e.priorActions = captureHorseHandJournalContext([other])!;
    e.acceptedActionOrdinal = 1;
    hand.actions!.unshift(other);
    expect(bindHorseDiscardExecutionToHand(e, hand)).toBe(1);
    hand.actions![0]!.amount = 1;
    expect(bindHorseDiscardExecutionToHand(e, hand)).toBeNull();
  });
  it.each(['record', 'lease', 'committed_id', 'request_prefix'])(
    'rejects an altered completed hand: %s',
    (fault) => {
      const { e, hand } = fixture();
      if (fault === 'record') hand.actions![0]!.timestamp = 1002;
      if (fault === 'lease') hand.fence = `${table}:12:10:observe`;
      if (fault === 'committed_id') hand.committedHandId = undefined;
      if (fault === 'request_prefix')
        e.request.journalContext!.priorActions = {
          version: 1,
          actionCount: 0,
          actionsDigest: 'a'.repeat(64),
        };
      expect(bindHorseDiscardExecutionToHand(e, hand)).toBeNull();
    }
  );
  it('reconciles the private choice and accepted action without revealing private data or claiming replay/GTO', () => {
    const { d, e, hand } = fixture();
    const out = reconcileHorseJournalHand(
      [
        record('discard_decision', d, 1),
        record('discard_execution', e, 2),
        record('accepted_hand', hand, 3),
      ],
      handKey
    );
    expect(out).toMatchObject({
      status: 'reconciled',
      discardDecisions: 1,
      acceptedDiscardActions: 1,
      matchedHorseDiscards: 1,
      gaps: [],
      completePopulation: false,
      replayVerified: false,
      gtoVerified: false,
      activationAllowed: false,
    });
    const json = JSON.stringify(out);
    for (const privateValue of [
      actor,
      table,
      'originalCards',
      'discardedCard',
      'hearts',
      'chosenIndex',
    ])
      expect(json).not.toContain(privateValue);
  });
  it('keeps an unaccepted result explicitly incomplete', () => {
    const { d, hand } = fixture();
    const out = reconcileHorseJournalHand(
      [record('discard_decision', d, 1), record('accepted_hand', hand, 3)],
      handKey
    );
    expect(out).toMatchObject({ status: 'incomplete', matchedHorseDiscards: 0 });
    expect(out.gaps).toContain('discard_execution_missing');
    expect(out.gaps).toContain('unmatched_discard_action');
  });
  it('does not infer the selected card from a public zero-amount discard', () => {
    const { hand } = fixture();
    const out = reconcileHorseJournalHand([record('accepted_hand', hand, 3)], handKey);
    expect(out).toMatchObject({ status: 'incomplete', matchedHorseDiscards: 0 });
    expect(out.gaps).toContain('unmatched_discard_action');
  });
  it('rejects a changed persisted worker choice despite valid record hashes', () => {
    const { d, e, hand } = fixture();
    d.cardIndex = 1;
    const out = reconcileHorseJournalHand(
      [
        record('discard_decision', d, 1),
        record('discard_execution', e, 2),
        record('accepted_hand', hand, 3),
      ],
      handKey
    );
    expect(out).toMatchObject({ status: 'incomplete', matchedHorseDiscards: 0 });
    expect(out.gaps).toContain('discard_input_mismatch');
  });
  it.each([
    'missing_decision',
    'missing_hand',
    'release',
    'order',
    'duplicate_decision',
    'duplicate_execution',
    'binding',
    'turn_key',
    'unknown_origin',
  ])('retains explicit missing/conflicting evidence: %s', (fault) => {
    const { d, e, hand } = fixture();
    if (fault === 'binding') hand.actions![0]!.timestamp = 1005;
    if (fault === 'unknown_origin')
      hand.actions!.push({ ...hand.actions![0]!, seat: 9, userId: table });
    let decision = record('discard_decision', d, 1),
      execution = record('discard_execution', e, 2);
    if (fault === 'release')
      execution = makeHorseJournalRecord({ ...execution, sourceRelease: 'b'.repeat(40) }, e);
    if (fault === 'order') execution = record('discard_execution', e, 1);
    if (fault === 'turn_key')
      execution = makeHorseJournalRecord({ ...execution, turnKey: 'b'.repeat(64) }, e);
    const rows = [decision, execution, record('accepted_hand', hand, 3)];
    if (fault === 'missing_decision') rows.shift();
    if (fault === 'missing_hand') rows.pop();
    if (fault === 'duplicate_decision') rows.push(record('discard_decision', d, 4));
    if (fault === 'duplicate_execution') rows.push(record('discard_execution', e, 4));
    const out = reconcileHorseJournalHand(rows, handKey);
    expect(out.status).not.toBe('reconciled');
    expect(out.gaps.length).toBeGreaterThan(0);
    expect(out).toMatchObject({
      completePopulation: false,
      replayVerified: false,
      gtoVerified: false,
      activationAllowed: false,
    });
  });
  it('requires the forced runout receipt from the actual flop commit', () => {
    const { d, e, hand } = fixture();
    e.request.journalContext!.lane = 'forced_runout';
    expect(() => validateHorseDiscardExecution(e)).toThrow();
    (e.controller.acceptedRecord as ActionRecord).stage = 'flop';
    hand.actions![0]!.stage = 'flop';
    expect(bindHorseDiscardExecutionToHand(e, hand)).toBe(0);
    expect(
      reconcileHorseJournalHand(
        [
          record('discard_decision', d, 1),
          record('discard_execution', e, 2),
          record('accepted_hand', hand, 3),
        ],
        handKey
      )
    ).toMatchObject({ status: 'reconciled', matchedHorseDiscards: 1 });
  });
  it('does not require a private Horse receipt for explicitly identified human discards', () => {
    const { hand } = fixture();
    hand.actions![0]!.origin = 'player';
    expect(reconcileHorseJournalHand([record('accepted_hand', hand, 3)], handKey)).toMatchObject({
      status: 'reconciled',
      acceptedDiscardActions: 1,
      matchedHorseDiscards: 0,
    });
  });
  it('durably retains and independently revalidates discard evidence after reopening the private spool', () => {
    const dir = mkdtempSync(join(tmpdir(), 'horse-discard-journal-'));
    directories.push(dir);
    const { d, e, hand } = fixture();
    const rows = [
      record('discard_decision', d, 1),
      record('discard_execution', e, 2),
      record('accepted_hand', hand, 3),
    ];
    const store = new HorseDecisionJournalStore(dir);
    expect(store.appendBatch(rows)).toEqual(['recorded', 'recorded', 'recorded']);
    store.close();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const reopened = new HorseDecisionJournalStore(dir, { readOnly: true });
    expect(reopened.readHand(handKey)).toEqual(rows);
    reopened.close();
    expect(readHorseJournalHand(dir, handKey)).toMatchObject({
      status: 'reconciled',
      matchedHorseDiscards: 1,
      replayVerified: false,
      gtoVerified: false,
      completePopulation: false,
    });
  });
});
