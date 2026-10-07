/**
 * P14.1 (2026-10-06): a flagged hand's horse reviews, their receipts and the
 * per-horse/day rollup are published by ONE call to fn_hhr_record_atomic.
 *
 * The writer this replaces upserted horse_hand_reviews and then called
 * fn_hhr_rollup_add once per inserted horse. A failed or unanswered second
 * call left a review with no rollup, its `break` dropped every later horse's
 * rollup too, and a resend could never reconcile it because the review row
 * already existed. These cases pin the engine half of the fix: one call per
 * hand carrying every qualifying row, nothing else written, every failure
 * reported under one tag and never thrown, and a resend that is byte-for-byte
 * the same request (the database answers it 'replayed').
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock('./supabase/client.js', () => ({
  supabase: { rpc: db.rpc, from: db.from },
}));
vi.mock('./errorReporter.js', () => ({ reportError: db.reportError }));

import {
  REVIEW_ROW_KEYS,
  buildReviewRows,
  recordHorseHandReviews,
  toAtomicPayloadRow,
  type HorseReviewInput,
  type HorseReviewRow,
} from './HorseHandReview.js';

const HAND = '11111111-1111-4111-8111-111111111111';
const TABLE = '22222222-2222-4222-8222-222222222222';
const HORSE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HORSE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HORSE_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const HUMAN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const card = (rank: string, suit: string) => ({ rank, suit });

/** Three horses, each 20bb+ either way, and one human: three qualifying rows. */
function threeFlaggedHorses(over: Partial<HorseReviewInput> = {}): HorseReviewInput {
  return {
    handId: HAND,
    tableId: TABLE,
    clubId: undefined,
    tournamentId: undefined,
    gameVariant: 'nlh',
    bigBlind: 2,
    playedAt: '2026-10-06T14:00:00.000Z',
    potSize: undefined,
    board: [
      card('K', 'spades'),
      card('T', 'spades'),
      card('4', 'spades'),
      card('7', 'diamonds'),
      card('2', 'hearts'),
    ],
    holeCardsAll: new Map([
      [HORSE_A, { seat: 1, cards: [card('9', 'spades'), card('6', 'spades')] }],
      [HORSE_B, { seat: 2, cards: [card('Q', 'hearts'), card('Q', 'diamonds')] }],
      [HORSE_C, { seat: 3, cards: [card('A', 'spades'), card('J', 'spades')] }],
      [HUMAN, { seat: 4, cards: [card('3', 'clubs'), card('8', 'hearts')] }],
    ]),
    contributions: new Map([
      [HORSE_A, 60],
      [HORSE_B, 60],
      [HORSE_C, 60],
      [HUMAN, 2],
    ]),
    winners: [{ userId: HORSE_C, amount: 182 }],
    actions: [
      { seat: 1, userId: HORSE_A, action: 'bet', amount: 20, stage: 'river' },
      { seat: 2, userId: HORSE_B, action: 'call', amount: 20, stage: 'river' },
      { seat: 3, userId: HORSE_C, action: 'raise', amount: 60, stage: 'river' },
      { seat: 1, userId: HORSE_A, action: 'call', amount: 40, stage: 'river' },
      { seat: 2, userId: HORSE_B, action: 'call', amount: 40, stage: 'river' },
    ],
    roster: [
      { userId: HORSE_A, isHorse: true },
      { userId: HORSE_B, isHorse: true },
      { userId: HORSE_C, isHorse: true },
      { userId: HUMAN, isHorse: false },
    ],
    ...over,
  };
}

const okReply = (rows: Array<{ horse_user_id: string }>, status = 'applied') => ({
  data: {
    version: 1,
    hand_id: HAND,
    rows: rows.map((r) => ({ horse_user_id: r.horse_user_id, status })),
  },
  error: null,
});

const atomicCalls = () => db.rpc.mock.calls.filter(([name]) => name === 'fn_hhr_record_atomic');

beforeEach(() => {
  // The once-per-process prune arms a ten-minute timer on the first call;
  // a fake clock keeps it from firing (or outliving the file).
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  vi.stubEnv('HORSE_HAND_REVIEW_ENABLED', 'true');
  vi.stubEnv('HORSE_NET_ROLLUP_ENABLED', 'false'); // no nets interval left behind
  db.rpc.mockReset();
  db.from.mockReset();
  db.reportError.mockReset();
  db.rpc.mockImplementation(
    async (name: string, args?: { p_rows?: Array<{ horse_user_id: string }> }) =>
      name === 'fn_hhr_record_atomic' ? okReply(args?.p_rows ?? []) : { data: null, error: null }
  );
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('recordHorseHandReviews publishes one hand in one atomic call', () => {
  it('sends exactly one fn_hhr_record_atomic call carrying every qualifying row', async () => {
    const input = threeFlaggedHorses();
    const expected = buildReviewRows(input);
    expect(expected).toHaveLength(3);

    await recordHorseHandReviews(input);

    expect(atomicCalls()).toHaveLength(1);
    const [, args] = atomicCalls()[0];
    expect(Object.keys(args)).toEqual(['p_rows']);
    expect(args.p_rows).toEqual(expected.map(toAtomicPayloadRow));
    expect(new Set(args.p_rows.map((r: HorseReviewRow) => r.hand_id))).toEqual(new Set([HAND]));
    expect(db.reportError).not.toHaveBeenCalled();
  });

  it('never writes horse_hand_reviews directly and never calls fn_hhr_rollup_add', async () => {
    await recordHorseHandReviews(threeFlaggedHorses());

    expect(db.from).not.toHaveBeenCalled();
    const names = db.rpc.mock.calls.map(([name]) => name);
    expect(names).not.toContain('fn_hhr_rollup_add');
    expect(names.filter((n) => n !== 'sp_prune_horse_hand_reviews')).toEqual([
      'fn_hhr_record_atomic',
    ]);
  });

  it('sends every row with exactly the 17 HorseReviewRow keys and no undefined value', async () => {
    // clubId, tournamentId and potSize are left undefined by this caller.
    await recordHorseHandReviews(threeFlaggedHorses());
    const [, args] = atomicCalls()[0];

    expect(REVIEW_ROW_KEYS).toHaveLength(17);
    for (const row of args.p_rows as Record<string, unknown>[]) {
      expect(Object.keys(row).sort()).toEqual([...REVIEW_ROW_KEYS].sort());
      for (const k of REVIEW_ROW_KEYS) expect(row[k], `${k} is undefined`).not.toBeUndefined();
      expect(row.tournament_id).toBeNull();
      expect(row.club_id).toBeNull();
      expect(row.pot_size).toBeNull();
      // What the database receives is the JSON, and JSON keeps every key.
      expect(Object.keys(JSON.parse(JSON.stringify(row))).sort()).toEqual(
        [...REVIEW_ROW_KEYS].sort()
      );
      expect(row.played_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('turns an undefined field into null rather than letting JSON drop the key', () => {
    const [row] = buildReviewRows(threeFlaggedHorses());
    const holed = { ...row, seat: undefined, board: undefined } as unknown as HorseReviewRow;
    const out = toAtomicPayloadRow(holed);
    expect(out.seat).toBeNull();
    expect(out.board).toBeNull();
    expect(Object.keys(JSON.parse(JSON.stringify(out))).sort()).toEqual(
      [...REVIEW_ROW_KEYS].sort()
    );
    // and carries nothing a caller bolted on
    const extra = toAtomicPayloadRow({ ...row, stray: 1 } as unknown as HorseReviewRow);
    expect(Object.keys(extra)).not.toContain('stray');
  });

  it('reports an rpc error under HorseHandReview.record_atomic and does not throw', async () => {
    db.rpc.mockImplementation(async (name: string) =>
      name === 'fn_hhr_record_atomic'
        ? { data: null, error: { message: 'hhr_identity_conflict' } }
        : { data: null, error: null }
    );

    await expect(recordHorseHandReviews(threeFlaggedHorses())).resolves.toBeUndefined();

    expect(atomicCalls()).toHaveLength(1); // no additive retry
    expect(db.reportError).toHaveBeenCalledTimes(1);
    const [err, tag] = db.reportError.mock.calls[0];
    expect(tag).toBe('HorseHandReview.record_atomic');
    expect((err as Error).message).toContain('hhr_identity_conflict');
  });

  it('reports a rejected rpc promise under the same tag and does not throw', async () => {
    db.rpc.mockImplementation(async (name: string) => {
      if (name === 'fn_hhr_record_atomic') throw new Error('socket hang up');
      return { data: null, error: null };
    });

    await expect(recordHorseHandReviews(threeFlaggedHorses())).resolves.toBeUndefined();

    expect(atomicCalls()).toHaveLength(1);
    expect(db.reportError).toHaveBeenCalledTimes(1);
    expect(db.reportError.mock.calls[0][1]).toBe('HorseHandReview.record_atomic');
  });

  it.each([
    ['null', null],
    ['a wrong version', { version: 2, rows: [] }],
    ['no rows array', { version: 1, rows: 'applied' }],
    ['a bare string', 'ok'],
  ])('reports an unparseable reply (%s) under the same tag', async (_label, data) => {
    db.rpc.mockImplementation(async (name: string) =>
      name === 'fn_hhr_record_atomic' ? { data, error: null } : { data: null, error: null }
    );

    await expect(recordHorseHandReviews(threeFlaggedHorses())).resolves.toBeUndefined();

    expect(db.reportError).toHaveBeenCalledTimes(1);
    expect(db.reportError.mock.calls[0][1]).toBe('HorseHandReview.record_atomic');
  });

  it('makes no call at all when the kill switch is off', async () => {
    vi.stubEnv('HORSE_HAND_REVIEW_ENABLED', 'false');

    await recordHorseHandReviews(threeFlaggedHorses());

    expect(db.rpc).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });

  it('makes no call for a hand with no qualifying row', async () => {
    // Everyone nets well under 20bb.
    await recordHorseHandReviews(
      threeFlaggedHorses({
        contributions: new Map([
          [HORSE_A, 4],
          [HORSE_B, 4],
          [HORSE_C, 4],
          [HUMAN, 2],
        ]),
        winners: [{ userId: HORSE_C, amount: 14 }],
      })
    );

    expect(atomicCalls()).toHaveLength(0);
    expect(db.from).not.toHaveBeenCalled();
    expect(db.reportError).not.toHaveBeenCalled();
  });

  it('resends a hand whose reply was lost as the identical request', async () => {
    let first = true;
    db.rpc.mockImplementation(
      async (name: string, args?: { p_rows?: Array<{ horse_user_id: string }> }) => {
        if (name !== 'fn_hhr_record_atomic') return { data: null, error: null };
        if (first) {
          first = false;
          throw new Error('response lost'); // committed, but the engine never heard
        }
        return okReply(args?.p_rows ?? [], 'replayed');
      }
    );
    const input = threeFlaggedHorses();

    await recordHorseHandReviews(input);
    await recordHorseHandReviews(input);

    const calls = atomicCalls();
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1][1])).toBe(JSON.stringify(calls[0][1]));
    // Only the lost reply is reported; the replayed answer is a success.
    expect(db.reportError).toHaveBeenCalledTimes(1);
  });
});
