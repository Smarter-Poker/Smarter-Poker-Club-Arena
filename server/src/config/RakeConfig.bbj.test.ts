/**
 * BAD BEAT JACKPOT — qualification matrix (audit 2026-08-18).
 *
 * Dan's rules, per game:
 *  - NLH/FLH: Aces full of Jacks or better must LOSE **to Quads or a
 *    Straight Flush**, loser holds an Ace, BOTH hole cards play (both sides).
 *  - PLO4/PLO8/Pineapple: quad Kings or better must lose.
 *  - PLO5: 8-high straight flush or better must lose.
 *  - PLO6 / Short Deck: not eligible.
 *  - 3+ players dealt, pot >= 10 BB, first runout only (enforced upstream).
 *
 * THE $99K FINDING: the winner's hand was never checked - 25 of 39 live
 * payouts ($99,066 of $148,121) were boat-over-boat hands the rule
 * excludes. Pinned here forever.
 */
import { describe, it, expect } from 'vitest';
import { detectBBJHit } from './RakeConfig.js';

const c = (rank: string, suit: string) => ({ rank, suit });

// Rankings per HAND_RANK: full_house 7, quads 8, straight_flush 9.
function sd(
  userId: string,
  handRanking: number,
  kickers: number[],
  hole: Array<{ rank: string; suit: string }>
) {
  return { userId, handRanking, handName: `rank${handRanking}`, kickers, holeCards: hole };
}

const DEALT = ['W', 'L', 'X'];

function detect(
  results: ReturnType<typeof sd>[],
  opts: {
    variant?: string;
    pot?: number;
    bb?: number;
    dealt?: string[];
    board?: Array<{ rank: string; suit: string }>;
  } = {}
) {
  return detectBBJHit(
    results,
    'W',
    opts.variant ?? 'nlh',
    opts.pot ?? 500,
    opts.bb ?? 10,
    (opts.dealt ?? DEALT).length,
    opts.dealt ?? DEALT,
    opts.board
  );
}

describe('THE $99K RULE: the winning hand must be Quads or a Straight Flush', () => {
  it('boat-over-boat does NOT trigger (winner has a bigger full house)', () => {
    const r = detect([
      sd('W', 7, [14, 13], [c('A', 'spades'), c('K', 'spades')]), // aces full of kings
      sd('L', 7, [14, 11], [c('A', 'hearts'), c('J', 'hearts')]), // aces full of jacks
    ]);
    expect(r.hit).toBe(false);
  });

  it('the same loser DOES trigger when the winner holds quads', () => {
    const r = detect([
      sd('W', 8, [13, 14], [c('K', 'spades'), c('K', 'clubs')]), // quad kings
      sd('L', 7, [14, 11], [c('A', 'hearts'), c('J', 'hearts')]),
    ]);
    expect(r.hit).toBe(true);
    expect(r.loserUserId).toBe('L');
    expect(r.winnerUserId).toBe('W');
  });

  it('a straight flush winner also qualifies', () => {
    const r = detect([
      sd('W', 9, [9], [c('9', 'hearts'), c('8', 'hearts')]),
      sd('L', 8, [14, 13], [c('A', 'hearts'), c('A', 'clubs')]), // quad aces STILL lose
    ]);
    expect(r.hit).toBe(true);
  });
});

describe('loser qualification minimums per game', () => {
  it('NLH: aces full of TENS does not qualify (JJ pair floor)', () => {
    const r = detect([
      sd('W', 8, [13, 14], [c('K', 'spades'), c('K', 'clubs')]),
      sd('L', 7, [14, 10], [c('A', 'hearts'), c('T', 'hearts')]),
    ]);
    expect(r.hit).toBe(false);
  });

  it('NLH: kings full does not qualify (must be ACES full)', () => {
    const r = detect([
      sd('W', 8, [13, 14], [c('K', 'spades'), c('K', 'clubs')]),
      sd('L', 7, [13, 14], [c('K', 'hearts'), c('A', 'hearts')]),
    ]);
    expect(r.hit).toBe(false);
  });

  it('NLH: loser must hold an ACE in the hole', () => {
    const r = detect([
      sd('W', 8, [13, 14], [c('K', 'spades'), c('K', 'clubs')]),
      sd('L', 7, [14, 11], [c('J', 'hearts'), c('J', 'clubs')]), // jacks full of... aces trips on board
    ]);
    expect(r.hit).toBe(false);
  });

  it('PLO: quad QUEENS does not qualify, quad KINGS does', () => {
    const queens = detect([sd('W', 9, [9], []), sd('L', 8, [12, 14], [])], { variant: 'plo' });
    expect(queens.hit).toBe(false);
    const kings = detect([sd('W', 9, [9], []), sd('L', 8, [13, 14], [])], { variant: 'plo' });
    expect(kings.hit).toBe(true);
  });

  it('PLO5: 7-high straight flush does not qualify, 8-high does', () => {
    const seven = detect([sd('W', 9, [9], []), sd('L', 9, [7], [])], { variant: 'plo5' });
    expect(seven.hit).toBe(false);
    const eight = detect([sd('W', 9, [9], []), sd('L', 9, [8], [])], { variant: 'plo5' });
    expect(eight.hit).toBe(true);
  });

  it('short deck and plo6 are never eligible', () => {
    for (const variant of ['short_deck', 'plo6']) {
      const r = detect([sd('W', 9, [9], []), sd('L', 8, [14, 13], [])], { variant });
      expect(r.hit).toBe(false);
    }
  });
});

describe('table minimums', () => {
  const QUAL = [
    sd('W', 8, [13, 14], [c('K', 'spades'), c('K', 'clubs')]),
    sd('L', 7, [14, 11], [c('A', 'hearts'), c('J', 'hearts')]),
  ];
  it('requires 3+ players dealt', () => {
    expect(detect(QUAL, { dealt: ['W', 'L'] }).hit).toBe(false);
  });
  it('requires pot >= 10 BB', () => {
    expect(detect(QUAL, { pot: 99, bb: 10 }).hit).toBe(false);
    expect(detect(QUAL, { pot: 100, bb: 10 }).hit).toBe(true);
  });
});

describe('"both cards from hand must play" (enforced when the board is provided)', () => {
  // Board: Ah Ad Jc Js 2d - aces full of jacks ON THE BOARD.
  const BOARD = [
    c('A', 'hearts'),
    c('A', 'diamonds'),
    c('J', 'clubs'),
    c('J', 'spades'),
    c('2', 'diamonds'),
  ];

  it('loser playing the board boat with one dead kicker does NOT qualify', () => {
    // Loser holds Ac + 3h: their boat is AAA-JJ using only the Ac -
    // the 3h never plays. Winner: quad jacks using both hole cards.
    const r = detect(
      [
        sd('W', 8, [11, 14], [c('J', 'hearts'), c('J', 'diamonds')]),
        sd('L', 7, [14, 11], [c('A', 'clubs'), c('3', 'hearts')]),
      ],
      { board: BOARD }
    );
    expect(r.hit).toBe(false);
  });

  it('both-cards-play loser (pocket cards both used) qualifies', () => {
    // Board: Ah Jc Js 8d 2d. Loser holds Ac Ad -> AAA JJ using BOTH aces.
    // Winner holds Jh Jd -> quad jacks using both.
    const board2 = [
      c('A', 'hearts'),
      c('J', 'clubs'),
      c('J', 'spades'),
      c('8', 'diamonds'),
      c('2', 'diamonds'),
    ];
    const r = detect(
      [
        sd('W', 8, [11, 14], [c('J', 'hearts'), c('J', 'diamonds')]),
        sd('L', 7, [14, 11], [c('A', 'clubs'), c('A', 'diamonds')]),
      ],
      { board: board2 }
    );
    expect(r.hit).toBe(true);
  });

  it('a winner with quads ON THE BOARD (kicker-only) does NOT qualify', () => {
    // Board: Jh Jc Js Jd 2d - quad jacks on board; winner's hole cards are
    // irrelevant (Ax kicker plays at most one card).
    const board3 = [
      c('J', 'hearts'),
      c('J', 'clubs'),
      c('J', 'spades'),
      c('J', 'diamonds'),
      c('2', 'diamonds'),
    ];
    const r = detect(
      [
        sd('W', 8, [11, 14], [c('A', 'clubs'), c('4', 'hearts')]),
        sd('L', 7, [14, 11], [c('A', 'hearts'), c('A', 'diamonds')]),
      ],
      { board: board3 }
    );
    expect(r.hit).toBe(false);
  });
});

describe('multiple qualifying losers: the STRONGEST beat is chosen', () => {
  it('quad-aces loser outranks an aces-full loser', () => {
    const r = detect([
      sd('W', 9, [10], [c('T', 'hearts'), c('9', 'hearts')]), // straight flush wins
      sd('L', 7, [14, 11], [c('A', 'clubs'), c('J', 'clubs')]),
      sd('X', 8, [14, 13], [c('A', 'spades'), c('A', 'diamonds')]), // quad aces - the worse beat
    ]);
    expect(r.hit).toBe(true);
    expect(r.loserUserId).toBe('X');
  });
});
