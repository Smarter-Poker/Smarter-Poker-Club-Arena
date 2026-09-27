/**
 * A BLIND LEVEL IS SPENT BY ANY DEALT HAND, NOT ONLY BY A BUST (2026-09-27)
 *
 * advanceBlindLevel holds a level that "came due with no hand dealt since it
 * began" (A_LEVEL_IS_NOT_SPENT_ON_A_HAND_THAT_WAS_NEVER_DEALT, 2026-09-23).
 * Its witness, lastObservedHandCompletedAtMs, is written by the manager's
 * onHandComplete callback. The engine only invoked that callback when a final
 * stack was zero, so the witness moved only when somebody busted.
 *
 * Measured on production 2026-09-27 15:43Z: 441 of 466 leased, dealing SNG and
 * Spin events were two or more levels behind their schedule. NLH Heads-Up
 * e0d497f5 (3-minute levels) had dealt 293 hands in three hours at level 0,
 * and the engine log said "Level 0 came due with no hand dealt since it
 * began - holding it until this tournament deals again" while it dealt.
 * Sunday Funday Six-Card Closer c7f21a83 (12-minute levels) sat at level 3
 * for days.
 *
 * These tests drive the real ServerTableEngine settlement method and the
 * real manager wiring. The first fails on the gated engine (the callback is
 * never invoked for a bust-free hand); all pass once every accepted hand is
 * reported and the manager keeps its own zero-stack gate for the sweep.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  commit: vi.fn(),
  obligations: vi.fn(),
  alert: vi.fn(async () => undefined),
}));
vi.mock('../services/supabase.js', async (original) => ({
  ...(await original<typeof import('../services/supabase.js')>()),
  logHandHistory: backend.commit,
  processHandPostCommitObligations: backend.obligations,
}));
vi.mock('../services/financialAlerts.js', () => ({ raiseFinancialAlert: backend.alert }));
vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (value: unknown) => String(value),
}));

import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { deadlineScheduler } from '../engine/DeadlineScheduler.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';

const TABLE = 'e4000000-0000-4000-8000-000000000001';
const EVENT = 'e4000000-0000-4000-8000-000000000002';
const A = 'e4000000-0000-4000-8000-000000000003';
const B = 'e4000000-0000-4000-8000-000000000004';
const C = 'e4000000-0000-4000-8000-000000000005';
const GENERATION = 'e4000000-0000-4000-8000-000000000006';

/** Every other post-hand read answers empty; no request leaves the process. */
const network = vi.fn(
  async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
);

beforeEach(() => {
  vi.stubGlobal('fetch', network);
});

afterEach(() => {
  deadlineScheduler.cancelAll(TABLE);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** One real tournament engine, holding a settled hand ready for postHandTasks. */
function engineWithSettledHand(finalStacks: [number, number, number]) {
  const engine = new ServerTableEngine(TABLE) as any;
  engine.tableInfo = {
    id: TABLE,
    tournament_id: EVENT,
    game_type: 'tournament',
    game_variant: 'nlh',
    small_blind: 25,
    big_blind: 50,
    max_players: 9,
  };
  engine.running = true;
  engine.handCount = 2_100_001;
  engine.lifecycleCanMutate = () => true;
  engine.hasCurrentEngineLeaseAuthority = () => true;
  engine.getEngineLeaseAuthority = () => ({ verified: true, generation: GENERATION });
  const dealt = [250, 100, 250];
  const winnerGain = finalStacks[0] - dealt[0];
  engine.currentHandPotSize = 150;
  engine.currentHandRake = 0;
  engine.currentHandBBJFee = 0;
  engine.currentHandDealtStacks = new Map([
    [A, dealt[0]],
    [B, dealt[1]],
    [C, dealt[2]],
  ]);
  engine.currentHandWinners = [{ userId: A, amount: winnerGain + 50, potIndex: 0 }];
  engine.currentHandPots = [{ index: 0, amount: winnerGain + 50, eligible: [A, B, C] }];
  engine.currentHandPerPotAwards = [
    { userId: A, amount: winnerGain + 50, potIndex: 0, low: false },
  ];
  engine.currentHandSeatGenerations = new Map(
    [A, B, C].map((id) => [id, { seat_id: id, seat_joined_at: '2026-09-27T00:00:00.123456Z' }])
  );
  const players = [A, B, C].map((id, index) => ({
    user_id: id,
    username: id,
    seat_number: index + 1,
    stack: finalStacks[index],
    is_horse: false,
  }));
  engine.seatedPlayers = players;
  backend.commit.mockImplementation(async (request: { handId: string }) => ({
    handId: request.handId,
    settlementCommitted: true,
  }));
  backend.obligations.mockImplementation(async () => ({ ok: true, pending_addons: 0 }));
  return { engine, players };
}

/** The real TournamentManagerBase wiring, on a manager holding only what it reads. */
function managerWiredTo(engine: unknown) {
  const manager = Object.create(TournamentManagerBase.prototype) as any;
  manager.lastObservedHandCompletedAtMs = 0;
  manager.requestEliminationSweep = vi.fn(() => true);
  manager.isCohortSatellite = () => false;
  (TournamentManagerBase.prototype as any).wireEliminationWake.call(manager, engine);
  return manager;
}

describe('a blind level is spent by any dealt hand', () => {
  it('the engine reports a bust-free accepted hand to its owner', async () => {
    const { engine, players } = engineWithSettledHand([350, 50, 200]);
    const seen: Array<{ tableId: string; stacks: { user_id: string; stack: number }[] }> = [];
    engine.onHandComplete((tableId: string, stacks: { user_id: string; stack: number }[]) =>
      seen.push({ tableId, stacks })
    );

    await engine.postHandTasks(players, 1);

    expect(backend.commit).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].tableId).toBe(TABLE);
    expect(seen[0].stacks.map((p) => p.stack)).toEqual([350, 50, 200]);
  });

  it('the manager records the witness for that hand and does not wake the sweep', async () => {
    const { engine, players } = engineWithSettledHand([350, 50, 200]);
    const manager = managerWiredTo(engine);
    // The level began before this hand; the guard compares against it.
    const levelBeganAt = Date.now() - 1;

    await engine.postHandTasks(players, 1);

    expect(manager.lastObservedHandCompletedAtMs).toBeGreaterThanOrEqual(levelBeganAt);
    // The fan-out the scheduler removed stays removed: no bust, no sweep.
    expect(manager.requestEliminationSweep).not.toHaveBeenCalled();
  });

  it('a bust still wakes the elimination sweep exactly once and records the witness', async () => {
    const { engine, players } = engineWithSettledHand([600, 0, 0]);
    const manager = managerWiredTo(engine);

    await engine.postHandTasks(players, 1);

    expect(manager.lastObservedHandCompletedAtMs).toBeGreaterThan(0);
    expect(manager.requestEliminationSweep).toHaveBeenCalledTimes(1);
  });

  it('a hand whose authoritative commit failed reports nothing', async () => {
    const { engine, players } = engineWithSettledHand([350, 50, 200]);
    const manager = managerWiredTo(engine);
    backend.commit.mockImplementation(async () => {
      throw Object.assign(new Error('commit refused'), { code: '40001' });
    });

    await engine.postHandTasks(players, 1).catch(() => undefined);

    expect(manager.lastObservedHandCompletedAtMs).toBe(0);
    expect(manager.requestEliminationSweep).not.toHaveBeenCalled();
  });
});
