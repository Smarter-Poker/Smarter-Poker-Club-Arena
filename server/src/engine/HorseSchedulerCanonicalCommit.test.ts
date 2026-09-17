import { horsePlanBatchBindingFromRequest } from './HorsePlanHandIdentity.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandConfig, HorseDecision, SeatPlayer } from '../types.js';
import type { FastHorseDecisionResult } from './horseDecision/protocol.js';

const worker = vi.hoisted(() => ({
  decideFast: vi.fn(),
  decideDeep: vi.fn(),
  commitDecisionEffects: vi.fn(async () => undefined),
  runWithDispatchBarrier: vi.fn(<T>(fn: () => T): T => fn()),
}));
vi.mock('./horseDecision/index.js', async () => ({
  ...(await vi.importActual<typeof import('./horseDecision/index.js')>('./horseDecision/index.js')),
  getLiveHorseDecisionWorker: () => worker,
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

import { HandController } from './HandController.js';
import { ServerTableEngine } from './ServerTableEngine.js';
import { createHorseExecutionWitness } from './HorseExecutionWitness.js';

const TABLE = 'fa100000-0000-4000-8000-000000000001';

function harness(variant: 'flh' | 'flo8', situation: 'short_open' | 'short_raise' | 'free') {
  const stacks =
    situation === 'short_open'
      ? [500, 25, 500]
      : situation === 'short_raise'
        ? [500, 500, 45]
        : [500, 500, 500];
  const players = stacks.map((stack, i) => ({
    seat: i + 1,
    user_id: `fa200000-0000-4000-8000-00000000000${i + 1}`,
    username: `Horse ${i + 1}`,
    stack,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  })) as SeatPlayer[];
  const hc = new HandController(
    {
      tableId: TABLE,
      handNumber: 1,
      gameVariant: variant,
      smallBlind: 10,
      bigBlind: 20,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    } as HandConfig,
    players,
    1
  );
  hc.start();
  for (const action of ['call', 'call', 'check'] as const)
    expect(hc.performAction(hc.getState().currentPlayerSeat!, action)).toBe(true);
  expect(hc.getState().stage).toBe('flop');
  if (situation === 'short_open') expect(hc.performAction(2, 'all_in')).toBe(true);
  if (situation === 'short_raise') {
    expect(hc.performAction(2, 'bet', 20)).toBe(true);
    expect(hc.performAction(3, 'all_in')).toBe(true);
  }
  const state = hc.getState();
  const seat = state.currentPlayerSeat!;
  const enginePlayer = state.players.find((p) => p.seat === seat)!;
  const player = {
    seat_number: seat,
    user_id: enginePlayer.user_id,
    username: enginePlayer.username,
    stack: enginePlayer.stack,
    is_horse: true,
    horse_profile: {},
  };
  const engine = new ServerTableEngine(TABLE) as any;
  engine.running = true;
  engine.isCurrentEngine = () => true;
  engine.handCount = 1;
  engine.tableInfo = { action_time_seconds: 15, big_blind: 20, game_variant: variant };
  engine.seatedPlayers = [player];
  engine.handController = hc;
  engine.disconnectEngine = { isSittingOut: () => false, recordPlayerActed: vi.fn() };
  engine.timeBankEngine = { isArmed: () => false, getPlayerBank: () => null };
  engine.getEngineLeaseAuthority = () => ({ verified: true, generation: '9' });
  engine.humansSeated = () => 0;
  engine.tableFormat = () => 'cash';
  engine.markProgress = vi.fn();
  const origins: unknown[] = [];
  hc.onEvent((event) => {
    if (event.type === 'PLAYER_ACTION') origins.push(event.origin);
  });
  const perform = vi.spyOn(hc, 'performAction');
  return { engine, player, enginePlayer, hc, state, seat, perform, origins };
}

function answer(decision: HorseDecision) {
  let witness: ReturnType<typeof createHorseExecutionWitness> | undefined;
  worker.decideFast.mockImplementationOnce(async (snapshot): Promise<FastHorseDecisionResult> => {
    witness = createHorseExecutionWitness(snapshot, decision, {
      requestId: 1,
      lane: 'fast',
      computeMs: 1,
      governorScale: 1,
    });
    return {
      type: 'FAST_RESULT',
      planIssueDisposition: 'no_effects',
      planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 1 }),
      requestId: 1,
      generation: snapshot.generation,
      fence: snapshot.fence,
      decision: { ...decision, executionWitness: witness },
      rngBefore: 11,
      rngAfter: 22,
      computeMs: 1,
      governorScale: 1,
      effects: [],
    };
  });
  return () => witness;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(['flh', 'flo8'] as const)('%s actual Horse scheduler completion', (variant) => {
  it.each([
    ['short_open', 20],
    ['short_raise', 40],
  ] as const)(
    'preserves a legal %s completion to %s through acceptance',
    async (situation, amount) => {
      const h = harness(variant, situation);
      const witness = answer({ action: 'raise', amount, thinkTime: 1 });
      h.engine.scheduleHorseAction(h.player, h.seat, h.enginePlayer, h.state);
      await vi.advanceTimersByTimeAsync(300);
      expect(worker.decideFast).toHaveBeenCalledOnce();
      expect(worker.decideFast.mock.calls[0][0].gameState).toMatchObject({
        bettingStructure: 'fixed_limit',
        minRaiseTo: amount,
        maxRaiseTo: amount,
      });
      expect(h.perform.mock.calls[0].slice(0, 4)).toEqual([
        h.seat,
        'raise',
        amount,
        'horse_policy',
      ]);
      expect(h.perform).toHaveBeenCalledOnce();
      expect(h.hc.getState().actionHistory.at(-1)).toMatchObject({
        seat: h.seat,
        action: 'raise',
        amount,
      });
      expect(h.hc.getState().players.find((p) => p.seat === h.seat)?.is_folded).toBe(false);
      expect(witness()).toMatchObject({
        executionStatus: 'intended',
        executedAction: 'raise',
        executedAmount: amount,
      });
      expect(h.origins).toEqual(['horse_policy']);
    }
  );
});

describe('actual Horse scheduler caught-brain exception provenance', () => {
  it.each([
    ['free', 'check'],
    ['short_open', 'fold'],
  ] as const)(
    'marks accepted %s %s as fallback despite a normal positive worker request id',
    async (situation, action) => {
      const h = harness('flh', situation);
      const witness = answer({ action, thinkTime: 1, policyFallback: 'brain_exception' });
      h.engine.scheduleHorseAction(h.player, h.seat, h.enginePlayer, h.state);
      await vi.advanceTimersByTimeAsync(300);
      expect(h.perform).toHaveBeenCalledOnce();
      expect(h.hc.getState().actionHistory.at(-1)).toMatchObject({ seat: h.seat, action });
      expect(witness()).toMatchObject({ executionStatus: 'fallback', executedAction: action });
      expect(h.perform.mock.calls[0][3]).toBe('horse_fallback');
      expect(h.origins).toEqual(['horse_fallback']);
      expect(worker.commitDecisionEffects).not.toHaveBeenCalled();
    }
  );
});
