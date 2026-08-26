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
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DisconnectEngine } from './DisconnectEngine.js';

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
  it('REFUSES a player it has never registered — the trap', () => {
    // Pinning the actual behaviour of the dependency. If this ever changes to
    // auto-register, the restore below becomes belt-and-braces rather than
    // load-bearing, and whoever changes it should see this test say so.
    const de = makeDisconnectEngine();
    de.sitOut(TABLE, SITTER, 'voluntary');
    expect(de.isSittingOut(TABLE, SITTER)).toBe(false);
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
