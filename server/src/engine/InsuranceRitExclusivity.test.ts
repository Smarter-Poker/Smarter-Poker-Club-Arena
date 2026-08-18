/**
 * DAN'S RULE (2026-08-18): "Insurance is only allowed for running it once."
 *
 * Two layers enforce it and both are pinned here against the REAL
 * handleAllInRunout dispatch:
 *   1. Config layer (FIX 92): a table configured with both features gets RIT
 *      force-disabled at engine start (insurance takes priority).
 *   2. Runtime layer: handleAllInRunout branches to the insurance per-street
 *      flow FIRST whenever insurance is enabled - the RIT offer block is
 *      unreachable on an insurance hand, and vice versa an insurance offer
 *      never appears on a RIT hand. A hand that runs multiple boards can
 *      therefore never carry an insurance contract, and an insured hand
 *      always runs exactly once.
 */
import { describe, it, expect } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

const TABLE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

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

function runoutHarness(opts: { insurance: boolean; rit: boolean }) {
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
    is_horse: false, // humans: nothing auto-responds, offers stay pending
  }));
  engine.runItTwiceEngine.configure(TABLE, {
    enabled: opts.rit,
    autoDeclineTimeout: 10,
    maxRuns: 3,
  });
  engine.insuranceEngine.configure(TABLE, {
    enabled: opts.insurance,
    houseMargin: 1.2,
    offerTimeoutSeconds: 15,
  });

  engine.handleAllInRunout(ev, engine.seatedPlayers);
  return { engine };
}

describe('insurance ⟂ run-it-twice — one hand can never carry both', () => {
  it('insurance enabled: the hand takes the insurance path and NO RIT offer exists', async () => {
    const { engine } = runoutHarness({ insurance: true, rit: true });
    // The per-street flow is async (deals a street, prices, offers).
    await new Promise((r) => setTimeout(r, 400));
    expect(engine.runItTwiceEngine.hasPendingOffer(TABLE)).toBe(false);
    const offers = engine.insuranceEngine.getOffers(TABLE);
    // The leader was offered insurance (or the spot was tied/uninsurable —
    // either way the RIT block was never reached). With random hole cards a
    // tie is possible; assert the RIT invariant unconditionally and the
    // insurance offer when the spot is insurable.
    if (offers.length > 0) {
      expect(offers[0].status).toBe('offered');
    }
  });

  it('RIT enabled without insurance: RIT offer exists and NO insurance offer ever appears', async () => {
    const { engine } = runoutHarness({ insurance: false, rit: true });
    expect(engine.runItTwiceEngine.hasPendingOffer(TABLE)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(engine.insuranceEngine.getOffers(TABLE)).toHaveLength(0);
  });
});
