/**
 * The shared presence watcher (src/lib/profilePresence.ts) and its hooks
 * (src/hooks/useProfilePresence.ts): one definition of online, batched,
 * re-asked before a heartbeat can go stale. The law that every surface uses
 * it is tests/presence-has-one-definition.law.test.ts.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/ownProfile', () => ({ readPresence: vi.fn() }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { readPresence } from '../../src/lib/ownProfile';
import {
  PRESENCE_RECHECK_MS,
  resetProfilePresenceForTests,
  watchProfilePresence,
  type PresenceAnswer,
} from '../../src/lib/profilePresence';
import {
  useIsProfileOnline,
  useOnlineNow,
  useProfilePresence,
} from '../../src/hooks/useProfilePresence';

const asked = vi.mocked(readPresence);
/** The database, as fn_profile_presence would answer it right now. */
let fresh = new Map<string, boolean>();
let visibility: DocumentVisibilityState = 'visible';

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  resetProfilePresenceForTests();
  asked.mockReset();
  asked.mockImplementation(async (ids: readonly string[]) => {
    const out = new Map<string, boolean>();
    for (const id of ids) if (fresh.has(id)) out.set(id, fresh.get(id) === true);
    return out;
  });
  fresh = new Map();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  resetProfilePresenceForTests();
  vi.useRealTimers();
});

describe('watchProfilePresence', () => {
  it('asks once for every dot mounted in the same tick', async () => {
    fresh = new Map([
      ['a', true],
      ['b', false],
      ['c', true],
    ]);
    const seenA: PresenceAnswer[] = [];
    const seenB: PresenceAnswer[] = [];
    watchProfilePresence(['a', 'b'], (m) => seenA.push(m));
    watchProfilePresence(['b', 'c'], (m) => seenB.push(m));
    await flush();

    expect(asked).toHaveBeenCalledTimes(1);
    expect([...asked.mock.calls[0][0]].sort()).toEqual(['a', 'b', 'c']);
    expect(seenA.at(-1)?.get('a')).toBe(true);
    expect(seenB.at(-1)?.get('c')).toBe(true);
    expect(seenB.at(-1)?.get('b')).toBe(false);
  });

  it('re-asks every watched account in one call, so a stale heartbeat goes offline', async () => {
    fresh = new Map([['a', true]]);
    const seen: PresenceAnswer[] = [];
    watchProfilePresence(['a'], (m) => seen.push(m));
    watchProfilePresence(['b'], () => {});
    await flush();
    expect(seen.at(-1)?.get('a')).toBe(true);

    // The heartbeat goes stale: nothing changes a row, the door now says no.
    fresh = new Map([['a', false]]);
    await vi.advanceTimersByTimeAsync(PRESENCE_RECHECK_MS);
    await flush();

    expect(asked).toHaveBeenCalledTimes(2);
    expect([...asked.mock.calls[1][0]].sort()).toEqual(['a', 'b']);
    expect(seen.at(-1)?.get('a')).toBe(false);
  });

  it('re-asks inside the five-minute freshness window, and not hammering', () => {
    expect(PRESENCE_RECHECK_MS).toBeLessThan(5 * 60_000);
    expect(PRESENCE_RECHECK_MS).toBeGreaterThanOrEqual(30_000);
  });

  it('a failed re-ask leaves the account offline, never the last "online"', async () => {
    fresh = new Map([['a', true]]);
    const seen: PresenceAnswer[] = [];
    watchProfilePresence(['a'], (m) => seen.push(m));
    await flush();
    expect(seen.at(-1)?.get('a')).toBe(true);

    asked.mockRejectedValueOnce(new Error('network'));
    await vi.advanceTimersByTimeAsync(PRESENCE_RECHECK_MS);
    await flush();
    expect(seen.at(-1)?.get('a')).toBe(false);
  });

  it('does not re-ask a hidden tab, and re-asks when it returns', async () => {
    watchProfilePresence(['a'], () => {});
    await flush();
    expect(asked).toHaveBeenCalledTimes(1);

    visibility = 'hidden';
    await vi.advanceTimersByTimeAsync(PRESENCE_RECHECK_MS * 3);
    expect(asked).toHaveBeenCalledTimes(1);

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(asked).toHaveBeenCalledTimes(2);
  });

  it('stops asking once nothing watches', async () => {
    const stop = watchProfilePresence(['a'], () => {});
    await flush();
    stop();
    await vi.advanceTimersByTimeAsync(PRESENCE_RECHECK_MS * 3);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('a second watcher of a known account is answered without asking again', async () => {
    fresh = new Map([['a', true]]);
    watchProfilePresence(['a'], () => {});
    await flush();
    const seen: PresenceAnswer[] = [];
    watchProfilePresence(['a'], (m) => seen.push(m));
    await flush();
    expect(asked).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)?.get('a')).toBe(true);
  });
});

describe('useProfilePresence / useIsProfileOnline / useOnlineNow', () => {
  it('answers from the door and follows its re-asks', async () => {
    fresh = new Map([
      ['a', true],
      ['b', false],
    ]);
    const { result } = renderHook(() => useProfilePresence(['a', 'b', null]));
    await act(flush);
    expect(result.current.get('a')).toBe(true);
    expect(result.current.get('b')).toBe(false);

    fresh = new Map([
      ['a', false],
      ['b', true],
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRESENCE_RECHECK_MS);
      await flush();
    });
    expect(result.current.get('a')).toBe(false);
    expect(result.current.get('b')).toBe(true);
  });

  it('a single dot is offline until the door says otherwise', async () => {
    fresh = new Map([['a', true]]);
    const { result } = renderHook(() => useIsProfileOnline('a'));
    expect(result.current).toBe(false);
    await act(flush);
    expect(result.current).toBe(true);
  });

  it("a roster row keeps the RPC's fresh answer only until the first re-ask lands", async () => {
    fresh = new Map([['a', false]]);
    const { result } = renderHook(() => useOnlineNow('a', true));
    expect(result.current).toBe(true);
    await act(flush);
    expect(result.current).toBe(false);
  });

  it('asks nothing for no accounts', async () => {
    const { result } = renderHook(() => useProfilePresence([]));
    await act(flush);
    expect(result.current.size).toBe(0);
    expect(asked).not.toHaveBeenCalled();
  });
});

describe('watchProfilePresence never shows an answer older than the last ask (2026-10-05 audit)', () => {
  /** A read that answers only when told to. */
  const deferredRead = () => {
    let resolve!: (m: Map<string, boolean>) => void;
    const promise = new Promise<Map<string, boolean>>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it('a slow read that lands after a newer one does not overwrite it', async () => {
    const slow = deferredRead();
    asked.mockImplementationOnce(() => slow.promise);
    const seen: PresenceAnswer[] = [];
    watchProfilePresence(['a'], (m) => seen.push(m));
    await flush();

    // The re-ask overtakes the first read and says offline.
    fresh = new Map([['a', false]]);
    await vi.advanceTimersByTimeAsync(PRESENCE_RECHECK_MS);
    await flush();
    expect(seen.at(-1)?.get('a')).toBe(false);

    // The first read finally lands, with what was true a minute ago.
    slow.resolve(new Map([['a', true]]));
    await flush();
    expect(seen.at(-1)?.get('a')).toBe(false);
  });

  it('a read still in flight when the last watcher leaves does not refill the cache', async () => {
    const slow = deferredRead();
    asked.mockImplementationOnce(() => slow.promise);
    const stop = watchProfilePresence(['a'], () => {});
    await flush();
    stop();
    slow.resolve(new Map([['a', true]]));
    await flush();

    // The next watcher must ask, not trust the orphaned answer.
    fresh = new Map([['a', false]]);
    const seen: PresenceAnswer[] = [];
    watchProfilePresence(['a'], (m) => seen.push(m));
    expect(seen).toEqual([]);
    await flush();
    expect(asked).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)?.get('a')).toBe(false);
  });

  it('an account that left the screen is asked afresh when it comes back', async () => {
    fresh = new Map([
      ['a', true],
      ['b', true],
    ]);
    watchProfilePresence(['a'], () => {});
    const stopB = watchProfilePresence(['b'], () => {});
    await flush();
    stopB();

    // b's heartbeat goes stale while nobody is looking at b.
    fresh = new Map([
      ['a', true],
      ['b', false],
    ]);
    const seen: PresenceAnswer[] = [];
    watchProfilePresence(['b'], (m) => seen.push(m));
    expect(seen.some((m) => m.get('b') === true)).toBe(false);
    await flush();
    expect(seen.at(-1)?.get('b')).toBe(false);
  });

  it('a batch whose watchers all left before it was sent is not sent', async () => {
    const stop = watchProfilePresence(['a'], () => {});
    stop();
    await flush();
    expect(asked).not.toHaveBeenCalled();
  });
});
