/**
 * MULTIWAY RUN-IT-TWICE — Dan's rules (2026-08-18), pinned end to end:
 *
 *  - RIT can be MULTIWAY: every player at the table, if all are all-in.
 *  - The CHOOSER is the player with the best ACTUAL hand right now — not
 *    the best percentage to win.
 *  - Every all-in player must accept. ONE decline → the pot runs ONCE.
 *
 * These drive the REAL handleAllInRunout / consent engine / settlement.
 */
import { describe, it, expect, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import { RunItTwiceEngine } from './RunItTwiceEngine.js';
import type { DeadlineScheduler } from './DeadlineScheduler.js';
import type { Card, HandConfig, HandEvent, SeatPlayer } from '../types.js';
import { waitForEvent } from '../testing/waitBudget.js';

const TABLE = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const c = (rank: string, suit: string) => ({ rank, suit }) as Card;

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

function mkEngine(players: SeatPlayer[], hc: HandController | null) {
  const engine = new ServerTableEngine(TABLE) as any;
  engine.running = true;
  engine.handCount = 1;
  engine.handController = hc;
  engine.tableInfo = { game_variant: 'nlh', big_blind: 10 };
  engine.seatedPlayers = players.map((p) => ({
    seat_number: p.seat,
    user_id: p.user_id,
    username: p.username,
    stack: p.stack,
    is_horse: false,
  }));
  engine.currentHandActions = players.map((player, index) => ({
    seat: player.seat,
    userId: player.user_id,
    action: index === 0 ? 'all_in' : 'call',
    timestamp: 1,
    stage: 'preflop',
  }));
  engine.runItTwiceEngine.configure(TABLE, { enabled: true, autoDeclineTimeout: 10, maxRuns: 3 });
  engine.insuranceEngine.configure(TABLE, { enabled: false });
  // 2026-08-19 (Dan item 16): an all-in run-out is now PACED - one street at a
  // time with the equity percentages refreshed between cards, ~4.6s end to end
  // at production timings. These tests are about RIT's decision flow, not that
  // pacing, so they run it at test speed instead of racing a wall clock.
  engine.allInFirstPauseMs = 1;
  engine.allInStreetPauseMs = 1;
  engine.allInStreetRevealMs = 1;
  engine.allInPreShowdownPauseMs = 1;
  return engine;
}

describe('chooser = best ACTUAL hand, not best equity', () => {
  it('flop: an overpair out-chooses a monster combo draw with higher equity', () => {
    // Board 9h 8h 2c. u1: Th Jh — straight flush draw, the EQUITY favorite.
    // u2: As Ad — overpair, the best MADE hand. Dan's rule: u2 chooses.
    const players = mkPlayers([500, 500]);
    players[0].cards = [c('T', 'hearts'), c('J', 'hearts')];
    players[1].cards = [c('A', 'spades'), c('A', 'diamonds')];
    players.forEach((p) => (p.is_all_in = true));
    const hcStub = { getState: () => ({ players, currentPlayerSeat: -1 }) } as any;
    const engine = mkEngine(players, hcStub);
    engine.broadcastAllInEquity = vi.fn().mockResolvedValue(undefined);

    const ev = {
      type: 'ALL_IN_RUNOUT',
      board: [c('9', 'hearts'), c('8', 'hearts'), c('2', 'clubs')],
      pot: 1000,
      players,
    } as unknown as HandEvent;
    engine.handleAllInRunout(ev, engine.seatedPlayers);

    const state = engine.runItTwiceEngine.getState(TABLE);
    expect(state).not.toBeNull();
    expect(state.chooserPlayerId).toBe('u2'); // made hand, NOT the draw
    expect(state.allPlayerIds).toEqual(['u1', 'u2']);
  });

  it('preflop (empty board): the bigger pocket pair chooses among three all-ins', () => {
    const players = mkPlayers([500, 500, 500]);
    players[0].cards = [c('K', 'spades'), c('K', 'hearts')];
    players[1].cards = [c('A', 'spades'), c('A', 'hearts')];
    players[2].cards = [c('A', 'clubs'), c('Q', 'clubs')];
    players.forEach((p) => (p.is_all_in = true));
    const hcStub = { getState: () => ({ players, currentPlayerSeat: -1 }) } as any;
    const engine = mkEngine(players, hcStub);
    engine.broadcastAllInEquity = vi.fn().mockResolvedValue(undefined);

    const ev = {
      type: 'ALL_IN_RUNOUT',
      board: [],
      pot: 1500,
      players,
    } as unknown as HandEvent;
    engine.handleAllInRunout(ev, engine.seatedPlayers);

    const state = engine.runItTwiceEngine.getState(TABLE);
    expect(state.chooserPlayerId).toBe('u2'); // pocket aces
    expect(state.allPlayerIds).toEqual(['u1', 'u2', 'u3']);
  });
});

describe('full-table 6-way consent - unanimous or run once', () => {
  const stub = { start() {}, schedule() {}, cancel() {} } as unknown as DeadlineScheduler;
  const ids = ['A', 'B', 'C', 'D', 'E', 'F'];

  function offer6() {
    const e = new RunItTwiceEngine(undefined, stub);
    e.configure('t6', { enabled: true, autoDeclineTimeout: 10, maxRuns: 3 });
    e.offer('t6', 't6:1', 'A', ids, 600);
    e.chooserDecides('t6', 'A', 3);
    return e;
  }

  it('all six must consent - five accepts are not enough', () => {
    const e = offer6();
    for (const id of ['B', 'C', 'D', 'E']) {
      expect(e.accept('t6', id)).toBe(false);
      expect(e.getState('t6')?.status).toBe('offered');
    }
    expect(e.accept('t6', 'F')).toBe(true); // sixth voice completes it
    expect(e.getState('t6')?.status).toBe('accepted');
    expect(e.getChosenRuns('t6')).toBe(3);
  });

  it('ONE decline anywhere kills it for everyone - the pot runs once', () => {
    const e = offer6();
    for (const id of ['B', 'C', 'D', 'F']) e.accept('t6', id);
    e.decline('t6', 'E'); // a single decline
    expect(e.getState('t6')?.status).toBe('declined');
    expect(e.isActive('t6')).toBe(false);
  });
});

describe('6-way all-in money path - side pots, three boards, cent conservation', () => {
  it('conserves every chip across a full-table 3-run RIT with five side pots', () => {
    const stacks = [50, 120, 200, 350, 500, 800];
    const players = mkPlayers(stacks);
    const events: HandEvent[] = [];
    const hc = new HandController(
      {
        tableId: TABLE,
        handNumber: 1,
        gameVariant: 'nlh',
        smallBlind: 5,
        bigBlind: 10,
        rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
        bbjConfig: { enabled: true, feeBB: 0.25, minPotBB: 5, minPlayersDealt: 2 },
      } as HandConfig,
      players,
      1
    );
    hc.onEvent((e) => events.push(e));
    hc.start();
    let guard = 0;
    while (!events.some((e) => e.type === 'ALL_IN_RUNOUT') && guard++ < 30) {
      const st = (hc as unknown as { state: { currentPlayerSeat: number } }).state;
      if (st.currentPlayerSeat <= 0) break;
      hc.performAction(st.currentPlayerSeat, 'all_in', 0);
    }
    expect(events.some((e) => e.type === 'ALL_IN_RUNOUT')).toBe(true);

    const engine = mkEngine(players, hc);
    engine.broadcastAllInEquity = vi.fn().mockResolvedValue(undefined);
    engine.runItTwiceEngine.offer(
      TABLE,
      `${TABLE}:1`,
      'u1',
      players.map((p) => p.user_id),
      0
    );
    engine.runItTwiceEngine.chooserDecides(TABLE, 'u1', 3);
    for (const p of players.slice(1)) engine.runItTwiceEngine.accept(TABLE, p.user_id);

    const st = (hc as unknown as { state: { players: SeatPlayer[] } }).state;
    engine.dealAndResolveRIT(st.players.filter((p) => !p.is_folded));

    const complete = events.find((e) => e.type === 'HAND_COMPLETE') as
      | { type: 'HAND_COMPLETE'; rake: number; bbjFee: number }
      | undefined;
    expect(complete).toBeDefined();
    const total = stacks.reduce((s, x) => s + x, 0);
    const after = st.players.reduce((s, p) => s + p.stack, 0);
    expect(after + complete!.rake + complete!.bbjFee).toBeCloseTo(total, 2);

    // The big stack's over-shove excess is returned UNCALLED before rake -
    // it was never part of the pot, so the winners' total is the contested
    // pot net of rake+bbj, not the raw buy-in sum.
    const uncalled = events
      .filter((e) => e.type === 'UNCALLED_BET_RETURNED')
      .reduce((s, e) => s + ((e as { amount?: number }).amount ?? 0), 0);
    const winners = engine.currentHandWinners as Array<{ userId: string; amount: number }>;
    expect(winners.length).toBeGreaterThan(0);
    const paid = winners.reduce((s, w) => s + w.amount, 0);
    expect(paid).toBeCloseTo(total - uncalled - complete!.rake - complete!.bbjFee, 2);
    for (const w of winners) {
      expect(players.map((p) => p.user_id)).toContain(w.userId);
    }
    // Three boards recorded: canonical board + two extra runouts in actions.
    expect((engine.currentHandCommunityCards as string[]).length).toBe(5);
    const extra = (engine.currentHandActions as Array<{ action: string }>).filter((a) =>
      a.action.startsWith('rit_board_')
    );
    expect(extra.length).toBe(2);
  });
});

describe('decline → the pot runs ONCE (full flow through the real wait)', () => {
  it('a declined offer continues the runout to a single-board completion', async () => {
    const players = mkPlayers([500, 500]);
    const events: HandEvent[] = [];
    const hc = new HandController(
      {
        tableId: TABLE,
        handNumber: 1,
        gameVariant: 'nlh',
        smallBlind: 5,
        bigBlind: 10,
        rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
      } as HandConfig,
      players,
      1
    );
    hc.onEvent((e) => events.push(e));
    hc.start();
    hc.performAction(1, 'all_in', 0);
    hc.performAction(2, 'all_in', 0);
    const ev = events.find((e) => e.type === 'ALL_IN_RUNOUT');
    expect(ev).toBeDefined();

    const engine = mkEngine(players, hc);
    engine.broadcastAllInEquity = vi.fn().mockResolvedValue(undefined);
    engine.handleAllInRunout(ev, engine.seatedPlayers); // real offer + real wait
    expect(engine.runItTwiceEngine.hasPendingOffer(TABLE)).toBe(true);

    // Chooser picks 2, responder DECLINES → run once.
    const chooser = engine.runItTwiceEngine.getState(TABLE).chooserPlayerId as string;
    const responder = chooser === 'u1' ? 'u2' : 'u1';
    engine.respondToRIT(chooser, undefined, 2);
    engine.respondToRIT(responder, 'decline');

    // waitForRITResponse polls every 250ms, then the paced single-board runout
    // deals its streets (at test pacing, see mkEngine) and completes.
    //
    // DE-FLAKE 2026-08-22: this was a flat `setTimeout(900)`, which is a bet
    // that the machine finishes in 900ms. Alone it always did; inside the full
    // 97-file suite it lost that bet about half the time, and the whole
    // "Server Engine" CI job went red with "expected undefined to be defined"
    // - on branches that had touched nothing near this code. Wait for the
    // event instead of for the clock.
    //
    // DE-FLAKE 2026-09-06 (PR #3272): the wait above was right, its budget was
    // not. It was a hardcoded `Date.now() + 10_000`, and vitest.config.ts said
    // `testTimeout: 10_000` - THE SAME NUMBER - so the loop could never reach
    // its own `expect`. Vitest killed the test at the identical instant and
    // printed "Test timed out in 10000ms", naming nothing. On a box running 18
    // runners across 16 cores (a pure-arithmetic SeededRandom assertion in the
    // same run took 3,045ms) ten seconds was never the right budget either.
    // Both numbers now come from src/testing/waitBudget.ts, where the budget is
    // strictly under the ceiling so an exhausted wait can say what was missing.
    const complete = await waitForEvent(events, 'HAND_COMPLETE');
    expect(complete).toBeDefined();
    const st = (hc as unknown as { state: { players: SeatPlayer[]; communityCards: Card[] } })
      .state;
    expect(st.communityCards.length).toBe(5); // ONE board, fully dealt
    // No RIT record markers on a run-once hand.
    const extra = (engine.currentHandActions as Array<{ action: string }>).filter((a) =>
      a.action.startsWith('rit_board_')
    );
    expect(extra.length).toBe(0);
  }, 15_000);
});
