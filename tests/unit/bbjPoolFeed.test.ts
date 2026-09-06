/**
 * ONE SOURCE FOR THE JACKPOT FIGURE (BBJ build plan phase 3.2).
 *
 * `bbj_pools` updates on every raked hand - 40,219 times in twenty-four hours,
 * measured on production 2026-09-06 - and six surfaces each held a Realtime
 * subscription to it so a number a player glances at could be exact to the
 * second. These pin the replacement: one poll per CLUB, shared, paused while
 * the tab is hidden, and refusing to publish a zero it did not read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
const reportError = vi.fn();
vi.mock('../../src/utils/errorReporter', () => ({
  reportError: (...a: unknown[]) => reportError(...a),
}));

import {
  watchBbjPool,
  __resetBbjPoolFeedForTests,
  BBJ_POOL_POLL_MS,
} from '../../src/lib/bbjPoolFeed';

const POOL = 'pool-1';
const row = (main: number) => ({ data: [{ pool_id: POOL, main_balance: main }], error: null });

/** The feed reads on subscribe; this lets that microtask settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  rpc.mockReset();
  reportError.mockReset();
  __resetBbjPoolFeedForTests();
});

afterEach(() => {
  __resetBbjPoolFeedForTests();
  vi.useRealTimers();
});

describe('one request serves every surface on a club', () => {
  it('six subscribers on one club share ONE read, not six', async () => {
    rpc.mockResolvedValue(row(100));
    const seen: number[] = [];
    const stops = Array.from({ length: 6 }, () =>
      watchBbjPool('club-a', (s) => seen.push(s.mainBalance))
    );
    await settle();

    /* THE WHOLE POINT. Before this, the felt, the lobby, the ticker, the
       wallet, the union dashboard and the jackpot page each opened their own
       subscription to the same row. */
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toEqual({ p_club_id: 'club-a' });
    expect(seen).toEqual([100, 100, 100, 100, 100, 100]);
    stops.forEach((s) => s());
  });

  it('a surface joining an already-running feed paints immediately', async () => {
    rpc.mockResolvedValue(row(250));
    const first = watchBbjPool('club-a', () => undefined);
    await settle();
    rpc.mockClear();

    const late: number[] = [];
    const second = watchBbjPool('club-a', (s) => late.push(s.mainBalance));
    /* Synchronously, with no read at all - otherwise a surface that mounts
       eight seconds into the interval shows a zero jackpot until the tick. */
    expect(late).toEqual([250]);
    expect(rpc).not.toHaveBeenCalled();
    first();
    second();
  });

  it('two clubs are two feeds', async () => {
    rpc.mockResolvedValue(row(1));
    const a = watchBbjPool('club-a', () => undefined);
    const b = watchBbjPool('club-b', () => undefined);
    await settle();
    expect(rpc).toHaveBeenCalledTimes(2);
    a();
    b();
  });
});

describe('the poll stops when nobody is looking', () => {
  it('the last unsubscribe stops the timer', async () => {
    rpc.mockResolvedValue(row(10));
    const a = watchBbjPool('club-a', () => undefined);
    const b = watchBbjPool('club-a', () => undefined);
    await settle();
    rpc.mockClear();

    a();
    vi.advanceTimersByTime(BBJ_POOL_POLL_MS * 2);
    await settle();
    expect(rpc, 'one listener remains, so the feed still polls').toHaveBeenCalled();

    rpc.mockClear();
    b();
    vi.advanceTimersByTime(BBJ_POOL_POLL_MS * 3);
    await settle();
    /* A player who closed the club an hour ago must not still be polling it. */
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a hidden tab costs nothing', async () => {
    rpc.mockResolvedValue(row(10));
    const stop = watchBbjPool('club-a', () => undefined);
    await settle();
    rpc.mockClear();

    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.advanceTimersByTime(BBJ_POOL_POLL_MS * 3);
    await settle();
    /* Realtime pushed to a backgrounded tab exactly as hard as to a visible
       one. This is the saving that subscription could never make. */
    expect(rpc).not.toHaveBeenCalled();

    spy.mockReturnValue('visible');
    vi.advanceTimersByTime(BBJ_POOL_POLL_MS);
    await settle();
    expect(rpc).toHaveBeenCalled();
    spy.mockRestore();
    stop();
  });
});

describe('it never publishes a figure it did not read', () => {
  it('a failed read leaves the last known jackpot on screen', async () => {
    rpc.mockResolvedValueOnce(row(5000));
    const seen: number[] = [];
    const stop = watchBbjPool('club-a', (s) => seen.push(s.mainBalance));
    await settle();
    expect(seen).toEqual([5000]);

    rpc.mockResolvedValue({ data: null, error: { message: 'network' } });
    vi.advanceTimersByTime(BBJ_POOL_POLL_MS);
    await settle();

    /* Publishing 0 here would tell every player at every table of this club
       that the jackpot is empty. A stale figure is a lag; a zeroed one is a
       lie about money. */
    expect(seen).toEqual([5000]);
    expect(reportError).toHaveBeenCalled();
    stop();
  });

  it('an unchanged figure is not republished', async () => {
    rpc.mockResolvedValue(row(42));
    const seen: number[] = [];
    const stop = watchBbjPool('club-a', (s) => seen.push(s.mainBalance));
    await settle();
    vi.advanceTimersByTime(BBJ_POOL_POLL_MS * 3);
    await settle();
    expect(seen).toEqual([42]);
    stop();
  });

  it('one surface throwing does not stop the other five being told', async () => {
    rpc.mockResolvedValue(row(7));
    const seen: number[] = [];
    const bad = watchBbjPool('club-a', () => {
      throw new Error('a render blew up');
    });
    const good = watchBbjPool('club-a', (s) => seen.push(s.mainBalance));
    await settle();
    expect(seen).toEqual([7]);
    expect(reportError).toHaveBeenCalled();
    bad();
    good();
  });
});
