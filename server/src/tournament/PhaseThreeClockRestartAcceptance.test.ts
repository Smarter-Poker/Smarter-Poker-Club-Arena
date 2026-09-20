/**
 * CA-03-09 runtime composition. Real hand, deadline scheduler, maintenance,
 * table pause methods, manager resume and lifecycle fences. Persistence is a
 * bounded in-memory transport fixture: this does not certify SQL thaw, hand
 * commits, table moves, deployment adoption or the full CA-03-09 control.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HandController } from '../engine/HandController.js';
import { DeadlineScheduler } from '../engine/DeadlineScheduler.js';
import { PreciseActionTimer } from '../engine/PreciseActionTimer.js';
import {
  MaintenanceBreak,
  type MaintenanceBreakStore,
  type PersistedMaintenanceBreak,
} from '../maintenance/MaintenanceBreak.js';
import { isMaintenanceFrozen, setMaintenanceFrozen } from '../maintenance/freezeState.js';
import {
  bindTournamentDataAuthority,
  bindTournamentDataAuthorityMethods,
  currentTournamentDataAuthority,
  runWithTournamentDataAuthority,
} from '../services/supabase/dataActorContext.js';
import type { HandConfig, SeatPlayer } from '../types.js';

let TournamentManagerBase: (typeof import('./TournamentManagerBase.js'))['TournamentManagerBase'];
let ServerTableEngineBase: (typeof import('../engine/ServerTableEngineBase.js'))['ServerTableEngineBase'];
let supabase: (typeof import('../services/supabase.js'))['supabase'];
let leaseNow: () => number;
const T = 'd3090000-0000-4000-8000-000000000001';
const TABLE = 'd3090000-0000-4000-8000-000000000002';
const A = {
  tournamentId: 'd3090000-0000-4000-8000-000000000003',
  leaseGeneration: 'd3090000-0000-4000-8000-000000000004',
};
const B1 = { tournamentId: T, leaseGeneration: 'd3090000-0000-4000-8000-000000000005' };
const B2 = { tournamentId: T, leaseGeneration: 'd3090000-0000-4000-8000-000000000006' };
const at = (time: string) => Date.parse(`2026-09-11T${time}.000Z`);
const managers: any[] = [];
const breaks: MaintenanceBreak[] = [];
const schedulers: DeadlineScheduler[] = [];

beforeAll(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder-key';
  ({ TournamentManagerBase } = await import('./TournamentManagerBase.js'));
  ({ ServerTableEngineBase } = await import('../engine/ServerTableEngineBase.js'));
  ({ supabase } = await import('../services/supabase.js'));
  ({ tournamentLeaseMonotonicNow: leaseNow } = await import('../services/tournamentLease.js'));
}, 60000);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at('12:52:45'));
  setMaintenanceFrozen(false);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // Every unexpected relation or RPC is a test failure, never a network call.
  vi.spyOn(supabase, 'from').mockImplementation((name) => {
    throw new Error(`Unexpected relation ${name}`);
  });
  vi.spyOn(supabase, 'rpc').mockImplementation((name) => {
    throw new Error(`Unexpected RPC ${name}`);
  });
});
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.fenceForServerShutdown();
  for (const owner of breaks.splice(0)) await owner.stop();
  for (const scheduler of schedulers.splice(0)) scheduler.stop();
  setMaintenanceFrozen(false);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function flush() {
  for (let i = 0; i < 15; i++) await Promise.resolve();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class MemoryStore implements MaintenanceBreakStore {
  async loadReleaseBoundary(): Promise<number | null> {
    return null;
  }
  row: PersistedMaintenanceBreak | null = null;
  async load() {
    return this.row && { ...this.row };
  }
  async save(row: PersistedMaintenanceBreak) {
    if (this.row && this.row.ownershipToken !== row.ownershipToken)
      throw new Error('MAINTENANCE_OWNERSHIP_LOST');
    this.row = { ...row };
  }
  async claim(expected: string, replacement: string) {
    if (!this.row || this.row.ownershipToken !== expected) return null;
    this.row = { ...this.row, ownershipToken: replacement };
    return { ...this.row };
  }
  async clear(expected: PersistedMaintenanceBreak) {
    if (JSON.stringify(expected) === JSON.stringify(this.row)) this.row = null;
  }
}
function table(hand: HandController | null = null) {
  const fsm = {
    state: 'running',
    transition(next: string) {
      this.state = next;
      return true;
    },
  };
  // Only construction/network dependencies are replaced. All pause decisions,
  // ownership flags, between-hand checks and gate timers use the real methods.
  return Object.assign(Object.create(ServerTableEngineBase.prototype), {
    tableId: TABLE,
    running: true,
    handController: hand,
    tableFSM: fsm,
    handForHandPaused: false,
    maintenancePaused: false,
    finalTableDealPaused: false,
    terminalCloseoutPaused: false,
    holdBeforeNextHand: false,
    pauseRequiresExplicitResume: false,
    tournamentMovePauseOwners: new Map(),
    claimedTournamentMovePauseOwners: new Set(),
    handForHandResolve: null,
    pausedSinceMs: 0,
    pauseMaxWaitMs: null,
    pauseGateTimer: null,
    armUnclaimedTournamentMovePauseExpiry: vi.fn(),
    notifyBoundaryPauseWaiters: vi.fn(),
    markProgress: vi.fn(),
    persistPresenceForRestart: vi.fn(async () => {}),
    isRunning() {
      return this.running;
    },
    isTournament: () => true,
    setHub: vi.fn(),
    onHandComplete: vi.fn(),
    renewEngineLeaseProof: vi.fn(() => true),
    fenceForEngineLeaseLoss: vi.fn(),
  });
}
function maintenance(store: MemoryStore, engines: Map<string, any>, thaw = async () => {}) {
  const owner = new MaintenanceBreak({
    engines: () => engines,
    isRunning: () => true,
    emit: vi.fn(),
    store,
    thaw: async (request) => {
      await thaw();
      store.row = null; // Synthetic v3 transaction releases this owned row.
      return {
        ...request,
        creditedThroughAt: Date.now(),
        effectiveFrozenSeconds: (Date.now() - request.freezeStartedAt) / 1000,
      };
    },
    now: () => Date.now(),
  });
  breaks.push(owner);
  return owner;
}
function managerFixture(engine: any, authority: typeof B1) {
  class Harness extends TournamentManagerBase {
    advances: unknown[] = [];
    frames: unknown[] = [];
    protected startEliminationChecker() {}
    protected async recalculateEliminatedPrizes() {
      return true;
    }
    protected createManagedTableEngine() {
      return engine;
    }
    protected startManagedTableEngine() {} // dealer I/O is outside this clock proof
    protected wireEliminationWake() {}
    protected async restoreDrawnFirstButtons() {}
    protected async reconcileTournamentEntryWindow() {
      return true;
    }
    requestEliminationSweep() {
      return true;
    }
    protected async broadcast(event: string, payload: unknown) {
      this.frames.push({ event, payload });
      return true;
    }
    protected async advanceBlindLevel() {
      this.advances.push(currentTournamentDataAuthority());
    }
  }
  const manager = new Harness(
    T,
    { registerTableEngine: () => true } as never,
    authority.leaseGeneration,
    leaseNow() + 1200000
  );
  bindTournamentDataAuthorityMethods(authority, manager);
  managers.push(manager);
  return manager as any;
}
function tournamentTransport() {
  const row: any = {
    id: T,
    status: 'RUNNING',
    tournament_type: 'mtt',
    format_contract: 'mtt-v1',
    current_level: 0,
    blind_structure: [{ smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 10 }],
    level_started_at: '2026-09-11T12:45:30.000Z',
    prize_pool_finalized: true,
    on_break: false,
    break_started_at: null,
    break_ends_at: null,
    addon_period_triggered: false,
    game_variant: 'nlh',
  };
  const writes: { patch: Record<string, unknown>; authority: unknown }[] = [];
  vi.mocked(supabase.from).mockImplementation((relation: string) => {
    if (!['tournaments', 'tables'].includes(relation))
      throw new Error(`Unexpected relation ${relation}`);
    let patch: Record<string, unknown> | null = null;
    let returnUpdatedRow = false;
    const result = () => {
      if (patch) {
        if (relation !== 'tournaments') throw new Error('Unexpected table blind rewrite');
        writes.push({ patch: { ...patch }, authority: currentTournamentDataAuthority() });
        Object.assign(row, patch);
        return { data: returnUpdatedRow ? structuredClone(row) : null, error: null };
      }
      return {
        data:
          relation === 'tournaments'
            ? structuredClone(row)
            : [
                {
                  id: TABLE,
                  small_blind: 25,
                  big_blind: 50,
                  ante: 0,
                  stakes: '25/50',
                  first_button_seat: null,
                },
              ],
        error: null,
      };
    };
    const query: any = {
      select() {
        if (patch) returnUpdatedRow = true;
        return query;
      },
      update(value: Record<string, unknown>) {
        patch = value;
        return query;
      },
      eq(column: string, value: string | number) {
        const scopedId = ['id', 'tournament_id'].includes(column) && value === T;
        const activeClock =
          relation === 'tournaments' &&
          patch !== null &&
          ((column === 'status' && value === 'RUNNING' && row.status === value) ||
            (column === 'current_level' && value === row.current_level));
        if (!scopedId && !activeClock) throw new Error('Scope escaped');
        return query;
      },
      in() {
        return query;
      },
      maybeSingle: async () => result(),
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
        return Promise.resolve().then(result).then(resolve, reject);
      },
    };
    return query;
  });
  return { row, writes };
}

describe('CA-03-09 clock, hand and restart composition', () => {
  it('keeps restart closed for a real hand and pending persistence, then preserves the announced end through adoption', async () => {
    const players = [1, 2].map((seat) => ({
      seat,
      user_id: `u${seat}`,
      username: `P${seat}`,
      stack: 1000,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    })) as SeatPlayer[];
    const hand = new HandController(
      {
        tableId: TABLE,
        handNumber: 1,
        gameVariant: 'nlh',
        smallBlind: 25,
        bigBlind: 50,
        rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      } as HandConfig,
      players,
      1
    );
    const complete = vi.fn();
    hand.onEvent((event) => {
      if (event.type === 'HAND_COMPLETE') complete(event);
    });
    hand.start();
    const engine = table(hand);
    const engines = new Map([[TABLE, engine]]);
    const store = new MemoryStore();
    const first = maintenance(store, engines);
    await first.start();
    await vi.advanceTimersByTimeAsync(35000);
    hand.performAction(1, 'call', 0);
    await vi.advanceTimersByTimeAsync(35000);
    hand.performAction(2, 'check', 0);
    await vi.advanceTimersByTimeAsync(35000);
    hand.performAction(2, 'check', 0);
    expect(first.endsAt()).toBe(at('13:00:00'));
    expect(engine.isMaintenancePaused()).toBe(true);
    const scheduler = runWithTournamentDataAuthority(
      A,
      () => new DeadlineScheduler({ now: () => Date.now() })
    );
    schedulers.push(scheduler);
    const clock = runWithTournamentDataAuthority(
      A,
      () => new PreciseActionTimer(undefined, scheduler, () => Date.now())
    );
    const expiredUnder: unknown[] = [];
    clock.startTimerAt(
      TABLE,
      'u1',
      at('12:55:05'),
      bindTournamentDataAuthority(B1, () => {
        expiredUnder.push(currentTournamentDataAuthority());
        hand.performAction(1, 'fold', 0);
      })
    );
    await vi.advanceTimersByTimeAsync(30000);
    expect(first.readyForRestart()).toBe(false);
    expect(complete).not.toHaveBeenCalled();
    expect(clock.getDeadline(TABLE, 'u1')).toBe(at('12:55:05'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(complete).toHaveBeenCalledOnce();
    expect(expiredUnder).toEqual([B1]);
    expect(first.readyForRestart()).toBe(false);
    // The actual engine retains its hand controller until hand persistence
    // completes. This promise models that external acceptance boundary only.
    const persisted = deferred();
    const settle = persisted.promise.then(() => {
      engine.handController = null;
    });
    expect(engine.isBetweenHands()).toBe(false);
    persisted.resolve();
    await settle;
    const parked = engine.awaitPauseGate();
    await flush();
    expect(engine.isParkedBetweenHands()).toBe(true);
    expect(first.readyForRestart()).toBe(true);
    expect((hand as any).state.players.reduce((sum: number, p: any) => sum + p.stack, 0)).toBe(
      2000
    );
    const token = store.row!.ownershipToken;
    await first.stop();
    await vi.advanceTimersByTimeAsync(55000);
    const adopted = maintenance(store, engines);
    await adopted.start();
    expect(store.row!.ownershipToken).not.toBe(token);
    expect(store.row!.breakEndsAt).toBe(at('13:00:00'));
    expect(adopted.endsAt()).toBe(at('13:00:00'));
    engine.resumeDealing(); // another pause owner cannot release maintenance
    expect(engine.isParkedBetweenHands()).toBe(true);
    await vi.advanceTimersByTimeAsync(at('13:00:00') - Date.now());
    await parked;
    expect(engine.isMaintenancePaused()).toBe(false);
    expect(engine.isParkedBetweenHands()).toBe(false);
    expect(store.row).toBeNull();
  });

  it('restores a real manager twice without resetting the level, waits for thaw, and fences the old generation', async () => {
    const { row, writes } = tournamentTransport();
    const firstTable = table();
    const engines = new Map([[TABLE, firstTable]]);
    const store = new MemoryStore();
    const firstBreak = maintenance(store, engines);
    await firstBreak.start();
    const first = managerFixture(firstTable, B1);
    expect(() => runWithTournamentDataAuthority(A, () => first.resume())).toThrow(
      'cannot be rebound'
    );
    await first.resume();
    expect(first.isRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(at('12:55:00') - Date.now());
    await first.pauseForBreak(300000);
    await first.beginBreakCountdown(300000, firstBreak.endsAt());
    const firstPark = firstTable.awaitPauseGate();
    await flush();
    expect(first.savedBlindTimerRemaining).toBe(30000);
    expect(firstBreak.readyForRestart()).toBe(true);
    const anchor = row.level_started_at;
    const deadline = row.break_ends_at;
    const obsolete = vi.fn();
    first.setLifecycleTimeout(obsolete, 180000);
    first.fenceForTournamentLeaseLoss();
    expect(first.renewTournamentLeaseProof(B1.leaseGeneration, leaseNow() + 1200000)).toBe(false);
    await firstBreak.stop();
    await vi.advanceTimersByTimeAsync(120000);
    const secondTable = table();
    engines.set(TABLE, secondTable);
    const thaw = deferred();
    const thawCall = vi.fn(() => thaw.promise);
    const secondBreak = maintenance(store, engines, thawCall);
    await secondBreak.start();
    const second = managerFixture(secondTable, B2);
    expect(() => runWithTournamentDataAuthority(A, () => second.resume())).toThrow(
      'cannot be rebound'
    );
    await second.resume();
    const secondPark = secondTable.awaitPauseGate();
    await flush();
    expect(second.isRunning()).toBe(true);
    expect(second.savedBlindTimerRemaining).toBe(30000);
    expect(second.blindTimer).toBeNull();
    expect(row.level_started_at).toBe(anchor);
    expect(row.break_ends_at).toBe(deadline);
    expect(second.renewTournamentLeaseProof(B1.leaseGeneration, leaseNow() + 1200000)).toBe(false);
    await vi.advanceTimersByTimeAsync(at('13:00:05') - Date.now());
    expect(obsolete).not.toHaveBeenCalled();
    expect(thawCall).toHaveBeenCalledOnce();
    expect(isMaintenanceFrozen()).toBe(true);
    expect(row.on_break).toBe(true);
    expect(second.blindTimer).toBeNull();
    expect(secondTable.isParkedBetweenHands()).toBe(true);
    thaw.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(250);
    await secondPark;
    expect(row.on_break).toBe(false);
    expect(secondTable.isMaintenancePaused()).toBe(false);
    expect(secondTable.isParkedBetweenHands()).toBe(false);
    expect(second.savedBlindTimerRemaining).toBe(0);
    const resumedAt = Date.now();
    expect(row.level_started_at).toBe(new Date(resumedAt - 570000).toISOString());
    expect(second.advances).toEqual([]);
    await vi.advanceTimersByTimeAsync(29999);
    expect(second.advances).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(second.advances).toEqual([B2]);
    expect(first.advances).toEqual([]);
    expect(
      writes.every(
        (write) =>
          JSON.stringify(write.authority) === JSON.stringify(B1) ||
          JSON.stringify(write.authority) === JSON.stringify(B2)
      )
    ).toBe(true);
    expect(
      writes.filter((write) => 'on_break' in write.patch && write.patch.on_break === false)
    ).toEqual([
      {
        patch: {
          on_break: false,
          break_ends_at: null,
          level_started_at: row.level_started_at,
        },
        authority: B2,
      },
    ]);
    // The retired dealer's held gate is released only for local test teardown.
    firstTable.resumeFromMaintenance();
    firstTable.resumeDealing();
    await firstPark;
  });
});
