/**
 * The hand-replay reconstruction, against a real production row.
 *
 * Everything this file pins was wrong somewhere in the app before 2026-08-27:
 *
 *  - `actions[].amount` is the raise-TO level for bet/raise/all_in and the
 *    chips added for call. Three separate consumers summed it as if it were
 *    uniformly incremental (HandDetailModal's running pot,
 *    HandHistoryService.buildResult, handHistoryAdapter.investedBy), and every
 *    one over-counted a raised pot.
 *  - No starting stack is stored, so the reference layout's stack column had to
 *    be recovered from the ending stack, the gross won and the net invested.
 *  - Blinds are not in the action log at all.
 *  - A returned uncalled bet is not recorded anywhere, while `pot_size` and the
 *    ending stack both already exclude it.
 *
 * The fixture is hand 3048511 exactly as `hand_history` holds it: PLO5 1/2,
 * four dealt in, a three-bet flop war ending all-in, and a run-it-twice second
 * board recorded as a `rit_board_2:` pseudo-action. Copied from production, not
 * invented — a fixture that agrees with the code but not with the database
 * proves nothing.
 */

import { describe, it, expect } from 'vitest';
import { buildReplay, titleCase } from '../../src/utils/handReplay';

const ETHAN = 'd708c5d2-cccf-4e29-b585-1acc3d145927';
const HIGHROLLER = '00000000-0000-0000-0000-000000000039';
const BMORE = 'f847d6ec-06ba-4268-b6d0-5ec070143750';
const ANDREW = 'be96b573-6518-479a-9fc9-5576fed8e63e';

/** hand_history row 3048511, verbatim. */
const HAND_3048511 = {
  handNumber: 3048511,
  playedAt: '2026-08-25T22:31:33.000+00:00',
  gameVariant: 'plo5',
  smallBlind: 1,
  bigBlind: 2,
  potSize: 324.2,
  rakeAmount: 5,
  bbjAmount: 0.5,
  buttonSeat: 5,
  board: ['6hearts', '2spades', 'Qhearts', 'Qclubs', '2diamonds'],
  players: [
    { seat: 1, userId: ETHAN, username: 'Ethan Ray', stack: 243.4 },
    { seat: 3, userId: HIGHROLLER, username: 'HighRoller', stack: 54.5 },
    { seat: 4, userId: BMORE, username: 'Bmorecharles', stack: 318.7 },
    { seat: 5, userId: ANDREW, username: 'Andrew Wilson', stack: 242.9 },
  ],
  actions: [
    { seat: 4, stage: 'preflop', action: 'call', amount: 2, userId: BMORE },
    { seat: 5, stage: 'preflop', action: 'fold', amount: 0, userId: ANDREW },
    { seat: 1, stage: 'preflop', action: 'call', amount: 1, userId: ETHAN },
    { seat: 3, stage: 'preflop', action: 'check', amount: 0, userId: HIGHROLLER },
    { seat: 1, stage: 'flop', action: 'check', amount: 0, userId: ETHAN },
    { seat: 3, stage: 'flop', action: 'check', amount: 0, userId: HIGHROLLER },
    { seat: 4, stage: 'flop', action: 'bet', amount: 3, userId: BMORE },
    { seat: 1, stage: 'flop', action: 'fold', amount: 0, userId: ETHAN },
    { seat: 3, stage: 'flop', action: 'raise', amount: 15, userId: HIGHROLLER },
    { seat: 4, stage: 'flop', action: 'raise', amount: 50, userId: BMORE },
    { seat: 3, stage: 'flop', action: 'raise', amount: 156, userId: HIGHROLLER },
    { seat: 4, stage: 'flop', action: 'all_in', amount: 159.1, userId: BMORE },
    { seat: 3, stage: 'flop', action: 'call', amount: 3.1, userId: HIGHROLLER },
    {
      seat: 0,
      stage: 'river',
      action: 'rit_board_2:6hearts,2spades,Qhearts,6diamonds,Kdiamonds',
      userId: 'system',
    },
  ],
  winners: [
    { userId: BMORE, amount: 318.7, potIndex: 0, hand: { name: 'Four of a Kind', ranking: 8 } },
  ],
  holeCards: {
    [HIGHROLLER]: [
      { rank: '8', suit: 'clubs' },
      { rank: 'K', suit: 'spades' },
      { rank: '8', suit: 'spades' },
      { rank: '4', suit: 'hearts' },
      { rank: 'A', suit: 'diamonds' },
    ],
    [BMORE]: [
      { rank: 'J', suit: 'spades' },
      { rank: '3', suit: 'clubs' },
      { rank: 'Q', suit: 'diamonds' },
      { rank: '5', suit: 'hearts' },
      { rank: 'Q', suit: 'spades' },
    ],
  },
  showdown: [
    { seat: 3, mucked: false, user_id: HIGHROLLER, hand_name: 'Two Pair', reveal_order: 0 },
    { seat: 4, mucked: false, user_id: BMORE, hand_name: 'Four of a Kind', reveal_order: 1 },
  ],
  pots: null,
};

describe('buildReplay — a real production hand', () => {
  const m = buildReplay(HAND_3048511 as never);

  it('rebuilds the pot to the penny', () => {
    // Summing amount naively gives 392.20 — 68 over — because a raise-TO level
    // includes what that seat already had in on the street.
    expect(m.rebuiltPot).toBe(324.2);
    expect(m.reconciles).toBe(true);
  });

  it('derives positions from the real button seat', () => {
    expect(m.positions).toEqual({ 5: 'BTN', 1: 'SB', 3: 'BB', 4: 'CO' });
  });

  it('synthesises the blinds that the action log never records', () => {
    const preflop = m.streets.find((s) => s.key === 'preflop')!;
    expect(preflop.rows[0]).toMatchObject({ seat: 1, verb: 'sb', amount: 1 });
    expect(preflop.rows[1]).toMatchObject({ seat: 3, verb: 'bb', amount: 2 });
  });

  it('recovers a starting stack for every seat', () => {
    const start = Object.fromEntries(m.players.map((p) => [p.seat, p.startStack]));
    // Bmorecharles was all-in for 161.10 and ended with the whole 318.70 pot.
    expect(start).toEqual({ 1: 245.4, 3: 215.6, 4: 161.1, 5: 242.9 });
  });

  it('leaves the all-in player on zero and never goes negative', () => {
    for (const street of m.streets) {
      for (const row of street.rows) {
        if (row.stackAfter !== null) expect(row.stackAfter).toBeGreaterThanOrEqual(0);
      }
    }
    const flop = m.streets.find((s) => s.key === 'flop')!;
    const allIn = flop.rows.find((r) => r.verb === 'all_in')!;
    expect(allIn.stackAfter).toBe(0);
  });

  it('turns each raise-TO level into the chips actually added', () => {
    const flop = m.streets.find((s) => s.key === 'flop')!;
    const amounts = flop.rows.filter((r) => r.amount > 0).map((r) => r.amount);
    //  bet 3 | raise to 15 | raise to 50 (had 3) | raise to 156 (had 15) |
    //  all-in to 159.1 (had 50) | call 3.1
    expect(amounts).toEqual([3, 15, 47, 141, 109.1, 3.1]);
  });

  it('shows the board face-up so far on each street header', () => {
    const byKey = Object.fromEntries(m.streets.map((s) => [s.key, s.board.length]));
    expect(byKey.preflop).toBe(0);
    expect(byKey.flop).toBe(3);
  });

  it('reads the run-it-twice board out of the pseudo-action', () => {
    expect(m.boards).toHaveLength(2);
    expect(m.boards[1].map((c) => `${c.rank}${c.suit}`)).toEqual(['6h', '2s', 'Qh', '6d', 'Kd']);
  });

  it('never renders the system pseudo-action as a row', () => {
    const verbs = m.streets.flatMap((s) => s.rows.map((r) => r.label));
    expect(verbs.join(' ')).not.toMatch(/rit_board/);
  });

  it('orders the showdown by the engine reveal order and keeps the muck ruling', () => {
    const boardOne = m.showdown.filter((r) => r.boardIndex === 0);
    expect(boardOne[0].name).toBe('HighRoller');
    expect(boardOne[1].name).toBe('Bmorecharles');
    /* The two who folded never reached showdown, so they are NOT showdown
       rows (2026-09-04, Dan: "doesn't display the correct hands" - a six-way
       fold-around listed six seats of card backs under "Showdown"). They stay
       in the action log, where their fold is. */
    expect(boardOne.find((r) => r.name === 'Ethan Ray')).toBeUndefined();
    expect(boardOne.every((r) => r.hole !== null)).toBe(true);
  });

  it('nets each player against what they actually put in', () => {
    const net = Object.fromEntries(m.players.map((p) => [p.username, p.net]));
    expect(net.Bmorecharles).toBe(157.6); // 318.70 collected, 161.10 invested
    expect(net.HighRoller).toBe(-161.1);
    expect(net['Ethan Ray']).toBe(-2);
    expect(net['Andrew Wilson']).toBe(0);
  });

  it('carries the rake and the jackpot drop through', () => {
    expect(m.rake).toBe(5);
    expect(m.bbjFee).toBe(0.5);
  });
});

describe('buildReplay — an uncalled bet', () => {
  /**
   * `returnUncalledBet` moves the chips and emits an event, and nothing writes
   * it to `actions`. So the log shows a 40 bet nobody called, while `pot_size`
   * (6) and the ending stack both already exclude it. Without the inference
   * the rebuild comes to 46 and the whole stack column is withdrawn.
   */
  const m = buildReplay({
    handNumber: 1,
    playedAt: null,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    potSize: 6,
    buttonSeat: 3,
    board: ['6hearts', '2spades', 'Qhearts'],
    players: [
      { seat: 1, userId: 'a', username: 'A', stack: 98 },
      { seat: 2, userId: 'b', username: 'B', stack: 105 },
      { seat: 3, userId: 'c', username: 'C', stack: 97 },
    ],
    actions: [
      { seat: 1, userId: 'a', action: 'call', amount: 1, stage: 'preflop' },
      { seat: 2, userId: 'b', action: 'check', amount: 0, stage: 'preflop' },
      { seat: 3, userId: 'c', action: 'call', amount: 2, stage: 'preflop' },
      { seat: 1, userId: 'a', action: 'check', amount: 0, stage: 'flop' },
      { seat: 2, userId: 'b', action: 'bet', amount: 40, stage: 'flop' },
      { seat: 3, userId: 'c', action: 'fold', amount: 0, stage: 'flop' },
      { seat: 1, userId: 'a', action: 'fold', amount: 0, stage: 'flop' },
    ],
    winners: [{ userId: 'b', amount: 6, potIndex: 0 }],
    holeCards: {},
  } as never);

  it('infers the return, so the pot reconciles', () => {
    expect(m.rebuiltPot).toBe(6);
    expect(m.reconciles).toBe(true);
  });

  it('renders it as a negative row, the way the reference does', () => {
    const flop = m.streets.find((s) => s.key === 'flop')!;
    const ret = flop.rows.find((r) => r.verb === 'return')!;
    expect(ret.amount).toBe(-40);
    expect(ret.name).toBe('B');
  });

  it('gives the chips back on the stack column too', () => {
    const flop = m.streets.find((s) => s.key === 'flop')!;
    const bet = flop.rows.find((r) => r.verb === 'bet')!;
    const ret = flop.rows.find((r) => r.verb === 'return')!;
    expect(bet.stackAfter).toBe(59);
    expect(ret.stackAfter).toBe(99);
  });
});

describe('buildReplay — when the row cannot be trusted', () => {
  /**
   * Antes and straddles are in no column and in no action. A hand carrying one
   * rebuilds short, and the stack column is withdrawn rather than drawn wrong.
   * This is the 0.8% tail: over the 4,000 most recent live hands the rebuild
   * lands on the stored pot_size on 99.18%, and the misses are tournament antes
   * and cash straddles.
   */
  const m = buildReplay({
    handNumber: 2,
    playedAt: null,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    potSize: 50, // an ante nobody recorded
    buttonSeat: 1,
    board: [],
    players: [
      { seat: 1, userId: 'a', username: 'A', stack: 10 },
      { seat: 2, userId: 'b', username: 'B', stack: 10 },
      { seat: 3, userId: 'c', username: 'C', stack: 10 },
    ],
    actions: [{ seat: 1, userId: 'a', action: 'fold', amount: 0, stage: 'preflop' }],
    winners: [],
    holeCards: {},
  } as never);

  it('says so rather than inventing a stack curve', () => {
    expect(m.reconciles).toBe(false);
    for (const street of m.streets) {
      for (const row of street.rows) expect(row.stackAfter).toBeNull();
    }
  });

  it('still lays the hand out', () => {
    expect(m.streets.length).toBeGreaterThan(0);
    expect(m.potTotal).toBe(50);
  });
});

describe('buildReplay — a hand the engine recorded in full', () => {
  /**
   * As of 2026-08-27 the engine writes its own forced money and its own
   * uncalled-bet return (HandController.postBlinds -> FORCED_BETS_POSTED, and
   * UNCALLED_BET_RETURNED). This is the shape those hands have.
   *
   * Two things must happen and neither is optional:
   *   - the blinds must NOT be synthesised on top of recorded ones, or the pot
   *     is double-counted by exactly SB + BB;
   *   - the return must NOT be inferred on top of a recorded one, or the same
   *     chips come out twice.
   *
   * This is also the only hand shape where an ANTE is recoverable at all, so
   * it is the case that lifts the 0.8% of live hands that cannot show a stack
   * column today.
   */
  const m = buildReplay({
    handNumber: 3,
    playedAt: null,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    // 3 antes (dead) + SB 1 + BB 2 + a 6 straddle + the SB calling it for 5
    // more (their 1 is already live) = 3 + 3 + 6 + 5 = 17. The 20 bet on the
    // flop went uncalled and came straight back, so it is not in the pot.
    potSize: 17,
    buttonSeat: 3,
    board: ['6hearts', '2spades', 'Qhearts'],
    players: [
      { seat: 1, userId: 'a', username: 'A', stack: 90 },
      { seat: 2, userId: 'b', username: 'B', stack: 108 },
      { seat: 3, userId: 'c', username: 'C', stack: 93 },
    ],
    actions: [
      { seat: 1, userId: 'a', action: 'sb', amount: 1, stage: 'preflop' },
      { seat: 2, userId: 'b', action: 'bb', amount: 2, stage: 'preflop' },
      { seat: 1, userId: 'a', action: 'ante', amount: 1, stage: 'preflop' },
      { seat: 2, userId: 'b', action: 'ante', amount: 1, stage: 'preflop' },
      { seat: 3, userId: 'c', action: 'ante', amount: 1, stage: 'preflop' },
      { seat: 3, userId: 'c', action: 'straddle', amount: 6, stage: 'preflop' },
      { seat: 1, userId: 'a', action: 'call', amount: 5, stage: 'preflop' },
      { seat: 2, userId: 'b', action: 'fold', amount: 0, stage: 'preflop' },
      { seat: 1, userId: 'a', action: 'check', amount: 0, stage: 'flop' },
      { seat: 3, userId: 'c', action: 'bet', amount: 20, stage: 'flop' },
      { seat: 1, userId: 'a', action: 'fold', amount: 0, stage: 'flop' },
      // Stored POSITIVE, like every other amount. The verb is the direction.
      { seat: 3, userId: 'c', action: 'return', amount: 20, stage: 'flop' },
    ],
    winners: [{ userId: 'c', amount: 17, potIndex: 0 }],
    holeCards: {},
  } as never);

  it('rebuilds the pot including the ante and the straddle', () => {
    // The ante is the money that no reconstruction could see before, and it is
    // why these hands used to fall into the un-reconciled tail.
    expect(m.rebuiltPot).toBe(17);
    expect(m.reconciles).toBe(true);
  });

  it('does not synthesise a second set of blinds over the recorded ones', () => {
    const preflop = m.streets.find((s) => s.key === 'preflop')!;
    expect(preflop.rows.filter((r) => r.verb === 'sb')).toHaveLength(1);
    expect(preflop.rows.filter((r) => r.verb === 'bb')).toHaveLength(1);
  });

  it('does not infer a return over the recorded one', () => {
    const flop = m.streets.find((s) => s.key === 'flop')!;
    const returns = flop.rows.filter((r) => r.verb === 'return');
    expect(returns).toHaveLength(1);
    expect(returns[0].amount).toBe(-20);
  });

  it('draws the ante and the straddle as their own rows', () => {
    const preflop = m.streets.find((s) => s.key === 'preflop')!;
    expect(preflop.rows.filter((r) => r.verb === 'ante')).toHaveLength(3);
    const straddle = preflop.rows.find((r) => r.verb === 'straddle')!;
    expect(straddle).toMatchObject({ seat: 3, amount: 6, label: 'Straddle' });
  });

  it('nets every player against the forced money they actually posted', () => {
    const net = Object.fromEntries(m.players.map((p) => [p.username, p.net]));
    expect(net.A).toBe(-7); // 1 sb + 1 ante + 5 call
    expect(net.B).toBe(-3); // 2 bb + 1 ante
    expect(net.C).toBe(10); // 17 collected, 6 straddle + 1 ante in
  });

  it('recovers a stack curve on a hand that previously could not have one', () => {
    const preflop = m.streets.find((s) => s.key === 'preflop')!;
    for (const row of preflop.rows) expect(row.stackAfter).not.toBeNull();
  });
});

describe('buildReplay — the reader never invents an action', () => {
  /**
   * `normalizeVerb` returned `'check'` for anything it did not recognise, so
   * any verb the engine writes that is not in its table — a timeout, a
   * sit-out, a verb added next quarter — was drawn to the player as a CHECK
   * THAT NEVER HAPPENED, indistinguishable from a real one, on a surface that
   * is about money.
   */
  const m = buildReplay({
    handNumber: 9,
    playedAt: null,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    potSize: 3,
    buttonSeat: 3,
    board: [],
    players: [
      { seat: 1, userId: 'a', username: 'A', stack: 99 },
      { seat: 2, userId: 'b', username: 'B', stack: 98 },
      { seat: 3, userId: 'c', username: 'C', stack: 100 },
    ],
    actions: [
      { seat: 3, userId: 'c', action: 'time_out', amount: 0, stage: 'preflop' },
      { seat: 1, userId: 'a', action: 'fold', amount: 0, stage: 'preflop' },
    ],
    winners: [],
    holeCards: {},
  } as never);

  const rows = m.streets.flatMap((s) => s.rows);

  it('does not turn an unknown verb into a Check', () => {
    const checks = rows.filter((r) => r.verb === 'check');
    expect(checks).toHaveLength(0);
  });

  it('prints the engine own word for it instead', () => {
    const row = rows.find((r) => r.seat === 3 && r.verb === 'unknown')!;
    expect(row).toBeTruthy();
    expect(row.label).toBe('Time Out');
  });
});

describe('buildReplay — "all in" with a space is still a raise-to level', () => {
  /**
   * `TO_LEVEL_VERBS` was tested against the RAW string while the label went
   * through a normaliser that collapsed spaces and hyphens. A row storing
   * `"all in"` was therefore labelled All In and had its amount treated as an
   * INCREMENT — adding the whole raise-to level to the pot on top of what that
   * seat already had in.
   */
  const build = (verb: string) =>
    buildReplay({
      handNumber: 10,
      playedAt: null,
      gameVariant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      potSize: 43,
      buttonSeat: 3,
      board: [],
      players: [
        { seat: 1, userId: 'a', username: 'A', stack: 0 },
        { seat: 2, userId: 'b', username: 'B', stack: 0 },
        { seat: 3, userId: 'c', username: 'C', stack: 0 },
      ],
      actions: [
        { seat: 3, userId: 'c', action: 'raise', amount: 8, stage: 'preflop' },
        { seat: 1, userId: 'a', action: 'fold', amount: 0, stage: 'preflop' },
        // to 20, and this seat already has the big blind's 2 in
        { seat: 2, userId: 'b', action: verb, amount: 20, stage: 'preflop' },
        { seat: 3, userId: 'c', action: 'call', amount: 12, stage: 'preflop' },
      ],
      winners: [],
      holeCards: {},
    } as never);

  it('reads every spelling the same way', () => {
    for (const spelling of ['all_in', 'all in', 'ALL-IN', 'allin']) {
      const m = build(spelling);
      // 1 + 2 blinds + 8 raise + 18 (to 20, minus the 2 already in) + 12 call
      expect(m.rebuiltPot).toBe(41);
    }
  });

  it('labels every spelling the same way', () => {
    for (const spelling of ['all_in', 'all in', 'ALL-IN', 'allin']) {
      const row = build(spelling)
        .streets.flatMap((s) => s.rows)
        .find((r) => r.verb === 'all_in')!;
      expect(row.label).toBe('All In');
    }
  });
});

describe('buildReplay — an antes-only log still gets its blinds', () => {
  /**
   * The blind-synthesis guard used to fire on ANY forced-money verb, and
   * `ante` was in the set. A tournament row that records antes but not blinds
   * therefore suppressed the blinds entirely: the pot came out short by
   * SB + BB, the whole stack column was withdrawn, and every preflop raise-to
   * was differenced against a committed map with no blinds in it.
   */
  const m = buildReplay({
    handNumber: 11,
    playedAt: null,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    potSize: 6, // 3 antes + SB 1 + BB 2
    buttonSeat: 3,
    board: [],
    players: [
      { seat: 1, userId: 'a', username: 'A', stack: 10 },
      { seat: 2, userId: 'b', username: 'B', stack: 10 },
      { seat: 3, userId: 'c', username: 'C', stack: 10 },
    ],
    actions: [
      { seat: 1, userId: 'a', action: 'ante', amount: 1, stage: 'preflop', dead: true },
      { seat: 2, userId: 'b', action: 'ante', amount: 1, stage: 'preflop', dead: true },
      { seat: 3, userId: 'c', action: 'ante', amount: 1, stage: 'preflop', dead: true },
      { seat: 3, userId: 'c', action: 'fold', amount: 0, stage: 'preflop' },
    ],
    winners: [],
    holeCards: {},
  } as never);

  it('synthesises the blinds the log does not carry', () => {
    const rows = m.streets.flatMap((s) => s.rows);
    expect(rows.filter((r) => r.verb === 'sb')).toHaveLength(1);
    expect(rows.filter((r) => r.verb === 'bb')).toHaveLength(1);
  });

  it('reconciles, so the stack column survives', () => {
    expect(m.rebuiltPot).toBe(6);
    expect(m.reconciles).toBe(true);
  });
});

describe('buildReplay — the pot line is not a claim about the main pot', () => {
  const m = buildReplay(HAND_3048511 as never);

  it('marks exactly one street as final', () => {
    expect(m.streets.filter((s) => s.isFinal)).toHaveLength(1);
    expect(m.streets[m.streets.length - 1].isFinal).toBe(true);
  });

  it('carries every extra board per street, not just a label', () => {
    // 3048511 ran twice. The second board existed only as the text "Board 2".
    const flop = m.streets.find((s) => s.key === 'flop')!;
    expect(flop.extraBoards).toHaveLength(1);
    expect(flop.extraBoards[0]).toHaveLength(3);
  });
});

describe('titleCase', () => {
  it('capitalises the first letter of every word, per the house rule', () => {
    expect(titleCase('Four of a Kind')).toBe('Four Of A Kind');
    expect(titleCase('STRAIGHT FLUSH')).toBe('Straight Flush');
    expect(titleCase('royal flush')).toBe('Royal Flush');
  });
});

/**
 * WHO WON WHICH BOARD, OUT OF WHICH POT (2026-09-13).
 *
 * Every earlier test in this file drives the legacy pseudo-action path and
 * none set `winnersByBoard`; the only coverage of the per-board reconstruction
 * was indirect, through the share-link round trip. This fixture is the
 * 3048511 hand re-recorded the way the engine writes it today: boards 2..N in
 * the column, one per-board row per (board, winner, half), and - new - the
 * slices saying which pot each row's share came out of.
 */
describe('buildReplay — the per-board record, read directly', () => {
  const ROW = {
    ...HAND_3048511,
    actions: HAND_3048511.actions.filter((a) => a.userId !== 'system'),
    extraBoards: [['6hearts', '2spades', 'Qhearts', '6diamonds', 'Kdiamonds']],
    // Two runs; Bmore takes run 1 with quads, HighRoller takes run 2 with a
    // straight. Amounts are the engine's post-rake shares.
    winnersByBoard: [
      {
        board: 1,
        userId: BMORE,
        amount: 159.35,
        handName: 'Four of a Kind',
        pots: [{ index: 0, amount: 159.35 }],
      },
      {
        board: 2,
        userId: HIGHROLLER,
        amount: 159.35,
        handName: 'Two Pair',
        pots: [
          { index: 0, amount: 150.0 },
          { index: 1, amount: 9.35 },
        ],
      },
    ],
    winners: [
      { userId: BMORE, amount: 159.35, potIndex: 0, hand: { name: 'Four of a Kind', ranking: 8 } },
      { userId: HIGHROLLER, amount: 159.35, potIndex: 1, hand: { name: 'Two Pair', ranking: 3 } },
    ],
    pots: [
      { index: 0, amount: 300 },
      { index: 1, amount: 18.7 },
    ],
  };
  const m = buildReplay(ROW as never);

  it('draws both boards and one winner per board', () => {
    expect(m.boards).toHaveLength(2);
    const winners = m.showdown.filter((r) => r.isWinner);
    expect(winners.map((r) => [r.boardIndex, r.name])).toEqual([
      [0, 'Bmorecharles'],
      [1, 'HighRoller'],
    ]);
  });

  it('names the hand each player made on the board they won', () => {
    const run2 = m.showdown.find((r) => r.boardIndex === 1 && r.userId === HIGHROLLER)!;
    expect(run2.handName).toBe('Two Pair');
    const run1 = m.showdown.find((r) => r.boardIndex === 0 && r.userId === BMORE)!;
    expect(run1.handName).toBe('Four Of A Kind');
  });

  it('carries the share of THAT board, not the whole-hand net', () => {
    const run2 = m.showdown.find((r) => r.boardIndex === 1 && r.userId === HIGHROLLER)!;
    expect(run2.net).toBe(159.35);
  });

  it('keeps the pot axis: a share paid out of two pots says so', () => {
    const run2 = m.showdown.find((r) => r.boardIndex === 1 && r.userId === HIGHROLLER)!;
    expect(run2.potSlices).toEqual([
      { index: 0, amount: 150 },
      { index: 1, amount: 9.35 },
    ]);
    expect(run2.potLabel).toBe('Main + Side 1 pots');
    expect(run2.boardLabel).toBe('Board 2');
    const run1 = m.showdown.find((r) => r.boardIndex === 0 && r.userId === BMORE)!;
    expect(run1.potSlices).toEqual([{ index: 0, amount: 159.35 }]);
    expect(run1.potLabel).toBe('Main pot');
  });

  it('a row without slices falls back to the whole-hand pot label and sets no axis', () => {
    const older = buildReplay({
      ...ROW,
      winnersByBoard: ROW.winnersByBoard.map(({ pots: _pots, ...w }) => w),
    } as never);
    const run2 = older.showdown.find((r) => r.boardIndex === 1 && r.userId === HIGHROLLER)!;
    expect(run2.potSlices).toBeUndefined();
    expect(run2.potLabel).toBe('Side 1 pot');
  });

  it('a losing seat on a board is not a winner there and carries no share', () => {
    const run1Loser = m.showdown.find((r) => r.boardIndex === 0 && r.userId === HIGHROLLER)!;
    expect(run1Loser.isWinner).toBe(false);
    expect(run1Loser.net).toBeNull();
  });
});

describe('buildReplay — legacy pseudo-actions are read in run order', () => {
  it('rit_board_3 recorded before rit_board_2 still lands as board 3', () => {
    const row = {
      ...HAND_3048511,
      actions: [
        ...HAND_3048511.actions.filter((a) => a.userId !== 'system'),
        {
          seat: 0,
          stage: 'river',
          action: 'rit_board_3:6hearts,2spades,Qhearts,9clubs,Tclubs',
          userId: 'system',
        },
        {
          seat: 0,
          stage: 'river',
          action: 'rit_board_2:6hearts,2spades,Qhearts,6diamonds,Kdiamonds',
          userId: 'system',
        },
      ],
    };
    const m = buildReplay(row as never);
    expect(m.boards).toHaveLength(3);
    expect(m.boards[1].map((c) => `${c.rank}${c.suit}`)).toEqual(['6h', '2s', 'Qh', '6d', 'Kd']);
    expect(m.boards[2].map((c) => `${c.rank}${c.suit}`)).toEqual(['6h', '2s', 'Qh', '9c', 'Tc']);
  });
});
