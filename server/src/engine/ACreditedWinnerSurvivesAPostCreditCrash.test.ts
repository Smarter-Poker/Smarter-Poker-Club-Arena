/**
 * A CREDITED WINNER SURVIVES A POST-CREDIT CRASH (2026-09-25).
 *
 * Four production hands (2026-09-11, 09-19, 09-23, 09-24 — real money,
 * horse-only, uncontested "everyone folds" wins) were written to
 * hand_history with pot_size correct, the winner correctly paid in
 * daily_mission_events (chips_won matching the pot exactly), but
 * winners: [] and table_id: NULL — a hand with no recorded winner at all.
 *
 * Root cause: completeHandInner() credits the winner's stack, then keeps
 * working past that point to build the WINNERS event's DISPLAY-ONLY payload
 * (per-pot rake scaling, penny reconciliation, board grouping, hand
 * descriptions — including a second describeHand() call per pot award,
 * after the identical showdown-reveal call already made earlier for the
 * SHOWDOWN event). If any of that later, purely cosmetic work throws,
 * completeHand()'s catch handler used to emit `{ type: 'WINNERS',
 * winners: [] }` unconditionally — discarding a winner who had already been
 * paid. ServerTableEngineHandEvents.ts only writes `currentHandWinners`
 * (which becomes hand_history.winners) when the emitted WINNERS event is
 * non-empty, so that empty array was not just a missed animation — it was
 * the exact, permanent winners array persisted for the hand.
 *
 * Fix: HandController now captures the just-credited winners into
 * `creditedWinnersAwaitingEmit` the instant they are paid (right after the
 * stack-crediting loop + snapChips()), and completeHand()'s crash fallback
 * emits that instead of a hard-coded empty array.
 *
 * This test reproduces the mechanism precisely: for this exact heads-up,
 * checked-to-river scenario, describeHand() is called exactly twice before
 * any chips are credited (once per revealed hand, building the SHOWDOWN
 * event) and once more AFTER credit (building the per-pot display record).
 * Throwing from the third call onward crashes the hand at the same point a
 * real cosmetic-work bug would, in BOTH the old and the fixed code — this
 * is not a fix-only hook, so the test genuinely fails on pre-fix code.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { HandController } from './HandController.js';
import type { Card, HandConfig, HandEvent, SeatPlayer } from '../types.js';

let describeHandCallCount = 0;
let throwFromCall = Infinity;

vi.mock('./PokerEngine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./PokerEngine.js')>();
  return {
    ...actual,
    describeHand: (...args: Parameters<typeof actual.describeHand>) => {
      describeHandCallCount++;
      if (describeHandCallCount >= throwFromCall) {
        throw new Error('injected post-credit failure (display-only hand description)');
      }
      return actual.describeHand(...args);
    },
  };
});

afterEach(() => {
  describeHandCallCount = 0;
  throwFromCall = Infinity;
});

function mkPlayers(stacks: number[]): SeatPlayer[] {
  return stacks.map(
    (stack, i) =>
      ({
        seat: i + 1,
        user_id: `u${i + 1}`,
        username: `P${i + 1}`,
        stack,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      }) as SeatPlayer
  );
}

function mkConfig(over: Partial<HandConfig> = {}): HandConfig {
  return {
    tableId: 't1',
    handNumber: 1000000,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    ...over,
  } as HandConfig;
}

const c = (rank: Card['rank'], suit: Card['suit']): Card => ({ rank, suit });

function harness(config: HandConfig, players: SeatPlayer[], dealerSeat: number) {
  const events: HandEvent[] = [];
  const hc = new HandController(config, players, dealerSeat);
  hc.onEvent((e) => events.push(e));
  const st = () => (hc as unknown as { state: any }).state;
  return {
    hc,
    events,
    st,
    actSeat: (s: number, action: string, amount = 0) => hc.performAction(s, action as any, amount),
    setHole: (seatNum: number, cards: Card[]) => {
      const p = st().players.find((pp: SeatPlayer) => pp.seat === seatNum);
      p.cards = cards;
    },
    setBoard: (cards: Card[]) => {
      st().communityCards.length = 0;
      st().communityCards.push(...cards);
    },
    winnersEvent: () =>
      events.find((e) => e.type === 'WINNERS') as
        | { type: 'WINNERS'; winners: Array<{ userId: string; amount: number }> }
        | undefined,
    handComplete: () => events.find((e) => e.type === 'HAND_COMPLETE'),
  };
}

const DRY_BOARD: Card[] = [
  c('K', 'spades'),
  c('Q', 'diamonds'),
  c('9', 'clubs'),
  c('5', 'hearts'),
  c('3', 'spades'),
];

/** Heads-up hand checked all the way to a river that closes the hand. */
function huCheckedToRiverClose(h: ReturnType<typeof harness>) {
  h.hc.start();
  h.actSeat(1, 'call'); // dealer/SB completes
  h.actSeat(2, 'check');
  h.actSeat(2, 'check'); // flop
  h.actSeat(1, 'check');
  h.actSeat(2, 'check'); // turn
  h.actSeat(1, 'check');
  h.actSeat(2, 'check'); // river
  h.setBoard(DRY_BOARD);
  h.setHole(1, [c('A', 'spades'), c('A', 'diamonds')]); // pair of aces — wins
  h.setHole(2, [c('7', 'diamonds'), c('2', 'clubs')]); // seven high — loses
}

describe('completeHand() crash fallback', () => {
  it('still reports the real winner (not []) when post-credit display work throws', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200]), 1);
    huCheckedToRiverClose(h);

    // Calls 1-2 are the pre-credit SHOWDOWN reveal descriptions (one per
    // hand); call 3 is the post-credit per-pot award description. Throwing
    // from call 3 crashes exactly where the four production incidents did:
    // after the pot was paid, while building the display-only record.
    throwFromCall = 3;
    h.actSeat(1, 'check'); // closes the hand and settles

    // The hand still ends: HAND_COMPLETE is the load-bearing emit and must
    // fire even when settlement display-work fails.
    expect(h.handComplete()).toBeDefined();

    const winnersEvent = h.winnersEvent();
    expect(winnersEvent).toBeDefined();
    // THE FIX: u1 (pair of aces, already credited before the crash) must
    // still be named here, not wiped to [] by the crash fallback.
    expect(winnersEvent?.winners.map((w) => w.userId)).toEqual(['u1']);
    expect(winnersEvent?.winners[0]?.amount).toBeGreaterThan(0);

    // And the credit itself must have actually landed on the winner's
    // stack — this test is only meaningful if the pot was genuinely paid
    // before the injected failure, exactly like the four production
    // incidents (chips_won matched pot_size in daily_mission_events even
    // though hand_history.winners was []).
    const winnerStack = h.st().players.find((p: SeatPlayer) => p.user_id === 'u1').stack;
    expect(winnerStack).toBeGreaterThan(199);
  });

  it('a hand that crashes before any credit still falls back to []', () => {
    // Regression guard on the fix itself: if nothing has been credited yet
    // (crash injected from the very first describeHand call, before any
    // pot distribution), creditedWinnersAwaitingEmit must still be [] —
    // proving the field only ever reports a REAL credit, never a guess.
    const h = harness(mkConfig(), mkPlayers([200, 200]), 1);
    huCheckedToRiverClose(h);

    throwFromCall = 1;
    h.actSeat(1, 'check');

    expect(h.handComplete()).toBeDefined();
    const winnersEvent = h.winnersEvent();
    expect(winnersEvent).toBeDefined();
    expect(winnersEvent?.winners).toEqual([]);
  });

  it('a hand that never crashes at all still resolves normally', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200]), 1);
    h.hc.start();
    h.actSeat(1, 'fold'); // SB folds preflop — BB wins uncontested, no showdown

    const winnersEvent = h.winnersEvent();
    expect(winnersEvent).toBeDefined();
    expect(winnersEvent?.winners.map((w) => w.userId)).toEqual(['u2']);
  });
});
