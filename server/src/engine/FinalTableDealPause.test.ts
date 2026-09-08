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

    state.settlementInFlight = Promise.resolve();
    expect(engine.isParkedForFinalTableDeal()).toBe(false);
    state.settlementInFlight = null;
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
