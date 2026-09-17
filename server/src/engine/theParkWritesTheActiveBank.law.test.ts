/**
 * LAW: the park settles an active bank before checkpointing it. Only a
 * genuinely empty checkpoint is durable without a write.
 *
 * The restart gate requires a complete, acknowledged checkpoint. An active
 * allocation must use the owning bank/accounting transition before capture;
 * missing metadata is an unknown outcome, never an empty bank.
 *
 * See docs/laws.d/server-src-engine-theParkWritesTheActiveBank.md
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const data = vi.hoisted(() => ({
  row: null as any,
  rpc: vi.fn(),
  writeErrors: [] as unknown[],
  writes: 0,
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    rpc: data.rpc,
    from: () => ({
      upsert: async (row: unknown) => {
        data.writes += 1;
        const error = data.writeErrors.shift() ?? null;
        if (!error) data.row = row;
        return { error };
      },
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: data.row, error: null }) }),
      }),
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { ServerTableEngine } from './ServerTableEngine.js';

const table = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const user = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const stay = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function engine() {
  const e = new ServerTableEngine(table) as any;
  e.lifecycleCanMutate = () => true;
  e.tableInfo = { id: table, tournament_id: null };
  e.handCount = 12;
  e.parkWriteRetryMs = 0;
  e.adoptSeatRoster([{ user_id: user, occupancy_id: stay, seat_number: 2, stack: 25 }]);
  return e;
}

beforeEach(() => {
  data.row = null;
  data.writeErrors = [];
  data.writes = 0;
  data.rpc.mockReset();
  data.rpc.mockResolvedValue({ data: { success: true, shortfall_seconds: 0 }, error: null });
});

describe('the park writes the active bank too', () => {
  it('captures a bank that is still counting down, charged its whole activation', async () => {
    const e = engine();
    e.timeBankEngine.initializePlayer(table, user, { remainingSeconds: 30, usesRemaining: 2 });
    e.timeBankMeta.set(user, { initialSeconds: 80, baseSeconds: 40, dbConsumedSeconds: 10 });
    e.timeBankEngine.configure(table, { secondsPerUse: 20 });
    const activated = e.timeBankEngine.activate(table, user, () => undefined);
    expect(activated).toBe(true);
    expect(e.timeBankEngine.getPlayerBank(table, user).isActive).toBe(true);
    e.pauseForMaintenance(120000);
    await e.presenceSave;
    expect(e.isMaintenanceStateDurable()).toBe(false);
    await e.persistPresenceForRestart('parked');
    expect(e.isMaintenanceStateDurable()).toBe(true);
    const snapshot = data.row?.time_bank_snapshot;
    expect(snapshot?.players?.[user]).toMatchObject({
      occupancyId: stay,
      remainingSeconds: 10,
      usesRemaining: 1,
      dbConsumedSeconds: 30,
    });
    expect(e.timeBankEngine.getPlayerBank(table, user).isActive).toBe(false);
    expect(data.rpc).toHaveBeenCalledTimes(1);
    expect(data.rpc).toHaveBeenCalledWith('fn_consume_time_bank', {
      p_user_id: user,
      p_seconds: 20,
    });
  });

  it('keeps an initialized bank with missing metadata behind the restart gate', async () => {
    const e = engine();
    // Missing metadata is not evidence that an initialized bank is safe to lose.
    e.timeBankEngine.initializePlayer(table, user, { remainingSeconds: 30, usesRemaining: 2 });
    e.pauseForMaintenance(120000);
    await e.presenceSave;
    expect(e.isMaintenanceStateDurable()).toBe(false);
    await e.persistPresenceForRestart('parked');
    expect(data.writes).toBe(0);
    expect(e.isMaintenanceStateDurable()).toBe(false);
  });

  it('is durable without a write only when there is no initialized bank or presence', async () => {
    const e = engine();
    e.pauseForMaintenance(120000);
    await e.presenceSave;
    await e.persistPresenceForRestart('parked');
    expect(data.writes).toBe(0);
    expect(e.isMaintenanceStateDurable()).toBe(true);
  });

  it('retries a refused park write once, and a successful retry is durable', async () => {
    const e = engine();
    e.timeBankEngine.initializePlayer(table, user, { remainingSeconds: 7, usesRemaining: 1 });
    e.timeBankMeta.set(user, { initialSeconds: 80, baseSeconds: 40, dbConsumedSeconds: 33 });
    e.pauseForMaintenance(120000);
    await e.presenceSave;
    data.writeErrors = [new Error('write unavailable')];
    await e.persistPresenceForRestart('parked');
    expect(data.writes).toBe(2);
    expect(e.isMaintenanceStateDurable()).toBe(true);
  });

  it('leaves the gate shut when the retry is refused as well', async () => {
    const e = engine();
    e.timeBankEngine.initializePlayer(table, user, { remainingSeconds: 7, usesRemaining: 1 });
    e.timeBankMeta.set(user, { initialSeconds: 80, baseSeconds: 40, dbConsumedSeconds: 33 });
    e.pauseForMaintenance(120000);
    await e.presenceSave;
    data.writeErrors = [new Error('write unavailable'), new Error('still unavailable')];
    await e.persistPresenceForRestart('parked');
    expect(data.writes).toBe(2);
    expect(e.isMaintenanceStateDurable()).toBe(false);
  });
});
