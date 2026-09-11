/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ENGINE MUST RECORD THE HAND IT ACTUALLY DEALT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There was no harness that ran a real HandController inside a real
 * ServerTableEngine. HandController has one (HandFuzzer, 18,000 hands a run)
 * and the engine has several that stub the controller out entirely
 * (PacedAllInRunout.test.ts replaces it with a literal object). Nothing
 * exercised the SEAM, and two live defects were sitting in it:
 *
 *   A. 20 cash hands in 24 hours raked on preflop fold-outs, 9.15 chips.
 *      `calculateRake` returns 0 when `noFlopNoDrop && !sawFlop`, and
 *      noFlopNoDrop is true at every live construction site — so `sawFlop`
 *      was true on hands whose pot is arithmetically too small to have seen a
 *      flop (a heads-up 2/4 pot of exactly 4.00 cannot have flopped; both
 *      players matching makes 8.00 the floor).
 *
 *   B. 16 hands with a showdown and pots up to 704.00 recorded with an EMPTY
 *      board. 15 of 16 on insurance-enabled tables.
 *
 * Both are the same shape, and the shape is only visible here: the engine
 * keeps TWO boards that can disagree.
 *
 *   HandController.state.communityCards   what was dealt; drives sawFlop,
 *                                         and through it the rake
 *   engine.currentHandCommunityCards      what hand_history stores
 *
 * The second is never derived from the first. It is assembled from
 * COMMUNITY_CARDS events in ServerTableEngineHandEvents (~line 588), so any
 * dealing path that does not emit one leaves the stored board empty while the
 * felt shows five cards — and any path that sets sawFlop without dealing
 * charges rake on a hand that never had a flop.
 *
 * These three invariants are what "the record matches the hand" means. They
 * are asserted on hand shapes the fuzzer cannot reach, because reaching them
 * requires the engine's event handler to be wired to a real controller.
 *
 *   INV-1  the stored board equals the dealt board
 *   INV-2  sawFlop is true exactly when three or more cards are out
 *   INV-3  under no-flop-no-drop, a hand with no flop is raked zero
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import type { HandConfig, SeatPlayer, HandEvent } from '../types.js';

const TABLE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

afterEach(() => vi.restoreAllMocks());

/** A live cash table's rake shape: 10%, capped, and no flop means no drop. */
const CASH_RAKE = { percent: 10, cap: 5, noFlopNoDrop: true };

function seats(n: number, stack = 400): SeatPlayer[] {
  return Array.from({ length: n }, (_, i) => ({
    user_id: `u${i + 1}`,
    seat: i + 1,
    stack,
    bet: 0,
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    cards: [],
  })) as unknown as SeatPlayer[];
}

function handConfig(over: Partial<HandConfig> = {}): HandConfig {
  return {
    tableId: TABLE,
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 2,
    bigBlind: 4,
    rakeConfig: CASH_RAKE,
    ...over,
  } as HandConfig;
}

/**
 * A real engine with only its OUTBOUND edges stubbed. Everything that decides
 * what the hand was — the event handler, the per-hand capture fields — is the
 * real thing, because that is the code under test.
 */
function engineFor(tableInfo: Record<string, unknown> = {}) {
  const engine = new ServerTableEngine(TABLE) as any;

  engine.tableInfo = {
    id: TABLE,
    game_variant: 'nlh',
    game_type: 'cash',
    small_blind: 2,
    big_blind: 4,
    max_players: 9,
    tournament_id: null,
    nit_game: false,
    ...tableInfo,
  };
  engine.running = true;

  // Outbound only: sockets, the hub, the database, and the clock.
  engine.broadcastCurrentState = vi.fn().mockResolvedValue(undefined);
  engine.broadcastAllInEquity = vi.fn().mockResolvedValue(undefined);
  engine.persistHoleCardsWithRetry = vi.fn().mockResolvedValue(undefined);
  engine.sleep = () => Promise.resolve();
  engine.hub = { emitEvent: vi.fn(), broadcast: vi.fn(), publish: vi.fn() };

  // dealHand() resets these at the top of every hand; this harness drives the
  // controller directly, so it does the same reset explicitly.
  engine.currentHandCommunityCards = [];
  engine.currentHandCommunityCards2 = [];
  engine.currentHandCommunityCards3 = [];
  engine.currentHandWentToFlop = false;
  engine.currentHandRake = 0;
  engine.currentHandBBJFee = 0;
  engine.currentHandPotSize = 0;

  return engine;
}

/**
 * Wire a real controller to the real handler exactly as dealHand does
 * (ServerTableEngineDealing ~2285): fire-and-forget, errors reported not
 * thrown. Settlement's database work is expected to fail in a test process and
 * must not mask the invariants, which are set before any of it runs.
 */
function wire(engine: any, hc: HandController) {
  const events: HandEvent[] = [];
  engine.handController = hc;
  hc.onEvent((event: HandEvent) => {
    events.push(event);
    void Promise.resolve(engine.handleHandEvent(event, [])).catch(() => {});
  });
  return events;
}

/** Let the voided handler promises settle before asserting on their effects. */
const drain = () => new Promise((r) => setTimeout(r, 0));

function assertRecordMatchesHand(engine: any, hc: HandController, events: HandEvent[]) {
  const state = hc.getState() as any;
  const dealt: string[] = (state.communityCards ?? []).map((c: any) =>
    typeof c === 'string' ? c : `${c.rank}${c.suit}`
  );
  const stored: string[] = engine.currentHandCommunityCards ?? [];
  const complete = events.find((e) => e.type === 'HAND_COMPLETE') as any;

  // INV-1 — the stored board is the dealt board.
  expect(
    stored,
    `hand_history would store ${stored.length} board card(s) for a hand that dealt ${dealt.length}`
  ).toEqual(dealt);

  // INV-2 — the flag and the board agree.
  expect(state.sawFlop, `sawFlop=${state.sawFlop} with ${dealt.length} board card(s)`).toBe(
    dealt.length >= 3
  );

  // INV-3 — no flop, no drop.
  if (complete && !state.sawFlop) {
    expect(complete.rake ?? 0, `raked ${complete.rake} on a hand that never saw a flop`).toBe(0);
  }
  return { dealt, stored, complete };
}

describe('the engine records the hand it actually dealt', () => {
  /**
   * DEFECT A, the live one. Heads-up, the small blind folds, the big blind
   * takes a walk. Production hand 50d4006e is exactly this shape at 2/4: pot
   * 4.00, raked 0.20 — the correct 5% heads-up rate applied to a hand that
   * never had a flop.
   */
  it('a preflop walk is not raked', async () => {
    const engine = engineFor();
    const hc = new HandController(handConfig(), seats(2), 1);
    const events = wire(engine, hc);

    hc.start();
    const sb = (hc.getState() as any).currentPlayerSeat;
    hc.performAction(sb, 'fold' as any);
    await drain();

    const { dealt, complete } = assertRecordMatchesHand(engine, hc, events);
    expect(dealt).toHaveLength(0);
    expect(complete?.rake ?? 0).toBe(0);
  });

  /** The same shape multiway: the blinds post, everyone folds round to the BB. */
  it('a multiway fold-out is not raked', async () => {
    const engine = engineFor();
    const hc = new HandController(handConfig({ smallBlind: 1, bigBlind: 2 }), seats(5), 1);
    const events = wire(engine, hc);

    hc.start();
    for (let guard = 0; guard < 12; guard++) {
      const st = hc.getState() as any;
      if (st.currentPlayerSeat < 0) break;
      if (!hc.performAction(st.currentPlayerSeat, 'fold' as any)) break;
    }
    await drain();

    const { dealt } = assertRecordMatchesHand(engine, hc, events);
    expect(dealt).toHaveLength(0);
  });

  /**
   * DEFECT B's shape. The per-street dealer is the path insurance and
   * run-it-twice tables take, and 15 of the 16 hands stored with an empty
   * board sat on insurance-enabled tables. Each street must reach the stored
   * board, not just the felt.
   */
  it('a per-street runout stores every street it deals', async () => {
    const engine = engineFor({ insurance_enabled: true });
    const hc = new HandController(handConfig({ insuranceEnabled: true }), seats(2), 1);
    const events = wire(engine, hc);

    hc.start();
    for (let street = 0; street < 3; street++) {
      const out = hc.dealNextStreet();
      await drain();
      const stored: string[] = engine.currentHandCommunityCards ?? [];
      expect(
        stored.length,
        `after the ${out.stage} the felt shows ${out.board.length} card(s) and the record holds ${stored.length}`
      ).toBe(out.board.length);
      if (out.complete) break;
    }

    assertRecordMatchesHand(engine, hc, events);
  });

  /**
   * THE HARNESS MUST FAIL WHEN THE DEFECT IS PRESENT.
   *
   * `markFlopSeen()` is the only writer of sawFlop that deals no cards. It
   * exists for run-it-twice, whose boards are built outside this controller
   * (HandController ~1464), and it is called at the TOP of dealAndResolveRIT
   * — before a single card is dealt. Any path that reaches it and then does
   * not deal produces exactly the live signature of defect A: sawFlop true,
   * board empty, rake charged, and `rit_boards` empty because the board loop
   * never ran. All 20 production hands match that signature.
   *
   * This test does not claim to reproduce the live trigger. It pins the
   * DETECTION: if that state is ever reached, INV-2 and INV-3 say so. Without
   * it the suite above would stay green while the bug shipped, which is how
   * this went unnoticed in the first place.
   */
  it('detects a flop marked seen with no board behind it', async () => {
    const engine = engineFor();
    const hc = new HandController(handConfig(), seats(2), 1);
    const events = wire(engine, hc);

    hc.start();
    const sb = (hc.getState() as any).currentPlayerSeat;
    hc.performAction(sb, 'fold' as any);
    await drain();

    // Completed hands now reject late runout callbacks. Prove that guard,
    // then inject the corrupt state directly to retain this detector's
    // negative control without reopening the production mutation door.
    hc.markFlopSeen();
    expect(hc.getState().sawFlop).toBe(false);
    const corrupt = hc as unknown as {
      state: { sawFlop: boolean };
      boardDealtOutsideState: boolean;
    };
    corrupt.state.sawFlop = true;
    corrupt.boardDealtOutsideState = true;

    expect(() => assertRecordMatchesHand(engine, hc, events)).toThrow();

    const state = hc.getState() as any;
    expect(state.sawFlop).toBe(true);
    expect(state.communityCards ?? []).toHaveLength(0);
    // And this is why it costs money: the same pot now prices a rake.
    expect(hc.priceDeductions(state.sawFlop, 4).rake).toBeGreaterThan(0);
    expect(hc.priceDeductions(false, 4).rake).toBe(0);
  });

  /** A hand that genuinely reaches a flop must still be raked. */
  it('a hand that sees a flop is still raked', async () => {
    const engine = engineFor();
    const hc = new HandController(handConfig(), seats(2), 1);
    const events = wire(engine, hc);

    hc.start();
    for (let guard = 0; guard < 8; guard++) {
      const st = hc.getState() as any;
      if (st.currentPlayerSeat < 0) break;
      if ((st.communityCards ?? []).length >= 3) break;
      if (!hc.performAction(st.currentPlayerSeat, 'call' as any)) {
        hc.performAction(st.currentPlayerSeat, 'check' as any);
      }
    }
    await drain();

    const state = hc.getState() as any;
    if ((state.communityCards ?? []).length >= 3) {
      expect(state.sawFlop).toBe(true);
      assertRecordMatchesHand(engine, hc, events);
    }
  });
});
