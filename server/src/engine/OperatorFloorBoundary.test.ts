import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import * as seats from '../services/supabase.js';
import { supabase } from '../services/supabase.js';
const tableId = '11111111-1111-4111-8111-111111111111';
afterEach(() => vi.restoreAllMocks());
function engine() {
  const e = new ServerTableEngine(tableId) as any;
  e.running = true;
  e.isCurrentEngine = () => true;
  e.hub = { emitEvent: vi.fn() };
  return e;
}
describe('the original dealer owns its durable operator floor hold', () => {
  it('restores a persisted hold and keeps maintenance/Lightning authorities independent', async () => {
    const e = engine();
    vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: { hold: { mode: 'park', reason: 'Integrity investigation' }, close: null },
      error: null,
    } as any);
    await e.refreshOperatorFloor();
    expect(e.isNextHandPaused()).toBe(true);
    expect(e.isPausedByDesign()).toBe(true);
    e.maintenancePaused = true;
    e.dealingHaltLock = true;
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: { hold: null, close: null },
      error: null,
    } as any);
    await e.refreshOperatorFloor();
    expect(e.operatorFloorPaused).toBe(false);
    expect(e.isNextHandPaused()).toBe(true);
    expect(
      e.hub.emitEvent.mock.calls.filter((call: any[]) => call[1].type === 'table_resumed')
    ).toHaveLength(0);
    e.preciseTimer.dispose();
  });
  it('a confirmed per-table resume cannot release the independent floor hold', async () => {
    const e = engine();
    e.lifecycleCanMutate = () => true;
    e.engineLeaseVerified = true;
    e.engineLeaseGeneration = '33333333-3333-4333-8333-333333333333';
    const commandId = '44444444-4444-4444-8444-444444444444';
    const rpc = vi.spyOn(supabase, 'rpc').mockImplementation((name: string) => {
      if (name === 'fn_ca_operator_floor_state')
        return Promise.resolve({
          data: { hold: { mode: 'park' }, close: null },
          error: null,
        }) as any;
      if (name === 'fn_ca_get_table_operator_hold')
        return Promise.resolve({
          data: { paused: true, version: 1, command_id: null },
          error: null,
        }) as any;
      if (name === 'fn_ca_set_table_operator_hold')
        return Promise.resolve({
          data: { paused: false, version: 2, command_id: commandId },
          error: null,
        }) as any;
      throw new Error('unexpected operator RPC');
    });
    try {
      await e.refreshOperatorFloor();
      const answer = await e.requestOperatorHold(false, tableId, commandId);
      expect(answer).toMatchObject({ success: true, admin_paused: false, paused: true });
      expect(e.adminPauseLock).toBe(false);
      expect(e.operatorFloorPaused).toBe(true);
      expect(e.isNextHandPaused()).toBe(true);
      expect(rpc).toHaveBeenCalledWith(
        'fn_ca_set_table_operator_hold',
        expect.objectContaining({ p_paused: false, p_command_id: commandId, p_expected_version: 1 })
      );
      expect(
        e.hub.emitEvent.mock.calls.filter((call: any[]) => call[1].type === 'table_resumed')
      ).toHaveLength(0);
    } finally {
      e.preciseTimer.dispose();
    }
  });
  it('clearing the floor cannot lift a pending or unconfirmed per-table pause', async () => {
    const e = engine();
    e.lifecycleCanMutate = () => true;
    e.engineLeaseVerified = true;
    e.engineLeaseGeneration = '33333333-3333-4333-8333-333333333333';
    const commandId = '44444444-4444-4444-8444-444444444444';
    let floorHeld = true;
    let entered!: () => void;
    const writeEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: (value: unknown) => void;
    const unresolvedWrite = new Promise((resolve) => {
      finish = resolve;
    });
    vi.spyOn(supabase, 'rpc').mockImplementation((name: string) => {
      if (name === 'fn_ca_operator_floor_state')
        return Promise.resolve({
          data: { hold: floorHeld ? { mode: 'park' } : null, close: null },
          error: null,
        }) as any;
      if (name === 'fn_ca_get_table_operator_hold')
        return Promise.resolve({
          data: { paused: false, version: 0, command_id: null },
          error: null,
        }) as any;
      if (name === 'fn_ca_set_table_operator_hold') {
        entered();
        return unresolvedWrite as any;
      }
      throw new Error('unexpected operator RPC');
    });
    try {
      await e.refreshOperatorFloor();
      const attempt = e.requestOperatorHold(true, tableId, commandId);
      const refused = expect(attempt).rejects.toThrow('Operator hold write is unconfirmed');
      await writeEntered;
      expect(e.pendingOperatorPauses).toBe(1);
      floorHeld = false;
      await e.refreshOperatorFloor();
      expect(e.operatorFloorPaused).toBe(false);
      expect(e.isNextHandPaused()).toBe(true);
      finish({ data: null, error: { code: '57014' } });
      await refused;
      expect(e.pendingOperatorPauses).toBe(0);
      expect(e.unconfirmedOperatorCommands.get(commandId)).toEqual({
        paused: true,
        expectedVersion: 0,
      });
      await e.refreshOperatorFloor();
      expect(e.operatorFloorPaused).toBe(false);
      expect(e.isNextHandPaused()).toBe(true);
      expect(
        e.hub.emitEvent.mock.calls.filter((call: any[]) => call[1].type === 'table_resumed')
      ).toHaveLength(0);
    } finally {
      e.preciseTimer.dispose();
    }
  });
  it('fails closed on an unreadable authoritative hold', async () => {
    const e = engine();
    vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    } as any);
    await expect(e.refreshOperatorFloor()).rejects.toThrow('operator_floor_state_unknown');
    expect(e.isNextHandPaused()).toBe(true);
    e.preciseTimer.dispose();
  });
  it('an older delayed read cannot lift a newer durable hold', async () => {
    const e = engine();
    let finish!: (x: unknown) => void;
    vi.spyOn(supabase, 'rpc')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve as any;
          }) as any
      )
      .mockResolvedValueOnce({
        data: { hold: { mode: 'pause' }, close: null },
        error: null,
      } as any);
    const old = e.refreshOperatorFloor();
    await e.refreshOperatorFloor();
    finish({ data: { hold: null, close: null }, error: null });
    await old;
    expect(e.operatorFloorPaused).toBe(true);
    e.preciseTimer.dispose();
  });
  it('fences a completed cash close without awaiting its own dealing loop', async () => {
    const e = engine();
    e.operatorCloseRequest = {
      operation_id: tableId,
      actor_id: tableId,
      reason: 'Closing cash tables',
    };
    e.tableInfo = { tournament_id: null, club_id: tableId };
    e.lifecycleCanMutate = () => true;
    e.isBetweenHands = () => true;
    vi.spyOn(seats, 'loadSeatedPlayers').mockResolvedValue([]);
    e.adoptSeatRoster = vi.fn();
    vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: true, error: null } as any);
    e.stop = vi.fn(() => new Promise(() => {}));
    await e.closeOperatorCashAtBoundary();
    expect(e.stop).toHaveBeenCalledOnce();
    e.preciseTimer.dispose();
  });
  it('a close request cannot cash out a live hand or a tournament field', async () => {
    const e = engine();
    e.operatorCloseRequest = {
      operation_id: tableId,
      actor_id: tableId,
      reason: 'Closing cash tables',
    };
    e.handController = {};
    e.leaveTable = vi.fn();
    await e.closeOperatorCashAtBoundary();
    expect(e.leaveTable).not.toHaveBeenCalled();
    e.handController = null;
    e.tableInfo = { tournament_id: tableId };
    await e.closeOperatorCashAtBoundary();
    expect(e.leaveTable).not.toHaveBeenCalled();
    e.preciseTimer.dispose();
  });
});
