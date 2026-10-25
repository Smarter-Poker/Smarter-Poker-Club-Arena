import { writeHandFacts } from '../supabase/handFacts.js';
import { accumulateBoard } from '../../engine/presentation/handEventFrames.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRiverAcceptedOracleReader } from './riverAcceptedOracle.js';
import { correctiveFixture, HAND, HAND_KEY, TABLE } from './fixture.test-support.js';
import { riverReferenceFixture, cards } from './riverReference.test-support.js';
import {
  journalHash,
  makeHorseJournalRecord,
  type HorseJournalRecord,
} from '../horseDecisionJournal/record.js';
import {
  readAcceptedRosterReturn,
  ACCEPTED_ROSTER_PRODUCER_VERSION,
} from '../horseAcceptedRoster/acceptance.js';
import type { AcceptedRoster } from '../horseAcceptedRoster/contract.js';
import {
  createHorseExecutionWitness,
  settleHorseExecutionWitness,
  retireHorseExecutionWitness,
} from '../../engine/HorseExecutionWitness.js';
import { buildHorseDecisionKey } from '../../engine/horseDecision/protocol.js';
import { correctiveReferenceBinding, correctiveUtilityContextDigest } from './review.js';
import { evidenceDigest } from './authority.js';
import { resolveKernelOriginalInput } from './kernelOriginalInput.js';
const db = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  calls: [] as Array<{ sql: string; values?: unknown[] }>,
  failure: false,
}));
vi.mock('pg', () => ({
  default: {
    Client: class {
      async connect() {}
      async end() {}
      async query(sql: string, values?: unknown[]) {
        db.calls.push({ sql, values });
        if (db.failure) throw Error('private connection/card/secret error');
        return { rows: sql.trimStart().startsWith('SELECT') ? db.rows : [] };
      }
    },
  },
}));
vi.mock('../supabase/client.js', () => ({
  supabase: {
    from: () => {
      throw Error('no database allowed');
    },
  },
}));
function sourceFixture(holding = 'As Ah', opponentHolding = 'Ks Kh', stats?: unknown) {
  const f = correctiveFixture(),
    players = f.snapshot.gameState.players;
  const ref = riverReferenceFixture();
  ref.hero = cards(holding);
  ref.original.snapshot.player.cards = ref.hero;
  ref.range = [{ cards: cards(opponentHolding), weight: 1 }];
  const hero = players[0],
    opponent = players[1];
  if (!hero || !opponent) throw Error('synthetic roster requires two actors');
  const snapshot = ref.original.snapshot;
  snapshot.player = { ...snapshot.player, user_id: hero.user_id };
  snapshot.gameState.players = snapshot.gameState.players.map((p, i) => ({
    ...p,
    user_id: i === 0 ? hero.user_id : opponent!.user_id,
  }));
  snapshot.gameState.actionHistory = structuredClone(f.snapshot.gameState.actionHistory!).map(
    (a) => ({
      ...a,
      stage: a.action === 'all_in' ? ('river' as const) : a.stage,
    })
  );
  snapshot.fence = f.snapshot.fence;
  snapshot.generation = f.snapshot.generation;
  snapshot.requestId = f.snapshot.requestId;
  snapshot.decisionTimeMs = f.snapshot.decisionTimeMs;
  snapshot.decisionKey = buildHorseDecisionKey(snapshot);
  ref.original = { snapshot, readFrame: f.capture.readFrame };
  const sourceStats =
    stats === 'omit'
      ? undefined
      : (stats ?? {
          version: 2,
          facts: snapshot.gameState.players.map((p, i) => ({
            hand_id: HAND,
            table_id: TABLE,
            user_id: p.user_id,
            seat: p.seat,
            game_variant: 'nlh',
            big_blind: 2,
            tournament_id: null,
            played_at: '2026-09-14T14:00:00.000Z',
            invested: 75,
            hole_cards: i === 0 ? ref.hero : cards(opponentHolding),
          })),
          transfers: [],
        });
  const payloadText = JSON.stringify(
    {
      accepted_hand_facts: {
        contributions: { [hero.user_id]: 75, [opponent!.user_id]: 75 },
        returned_uncalled: {},
        ...(sourceStats === undefined ? {} : { stats_facts: sourceStats }),
      },
    },
    null,
    1
  );
  const payloadDigest = journalHash(payloadText);
  const roster: AcceptedRoster = {
    version: 1,
    basis: 'profiles_read_in_acceptance_transaction',
    tableId: TABLE,
    handId: HAND,
    handNumber: 12,
    capturedAt: '2026-09-14T14:00:00.000000Z',
    actors: players
      .map((p, i) => ({
        userId: p.user_id,
        seat: p.seat,
        seatId: `70000000-0000-4000-8000-00000000000${i + 1}`,
        seatJoinedAt: '2026-09-14T13:00:00.123456+00:00',
        classification: i === 0 ? ('horse' as const) : ('human' as const),
        status: 'canonical_boolean' as const,
      }))
      .sort((a, b) => a.userId.localeCompare(b.userId)),
  };
  const returned = readAcceptedRosterReturn(
    {
      version: 1,
      status: 'captured',
      reasons: [],
      payloadDigest,
      producerVersion: ACCEPTED_ROSTER_PRODUCER_VERSION,
      roster,
    },
    { tableId: TABLE, handNumber: 12, historyId: HAND, payloadDigest }
  );
  if (returned.status !== 'captured') throw Error('synthetic accepted roster');
  const hand = {
    ...f.hand,
    bigBlind: 2,
    acceptedActorRoster: returned.transport,
    actions: [
      ...snapshot.gameState.actionHistory!,
      {
        ...f.hand.actions!.at(-1)!,
        seat: hero.seat,
        userId: hero.user_id,
        timestamp: 1001,
        action: 'call' as const,
        amount: 50,
        stage: 'river' as const,
        publicNode: {
          version: 1,
          status: 'captured',
          actorSeat: hero.seat,
          street: 'river',
        },
      },
    ],
  };
  const decision = { action: 'call' as const, amount: 50, thinkTime: 10 };
  const capture = { ...f.capture, snapshot, decision };
  const witness = createHorseExecutionWitness(snapshot, decision, {
    requestId: 1,
    lane: 'fast',
    computeMs: 1,
    governorScale: 1,
  });
  settleHorseExecutionWitness(witness, {
    applied: true,
    acceptedActions: [{ record: hand.actions.at(-1)!, intended: true }],
  });
  const turn = journalHash(
    JSON.stringify([
      snapshot.generation,
      snapshot.fence,
      snapshot.requestId,
      snapshot.decisionKey,
      snapshot.decisionTimeMs,
    ])
  );
  const make = (kind: HorseJournalRecord['kind'], sequence: number, body: unknown) =>
    makeHorseJournalRecord(
      {
        producerId: '40000000-0000-4000-8000-000000000001',
        sequence,
        atMs: 2000,
        sourceRelease: ref.binding.sourceRelease,
        kind,
        handKey: HAND_KEY,
        turnKey: kind === 'accepted_hand' ? HAND_KEY : turn,
      },
      body
    );
  const accepted = make('accepted_hand', 3, hand);
  const row = {
    hand_id: HAND,
    table_id: TABLE,
    hand_number: '12',
    atomic_hand_id: HAND,
    atomic_table_id: TABLE,
    atomic_hand_number: '12',
    big_blind: '2.00',
    game_variant: 'nlh',
    tournament_id: null,
    actions_text: JSON.stringify(hand.actions),
    players_text: JSON.stringify(
      players.map((p) => ({
        userId: p.user_id,
        seat: p.seat,
        username: 'SYNTHETIC_PRIVATE_NAME',
        cards: ['As', 'Kd'],
      }))
    ),
    payload_text: payloadText,
    payload_digest: payloadDigest,
    core_payload_digest: 'c'.repeat(64),
    post_commit_request_digest: 'd'.repeat(64),
    stack_result_text: JSON.stringify({
      success: true,
      hand_id: '90000000-0000-4000-8000-000000000009',
      table_id: TABLE,
      hand_number: 12,
      tournament_id: null,
      players: 2,
      mode: 'delta',
      departed: [],
      rebased: {},
      written: Object.fromEntries(players.map((p) => [p.user_id, 100])),
      request: {
        stacks: players.map((p, i) => ({
          user_id: p.user_id,
          stack: 100,
          stack_before: 100,
          seat_id: `70000000-0000-4000-8000-00000000000${i + 1}`,
          seat_joined_at: '2026-09-14T13:00:00.123456+00:00',
        })),
        rake: 0,
        bbj: 0,
        inflow: 0,
      },
    }),
    roster_hand_id: HAND,
    roster_status: 'captured',
    roster_payload_digest: payloadDigest,
    roster_producer_version: ACCEPTED_ROSTER_PRODUCER_VERSION,
    roster_text: JSON.stringify(roster),
    committed_at: '2026-09-14T14:00:00.000Z',
    post_commit_completed_at: null,
    read_at: '2026-09-14T14:00:01.000Z',
    snapshot_id: '20:30:22,24',
  };
  const decisionRecord = make('decision', 1, capture),
    executionRecord = make('execution', 2, witness);
  ref.binding = correctiveReferenceBinding(decisionRecord, executionRecord, accepted);
  ref.rangeReadFrameDigest = ref.binding.readFrameDigest;
  ref.rangeDigest = evidenceDigest(ref.range);
  ref.utilityContextDigest = correctiveUtilityContextDigest(snapshot);
  return {
    records: [make('decision', 1, capture), make('execution', 2, witness), accepted],
    handKey: HAND_KEY,
    acceptedHandRecordDigest: accepted.sha256,
    rows: [row],
    ref,
  };
}
const env = {
  DATABASE_URL:
    'postgresql://offline-user:offline-password@synthetic.local:5432/postgres?sslmode=require',
};
function prepare(holding = 'As Ah', opponentHolding = 'Ks Kh', stats?: unknown) {
  const f = sourceFixture(holding, opponentHolding, stats);
  db.rows = [
    {
      ...f.rows[0],
      oracle_hole_cards_text: JSON.stringify({
        [f.ref.original.snapshot.player.user_id]: f.ref.hero,
        [f.ref.original.snapshot.gameState.players[1].user_id]: cards(opponentHolding),
      }),
      oracle_board_text: JSON.stringify(['Ac', 'Ad', '7h', '8d', '9c']),
      oracle_ended_at_text: '2026-09-14T14:00:00.000Z',
    },
  ];
  return f;
}
const run = (f: ReturnType<typeof sourceFixture>) =>
  createRiverAcceptedOracleReader(env)({
    records: f.records,
    handKey: f.handKey,
    input: f.ref,
  });
beforeEach(() => {
  db.rows = [];
  db.calls = [];
  db.failure = false;
});
async function canonicalStats() {
  const f = sourceFixture(),
    players = f.ref.original.snapshot.gameState.players;
  const stats = await writeHandFacts({
    handId: HAND,
    tableId: TABLE,
    clubId: '50000000-0000-4000-8000-000000000001',
    handNumber: 12,
    gameVariant: 'nlh',
    bigBlind: 2,
    playedAt: '2026-09-14T14:00:00.000Z',
    rakeAmount: 4,
    buttonSeat: players[0].seat,
    boardLength: 5,
    holeCardsAll: new Map(
      players.map((p, i) => [
        p.user_id,
        { seat: p.seat, cards: i === 0 ? f.ref.hero : cards('Ks Kh') },
      ])
    ),
    contributions: new Map(players.map((p) => [p.user_id, 75])),
    winners: [{ userId: players[0].user_id, amount: 146 }],
    actions: f.ref.original.snapshot.gameState.actionHistory!,
    roster: players.map((p, i) => ({ userId: p.user_id, isHorse: i === 0 })),
    collectOnly: true,
  });
  if (!stats) throw Error('canonical synthetic writer refused');
  return stats;
}
describe('bounded accepted-source river oracle', () => {
  it('authenticates the actual accepted DEEP execution against its retained FAST original', async () => {
    const f = prepare(),
      old = f.records[0],
      capture = JSON.parse(old.body),
      snapshot = f.ref.original.snapshot;
    const make = (
      kind: HorseJournalRecord['kind'],
      sequence: number,
      body: unknown,
      turnKey: string
    ) => makeHorseJournalRecord({ ...old, kind, sequence, turnKey }, body);
    const fast = make(
      'decision',
      1,
      { ...capture, decision: { action: 'fold', thinkTime: 0 } },
      old.turnKey
    );
    const fastWitness = createHorseExecutionWitness(
      snapshot,
      { action: 'fold', thinkTime: 0 },
      { requestId: snapshot.requestId, lane: 'fast', computeMs: 1, governorScale: 1 }
    );
    retireHorseExecutionWitness(fastWitness, 'second_look_replaced');
    const retired = make('execution', 2, fastWitness, old.turnKey);
    const deepSnapshot = {
      ...snapshot,
      requestId: snapshot.requestId + 1,
      type: 'DECIDE_DEEP' as const,
      rngBefore: capture.rngBefore,
      deepEquity: 2,
    };
    const deepTurn = journalHash(
      JSON.stringify([
        snapshot.generation,
        snapshot.fence,
        deepSnapshot.requestId,
        snapshot.decisionKey,
        snapshot.decisionTimeMs,
      ])
    );
    const deep = make(
      'decision',
      3,
      {
        ...capture,
        snapshot: deepSnapshot,
        originalFastBinding: {
          inputDigest: evidenceDigest(snapshot),
          readFrameDigest: evidenceDigest(capture.readFrame),
        },
      },
      deepTurn
    );
    const deepWitness = createHorseExecutionWitness(
      deepSnapshot,
      { action: 'call', amount: 50, thinkTime: 10 },
      { requestId: deepSnapshot.requestId, lane: 'deep', computeMs: 1, governorScale: 1 }
    );
    const acceptedBody = JSON.parse(f.records[2].body);
    settleHorseExecutionWitness(deepWitness, {
      applied: true,
      acceptedActions: [{ record: acceptedBody.actions.at(-1), intended: true }],
    });
    const execution = make('execution', 4, deepWitness, deepTurn),
      accepted = make('accepted_hand', 5, acceptedBody, f.handKey);
    f.records = [fast, retired, deep, execution, accepted];
    f.acceptedHandRecordDigest = accepted.sha256;
    const resolved = resolveKernelOriginalInput(f.records, deep, execution, accepted);
    if (resolved.status !== 'resolved') throw Error('synthetic DEEP original:' + resolved.reason);
    f.ref.binding = resolved.binding;
    expect(await run(f)).toMatchObject({
      status: 'accepted_source_oracle',
      oracle: { callBb: 48 },
    });
    const missingFast = {
      ...f,
      records: f.records.filter((record) => record.sha256 !== fast.sha256),
    };
    db.calls = [];
    expect(await run(missingFast)).toMatchObject({
      status: 'unavailable',
      reason: 'oracle_binding_refused',
    });
    expect(db.calls).toEqual([]);
  });

  it('uses canonical immutable paid mucked facts without another query or mutable fact table', async () => {
    const stats = await canonicalStats(),
      f = prepare('As Ah', 'Ks Kh', stats);
    db.rows[0].oracle_hole_cards_text = '{}';
    expect(await run(f)).toMatchObject({
      status: 'accepted_source_oracle',
      oracle: { callBb: 48 },
      completePopulation: false,
      playedAt: '2026-09-14T14:00:00.000Z',
    });
    expect(db.calls.filter((c) => c.sql.trimStart().startsWith('SELECT'))).toHaveLength(1);
    expect(db.calls.find((c) => c.sql.trimStart().startsWith('SELECT'))!.sql).not.toContain(
      'ca_hand_facts'
    );
  });
  it.each([
    'hand',
    'table',
    'actor',
    'seat',
    'variant',
    'blind',
    'tournament',
    'played',
    'unpaid',
    'duplicate',
    'version',
    'hero',
    'revealed',
  ] as const)('refuses authenticated canonical stats with %s mismatch', async (fault) => {
    const stats = structuredClone(await canonicalStats());
    const facts = stats.facts as Array<Record<string, unknown>>,
      fact = facts[1];
    if (fault === 'hand') fact.hand_id = TABLE;
    if (fault === 'table') fact.table_id = HAND;
    if (fault === 'actor') fact.user_id = TABLE;
    if (fault === 'seat') fact.seat = 99;
    if (fault === 'variant') fact.game_variant = 'plo5';
    if (fault === 'blind') fact.big_blind = 3;
    if (fault === 'tournament') fact.tournament_id = HAND;
    if (fault === 'played') fact.played_at = '2026-09-15T14:00:00.000Z';
    if (fault === 'unpaid') fact.invested = 0;
    if (fault === 'duplicate') facts.push(structuredClone(fact));
    if (fault === 'version') (stats as { version: number }).version = 99;
    if (fault === 'hero') facts[0].hole_cards = cards('Qs Qh');
    const f = prepare('As Ah', 'Ks Kh', stats);
    if (fault === 'revealed')
      db.rows[0].oracle_hole_cards_text = JSON.stringify({
        [f.ref.original.snapshot.gameState.players[1].user_id]: cards('Qs Qh'),
      });
    // Payload digest and accepted roster were constructed around these exact
    // bytes; recomputing hashes cannot override original actor/source scope.
    expect(await run(f)).toMatchObject({
      status: 'unavailable',
      qualified: false,
    });
    expect(db.calls.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('keeps missing or retired immutable holdings unavailable', async () => {
    const stats = await canonicalStats();
    for (const fact of stats.facts as Array<Record<string, unknown>>) fact.hole_cards = null;
    const f = prepare('As Ah', 'Ks Kh', stats);
    db.rows[0].oracle_hole_cards_text = '{}';
    expect(await run(f)).toMatchObject({
      status: 'unavailable',
      reason: 'oracle_holdings_unavailable',
    });
  });
  it('refuses legacy missing immutable stats even with revealed cards and a history timestamp', async () => {
    const f = prepare('As Ah', 'Ks Kh', 'omit');
    expect(await run(f)).toMatchObject({ status: 'unavailable', reason: 'oracle_binding_refused' });
  });
  it('binds canonical playedAt in the oracle digest', async () => {
    const stats = await canonicalStats();
    const f = prepare('As Ah', 'Ks Kh', stats),
      a = await run(f);
    for (const fact of stats.facts as Array<Record<string, unknown>>)
      fact.played_at = '2026-09-15T14:00:00.000Z';
    const g = prepare('As Ah', 'Ks Kh', stats);
    db.rows[0].oracle_ended_at_text = '2026-09-15T14:00:00.000Z';
    const b = await run(g);
    expect(a.status).toBe('accepted_source_oracle');
    expect(b).toMatchObject({
      status: 'accepted_source_oracle',
      playedAt: '2026-09-15T14:00:00.000Z',
    });
    if (a.status === 'accepted_source_oracle' && b.status === 'accepted_source_oracle')
      expect(a.oracleDigest).not.toBe(b.oracleDigest);
  });
  it('binds authenticated committedAt and refuses absent commit clock', async () => {
    const f = prepare(),
      a = await run(f);
    expect(a).toMatchObject({
      status: 'accepted_source_oracle',
      committedAt: '2026-09-14T14:00:00.000Z',
    });
    db.rows[0].committed_at = '2026-09-14T14:00:01.000Z';
    const b = await run(f);
    expect(b).toMatchObject({
      status: 'accepted_source_oracle',
      committedAt: '2026-09-14T14:00:01.000Z',
    });
    if (a.status === 'accepted_source_oracle' && b.status === 'accepted_source_oracle')
      expect(a.oracleDigest).not.toBe(b.oracleDigest);
    db.rows[0].committed_at = 'invalid';
    expect(await run(f)).toMatchObject({ status: 'unavailable' });
  });
  it('canonicalizes authenticated terminal time and refuses missing or invalid time', async () => {
    const f = prepare();
    db.rows[0].oracle_ended_at_text = '2026-09-14 09:00:00-05';
    expect(await run(f)).toMatchObject({
      status: 'accepted_source_oracle',
      playedAt: '2026-09-14T14:00:00.000Z',
    });
    for (const invalid of [null, 'invalid', '']) {
      db.rows[0].oracle_ended_at_text = invalid;
      expect(await run(f)).toMatchObject({
        status: 'unavailable',
        reason: 'oracle_binding_refused',
      });
    }
  });
  it('accepts actual persisted board strings produced by the shared history owner', async () => {
    const f = prepare();
    db.rows[0].oracle_board_text = JSON.stringify(accumulateBoard([], 'flop', f.ref.board));
    expect(await run(f)).toMatchObject({
      status: 'accepted_source_oracle',
      oracle: { foldBb: 0, callBb: 48 },
    });
  });
  it('reads exact accepted coordinates privately and independently computes a winning call', async () => {
    const f = prepare(),
      r = await run(f);
    expect(
      r,
      JSON.stringify({
        result: r,
        calls: db.calls.map((c) => c.sql.slice(0, 18)),
      })
    ).toMatchObject({
      status: 'accepted_source_oracle',
      oracle: { foldBb: 0, callBb: 48 },
      qualified: false,
      completePopulation: false,
      activationAllowed: false,
    });
    expect(db.calls[0].sql).toBe('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(db.calls.find((c) => c.sql.trimStart().startsWith('SELECT'))?.values).toEqual([
      HAND,
      TABLE,
      12,
    ]);
    expect(db.calls.at(-1)?.sql).toBe('COMMIT');
    const json = JSON.stringify(r);
    for (const text of [HAND, TABLE, 'offline-password', 'Ks', 'Kh', 'oracle_hole_cards_text'])
      expect(json).not.toContain(text);
  });
  it.each([
    'unknown-actor',
    'board',
    'source',
    'variant',
    'payload',
    'duplicate',
    'colliding-cards',
    'wrong-card-count',
    'invalid-rank',
    'decision',
    'read-frame',
  ] as const)('refuses %s without deriving a qualified oracle', async (fault) => {
    const f = prepare(),
      row = db.rows[0];
    if (fault === 'unknown-actor') row.oracle_hole_cards_text = '{"unknown_actor":[]}';
    if (fault === 'board') row.oracle_board_text = '["2c","3d","7h","8d","9c"]';
    if (fault === 'source') row.atomic_hand_id = '90000000-0000-4000-8000-000000000009';
    if (fault === 'variant') row.game_variant = 'plo5';
    if (fault === 'payload') row.payload_text = String(row.payload_text) + ' ';
    if (fault === 'duplicate') db.rows.push(structuredClone(row));
    if (fault === 'colliding-cards')
      row.oracle_hole_cards_text = JSON.stringify({
        [f.ref.original.snapshot.gameState.players[1].user_id]: f.ref.hero,
      });
    if (fault === 'wrong-card-count')
      row.oracle_hole_cards_text = JSON.stringify({
        [f.ref.original.snapshot.gameState.players[1].user_id]: cards('Ks Kh Qs'),
      });
    if (fault === 'invalid-rank')
      row.oracle_hole_cards_text = JSON.stringify({
        [f.ref.original.snapshot.gameState.players[1].user_id]: [
          { rank: '1', suit: 'spades' },
          { rank: 'K', suit: 'hearts' },
        ],
      });
    if (fault === 'decision') f.ref.binding.decisionDigest = '0'.repeat(64);
    if (fault === 'read-frame') f.ref.original.readFrame = { forged: true };
    const r = await run(f);
    expect(r).toMatchObject({
      status: 'unavailable',
      qualified: false,
      completePopulation: false,
      activationAllowed: false,
    });
    expect(r).not.toHaveProperty('oracle');
    if (db.calls.some((c) => c.sql.startsWith('BEGIN')))
      expect(db.calls.at(-1)?.sql).toBe('ROLLBACK');
  });
  it.each([
    ['2s 2h', 'Ks Kh', -25],
    ['Ks Kh', 'Kc Kd', 11.5],
  ] as const)(
    'independently prices %s against %s including costs',
    async (hero, opponent, expected) => {
      const f = prepare(hero, opponent),
        result = await run(f);
      expect(result).toMatchObject({
        status: 'accepted_source_oracle',
        oracle: { foldBb: 0, callBb: expected },
      });
    }
  );
  it('never connects with absent configuration or exposes driver errors', async () => {
    const f = prepare();
    expect(
      await createRiverAcceptedOracleReader({})({
        records: f.records,
        handKey: f.handKey,
        input: f.ref,
      })
    ).toMatchObject({
      status: 'unavailable',
      reason: 'oracle_configuration_unavailable',
    });
    expect(db.calls).toEqual([]);
    db.failure = true;
    const r = await run(f);
    expect(r).toMatchObject({
      status: 'unavailable',
      reason: 'oracle_source_unavailable',
    });
    expect(JSON.stringify(r)).not.toContain('private');
  });
});
