import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHorseExecutionWitness,
  settleHorseExecutionWitness,
  retireHorseExecutionWitness,
} from '../../engine/HorseExecutionWitness.js';
import {
  captureHorseHandJournalContext,
  horsePriorActionsDigest,
} from '../../engine/HorseDecisionHandBinding.js';
import { encodeHorseDecisionReads } from '../../engine/HorseDecisionReadFrame.js';
import { HorseMind } from '../../engine/HorseMind.js';
import {
  buildHorseDecisionKey,
  type FastHorseDecisionRequest,
} from '../../engine/horseDecision/protocol.js';
import { jointPolicyFixture } from '../../engine/multiway/JointRangeFixture.test-support.js';
import { journalHash, makeHorseJournalRecord, type HorseJournalRecord } from './record.js';
import { HorseDecisionJournalStore } from './store.js';
import { readHorseJournalHand, reconcileHorseJournalHand } from './review.js';

const table = '10000000-0000-4000-8000-000000000001',
  hand = '30000000-0000-4000-8000-000000000001',
  producer = '40000000-0000-4000-8000-000000000001';
const handKey = journalHash(`${table}:12:9`);
const turn = (x: any) =>
  journalHash(
    JSON.stringify([x.generation, x.fence, x.requestId, x.decisionKey, x.decisionTimeMs])
  );
function fixture(
  variant: Parameters<typeof jointPolicyFixture>[0] = 'nlh',
  historyPrefix: readonly Record<string, unknown>[] = []
) {
  const raw = jointPolicyFixture(variant, 1, 'cash', 'preflop');
  const { hero, state } = JSON.parse(JSON.stringify(raw), (k, v) =>
    typeof v === 'string' && /^p[0-9]$/.test(v)
      ? `20000000-0000-4000-8000-00000000000${Number(v.slice(1)) + 1}`
      : v
  );
  state.toCall = 1;
  const snapshot: FastHorseDecisionRequest = {
    type: 'DECIDE_FAST',
    requestId: 1,
    generation: 7,
    fence: `${table}:12:1:9:7`,
    decisionTimeMs: 1000,
    decisionKey: '',
    player: hero,
    gameState: state,
    style: 'balanced',
    handJournalContext: captureHorseHandJournalContext([...historyPrefix, ...state.actionHistory]),
  };
  snapshot.decisionKey = buildHorseDecisionKey(snapshot);
  const decision = { action: 'call' as const, thinkTime: 50 };
  const d = {
    snapshot,
    readFrame: encodeHorseDecisionReads(
      HorseMind.createSandbox(),
      state.players,
      HorseMind.handKeyOf(state.actionHistory)
    ),
    decision,
    effects: [],
    rngBefore: 1,
    rngAfter: 2,
    computeMs: 1,
    governorScale: 1,
    runtimePins: 'incomplete',
  };
  const w = createHorseExecutionWitness(snapshot, decision, {
    requestId: 1,
    lane: 'fast',
    computeMs: 1,
    governorScale: 1,
  });
  const record = {
    seat: hero.seat,
    userId: hero.user_id,
    action: 'call' as const,
    amount: 1,
    timestamp: 1001,
    stage: 'preflop' as const,
  };
  settleHorseExecutionWitness(w, { applied: true, acceptedActions: [{ record, intended: true }] });
  const ordinal = historyPrefix.length + state.actionHistory.length;
  const a = {
    type: 'OBSERVE_COMPLETED_HAND',
    requestId: 3,
    generation: 12,
    fence: `${table}:12:9:observe`,
    handKey: `${table}:12`,
    committedHandId: hand,
    bigBlind: state.bigBlind,
    actions: [
      ...historyPrefix,
      ...state.actionHistory,
      {
        ...record,
        origin: 'horse_policy',
        publicNode: { version: 1, status: 'captured', actorSeat: hero.seat, street: 'preflop' },
        observationIdentity: {
          version: 1,
          status: 'bound',
          handId: hand,
          actionOrdinal: ordinal,
          observationId: `${hand}:${ordinal}`,
          sessionKey: 'a'.repeat(64),
        },
      },
    ],
  };
  const make = (
    kind: HorseJournalRecord['kind'],
    sequence: number,
    body: unknown,
    recordTurn = turn(snapshot)
  ) =>
    makeHorseJournalRecord(
      {
        producerId: producer,
        sequence,
        atMs: 2000,
        sourceRelease: 'a'.repeat(40),
        kind,
        handKey,
        turnKey: kind === 'accepted_hand' ? handKey : recordTurn,
      },
      body
    );
  const result = {
    d,
    w,
    a,
    make,
    rows: (): HorseJournalRecord[] => [
      make('decision', 1, result.d),
      make('execution', 2, result.w),
      make('accepted_hand', 3, result.a),
    ],
  };
  return result;
}
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const directory = () => {
  const d = mkdtempSync(join(tmpdir(), 'horse-review-test-'));
  dirs.push(d);
  return d;
};
describe('private retained-hand journal consumer', () => {
  const returned = () => ({
    seat: 1,
    userId: '20000000-0000-4000-8000-000000000001',
    action: 'return',
    amount: 100,
    timestamp: 1002,
    stage: 'flop',
    historyEvent: 'uncalled_bet_returned',
  });

  it('reconciles explicit forced posts and returned accounting rows without changing the Horse ordinal', () => {
    const post = {
      ...returned(),
      action: 'sb',
      amount: 1,
      timestamp: 999,
      stage: 'preflop',
      dead: false,
      origin: 'forced',
    };
    const { historyEvent: _event, ...forcedPost } = post;
    const f = fixture('nlh', [forcedPost]);
    f.a.actions.push(returned());
    const before = JSON.stringify(f.a);
    expect(f.w.handAnchor).toMatchObject({ status: 'anchored', actionOrdinal: 1 });
    expect(reconcileHorseJournalHand(f.rows(), handKey)).toMatchObject({
      status: 'reconciled',
      acceptedHorseActions: 1,
      matchedActions: 1,
      gaps: [],
      completePopulation: false,
      activationAllowed: false,
    });
    expect(JSON.stringify(f.a)).toBe(before);
  });

  // Exact five-field history shape emitted by ServerTableEngineRunout. Boards
  // may share the already-dealt flop; only duplicates within one board are bad.
  const ritBoard = (board: 2 | 3 = 2): Record<string, unknown> => ({
    seat: 0,
    userId: 'system',
    action:
      board === 2
        ? 'rit_board_2:2clubs,3diamonds,4hearts,Tspades,Aclubs'
        : 'rit_board_3:2clubs,3diamonds,4hearts,Kspades,Qclubs',
    stage: 'river',
    timestamp: 1002,
  });

  it.each([2, 3] as const)(
    'reconciles %s-run trailing board metadata while preserving posts, returns and full ordinals',
    (runs) => {
      const forcedPost = {
        seat: 1,
        userId: '20000000-0000-4000-8000-000000000001',
        action: 'sb',
        amount: 1,
        timestamp: 999,
        stage: 'preflop',
        dead: false,
        origin: 'forced',
      };
      const f = fixture('nlh', [forcedPost]);
      const accepted = f.a.actions[1];
      f.a.actions.push(ritBoard(2));
      if (runs === 3) f.a.actions.push(ritBoard(3));
      // The actual RIT path appends boards before settleUncalledBet emits this.
      f.a.actions.push({ ...returned(), timestamp: 1003 });
      const rows = f.rows();
      const beforeHand = JSON.stringify(f.a);
      const beforeRows = JSON.stringify(rows);
      Object.freeze(f.a.actions);
      Object.freeze(rows);
      expect(f.w.handAnchor).toMatchObject({ status: 'anchored', actionOrdinal: 1 });
      expect(accepted.observationIdentity.actionOrdinal).toBe(1);
      const report = reconcileHorseJournalHand(rows, handKey);
      expect(report).toMatchObject({
        status: 'reconciled',
        acceptedHorseActions: 1,
        matchedActions: 1,
        gaps: [],
        completePopulation: false,
        replayVerified: false,
        gtoVerified: false,
        activationAllowed: false,
      });
      expect(f.a.actions[0]).toEqual(forcedPost);
      expect(f.a.actions[1]).toBe(accepted);
      expect(f.a.actions.at(-1)).toEqual({ ...returned(), timestamp: 1003 });
      expect(JSON.stringify(f.a)).toBe(beforeHand);
      expect(JSON.stringify(rows)).toBe(beforeRows);
      expect(JSON.stringify(report)).not.toContain(String(ritBoard(2).action));
    }
  );

  it.each([
    { name: 'player seat', patch: { seat: 1 } },
    { name: 'string seat', patch: { seat: '0' } },
    { name: 'player UUID', patch: { userId: '20000000-0000-4000-8000-000000000001' } },
    { name: 'missing actor', patch: { userId: undefined } },
    { name: 'missing cards', patch: { action: 'rit_board_2:' } },
    { name: 'four cards', patch: { action: 'rit_board_2:2clubs,3diamonds,4hearts,Tspades' } },
    {
      name: 'six cards',
      patch: { action: 'rit_board_2:2clubs,3diamonds,4hearts,Tspades,Aclubs,Khearts' },
    },
    { name: 'bad rank', patch: { action: 'rit_board_2:2clubs,3diamonds,4hearts,10spades,Aclubs' } },
    { name: 'bad suit', patch: { action: 'rit_board_2:2clubs,3diamonds,4hearts,Tspade,Aclubs' } },
    {
      name: 'duplicate card',
      patch: { action: 'rit_board_2:2clubs,3diamonds,4hearts,Tspades,2clubs' },
    },
    {
      name: 'first board',
      patch: { action: 'rit_board_1:2clubs,3diamonds,4hearts,Tspades,Aclubs' },
    },
    {
      name: 'fourth board',
      patch: { action: 'rit_board_4:2clubs,3diamonds,4hearts,Tspades,Aclubs' },
    },
    {
      name: 'padded board number',
      patch: { action: 'rit_board_02:2clubs,3diamonds,4hearts,Tspades,Aclubs' },
    },
    ...['\n', '\r', '\r\n', '\u2028', '\u2029'].map((suffix) => ({
      name: `trailing line terminator ${JSON.stringify(suffix)}`,
      patch: { action: String(ritBoard().action) + suffix },
    })),
    { name: 'wrong stage', patch: { stage: 'flop' } },
    { name: 'missing stage', patch: { stage: undefined } },
    { name: 'supplied zero amount', patch: { amount: 0 } },
    { name: 'supplied null amount', patch: { amount: null } },
    { name: 'forced origin', patch: { origin: 'forced' } },
    { name: 'Horse origin', patch: { origin: 'horse_policy' } },
    { name: 'null origin', patch: { origin: null } },
    { name: 'public node', patch: { publicNode: { version: 1, status: 'captured' } } },
    {
      name: 'observation identity',
      patch: { observationIdentity: { version: 1, status: 'bound' } },
    },
    { name: 'return marker', patch: { historyEvent: 'uncalled_bet_returned' } },
    { name: 'dead-money flag', patch: { dead: false } },
    { name: 'raise flag', patch: { isFullRaise: false } },
    { name: 'missing timestamp', patch: { timestamp: undefined } },
    { name: 'negative timestamp', patch: { timestamp: -1 } },
    { name: 'fractional timestamp', patch: { timestamp: 1002.5 } },
    { name: 'unsafe timestamp', patch: { timestamp: Number.MAX_SAFE_INTEGER + 1 } },
    { name: 'string timestamp', patch: { timestamp: '1002' } },
    { name: 'null timestamp', patch: { timestamp: null } },
  ])('never reconciles an RIT metadata impostor with $name', ({ patch }) => {
    const f = fixture();
    f.a.actions.push({ ...ritBoard(), ...patch });
    const before = JSON.stringify(f.a);
    const report = reconcileHorseJournalHand(f.rows(), handKey);
    expect(report.status).not.toBe('reconciled');
    expect(report.gaps.length).toBeGreaterThan(0);
    expect(report.completePopulation).toBe(false);
    expect(report.activationAllowed).toBe(false);
    expect(JSON.stringify(f.a)).toBe(before);
  });

  it.each([
    { name: 'board three without board two', boards: [3] },
    { name: 'duplicate board two', boards: [2, 2] },
    { name: 'reversed boards', boards: [3, 2] },
  ] as const)('refuses $name in the retained RIT suffix', ({ boards }) => {
    const f = fixture();
    f.a.actions.push(...boards.map((board) => ritBoard(board)));
    expect(reconcileHorseJournalHand(f.rows(), handKey).status).not.toBe('reconciled');
  });

  it('does not hide a player action after RIT board metadata', () => {
    const f = fixture();
    f.a.actions.push(ritBoard(), {
      seat: 2,
      userId: '20000000-0000-4000-8000-000000000002',
      action: 'check',
      amount: 0,
      timestamp: 1003,
      stage: 'river',
      origin: 'player',
    });
    expect(reconcileHorseJournalHand(f.rows(), handKey).status).not.toBe('reconciled');
  });

  it.each([2, 3] as const)(
    'keeps board %s metadata invalid for live player-action anchors',
    (board) => {
      const f = fixture();
      const actions = [...f.a.actions, ritBoard(board)];
      expect(horsePriorActionsDigest(actions)).toBeNull();
      expect(captureHorseHandJournalContext(actions)).toBeNull();
    }
  );

  it('reconciles persisted RIT metadata from a fresh read-only store without rewriting it', () => {
    const dir = directory();
    const f = fixture();
    f.a.actions.push(ritBoard(), { ...returned(), timestamp: 1003 });
    const rows = f.rows();
    const store = new HorseDecisionJournalStore(dir);
    try {
      store.appendBatch(rows);
    } finally {
      store.close();
    }
    const path = join(dir, 'horse-decisions.sqlite');
    const before = readFileSync(path);
    expect(readHorseJournalHand(dir, handKey)).toMatchObject({
      status: 'reconciled',
      acceptedHorseActions: 1,
      matchedActions: 1,
      gaps: [],
    });
    expect(readFileSync(path)).toEqual(before);
    const reader = new HorseDecisionJournalStore(dir, { readOnly: true });
    try {
      expect(reader.readHand(handKey)).toEqual(rows);
    } finally {
      reader.close();
    }
  });

  it.each([
    { name: 'legacy absent marker', patch: { historyEvent: undefined } },
    { name: 'zero returned amount', patch: { amount: 0 } },
    { name: 'unknown marker', patch: { historyEvent: 'accounting' } },
    { name: 'null marker', patch: { historyEvent: null } },
    { name: 'array marker', patch: { historyEvent: ['uncalled_bet_returned'] } },
    { name: 'object marker', patch: { historyEvent: { type: 'uncalled_bet_returned' } } },
    { name: 'ordinary player choice', patch: { action: 'call', origin: 'player' } },
    { name: 'discard choice', patch: { action: 'discard' } },
    ...['unknown', 'forced', 'pre_action', 'player', 'horse_policy', 'horse_fallback', null].map(
      (origin) => ({ name: `supplied origin ${origin}`, patch: { origin } })
    ),
    {
      name: 'legacy return with forced origin',
      patch: { historyEvent: undefined, origin: 'forced' },
    },
  ])('keeps $name unqualified instead of inventing event provenance', ({ patch }) => {
    const f = fixture();
    f.a.actions.push({ ...returned(), ...patch });
    expect(reconcileHorseJournalHand(f.rows(), handKey)).toMatchObject({
      status: 'incomplete',
      gaps: expect.arrayContaining(['action_origin_unavailable']),
      completePopulation: false,
      activationAllowed: false,
    });
  });

  it.each([
    'nlh',
    'plo4',
    'plo5',
    'plo6',
    'plo8',
    'flh',
    'flo8',
    'short_deck',
    'pineapple',
  ] as const)(
    'joins original inputs, reads, execution and accepted action for %s without claiming strength',
    (variant) => {
      const f = fixture(variant),
        report = reconcileHorseJournalHand(f.rows(), handKey);
      expect(report).toMatchObject({
        status: 'reconciled',
        retainedRecords: 3,
        acceptedHorseActions: 1,
        matchedActions: 1,
        gaps: [],
        completePopulation: false,
        replayVerified: false,
        gtoVerified: false,
        activationAllowed: false,
      });
      const publicJson = JSON.stringify(report);
      for (const secret of [
        table,
        hand,
        producer,
        f.d.snapshot.player.user_id,
        'decisionKey',
        'readFrame',
        'sourceRelease',
        'sessionKey',
      ])
        expect(publicJson).not.toContain(secret);
    }
  );
  it('recovers from a fresh read-only connection without altering the spool', () => {
    const dir = directory(),
      f = fixture(),
      s = new HorseDecisionJournalStore(dir);
    s.appendBatch(f.rows());
    s.close();
    const path = join(dir, 'horse-decisions.sqlite'),
      before = readFileSync(path);
    expect(readHorseJournalHand(dir, handKey).status).toBe('reconciled');
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(dir)).toEqual(['horse-decisions.sqlite']);
    const ro = new HorseDecisionJournalStore(dir, { readOnly: true });
    expect(() => ro.append(f.rows()[0]!)).toThrow('read only');
    ro.close();
  });
  it('missing storage is unavailable and is never created by review', () => {
    const dir = join(directory(), 'absent');
    expect(readHorseJournalHand(dir, handKey)).toMatchObject({
      status: 'unavailable',
      gaps: ['storage_unavailable'],
    });
    expect(existsSync(dir)).toBe(false);
  });
  it('deduplicates exact disk replay and transport retries without counting another action', () => {
    const f = fixture(),
      rows = f.rows();
    const report = reconcileHorseJournalHand(
      [...rows, structuredClone(rows[0]!), f.make('accepted_hand', 4, { ...f.a, requestId: 99 })],
      handKey
    );
    expect(report).toMatchObject({ status: 'reconciled', matchedActions: 1, retainedRecords: 4 });
    expect(reconcileHorseJournalHand(rows.slice().reverse(), handKey).manifest).toBe(
      reconcileHorseJournalHand(rows, handKey).manifest
    );
  });
  it.each(['accepted_hand', 'decision', 'execution'] as const)(
    'reports missing %s rather than an empty successful population',
    (kind) => {
      const report = reconcileHorseJournalHand(
        fixture()
          .rows()
          .filter((r) => r.kind !== kind),
        handKey
      );
      expect(report.status).not.toBe('reconciled');
      expect(report.gaps).toContain(`${kind}_missing`);
      expect(report.matchedActions).toBe(0);
    }
  );
  it.each(['identity', 'actions', 'blind'])('refuses contradictory accepted %s', (change) => {
    const f = fixture(),
      a = structuredClone(f.a);
    if (change === 'identity') a.committedHandId = table;
    else if (change === 'blind') a.bigBlind++;
    else a.actions.at(-1)!.amount++;
    expect(
      reconcileHorseJournalHand([...f.rows(), f.make('accepted_hand', 4, a)], handKey)
    ).toMatchObject({ status: 'unavailable', gaps: ['accepted_hand_conflict'] });
  });
  it.each([
    'selected',
    'actor',
    'read_frame',
    'rng',
    'key',
    'release',
    'order',
    'status',
    'origin',
    'prefix',
    'source_turn',
  ])('makes changed %s evidence unavailable', (change) => {
    const f = fixture();
    if (change === 'selected') f.w = { ...f.w, selected: { action: 'raise', amount: 20 } };
    else if (change === 'actor')
      f.w.acceptedActions[0] = {
        ...f.w.acceptedActions[0]!,
        record: { ...f.w.acceptedActions[0]!.record, userId: table },
      };
    else if (change === 'read_frame') f.d.readFrame = { ...f.d.readFrame, sha256: '0'.repeat(64) };
    else if (change === 'rng') f.d.rngBefore = -1;
    else if (change === 'key') f.d.snapshot.decisionKey = 'bad';
    else if (change === 'status') f.w.executionStatus = 'coerced';
    else if (change === 'origin') f.a.actions.at(-1)!.origin = 'horse_fallback';
    else if (change === 'prefix')
      f.d.snapshot.handJournalContext = { ...f.d.snapshot.handJournalContext!, actionCount: 22 };
    let rows = f.rows();
    if (change === 'release')
      rows[1] = makeHorseJournalRecord({ ...rows[1]!, sourceRelease: 'b'.repeat(40) }, f.w);
    if (change === 'order') rows[1] = f.make('execution', 0 + 1, f.w);
    if (change === 'source_turn') rows[1] = f.make('execution', 2, f.w, 'f'.repeat(64));
    const report = reconcileHorseJournalHand(rows, handKey);
    expect(report.status).not.toBe('reconciled');
    expect(report.matchedActions).toBe(0);
    expect(report.gaps.length).toBeGreaterThan(0);
  });
  it('detects a Horse action that has no corresponding captured decision', () => {
    const f = fixture();
    f.a.actions.push({ ...f.a.actions.at(-1)!, timestamp: 1002 });
    expect(reconcileHorseJournalHand(f.rows(), handKey)).toMatchObject({
      status: 'incomplete',
      acceptedHorseActions: 2,
      matchedActions: 1,
      gaps: ['unmatched_horse_action'],
    });
  });
  it('does not pick the first of competing decisions for one accepted action', () => {
    const f = fixture(),
      other = fixture();
    other.d.snapshot.requestId = 9;
    other.w = createHorseExecutionWitness(other.d.snapshot, other.d.decision, {
      requestId: 9,
      lane: 'fast',
      computeMs: 1,
      governorScale: 1,
    });
    settleHorseExecutionWitness(other.w, { applied: true, acceptedActions: f.w.acceptedActions });
    const rows = [
      ...f.rows(),
      other.make('decision', 4, other.d),
      other.make('execution', 5, other.w),
    ];
    expect(reconcileHorseJournalHand(rows, handKey)).toMatchObject({
      status: 'incomplete',
      matchedActions: 0,
      gaps: ['multiple_decisions_for_action'],
    });
  });
  it('requires an explicit terminal retirement for an unexecuted decision', () => {
    const f = fixture();
    f.w = createHorseExecutionWitness(f.d.snapshot, f.d.decision, {
      requestId: 1,
      lane: 'fast',
      computeMs: 1,
      governorScale: 1,
    });
    retireHorseExecutionWitness(f.w, 'turn_abandoned');
    f.a.actions.pop();
    expect(reconcileHorseJournalHand(f.rows(), handKey)).toMatchObject({
      status: 'reconciled',
      matchedActions: 0,
      retiredDecisions: 1,
    });
  });
  it('reconciles a coerced controller amount without calling it the intended wager', () => {
    const f = fixture();
    f.w.executionStatus = 'pending';
    const accepted = {
      ...f.w.acceptedActions[0]!,
      record: { ...f.w.acceptedActions[0]!.record, amount: 2 },
    };
    settleHorseExecutionWitness(f.w, { applied: true, acceptedActions: [accepted] });
    f.a.actions.at(-1)!.amount = 2;
    expect(f.w.executionStatus).toBe('coerced');
    expect(reconcileHorseJournalHand(f.rows(), handKey)).toMatchObject({
      status: 'reconciled',
      matchedActions: 1,
    });
  });
  it.each([false, true])(
    'checks the original deep RNG and request identity (changed=%s)',
    (changed) => {
      const f = fixture();
      const s = {
        ...f.d.snapshot,
        type: 'DECIDE_DEEP' as const,
        rngBefore: changed ? 99 : f.d.rngBefore,
        deepEquity: 2,
      };
      const { effects: _effects, ...deepCapture } = f.d;
      const d = { ...deepCapture, snapshot: s };
      const w = createHorseExecutionWitness(s, d.decision, {
        requestId: s.requestId,
        lane: 'deep',
        computeMs: 1,
        governorScale: 1,
      });
      settleHorseExecutionWitness(w, { applied: true, acceptedActions: f.w.acceptedActions });
      const report = reconcileHorseJournalHand(
        [f.make('decision', 1, d), f.make('execution', 2, w), f.rows()[2]!],
        handKey
      );
      expect(report.status).toBe(changed ? 'incomplete' : 'reconciled');
    }
  );
  it('will not merge evidence from different worker producers or trust an unknown action origin', () => {
    const f = fixture(),
      rows = f.rows();
    rows[1] = makeHorseJournalRecord({ ...rows[1]!, producerId: table }, f.w);
    expect(reconcileHorseJournalHand(rows, handKey).gaps).toEqual(
      expect.arrayContaining(['execution_missing', 'decision_missing', 'unmatched_horse_action'])
    );
    f.a.actions.at(-1)!.origin = 'unknown';
    expect(reconcileHorseJournalHand(f.rows(), handKey).gaps).toContain(
      'action_origin_unavailable'
    );
  });
  it('refuses invalid input, oversized populations and record identity conflicts', () => {
    const f = fixture(),
      rows = f.rows();
    for (const changed of [
      [{ ...rows[0]!, sha256: 'bad' }],
      Array(257).fill(rows[0]),
      [...rows, f.make('decision', 1, { changed: true })],
    ])
      expect(reconcileHorseJournalHand(changed, handKey).status).toBe('unavailable');
    expect(reconcileHorseJournalHand([], handKey)).toMatchObject({
      status: 'unavailable',
      gaps: ['accepted_hand_missing'],
    });
  });
});
