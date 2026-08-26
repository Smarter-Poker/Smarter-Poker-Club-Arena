/**
 * HORSE HAND REVIEW (Dan 2026-08-26) — pure-logic tests for the 20bb flag.
 * IO (supabase insert/rpc) is exercised nowhere here by design: buildReviewRows
 * and detectLeaks are pure, and the writer is fire-and-forget in production.
 */
import { describe, it, expect } from 'vitest';
import { buildReviewRows, detectLeaks, type HorseReviewInput } from './HorseHandReview.js';
import type { Card } from '../types.js';

const c = (rank: string, suit: string): Card => ({ rank, suit }) as Card;
const s = 'spades';
const h = 'hearts';
const d = 'diamonds';
const cl = 'clubs';

function baseInput(over: Partial<HorseReviewInput> = {}): HorseReviewInput {
  return {
    handId: '11111111-1111-1111-1111-111111111111',
    tableId: '22222222-2222-2222-2222-222222222222',
    tournamentId: null,
    clubId: null,
    gameVariant: 'plo6',
    bigBlind: 2,
    playedAt: '2026-08-26T14:00:00.000Z',
    potSize: 120,
    board: [c('K', s), c('T', s), c('4', s), c('7', d), c('2', h)],
    holeCardsAll: new Map([
      [
        'horse-1',
        { seat: 1, cards: [c('9', s), c('6', s), c('A', h), c('J', d), c('3', cl), c('8', h)] },
      ],
      [
        'human-1',
        { seat: 2, cards: [c('A', s), c('Q', s), c('K', h), c('K', d), c('5', cl), c('4', h)] },
      ],
    ]),
    contributions: new Map([
      ['horse-1', 60],
      ['human-1', 60],
    ]),
    winners: [{ userId: 'human-1', amount: 114 }],
    actions: [
      { seat: 1, userId: 'horse-1', action: 'bet', amount: 20, stage: 'river' },
      { seat: 2, userId: 'human-1', action: 'raise', amount: 60, stage: 'river' },
      { seat: 1, userId: 'horse-1', action: 'call', amount: 40, stage: 'river' },
    ],
    roster: [
      { userId: 'horse-1', isHorse: true },
      { userId: 'human-1', isHorse: false },
    ],
    ...over,
  };
}

describe('buildReviewRows', () => {
  it('flags the losing horse at 30bb and tags the non-nut flush stack-off', () => {
    const rows = buildReviewRows(baseInput());
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.horse_user_id).toBe('horse-1');
    expect(r.net_bb).toBe(-30);
    expect(r.leak_tags).toContain('nonnut_flush_stackoff');
    expect(r.leak_tags).toContain('river_aggr_lost');
    expect(r.format).toBe('hu_cash');
  });

  it('flags a big WIN with no leak tags', () => {
    const rows = buildReviewRows(
      baseInput({
        winners: [{ userId: 'horse-1', amount: 114 }],
      })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].net_bb).toBe(27);
    expect(rows[0].leak_tags).toEqual([]);
  });

  it('ignores hands under the 20bb threshold', () => {
    const rows = buildReviewRows(
      baseInput({
        contributions: new Map([
          ['horse-1', 10],
          ['human-1', 10],
        ]),
        winners: [{ userId: 'human-1', amount: 19 }],
      })
    );
    expect(rows).toHaveLength(0);
  });

  it('never flags humans', () => {
    const rows = buildReviewRows(
      baseInput({
        roster: [
          { userId: 'horse-1', isHorse: false },
          { userId: 'human-1', isHorse: false },
        ],
      })
    );
    expect(rows).toHaveLength(0);
  });

  it('labels tournaments', () => {
    const rows = buildReviewRows(
      baseInput({ tournamentId: '33333333-3333-3333-3333-333333333333' })
    );
    expect(rows[0].format).toBe('tournament');
  });
});

describe('string boards from the settlement path', () => {
  it('board strings produce the same tags as card objects', async () => {
    const { buildReviewRows: b } = await import('./HorseHandReview.js');
    const input = baseInput({
      board: ['Kspades', '10spades', '4spades', '7diamonds', '2hearts'] as never,
    });
    const rows = b(input);
    expect(rows).toHaveLength(1);
    expect(rows[0].leak_tags).toContain('nonnut_flush_stackoff');
  });
});

describe('detectLeaks', () => {
  const board = [c('K', s), c('T', s), c('4', s), c('7', d), c('2', h)];

  it('big_bet_fold on a surrendered big investment', () => {
    const tags = detectLeaks({
      netBB: -25,
      invested: 50,
      bigBlind: 2,
      variant: 'nlh',
      holeCards: [c('A', h), c('K', d)],
      board,
      heroActions: [
        { action: 'bet', stage: 'turn', amount: 30 },
        { action: 'fold', stage: 'river' },
      ],
      wentToShowdown: false,
    });
    expect(tags).toContain('big_bet_fold');
  });

  it('preflop_stackoff when 40bb+ went in with no postflop action', () => {
    const tags = detectLeaks({
      netBB: -45,
      invested: 90,
      bigBlind: 2,
      variant: 'nlh',
      holeCards: [c('A', h), c('Q', d)],
      board: null,
      heroActions: [{ action: 'all_in', stage: 'preflop', amount: 90 }],
      wentToShowdown: true,
    });
    expect(tags).toContain('preflop_stackoff');
  });

  it('second nut flush gets its own tag', () => {
    const tags = detectLeaks({
      netBB: -30,
      invested: 60,
      bigBlind: 2,
      variant: 'plo4',
      holeCards: [c('Q', s), c('2', s), c('J', d), c('J', cl)],
      board,
      heroActions: [{ action: 'call', stage: 'river', amount: 40 }],
      wentToShowdown: true,
    });
    expect(tags).toContain('second_nut_flush_stackoff');
    expect(tags).not.toContain('nonnut_flush_stackoff');
  });

  it('wins never carry leak tags', () => {
    const tags = detectLeaks({
      netBB: 40,
      invested: 60,
      bigBlind: 2,
      variant: 'plo6',
      holeCards: [c('9', s), c('6', s), c('A', h), c('J', d)],
      board,
      heroActions: [{ action: 'call', stage: 'river', amount: 40 }],
      wentToShowdown: true,
    });
    expect(tags).toEqual([]);
  });
});
