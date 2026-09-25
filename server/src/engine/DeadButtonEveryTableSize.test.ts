/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEAD BUTTON RULE HOLDS AT EVERY TABLE SIZE (2026-09-25, TDA Rule 30)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * HeadsUpButtonFairness.test.ts pins the two-handed half of the rule: the big
 * blind advances and the button follows. The dealing loop applied it only
 * when a table had dropped to two. At three or more it rotated the BUTTON to
 * the next occupied seat (the moving button), so on a tournament table:
 *
 *   - seats 1..6, button 2 / small 3 / big 4, seat 3 busts: the next hand was
 *     button 4 / small 5 / big 6. Seat 4 posted the big blind and then held
 *     the button, never posting a small blind; seat 5 went from UTG straight
 *     to the big blind, never posting a small blind either.
 *   - the BIG blind (seat 4) busts: button 3 / small 5 / big 6. Seat 5 went
 *     small blind, then button, and never posted a big blind that orbit.
 *   - a player balanced in to empty seat 3 between button 2 and small blind 4
 *     took the button, and seats 4 and 5 posted the small and the big blind
 *     twice running.
 *
 * Every row below asserts the (button, small blind, big blind) sequence over
 * several hands, first through the pure rule and then through the REAL deal:
 * ServerTableEngine.dealHand up to the moment the HandController exists, then
 * HandController.start() so the seats that actually post are read off the
 * forced-bet record rather than inferred. `null` is a dead small blind and a
 * button on an emptied seat is a dead button. Nobody posts the big blind
 * twice, nobody skips a blind, the button never moves backwards.
 *
 * The cash rows at the end pin that a cash table is untouched: its published
 * rule (GameRulesModal, "The Button Moves Clockwise Among Eligible Players,
 * Skipping Empty Seats") is the moving button, and its entry hold-outs are
 * built on that walk.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { deadButtonPositions } from './deadButton.js';
import { sliceMethod, sliceStatement } from '../testHelpers/sourceWindow.js';

vi.mock('../services/supabase/client.js', () => ({ supabase: {}, maintenanceSupabase: {} }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const { ServerTableEngine } = await import('./ServerTableEngine.js');

const DEALING = readFileSync(join(__dirname, 'ServerTableEngineDealing.ts'), 'utf8');
const BASE = readFileSync(join(__dirname, 'ServerTableEngineBase.ts'), 'utf8');
const CONTROLLER = readFileSync(join(__dirname, 'HandController.ts'), 'utf8');

/** One hand of the table: the seats dealt, and who owes what. */
type Hand = {
  /** The occupied seats when this hand is dealt. */
  seats: number[];
  /** A player who arrived at this seat between hands (moved in / late reg). */
  arrival?: number;
  /** [button, small blind (null = dead), big blind] */
  expect: [number, number | null, number];
  /** Seats expected to post a live big blind to enter (bbOnlyPosts). */
  postsToEnter?: number[];
};

type Scenario = {
  name: string;
  /** Where the blinds sat on the hand BEFORE the first row. */
  last: { button: number; smallBlind: number; bigBlind: number };
  hands: Hand[];
};

// The opening position of every scenario is seats 1..6 with the button on 2,
// the small blind on 3 and the big blind on 4 (the hand before that was
// button 1 / small 2 / big 3).
const OPENING = { button: 1, smallBlind: 2, bigBlind: 3 };

const SCENARIOS: Scenario[] = [
  {
    name: 'a normal orbit moves every position one seat each hand',
    last: OPENING,
    hands: [
      { seats: [1, 2, 3, 4, 5, 6], expect: [2, 3, 4] },
      { seats: [1, 2, 3, 4, 5, 6], expect: [3, 4, 5] },
      { seats: [1, 2, 3, 4, 5, 6], expect: [4, 5, 6] },
      { seats: [1, 2, 3, 4, 5, 6], expect: [5, 6, 1] },
      { seats: [1, 2, 3, 4, 5, 6], expect: [6, 1, 2] },
      { seats: [1, 2, 3, 4, 5, 6], expect: [1, 2, 3] },
      { seats: [1, 2, 3, 4, 5, 6], expect: [2, 3, 4] },
    ],
  },
  {
    name: 'the small blind busts (between the button and the big blind): a dead button',
    last: OPENING,
    hands: [
      { seats: [1, 2, 3, 4, 5, 6], expect: [2, 3, 4] },
      // Seat 3 is gone. The big blind advances to 5, seat 4 posts the small
      // blind it is owed, and the button sits dead on empty seat 3. The
      // moving button gave 4 / 5 / 6 here.
      { seats: [1, 2, 4, 5, 6], expect: [3, 4, 5] },
      { seats: [1, 2, 4, 5, 6], expect: [4, 5, 6] },
      { seats: [1, 2, 4, 5, 6], expect: [5, 6, 1] },
      { seats: [1, 2, 4, 5, 6], expect: [6, 1, 2] },
      { seats: [1, 2, 4, 5, 6], expect: [1, 2, 4] },
    ],
  },
  {
    name: 'the big blind busts: a dead small blind, then a dead button',
    last: OPENING,
    hands: [
      { seats: [1, 2, 3, 4, 5, 6], expect: [2, 3, 4] },
      // Seat 4 is gone. The big blind advances to 5; the small blind is DEAD
      // at seat 4, nobody posts it; seat 3 takes the button it is owed. The
      // moving button gave 3 / 5 / 6 here, and seat 5 never posted a big
      // blind that orbit.
      { seats: [1, 2, 3, 5, 6], expect: [3, null, 5] },
      // The button follows the dead small blind onto the empty seat.
      { seats: [1, 2, 3, 5, 6], expect: [4, 5, 6] },
      { seats: [1, 2, 3, 5, 6], expect: [5, 6, 1] },
      { seats: [1, 2, 3, 5, 6], expect: [6, 1, 2] },
      { seats: [1, 2, 3, 5, 6], expect: [1, 2, 3] },
    ],
  },
  {
    name: 'the button busts: the blinds are unaffected',
    last: OPENING,
    hands: [
      { seats: [1, 2, 3, 4, 5, 6], expect: [2, 3, 4] },
      { seats: [1, 3, 4, 5, 6], expect: [3, 4, 5] },
      { seats: [1, 3, 4, 5, 6], expect: [4, 5, 6] },
      { seats: [1, 3, 4, 5, 6], expect: [5, 6, 1] },
      { seats: [1, 3, 4, 5, 6], expect: [6, 1, 3] },
      { seats: [1, 3, 4, 5, 6], expect: [1, 3, 4] },
    ],
  },
  {
    name: 'two adjacent players bust: both positions go dead and catch up',
    last: OPENING,
    hands: [
      { seats: [1, 2, 3, 4, 5, 6], expect: [2, 3, 4] },
      { seats: [1, 2, 5, 6], expect: [3, null, 5] },
      { seats: [1, 2, 5, 6], expect: [4, 5, 6] },
      { seats: [1, 2, 5, 6], expect: [5, 6, 1] },
      { seats: [1, 2, 5, 6], expect: [6, 1, 2] },
    ],
  },
  {
    name: 'a new arrival behind the button waits for the big blind, nobody pays twice',
    // Seat 3 has been empty: the hand before was button 1 / small 2 / big 4.
    last: { button: 1, smallBlind: 2, bigBlind: 4 },
    hands: [
      // Seat 3 is still empty this hand: button 2, small 4, big 5.
      { seats: [1, 2, 4, 5, 6], expect: [2, 4, 5] },
      // A player is moved in to seat 3. The moving button handed THEM the
      // button and made seat 4 post the small blind twice and seat 5 the big
      // blind twice. Under the rule seat 4 (last hand's small blind) takes
      // the button, seat 5 posts the small, the big blind advances to 6, and
      // the arrival is the cutoff: neither the button nor the small blind
      // seat, so it owes nothing and posts when the big blind reaches it.
      { seats: [1, 2, 3, 4, 5, 6], arrival: 3, expect: [4, 5, 6], postsToEnter: [] },
      { seats: [1, 2, 3, 4, 5, 6], expect: [5, 6, 1] },
      { seats: [1, 2, 3, 4, 5, 6], expect: [6, 1, 2] },
      { seats: [1, 2, 3, 4, 5, 6], expect: [1, 2, 3] },
      { seats: [1, 2, 3, 4, 5, 6], expect: [2, 3, 4] },
    ],
  },
  {
    name: 'a new arrival into the dead button seat takes the button and posts to enter',
    last: OPENING,
    hands: [
      { seats: [1, 2, 3, 4, 5, 6], expect: [2, 3, 4] },
      // Seat 3 busts and a moved-in player takes the seat before the next
      // deal. The button is owed to that seat, so the arrival holds it, and
      // the arrival rule (B2) bills them a live big blind to enter rather
      // than most of an orbit for free. Seats 4 and 5 post as the rule says.
      { seats: [1, 2, 3, 4, 5, 6], arrival: 3, expect: [3, 4, 5], postsToEnter: [3] },
      { seats: [1, 2, 3, 4, 5, 6], expect: [4, 5, 6] },
      { seats: [1, 2, 3, 4, 5, 6], expect: [5, 6, 1] },
      { seats: [1, 2, 3, 4, 5, 6], expect: [6, 1, 2] },
      { seats: [1, 2, 3, 4, 5, 6], expect: [1, 2, 3] },
    ],
  },
  {
    name: 'a new arrival into the dead small blind seat posts it, then the big blind',
    last: OPENING,
    hands: [
      { seats: [1, 2, 3, 4, 5, 6], expect: [2, 3, 4] },
      // The big blind (seat 4) busts and a moved-in player takes seat 4. The
      // small blind is owed at that seat, so the arrival posts it live (the
      // arrival rule leaves a small-blind seat on the hook for the big blind
      // next hand, which they post from the button as a live entry post).
      { seats: [1, 2, 3, 4, 5, 6], arrival: 4, expect: [3, 4, 5], postsToEnter: [] },
      { seats: [1, 2, 3, 4, 5, 6], expect: [4, 5, 6], postsToEnter: [4] },
      { seats: [1, 2, 3, 4, 5, 6], expect: [5, 6, 1] },
      { seats: [1, 2, 3, 4, 5, 6], expect: [6, 1, 2] },
    ],
  },
  {
    name: 'three-handed to heads-up and back: both halves of the rule agree',
    last: { button: 3, smallBlind: 1, bigBlind: 2 },
    hands: [
      { seats: [1, 2, 3], expect: [1, 2, 3] },
      // Seat 1 busts. Heads-up: the big blind advances to 2, seat 3 takes the
      // button and posts the small blind (headsUpButtonSeat).
      { seats: [2, 3], expect: [3, 3, 2] },
      { seats: [2, 3], expect: [2, 2, 3] },
      // A player is balanced in to seat 1, which is the next live seat after
      // the big blind: the big blind advances onto the arrival, seat 3 posts
      // the small blind it is owed and seat 2 (heads-up small blind) takes
      // the button. The arrival is the big blind, so it owes nothing extra.
      { seats: [1, 2, 3], arrival: 1, expect: [2, 3, 1], postsToEnter: [] },
      { seats: [1, 2, 3], expect: [3, 1, 2] },
      { seats: [1, 2, 3], expect: [1, 2, 3] },
      { seats: [1, 2, 3], expect: [2, 3, 1] },
    ],
  },
  {
    name: 'heads-up to three-handed when the arrival sits between the button and the big blind',
    // The hand before was heads-up: seat 2 button and small blind, seat 5 big.
    last: { button: 2, smallBlind: 2, bigBlind: 5 },
    hands: [
      // A player is balanced in to seat 3. The big blind advances past 5 to
      // seat 2, the old button/small-blind seat, so the button cannot follow
      // it there: it goes to the arrival, the seat before the small blind,
      // and the arrival rule bills them a live big blind to enter.
      { seats: [2, 3, 5], arrival: 3, expect: [3, 5, 2], postsToEnter: [3] },
      { seats: [2, 3, 5], expect: [5, 2, 3] },
      { seats: [2, 3, 5], expect: [2, 3, 5] },
      { seats: [2, 3, 5], expect: [3, 5, 2] },
    ],
  },
  {
    name: 'a nine-handed table with empty seats between players',
    last: { button: 8, smallBlind: 1, bigBlind: 3 },
    hands: [
      { seats: [1, 3, 5, 6, 8, 9], expect: [1, 3, 5] },
      { seats: [1, 3, 5, 6, 8, 9], expect: [3, 5, 6] },
      // Seat 6 (the big blind) busts: dead small blind at 6, button on 5.
      { seats: [1, 3, 5, 8, 9], expect: [5, null, 8] },
      { seats: [1, 3, 5, 8, 9], expect: [6, 8, 9] },
      { seats: [1, 3, 5, 8, 9], expect: [8, 9, 1] },
      { seats: [1, 3, 5, 8, 9], expect: [9, 1, 3] },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// The rule, pure
// ═══════════════════════════════════════════════════════════════════════════
describe('deadButtonPositions: the big blind advances one live seat and the rest follow', () => {
  for (const s of SCENARIOS) {
    it(s.name, () => {
      let last = { smallBlind: s.last.smallBlind, bigBlind: s.last.bigBlind };
      let button = s.last.button;
      // Heads-up the button IS the small blind, so on the hand after a
      // heads-up hand the same player can hold it again (small blind, then
      // button): that is the one time the button seat may repeat.
      let lastWasHeadsUp = s.last.button === s.last.smallBlind;
      for (const [i, hand] of s.hands.entries()) {
        const dead = deadButtonPositions(hand.seats, last);
        let got: [number, number | null, number];
        if (hand.seats.length === 2) {
          // Heads-up is headsUpButtonSeat's half of the rule; the pure
          // function stands down and the caller keeps it.
          expect(dead).toBeNull();
          const bb = hand.seats.find((x) => x !== last.bigBlind)!;
          const sb = hand.seats.find((x) => x !== bb)!;
          got = [sb, sb, bb];
        } else {
          expect(dead, `hand ${i + 1} of "${s.name}"`).not.toBeNull();
          got = [dead!.button, dead!.smallBlind, dead!.bigBlind];
          // The small blind seat is where the big blind was, occupied or not.
          expect(dead!.smallBlindSeat).toBe(last.bigBlind);
          // The button always advances and never lands on a blind.
          if (!lastWasHeadsUp) expect(dead!.button).not.toBe(button);
          expect(dead!.button).not.toBe(dead!.bigBlind);
          expect(dead!.button).not.toBe(dead!.smallBlindSeat);
          // The big blind is always a live seat.
          expect(hand.seats).toContain(dead!.bigBlind);
        }
        expect(got, `hand ${i + 1} of "${s.name}"`).toEqual(hand.expect);
        button = got[0];
        lastWasHeadsUp = hand.seats.length === 2;
        last = { smallBlind: dead ? dead.smallBlindSeat : got[1]!, bigBlind: got[2] };
      }
    });
  }

  it('stands down where the rule does not apply', () => {
    expect(deadButtonPositions([1, 2], { smallBlind: 1, bigBlind: 2 })).toBeNull();
    expect(deadButtonPositions([1, 2, 3], { smallBlind: 0, bigBlind: 0 })).toBeNull();
    expect(deadButtonPositions([1, 2, 3], { smallBlind: 2, bigBlind: 0 })).toBeNull();
  });

  it('the old rule, rotate the button to the next occupied seat, fails the first bust case', () => {
    // Button 2, small 3, big 4; seat 3 busts. The moving button lands on 4,
    // so seat 4 posts the big blind and then holds the button with no small
    // blind in between, and seat 5 goes from UTG straight to the big blind.
    const seats = [1, 2, 4, 5, 6];
    const moving = seats.find((x) => x > 2)!;
    expect(moving).toBe(4);
    const rule = deadButtonPositions(seats, { smallBlind: 3, bigBlind: 4 })!;
    expect([rule.button, rule.smallBlind, rule.bigBlind]).toEqual([3, 4, 5]);
    expect(rule.button).not.toBe(moving); // the bug, stated
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The rule, through the real deal
// ═══════════════════════════════════════════════════════════════════════════
const engines: any[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.preciseTimer.dispose();
});

const SB = 50;
const BB = 100;

function seatRow(seat: number) {
  return {
    seat_number: seat,
    user_id: `u${seat}`,
    username: `P${seat}`,
    stack: 10_000,
    occupancy_id: `occupancy-${seat}`,
    seat_id: `00000000-0000-4000-8000-0000000000${String(seat).padStart(2, '0')}`,
    seat_joined_at: '2026-09-25T00:00:00.000Z',
  };
}

function tableEngine(kind: 'tournament' | 'cash', last: Scenario['last']) {
  const engine = new ServerTableEngine(`dead-button-${kind}`) as any;
  engines.push(engine);
  engine.tableInfo = {
    id: `dead-button-${kind}`,
    game_variant: 'nlh',
    game_type: kind,
    tournament_id: kind === 'tournament' ? 'tid' : null,
    small_blind: SB,
    big_blind: BB,
    ante: 0,
  };
  engine.takePreparedHandNumber = () => 123;
  // The bomb-pot scheduler snapshot would otherwise persist on the first
  // hand; the diff guard skips the write when the row already says "off".
  engine.bombPotSchedPersistedJson = 'null';
  engine.lastButtonSeat = last.button;
  engine.lastSmallBlindSeat = last.smallBlind;
  engine.lastBigBlindSeat = last.bigBlind;
  engine.disconnectEngine.isSittingOut = () => false;
  return engine;
}

/**
 * Deal one hand for real: dealHand runs through the rotation, the blind
 * computation, the arrival posts and the HandController's construction, and
 * is stopped at the time-bank read that follows (a database call). Then the
 * controller is started so the blinds are actually posted, and the seats that
 * posted are read off FORCED_BETS_POSTED, which is the hand record.
 */
async function dealOne(
  engine: any,
  seats: number[]
): Promise<{
  button: number;
  sb: number | null;
  bb: number;
  postsToEnter: number[];
  pot: number;
}> {
  const stop = new Error('hand controller built');
  engine.fetchTimeBankExtras = () => {
    throw stop;
  };
  const players = seats.map(seatRow);
  engine.seatedPlayers = players;
  engine.dealtInUserIds = new Set(players.map((p) => p.user_id));
  await expect(engine.dealHand(players)).rejects.toBe(stop);
  const hc = engine.handController;
  expect(hc, 'no HandController was built').toBeTruthy();
  const posted: Array<{ seat: number; kind: string; amount: number }> = [];
  hc.onEvent((ev: any) => {
    if (ev.type === 'FORCED_BETS_POSTED') posted.push(...ev.postings);
  });
  hc.start();
  const sb = posted.find((p) => p.kind === 'sb');
  const bb = posted.find((p) => p.kind === 'bb');
  expect(bb, 'no big blind was posted').toBeTruthy();
  expect(bb!.amount).toBe(BB);
  if (sb) expect(sb.amount).toBe(SB);
  return {
    button: hc.getDealerSeat(),
    sb: sb ? sb.seat : null,
    bb: bb!.seat,
    postsToEnter: posted.filter((p) => p.kind === 'post').map((p) => p.seat),
    pot: hc.getState().pot,
  };
}

describe('the real deal: (button, small blind, big blind) over several hands', () => {
  for (const s of SCENARIOS) {
    it(s.name, async () => {
      const engine = tableEngine('tournament', s.last);
      for (const [i, hand] of s.hands.entries()) {
        if (hand.arrival !== undefined) {
          // The dealing loop classifies an arrival before the deal, over the
          // roster the deal will use (noteTournamentArrival, B2).
          engine.seatedPlayers = hand.seats.map(seatRow);
          engine.noteTournamentArrival(hand.arrival, `u${hand.arrival}`);
        }
        const got = await dealOne(engine, hand.seats);
        expect([got.button, got.sb, got.bb], `hand ${i + 1} of "${s.name}"`).toEqual(hand.expect);
        expect(got.postsToEnter, `entry posts on hand ${i + 1} of "${s.name}"`).toEqual(
          hand.postsToEnter ?? []
        );
        // Chips are conserved: the pot is exactly the blinds that were posted.
        const expectedPot = (got.sb === null ? 0 : SB) + BB + got.postsToEnter.length * BB;
        expect(got.pot).toBe(expectedPot);
        // Every predictor agrees with the deal it just predicted.
        expect(engine.lastButtonSeat).toBe(got.button);
        expect(engine.lastBigBlindSeat).toBe(got.bb);
      }
    });
  }

  it('the predictors name the same seats the deal uses, dead or live', async () => {
    const engine = tableEngine('tournament', OPENING);
    await dealOne(engine, [1, 2, 3, 4, 5, 6]); // 2 / 3 / 4
    // The big blind busts: the small blind is dead at 4 and the button is 3.
    engine.seatedPlayers = [1, 2, 3, 5, 6].map(seatRow);
    expect(engine.getButtonSeatIndex()).toBe(3);
    expect(engine.getSBSeatIndex()).toBe(4); // the seat, so an arrival there is charged
    expect(engine.getBBSeatIndex()).toBe(5);
    const got = await dealOne(engine, [1, 2, 3, 5, 6]);
    expect([got.button, got.sb, got.bb]).toEqual([3, null, 5]);
    // And the dead button next: the predictors say so before the deal does.
    expect(engine.getButtonSeatIndex()).toBe(4);
    expect(engine.getSBSeatIndex()).toBe(5);
    expect(engine.getBBSeatIndex()).toBe(6);
  });

  it('a big blind bust in pot-limit does not price a small blind nobody owes', async () => {
    const engine = tableEngine('tournament', OPENING);
    engine.tableInfo.game_variant = 'plo4';
    await dealOne(engine, [1, 2, 3, 4, 5, 6]);
    await dealOne(engine, [1, 2, 3, 5, 6]); // dead small blind
    // TDA 54: preflop pot-limit sizing assumes full blind posts even when a
    // blind is short. A DEAD small blind is not short, it does not exist, so
    // the adjustment carries only the big blind's own deficit (zero here).
    expect(engine.handController.getState().potLimitBlindAdjustment).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A cash table keeps its published rule: the moving button
// ═══════════════════════════════════════════════════════════════════════════
describe('a cash table is untouched: the button moves clockwise among eligible players', () => {
  it('rotates the button to the next occupied seat after a bust (as published)', async () => {
    const engine = tableEngine('cash', OPENING);
    let got = await dealOne(engine, [1, 2, 3, 4, 5, 6]);
    expect([got.button, got.sb, got.bb]).toEqual([2, 3, 4]);
    // Seat 3 leaves. The cash rule is the moving button: 4 / 5 / 6, exactly
    // what it did before the tournament rule existed.
    got = await dealOne(engine, [1, 2, 4, 5, 6]);
    expect([got.button, got.sb, got.bb]).toEqual([4, 5, 6]);
    expect(engine.getButtonSeatIndex()).toBe(5);
    expect(engine.getSBSeatIndex()).toBe(6);
    expect(engine.getBBSeatIndex()).toBe(1);
  });

  it('never hands a cash hand explicit blind seats, so its controller walks as before', async () => {
    const engine = tableEngine('cash', OPENING);
    await dealOne(engine, [1, 2, 3, 4, 5, 6]);
    expect(engine.handController.config.blindSeats).toBeUndefined();
  });

  it('the tournament rule itself refuses a cash roster', () => {
    const engine = tableEngine('cash', OPENING);
    expect(engine.tournamentDeadButtonSeats([1, 2, 3, 4, 5, 6].map(seatRow))).toBeNull();
    engine.tableInfo.tournament_id = 'tid';
    expect(engine.tournamentDeadButtonSeats([1, 2, 3, 4, 5, 6].map(seatRow))).toEqual({
      button: 2,
      smallBlindSeat: 3,
      smallBlind: 3,
      bigBlind: 4,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Wiring: the rule is worthless if the loop does not use it
// ═══════════════════════════════════════════════════════════════════════════
describe('the dealing loop and the predictors share one definition of the rule', () => {
  it('the deal reads the rule after the heads-up block and before the button is recorded', () => {
    const at = DEALING.indexOf('this.tournamentDeadButtonSeats(players)');
    const recorded = DEALING.indexOf('this.lastButtonSeat = dealerSeat;');
    const headsUp = DEALING.indexOf('headsUpButtonSeat(sortedSeats, this.lastBigBlindSeat)');
    expect(at).toBeGreaterThan(headsUp);
    expect(recorded).toBeGreaterThan(at);
  });

  it('the small blind seat is recorded beside the big blind anchor, on the same hands', () => {
    const stmt = sliceStatement(DEALING, 'if (!bombPotConfig) {');
    expect(stmt).toMatch(/this\.lastBigBlindSeat = bbSeat;/);
    expect(stmt).toMatch(/this\.lastSmallBlindSeat = sbSeatPosition;/);
  });

  it('a tournament hand is told its blind seats; a cash hand is not', () => {
    expect(DEALING).toMatch(
      /blindSeats: this\.isTournamentTable\(\) \? \{ smallBlind: sbSeat, bigBlind: bbSeat \} : undefined/
    );
    const body = sliceMethod(CONTROLLER, 'private blindSeatsForHand');
    expect(body).toMatch(/this\.config\.blindSeats/);
    expect(sliceMethod(CONTROLLER, 'private postBlinds')).toMatch(/this\.blindSeatsForHand\(\)/);
    expect(sliceMethod(CONTROLLER, 'private setNextPlayer')).toMatch(/this\.blindSeatsForHand\(\)/);
  });

  it('every predictor goes through the rule first', () => {
    expect(sliceMethod(BASE, 'protected predictButtonSeat')).toMatch(
      /this\.tournamentDeadButtonSeats\(roster\)/
    );
    expect(sliceMethod(BASE, 'protected predictBlindSeats')).toMatch(
      /this\.tournamentDeadButtonSeats\(roster\)/
    );
    expect(sliceMethod(BASE, 'protected getSBSeatIndex')).toMatch(/predictBlindSeats/);
    expect(sliceMethod(BASE, 'protected getBBSeatIndex')).toMatch(/predictBlindSeats/);
    expect(sliceMethod(BASE, 'protected tournamentDeadButtonSeats')).toMatch(
      /if \(!this\.isTournamentTable\(\) \|\| roster\.length < 3\) return null;/
    );
  });

  it('the small blind seat survives a restart, dead or live', () => {
    expect(BASE).toMatch(/protected lastSmallBlindSeat: number = 0;/);
    const body = sliceMethod(BASE, 'private async restoreButtonFromHistory');
    expect(body).toMatch(/this\.lastSmallBlindSeat = /);
    expect(body).toMatch(/postedSeat\(rows\[1\], 'bb'\)/);
  });
});
