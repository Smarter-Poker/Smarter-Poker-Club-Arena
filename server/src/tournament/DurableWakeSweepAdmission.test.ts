import { beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ from: vi.fn(), report: vi.fn(), frozen: false }));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { from: io.from },
  maintenanceSupabase: { from: io.from },
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: io.report, reportWarning: vi.fn() }));
vi.mock('../maintenance/freezeState.js', () => ({
  isMaintenanceFrozen: () => io.frozen,
  isTerminalSettlementFrozen: () => io.frozen,
}));
import { TournamentManager } from './TournamentManager.js';
const eventId = '00000000-0000-4000-8000-000000009917';
const row = { id: 990219, reason: 'late_registration', generation: 4 };
function fixture() {
  const value = new TournamentManager(eventId, {} as any) as any;
  value.running = true;
  value.resumeCommittedTerminalCleanup = vi.fn().mockResolvedValue(false);
  value.addOnOfferWindowOpen = () => false;
  value.requestUrgentEliminationSweepAfter = vi.fn();
  value.requestEliminationSweep = vi.fn();
  value.onEliminationSweepSettled = vi.fn();
  const sequence: string[] = [];
  value.reconcileTournamentEntryWindow = vi.fn(async () => {
    sequence.push('authority');
    return true;
  });
  value.admitCommittedCapacityTables = vi.fn(async () => {
    sequence.push('dealer');
    value.running = false;
  });
  const query: any = {};
  for (const key of ['select', 'eq', 'is', 'order']) query[key] = vi.fn(() => query);
  query.limit = vi.fn().mockResolvedValue({ data: [row], error: null });
  io.from.mockReturnValue(query);
  return { value, query, sequence };
}
beforeEach(() => {
  vi.clearAllMocks();
  io.frozen = false;
});
describe('existing sweep admission owns canonical pending wake handoff', () => {
  it('starts a committed capacity table without any Realtime delivery, after entry authority', async () => {
    const { value, query, sequence } = fixture();
    await value.runEliminationSweep(new AbortController().signal);
    expect(sequence).toEqual(['authority', 'dealer']);
    expect(io.from).toHaveBeenCalledWith('tournament_manager_wakes');
    expect(query.eq).toHaveBeenCalledWith('tournament_id', eventId);
    expect(query.is).toHaveBeenCalledWith('consumed_at', null);
    expect(query.limit).toHaveBeenCalledWith(20);
    expect([...value.pendingManagerWakes]).toEqual([[row.id, row.reason]]);
    expect([...value.pendingManagerWakeGenerations]).toEqual([[row.id, 4]]);
  });
  it('keeps a newer Realtime generation received while the canonical read was in flight', async () => {
    const { value, query } = fixture();
    query.limit.mockImplementation(async () => {
      value.pendingManagerWakes.set(row.id, row.reason);
      value.pendingManagerWakeGenerations.set(row.id, 5);
      return { data: [row], error: null };
    });
    await value.runEliminationSweep(new AbortController().signal);
    expect(value.pendingManagerWakeGenerations.get(row.id)).toBe(5);
  });
  it.each(['error', 'invalid'])(
    'reports an %s read and preserves known work for authoritative processing',
    async (kind) => {
      const { value, query, sequence } = fixture();
      value.pendingManagerWakes.set(row.id, row.reason);
      value.pendingManagerWakeGenerations.set(row.id, 5);
      query.limit.mockResolvedValue(
        kind === 'error'
          ? { data: null, error: { message: 'unavailable' } }
          : { data: [row, { ...row, id: 7, generation: 0 }], error: null }
      );
      await value.runEliminationSweep(new AbortController().signal);
      expect(sequence).toEqual(['authority', 'dealer']);
      expect(io.report).toHaveBeenCalled();
      expect(value.requestUrgentEliminationSweepAfter).toHaveBeenCalledOnce();
      expect([...value.pendingManagerWakeGenerations]).toEqual([[row.id, 5]]);
    }
  );
  it.each(['stopped', 'aborted', 'frozen'])(
    'does not hydrate or admit a dealer when %s',
    async (mode) => {
      const { value } = fixture();
      const controller = new AbortController();
      if (mode === 'stopped') value.running = false;
      if (mode === 'aborted') controller.abort();
      if (mode === 'frozen') io.frozen = true;
      // A frozen business sweep may continue its ordinary safe stages.
      value.reconcileTournamentEntryWindow.mockResolvedValue(false);
      value.checkFinalTableDeal = vi.fn().mockResolvedValue(true);
      await value.runEliminationSweep(controller.signal);
      expect(io.from).not.toHaveBeenCalledWith('tournament_manager_wakes');
      expect(value.admitCommittedCapacityTables).not.toHaveBeenCalled();
    }
  );
  it.each(['stop', 'abort', 'freeze'])(
    'does not fold a receipt after %s during the read',
    async (mode) => {
      const { value, query } = fixture();
      const controller = new AbortController();
      query.limit.mockImplementation(async () => {
        if (mode === 'stop') value.running = false;
        if (mode === 'abort') controller.abort();
        if (mode === 'freeze') io.frozen = true;
        return { data: [row], error: null };
      });
      value.checkFinalTableDeal = vi.fn().mockResolvedValue(true);
      await value.runEliminationSweep(controller.signal);
      expect(value.pendingManagerWakes.size).toBe(0);
      expect(value.admitCommittedCapacityTables).not.toHaveBeenCalled();
    }
  );
  it('cannot start a dealer when the database entry authority refuses', async () => {
    const { value } = fixture();
    value.reconcileTournamentEntryWindow.mockResolvedValue(false);
    await value.runEliminationSweep(new AbortController().signal);
    expect(value.reconcileTournamentEntryWindow).toHaveBeenCalledOnce();
    expect(value.admitCommittedCapacityTables).not.toHaveBeenCalled();
  });
});
