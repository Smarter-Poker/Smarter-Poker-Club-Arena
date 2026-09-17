import { beforeEach, describe, expect, it, vi } from 'vitest';
const data = vi.hoisted(() => ({
  row: null as any,
  rpc: vi.fn(),
  readError: null as unknown,
  writeError: null as unknown,
  beforeWrite: null as (() => Promise<void>) | null,
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    rpc: data.rpc,
    from: () => ({
      upsert: async (row: unknown) => {
        await data.beforeWrite?.();
        if (!data.writeError) data.row = row;
        return { error: data.writeError };
      },
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: data.row, error: data.readError }) }),
      }),
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { ServerTableEngine } from './ServerTableEngine.js';
import { loadTimeBanksFromPark } from '../services/supabase/snapshots.js';
const table = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const user = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const stay = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function engine(occupancy = stay) {
  const e = new ServerTableEngine(table) as any;
  e.lifecycleCanMutate = () => true;
  e.tableInfo = { id: table, tournament_id: null };
  e.handCount = 12;
  e.adoptSeatRoster([{ user_id: user, occupancy_id: occupancy, seat_number: 2, stack: 25 }]);
  return e;
}
async function saved() {
  const e = engine();
  e.disconnectEngine.restoreFsmStates(table, {
    [user]: { state: 'SAT_OUT', sinceMs: Date.now() - 30000, graceDeadlineMs: null },
  });
  e.timeBankEngine.initializePlayer(table, user, { remainingSeconds: 7, usesRemaining: 1 });
  e.timeBankMeta.set(user, { initialSeconds: 80, baseSeconds: 40, dbConsumedSeconds: 33 });
  await e.persistPresenceForRestart('parked');
  return e;
}
beforeEach(() => {
  data.row = null;
  data.readError = null;
  data.writeError = null;
  data.beforeWrite = null;
  data.rpc.mockReset();
});
describe('a marked parked bank survives only its own unchanged stay and hand boundary', () => {
  it('preserves seven remaining seconds and the billed basis across a new engine', async () => {
    await saved();
    const next = engine();
    await next.readParkedTimeBanks();
    next.adoptSeatRoster(next.seatedPlayers);
    expect(next.timeBankEngine.getPlayerBank(table, user)).toMatchObject({
      remainingSeconds: 7,
      usesRemaining: 1,
    });
    expect(next.timeBankMeta.get(user)).toEqual({
      initialSeconds: 80,
      baseSeconds: 40,
      dbConsumedSeconds: 33,
    });
    next.onTimeBankAccounting({ type: 'TIME_BANK_STOPPED', tableId: table, playerId: user });
    expect(data.rpc).not.toHaveBeenCalled();
  });
  it('holds restart readiness through pending and failed saves, then accepts a durable save', async () => {
    const e = await saved();
    e.pauseForMaintenance(120000);
    await e.presenceSave;
    expect(e.isMaintenanceStateDurable()).toBe(false);
    data.writeError = new Error('write unavailable');
    await e.persistPresenceForRestart('parked');
    expect(e.isMaintenanceStateDurable()).toBe(false);
    data.writeError = null;
    let release!: () => void;
    data.beforeWrite = () =>
      new Promise<void>((r) => {
        release = r;
      });
    const write = e.persistPresenceForRestart('parked');
    await Promise.resolve();
    expect(e.isMaintenanceStateDurable()).toBe(false);
    release();
    await write;
    expect(e.isMaintenanceStateDurable()).toBe(true);
  });
  it('orders a slow announcement before the final bank snapshot', async () => {
    const e = await saved();
    let release!: () => void;
    data.beforeWrite = () =>
      new Promise<void>((r) => {
        release = r;
      });
    const announcement = e.persistPresenceForRestart('announced');
    await Promise.resolve();
    const parked = e.persistPresenceForRestart('parked');
    data.beforeWrite = null;
    release();
    await Promise.all([announcement, parked]);
    expect(data.row.time_bank_snapshot.players[user].remainingSeconds).toBe(7);
    expect(data.row.engine_instance).toMatch(/:parked$/);
  });
  it('checkpoints a table already physically parked when maintenance takes ownership', async () => {
    const e = await saved();
    e.running = true;
    e.pauseAfterHand(300000, { untilResumed: true });
    const parked = e.awaitPauseGate();
    const existingGate = e.handForHandResolve;
    try {
      expect(existingGate).not.toBeNull();
      e.pauseForMaintenance(300000);
      expect(e.isMaintenanceStateDurable()).toBe(false);
      await e.presenceSave;
      expect(e.isMaintenanceStateDurable()).toBe(true);
      expect(data.row.engine_instance).toMatch(/:parked$/);
      expect(data.row.time_bank_snapshot.players[user]).toMatchObject({
        occupancyId: stay,
        remainingSeconds: 7,
        usesRemaining: 1,
        dbConsumedSeconds: 33,
      });
      expect(e.handForHandResolve).toBe(existingGate);
      expect(e.handForHandPaused).toBe(true);
      expect(data.rpc).not.toHaveBeenCalled();
    } finally {
      e.resumeFromMaintenance();
      e.resumeDealing();
      await parked;
    }
  });
  it('does not replace the final bank checkpoint with a repeated maintenance announcement', async () => {
    const e = await saved();
    e.pauseForMaintenance(120000);
    await e.presenceSave;
    await e.persistPresenceForRestart('parked');
    const finalSnapshot = data.row.time_bank_snapshot;
    e.pauseForMaintenance(300000);
    await e.presenceSave;
    expect(e.pauseMaxWaitMs).toBe(300000);
    expect(e.isMaintenanceStateDurable()).toBe(true);
    expect(data.row.time_bank_snapshot).toEqual(finalSnapshot);
    expect(data.row.engine_instance).toMatch(/:parked$/);
  });
  it.each([false, true])(
    'keeps the existing pause fenced while its checkpoint waits (refused=%s)',
    async (refused) => {
      const e = await saved();
      e.running = true;
      e.pauseAfterHand(300000, { untilResumed: true });
      const parked = e.awaitPauseGate();
      const existingGate = e.handForHandResolve;
      let release!: () => void;
      data.beforeWrite = () =>
        new Promise<void>((resolve) => {
          release = resolve;
        });
      if (refused) data.writeError = new Error('checkpoint refused');
      try {
        e.pauseForMaintenance(300000);
        await Promise.resolve();
        expect(e.isMaintenanceStateDurable()).toBe(false);
        expect(e.handForHandResolve).toBe(existingGate);
        release();
        await e.presenceSave;
        expect(e.isMaintenanceStateDurable()).toBe(!refused);
        expect(e.handForHandResolve).toBe(existingGate);
        expect(e.timeBankEngine.getPlayerBank(table, user).remainingSeconds).toBe(7);
        expect(data.rpc).not.toHaveBeenCalled();
      } finally {
        release?.();
        e.resumeFromMaintenance();
        e.resumeDealing();
        await parked;
      }
    }
  );
  it('does not give the old bank to a new occupancy', async () => {
    await saved();
    const next = engine('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    await next.readParkedTimeBanks();
    next.adoptSeatRoster(next.seatedPlayers);
    expect(next.timeBankEngine.getPlayerBank(table, user)).toBeNull();
  });
  it('never overwrites a bank already initialized in this engine', async () => {
    await saved();
    const next = engine();
    next.timeBankEngine.initializePlayer(table, user, { remainingSeconds: 3, usesRemaining: 0 });
    await next.readParkedTimeBanks();
    next.adoptSeatRoster(next.seatedPlayers);
    expect(next.timeBankEngine.getPlayerBank(table, user).remainingSeconds).toBe(3);
  });
  it.each(['legacy', 'later-hand', 'older-write', 'expired', 'invalid'])(
    'rejects %s snapshots',
    async (kind) => {
      await saved();
      let hand = 12,
        now = Date.now();
      if (kind === 'legacy') delete data.row.time_bank_snapshot;
      if (kind === 'later-hand') hand++;
      if (kind === 'older-write') data.row.parked_at = new Date(now + 1).toISOString();
      if (kind === 'expired') now += 21 * 60000;
      if (kind === 'invalid') data.row.time_bank_snapshot.players[user].remainingSeconds = -1;
      expect(await loadTimeBanksFromPark(table, hand, now)).toEqual({});
    }
  );
  it('rejects startup on an unreadable bank instead of granting another allowance', async () => {
    await saved();
    data.readError = new Error('unavailable');
    const next = engine();
    await expect(next.readParkedTimeBanks()).rejects.toThrow('unavailable');
    next.adoptSeatRoster(next.seatedPlayers);
    expect(next.timeBankEngine.getPlayerBank(table, user)).toBeNull();
  });
});
