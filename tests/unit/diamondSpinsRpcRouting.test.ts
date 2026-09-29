/**
 * The client itself decides which calls are bounded, so the list of bounded
 * doors is pinned here against the REAL client — not against a copy of the
 * pattern, which could agree with a test while disagreeing with the app.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DIAMOND_SPINS_RPC_DEADLINE_MS } from '../../src/lib/diamondSpinsRpcDeadline';

const BASE = 'https://unit.supabase.co';

/** Every Diamond Spins door a page waits on, by the RPC it sends. */
const BOUNDED = [
  'fn_wheel_commit',
  'fn_wheel_spin_v2',
  'fn_wheel_bonus_start',
  'fn_wheel_bonus_state',
  'fn_wheel_state_v2',
  'fn_diamond_game_commit',
  'fn_diamond_game_state',
  'fn_diamond_games_entry',
  'fn_diamond_bonus_start',
  'fn_diamond_bonus_state',
  'fn_diamond_wallet_summary',
  'fn_crash_start',
  'fn_crash_settle',
  'fn_crash_cashout',
  'fn_plinko_drop',
  'fn_choice_start',
  'fn_choice_act',
  'fn_choice_state',
  'fn_shared_bonus_replay',
];

/** Doors outside Diamond Spins keep the transport they have today. */
const UNBOUNDED = ['atomic_table_buyin', 'insert_hole_cards', 'fn_ca_cash_buyin_receipt'];

let supabase: typeof import('../../src/lib/supabase').supabase;

beforeAll(async () => {
  vi.stubEnv('VITE_SUPABASE_URL', BASE);
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key-for-unit-tests');
  ({ supabase } =
    await vi.importActual<typeof import('../../src/lib/supabase')>('../../src/lib/supabase'));
  // Both are reached by dynamic import inside the client. Load them here so a
  // test that runs on fake timers is measuring the deadline and the retry,
  // not the module registry.
  await import('../../src/lib/diamondSpinsRpcDeadline');
  await import('../../src/lib/pgrstRetryFetch');
});
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Sends the call with a transport that never answers and reports the wait. */
function hungCall(fn: string) {
  const transport = vi.fn().mockReturnValue(new Promise(() => {}));
  vi.stubGlobal('fetch', transport);
  const state = { settled: false, result: undefined as unknown };
  const done = supabase.rpc(fn as never, {} as never).then((value) => {
    state.settled = true;
    state.result = value;
    return value;
  });
  return { transport, state, done };
}

describe('the doors a Diamond Spins page waits on', () => {
  it.each(BOUNDED)('%s answers its page when the socket goes quiet', async (fn) => {
    const { transport, state, done } = hungCall(fn);
    await vi.advanceTimersByTimeAsync(DIAMOND_SPINS_RPC_DEADLINE_MS - 100);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    const { data, error, status } = (await done) as {
      data: unknown;
      error: { message: string; code: string } | null;
      status: number;
    };
    expect(data).toBeNull();
    // A lost answer, with no code on it: every page replays its saved request
    // rather than treating the round as refused.
    expect(error?.message).toContain('The Request Timed Out');
    expect(error?.code).toBe('');
    expect(status).toBe(0);
    expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
  });
});

describe('the rest of the app', () => {
  it.each(UNBOUNDED)('%s is left on the transport it has today', async (fn) => {
    const { transport, state } = hungCall(fn);
    await vi.advanceTimersByTimeAsync(DIAMOND_SPINS_RPC_DEADLINE_MS * 3);
    expect(state.settled).toBe(false);
    expect(transport.mock.calls[0][1]?.signal?.aborted ?? false).toBe(false);
  });

  it('leaves a table read unbounded', async () => {
    const transport = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal('fetch', transport);
    let settled = false;
    void supabase
      .from('diamond_game_rounds')
      .select('id')
      .then(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(DIAMOND_SPINS_RPC_DEADLINE_MS * 3);
    expect(settled).toBe(false);
  });
});

describe('a bounded door keeps the retries it already had', () => {
  it('rides out a PostgREST reload inside its budget', async () => {
    // Real timers: the retry's own backoff is under a second, and the point
    // here is that the deadline does not cut the retry short.
    vi.useRealTimers();
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'PGRST002', message: 'schema cache' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', transport);
    const { data, error } = (await supabase.rpc('fn_crash_settle' as never, {} as never)) as {
      data: unknown;
      error: unknown;
    };
    expect(error).toBeNull();
    expect(data).toEqual({ ok: true });
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
