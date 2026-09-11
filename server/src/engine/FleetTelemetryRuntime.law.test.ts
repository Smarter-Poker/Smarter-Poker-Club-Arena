import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const worker = vi.hoisted(() => ({
  decideFast: vi.fn(async (snapshot: any) => ({
    type: 'FAST_RESULT',
    requestId: 1,
    generation: snapshot.generation,
    fence: snapshot.fence,
    decision: { action: 'call', thinkTime: 2000 },
    effects: [],
    rngBefore: 1,
    rngAfter: 2,
    computeMs: 1,
    governorScale: 1,
  })),
  decideDeep: vi.fn(),
  runWithDispatchBarrier: <T>(run: () => T): T => run(),
  commitDecisionEffects: vi.fn(async () => ({})),
}));
vi.mock('./horseDecision/index.js', async () => ({
  ...(await vi.importActual<typeof import('./horseDecision/index.js')>('./horseDecision/index.js')),
  getLiveHorseDecisionWorker: () => worker,
}));
vi.mock('../services/supabase/client.js', () => ({ supabase: {}, maintenanceSupabase: {} }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../http/auth.js', () => ({ authenticateRequest: vi.fn(async () => ({ userId: 'u4' })) }));
vi.mock('../http/body.js', () => ({ readBody: vi.fn(async (req: any) => req.body) }));
vi.mock('../http/rateLimit.js', () => ({ checkRateLimit: vi.fn(() => true) }));

import { EngineTelemetry } from './EngineTelemetry.js';
import { HandController } from './HandController.js';
import { ServerTableEngine } from './ServerTableEngine.js';
import { GameServer } from '../GameServer.js';
import { handleAction } from '../handlers/action.js';
import { mockReq, mockRes, parseJson } from '../handlers/_testHelpers.js';
import { _resetActionIdempotencyForTests } from '../http/actionIdempotency.js';
import type { HandConfig, SeatPlayer } from '../types.js';

const telemetry: EngineTelemetry[] = [];
function meter() {
  const t = new EngineTelemetry();
  telemetry.push(t);
  return t;
}
function engineWithRealHand(horse = false) {
  const engine = new ServerTableEngine('abababab-abab-abab-abab-abababababab') as any;
  telemetry.push(engine.telemetry);
  const players = [1, 2, 3, 4].map((seat) => ({
    seat,
    user_id: `u${seat}`,
    username: `Player ${seat}`,
    stack: 100,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  })) as SeatPlayer[];
  const hand = new HandController(
    {
      tableId: engine.tableId,
      handNumber: 9_000_001,
      gameVariant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    } as HandConfig,
    players,
    1
  );
  hand.start();
  engine.running = true;
  engine.isCurrentEngine = () => true;
  engine.lifecycleCanMutate = () => true;
  engine.handController = hand;
  engine.handCount = 9_000_001;
  engine.tableInfo = { game_variant: 'nlh', big_blind: 2, action_time_seconds: 15 };
  engine.seatedPlayers = players.map((p) => ({
    ...p,
    seat_number: p.seat,
    is_horse: horse && p.seat === 4,
    horse_profile: {},
  }));
  engine.getEngineLeaseAuthority = () => ({ verified: true, generation: 'lease-1' });
  engine.requestSnapshot = vi.fn();
  engine.markProgress = vi.fn();
  return { engine, hand, player: engine.seatedPlayers[3] };
}
function metric(text: string, name: string) {
  return Number(
    text
      .split('\n')
      .find((line) => line.startsWith(name + ' '))
      ?.slice(name.length + 1)
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));
  EngineTelemetry.__resetFleetCountersForTest();
  _resetActionIdempotencyForTests();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  telemetry.splice(0).forEach((t) => t.dispose());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('one process ledger serves health and Prometheus', () => {
  it('counts completed hands rather than global hand ordinals, including unsampled retirement', () => {
    const server = new GameServer() as any;
    const { engine } = engineWithRealHand();
    engine.handCount = 2_200_000_000;
    server.tableEngines.set(engine.tableId, engine);
    engine.telemetry.recordHandTiming(engine.tableId, 1, 1, 5000);
    expect(server.getStatus().totalHandsDealt).toBe(1);
    expect(metric(server.getPrometheusMetrics(), 'poker_hands_dealt_total')).toBe(1);
    // Neither endpoint observes this second hand before retirement.
    engine.telemetry.recordHandTiming(engine.tableId, 1, 1, 6000);
    engine.telemetry.recordActionProcessingTime(engine.tableId, 'u4', 'call', 2);
    engine.telemetry.dispose();
    server.tableEngines.delete(engine.tableId);
    expect(server.getStatus().totalHandsDealt).toBe(2);
    expect(server.getStatus().performance.totalActionsRecorded).toBe(1);
    expect(metric(server.getPrometheusMetrics(), 'poker_hands_dealt_total')).toBe(2);
    const replacement = engineWithRealHand().engine;
    server.tableEngines.set(replacement.tableId, replacement);
    replacement.telemetry.recordHandTiming(replacement.tableId, 1, 1, 7000);
    expect(server.getStatus().totalHandsDealt).toBe(3);
    expect(metric(server.getPrometheusMetrics(), 'poker_hands_dealt_total')).toBe(3);
  });

  it('keeps lifetime actions separate from bounded samples and expires stale latency evidence', () => {
    const t = meter();
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    for (let i = 0; i < 650; i++) t.recordActionProcessingTime('t', 'u', 'call', 2);
    expect(EngineTelemetry.getFleetSnapshot([t])).toMatchObject({
      totalActionsRecorded: 650,
      actionSampleCount: 500,
      avgProcessingMs: 2,
      avgBroadcastMs: null,
      broadcastSampleCount: 0,
    });
    expect(metric(EngineTelemetry.renderFleetMetrics([t]), 'poker_actions_recorded_total')).toBe(
      650
    );
    expect(metric(EngineTelemetry.renderFleetMetrics([t]), 'poker_broadcast_latency_ms')).toBeNaN();
    elapsed = 300_001;
    // A backwards wall-clock correction must not keep stale samples fresh.
    vi.setSystemTime(Date.now() - 60_000);
    expect(EngineTelemetry.getFleetSnapshot([t])).toMatchObject({
      totalActionsRecorded: 650,
      actionSampleCount: 0,
      avgProcessingMs: null,
      lastActionAgeMs: 300_001,
    });
    expect(metric(EngineTelemetry.renderFleetMetrics([t]), 'poker_action_processing_ms')).toBeNaN();
  });

  it('reports empty evidence as unavailable and weights only measured broadcasts', () => {
    expect(EngineTelemetry.getFleetSnapshot([])).toMatchObject({
      totalActionsRecorded: 0,
      totalHandsDealt: 0,
      actionSampleCount: 0,
      avgProcessingMs: null,
      avgBroadcastMs: null,
      lastActionAt: null,
    });
    const a = meter(),
      b = meter();
    a.recordActionProcessingTime('a', 'u', 'call', 2, 10);
    for (let i = 0; i < 100; i++) b.recordActionProcessingTime('b', 'u', 'call', 2);
    expect(EngineTelemetry.getFleetSnapshot([a, b])).toMatchObject({
      avgBroadcastMs: 10,
      broadcastSampleCount: 1,
      actionSampleCount: 101,
    });
  });
});

describe('accepted rule execution is the timing boundary', () => {
  it('arms the broadcast clock before the real synchronous action executes', () => {
    const { engine, hand } = engineWithRealHand();
    const acceptedAt = Date.now();
    engine.lastActionAcceptedAtMs = acceptedAt - 5000;
    const original = hand.performAction.bind(hand);
    const observedClocks: number[] = [];
    vi.spyOn(hand, 'performAction').mockImplementation((...args) => {
      observedClocks.push(engine.lastActionAcceptedAtMs);
      return original(...args);
    });
    expect(engine.handlePlayerAction('u4', 'call').success).toBe(true);
    expect(observedClocks).toEqual([acceptedAt]);
    expect(hand.getState().actionHistory.filter((a) => a.action === 'call')).toHaveLength(1);
  });

  it('keeps false and thrown operations uncounted and preserves a true action if telemetry throws', () => {
    const t = meter();
    expect(EngineTelemetry.measureAcceptedAction(t, 't', 'u', 'call', () => false)).toBe(false);
    const failure = new Error('rules failure');
    expect(() =>
      EngineTelemetry.measureAcceptedAction(t, 't', 'u', 'call', () => {
        throw failure;
      })
    ).toThrow(failure);
    expect(t.getPerformanceSummary().totalActionsRecorded).toBe(0);
    const apply = vi.fn(() => true);
    vi.spyOn(t, 'recordActionProcessingTime').mockImplementation(() => {
      throw new Error('metric sink');
    });
    expect(EngineTelemetry.measureAcceptedAction(t, 't', 'u', 'call', apply)).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('uses a monotonic execution duration and counts an actual accepted hand action once', () => {
    const { engine, hand } = engineWithRealHand();
    let mono = 10;
    vi.spyOn(performance, 'now').mockImplementation(() => mono);
    const original = hand.performAction.bind(hand);
    vi.spyOn(hand, 'performAction').mockImplementation((...args) => {
      mono += 7;
      vi.setSystemTime(Date.now() - 60_000);
      return original(...args);
    });
    expect(engine.handlePlayerAction('u4', 'call').success).toBe(true);
    expect(hand.getState().actionHistory.filter((a) => a.action === 'call')).toHaveLength(1);
    expect(engine.telemetry.getPerformanceSummary()).toMatchObject({
      totalActionsRecorded: 1,
      actionCount: 1,
      avgProcessingMs: 7,
    });
    expect(engine.handlePlayerAction('u4', 'call').success).toBe(false);
    expect(engine.telemetry.getPerformanceSummary().totalActionsRecorded).toBe(1);
  });

  it('HTTP acceptance and idempotent replay do not duplicate the engine sample', async () => {
    const { engine, hand } = engineWithRealHand();
    const body = JSON.stringify({
      tableId: engine.tableId,
      action: 'call',
      actionContext: engine.getActionContext(),
      idempotencyKey: 'telemetry-key-0001',
    });
    const post = async () => {
      const { res, captured } = mockRes();
      await handleAction(Object.assign(mockReq(), { body }), res, {
        gameServer: { getTableEngine: () => engine },
      });
      return parseJson(captured) as any;
    };
    expect((await post()).success).toBe(true);
    expect((await post()).replayed).toBe(true);
    expect(hand.getState().actionHistory.filter((a) => a.action === 'call')).toHaveLength(1);
    expect(engine.telemetry.getPerformanceSummary().totalActionsRecorded).toBe(1);
  });

  it('real horse dispatch records its accepted action after pacing, excluding the two-second think delay', async () => {
    const { engine, hand, player } = engineWithRealHand(true);
    const state = hand.getState();
    engine.scheduleHorseAction(
      player,
      4,
      state.players.find((p) => p.seat === 4),
      state
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(engine.telemetry.getPerformanceSummary().actionCount).toBe(0);
    await vi.advanceTimersByTimeAsync(2500);
    expect(hand.getState().actionHistory.filter((a) => a.action === 'call')).toHaveLength(1);
    const perf = engine.telemetry.getPerformanceSummary();
    expect(perf.actionCount).toBe(1);
    expect(perf.avgProcessingMs).toBeLessThan(100);
  });

  it('records only the real fallback that lands after a rejected horse decision', async () => {
    const { engine, hand, player } = engineWithRealHand(true);
    const perform = vi.spyOn(hand, 'performAction').mockReturnValueOnce(false);
    const state = hand.getState();
    engine.scheduleHorseAction(
      player,
      4,
      state.players.find((p) => p.seat === 4),
      state
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(perform.mock.calls.map((call) => call[1])).toEqual(['call', 'check', 'fold']);
    expect(hand.getState().actionHistory.filter((a) => a.action === 'fold')).toHaveLength(1);
    expect(engine.telemetry.getPerformanceSummary()).toMatchObject({
      totalActionsRecorded: 1,
      actionCount: 1,
    });
  });

  it('does not record a horse result cancelled during its pacing delay', async () => {
    const { engine, hand, player } = engineWithRealHand(true);
    const state = hand.getState();
    engine.scheduleHorseAction(
      player,
      4,
      state.players.find((p) => p.seat === 4),
      state
    );
    await vi.advanceTimersByTimeAsync(500);
    engine.cancelHorseDecisionWork();
    await vi.advanceTimersByTimeAsync(2500);
    expect(hand.getState().actionHistory).toEqual(state.actionHistory);
    expect(engine.telemetry.getPerformanceSummary().actionCount).toBe(0);
  });
});
