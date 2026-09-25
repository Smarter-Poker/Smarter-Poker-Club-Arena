import { beforeEach, describe, expect, it, vi } from 'vitest';
const data = vi.hoisted(() => ({
  row: null as any,
  rpc: vi.fn(),
  historyRead: vi.fn(),
  readError: null as unknown,
  writeError: null as unknown,
  beforeWrite: null as (() => Promise<void>) | null,
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    rpc: data.rpc,
    from: (tableName: string) =>
      tableName === 'hand_history'
        ? {
            select: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: data.historyRead,
                  }),
                }),
              }),
            }),
          }
        : {
            upsert: async (row: unknown) => {
              await data.beforeWrite?.();
              if (!data.writeError) data.row = row;
              return { error: data.writeError };
            },
            select: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: data.row, error: data.readError }) }),
            }),
          },
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/supabase.js', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../services/supabase.js')),
  loadTable: async () => ({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    tournament_id: null,
    small_blind: 1,
    big_blind: 2,
    max_players: 6,
    game_variant: 'nlh',
  }),
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { ServerTableEngine } from './ServerTableEngine.js';
import { GameServer } from '../GameServer.js';
import { TournamentRetirementCustody } from '../services/TournamentRetirementCustody.js';
import {
  replaceOwnedTableEngine,
  unregisterOwnedTournamentTableEngine,
} from '../tournament/TournamentManagerOwnership.js';
import { loadPresenceFromPark, loadTimeBanksFromPark } from '../services/supabase/snapshots.js';
const table = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const user = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const stay = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function engine(occupancy = stay) {
  const e = new ServerTableEngine(table) as any;
  e.lifecycleCanMutate = () => true;
  e.tableInfo = { id: table, tournament_id: null };
  e.handCount = 12;
  e.parkWriteRetryMs = 0;
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
  data.historyRead.mockReset().mockResolvedValue({ data: { hand_number: 12 }, error: null });
});
describe('a marked parked bank survives only its own unchanged stay and hand boundary', () => {
  function freshStartup() {
    const next = new ServerTableEngine(table) as any;
    expect(next.handCount).toBe(0);
    // Keep the real start -> history seed -> bank read -> native park chain.
    // No play or process-wide lease/timer is needed to reach its first pause.
    next.lifecycleCanMutate = () => next.running;
    next.claimProcessOwnership = () => true;
    next.armEngineLeaseExpiryTimer = () => {};
    next.restoreButtonFromHistory = async () => {};
    next.checkCrashRecovery = async () => false;
    next.awaitPauseGate = async () => {
      next.running = false;
    };
    next.killForRestart = vi.fn(() => {
      next.running = false;
    });
    next.pauseForMaintenance(300000);
    return next;
  }

  it.each([0, 48])(
    'restores the real startup hand identity after a %i-hour outage before re-parking a saved bank',
    async (hours) => {
      await saved();
      const parkedAt = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      data.row.parked_at = parkedAt;
      data.row.time_bank_snapshot.parkedAt = parkedAt;
      const previousBank = structuredClone(data.row.time_bank_snapshot.players[user]);
      const next = freshStartup();
      await next.start();
      expect(next.killForRestart).not.toHaveBeenCalled();
      expect(next.handCount).toBe(12);
      expect(data.row.time_bank_snapshot.handNumber).toBe(12);
      expect(data.row.time_bank_snapshot.players[user]).toEqual(previousBank);
      // Continue the same generation after the harness stopped at its pause.
      next.running = true;
      next.adoptSeatRoster([{ user_id: user, occupancy_id: stay, seat_number: 2, stack: 25 }]);
      next.running = false;
      expect(next.timeBankEngine.getPlayerBank(table, user)).toMatchObject({
        remainingSeconds: 7,
        usesRemaining: 1,
      });
      expect(next.timeBankMeta.get(user)).toEqual({
        initialSeconds: 80,
        baseSeconds: 40,
        dbConsumedSeconds: 33,
      });
      expect(data.rpc).not.toHaveBeenCalled();
    }
  );

  it.each([true, undefined])(
    'preserves unlimited-use metadata through repeated startup and roster checkpoints (%s)',
    async (unlimitedActivations) => {
      const old = engine();
      old.timeBankEngine.initializePlayer(table, user, {
        remainingSeconds: 0,
        usesRemaining: 0,
        unlimitedActivations,
      });
      old.timeBankMeta.set(user, {
        initialSeconds: 80,
        baseSeconds: 40,
        dbConsumedSeconds: 40,
        ...(unlimitedActivations ? { unlimitedActivations: true } : {}),
      });
      await old.persistPresenceForRestart('parked');
      const originalBank = structuredClone(data.row.time_bank_snapshot.players[user]);

      for (let generation = 0; generation < 2; generation++) {
        const next = freshStartup();
        await next.start();
        expect(next.killForRestart).not.toHaveBeenCalled();
        next.running = true;
        next.adoptSeatRoster([{ user_id: user, occupancy_id: stay, seat_number: 2, stack: 25 }]);
        expect(next.timeBankEngine.isUnlimited(table, user)).toBe(unlimitedActivations === true);
        await next.persistPresenceForRestart('parked');
        next.running = false;
        expect(data.row.time_bank_snapshot.handNumber).toBe(12);
        expect(data.row.time_bank_snapshot.players[user]).toEqual(originalBank);
        expect(next.timeBankMeta.get(user)).toEqual({
          initialSeconds: 80,
          baseSeconds: 40,
          dbConsumedSeconds: 40,
          ...(unlimitedActivations ? { unlimitedActivations: true } : {}),
        });
      }
      expect(data.rpc).not.toHaveBeenCalled();
    }
  );

  it('consumes the completed mixed transfer bank through native startup and re-park', async () => {
    const parkedAt = new Date().toISOString();
    const transferred = {
      occupancyId: stay,
      remainingSeconds: 47,
      usesRemaining: 4,
      initialSeconds: 60,
      baseSeconds: 30,
      dbConsumedSeconds: 13,
      unlimitedActivations: true,
    };
    data.row = {
      table_id: table,
      disconnect_states: {},
      parked_at: parkedAt,
      engine_instance: 'f06_mixed_custody',
      time_bank_snapshot: {
        version: 1,
        parkedAt,
        handNumber: 12,
        players: { [user]: transferred },
      },
    };
    const next = freshStartup();
    await next.start();
    next.running = true;
    next.adoptSeatRoster([{ user_id: user, occupancy_id: stay, seat_number: 2, stack: 25 }]);
    expect(next.timeBankEngine.getPlayerBank(table, user)).toMatchObject({
      remainingSeconds: 47,
      usesRemaining: 4,
    });
    expect(next.timeBankEngine.isUnlimited(table, user)).toBe(true);
    await next.persistPresenceForRestart('parked');
    next.running = false;
    expect(data.row.time_bank_snapshot.players[user]).toEqual(transferred);
    expect(data.rpc).not.toHaveBeenCalled();
  });

  it('retains the native disconnect expiry while restoring a transferred bank', async () => {
    const parkedAt = new Date(Date.now() - 21 * 60 * 1000).toISOString();
    data.row = {
      table_id: table,
      disconnect_states: { [user]: { state: 'DISCONNECTED', sinceMs: 1, graceDeadlineMs: 2 } },
      parked_at: parkedAt,
      engine_instance: 'f06_mixed_custody',
      time_bank_snapshot: {
        version: 1,
        parkedAt,
        handNumber: 12,
        players: {
          [user]: {
            occupancyId: stay,
            remainingSeconds: 47,
            usesRemaining: 4,
            initialSeconds: 60,
            baseSeconds: 30,
            dbConsumedSeconds: 13,
            unlimitedActivations: true,
          },
        },
      },
    };
    expect(await loadPresenceFromPark(table)).toBeNull();
    expect((await loadTimeBanksFromPark(table, 12))[user]).toMatchObject({
      remainingSeconds: 47,
      unlimitedActivations: true,
    });
    expect(data.rpc).not.toHaveBeenCalled();
  });

  it('has no initialized custody to restore from an unrelated empty historic snapshot', async () => {
    const parkedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    data.row = {
      table_id: table,
      disconnect_states: {},
      parked_at: parkedAt,
      time_bank_snapshot: { version: 1, parkedAt, handNumber: 0, players: {} },
    };
    const next = freshStartup();
    await next.start();
    expect(next.timeBankMeta.size).toBe(0);
    expect(next.parkedTimeBanks).toEqual({});
    expect(next.timeBankEngine.hasPlayerBanksForTable(table)).toBe(false);
    expect(next.captureParkedTimeBanks()).toEqual({});
    expect(data.rpc).not.toHaveBeenCalled();
  });

  it.each(['refused', 'thrown', 'invalid'])(
    'refuses startup before overwriting a saved bank when hand history is %s',
    async (outcome) => {
      await saved();
      const checkpoint = structuredClone(data.row);
      if (outcome === 'thrown')
        data.historyRead.mockRejectedValue(new Error('history unavailable'));
      else
        data.historyRead.mockResolvedValue({
          data: outcome === 'invalid' ? { hand_number: -1 } : null,
          error: outcome === 'refused' ? new Error('history unavailable') : null,
        });
      const next = freshStartup();
      await expect(next.start()).rejects.toThrow(
        /history unavailable|Invalid persisted hand number/
      );
      expect(next.killForRestart).toHaveBeenCalledTimes(1);
      expect(data.row).toEqual(checkpoint);
      expect(data.rpc).not.toHaveBeenCalled();
    }
  );

  it('starts a genuinely new table at zero when history is empty', async () => {
    data.historyRead.mockResolvedValue({ data: null, error: null });
    const next = freshStartup();
    await next.start();
    expect(next.killForRestart).not.toHaveBeenCalled();
    expect(next.handCount).toBe(0);
    expect(data.row).toBeNull();
    expect(data.rpc).not.toHaveBeenCalled();
  });

  it('keeps the completed boundary when maintenance interrupts hand-number allocation', async () => {
    const old = engine();
    old.running = true;
    old.seatedPlayers.push({
      user_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      occupancy_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      seat_number: 3,
      stack: 25,
    });
    old.timeBankEngine.initializePlayer(table, user, { remainingSeconds: 7, usesRemaining: 1 });
    old.timeBankMeta.set(user, { initialSeconds: 80, baseSeconds: 40, dbConsumedSeconds: 33 });
    old.takePreparedHandNumber = () => null;
    old.allocateGlobalHandNumber = async () => 13;
    old.reserveF06Hand = async () => {
      old.maintenancePaused = true;
    };
    await old.dealHand([...old.seatedPlayers]);
    expect(old.handController).toBeNull();
    await old.persistPresenceForRestart('parked');
    const next = freshStartup();
    await next.start();
    expect(data.row.time_bank_snapshot.handNumber).toBe(12);
    expect(next.parkedTimeBanks[user]).toMatchObject({ remainingSeconds: 7, usesRemaining: 1 });
    expect(data.row.time_bank_snapshot.players[user]).toMatchObject({
      remainingSeconds: 7,
      usesRemaining: 1,
      dbConsumedSeconds: 33,
    });
    expect(data.rpc).not.toHaveBeenCalled();
  });
  it('never bills an active allocation twice across its parked snapshot and restart', async () => {
    data.rpc.mockResolvedValue({ data: { success: true, shortfall_seconds: 0 }, error: null });
    const old = engine();
    old.timeBankEngine.initializePlayer(table, user, { remainingSeconds: 30, usesRemaining: 2 });
    old.timeBankMeta.set(user, { initialSeconds: 80, baseSeconds: 40, dbConsumedSeconds: 10 });
    old.timeBankEngine.configure(table, { secondsPerUse: 20 });
    expect(old.timeBankEngine.activate(table, user, () => undefined)).toBe(true);
    try {
      await old.persistPresenceForRestart('parked');
      old.timeBankEngine.playerActed(table, user);
      const next = engine();
      await next.readParkedTimeBanks();
      next.adoptSeatRoster(next.seatedPlayers);
      next.onTimeBankAccounting({ type: 'TIME_BANK_STOPPED', tableId: table, playerId: user });
      expect(data.rpc.mock.calls.filter(([name]) => name === 'fn_consume_time_bank')).toEqual([
        ['fn_consume_time_bank', { p_user_id: user, p_seconds: 20 }],
      ]);
      expect(next.timeBankMeta.get(user).dbConsumedSeconds).toBe(30);
      expect(old.timeBankEngine.getPlayerBank(table, user).isActive).toBe(false);
    } finally {
      old.timeBankEngine.dispose(table);
    }
  });
  it('does not certify an initialized bank that cannot be restored', async () => {
    const e = engine();
    e.timeBankEngine.initializePlayer(table, user, { remainingSeconds: 30, usesRemaining: 2 });
    e.pauseForMaintenance(120000);
    await e.presenceSave;
    await e.persistPresenceForRestart('parked');
    expect(e.isMaintenanceStateDurable()).toBe(false);
    expect(data.row).toBeNull();
  });
  it.each(['pending', 'refused', 'thrown', 'missing-receipt', 'stale-break'])(
    'requires the active-bank debit acknowledgment for the same break (%s)',
    async (outcome) => {
      let acknowledge!: (value: unknown) => void;
      let reject!: (error: Error) => void;
      data.rpc.mockReturnValue(
        new Promise((resolve, fail) => {
          acknowledge = resolve;
          reject = fail;
        })
      );
      const e = engine();
      e.timeBankEngine.initializePlayer(table, user, { remainingSeconds: 30, usesRemaining: 2 });
      e.timeBankMeta.set(user, { initialSeconds: 80, baseSeconds: 40, dbConsumedSeconds: 10 });
      e.timeBankEngine.configure(table, { secondsPerUse: 20 });
      expect(e.timeBankEngine.activate(table, user, () => undefined)).toBe(true);
      e.pauseForMaintenance(120000);
      await e.presenceSave;
      const parked = e.persistPresenceForRestart('parked');
      await Promise.resolve();
      expect(e.isMaintenanceStateDurable()).toBe(false);
      expect(data.row).toBeNull();
      expect(data.rpc).toHaveBeenCalledTimes(1);
      e.onTimeBankAccounting({ type: 'TIME_BANK_STOPPED', tableId: table, playerId: user });
      expect(data.rpc).toHaveBeenCalledTimes(1);
      if (outcome === 'stale-break') {
        e.resumeFromMaintenance();
        e.pauseForMaintenance(120000);
      }
      if (outcome === 'thrown') reject(new Error('acknowledgment lost'));
      else
        acknowledge({
          data: outcome === 'missing-receipt' ? null : { success: outcome !== 'refused' },
          error: null,
        });
      await parked;
      await e.presenceSave;
      expect(e.isMaintenanceStateDurable()).toBe(outcome === 'pending');
      if (outcome === 'pending') {
        expect(data.row.time_bank_snapshot.players[user]).toMatchObject({
          remainingSeconds: 10,
          dbConsumedSeconds: 30,
        });
      } else expect(data.row).toBeNull();
      if (outcome === 'stale-break') {
        await e.persistPresenceForRestart('parked');
        expect(e.isMaintenanceStateDurable()).toBe(true);
      }
      expect(data.rpc).toHaveBeenCalledTimes(1);
      e.timeBankEngine.dispose(table);
    }
  );
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
  it('preserves a zero-balance Lifetime bank across two native restart cycles', async () => {
    const first = engine();
    first.timeBankEngine.initializePlayer(table, user, {
      remainingSeconds: 0,
      usesRemaining: 0,
      unlimitedActivations: true,
    });
    first.timeBankMeta.set(user, {
      initialSeconds: 40,
      baseSeconds: 40,
      dbConsumedSeconds: 0,
      unlimitedActivations: true,
    });

    await first.persistPresenceForRestart('parked');
    expect(data.row.time_bank_snapshot.players[user].unlimitedActivations).toBe(true);

    const second = engine();
    await second.readParkedTimeBanks();
    second.adoptSeatRoster(second.seatedPlayers);
    expect(second.timeBankEngine.isUnlimited(table, user)).toBe(true);
    expect(second.timeBankEngine.hasTimeBank(table, user)).toBe(true);
    expect(second.timeBankMeta.get(user).unlimitedActivations).toBe(true);

    await second.persistPresenceForRestart('parked');
    expect(data.row.time_bank_snapshot.players[user].unlimitedActivations).toBe(true);

    const third = engine();
    await third.readParkedTimeBanks();
    third.adoptSeatRoster(third.seatedPlayers);
    expect(third.timeBankEngine.isUnlimited(table, user)).toBe(true);
    expect(third.timeBankEngine.hasTimeBank(table, user)).toBe(true);
    expect(third.timeBankMeta.get(user).unlimitedActivations).toBe(true);
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
        data.beforeWrite = null;
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
  it.each(['cash', 'mtt', 'spin', 'sng'])(
    'retains an unchanged %s bank after a prolonged outage without granting or charging again',
    async (format) => {
      await saved();
      const original = structuredClone(data.row.time_bank_snapshot.players[user]);
      const parkedAt = new Date(Date.now() - 48 * 60 * 60000).toISOString();
      data.row.parked_at = parkedAt;
      data.row.time_bank_snapshot.parkedAt = parkedAt;
      const next = engine();
      next.tableInfo = {
        id: table,
        tournament_id: format === 'cash' ? null : 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        tournament_type: format,
      };
      await next.readParkedTimeBanks();
      next.adoptSeatRoster(next.seatedPlayers);
      expect(next.timeBankEngine.getPlayerBank(table, user)).toMatchObject({
        remainingSeconds: original.remainingSeconds,
        usesRemaining: original.usesRemaining,
      });
      await next.persistPresenceForRestart('parked');
      expect(data.row.time_bank_snapshot.players[user]).toEqual(original);
      expect(data.rpc).not.toHaveBeenCalled();
    }
  );
  it.each(['later-hand', 'new-occupancy'])(
    'rejects an old bank after %s even when it was saved during a long outage',
    async (change) => {
      await saved();
      const parkedAt = new Date(Date.now() - 48 * 60 * 60000).toISOString();
      data.row.parked_at = parkedAt;
      data.row.time_bank_snapshot.parkedAt = parkedAt;
      const next = engine(
        change === 'new-occupancy' ? 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' : stay
      );
      if (change === 'later-hand') next.handCount++;
      await next.readParkedTimeBanks();
      next.adoptSeatRoster(next.seatedPlayers);
      expect(next.timeBankEngine.getPlayerBank(table, user)).toBeNull();
      expect(data.rpc).not.toHaveBeenCalled();
    }
  );
  it.each(['legacy', 'later-hand', 'older-write', 'future', 'invalid', 'invalid-unlimited'])(
    'rejects %s snapshots',
    async (kind) => {
      await saved();
      let hand = 12,
        now = Date.now();
      if (kind === 'legacy') delete data.row.time_bank_snapshot;
      if (kind === 'later-hand') hand++;
      if (kind === 'older-write') data.row.parked_at = new Date(now + 1).toISOString();
      if (kind === 'future') now -= 60000;
      if (kind === 'invalid') data.row.time_bank_snapshot.players[user].remainingSeconds = -1;
      if (kind === 'invalid-unlimited')
        data.row.time_bank_snapshot.players[user].unlimitedActivations = 'true';
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

describe('stopped tournament bank custody', () => {
  function stoppedCandidate() {
    const e = engine();
    e.tableInfo.tournament_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    e.flushSnapshot = vi.fn().mockResolvedValue(undefined);
    e.timeBankEngine.initializePlayer(table, user, {
      remainingSeconds: 7,
      usesRemaining: 1,
      unlimitedActivations: true,
    });
    e.timeBankMeta.set(user, {
      initialSeconds: 80,
      baseSeconds: 40,
      dbConsumedSeconds: 33,
      unlimitedActivations: true,
    });
    return e;
  }

  it('retains actual stopped banks and transfers them only inside the replacement identity CAS', async () => {
    const original = stoppedCandidate();
    original.disconnectEngine.restoreFsmStates(table, {
      [user]: { state: 'SAT_OUT', sinceMs: Date.now() - 30000, graceDeadlineMs: null },
    });
    const capturedPresence = original.disconnectEngine.getFsmStatesForTable(table);
    const replacement = engine();
    replacement.tableInfo.tournament_id = original.tableInfo.tournament_id;
    const originals = new Map([[table, original]]);
    const owned = new Set([table]);
    await original.stop();
    expect(original.captureParkedTimeBanks()[user]).toEqual({
      occupancyId: stay,
      remainingSeconds: 7,
      usesRemaining: 1,
      initialSeconds: 80,
      baseSeconds: 40,
      dbConsumedSeconds: 33,
      unlimitedActivations: true,
    });
    expect(original.hasUnretiredStoppedTimeBankCustody()).toBe(true);
    expect(unregisterOwnedTournamentTableEngine(originals, owned, table, original)).toBe(false);
    expect(originals.get(table)).toBe(original);
    const owner = Object.assign(Object.create(GameServer.prototype), {
      running: true,
      tableEngines: originals,
      tournamentOwnedTables: owned,
      tournamentRetirementCustody: new TournamentRetirementCustody(),
      maintenanceBreak: { adopt: vi.fn() },
    });
    expect(await owner.replaceTableEngine(table, original, replacement)).toBe(true);
    expect(originals.get(table)).toBe(replacement);
    await replacement.readParkedTimeBanks();
    replacement.adoptSeatRoster([{ user_id: user, occupancy_id: stay, seat_number: 2, stack: 25 }]);
    expect(replacement.timeBankEngine.getPlayerBank(table, user)).toMatchObject({
      remainingSeconds: 7,
      usesRemaining: 1,
      unlimitedActivations: true,
    });
    expect(replacement.disconnectEngine.getFsmStatesForTable(table)).toEqual(capturedPresence);
    await replacement.stop();
    expect(replacement.hasUnretiredStoppedTimeBankCustody()).toBe(true);
  });

  it('retains actual inherited presence through re-park and another stop before the first roster', async () => {
    const original = stoppedCandidate();
    original.disconnectEngine.restoreFsmStates(table, {
      [user]: { state: 'SAT_OUT', sinceMs: Date.now() - 30000, graceDeadlineMs: null },
    });
    const states = original.disconnectEngine.getFsmStatesForTable(table);
    await original.stop();
    const next = engine();
    next.tableInfo.tournament_id = original.tableInfo.tournament_id;
    next.seatedPlayers = [];
    expect(next.adoptStoppedTimeBankCustody(original)).toBe(true);
    await next.persistPresenceForRestart('parked');
    expect(data.row.disconnect_states).toEqual(states);
    expect(data.row.time_bank_snapshot.players[user].remainingSeconds).toBe(7);
    await next.stop();
    const final = engine();
    final.tableInfo.tournament_id = original.tableInfo.tournament_id;
    expect(final.adoptStoppedTimeBankCustody(next)).toBe(true);
    final.adoptSeatRoster([{ user_id: user, occupancy_id: stay, seat_number: 2, stack: 25 }]);
    expect(final.disconnectEngine.getFsmStatesForTable(table)).toEqual(states);
    expect(final.timeBankEngine.getPlayerBank(table, user)?.remainingSeconds).toBe(7);
    await final.stop();
  });

  it('does not apply inherited presence to a replacement occupancy', async () => {
    const original = stoppedCandidate();
    original.disconnectEngine.restoreFsmStates(table, {
      [user]: { state: 'SAT_OUT', sinceMs: Date.now() - 30000, graceDeadlineMs: null },
    });
    await original.stop();
    const next = engine();
    next.tableInfo.tournament_id = original.tableInfo.tournament_id;
    expect(next.adoptStoppedTimeBankCustody(original)).toBe(true);
    next.adoptSeatRoster([{ user_id: user, occupancy_id: 'new-stay', seat_number: 2, stack: 25 }]);
    expect(next.disconnectEngine.getFsmStatesForTable(table)).toEqual({});
    expect(next.timeBankEngine.getPlayerBank(table, user)).toBeNull();
    await next.stop();
  });

  it('joins a bank debit before capture and retains unknown outcomes without replay', async () => {
    const original = stoppedCandidate();
    original.timeBankEngine.initializePlayer(table, user, {
      remainingSeconds: 30,
      usesRemaining: 2,
      unlimitedActivations: false,
    });
    original.timeBankMeta.set(user, { initialSeconds: 80, baseSeconds: 40, dbConsumedSeconds: 10 });
    original.timeBankEngine.configure(table, { secondsPerUse: 20 });
    let finish!: (value: any) => void;
    data.rpc.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    expect(original.timeBankEngine.activate(table, user, () => undefined)).toBe(true);
    const stopping = original.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(original.timeBankEngine.getPlayerBank(table, user)).not.toBeNull();
    expect(data.rpc).toHaveBeenCalledOnce();
    finish({ data: null, error: new Error('response lost') });
    await stopping;
    expect(original.captureParkedTimeBanks()[user]).toMatchObject({
      remainingSeconds: 10,
      usesRemaining: 1,
    });
    expect(original.hasUnretiredStoppedTimeBankCustody()).toBe(true);
    const next = engine();
    next.tableInfo.tournament_id = original.tableInfo.tournament_id;
    expect(next.adoptStoppedTimeBankCustody(original)).toBe(false);
    expect(original.retireStoppedTimeBanksForClosedSession()).toBe(false);
    await original.stop();
    expect(data.rpc).toHaveBeenCalledOnce();
  });

  it('refuses incomplete capture without disposing the original value', async () => {
    const original = stoppedCandidate();
    original.timeBankMeta.delete(user);
    await expect(original.stop()).rejects.toThrow('teardown failed');
    expect(original.timeBankEngine.getPlayerBank(table, user)).toMatchObject({
      remainingSeconds: 7,
    });
    expect(original.hasUnretiredStoppedTimeBankCustody()).toBe(true);
  });

  it('cannot transfer banks after another generation wins the map race', async () => {
    const original = stoppedCandidate();
    let finish!: () => void;
    original.flushSnapshot = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const next = engine();
    const winner = engine();
    next.tableInfo.tournament_id = original.tableInfo.tournament_id;
    const originals = new Map([[table, original]]);
    const adopting = vi.fn(() => next.adoptStoppedTimeBankCustody(original));
    const replacing = replaceOwnedTableEngine(
      originals,
      new Set([table]),
      table,
      original,
      next,
      () => true,
      adopting
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    originals.set(table, winner);
    finish();
    expect(await replacing).toBe(false);
    expect(adopting).not.toHaveBeenCalled();
    expect(original.hasUnretiredStoppedTimeBankCustody()).toBe(true);
    expect(next.captureParkedTimeBanks()).toEqual({});
  });

  it.each(['refused', 'lost_reply'])(
    'retains an unacknowledged native park (%s)',
    async (outcome) => {
      const original = stoppedCandidate();
      data.writeError = new Error(outcome);
      if (outcome === 'lost_reply')
        data.beforeWrite = async () => {
          data.row = {
            time_bank_snapshot: {
              version: 1,
              handNumber: 12,
              players: structuredClone(original.captureParkedTimeBanks()),
            },
          };
        };
      await original.persistPresenceForRestart('parked');
      await original.stop();
      expect(original.hasUnretiredStoppedTimeBankCustody()).toBe(true);
      expect(original.isMaintenanceStateDurable()).toBe(false);
    }
  );

  it('allows a matching acknowledged park but never an older bank value', async () => {
    const original = stoppedCandidate();
    await original.persistPresenceForRestart('parked');
    await original.stop();
    expect(original.hasUnretiredStoppedTimeBankCustody()).toBe(false);
    const changed = stoppedCandidate();
    await changed.persistPresenceForRestart('parked');
    changed.timeBankEngine.getPlayerBank(table, user).remainingSeconds = 6;
    await changed.stop();
    expect(changed.hasUnretiredStoppedTimeBankCustody()).toBe(true);
  });

  it('ends a fully captured session only through the existing confirmed-terminal cleanup', async () => {
    const original = stoppedCandidate();
    await original.stop();
    const owner = Object.assign(Object.create(GameServer.prototype), {
      tableEngines: new Map([[table, original]]),
      tournamentOwnedTables: new Set([table]),
    });
    expect(owner.unregisterTournamentTableEngine(table, original)).toBe(false);
    expect(owner.unregisterTableEngine(table, original)).toBe(true);
    expect(owner.tableEngines.has(table)).toBe(false);
  });
});
