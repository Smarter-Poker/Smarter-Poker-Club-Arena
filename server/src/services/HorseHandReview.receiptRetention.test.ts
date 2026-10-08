/**
 * Receipt retention (20261008041150): the once-per-process retention callback
 * prunes the hand reviews and then, in a second statement of its own, the
 * replay receipts. The review prune already spends most of service_role's
 * 8 s statement timeout, so the receipts never ride inside it, and the
 * receipt prune runs whether or not the review prune succeeded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HorseReviewInput } from './HorseHandReview.js';

const db = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock('./supabase/client.js', () => ({
  supabase: { rpc: db.rpc, from: db.from },
}));
vi.mock('./errorReporter.js', () => ({ reportError: db.reportError }));

const HAND = '11111111-1111-4111-8111-111111111111';
const TABLE = '22222222-2222-4222-8222-222222222222';
const HORSE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HUMAN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TEN_MINUTES = 10 * 60 * 1000;
const PRUNES = ['sp_prune_horse_hand_reviews', 'sp_prune_horse_hand_review_receipts'];

const card = (rank: string, suit: string) => ({ rank, suit });

/** One horse 30bb down: one qualifying row, which arms the retention timer. */
function oneFlaggedHorse(): HorseReviewInput {
  return {
    handId: HAND,
    tableId: TABLE,
    clubId: undefined,
    tournamentId: undefined,
    gameVariant: 'nlh',
    bigBlind: 2,
    playedAt: '2026-10-08T05:00:00.000Z',
    potSize: undefined,
    board: [
      card('K', 'spades'),
      card('T', 'spades'),
      card('4', 'spades'),
      card('7', 'diamonds'),
      card('2', 'hearts'),
    ],
    holeCardsAll: new Map([
      [HORSE_A, { seat: 1, cards: [card('Q', 'hearts'), card('Q', 'diamonds')] }],
      [HUMAN, { seat: 2, cards: [card('A', 'spades'), card('J', 'spades')] }],
    ]),
    contributions: new Map([
      [HORSE_A, 60],
      [HUMAN, 60],
    ]),
    winners: [{ userId: HUMAN, amount: 120 }],
    actions: [
      { seat: 1, userId: HORSE_A, action: 'bet', amount: 20, stage: 'river' },
      { seat: 2, userId: HUMAN, action: 'raise', amount: 60, stage: 'river' },
      { seat: 1, userId: HORSE_A, action: 'call', amount: 40, stage: 'river' },
    ],
    roster: [
      { userId: HORSE_A, isHorse: true },
      { userId: HUMAN, isHorse: false },
    ],
  };
}

type RpcReply = { data: unknown; error: { message: string } | null };

function answer(prune: (name: string) => RpcReply | Promise<RpcReply>) {
  db.rpc.mockImplementation(
    async (name: string, args?: { p_rows?: Array<{ horse_user_id: string }> }) => {
      if (name === 'fn_hhr_record_atomic') {
        const rows = args?.p_rows ?? [];
        return {
          data: {
            version: 1,
            hand_id: HAND,
            rows: rows.map((r) => ({ horse_user_id: r.horse_user_id, status: 'applied' })),
          },
          error: null,
        };
      }
      return prune(name);
    }
  );
}

/** A fresh module per case: the retention timer is armed once per process. */
async function publishAndWaitForRetention() {
  const { recordHorseHandReviews } = await import('./HorseHandReview.js');
  await recordHorseHandReviews(oneFlaggedHorse());
  expect(db.rpc.mock.calls.map(([n]) => n)).toEqual(['fn_hhr_record_atomic']);
  await vi.advanceTimersByTimeAsync(TEN_MINUTES);
  return db.rpc.mock.calls.map(([n]) => n as string).filter((n) => PRUNES.includes(n));
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  vi.stubEnv('HORSE_HAND_REVIEW_ENABLED', 'true');
  vi.stubEnv('HORSE_NET_ROLLUP_ENABLED', 'false');
  db.rpc.mockReset();
  db.from.mockReset();
  db.reportError.mockReset();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('the retention callback prunes reviews, then receipts in their own statement', () => {
  it('calls sp_prune_horse_hand_reviews and then sp_prune_horse_hand_review_receipts, once each, without arguments', async () => {
    answer(() => ({ data: 0, error: null }));
    const prunes = await publishAndWaitForRetention();
    expect(prunes).toEqual(PRUNES);
    for (const [name, args] of db.rpc.mock.calls) {
      if (PRUNES.includes(name as string)) expect(args).toBeUndefined();
    }
    expect(db.reportError).not.toHaveBeenCalled();
  });

  it('does not prune before the ten-minute retention delay', async () => {
    answer(() => ({ data: 0, error: null }));
    const { recordHorseHandReviews } = await import('./HorseHandReview.js');
    await recordHorseHandReviews(oneFlaggedHorse());
    await vi.advanceTimersByTimeAsync(TEN_MINUTES - 1);
    expect(db.rpc.mock.calls.map(([n]) => n)).toEqual(['fn_hhr_record_atomic']);
  });

  it('arms once per process: a second flagged hand adds no second prune', async () => {
    answer(() => ({ data: 0, error: null }));
    const { recordHorseHandReviews } = await import('./HorseHandReview.js');
    await recordHorseHandReviews(oneFlaggedHorse());
    await recordHorseHandReviews(oneFlaggedHorse());
    await vi.advanceTimersByTimeAsync(3 * TEN_MINUTES);
    const names = db.rpc.mock.calls.map(([n]) => n as string);
    expect(names.filter((n) => PRUNES.includes(n))).toEqual(PRUNES);
  });

  it('still prunes receipts when the review prune answers an error, and reports each under its own tag', async () => {
    answer((name) =>
      name === 'sp_prune_horse_hand_reviews'
        ? { data: null, error: { message: 'canceling statement due to statement timeout' } }
        : { data: null, error: { message: 'receipt prune refused' } }
    );
    expect(await publishAndWaitForRetention()).toEqual(PRUNES);
    expect(db.reportError.mock.calls.map(([e, tag]) => [(e as Error).message, tag])).toEqual([
      ['canceling statement due to statement timeout', 'HorseHandReview.prune'],
      ['receipt prune refused', 'HorseHandReview.prune_receipts'],
    ]);
  });

  it('still prunes receipts when the review prune rejects, and never throws', async () => {
    answer((name) => {
      if (name === 'sp_prune_horse_hand_reviews') throw new Error('fetch failed');
      return { data: 3, error: null };
    });
    expect(await publishAndWaitForRetention()).toEqual(PRUNES);
    expect(db.reportError.mock.calls.map(([e, tag]) => [(e as Error).message, tag])).toEqual([
      ['fetch failed', 'HorseHandReview.prune'],
    ]);
  });

  it('reports a rejected receipt prune under HorseHandReview.prune_receipts', async () => {
    answer((name) => {
      if (name === 'sp_prune_horse_hand_review_receipts') throw new Error('socket hang up');
      return { data: 0, error: null };
    });
    expect(await publishAndWaitForRetention()).toEqual(PRUNES);
    expect(db.reportError.mock.calls.map(([e, tag]) => [(e as Error).message, tag])).toEqual([
      ['socket hang up', 'HorseHandReview.prune_receipts'],
    ]);
  });
});
