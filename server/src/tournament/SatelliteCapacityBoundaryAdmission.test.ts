import { afterEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => ({ read: vi.fn(), settle: vi.fn() }));
vi.mock('./satelliteQualifierRpc.js', () => ({
  readSatelliteQualifierState: rpc.read,
  requestSatelliteQualifierReceipt: rpc.settle,
}));
vi.mock('../maintenance/freezeState.js', () => ({ isMaintenanceFrozen: () => false }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn(), describeError: String }));
import { TournamentManager } from './TournamentManager.js';
import { supabase } from '../services/supabase.js';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const EVENT = id(1),
  EXISTING = id(2),
  PENDING = id(3);
function dealer() {
  return {
    isRunning: () => true,
    setHub: vi.fn(),
    parkForTerminalCloseout: vi.fn(async () => true),
    releaseTerminalCloseoutPause: vi.fn(),
  };
}
function harness() {
  const m: any = new TournamentManager(EVENT, {} as any, id(9), performance.now() + 60000);
  m.running = true;
  m.isRunning = () => true;
  m.isCohortSatellite = () => true;
  m.eliminationMutationAllowed = () => true;
  m.noteEliminationSweepStep = vi.fn();
  m.requestUrgentEliminationSweepAfter = vi.fn();
  m.declareConsolidationOutstanding = vi.fn();
  m.loadBalancerTables = vi.fn(async () => []);
  m.tableBalancer.shouldRebalance = () => false;
  m.broadcast = vi.fn(async () => true);
  m.prepareManagedTableEngineForPlay = vi.fn();
  m.wireEliminationWake = vi.fn();
  const existing = dealer(),
    fresh = dealer(),
    order: string[] = [];
  m.tableEngines.set(EXISTING, existing);
  m.gameServer.getTableEngine = (tableId: string) => m.tableEngines.get(tableId);
  m.gameServer.registerTableEngine = vi.fn(() => {
    order.push('register');
    return true;
  });
  m.createManagedTableEngine = vi.fn(() => fresh);
  m.startManagedTableEngine = vi.fn(() => {
    order.push('start');
    m.holdSatelliteQualifierBoundary();
  });
  m.satelliteQualifierBoundaryPending = true;
  m.satelliteQualifierBoundaryGeneration = 4;
  rpc.read.mockResolvedValue({
    state: 'continuing',
    fullTicketCount: 1,
    qualifierIds: Array.from({ length: 30 }, (_, n) => id(n + 100)),
  });
  const query: any = {
    select: () => query,
    eq: () => query,
    in: async () => ({ data: [{ id: PENDING }, { id: EXISTING }], error: null }),
  };
  vi.spyOn(supabase, 'from').mockReturnValue(query);
  const call = vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string) => {
    if (name === 'fn_ensure_late_registration_capacity')
      return {
        data: {
          ok: true,
          created: false,
          reason: 'capacity_sufficient',
          active_entries: 30,
          remaining_deficit: 0,
          pending_table_ids: [PENDING],
          pending_table_count: 1,
        },
        error: null,
      };
    if (name === 'fn_ack_tournament_capacity_tables') {
      order.push('ack');
      return { data: { ok: true, requested: 1 }, error: null };
    }
    throw new Error(`unexpected RPC ${name}`);
  }) as never);
  return { m, existing, fresh, order, call };
}
afterEach(() => {
  vi.restoreAllMocks();
  rpc.read.mockReset();
  rpc.settle.mockReset();
});
describe('a satellite boundary reaches its pending capacity admission', () => {
  it('admits the original receipt before acknowledging it, then releases the complete parked field', async () => {
    const { m, existing, fresh, order, call } = harness();
    expect(await m.checkSatelliteQualifierCompletion()).toBe('pending');
    expect(call).toHaveBeenCalledWith('fn_ensure_late_registration_capacity', {
      p_tournament_id: EVENT,
      p_reserved_entries: 0,
    });
    expect(order).toEqual(['register', 'start', 'ack']);
    expect(m.tableEngines.get(PENDING)).toBe(fresh);
    expect(m.prepareManagedTableEngineForPlay).toHaveBeenCalledWith(fresh);
    expect(m.satelliteQualifierBoundaryPending).toBe(true);
    expect(existing.releaseTerminalCloseoutPause).not.toHaveBeenCalled();
    expect(fresh.releaseTerminalCloseoutPause).not.toHaveBeenCalled();
    expect(rpc.settle).not.toHaveBeenCalled();
    expect(await m.checkSatelliteQualifierCompletion()).toBe('legacy');
    expect(m.satelliteQualifierBoundaryPending).toBe(false);
    expect(existing.releaseTerminalCloseoutPause).toHaveBeenCalledOnce();
    expect(fresh.releaseTerminalCloseoutPause).toHaveBeenCalledOnce();
    expect(m.gameServer.registerTableEngine).toHaveBeenCalledOnce();
  });
  it('keeps the boundary when capacity authority cannot answer', async () => {
    const { m, existing, call } = harness();
    call.mockResolvedValue({ data: null, error: { message: 'timeout' } } as never);
    expect(await m.checkSatelliteQualifierCompletion()).toBe('pending');
    expect(call).toHaveBeenCalledOnce();
    expect(m.tableEngines.has(PENDING)).toBe(false);
    expect(existing.releaseTerminalCloseoutPause).not.toHaveBeenCalled();
    expect(rpc.settle).not.toHaveBeenCalled();
  });
  it('leaves an existing stopped dealer to its original recovery owner', async () => {
    const { m, call } = harness();
    m.tableEngines.set(PENDING, { ...dealer(), isRunning: () => false });
    expect(await m.checkSatelliteQualifierCompletion()).toBe('pending');
    expect(call).not.toHaveBeenCalled();
    expect(m.createManagedTableEngine).not.toHaveBeenCalled();
  });
});
