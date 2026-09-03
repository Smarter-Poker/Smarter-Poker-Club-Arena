/**
 * GLOBAL HAND NUMBERING (Dan, 2026-08-18)
 *
 * "Each hand number needs to be 100% completely different and unique ...
 * counting upwards forever ... hand numbers can never reset or be reused ever."
 *
 * It used to be a per-table counter (`this.handCount++`) that restarted at 0 on
 * every engine start, which is why the most recent 20,000 hands carried only
 * 7,468 distinct numbers and "Hand #196" existed on many tables at once.
 *
 * These tests drive the REAL allocator on the REAL engine class with the
 * database call stubbed, and pin the behaviour that matters:
 *   - it uses the value the global sequence hands back, verbatim
 *   - it retries a transient failure rather than dealing an unnumbered hand
 *   - it REFUSES to deal when it cannot get a number (the deliberate choice:
 *     a hand nobody can identify must never move money)
 *   - it rejects a nonsense allocation instead of trusting it
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import * as supabaseModule from '../services/supabase.js';

const TABLE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

function makeEngine() {
  const engine = new ServerTableEngine(TABLE) as unknown as Record<string, any>;
  return engine;
}

// `ReturnType<typeof vi.spyOn>` resolves to the UN-parameterised mock type,
// MockInstance<(this: unknown, ...args: unknown[]) => unknown>, which the real
// typed spy on supabase.rpc is not assignable to - rpc's first parameter is a
// string function name, not unknown. That is a hard TS2322, and because the
// Hetzner workflow gates on "Server tests must pass before anything is
// deployed", it blocked EVERY engine deploy rather than just failing this
// file. Deriving the type from the actual call keeps full type safety.
function createRpcSpy() {
  return vi.spyOn(supabaseModule.supabase, 'rpc');
}

let rpcSpy: ReturnType<typeof createRpcSpy>;

beforeEach(() => {
  rpcSpy = createRpcSpy();
});

afterEach(() => {
  rpcSpy.mockRestore();
});

describe('global hand number allocation', () => {
  it('returns exactly what the sequence allocated', async () => {
    rpcSpy.mockResolvedValue({ data: 1000042, error: null } as never);
    const e = makeEngine();
    await expect(e.allocateGlobalHandNumber()).resolves.toBe(1000042);
    expect(rpcSpy).toHaveBeenCalledWith('fn_next_hand_number');
  });

  it('never reuses a number across consecutive hands on the same table', async () => {
    let n = 1000000;
    // Cast the whole implementation, not its return value: supabase.rpc is
    // typed to return a PostgrestFilterBuilder (thenable, but not a Promise),
    // so `async () => x as never` is Promise<never> and fails TS2740.
    rpcSpy.mockImplementation((() => Promise.resolve({ data: ++n, error: null })) as never);
    const e = makeEngine();
    const seen = new Set<number>();
    for (let i = 0; i < 25; i++) {
      const got = await e.allocateGlobalHandNumber();
      expect(seen.has(got), `duplicate hand number ${got}`).toBe(false);
      seen.add(got);
    }
    expect(seen.size).toBe(25);
  });

  it('ascends - a later hand always outranks an earlier one', async () => {
    let n = 1000000;
    // Cast the whole implementation, not its return value: supabase.rpc is
    // typed to return a PostgrestFilterBuilder (thenable, but not a Promise),
    // so `async () => x as never` is Promise<never> and fails TS2740.
    rpcSpy.mockImplementation((() => Promise.resolve({ data: ++n, error: null })) as never);
    const e = makeEngine();
    let prev = 0;
    for (let i = 0; i < 10; i++) {
      const got = await e.allocateGlobalHandNumber();
      expect(got).toBeGreaterThan(prev);
      prev = got;
    }
  });

  it('retries a transient database failure instead of giving up on the hand', async () => {
    rpcSpy
      .mockResolvedValueOnce({ data: null, error: { message: 'ETIMEDOUT' } } as never)
      .mockResolvedValueOnce({ data: 1000077, error: null } as never);
    const e = makeEngine();
    await expect(e.allocateGlobalHandNumber()).resolves.toBe(1000077);
    expect(rpcSpy).toHaveBeenCalledTimes(2);
  });

  it('REFUSES to deal when no number can be allocated', async () => {
    rpcSpy.mockResolvedValue({ data: null, error: { message: 'db down' } } as never);
    const e = makeEngine();
    // A hand that cannot be numbered cannot be settled or audited either, so
    // refusing is strictly safer than dealing a hand nothing can identify.
    await expect(e.allocateGlobalHandNumber()).rejects.toThrow(/hand number allocation failed/);
  });

  it('rejects a nonsense allocation rather than trusting it', async () => {
    // 0, a legacy-range value, or a NULL are all "not a real allocation" — the
    // sequence starts at 1,000,000 and never returns below it.
    for (const bad of [0, null, 196, undefined, 'x']) {
      rpcSpy.mockResolvedValue({ data: bad, error: null } as never);
      const e = makeEngine();
      await expect(e.allocateGlobalHandNumber()).rejects.toThrow();
    }
  });
});
