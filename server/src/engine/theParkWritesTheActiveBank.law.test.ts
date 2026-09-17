/**
 * LAW: the park writes the active bank too, and a park with nothing to write
 * is durable.
 *
 * The restart gate (MaintenanceBreak.readyForRestart) counts a table as
 * unparked while its park write has not landed. A bank still counting down
 * at the park used to be skipped by the capture, so a table whose every bank
 * was active had nothing to write, was never marked durable, and held the
 * gate shut for the whole break. Measured 2026-09-17 17:55 UTC on engine-01:
 * 30 such tables, readyForRestart never, three staged releases missed.
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
    });
  });

  it('is durable at once when no bank can be written, instead of holding the gate shut', async () => {
    const e = engine();
    // A bank with no meta cannot be restored, so there is nothing to write.
    e.timeBankEngine.initializePlayer(table, user, { remainingSeconds: 30, usesRemaining: 2 });
    e.pauseForMaintenance(120000);
    await e.presenceSave;
    expect(e.isMaintenanceStateDurable()).toBe(false);
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
