import { describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

function feeder() {
  const engine = Object.create(ServerTableEngine.prototype) as any;
  Object.assign(engine, {
    tableId: 'table',
    tableInfo: { cluster_id: 'cluster', game_type: 'cash' },
    seatedPlayers: [{ user_id: 'player', occupancy_id: 'current' }],
    dealtInUserIds: new Set(),
    dealingHaltLock: true,
    handController: null,
    returnedFromSitOutAtMs: new Map(),
    pendingSitOut: new Set(),
    leaveHeldByClock: new Map(),
    returningFromSitout: new Set(),
    disconnectEngine: { sitOut: vi.fn(), sitBack: vi.fn() },
    chipContinuity: { evaluate: vi.fn(async () => []) },
    broadcastCurrentState: vi.fn(),
    isContinuityActive: vi.fn(() => false),
  });
  return engine;
}

describe('restarted halted feeder keeps the one-real-hand Sit Out rule', () => {
  it('accepts authoritative completed Lightning participation for this occupancy without seeding button veterans', () => {
    const engine = feeder();
    expect(
      engine.sitOut('player', true, { completedLightningOccupancyId: 'current' }).success
    ).toBe(true);
    expect(engine.disconnectEngine.sitOut).toHaveBeenCalledOnce();
    expect(engine.dealtInUserIds.size).toBe(0);
  });
  it.each(['stale', undefined])(
    'refuses a %s occupancy proof without changing presence',
    (occupancy) => {
      const engine = feeder();
      expect(
        engine.sitOut('player', true, { completedLightningOccupancyId: occupancy })
      ).toMatchObject({
        success: false,
        code: 'SITOUT_HAND_REQUIRED',
      });
      expect(engine.disconnectEngine.sitOut).not.toHaveBeenCalled();
    }
  );
  it('never grants ordinary cash a Lightning proof exemption', () => {
    const engine = feeder();
    engine.dealingHaltLock = false;
    expect(
      engine.sitOut('player', true, { completedLightningOccupancyId: 'current' }).success
    ).toBe(false);
  });
  it('preserves ordinary veterans and return without requiring any proof', () => {
    const engine = feeder();
    engine.dealtInUserIds.add('player');
    expect(engine.sitOut('player', true).success).toBe(true);
    engine.dealtInUserIds.clear();
    expect(engine.sitOut('player', false).success).toBe(true);
  });
});
