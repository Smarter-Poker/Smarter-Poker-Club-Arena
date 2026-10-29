import { afterEach, expect, it, vi } from 'vitest';
const network = vi.hoisted(() => ({
  writes: [] as any[],
  answer: null as null | (() => Promise<any>),
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: (table: string) => ({
      upsert: (row: any, options: any) => {
        if (table !== 'engine_presence_parked') throw Error('Unexpected table');
        network.writes.push({ table, row: structuredClone(row), options });
        return network.answer ? network.answer() : Promise.resolve({ error: null });
      },
    }),
    rpc: () => {
      throw Error('Unexpected RPC');
    },
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn(), reportWarning: vi.fn() }));
import { ServerTableEngine } from './ServerTableEngine.js';
const engines: any[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  network.writes.length = 0;
  network.answer = null;
  vi.useRealTimers();
});
function fixture(n: number) {
  const tableId = `c0ffee00-0000-4000-8000-0000000009${n}0`,
    userId = 'cash-user-' + n;
  const e: any = new ServerTableEngine(tableId);
  engines.push(e);
  expect(e.claimProcessOwnership()).toBe(true);
  e.running = true;
  e.handCount = 37;
  e.tableInfo = { id: tableId, tournament_id: null };
  e.seatedPlayers = [
    {
      user_id: userId,
      seat_number: 1,
      stack: 1000,
      seat_id: `c0ffee00-0000-4000-8000-0000000009${n}1`,
      seat_joined_at: '2026-10-29T00:00:00Z',
      occupancy_id: `c0ffee00-0000-4000-8000-0000000009${n}2`,
    },
  ];
  e.timeBankEngine.initializePlayer(tableId, userId, { remainingSeconds: 27, usesRemaining: 1 });
  e.timeBankMeta.set(userId, { initialSeconds: 40, baseSeconds: 40, dbConsumedSeconds: 13 });
  e.disconnectEngine.registerPlayer(tableId, userId);
  const banks = e.captureParkedTimeBanks(),
    presence = e.captureRetainedPresence();
  // Reach the existing physical boundary before the maintenance announcement.
  e.pauseAfterHand(120000, { beforeNextHand: true, untilResumed: true });
  e.dealingLoopPromise = e.awaitPauseGate();
  expect(typeof e.handForHandResolve).toBe('function');
  return { e, tableId, userId, banks, presence };
}
it('real EED cash maintenance park acknowledges exact native banks/presence before real stop drops memory', async () => {
  const { e, tableId, userId, banks, presence } = fixture(1);
  e.pauseForMaintenance(300000);
  await e.presenceSave;
  expect(e.maintenancePaused).toBe(true);
  expect(e.presenceSavePending).toBe(0);
  expect(e.parkedBankSaveComplete).toBe(true);
  expect(e.isMaintenanceStateDurable()).toBe(true);
  expect(network.writes).toHaveLength(1);
  const { row, options } = network.writes[0];
  expect(options).toEqual({ onConflict: 'table_id' });
  expect(row.table_id).toBe(tableId);
  expect(row.engine_instance).toMatch(/:parked$/);
  expect(row.disconnect_states).toEqual(presence);
  expect(row.time_bank_snapshot).toEqual({
    version: 1,
    parkedAt: row.parked_at,
    handNumber: 37,
    players: banks,
  });
  expect(row.time_bank_snapshot.players[userId]).toEqual({
    occupancyId: e.seatedPlayers[0].occupancy_id,
    remainingSeconds: 27,
    usesRemaining: 1,
    initialSeconds: 40,
    baseSeconds: 40,
    dbConsumedSeconds: 13,
    unlimitedActivations: false,
  });
  expect(e.acknowledgedTimeBankPark).toEqual({
    handNumber: 37,
    banks: JSON.stringify(Object.entries(banks).sort(([a], [b]) => a.localeCompare(b))),
  });
  await e.stop();
  expect(e.timeBankEngine.getBanksForTable(tableId)).toEqual([]);
  expect(e.stoppedTimeBankCustody).toBeNull();
  expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(false);
  expect(e.terminalTeardownComplete).toBe(true);
  // The native parked row, not stopped-custody state, is the only durable bank witness.
  expect(network.writes).toHaveLength(1);
  expect(network.writes[0].row.time_bank_snapshot.players).toEqual(banks);
});
it('a held native park is not safe merely because maintenancePaused is true', async () => {
  let release!: (value: any) => void;
  network.answer = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const { e } = fixture(2);
  e.pauseForMaintenance(300000);
  await vi.waitFor(() => expect(network.writes).toHaveLength(1));
  expect(e.maintenancePaused).toBe(true);
  expect(e.presenceSavePending).toBe(1);
  expect(e.parkedBankSaveComplete).toBe(false);
  expect(e.acknowledgedTimeBankPark).toBeNull();
  expect(e.isMaintenanceStateDurable()).toBe(false);
  release({ error: null });
  await e.presenceSave;
  expect(e.parkedBankSaveComplete).toBe(true);
});
it('a refused native park keeps the exact bank checkpoint unconfirmed after its existing retry', async () => {
  vi.useFakeTimers();
  network.answer = async () => ({ error: { message: 'fixture refusal' } });
  const { e } = fixture(3);
  e.pauseForMaintenance(300000);
  await vi.advanceTimersByTimeAsync(0);
  expect(network.writes).toHaveLength(1);
  expect(e.parkedBankSaveComplete).toBe(false);
  expect(e.isMaintenanceStateDurable()).toBe(false);
  await vi.advanceTimersByTimeAsync(5000);
  await e.presenceSave;
  expect(network.writes).toHaveLength(2);
  expect(e.presenceSavePending).toBe(0);
  expect(e.parkedBankSaveComplete).toBe(false);
  expect(e.acknowledgedTimeBankPark).toBeNull();
  expect(e.isMaintenanceStateDurable()).toBe(false);
});
it('unknown time-bank accounting refuses before any external park write', async () => {
  const { e } = fixture(4);
  e.timeBankAccountingUnconfirmed = true;
  e.pauseForMaintenance(300000);
  await e.presenceSave;
  expect(network.writes).toEqual([]);
  expect(e.presenceSavePending).toBe(0);
  expect(e.parkedBankSaveComplete).toBe(false);
  expect(e.isMaintenanceStateDurable()).toBe(false);
  expect(e.maintenanceDurabilityReason()).toBe('accounting_unconfirmed');
});
