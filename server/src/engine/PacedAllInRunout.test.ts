/**
 * Dan 2026-08-19, bug list item 16: "when players are all-in before all cards
 * are out, show win percentages, slow the action down (turn card ->
 * percentages change -> river -> winning hand identified -> pot pushed)."
 *
 * The percentages already existed and were already broadcast - but only ONCE,
 * at the moment of the all-in. The run-out went through
 * HandController.runOutCommunityCards, a synchronous `while (board < 5)` loop
 * that dealt flop, turn and river in a SINGLE TICK and completed the hand
 * immediately after. Every card appeared at once, so no percentage could ever
 * be seen changing.
 *
 * These tests drive the paced runner directly.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

afterEach(() => vi.restoreAllMocks());

/** A controller parked on a preflop all-in: empty board, five cards to come. */
function harness(startingBoardLength = 0) {
  const engine = new ServerTableEngine(TABLE) as any;
  const timeline: Array<{ what: string; at: number }> = [];
  const t0 = Date.now();
  const stamp = (what: string) => timeline.push({ what, at: Date.now() - t0 });

  let board: string[] = Array.from({ length: startingBoardLength }, (_, i) => `c${i}`);

  const controller = {
    getCommunityCards: () => board,
    dealNextStreet: () => {
      const stage = board.length < 3 ? 'flop' : board.length < 4 ? 'turn' : 'river';
      const count = stage === 'flop' ? 3 - board.length : 1;
      board = [...board, ...Array.from({ length: count }, (_, i) => `${stage}${i}`)];
      stamp(`deal:${stage}`);
      return { board, stage, complete: board.length >= 5 };
    },
    continueRunout: () => stamp('complete'),
  };

  engine.handController = controller;
  engine.running = true;
  engine.broadcastCurrentState = vi.fn();
  engine.broadcastAllInEquity = vi.fn().mockImplementation(async () => {
    stamp('equity');
  });

  // Keep the test fast without removing the ordering the pacing creates. The
  // real values are 1000/1400/1200; what is under test is the SEQUENCE and the
  // fact that time passes between cards at all, not the specific durations.
  engine.allInFirstPauseMs = 5;
  engine.allInStreetPauseMs = 10;
  engine.allInPreShowdownPauseMs = 5;
  engine.sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  return { engine, timeline, controller, getBoard: () => board };
}

const PLAYERS = [
  { user_id: 'a', seat: 1, cards: [{}, {}] },
  { user_id: 'b', seat: 2, cards: [{}, {}] },
] as never[];

describe('pacedAllInRunout', () => {
  it('deals the streets ONE AT A TIME, not in a single tick', async () => {
    const { engine, timeline } = harness(0);
    await engine.pacedAllInRunout(PLAYERS, 1000);

    const deals = timeline.filter((e) => e.what.startsWith('deal:'));
    expect(deals.map((d) => d.what)).toEqual(['deal:flop', 'deal:turn', 'deal:river']);
    // The whole point: real time passes between cards.
    expect(deals[1].at).toBeGreaterThan(deals[0].at);
    expect(deals[2].at).toBeGreaterThan(deals[1].at);
  });

  it('refreshes the percentages after EVERY street', async () => {
    const { engine, timeline } = harness(0);
    await engine.pacedAllInRunout(PLAYERS, 1000);

    const order = timeline.filter((e) => e.what !== 'complete').map((e) => e.what);
    expect(order).toEqual(['deal:flop', 'equity', 'deal:turn', 'equity', 'deal:river', 'equity']);
  });

  it('completes the hand once, at the end', async () => {
    const { engine, timeline, getBoard } = harness(0);
    await engine.pacedAllInRunout(PLAYERS, 1000);

    expect(getBoard()).toHaveLength(5);
    expect(timeline.filter((e) => e.what === 'complete')).toHaveLength(1);
    expect(timeline[timeline.length - 1].what).toBe('complete');
  });

  it('handles a turn-and-river all-in (board already has a flop)', async () => {
    const { engine, timeline } = harness(3);
    await engine.pacedAllInRunout(PLAYERS, 1000);
    expect(timeline.filter((e) => e.what.startsWith('deal:')).map((d) => d.what)).toEqual([
      'deal:turn',
      'deal:river',
    ]);
  });

  it('does not stall a hand that is already complete', async () => {
    const { engine, timeline } = harness(5);
    await engine.pacedAllInRunout(PLAYERS, 1000);
    expect(timeline.filter((e) => e.what.startsWith('deal:'))).toHaveLength(0);
    expect(timeline.filter((e) => e.what === 'complete')).toHaveLength(1);
  });

  it('stops dealing if the table is torn down mid-runout', async () => {
    const { engine, timeline } = harness(0);
    engine.broadcastAllInEquity = vi.fn().mockImplementation(async () => {
      timeline.push({ what: 'equity', at: 0 });
      engine.running = false; // the table shuts down after the first street
    });
    await engine.pacedAllInRunout(PLAYERS, 1000);
    expect(timeline.filter((e) => e.what.startsWith('deal:'))).toHaveLength(1);
  });

  /**
   * Dan 2026-08-27, round 3, item 8: "There was a 3-way all-in preflop, one
   * player with AA, another with QQ and the third with 99. There was a bug or
   * glitch with 3 players all in, the board never ran out, nothing happened,
   * and the players who lost (QQ and 99) saw all their chips lost."
   *
   * The loop used to `await` the equity broadcast on every street, so the
   * DEAL was gated on a computation whose cost grows with the number of all-in
   * hands: the worker pool carries a 15s per-job timeout, and its failure path
   * is a synchronous per-player enumeration on the main event loop. Two hands
   * was survivable. Three was not, three times over.
   *
   * There was no three-handed test on a plain table — the existing 3-way
   * coverage is all RunItTwice — which is why a bug that only appears with a
   * third player reached production.
   */
  describe('three-handed, the case Dan reported', () => {
    const THREE = [
      { user_id: 'aa', seat: 1, cards: [{}, {}] },
      { user_id: 'qq', seat: 2, cards: [{}, {}] },
      { user_id: 'nn', seat: 3, cards: [{}, {}] },
    ] as never[];

    it('runs the board out and completes, with three players all in preflop', async () => {
      const { engine, timeline, getBoard } = harness(0);
      await engine.pacedAllInRunout(THREE, 1000);

      expect(timeline.filter((e) => e.what.startsWith('deal:')).map((d) => d.what)).toEqual([
        'deal:flop',
        'deal:turn',
        'deal:river',
      ]);
      expect(getBoard()).toHaveLength(5);
      expect(timeline.filter((e) => e.what === 'complete')).toHaveLength(1);
    });

    it('deals on time even when the equity computation takes far longer than the street', async () => {
      /* THE REGRESSION ITSELF. Equity here takes 500ms a street against a 10ms
         street pause — the shape of a three-way job that times out on the pool
         and falls back to the synchronous enumeration. Before the fix this
         test's board would still be face down when the assertion ran, because
         the deal waited for the number. */
      const { engine, timeline, getBoard } = harness(0);
      engine.broadcastAllInEquity = vi
        .fn()
        .mockImplementation(() => new Promise((r) => setTimeout(r, 500)));

      const started = Date.now();
      await engine.pacedAllInRunout(THREE, 1000);
      const elapsed = Date.now() - started;

      expect(getBoard()).toHaveLength(5);
      expect(timeline.filter((e) => e.what === 'complete')).toHaveLength(1);
      // Three streets of a 500ms wait would be 1.5s on its own. The whole
      // runout is paced by its own sleeps (5 + 10 + 10 + 5 = 30ms) and must
      // stay in that neighbourhood.
      expect(elapsed).toBeLessThan(400);
    });

    it('a rejected equity job does not stop the board or the hand', async () => {
      // Nothing awaits the promise any more, so a rejection has to be caught at
      // the call site or it becomes an unhandled rejection that can take the
      // process down — and with it every other table on the server.
      const { engine, timeline, getBoard } = harness(0);
      engine.broadcastAllInEquity = vi.fn().mockRejectedValue(new Error('equity pool is down'));

      await expect(engine.pacedAllInRunout(THREE, 1000)).resolves.toBeUndefined();
      expect(getBoard()).toHaveLength(5);
      expect(timeline.filter((e) => e.what === 'complete')).toHaveLength(1);
    });
  });

  it('does not spin forever when the deck runs short', async () => {
    // AUDIT 2026-08-19: dealNextStreet returns whatever the deck has left. A
    // board that stops growing used to satisfy the loop condition forever —
    // and this loop SLEEPS 1.4s per turn while re-broadcasting state and
    // equity, so it would spin and flood every client at the table. Reachable:
    // an 8-max PLO6 hand needs 48 hole cards plus 5 board out of 52.
    const { engine, timeline, controller } = harness(0);
    controller.dealNextStreet = () => {
      timeline.push({ what: 'deal:nothing', at: 0 });
      return { board: [], stage: 'flop', complete: false }; // deck gave nothing
    };

    const done = engine.pacedAllInRunout(PLAYERS, 1000);
    // If the guard were missing this never resolves and the test times out.
    await done;

    expect(timeline.filter((e) => e.what === 'deal:nothing').length).toBeLessThanOrEqual(3);
    // The hand still has to end.
    expect(timeline.filter((e) => e.what === 'complete')).toHaveLength(1);
  }, 15000);

  it('still finishes the hand when a street throws', async () => {
    const { engine, timeline, controller } = harness(0);
    controller.dealNextStreet = () => {
      throw new Error('deck exploded');
    };
    await engine.pacedAllInRunout(PLAYERS, 1000);
    // A parked hand is the one outcome that must never happen.
    expect(timeline.filter((e) => e.what === 'complete')).toHaveLength(1);
  });
});
