import { afterEach, expect, it, vi } from 'vitest';
import { TournamentManager } from './TournamentManager.js';
import { TournamentManagerEliminations } from './TournamentManagerEliminations.js';
import { TournamentSweepWorkCursor } from './TournamentSweepWorkCursor.js';
import { supabase } from '../services/supabase.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';
const eventId = '00000000-0000-4000-8000-000000000188';
const tableIds = ['table-one', 'table-two'];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setMaintenanceFrozen(false);
});
function admission(afterRead: (m: any) => void = () => {}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T14:25:46Z'));
  const m: any = new TournamentManager(eventId, {} as any, 'club', performance.now() + 60_000);
  m.running = true;
  m.eliminationSweepSignal = new AbortController().signal;
  m.eliminationSweepDeadlineAt = Date.now() + 5_000;
  m.requestUrgentEliminationSweepAfter = vi.fn();
  m.broadcast = vi.fn(async () => true);
  m.startCapacityTableEngine = vi.fn(() => true);
  const q: any = {
    select: () => q,
    eq: () => q,
    is: () => q,
    order: () => q,
    limit: vi.fn(async () => {
      vi.setSystemTime(Date.now() + 6_000);
      afterRead(m);
      return { data: tableIds.map((table_id) => ({ table_id })), error: null };
    }),
  };
  vi.spyOn(supabase, 'from').mockReturnValue(q);
  const rpc = vi
    .spyOn(supabase, 'rpc')
    .mockResolvedValue({ data: { ok: true, requested: 2 }, error: null } as never);
  return { m, q, rpc };
}
it('starts and acknowledges one bounded page even when its read spends the sweep budget', async () => {
  const { m, q, rpc } = admission();
  await m.admitCommittedCapacityTables();
  expect(q.limit).toHaveBeenCalledWith(20);
  expect(m.startCapacityTableEngine.mock.calls).toEqual(tableIds.map((id) => [id]));
  expect(rpc).toHaveBeenCalledWith('fn_ack_tournament_capacity_tables', {
    p_tournament_id: eventId,
    p_table_ids: tableIds,
  });
  expect(m.eliminationMutationBatchIsOpen()).toBe(false);
  expect(m.eliminationMutationAllowed()).toBe(false);
});
it('admits the committed page even when earlier work spent the ordinary clock budget', async () => {
  const { m, rpc } = admission();
  m.eliminationSweepDeadlineAt = Date.now() - 1;
  await m.admitCommittedCapacityTables();
  expect(m.startCapacityTableEngine).toHaveBeenCalledTimes(2);
  expect(rpc).toHaveBeenCalledOnce();
  expect(m.eliminationMutationBatchIsOpen()).toBe(false);
});
it.each(['stop', 'abort', 'freeze'] as const)(
  'a %s during the read prevents every start and acknowledgement',
  async (kind) => {
    const { m, rpc } = admission((manager) => {
      if (kind === 'stop') manager.running = false;
      if (kind === 'abort') manager.eliminationSweepSignal = AbortSignal.abort();
      if (kind === 'freeze') setMaintenanceFrozen(true);
    });
    await m.admitCommittedCapacityTables();
    expect(m.startCapacityTableEngine).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(m.eliminationMutationBatchIsOpen()).toBe(false);
  }
);
it('closes its batch and retains the same receipt identities after a lost acknowledgement', async () => {
  const { m, rpc } = admission();
  rpc.mockRejectedValueOnce(new Error('lost acknowledgement'));
  await expect(m.admitCommittedCapacityTables()).rejects.toThrow('lost acknowledgement');
  expect(m.eliminationMutationBatchIsOpen()).toBe(false);
  m.eliminationSweepDeadlineAt = Date.now() + 5_000;
  await m.admitCommittedCapacityTables();
  expect(rpc.mock.calls.map((call) => call[1])).toEqual([
    { p_tournament_id: eventId, p_table_ids: tableIds },
    { p_tournament_id: eventId, p_table_ids: tableIds },
  ]);
});
it('admits committed dealers after terminal authority and before seatless entry work', async () => {
  const order: string[] = [];
  const m: any = Object.create(TournamentManagerEliminations.prototype);
  Object.assign(m, {
    tournamentId: eventId,
    running: true,
    isProcessingEliminations: false,
    pendingManagerWakes: new Map([[1, 'late_registration']]),
    pendingManagerWakeGenerations: new Map([[1, 1]]),
    eliminationSweepCursor: new TournamentSweepWorkCursor(),
    tableEngines: new Map(),
    tournamentCache: {},
    resumeCommittedTerminalCleanup: vi.fn(async () => false),
    admitCommittedCapacityTables: vi.fn(async () => {
      order.push('admit');
    }),
    addOnOfferWindowOpen: () => true,
    lastAddOnOfferAt: 0,
    tryTournamentAddOns: vi.fn(async () => {
      order.push('addon');
      m.lastAddOnOfferPass = { offered: 0, more: false };
    }),
    scheduleAddOnRetry: vi.fn(),
    reconcileTournamentEntryWindow: vi.fn(async () => {
      order.push('reprice');
      return true;
    }),
    seatAcceptedEntrantsAwaitingChairs: vi.fn(async () => {
      order.push('seating');
      return false;
    }),
    requestEliminationSweep: vi.fn(),
    eliminationWorkBudgetExpired: () => false,
  });
  await m.runEliminationSweep(new AbortController().signal);
  expect(order).toEqual(['addon', 'reprice', 'admit', 'seating']);
});
