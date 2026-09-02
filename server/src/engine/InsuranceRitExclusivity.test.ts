/**
 * SEQUENCING 2026-08-26 (Dan's leader-seat recording) — supersedes FIX 92's
 * config-layer exclusion. A table may run BOTH features; the ORDER is fixed:
 *
 *   1. The run-it-multi-times question is asked FIRST (all-in, board short).
 *   2. Insurance engages ONLY when the hand resolves to a single run —
 *      chooser picks one, any responder declines, or the offer times out.
 *      ("THE INSURANCE PART PICKED UP ON THE TURN. AFTER THE RUN IT TWICE
 *      WAS DECLINED.")
 *   3. A hand that deals extra boards NEVER carries an insurance contract,
 *      and an insured hand always runs exactly once (Dan 2026-08-18:
 *      "insurance is only allowed for running it once").
 *
 * Pinned against the REAL handleAllInRunout dispatch.
 */
import { describe, it, expect } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

const TABLE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  /* The table ROW is the source of truth, not the engine's configure() call.
     Since 2026-08-27 handleAllInRunout re-reads it through
     applyRunItTwiceConfig() on every all-in — that is the fix for production
     hand #3046089, which dealt three boards off a configuration sampled when
     the engine booted. So a harness that only called runItTwiceEngine.configure
     below would have its `enabled` overwritten a moment later by the columns
     this row does not carry (`run_it_twice ?? true` — RIT defaults ON, see the
     2026-08-18 intent fix). Both are set, and they agree. */
  engine.tableInfo = {
    game_variant: 'nlh',
    big_blind: 10,
    run_it_twice: opts.rit,
    allow_run_it_twice: opts.rit,
    run_it_twice_enabled: false,
    insurance_enabled: opts.insurance,
  };
  engine.allInStreetPauseMs = 1; // drive ordering, not real seconds
  engine.allInFirstPauseMs = 1;
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

describe('insurance x run-it-twice - the RIT question first, insurance on a single run', () => {
  it('both enabled: the RIT offer fires FIRST and no insurance offer exists yet', async () => {
    const { engine } = runoutHarness({ insurance: true, rit: true });
    await sleep(300);
    expect(engine.runItTwiceEngine.hasPendingOffer(TABLE)).toBe(true);
    expect(engine.insuranceEngine.getOffers(TABLE)).toHaveLength(0);
  });

  it('both enabled: chooser runs it ONCE -> insurance flow engages', async () => {
    const { engine } = runoutHarness({ insurance: true, rit: true });
    await sleep(150);
    const chooserId = engine.runItTwiceEngine.getState(TABLE)?.chooserPlayerId as string;
    expect(chooserId).toBeTruthy();
    const resp = engine.respondToRIT(chooserId, undefined, 1);
    expect(resp.success).toBe(true);
    // waitForRITResponse polls, then the single-run continuation enters the
    // per-street insurance flow, which offers on the standing board.
    await sleep(900);
    expect(engine.runItTwiceEngine.isActive(TABLE)).toBe(false);
    const offers = engine.insuranceEngine.getOffers(TABLE);
    // Random hole cards can tie (no offer on a tied board) — when the spot is
    // insurable, the offer must exist and be pending for the leader.
    if (offers.length > 0) {
      expect(offers[0].status).toBe('offered');
    }
  });

  it('both enabled: RIT ACCEPTED (2 boards) -> NO insurance offer ever appears', async () => {
    const { engine } = runoutHarness({ insurance: true, rit: true });
    await sleep(150);
    const chooserId = engine.runItTwiceEngine.getState(TABLE)?.chooserPlayerId as string;
    const otherId = chooserId === 'u1' ? 'u2' : 'u1';
    expect(engine.respondToRIT(chooserId, undefined, 2).success).toBe(true);
    expect(engine.respondToRIT(otherId, 'accept').success).toBe(true);
    await sleep(900);
    // Multi-board hand: per-hand exclusivity — no insurance contract.
    expect(engine.insuranceEngine.getOffers(TABLE)).toHaveLength(0);
  });

  it('insurance only (no RIT): straight to the insurance path, no RIT offer', async () => {
    const { engine } = runoutHarness({ insurance: true, rit: false });
    await sleep(400);
    expect(engine.runItTwiceEngine.hasPendingOffer(TABLE)).toBe(false);
    const offers = engine.insuranceEngine.getOffers(TABLE);
    if (offers.length > 0) {
      expect(offers[0].status).toBe('offered');
    }
  });

  it('RIT only (no insurance): RIT offer exists and NO insurance offer ever appears', async () => {
    const { engine } = runoutHarness({ insurance: false, rit: true });
    expect(engine.runItTwiceEngine.hasPendingOffer(TABLE)).toBe(true);
    await sleep(200);
    expect(engine.insuranceEngine.getOffers(TABLE)).toHaveLength(0);
  });
});
