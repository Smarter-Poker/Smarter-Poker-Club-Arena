/**
 * A FROZEN RETAINED-HAND DOOR IS A WAIT, NOT A CRASH (2026-10-15)
 *
 * Production, engine_recovery_events 2026-10-07 to 2026-10-09: on every
 * engine-replacing break the same three cash tables, each holding a retained
 * hand, were killed with `start_failed:start_load_table` and rebuilt 130 to
 * 480 times between :55 and :00. Each start asked fn_ca_resume_hand_submission
 * for the retained hand, the door answered HAND_SUBMISSION_PLATFORM_FROZEN
 * (fn_platform_frozen) or HAND_SUBMISSION_MAINTENANCE_BUSY (the cutover lock),
 * start() turned that into a watchdog kill and a recovery row, and discovery
 * rebuilt the table into the same answer until the thaw. That is the
 * ClubArenaEngineKillStorm page.
 *
 * Pinned here, against the real modules:
 *   1. The door's two freeze answers are a named RetainedHandSubmissionFrozenError
 *      with the unchanged log text, and nothing else is.
 *   2. checkCrashRecovery waits for the thaw and asks again: no throw, progress
 *      stamped on every answer, and the resumed hand is restored when it comes.
 *   3. The engine's own thaw edge wakes the wait without the poll elapsing.
 *   4. start() through the real checkCrashRecovery: a freeze that lifts reaches
 *      ready=true with no watchdog kill and no recovery row; a generation that
 *      stops while frozen returns quietly; any other refusal is still a
 *      start_failed kill.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadTable = vi.fn();
const loadSeatedPlayers = vi.fn();
const getActiveHandSnapshotFull = vi.fn();
const loadPresenceFromPark = vi.fn();

vi.mock('../services/supabase.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/supabase.js');
  return {
    ...actual,
    loadSeatedPlayers: (...a: unknown[]) => loadSeatedPlayers(...a),
    loadTable: (...a: unknown[]) => loadTable(...a),
    getActiveHandSnapshotFull: (...a: unknown[]) => getActiveHandSnapshotFull(...a),
    loadPresenceFromPark: (...a: unknown[]) => loadPresenceFromPark(...a),
  };
});

const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { supabase } = await import('../services/supabase/client.js');
const errors = await import('../services/errorReporter.js');
const freeze = await import('../maintenance/freezeState.js');
const {
  RETAINED_HAND_FREEZE_REFUSALS,
  RETAINED_HAND_STANDING_REFUSALS,
  RetainedHandSubmissionFrozenError,
  RetainedHandSubmissionRefusedError,
  resumeRetainedHandSubmission,
} = await import('../services/supabase/handHistory.js');

const TABLE = '7c1d3a52-5b0e-4f7e-9d3c-2a61f0b4e8a1';
const GENERATION = '0b6f2e1c-8a4d-4c35-9e7f-5d2a1b3c4e6f';
const SUBMISSION = '3e9a7c5b-1d2f-4a6e-8b0c-9f1e2d3c4b5a';
const cashAuthority = () => ({
  scope: 'cash' as const,
  verified: true,
  generation: GENERATION,
  proofDeadlineMonotonicMs: performance.now() + 600_000,
});

const frozen = { data: null, error: { message: 'HAND_SUBMISSION_PLATFORM_FROZEN' } };
const busy = { data: null, error: { message: 'HAND_SUBMISSION_MAINTENANCE_BUSY' } };
const notFound = { data: { found: false }, error: null };
const resumed = {
  data: {
    found: true,
    completed: true,
    success: true,
    atomic_hand_commit: true,
    snapshot_completed: true,
    post_commit_completed: true,
    table_id: TABLE,
    history_id: SUBMISSION,
    submission_id: SUBMISSION,
    submission_hash: 'a'.repeat(64),
    hand_number: '4211',
  },
  error: null,
};

/** Script fn_ca_resume_hand_submission's answers; every other RPC is unexpected. */
function scriptDoor(...answers: unknown[]) {
  const calls: string[] = [];
  vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string) => {
    calls.push(name);
    if (name === 'fn_ca_resume_hand_submission') {
      const next = answers.shift();
      if (!next) throw new Error('door asked more often than scripted');
      return next;
    }
    // The projection wake after a resumed hand: harmless, answered empty.
    return { data: null, error: null };
  }) as any);
  return () => calls.filter((n) => n === 'fn_ca_resume_hand_submission').length;
}

function startable(authority: any) {
  const engine = new ServerTableEngine(TABLE, authority) as any;
  const killed: string[] = [];
  const phases: string[] = [];
  const realKill = engine.killForRestart.bind(engine);
  engine.killForRestart = (reason: string, notify?: boolean) => {
    killed.push(reason);
    realKill(reason, notify);
  };
  const realPhase = engine.setLoopPhase.bind(engine);
  engine.setLoopPhase = (phase: string) => {
    phases.push(phase);
    realPhase(phase);
    // The test ends at the wait for players: the start itself is what is pinned.
    if (phase === 'start_wait_for_players') engine.running = false;
  };
  engine.sleep = vi.fn(async () => {});
  engine.seedHandCountFromHistory = async () => {};
  engine.restoreButtonFromHistory = vi.fn(async () => {});
  engine.restoreKillFromHistory = vi.fn(async () => {});
  engine.restoreSitOutsFromSeats = () => {};
  engine.evictExpiredSitOuts = async () => {};
  engine.readParkedTimeBanks = async () => {};
  engine.resolveOrphanedAddOns = async () => {};
  engine.broadcastCurrentState = async () => {};
  engine.scheduleHeartbeatCheck = () => {};
  engine.dealingLoop = async () => {};
  engine.recordRecoveryEvent = vi.fn();
  return { engine, killed, phases };
}

beforeEach(() => {
  vi.spyOn(errors, 'reportError').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  loadTable.mockResolvedValue({ id: TABLE, small_blind: 1, big_blind: 2, ante: 0 });
  loadSeatedPlayers.mockResolvedValue([]);
  getActiveHandSnapshotFull.mockResolvedValue(null);
  loadPresenceFromPark.mockResolvedValue(null);
});

afterEach(() => {
  freeze.setMaintenanceFrozen(false);
  vi.restoreAllMocks();
  loadTable.mockReset();
  loadSeatedPlayers.mockReset();
  getActiveHandSnapshotFull.mockReset();
  loadPresenceFromPark.mockReset();
});

describe('the door names the freeze and nothing else', () => {
  it('the freeze set is exactly the two answers that lift at the thaw', () => {
    expect([...RETAINED_HAND_FREEZE_REFUSALS].sort()).toEqual([
      'HAND_SUBMISSION_MAINTENANCE_BUSY',
      'HAND_SUBMISSION_PLATFORM_FROZEN',
    ]);
    for (const code of RETAINED_HAND_FREEZE_REFUSALS)
      expect(RETAINED_HAND_STANDING_REFUSALS.has(code)).toBe(false);
  });

  it.each([...RETAINED_HAND_FREEZE_REFUSALS])(
    '%s is a RetainedHandSubmissionFrozenError',
    async (code) => {
      vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: null, error: { message: code } } as any);
      const error = await resumeRetainedHandSubmission(TABLE, 'i', GENERATION).catch((e) => e);
      expect(error).toBeInstanceOf(RetainedHandSubmissionFrozenError);
      expect(error).not.toBeInstanceOf(RetainedHandSubmissionRefusedError);
      expect(error).toMatchObject({ tableId: TABLE, code });
      expect(error.message).toBe(`retained_hand_submission_readback_failed: ${code}`);
    }
  );

  it.each([
    'HAND_SUBMISSION_LEASE_UNPROVEN',
    'F06_HAND_DISPATCH_BUSY',
    'HAND_SUBMISSION_TABLE_NOT_ADMITTED',
  ])(
    '%s is not the freeze',
    async (code) => {
      vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: null, error: { message: code } } as any);
      const error = await resumeRetainedHandSubmission(TABLE, 'i', GENERATION).catch((e) => e);
      expect(error).not.toBeInstanceOf(RetainedHandSubmissionFrozenError);
    }
  );
});

/** The recovery step alone, as the current owner of a live cash lease. */
function recovering() {
  const harness = startable(cashAuthority());
  harness.engine.lifecycleCanMutate = () => true;
  return harness;
}

const settle = async () => {
  for (let n = 0; n < 5; n++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('checkCrashRecovery waits for the thaw and asks again', () => {
  it('frozen, then busy, then nothing retained: no throw, progress on every answer', async () => {
    const asked = scriptDoor(frozen, frozen, busy, notFound);
    const { engine, killed } = recovering();
    const progress = vi.spyOn(engine, 'markProgress');
    await expect(engine.checkCrashRecovery()).resolves.toBe(false);
    expect(asked()).toBe(4);
    expect(progress).toHaveBeenCalledTimes(3);
    expect(engine.sleep).toHaveBeenCalledTimes(3);
    for (const [ms] of engine.sleep.mock.calls)
      expect(ms).toBeLessThanOrEqual(ServerTableEngine.RETAINED_HAND_THAW_POLL_MAX_MS);
    expect(killed).toEqual([]);
    expect(engine.recordRecoveryEvent).not.toHaveBeenCalled();
  });

  it('the retained hand that the thaw admits is restored as the last settled one', async () => {
    const asked = scriptDoor(frozen, resumed);
    const { engine } = recovering();
    await engine.checkCrashRecovery();
    expect(asked()).toBe(2);
    expect(engine.handCount).toBe(4211);
    expect(engine.restoreButtonFromHistory).toHaveBeenCalledTimes(1);
    expect(engine.restoreKillFromHistory).toHaveBeenCalledTimes(1);
  });

  it("the engine's thaw edge wakes the wait before the poll elapses", async () => {
    const asked = scriptDoor(frozen, notFound);
    const { engine } = recovering();
    // A poll that never elapses on its own: only the thaw can end this wait.
    engine.sleep = vi.fn(() => new Promise<void>(() => {}));
    freeze.setMaintenanceFrozen(true);
    const done = engine.checkCrashRecovery();
    await settle();
    expect(asked()).toBe(1);
    expect(engine.sleep).toHaveBeenCalledTimes(1);
    freeze.setMaintenanceFrozen(false);
    await expect(done).resolves.toBe(false);
    expect(asked()).toBe(2);
  });

  it('a generation that is no longer current stops asking', async () => {
    const asked = scriptDoor(frozen, frozen, frozen);
    const { engine } = recovering();
    let current = true;
    engine.lifecycleCanMutate = () => current;
    engine.sleep = vi.fn(async () => {
      current = false;
    });
    await expect(engine.checkCrashRecovery()).resolves.toBe(false);
    expect(asked()).toBe(1);
  });
});

describe('start() through the real checkCrashRecovery', () => {
  it('a freeze that lifts reaches ready=true with no kill and no recovery row', async () => {
    const asked = scriptDoor(frozen, frozen, notFound);
    const { engine, killed, phases } = startable(cashAuthority());
    await expect(engine.start()).resolves.toBeUndefined();
    await expect(engine.ready).resolves.toBe(true);
    expect(asked()).toBe(3);
    expect(phases).toContain('start_retained_hand_awaiting_thaw');
    expect(killed).toEqual([]);
    expect(engine.recordRecoveryEvent).not.toHaveBeenCalled();
    expect(errors.reportError).not.toHaveBeenCalledWith(
      expect.anything(),
      `ServerTableEngine.${TABLE}.failed_to_start`
    );
    await engine.stop();
  });

  it('a generation that stops while frozen returns quietly: no kill, no recovery row', async () => {
    scriptDoor(frozen, frozen, frozen, frozen);
    const { engine, killed } = startable(cashAuthority());
    let polls = 0;
    engine.sleep = vi.fn(async () => {
      if (++polls === 2) engine.running = false;
    });
    await expect(engine.start()).resolves.toBeUndefined();
    expect(killed).toEqual([]);
    expect(engine.recordRecoveryEvent).not.toHaveBeenCalled();
    await engine.stop();
  });

  it('any other refusal is still a start_failed kill', async () => {
    scriptDoor({ data: null, error: { message: 'HAND_SUBMISSION_LEASE_UNPROVEN' } });
    const { engine, killed } = startable(cashAuthority());
    await expect(engine.start()).rejects.toThrow(
      'retained_hand_submission_readback_failed: HAND_SUBMISSION_LEASE_UNPROVEN'
    );
    expect(killed).toEqual(['start_failed:start_load_table']);
    await engine.stop();
  });
});
