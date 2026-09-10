import { describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE_ID = '11111111-1111-4111-8111-111111111111';

function parkedEngine(): {
  engine: ServerTableEngine;
  state: any;
  released: ReturnType<typeof vi.fn>;
} {
  const engine = new ServerTableEngine(TABLE_ID);
  const state = engine as any;
  const released = vi.fn();
  state.running = true;
  state.handController = null;
  engine.pauseForFinalTableDeal(60_000);
  state.handForHandResolve = released;
  return { engine, state, released };
}

describe('final-table deal pause authority', () => {
  it('does not call a merely between-hands engine parked until its loop reaches the gate', () => {
    const engine = new ServerTableEngine(TABLE_ID);
    const state = engine as any;
    state.running = true;
    state.handController = null;

    engine.pauseForFinalTableDeal(60_000);

    expect(engine.isBetweenHands()).toBe(true);
    expect(engine.isParkedForFinalTableDeal()).toBe(false);
    expect(state.holdBeforeNextHand).toBe(true);
    expect(state.isPausedByDesign()).toBe(true);
  });

  it('reports ready only with its own authority, a live engine, and a physical park', () => {
    const { engine, state } = parkedEngine();
    expect(engine.isParkedForFinalTableDeal()).toBe(true);

    state.settlementInFlight = new Set([Promise.resolve()]);
    expect(engine.isParkedForFinalTableDeal()).toBe(false);
    state.settlementInFlight = new Set();
    state.handController = {};
    expect(engine.isParkedForFinalTableDeal()).toBe(false);
    state.handController = null;
    state.running = false;
    expect(engine.isParkedForFinalTableDeal()).toBe(false);
  });

  it('hand-for-hand resume cannot lift a final-table deal hold', () => {
    const { engine, state, released } = parkedEngine();
    state.handForHandPaused = true;

    engine.resumeDealing();

    expect(state.finalTableDealPaused).toBe(true);
    expect(state.handForHandResolve).toBe(released);
    expect(released).not.toHaveBeenCalled();
  });

  it('deal release cannot lift an overlapping maintenance pause', () => {
    const { engine, state, released } = parkedEngine();
    state.maintenancePaused = true;

    engine.resumeFromFinalTableDeal();

    expect(state.finalTableDealPaused).toBe(false);
    expect(state.maintenancePaused).toBe(true);
    expect(state.handForHandResolve).toBe(released);
    expect(released).not.toHaveBeenCalled();

    engine.resumeFromMaintenance();
    expect(released).toHaveBeenCalledOnce();
    expect(state.handForHandResolve).toBeNull();
  });

  it('maintenance release cannot lift an overlapping deal pause', () => {
    const { engine, state, released } = parkedEngine();
    state.maintenancePaused = true;

    engine.resumeFromMaintenance();

    expect(state.maintenancePaused).toBe(false);
    expect(state.finalTableDealPaused).toBe(true);
    expect(state.handForHandResolve).toBe(released);
    expect(released).not.toHaveBeenCalled();
  });
});

describe('operator resume owns only the operator pause', () => {
  it.each([
    [
      'maintenance',
      (e: any) => e.pauseForMaintenance(300_000),
      (e: any) => e.resumeFromMaintenance(),
    ],
    [
      'deal discussion',
      (e: any) => e.pauseForFinalTableDeal(60_000),
      (e: any) => e.resumeFromFinalTableDeal(),
    ],
    ['hand-for-hand', (e: any) => e.pauseAfterHand(), (e: any) => e.resumeDealing()],
  ] as const)('keeps the %s gate and state parked', async (_name, arm, release) => {
    const engine = new ServerTableEngine(TABLE_ID) as any;
    engine.running = true;
    engine.tableFSM.transition('waiting');
    engine.tableFSM.transition('seating');
    engine.tableFSM.transition('running');
    engine.hub = { emitEvent: vi.fn() };
    engine.persistPresenceForRestart = vi.fn(async () => {});
    engine.adminPause();
    arm(engine);
    const parked = engine.awaitPauseGate();
    const resolver = engine.handForHandResolve;
    try {
      engine.adminResume();
      expect(engine.adminPauseLock).toBe(false);
      expect(engine.tableFSM.state).toBe('paused');
      expect(engine.handForHandResolve).toBe(resolver);
      expect(
        engine.hub.emitEvent.mock.calls.some((call: any[]) => call[1].type === 'table_resumed')
      ).toBe(false);
    } finally {
      release(engine);
      await parked;
      engine.preciseTimer.dispose();
    }
  });

  it('cannot clear the separately requested maintenance lock', () => {
    const engine = new ServerTableEngine(TABLE_ID) as any;
    engine.tableFSM.transition('waiting');
    engine.tableFSM.transition('seating');
    engine.tableFSM.transition('running');
    engine.setMaintenanceLock(true);
    engine.adminPause();
    engine.adminResume();
    expect(engine.maintenanceLock).toBe(true);
    expect(engine.tableFSM.state).toBe('paused');
    engine.setMaintenanceLock(false);
    expect(engine.tableFSM.state).toBe('running');
    engine.preciseTimer.dispose();
  });
});

describe('another pause release preserves an operator hold', () => {
  it.each([
    [
      'maintenance',
      (e: any) => e.pauseForMaintenance(300_000),
      (e: any) => e.resumeFromMaintenance(),
    ],
    [
      'deal discussion',
      (e: any) => e.pauseForFinalTableDeal(60_000),
      (e: any) => e.resumeFromFinalTableDeal(),
    ],
    ['hand-for-hand', (e: any) => e.pauseAfterHand(), (e: any) => e.resumeDealing()],
  ] as const)('keeps the operator state after %s ends', async (_name, arm, release) => {
    const engine = new ServerTableEngine(TABLE_ID) as any;
    engine.running = true;
    for (const state of ['waiting', 'seating', 'running']) engine.tableFSM.transition(state);
    engine.persistPresenceForRestart = vi.fn(async () => {});
    engine.adminPause();
    arm(engine);
    const gate = engine.awaitPauseGate();
    release(engine);
    await gate;
    expect(engine.adminPauseLock).toBe(true);
    expect(engine.tableFSM.state).toBe('paused');
    engine.adminResume();
    expect(engine.tableFSM.state).toBe('running');
    engine.preciseTimer.dispose();
  });
});
