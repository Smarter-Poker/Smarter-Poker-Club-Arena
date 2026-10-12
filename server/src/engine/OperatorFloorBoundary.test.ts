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

it('a closure-only dealer never deals even if its persisted close disappears', async () => {
  const e = new ServerTableEngine(tableId, {
    scope: 'cash',
    verified: true,
    generation: tableId,
    proofDeadlineMonotonicMs: performance.now() + 60000,
    closureOperationId: tableId,
  }) as any;
  vi.spyOn(supabase, 'rpc').mockResolvedValue({
    data: { hold: null, close: null },
    error: null,
  } as any);
  await e.refreshOperatorFloor();
  expect(e.operatorFloorPaused).toBe(true);
  await expect(e.passOperatorFloorBoundary()).rejects.toThrow(
    'operator_cash_close_authority_changed'
  );
  await expect(e.dealHand([])).rejects.toThrow('operator_cash_close_dealing_forbidden');
  e.preciseTimer.dispose();
});
