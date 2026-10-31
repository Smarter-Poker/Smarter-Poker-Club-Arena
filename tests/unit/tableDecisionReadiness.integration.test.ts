import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../server/src/services/supabase/client.js', () => ({
  supabase: {},
  maintenanceSupabase: {},
}));
vi.mock('../../server/src/services/errorReporter.js', () => ({
  reportError: vi.fn(),
  reportWarning: vi.fn(),
}));
import { HandController } from '../../server/src/engine/HandController';
import { HandContinuationLane } from '../../server/src/engine/HandContinuationLane';
import { ServerTableEngine } from '../../server/src/engine/ServerTableEngine';
import type { HandConfig, SeatPlayer } from '../../server/src/types';
import { mapEngineSnapshot } from '../../src/utils/mapEngineSnapshot';
import { submitTableDecision, tableDecisionIsReady } from '../../src/lib/tableActionDecision';

let engine: any;
afterEach(() => {
  if (!engine) return;
  engine.handContinuation?.close();
  engine.clearLooseHandTimers();
  engine.clearTurnTimer();
  engine.preciseTimer.dispose();
  engine.engineTelemetry.dispose();
  engine.actionValidator.dispose();
  engine.timeBankEngine.disposeAll();
  (engine.constructor as any).releaseCurrentEngine(engine.tableId, engine);
  engine = null;
});

it('only the original retained-ready publication restores mapped input, without replaying a wager', async () => {
  engine = new ServerTableEngine('client-input-readiness') as any;
  expect(engine.claimProcessOwnership()).toBe(true);
  engine.running = true;
  const controller = new HandController(
    {
      tableId: 'client-input-readiness',
      handNumber: 1,
      gameVariant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    } as HandConfig,
    [1, 2, 3, 4].map((seat) => ({
      seat,
      user_id: `u${seat}`,
      username: `P${seat}`,
      stack: 100,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    })) as SeatPlayer[],
    1
  );
  controller.start();
  engine.handController = controller;
  engine.tableInfo = { game_variant: 'nlh', big_blind: 2, small_blind: 1, max_players: 4 };
  engine.handCount = 1;
  engine.playerTurnStartTime = Date.now() - 5000;
  engine.playerTurnDuration = 25;
  const published: Record<string, any>[] = [];
  engine.hub = {
    publish: (_table: string, state: Record<string, any>) => published.push(structuredClone(state)),
    emitEvent: vi.fn(),
  };
  const initial = engine.getTableState('u4');
  engine.retainedPublicHandState = { ...structuredClone(controller.getState()), deck: [] };
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lane = new HandContinuationLane(
    0,
    () => JSON.stringify(controller.getState()),
    () => ({}),
    async () => pending,
    async () => {},
    () => true,
    (error) => {
      throw error;
    },
    undefined,
    async () => engine.publishRetainedInputReadiness()
  );
  engine.handContinuation = lane;
  lane.checkpoint();
  const withheld = engine.getTableState('u4');
  const mapped = mapEngineSnapshot(withheld, 'u4', 4);
  expect(withheld.hand_number).toBe(initial.hand_number);
  expect(withheld.current_player).toBe(initial.current_player);
  expect(
    tableDecisionIsReady({ actionContext: mapped.actionContext, allowContextless: false })
  ).toBe(false);
  const send = vi.fn(async () => ({ success: true }));
  await submitTableDecision({
    actionContext: mapped.actionContext,
    allowContextless: false,
    send,
    refresh: async () => true,
  });
  expect(send).not.toHaveBeenCalled();
  expect(published).toHaveLength(0);
  release();
  await lane.join();
  expect(published).toHaveLength(1);
  expect(published[0].action_context).toBe(initial.action_context);
  expect(initial.turn_duration_ms).toBe(25000);
  expect(published[0].turn_deadline_ms).toBe(initial.turn_start_time_ms + initial.turn_duration_ms);
  expect(published[0].turn_start_time_ms).toBe(initial.turn_start_time_ms);
  const ready = mapEngineSnapshot(published[0], 'u4', 4);
  expect(
    tableDecisionIsReady({ actionContext: ready.actionContext, allowContextless: false })
  ).toBe(true);
  expect(send).not.toHaveBeenCalled();
  await submitTableDecision({
    actionContext: ready.actionContext,
    allowContextless: false,
    send,
    refresh: async () => true,
  });
  expect(send).toHaveBeenCalledExactlyOnceWith(initial.action_context);
});
