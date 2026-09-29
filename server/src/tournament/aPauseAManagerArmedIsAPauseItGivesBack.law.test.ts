/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A PAUSE A MANAGER ARMED IS A PAUSE IT GIVES BACK (2026-09-28)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE LAW. A table a tournament manager attaches may never be left holding a
 * pause that no living authority will release. The manager either gives back
 * every pause it armed once the condition that armed it is gone, or it never
 * arms one it cannot give back.
 *
 * MEASURED IN PRODUCTION, 2026-09-28. Three satellites resumed cleanly and
 * then dealt nothing for 14 to 18 hours:
 *
 *   b165b22f  2 tables, 6 seats, dark 1090 min, level 15
 *   0e1d340e  2 tables, 6 seats, dark 1072 min, level 17
 *   e8cc6c78  2 tables, 5 seats, dark  855 min, level 15
 *
 * Every table `status = 'running'`, every seat `left_at IS NULL`, `stack > 0`,
 * `is_sitting_out = false` - 2 to 4 dealable players each. `on_break = false`,
 * `addon_period_started_at` null, `prize_pool_finalized = true`. It survived a
 * full engine restart at 15:59:24Z on a brand-new process, so it was
 * reproduced from durable rows on every adoption rather than being stranded
 * in-memory state. The dealers logged, and then never logged again:
 *
 *   [ServerTableEngine:910751a4] presence restored from the park: 6/6 seats
 *   [ServerTableEngine:910751a4] Parked between hands - waiting for the pause to lift...
 *
 * TWO WAYS THE MANAGER LOST TRACK OF A RELEASE IT OWED, one law.
 *
 * 1. THE CLAIM OUTLIVED THE RELEASE. `prepareManagedTableEngineForPlay` arms
 *    the break hold as `pauseAfterHand(..., { untilResumed: true })`, and
 *    `untilResumed` is a CLAIM as much as a pause: `awaitPauseGate`'s safety
 *    timeout reads `pauseRequiresExplicitResume` and refuses to self-resume,
 *    once, after which it nulls its own timer and nothing re-arms it.
 *    `resumeDealing()` - the manager's one release - cleared `handForHandPaused`
 *    and RETURNED when any other authority co-held the table, leaving the
 *    claim raised with nobody behind it: `resumeFromBreak()` had already
 *    written `onBreak = false` and early-returns for the rest of the event.
 *    All three events are cohort satellites, and `admitManagedTableEngine`
 *    arms the qualifier boundary (`terminalCloseoutPaused`) on every table it
 *    admits for one - so every dealer on every one of them took that deferral
 *    on the 15:59:24Z adoption.
 *
 * 2. A DEALER ARMED ON ONE SIDE OF THE RELEASE AND PUBLISHED ON THE OTHER.
 *    `performManagedTableEngineRecovery` arms the replacement BEFORE
 *    `await this.gameServer.replaceTableEngine(...)` - the order
 *    TournamentEngineRecovery.guard.test.ts pins, because a dealer must
 *    inherit the hold before it is published - and joins it to `tableEngines`
 *    only after that await. `resumeFromBreak()` has awaits of its own, sweeps
 *    `tableEngines` exactly once, and disables itself in the same call. A
 *    replacement that crosses that window is armed by a break that is over and
 *    is never offered the release at all.
 *
 * WHAT THIS PINS. The claim is surrendered by `resumeDealing()` whether or not
 * it reaches the gate, so it can never name an authority that has gone; and
 * the release is offered at the dealer's OWN park edge (`onPauseReady`, fired
 * from inside `awaitPauseGate`, wired on every managed engine), so a dealer
 * that the single sweep could not see is released the moment it says it is
 * waiting. Not a timer, not a watchdog, not a later sweep: the same causal
 * edge `advanceHandForHandBarrier` and the stage-end barrier already answer.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sliceCall, sliceMethod } from '../testHelpers/sourceWindow.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';
import { bindTournamentDataAuthorityMethods } from '../services/supabase/dataActorContext.js';

let TournamentManagerBase: (typeof import('./TournamentManagerBase.js'))['TournamentManagerBase'];
let ServerTableEngineBase: (typeof import('../engine/ServerTableEngineBase.js'))['ServerTableEngineBase'];
let supabase: (typeof import('../services/supabase.js'))['supabase'];
let leaseNow: () => number;

const T = 'ca280000-0000-4000-8000-000000000001';
const TABLE = 'ca280000-0000-4000-8000-000000000002';
const AUTH = { tournamentId: T, leaseGeneration: 'ca280000-0000-4000-8000-000000000003' };

const MANAGER_SRC = readFileSync(
  resolve(process.cwd(), 'src/tournament/TournamentManagerBase.ts'),
  'utf8'
);
const ENGINE_SRC = readFileSync(
  resolve(process.cwd(), 'src/engine/ServerTableEngineBase.ts'),
  'utf8'
);

const managers: any[] = [];

beforeAll(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder-key';
  ({ TournamentManagerBase } = await import('./TournamentManagerBase.js'));
  ({ ServerTableEngineBase } = await import('../engine/ServerTableEngineBase.js'));
  ({ supabase } = await import('../services/supabase.js'));
  ({ tournamentLeaseMonotonicNow: leaseNow } = await import('../services/tournamentLease.js'));
}, 60000);

beforeEach(() => {
  setMaintenanceFrozen(false);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // Hermetic: the level clock this release re-arms persists its anchor, and a
  // law about pause custody may not depend on - or reach - the network.
  vi.spyOn(supabase, 'from').mockImplementation(() => {
    const query: any = new Proxy(
      {
        maybeSingle: async () => ({ data: null, error: null }),
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(ok),
      },
      { get: (target, key) => (key in target ? (target as any)[key] : () => query) }
    );
    return query;
  });
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.fenceForServerShutdown();
  setMaintenanceFrozen(false);
  vi.restoreAllMocks();
});

async function flush() {
  for (let i = 0; i < 15; i++) await Promise.resolve();
}

/**
 * Only construction and I/O are replaced. Every pause decision below - the
 * arm, the gate, the release, the FSM edge - is the real engine code.
 */
function dealer() {
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
    adminPauseLock: false,
    maintenanceLock: false,
    dealingHaltLock: false,
    f06MovementAdmission: null,
    tournamentMovePauseOwners: new Set(),
    claimedTournamentMovePauseOwners: new Set(),
    breakHeldTournamentMovePauseOwners: new Set(),
    tournamentMoveOperations: new Set(),
    tournamentMoveOperationByOwner: new Map(),
    tournamentMovePauseExpiryTimers: new Map(),
    boundaryPauseWaiters: new Set(),
    terminalBoundaryPendingGenerations: new Set(),
    handForHandResolve: null,
    pausedSinceMs: 0,
    pauseMaxWaitMs: null,
    pauseGateTimer: null,
    notifyBoundaryPauseWaiters: vi.fn(),
    markProgress: vi.fn(),
    isRunning() {
      return this.running;
    },
    isTournament: () => true,
    setHub: vi.fn(),
    onHandComplete: vi.fn(),
    onRestartRequired: vi.fn(),
    renewEngineLeaseProof: vi.fn(() => true),
    fenceForEngineLeaseLoss: vi.fn(),
  });
}

/** A live manager holding its lease, with the durable I/O of a break removed. */
function managerFixture() {
  class Harness extends TournamentManagerBase {
    frames: { event: string; payload: unknown }[] = [];
    protected startEliminationChecker() {}
    protected async recalculateEliminatedPrizes() {
      return true;
    }
    protected createManagedTableEngine(): never {
      throw new Error('this proof attaches its dealers by hand');
    }
    protected startManagedTableEngine() {} // dealer I/O is outside this proof
    protected async restoreDrawnFirstButtons() {}
    protected async reconcileTournamentEntryWindow() {
      return true;
    }
    requestEliminationSweep() {
      return true;
    }
    protected async clearPersistedBreak() {} // the durable half has its own law
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
  const live = manager as any;
  live.running = true;
  // What start()/resume() open. Every lifecycle-fenced call reads this.
  live.lifecycleEpoch.begin();
  live.tournamentCache = {
    id: T,
    status: 'RUNNING',
    tournament_type: 'mtt',
    current_level: 15,
    blind_structure: [{ smallBlind: 700, bigBlind: 1400, ante: 150, durationMinutes: 10 }],
  };
  return live;
}

/** Attach a dealer the way every adoption and every recovery does. */
function attach(manager: any, engine: any, publish = true) {
  manager.wireEliminationWake(engine);
  manager.prepareManagedTableEngineForPlay(engine);
  if (publish) manager.tableEngines.set(TABLE, engine);
}

describe('a pause a tournament manager armed is a pause it gives back', () => {
  it('surrenders its claim when it releases, even while another authority still holds the table', async () => {
    const manager = managerFixture();
    const engine = dealer();
    manager.onBreak = true;
    attach(manager, engine);

    // The break's absolute hold, and the qualifier boundary an adoption arms
    // on every table of a cohort satellite. The measured 15:59:24Z shape.
    expect(engine.pauseRequiresExplicitResume).toBe(true);
    expect(engine.requiresExplicitPauseResume()).toBe(true);
    void engine.parkForTerminalCloseout(0).catch(() => undefined);
    expect(engine.terminalCloseoutPaused).toBe(true);

    await manager.resumeFromBreak();
    await flush();

    // The manager is off its break and will never call resumeFromBreak again,
    // so it may hold no claim on this dealer.
    expect(manager.isOnBreak()).toBe(false);
    expect(engine.handForHandPaused).toBe(false);
    expect(engine.pauseRequiresExplicitResume).toBe(false);
    expect(engine.requiresExplicitPauseResume()).toBe(false);

    // The table is still held - by the authority that still owns it, and by
    // nothing else. The break did not deal through the boundary on its way out.
    expect(engine.isNextHandPaused()).toBe(true);
    expect(engine.terminalCloseoutPaused).toBe(true);

    // ...and when THAT authority finishes, the table deals.
    engine.releaseTerminalCloseoutPause();
    expect(engine.isNextHandPaused()).toBe(false);
    expect(engine.holdBeforeNextHand).toBe(false);
  });

  it('releases a dealer that was armed before the release and published after it', async () => {
    const manager = managerFixture();
    const engine = dealer();
    manager.onBreak = true;

    // performManagedTableEngineRecovery arms the replacement, then awaits
    // gameServer.replaceTableEngine before publishing it into tableEngines.
    attach(manager, engine, false);
    expect(engine.requiresExplicitPauseResume()).toBe(true);
    expect(manager.tableEngines.has(TABLE)).toBe(false);

    // The break ends inside that window. Its one sweep cannot see this dealer.
    await manager.resumeFromBreak();
    await flush();
    expect(manager.isOnBreak()).toBe(false);
    expect(engine.requiresExplicitPauseResume()).toBe(true);

    // The recovery completes and the dealer starts. It reaches the gate and
    // says so, which is the edge the manager answers.
    manager.tableEngines.set(TABLE, engine);
    let stillParked = true;
    const gate = engine.awaitPauseGate().then(() => {
      stillParked = false;
    });
    await flush();

    // Asserted before the await, so a dealer that is NOT released fails here
    // rather than hanging on a promise nothing will ever resolve.
    expect(stillParked).toBe(false);
    await gate;
    expect(engine.handForHandPaused).toBe(false);
    expect(engine.pauseRequiresExplicitResume).toBe(false);
    expect(engine.holdBeforeNextHand).toBe(false);
    expect(engine.isNextHandPaused()).toBe(false);
    expect(engine.tableFSM.state).toBe('running');
  });

  it('leaves a dealer held while the condition that armed it is still true', async () => {
    const manager = managerFixture();
    const engine = dealer();
    manager.onBreak = true;
    attach(manager, engine);

    let stillParked = true;
    const gate = engine.awaitPauseGate().then(() => {
      stillParked = false;
    });
    await flush();

    // The break has NOT ended. The park edge must not become a way out of it.
    expect(stillParked).toBe(true);
    expect(engine.handForHandPaused).toBe(true);
    expect(engine.pauseRequiresExplicitResume).toBe(true);
    expect(engine.isNextHandPaused()).toBe(true);

    await manager.resumeFromBreak();
    await flush();
    expect(stillParked).toBe(false);
    await gate;
  });

  it('asks whether it still owes the release at the dealer park edge, and gates it on the claim', () => {
    const pauseReady = sliceCall(
      sliceMethod(MANAGER_SRC, 'wireEliminationWake(engine: ServerTableEngine)'),
      'engine.onPauseReady('
    );
    // Asked at the edge, and asked FIRST - before any barrier that reads the
    // dealer's parked state and would answer differently for a held table.
    expect(pauseReady).toContain('this.releaseManagedTablePauseIfUnowned(engine)');
    expect(pauseReady.indexOf('this.releaseManagedTablePauseIfUnowned(engine)')).toBeLessThan(
      pauseReady.indexOf('this.advanceHandForHandBarrier()')
    );

    const release = sliceMethod(
      MANAGER_SRC,
      'protected releaseManagedTablePauseIfUnowned(engine: ServerTableEngine): void {'
    );
    // Only the hold this manager arms, and only once every owner of it is gone.
    expect(release).toContain('engine.requiresExplicitPauseResume()');
    expect(release).toContain('this.onBreak || this.stageEndPause || this.handForHandActive');
    expect(release).toContain('this.addOnBreakActive && this.addOnBreakOwnsPause');
    expect(release).toContain('engine.resumeDealing()');
    // A release, not a retry: nothing here may schedule its way to an answer.
    expect(release).not.toContain('setTimeout');
    expect(release).not.toContain('setLifecycleTimeout');
    expect(release).not.toContain('setLifecycleInterval');
  });

  it('drops the untilResumed claim on the deferral path, not only on the way to the gate', () => {
    const resumeDealing = sliceMethod(ENGINE_SRC, 'resumeDealing(): void {');
    const surrender = resumeDealing.indexOf('this.pauseRequiresExplicitResume = false');
    const deferral = resumeDealing.indexOf('this.terminalCloseoutPaused');
    const gate = resumeDealing.indexOf('this.releasePauseGate()');
    expect(surrender).toBeGreaterThan(-1);
    expect(deferral).toBeGreaterThan(surrender);
    expect(gate).toBeGreaterThan(deferral);

    // The claim is raised by exactly one shape, so it can be answered by
    // exactly one release. If a second arm appears, this law must be re-read.
    expect(sliceMethod(ENGINE_SRC, 'pauseAfterHand(')).toContain(
      'if (opts?.untilResumed) this.pauseRequiresExplicitResume = true'
    );
    const raises = (ENGINE_SRC.match(/this\.pauseRequiresExplicitResume = true/g) ?? []).length;
    expect(raises).toBe(1);

    // The safety timeout still honours every fail-closed authority; the claim
    // it can no longer be handed is the one whose owner has gone.
    const gateBody = sliceMethod(ENGINE_SRC, 'protected async awaitPauseGate(): Promise<void> {');
    expect(gateBody).toContain('this.pauseRequiresExplicitResume ||');
    expect(gateBody).toContain('this.terminalCloseoutPaused ||');
  });
});
