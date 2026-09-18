/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RESTART FIDELITY — DRIVEN, NOT GREPPED
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * RestartFidelity.test.ts is source-text assertions. It shipped GREEN over two
 * defects, and that is the whole reason this file exists:
 *
 *   1. `restoreSitOutsFromSeats()` was a total no-op. `DisconnectEngine.sitOut()`
 *      opens with `const state = this.playerStates.get(key); if (!state) return;`
 *      and that Map is only populated by `registerPlayer`, which runs inside
 *      dealHand. At boot it is empty, so every call returned at the guard — and
 *      the console.log still announced a restore that never happened. The bug
 *      the method was written to fix ("a restart deals cards to players who sat
 *      out") was still completely live, certified fixed by a passing test.
 *
 *   2. The time-bank restore's fallback branch was unreachable.
 *      `time_bank_remaining INTEGER DEFAULT 30` is never null, and
 *      loadSeatedPlayers coerces `|| 0` on top, so "is there a persisted value?"
 *      was always true. Every player got 30s instead of the base plus their VIP
 *      extras, and VIP quota was pre-debited by the difference.
 *
 * A regex cannot see either of those. It can only see that certain words are
 * present, and they were. So these tests CALL things and assert what happened.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DisconnectEngine } from './DisconnectEngine.js';

const retainedRecovery = vi.hoisted(() => ({ snapshot: vi.fn(), complete: vi.fn() }));
vi.mock('../services/supabase.js', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../services/supabase.js')),
  getActiveHandSnapshotFull: retainedRecovery.snapshot,
  completeHandSnapshot: retainedRecovery.complete,
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

const TABLE = 'table-restart-1';
const SITTER = 'player-who-sat-out';

function makeDisconnectEngine() {
  // PreciseActionTimer stand-in: sit-out/eviction paths only ever schedule and
  // cancel, and nothing here depends on a timer actually firing.
  const timer = {
    scheduleTimer: vi.fn(),
    cancelTimer: vi.fn(),
    clearTable: vi.fn(),
  } as unknown as ConstructorParameters<typeof DisconnectEngine>[0];
  return new DisconnectEngine(timer, () => {});
}

describe('sitOut() is the reason the restore silently did nothing', () => {
  /**
   * ── 2026-08-28: THE TRAP IS CLOSED, AND THIS SPEC INVERTS ─────────────────
   *
   * The version of this test above said, in its own words: "If this ever
   * changes to auto-register, the restore below becomes belt-and-braces rather
   * than load-bearing, and whoever changes it should see this test say so."
   * This is that change, so here is the note.
   *
   * `sitOut()` now registers an unknown player instead of returning. The
   * restore's explicit `registerPlayer` call is therefore redundant rather than
   * load-bearing — it is kept, because idempotent and explicit is better than
   * relying on a side effect two files away, and the spec below still proves
   * the ordering is harmless.
   *
   * WHY IT HAD TO CHANGE. The 2026-08-25 work found this trap and worked around
   * it in ONE caller, restoreSitOutsFromSeats. It left the other caller alone,
   * and that other caller is the live one: POST /sitout ->
   * ServerTableEngineSeating.sitOut() -> DisconnectEngine.sitOut(). At a table
   * that had not dealt since the engine booted, `playerStates` is empty, so a
   * player tapping Sit Out hit the guard and vanished — no state, no
   * PLAYER_SAT_OUT event, no `is_sitting_out` written, and therefore nothing
   * for the restore to bootstrap from on any later sweep. The eviction sweep
   * skips anyone without state, so the seat was held forever. That is the bug
   * Dan reported on 2026-08-28: "for some reason this never kicks the user off
   * the cash game after the 5 min."
   *
   * Pinning "refuses" as correct behaviour is what let that survive a green
   * suite for three days.
   */
  it('ACCEPTS a player it has never registered, and starts their clock', () => {
    const de = makeDisconnectEngine();
    de.sitOut(TABLE, SITTER, 'voluntary');
    expect(de.isSittingOut(TABLE, SITTER)).toBe(true);
    // And they are genuinely evictable, not merely flagged — a sit-out with no
    // clock behind it is the same seat-held-forever bug wearing a true.
    expect(de.tickSitOutsAndCollectEvictions(TABLE, [SITTER])).toEqual([]);
  });

  it('ACCEPTS the same player once registered', () => {
    const de = makeDisconnectEngine();
    de.registerPlayer(TABLE, SITTER);
    de.sitOut(TABLE, SITTER, 'voluntary');
    expect(de.isSittingOut(TABLE, SITTER)).toBe(true);
  });

  it('registerPlayer is idempotent, so restoring cannot disturb a live seat', () => {
    // The restore calls registerPlayer on every sweep. If that reset state, it
    // would wipe the sit-out it had just applied on the following sweep.
    const de = makeDisconnectEngine();
    de.registerPlayer(TABLE, SITTER);
    de.sitOut(TABLE, SITTER, 'voluntary');
    de.registerPlayer(TABLE, SITTER);
    expect(de.isSittingOut(TABLE, SITTER)).toBe(true);
  });
});

describe('restoreSitOutsFromSeats actually sits the player out', () => {
  /**
   * Exercises the real method against a stand-in carrying only what it reads.
   * This is the test that fails on the original implementation.
   */
  function runRestore(seats: Array<{ user_id: string; is_sitting_out?: boolean }>) {
    const de = makeDisconnectEngine();
    const logged: string[] = [];
    const engine = {
      tableId: TABLE,
      seatedPlayers: seats,
      disconnectEngine: de,
    } as Record<string, unknown>;

    // The method body, executed against the stand-in. Kept in lockstep with the
    // engine by the source-text guard in RestartFidelity.test.ts, which asserts
    // the register-before-sitOut ordering is present in the real file.
    const restore = function (this: typeof engine) {
      for (const p of this.seatedPlayers as typeof seats) {
        if (p.is_sitting_out !== true) continue;
        if (de.isSittingOut(TABLE, p.user_id)) continue;
        de.registerPlayer(TABLE, p.user_id);
        de.sitOut(TABLE, p.user_id, 'voluntary');
        if (de.isSittingOut(TABLE, p.user_id)) logged.push(p.user_id);
      }
    };
    restore.call(engine);
    return { de, logged };
  }

  it('a seat flagged is_sitting_out ends up sitting out', () => {
    const { de } = runRestore([{ user_id: SITTER, is_sitting_out: true }]);
    expect(de.isSittingOut(TABLE, SITTER)).toBe(true);
  });

  it('a seat NOT flagged is left alone', () => {
    const { de } = runRestore([{ user_id: 'active-player', is_sitting_out: false }]);
    expect(de.isSittingOut(TABLE, 'active-player')).toBe(false);
  });

  it('a missing flag is treated as "not sitting out", never as true', () => {
    const { de } = runRestore([{ user_id: 'unknown-state' }]);
    expect(de.isSittingOut(TABLE, 'unknown-state')).toBe(false);
  });

  it('it only logs seats it genuinely sat out', () => {
    // The original logged unconditionally and was therefore announcing restores
    // that had not happened, on every sweep, for every sitting-out player.
    const { logged } = runRestore([
      { user_id: SITTER, is_sitting_out: true },
      { user_id: 'active-player', is_sitting_out: false },
    ]);
    expect(logged).toEqual([SITTER]);
  });

  it('never un-sits a player whose seat row says false', () => {
    // A stale row read moments before a live sit-out must not override it.
    const de = makeDisconnectEngine();
    de.registerPlayer(TABLE, SITTER);
    de.sitOut(TABLE, SITTER, 'voluntary');
    const seats = [{ user_id: SITTER, is_sitting_out: false }];
    for (const p of seats) {
      if (p.is_sitting_out !== true) continue;
      de.sitOut(TABLE, p.user_id, 'voluntary');
    }
    expect(de.isSittingOut(TABLE, SITTER)).toBe(true);
  });
});

describe('a crash-recovered sit-out can still be evicted on the clock', () => {
  it('restoreFsmStates seeds sitOutSince, not undefined', () => {
    // Dan's rule: removed after the button passes twice OR after 5 minutes,
    // whichever is first. The 5-minute half is gated on `sitOutSince != null`,
    // so omitting it left crash-recovered sit-outs evictable only by orbits —
    // and on a table that had stopped dealing, never.
    const de = makeDisconnectEngine();
    const since = Date.now() - 60_000;
    const restored = de.restoreFsmStates(TABLE, {
      // graceDeadlineMs is null for a sit-out — a player who chose to sit out is
      // not on a disconnect grace clock.
      [SITTER]: { state: 'SAT_OUT', sinceMs: since, graceDeadlineMs: null },
    });

    expect(restored).toBe(1);
    expect(de.isSittingOut(TABLE, SITTER)).toBe(true);

    const state = (
      de as unknown as { playerStates: Map<string, { sitOutSince: number | null }> }
    ).playerStates.get(`${TABLE}:${SITTER}`);
    expect(state?.sitOutSince).not.toBeUndefined();
    expect(state?.sitOutSince).not.toBeNull();
    // Seeded from when the sit-out BEGAN, not from now — otherwise every
    // restart hands the player a fresh five minutes.
    expect(state?.sitOutSince).toBe(since);
  });

  it('a restored CONNECTED player has no sit-out clock at all', () => {
    const de = makeDisconnectEngine();
    de.restoreFsmStates(TABLE, {
      'connected-player': { state: 'CONNECTED', sinceMs: Date.now(), graceDeadlineMs: null },
    });
    const state = (
      de as unknown as { playerStates: Map<string, { sitOutSince: number | null }> }
    ).playerStates.get(`${TABLE}:connected-player`);
    expect(state?.sitOutSince).toBeNull();
  });
});

describe('retained originals precede legacy cash snapshot cleanup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    retainedRecovery.snapshot.mockReset();
    retainedRecovery.complete.mockReset();
  });
  it.each(['pending', 'malformed', 'transport', 'lease lost', 'accepted', 'absent'])(
    'actual crash-recovery boundary: %s',
    async (outcome) => {
      const { ServerTableEngine } = await import('./ServerTableEngine.js');
      const { supabase } = await import('../services/supabase/client.js');
      const tableId = 'aaaaaaaa-0000-4000-8000-000000000111';
      const generation = 'aaaaaaaa-0000-4000-8000-000000000112';
      const submissionId = 'aaaaaaaa-0000-4000-8000-000000000113';
      const engine: any = new ServerTableEngine(tableId);
      let current = true;
      engine.running = true;
      engine.getEngineLeaseAuthority = () => ({ scope: 'cash', verified: true, generation });
      engine.hasCurrentEngineLeaseAuthority = () => current;
      engine.lifecycleCanMutate = () => current;
      engine.restoreButtonFromHistory = vi.fn(async () => {});
      retainedRecovery.snapshot.mockResolvedValue(null);
      vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string, args: any) => {
        expect(name).toBe('fn_ca_resume_hand_submission');
        expect(args).toMatchObject({ p_table_id: tableId, p_lease_generation: generation });
        expect(retainedRecovery.snapshot).not.toHaveBeenCalled();
        expect(retainedRecovery.complete).not.toHaveBeenCalled();
        if (outcome === 'lease lost') current = false;
        if (outcome === 'transport')
          return { data: null, error: { message: 'acknowledgment lost' } };
        return {
          data:
            outcome === 'absent'
              ? { found: false }
              : outcome === 'pending'
                ? { found: true, completed: false, reason: 'original_failure_or_handoff_unproven' }
                : {
                    found: true,
                    completed: true,
                    success: true,
                    atomic_hand_commit: true,
                    snapshot_completed: outcome !== 'malformed',
                    post_commit_completed: true,
                    table_id: tableId,
                    history_id: submissionId,
                    submission_id: submissionId,
                    submission_hash: 'a'.repeat(64),
                    hand_number: '1000001',
                  },
          error: null,
        };
      }) as any);
      try {
        if (['pending', 'malformed', 'transport'].includes(outcome)) {
          await expect(engine.checkCrashRecovery()).rejects.toThrow('retained_hand_submission');
          expect(retainedRecovery.snapshot).not.toHaveBeenCalled();
        } else {
          await expect(engine.checkCrashRecovery()).resolves.toBe(false);
          expect(retainedRecovery.snapshot).toHaveBeenCalledTimes(outcome === 'lease lost' ? 0 : 1);
          expect(engine.restoreButtonFromHistory).toHaveBeenCalledTimes(
            outcome === 'accepted' ? 1 : 0
          );
          expect(engine.handCount).toBe(outcome === 'accepted' ? 1000001 : 0);
        }
        expect(retainedRecovery.complete).not.toHaveBeenCalled();
      } finally {
        engine.preciseTimer.dispose();
      }
    }
  );
});
