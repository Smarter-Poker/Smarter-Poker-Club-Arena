import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({ supabase: {}, maintenanceSupabase: {} }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../http/auth.js', () => ({ authenticateRequest: vi.fn(async () => ({ userId: 'u4' })) }));
vi.mock('../http/body.js', () => ({ readBody: vi.fn(async (req: any) => req.body) }));
vi.mock('../http/rateLimit.js', () => ({ checkRateLimit: vi.fn(() => true) }));
import { handleAction } from '../handlers/action.js';
import { _resetActionIdempotencyForTests } from '../http/actionIdempotency.js';
import { mockReq, mockRes, parseJson } from '../handlers/_testHelpers.js';
import { playerActionContext } from './PlayerActionContext.js';
import { HandController } from './HandController.js';
import { ServerTableEngine } from './ServerTableEngine.js';
import type { HandConfig, SeatPlayer } from '../types.js';

function hand() {
  const h = new HandController(
    {
      tableId: 'context-test',
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
  h.start();
  return h;
}
function harness() {
  const h = hand();
  const engine = Object.create(ServerTableEngine.prototype) as any;
  engine.handController = h;
  engine.lifecycleCanMutate = () => true;
  engine.actionLock = false;
  engine._handlePlayerActionInner = vi.fn((user: string, action: string, amount?: number) => ({
    success: h.performAction(Number(user.slice(1)), action as any, amount),
  }));
  return { h, engine };
}
describe('HTTP decision context before engine mutation', () => {
  it.each(['previous-decision', null])(
    'rejects context %s without moving chips or advancing the turn',
    (context) => {
      const { h, engine } = harness();
      const before = JSON.stringify(h.getState());
      const result = engine.handlePlayerAction('u4', 'raise', 10, context);
      expect(result.success).toBe(false);
      expect(JSON.stringify(h.getState())).toBe(before);
      expect(engine._handlePlayerActionInner).not.toHaveBeenCalled();
    }
  );
  it('accepts the displayed context and retains trusted internal actions', () => {
    const { h, engine } = harness();
    expect(
      engine.handlePlayerAction('u4', 'call', undefined, engine.getActionContext()).success
    ).toBe(true);
    expect(engine.handlePlayerAction('u1', 'call').success).toBe(true);
    expect(h.getState().actionHistory.filter((a) => a.action === 'call')).toHaveLength(2);
  });
});

function revisit(h: HandController) {
  expect(h.performAction(1, 'raise', 6)).toBe(true);
  expect(h.performAction(2, 'call')).toBe(true);
  expect(h.performAction(3, 'call')).toBe(true);
  expect(h.getState().currentPlayerSeat).toBe(4);
}
describe('real hand decision identity', () => {
  it('changes when the same seat faces another decision in the same hand', () => {
    const { h, engine } = harness();
    const old = engine.getActionContext();
    expect(engine.handlePlayerAction('u4', 'call', undefined, old).success).toBe(true);
    revisit(h);
    const before = JSON.stringify(h.getState());
    expect(engine.handlePlayerAction('u4', 'call', undefined, old).code).toBe('STALE_ACTION');
    expect(JSON.stringify(h.getState())).toBe(before);
    expect(
      engine.handlePlayerAction('u4', 'call', undefined, engine.getActionContext()).success
    ).toBe(true);
  });
  it('rejects a rebuilt incarnation of the same numbered hand', () => {
    const { engine } = harness();
    const old = engine.getActionContext();
    engine.handController = hand();
    expect(engine.getActionContext()).not.toBe(old);
    expect(engine.handlePlayerAction('u4', 'raise', 10, old).code).toBe('STALE_ACTION');
    expect(engine._handlePlayerActionInner).not.toHaveBeenCalled();
  });
  it('is stable during clock updates and contains no card or deck values', () => {
    const { h, engine } = harness();
    const token = engine.getActionContext();
    engine.playerTurnStartTime = Date.now();
    engine.playerTurnDuration = 100;
    expect(engine.getActionContext()).toBe(token);
    expect(playerActionContext(h)).toBe(token);
    expect(token).toMatch(/^[0-9a-f-]{36}:preflop:0:4:2$/);
  });
});
async function post(engine: any, body: Record<string, unknown>) {
  const req = Object.assign(mockReq(), { body: JSON.stringify(body) });
  const { res, captured } = mockRes();
  await handleAction(req, res, { gameServer: { getTableEngine: () => engine } });
  return { status: captured.statusCode, body: parseJson(captured) as any };
}
describe('HTTP retries preserve the decision boundary', () => {
  beforeEach(() => _resetActionIdempotencyForTests());
  it('replays once, then rejects the obsolete decision even after cache eviction', async () => {
    const { h, engine } = harness();
    engine.recordActionPerformance = vi.fn();
    const body = {
      tableId: 'context-test',
      action: 'call',
      actionContext: engine.getActionContext(),
      idempotencyKey: 'context-key-0001',
    };
    expect((await post(engine, body)).body.success).toBe(true);
    revisit(h);
    const before = JSON.stringify(h.getState());
    expect((await post(engine, body)).body.replayed).toBe(true);
    expect(JSON.stringify(h.getState())).toBe(before);
    _resetActionIdempotencyForTests();
    expect((await post(engine, body)).body.code).toBe('STALE_ACTION');
    expect(JSON.stringify(h.getState())).toBe(before);
  });
  it('binds a duplicate key to its original context', async () => {
    const { h, engine } = harness();
    engine.recordActionPerformance = vi.fn();
    const body = {
      tableId: 'context-test',
      action: 'call',
      actionContext: engine.getActionContext(),
      idempotencyKey: 'context-key-0002',
    };
    expect((await post(engine, body)).body.success).toBe(true);
    revisit(h);
    expect((await post(engine, { ...body, actionContext: engine.getActionContext() })).status).toBe(
      409
    );
    expect(engine._handlePlayerActionInner).toHaveBeenCalledTimes(1);
  });
  it('a legacy browser gets a reload instruction without applying its action', async () => {
    const { engine } = harness();
    engine.recordActionPerformance = vi.fn();
    const result = await post(engine, { tableId: 'context-test', action: 'raise', amount: 10 });
    expect(result.status).toBe(200); // The legacy client reads only successful HTTP envelopes.
    expect(result.body.success).toBe(false);
    expect(result.body.code).toBe('ACTION_CONTEXT_REQUIRED');
    expect(result.body.error).toContain('Reload');
    expect(engine._handlePlayerActionInner).not.toHaveBeenCalled();
  });
});

describe('decision context delivery', () => {
  function delivery() {
    const engine = new ServerTableEngine('context-delivery') as any;
    const h = hand();
    engine.handController = h;
    engine.tableInfo = { game_variant: 'nlh', big_blind: 2, small_blind: 1, max_players: 4 };
    engine.handCount = 1;
    engine.hub = { publish: vi.fn(), emitEvent: vi.fn() };
    return { engine, h };
  }
  it('publishes the same context on HTTP resync and live state', async () => {
    const { engine } = delivery();
    const token = engine.getActionContext();
    expect(engine.getTableState('u4').action_context).toBe(token);
    await engine.broadcastCurrentState();
    expect(engine.hub.publish.mock.calls.at(-1)[1].action_context).toBe(token);
  });
  it.each([false, true])(
    'never labels an obsolete discrete turn with a new decision: advance=%s',
    async (advance) => {
      const { engine, h } = delivery();
      engine.handleTurnChange = vi.fn(async () => {});
      engine.markProgress = vi.fn();
      const token = engine.getActionContext();
      engine.broadcastCurrentState = vi.fn(async () => {
        if (advance) {
          h.performAction(4, 'call');
          revisit(h);
        }
      });
      await engine.handleHandEvent({ type: 'TURN_CHANGE', seat: 4, availableActions: [] }, [
        { seat_number: 4, user_id: 'u4' },
      ]);
      const turns = engine.hub.emitEvent.mock.calls.filter(
        (c: any[]) => c[1].type === 'turn_change'
      );
      if (advance) expect(turns).toHaveLength(0);
      else {
        expect(turns).toHaveLength(1);
        expect(turns[0][1].action_context).toBe(token);
      }
    }
  );
});
