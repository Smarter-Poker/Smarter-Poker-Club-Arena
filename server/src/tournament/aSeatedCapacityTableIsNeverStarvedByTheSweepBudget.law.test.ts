/**
 * A SEATED LATE-REGISTRATION TABLE GETS ITS DEALER WHATEVER THE SWEEP BUDGET
 * (2026-10-26).
 *
 * Production 13:28-13:55 UTC, engine 4dfd07ef: seven capacity tables across
 * Sunrise Bounty x2 and Morning Free Buy x2 sat with nine players seated and
 * no dealer for up to 27 minutes, because admission bailed on the spent 5 s
 * work budget on every pass of those busy events. A player reported it:
 * "I did a rebuy. That sat me at a table but no cards are being dealt."
 *
 * This drives the real admitCommittedCapacityTables with the budget already
 * spent (eliminationMutationAllowed() false), and proves it still starts the
 * dealer and acknowledges the receipt. It also proves the three things that
 * may stop it still do: a finished event, a stopped manager and an aborted
 * sweep.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  report: vi.fn(),
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { from: transport.from, rpc: transport.rpc },
  maintenanceSupabase: { from: transport.from, rpc: transport.rpc },
}));
vi.mock('../services/errorReporter.js', () => ({
  reportError: transport.report,
  reportThrottled: vi.fn(),
}));

const { TournamentManager } = await import('./TournamentManager.js');

const TOURNAMENT_ID = '3675640e-a27c-4650-a364-31eabd760566';
const TABLE_ID = '35a9c43f-ca72-4ea6-8a08-2b1579bafdce';

function receiptsQuery(rows: Array<{ table_id: string; created_at: string }>) {
  const query: any = {};
  for (const method of ['select', 'eq', 'is', 'order']) query[method] = vi.fn(() => query);
  query.limit = vi.fn(async () => ({ data: rows, error: null }));
  return query;
}

function manager(overrides: Record<string, unknown> = {}) {
  const controller = new AbortController();
  const self: any = {
    tournamentId: TOURNAMENT_ID,
    running: true,
    eliminationSweepSignal: controller.signal,
    // The budget is spent: the ordinary mutation fence says no.
    eliminationSweepDeadlineAt: Date.now() - 1_000,
    eliminationMutationBatchOpen: false,
    eliminationMutationAllowed: () => false,
    tournamentFinished: false,
    finalTableDealHandled: false,
    tableEngines: new Map(),
    startCapacityTableEngine: vi.fn(() => true),
    requestUrgentEliminationSweepAfter: vi.fn(),
    broadcast: vi.fn(async () => undefined),
    ...overrides,
  };
  return { self, controller };
}

const admit = (TournamentManager.prototype as any).admitCommittedCapacityTables as (
  this: unknown
) => Promise<void>;

describe('a seated late-registration table is never starved by the sweep budget', () => {
  beforeEach(() => {
    transport.from.mockReset();
    transport.rpc.mockReset();
    transport.report.mockReset();
    transport.from.mockImplementation(() =>
      receiptsQuery([{ table_id: TABLE_ID, created_at: '2026-10-26T13:29:24.186Z' }])
    );
    transport.rpc.mockResolvedValue({
      data: { ok: true, requested: 1, newly_admitted: 1 },
      error: null,
    });
  });

  it('starts the dealer and acknowledges the receipt with the work budget spent', async () => {
    const { self } = manager();
    await admit.call(self);
    expect(transport.from).toHaveBeenCalledWith('tournament_capacity_table_receipts');
    expect(self.startCapacityTableEngine).toHaveBeenCalledWith(TABLE_ID);
    expect(transport.rpc).toHaveBeenCalledWith('fn_ack_tournament_capacity_tables', {
      p_tournament_id: TOURNAMENT_ID,
      p_table_ids: [TABLE_ID],
    });
    expect(self.broadcast).toHaveBeenCalledWith(
      'table_expansion',
      expect.objectContaining({ newTableIds: [TABLE_ID] })
    );
    expect(transport.report).not.toHaveBeenCalled();
  });

  it('never starts a dealer for a finished event', async () => {
    for (const finished of [{ tournamentFinished: true }, { finalTableDealHandled: true }]) {
      const { self } = manager(finished);
      await admit.call(self);
      expect(self.startCapacityTableEngine).not.toHaveBeenCalled();
      expect(transport.rpc).not.toHaveBeenCalled();
    }
  });

  it('stops for a stopped manager or an aborted sweep', async () => {
    const stopped = manager({ running: false });
    await admit.call(stopped.self);
    expect(stopped.self.startCapacityTableEngine).not.toHaveBeenCalled();

    const aborted = manager();
    aborted.controller.abort();
    await admit.call(aborted.self);
    expect(aborted.self.startCapacityTableEngine).not.toHaveBeenCalled();
    expect(transport.rpc).not.toHaveBeenCalled();
  });
});
