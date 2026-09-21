/**
 * A STALE BREAK MUST HEAL ON ADOPTION (2026-09-20).
 *
 * Production shape, measured 2026-09-20: 39 RUNNING tournaments carry
 * `on_break = true` with `break_ends_at = 2026-09-18 22:00:00+00`, 46 hours
 * past. The engine restarted at 2026-09-18 23:12 and re-adopted every one of
 * them — AFTER that deadline — and the rows are still on_break.
 *
 * resumeLifecycle's expired-break branch exists for exactly this: a
 * `break_ends_at` in the past takes the `else` arm and calls resumeFromBreak()
 * to clear the durable flags and put the dealers back to work. This pins that
 * a brand-new manager adopting such a row converges BOTH halves of the state:
 * the durable row (on_break/break_ends_at) and the in-memory hold that
 * prepareManagedTableEngineForPlay put on every replacement engine with
 * `untilResumed: true`. Clearing only the row would advertise a live
 * tournament whose tables deal nothing.
 *
 * Persistence is the same bounded in-memory transport the CA-03-09 restart
 * acceptance uses; the pause/resume decisions are the real engine methods.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';
import { bindTournamentDataAuthorityMethods } from '../services/supabase/dataActorContext.js';

let TournamentManagerBase: (typeof import('./TournamentManagerBase.js'))['TournamentManagerBase'];
let ServerTableEngineBase: (typeof import('../engine/ServerTableEngineBase.js'))['ServerTableEngineBase'];
let supabase: (typeof import('../services/supabase.js'))['supabase'];
let leaseNow: () => number;

const T = 'd3200000-0000-4000-8000-000000000001';
const TABLE = 'd3200000-0000-4000-8000-000000000002';
const AUTH = { tournamentId: T, leaseGeneration: 'd3200000-0000-4000-8000-000000000003' };

/** The measured incident clock. */
const BREAK_STARTED_AT = '2026-09-18T21:55:00.010Z';
const BREAK_ENDS_AT = '2026-09-18T22:00:00.000Z';
const LEVEL_STARTED_AT = '2026-09-18T21:46:23.437Z';
const ADOPTED_AT = Date.parse('2026-09-18T23:12:30.000Z');

const managers: any[] = [];

beforeAll(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder-key';
  ({ TournamentManagerBase } = await import('./TournamentManagerBase.js'));
  ({ ServerTableEngineBase } = await import('../engine/ServerTableEngineBase.js'));
  ({ supabase } = await import('../services/supabase.js'));
  ({ tournamentLeaseMonotonicNow: leaseNow } = await import('../services/tournamentLease.js'));
}, 60000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(ADOPTED_AT);
  setMaintenanceFrozen(false);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(supabase, 'from').mockImplementation((name) => {
    throw new Error(`Unexpected relation ${name}`);
  });
  vi.spyOn(supabase, 'rpc').mockImplementation((name) => {
    throw new Error(`Unexpected RPC ${name}`);
  });
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.fenceForServerShutdown();
  setMaintenanceFrozen(false);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flush() {
  for (let i = 0; i < 15; i++) await Promise.resolve();
}

/** Only construction/network dependencies are replaced; pause state is real. */
function table() {
  const fsm = {
    state: 'running',
    transition(next: string) {
      this.state = next;
      return true;
    },
  };
  return Object.assign(Object.create(ServerTableEngineBase.prototype), {
    tableId: TABLE,
    running: true,
    handController: null,
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

function managerFixture(engine: any) {
  class Harness extends TournamentManagerBase {
    frames: { event: string; payload: unknown }[] = [];
    protected startEliminationChecker() {}
    protected async recalculateEliminatedPrizes() {
      return true;
    }
    protected createManagedTableEngine() {
      return engine;
    }
    protected startManagedTableEngine() {} // dealer I/O is outside this proof
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
    protected async advanceBlindLevel() {}
  }
  const manager = new Harness(
    T,
    { registerTableEngine: () => true } as never,
    AUTH.leaseGeneration,
    leaseNow() + 1200000
  );
  bindTournamentDataAuthorityMethods(AUTH, manager);
  managers.push(manager);
  return manager as any;
}

/** The measured row: RUNNING, on_break, its countdown 72 minutes expired. */
function staleBreakTransport(opts: { beforeFirstUpdate?: (row: any) => void } = {}) {
  const row: any = {
    id: T,
    status: 'RUNNING',
    tournament_type: 'mtt',
    format_contract: 'mtt-v1',
    club_id: null,
    current_level: 9,
    blind_structure: [
      { smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 10 },
      { smallBlind: 50, bigBlind: 100, ante: 0, durationMinutes: 10 },
      { smallBlind: 75, bigBlind: 150, ante: 0, durationMinutes: 10 },
      { smallBlind: 100, bigBlind: 200, ante: 25, durationMinutes: 10 },
      { smallBlind: 150, bigBlind: 300, ante: 25, durationMinutes: 10 },
      { smallBlind: 200, bigBlind: 400, ante: 50, durationMinutes: 10 },
      { smallBlind: 300, bigBlind: 600, ante: 75, durationMinutes: 10 },
      { smallBlind: 400, bigBlind: 800, ante: 100, durationMinutes: 10 },
      { smallBlind: 500, bigBlind: 1000, ante: 100, durationMinutes: 10 },
      { smallBlind: 700, bigBlind: 1400, ante: 150, durationMinutes: 10 },
    ],
    started_at: '2026-09-18T20:00:00.000Z',
    level_started_at: LEVEL_STARTED_AT,
    prize_pool_finalized: true,
    on_break: true,
    break_started_at: BREAK_STARTED_AT,
    break_ends_at: BREAK_ENDS_AT,
    addon_period_triggered: false,
    game_variant: 'nlh',
  };
  const writes: Record<string, unknown>[] = [];
  const attempts: Record<string, unknown>[] = [];
  let firstUpdateSeen = false;
  vi.mocked(supabase.from).mockImplementation((relation: string) => {
    if (!['tournaments', 'tables'].includes(relation))
      throw new Error(`Unexpected relation ${relation}`);
    let patch: Record<string, unknown> | null = null;
    let returnUpdatedRow = false;
    let scopeMatches = true;
    const result = () => {
      if (patch) {
        if (relation !== 'tournaments') throw new Error('Unexpected table blind rewrite');
        attempts.push({ ...patch });
        // A filtered UPDATE that matches no row writes nothing and returns null,
        // exactly as PostgREST does.
        if (!scopeMatches) return { data: null, error: null };
        writes.push({ ...patch });
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
                  small_blind: 700,
                  big_blind: 1400,
                  ante: 150,
                  stakes: '700/1400',
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
        if (relation === 'tournaments' && !firstUpdateSeen) {
          firstUpdateSeen = true;
          opts.beforeFirstUpdate?.(row);
        }
        return query;
      },
      eq(column: string, value: string | number) {
        if (['id', 'tournament_id'].includes(column)) {
          if (value !== T) scopeMatches = false;
          return query;
        }
        if (relation === 'tournaments' && patch !== null) {
          if ((row as any)[column] !== value) scopeMatches = false;
          return query;
        }
        throw new Error(`Scope escaped on ${column}`);
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
  return { row, writes, attempts };
}

describe('adoption of a tournament whose break expired while the engine was down', () => {
  it('clears the durable break and puts its tables back to work', async () => {
    const { row, writes } = staleBreakTransport();
    const engine = table();
    const manager = managerFixture(engine);

    await manager.resume();
    await flush();

    expect(manager.isRunning()).toBe(true);
    // The durable half.
    expect(row.on_break).toBe(false);
    expect(row.break_ends_at).toBeNull();
    expect(
      writes.filter((patch) => 'on_break' in patch && patch.on_break === false).length
    ).toBeGreaterThan(0);
    // The in-memory half: the manager no longer believes it is on a break...
    expect(manager.isOnBreak()).toBe(false);
    // ...and the replacement dealer that prepareManagedTableEngineForPlay
    // held `untilResumed` is released, so the tournament actually deals.
    expect((engine as any).handForHandPaused).toBe(false);
    expect((engine as any).pauseRequiresExplicitResume).toBe(false);
    expect((engine as any).holdBeforeNextHand).toBe(false);
    // And the level clock is ticking again rather than suspended forever.
    expect(manager.blindTimer).not.toBeNull();
  });

  it('re-proposes its release when the first one matches no row, instead of retrying a proposal that never can', async () => {
    /**
     * clearPersistedBreak writes the release and its credited clock as ONE
     * conditional row version, filtered on the level it measured. If anything
     * moves `current_level` between the adoption read and that write - which
     * is exactly what a re-adoption storm does, with the retiring manager and
     * its replacement both alive for a moment - the update matches no row and
     * the release throws.
     *
     * The bounded retry that throw arms re-sends `pendingBreakResumeClock`,
     * which is RETAINED on purpose so a lost acknowledgement is recognised
     * rather than double-applied. Retained, it is also pinned to the level
     * that no longer exists: every retry filters on it, matches nothing, and
     * throws again. The tournament holds its lease, deals nothing and never
     * comes off a break that expired over an hour ago.
     */
    const { row, attempts } = staleBreakTransport({
      beforeFirstUpdate: (live) => {
        live.current_level = 10;
      },
    });
    const engine = table();
    const manager = managerFixture(engine);

    await manager.resume();
    await flush();

    // The first release could not land, so the adoption ends still on break.
    expect(row.on_break).toBe(true);
    expect(manager.isOnBreak()).toBe(true);

    // Give the bounded retry a generous window to converge.
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      await flush();
    }

    expect(attempts.length).toBeGreaterThan(1);
    expect(row.on_break).toBe(false);
    expect(row.break_ends_at).toBeNull();
    expect(manager.isOnBreak()).toBe(false);
    expect((engine as any).handForHandPaused).toBe(false);
    expect((engine as any).pauseRequiresExplicitResume).toBe(false);
    expect((engine as any).holdBeforeNextHand).toBe(false);
  });

  it('holds the release until the maintenance thaw commits, then lets it go', async () => {
    const { row } = staleBreakTransport();
    const engine = table();
    const manager = managerFixture(engine);
    setMaintenanceFrozen(true);

    const adoption = manager.resume();
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();

    // The freeze outranks an expired countdown: nothing is released yet.
    expect(row.on_break).toBe(true);
    expect(manager.isOnBreak()).toBe(true);
    expect((engine as any).pauseRequiresExplicitResume).toBe(true);

    setMaintenanceFrozen(false);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    await adoption;
    await flush();

    expect(row.on_break).toBe(false);
    expect(manager.isOnBreak()).toBe(false);
    expect((engine as any).pauseRequiresExplicitResume).toBe(false);
  });

  it('re-pauses rather than resuming when the adopted break has NOT expired', async () => {
    const { row } = staleBreakTransport();
    // Move the countdown to five minutes past the adoption instant.
    row.break_ends_at = new Date(ADOPTED_AT + 300000).toISOString();
    const engine = table();
    const manager = managerFixture(engine);

    await manager.resume();
    await flush();

    expect(row.on_break).toBe(true);
    expect(manager.isOnBreak()).toBe(true);
    // Held until the countdown it still has, with an explicit-resume hold.
    expect((engine as any).handForHandPaused).toBe(true);
    expect((engine as any).holdBeforeNextHand).toBe(true);
    expect((engine as any).pauseRequiresExplicitResume).toBe(true);
  });
});
