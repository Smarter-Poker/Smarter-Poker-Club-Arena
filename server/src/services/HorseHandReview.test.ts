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
    /*
     * UPDATED 2026-09-01. This used to assert an empty array. A winning hand
     * still carries no LEAK tag - that is the property worth pinning and it
     * is unchanged - but the baseInput line bets the river and reaches
     * showdown, so it now also carries the outcome-neutral river_aggr_won
     * record. See the "river aggression is recorded on both outcomes" block
     * at the foot of this file for why that record has to exist: without it
     * river_aggr_lost has no denominator, and it was the largest single line
     * in the 2026-08-31 audit at -97,229bb.
     */
    const LEAK_TAGS = rows[0].leak_tags.filter((t: string) => t !== 'river_aggr_won');
    expect(LEAK_TAGS).toEqual([]);
    expect(rows[0].leak_tags).toContain('river_aggr_won');
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

/**
 * ═══ THE WIN SIDE OF RIVER AGGRESSION (2026-09-01) ═══
 *
 * MEASURED on 2026-08-31: `river_aggr_lost` carried 1,545 hands and
 * -97,229bb - about five times the whole day's horse net of -19,984bb - and
 * dominated the tag mix of nine of the ten bleeding horses in the audit. It
 * is the single largest line in the report and it could not be acted on,
 * because `detectLeaks` returns early on any winning hand, so the tag exists
 * only on losses. There is no denominator: a horse that bets every river and
 * a horse that value-bets perfectly leave identical evidence, since the 5,277
 * winning hands stored that day carried no tag at all.
 *
 * Capping the river on that number would be tuning against a sample selected
 * for being negative. These tests pin the mirror, and pin that it stays out of
 * the leak machinery.
 */
describe('river aggression is recorded on both outcomes', () => {
  const riverBetLine = [
    { action: 'bet', stage: 'flop', amount: 10 },
    { action: 'bet', stage: 'river', amount: 40 },
  ];

  it('a winning river bet is tagged river_aggr_won', () => {
    const tags = detectLeaks({
      netBB: 60,
      invested: 50,
      bigBlind: 2,
      variant: 'nlh',
      holeCards: [c('A', h), c('K', d)],
      board: [c('K', s), c('T', s), c('4', s), c('7', d), c('2', h)],
      heroActions: riverBetLine,
      wentToShowdown: true,
    });
    expect(tags).toContain('river_aggr_won');
  });

  it('the same line that loses is still tagged river_aggr_lost', () => {
    const tags = detectLeaks({
      netBB: -60,
      invested: 50,
      bigBlind: 2,
      variant: 'nlh',
      holeCards: [c('A', h), c('K', d)],
      board: [c('K', s), c('T', s), c('4', s), c('7', d), c('2', h)],
      heroActions: riverBetLine,
      wentToShowdown: true,
    });
    expect(tags).toContain('river_aggr_lost');
    expect(tags).not.toContain('river_aggr_won');
  });

  it('a win carries the outcome record and NO leak tag', () => {
    // The early return is load-bearing: every other tag in this file is a
    // verdict that the hand was played badly, and a hand that won 60bb was
    // not. Only the outcome-neutral line record crosses over.
    const tags = detectLeaks({
      netBB: 60,
      invested: 200, // would trip preflop_stackoff on a loss
      bigBlind: 2,
      variant: 'nlh',
      holeCards: [c('A', h), c('K', d)],
      board: [c('K', s), c('T', s), c('4', s), c('7', d), c('2', h)],
      heroActions: [{ action: 'all_in', stage: 'preflop', amount: 400 }],
      wentToShowdown: true,
    });
    expect(tags).not.toContain('preflop_stackoff');
    expect(tags).not.toContain('big_bet_fold');
    expect(tags).toEqual([]);
  });

  it('a win without river aggression is tagged nothing at all', () => {
    const tags = detectLeaks({
      netBB: 40,
      invested: 20,
      bigBlind: 2,
      variant: 'nlh',
      holeCards: [c('A', h), c('K', d)],
      board: [c('K', s), c('T', s), c('4', s), c('7', d), c('2', h)],
      heroActions: [
        { action: 'bet', stage: 'flop', amount: 10 },
        { action: 'check', stage: 'river' },
      ],
      wentToShowdown: true,
    });
    expect(tags).toEqual([]);
  });

  it('a win that never reached showdown is not river aggression', () => {
    const tags = detectLeaks({
      netBB: 40,
      invested: 20,
      bigBlind: 2,
      variant: 'nlh',
      holeCards: [c('A', h), c('K', d)],
      board: [c('K', s), c('T', s), c('4', s), c('7', d), c('2', h)],
      heroActions: riverBetLine,
      wentToShowdown: false,
    });
    expect(tags).toEqual([]);
  });

  it('the self-tuner cannot mistake the win record for a leak', () => {
    // The tuner reads tags by exact name. If river_aggr_won ever appeared in
    // one of those gates, a PROFITABLE river would tighten the horse - the
    // precise inversion this change exists to prevent.
    const tuner = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'HorseSelfTuner.ts'),
      'utf8'
    );
    expect(tuner).not.toContain('river_aggr_won');
  });
});
