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
  // Stamped 2026-08-28: the state broadcast is the moment the street reaches
  // the client, and the equity broadcast must land AFTER it has been seen.
  // Without it in the timeline that ordering cannot be asserted at all.
  engine.broadcastCurrentState = vi.fn().mockImplementation(() => {
    stamp('state');
  });
  engine.broadcastAllInEquity = vi.fn().mockImplementation(async () => {
    stamp('equity');
  });

  // Keep the test fast without removing the ordering the pacing creates. The
  // real values are 2000/1400/1200 with a 1250ms reveal gate; what is under
  // test is the SEQUENCE and the fact that time passes between cards at all,
  // not the specific durations.
  engine.allInFirstPauseMs = 5;
  engine.allInStreetPauseMs = 10;
  engine.allInPreShowdownPauseMs = 5;
  engine.allInStreetRevealMs = 25;
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

    const order = timeline
      .filter((e) => e.what !== 'complete' && e.what !== 'state')
      .map((e) => e.what);
    expect(order).toEqual(['deal:flop', 'equity', 'deal:turn', 'equity', 'deal:river', 'equity']);
  });

  /**
   * THE STREET MUST BE SEEN BEFORE THE NUMBERS MOVE (Dan 2026-08-28).
   *
   * Verbatim: "EQUITY CHANGES ONLY AFTER THE FLOP IS DISPLAYED, (NOT BEFORE
   * OR DURING)". The run-out used to broadcast state and equity back to back
   * in the same instant, so the percentages flipped to the outcome while the
   * card that caused it was still animating in. On the reported hand the
   * villain read 0% and the hero 100% before the river was face up.
   */
  it('never moves the percentages until the street has had time to be seen', async () => {
    const { engine, timeline } = harness(0);
    await engine.pacedAllInRunout(PLAYERS, 1000);

    const order = timeline.filter((e) => e.what !== 'complete').map((e) => e.what);
    expect(order).toEqual([
      'deal:flop',
      'state',
      'equity',
      'deal:turn',
      'state',
      'equity',
      'deal:river',
      'state',
      'equity',
    ]);

    // Not merely ordered — actually separated, by the reveal gate.
    const states = timeline.filter((e) => e.what === 'state');
    const equities = timeline.filter((e) => e.what === 'equity');
    expect(states).toHaveLength(3);
    expect(equities).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(
        equities[i].at - states[i].at,
        `street ${i + 1}: equity moved before the card could be seen`
      ).toBeGreaterThanOrEqual(20);
    }
  });

  it('uses the shared reveal constant rather than a local magic number', async () => {
    const { HAND_COMPLETION } = await import('../config/handCompletionSpec.js');
    const engine = new ServerTableEngine(TABLE) as never as { allInStreetRevealMs: number };
    expect(engine.allInStreetRevealMs).toBe(HAND_COMPLETION.ALL_IN_STREET_REVEAL_MS);
    // Long enough for a flop to finish turning over (0.30s land, 0.75s hold,
    // flip complete at 1.25s per CommunityCards.css).
    expect(HAND_COMPLETION.ALL_IN_STREET_REVEAL_MS).toBeGreaterThanOrEqual(1250);
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
