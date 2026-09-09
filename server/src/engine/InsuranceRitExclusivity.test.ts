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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const equityWorker = vi.hoisted(() => ({
  estimateEquity: vi.fn(),
  estimateInsurance: vi.fn(),
  estimateLayeredEquity: vi.fn(),
}));

vi.mock('./equity/EquityWorkerPool.js', () => ({
  getEquityPool: () => equityWorker,
}));

import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';
import { waitFor } from '../testing/waitBudget.js';

let tableSequence = 0;
let TABLE: string;
const runoutEngines = new Set<ServerTableEngine>();

beforeEach(() => {
  TABLE = 'eeeeeeee-eeee-eeee-eeee-' + String(++tableSequence).padStart(12, '0');
  equityWorker.estimateEquity.mockReset();
  equityWorker.estimateInsurance.mockReset();
  equityWorker.estimateLayeredEquity.mockReset();
  equityWorker.estimateEquity.mockImplementation(async (hands: unknown[][]) =>
    hands.map(() => 1 / hands.length)
  );
  equityWorker.estimateInsurance.mockImplementation(async (hands: unknown[][]) =>
    hands.map((_, index) => ({
      equity: index === 0 ? 82 : 18,
      strictLossPct: index === 0 ? 18 : 82,
      pushPct: 0,
      exact: false,
      runouts: 6000,
    }))
  );
  equityWorker.estimateLayeredEquity.mockImplementation(
    async (
      hands: unknown[][],
      _ids: string[],
      _seats: number[],
      _boards: unknown[][],
      _dead: unknown[],
      _iters: number,
      _variant: string,
      pots: unknown[],
      _dealer: number,
      totalWinnings: number
    ) => ({
      equities: hands.map((_, index) => (index === 0 ? 0.82 : 0.18)),
      layerEquities: pots.map(() => hands.map((_, index) => (index === 0 ? 0.82 : 0.18))),
      expectedNetReturns: hands.map((_, index) =>
        index === 0 ? totalWinnings * 0.82 : totalWinnings * 0.18
      ),
      strictLossPcts: hands.map((_, index) => (index === 0 ? 18 : 82)),
      pushPcts: hands.map(() => 0),
      seed: 424242,
      exact: false,
      runouts: 6000,
    })
  );
});

afterEach(async () => {
  try {
    for (const engine of runoutEngines) {
      await engine.stop();
      expect(engine.isRunning()).toBe(false);
    }
  } finally {
    runoutEngines.clear();
    vi.restoreAllMocks();
  }
});

/**
 * DE-FLAKE 2026-09-03 (CI run 33807616017, PR #2888) — wait for the CONDITION,
 * not for the clock. Same lesson, same shape, as the 2026-08-22 de-flake in
 * RunItTwice.multiway.test.ts.
 *
 * Every wait in this file used to be a flat `sleep(n)`, which is a bet on how
 * fast the machine is. Both offers in play carry a WALL-CLOCK deadline on the
 * shared DeadlineScheduler, so the bet is not merely slow when it loses - the
 * deadline auto-declines the offer and the assertion reads the wrong status.
 * That is exactly what went red: "insurance only (no RIT)" spent 30,675ms on
 * its `sleep(400)` inside a 348-file run, the 15s insurance window closed, and
 * `expected 'declined' to be 'offered'` on a branch that had touched nothing
 * near insurance. Reproduced deterministically by shrinking the window to
 * 0.15s; green again at every window once the waits became conditional.
 */
/*
 * DE-FLAKE 2026-09-06 (PR #3272). The conditional waits below were the right
 * fix for the flat sleeps described above, but the budget was a hardcoded
 * 10_000 - identical to `testTimeout: 10_000` in vitest.config.ts. A wait that
 * spends its whole budget is killed by vitest at the same instant it would
 * have given up, so it can never report what it was waiting for; CI prints
 * "Test timed out in 10000ms" and names nothing. It also silently RETURNED on
 * exhaustion, leaving the caller's assertion to report a symptom.
 *
 * Budget and ceiling now come from src/testing/waitBudget.ts (imported at the
 * top), the budget is strictly under the ceiling, and an exhausted wait throws
 * saying what it wanted. Each call site passes that description.
 */

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
  runoutEngines.add(engine);
  // This harness tests runout dispatch, not database snapshot persistence.
  // Stop the real engine after every assertion (including failed assertions),
  // so pending offers and table-keyed deadlines cannot outlive their test.
  vi.spyOn(engine, 'flushSnapshot').mockResolvedValue(undefined);
  engine.running = true;
  engine.handCount = 1;
  engine.handController = hc;
  engine.lifecycleCanMutate = () => true;
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
  engine.allInStreetRevealMs = 1;
  engine.allInPreShowdownPauseMs = 1;
  engine.seatedPlayers = players.map((p) => ({
    seat_number: p.seat,
    user_id: p.user_id,
    username: p.username,
    stack: p.stack,
    is_horse: false, // humans: nothing auto-responds, offers stay pending
  }));
  engine.currentHandActions = players.map((player, index) => ({
    seat: player.seat,
    userId: player.user_id,
    action: index === 0 ? 'all_in' : 'call',
    timestamp: 1,
    stage: 'preflop',
  }));
  /* The second half of the same de-flake. NO test in this file exercises a
     timeout - the windows exist only so the machinery does not hang - and at
     10s/15s they are close enough to the waits below to race them on a loaded
     runner. Ten minutes is longer than any stall a CI worker survives, so the
     ordering these tests pin is the only thing they can measure. Timeout
     behaviour is pinned where it belongs: RunItTwice.offerpath.test.ts drives
     it on fake timers, InsuranceEngine.test.ts asserts the declined status. */
  engine.runItTwiceEngine.configure(TABLE, {
    enabled: opts.rit,
    autoDeclineTimeout: 600,
    maxRuns: 3,
  });
  engine.insuranceEngine.configure(TABLE, {
    enabled: opts.insurance,
    houseMargin: 1.2,
    offerTimeoutSeconds: 600,
  });

  engine.handleAllInRunout(ev, engine.seatedPlayers);
  return { engine, events };
}

describe('insurance x run-it-twice - the RIT question first, insurance on a single run', () => {
  const handOver = (events: HandEvent[]) => !!events.find((e) => e.type === 'HAND_COMPLETE');

  it('both enabled: the RIT offer fires FIRST and no insurance offer exists yet', async () => {
    const { engine } = runoutHarness({ insurance: true, rit: true });
    // The RIT offer appearing IS the ordering claim. Read insurance the moment
    // it appears, instead of betting 300ms that it has.
    await waitFor(
      () => engine.runItTwiceEngine.hasPendingOffer(TABLE),
      'a pending RIT offer on the table'
    );
    expect(engine.runItTwiceEngine.hasPendingOffer(TABLE)).toBe(true);
    expect(engine.insuranceEngine.getOffers(TABLE)).toHaveLength(0);
  });

  it('both enabled: chooser runs it ONCE -> insurance flow engages', async () => {
    const { engine, events } = runoutHarness({ insurance: true, rit: true });
    await waitFor(
      () => !!engine.runItTwiceEngine.getState(TABLE)?.chooserPlayerId,
      'the RIT engine to name a chooser'
    );
    const chooserId = engine.runItTwiceEngine.getState(TABLE)?.chooserPlayerId as string;
    expect(chooserId).toBeTruthy();
    const resp = engine.respondToRIT(chooserId, undefined, 1);
    expect(resp.success).toBe(true);
    // waitForRITResponse polls, then the single-run continuation enters the
    // per-street insurance flow, which offers on the standing board.
    await waitFor(
      () => !engine.runItTwiceEngine.isActive(TABLE),
      'the RIT offer to finish (accepted, declined or expired)'
    );
    expect(engine.runItTwiceEngine.isActive(TABLE)).toBe(false);
    // Random hole cards can tie (no offer on a tied board) - when the spot is
    // insurable, the offer must exist and be pending for the leader. Either
    // outcome ends the wait: the offer lands and holds the runout, or there is
    // nothing to insure and the hand runs out.
    await waitFor(
      () => engine.insuranceEngine.getOffers(TABLE).length > 0 || handOver(events),
      'an insurance offer, or the hand to end'
    );
    const offers = engine.insuranceEngine.getOffers(TABLE);
    if (offers.length > 0) {
      expect(offers[0].status).toBe('offered');
    }
  }, 30_000);

  it('both enabled: RIT ACCEPTED (2 boards) -> NO insurance offer ever appears', async () => {
    const { engine, events } = runoutHarness({ insurance: true, rit: true });
    await waitFor(
      () => !!engine.runItTwiceEngine.getState(TABLE)?.chooserPlayerId,
      'the RIT engine to name a chooser'
    );
    const chooserId = engine.runItTwiceEngine.getState(TABLE)?.chooserPlayerId as string;
    const otherId = chooserId === 'u1' ? 'u2' : 'u1';
    expect(engine.respondToRIT(chooserId, undefined, 2).success).toBe(true);
    expect(engine.respondToRIT(otherId, 'accept').success).toBe(true);
    // "NEVER carries an insurance contract" is a claim about the WHOLE hand,
    // so wait for the hand to end rather than for 900ms of it.
    await waitFor(() => handOver(events), 'the hand to reach HAND_COMPLETE');
    expect(handOver(events)).toBe(true);
    // Multi-board hand: per-hand exclusivity - no insurance contract.
    expect(engine.insuranceEngine.getOffers(TABLE)).toHaveLength(0);
  });

  it('insurance only (no RIT): straight to the insurance path, no RIT offer', async () => {
    const { engine, events } = runoutHarness({ insurance: true, rit: false });
    await waitFor(
      () => engine.insuranceEngine.getOffers(TABLE).length > 0 || handOver(events),
      'an insurance offer, or the hand to end'
    );
    expect(engine.runItTwiceEngine.hasPendingOffer(TABLE)).toBe(false);
    const offers = engine.insuranceEngine.getOffers(TABLE);
    if (offers.length > 0) {
      expect(offers[0].status).toBe('offered');
    }
  });

  it('RIT only (no insurance): RIT offer exists and NO insurance offer ever appears', async () => {
    const { engine } = runoutHarness({ insurance: false, rit: true });
    expect(engine.runItTwiceEngine.hasPendingOffer(TABLE)).toBe(true);
    // Insurance is switched off, so nothing can ever create an offer here; the
    // wait only has to outlive the point where one WOULD have been created,
    // which is the RIT offer standing open.
    await waitFor(
      () => engine.runItTwiceEngine.hasPendingOffer(TABLE),
      'a pending RIT offer on the table'
    );
    expect(engine.insuranceEngine.getOffers(TABLE)).toHaveLength(0);
  });
});
