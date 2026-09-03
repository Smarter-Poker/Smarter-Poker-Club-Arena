/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MEMBERSHIP WARM START — boot and the lobby must share one request
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * getUserMemberships() is the first thing the app asks the network for, and
 * until 2026-08-23 nothing could ask for it until React had mounted, resolved
 * the route and loaded HomePage's chunk - several hundred milliseconds on a
 * phone with the connection idle. main.tsx now starts it at module-eval time.
 *
 * That only helps if the later call JOINS the warm one instead of issuing a
 * second request; otherwise the warm start is pure extra load. These tests
 * cover the four properties that make it safe:
 *
 *   1. two calls in the warm window produce ONE request
 *   2. a different user is never served the first user's result
 *   3. a failure is not memoised for five seconds
 *   4. sign-out drops the window entirely
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Counts how many times the membership query actually reaches "the network". */
let selectCalls = 0;
let failNext = false;
let holdNext = false;
let heldResolvers: Array<() => void> = [];

vi.mock('@/lib/supabase', () => {
  const result = () => {
    if (failNext) return Promise.reject(new Error('network down'));
    if (!holdNext) return Promise.resolve({ data: [], error: null });
    return new Promise<{ data: never[]; error: null }>((resolve) => {
      heldResolvers.push(() => resolve({ data: [], error: null }));
    });
  };

  const builder: any = {
    select: (..._a: unknown[]) => {
      selectCalls++;
      return builder;
    },
    eq: () => builder,
    in: () => result(),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => result().then(res, rej),
  };

  return {
    supabase: {
      from: () => builder,
      rpc: () => Promise.resolve({ data: [], error: null }),
    },
    getAuthUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
  };
});

import {
  getUserMemberships,
  warmUserMemberships,
  clearMembershipsWarmCache,
} from '@/services/ClubsService';
import { clearUserCaches } from '@/utils/clearUserCaches';

describe('membership warm start', () => {
  beforeEach(() => {
    selectCalls = 0;
    failNext = false;
    holdNext = false;
    heldResolvers = [];
    vi.useRealTimers();
    clearMembershipsWarmCache();
  });

  it('serves a second caller from the request already in flight', async () => {
    const a = getUserMemberships({ id: 'user-1' });
    const b = getUserMemberships({ id: 'user-1' });
    await Promise.all([a, b]);
    expect(selectCalls, 'the lobby issued its own request instead of joining the warm one').toBe(1);
  });

  it('never duplicates a still-pending request after the five-second warm window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T09:00:00Z'));
    holdNext = true;
    const first = getUserMemberships({ id: 'user-1' });

    await vi.advanceTimersByTimeAsync(6_000);
    holdNext = false;
    const second = getUserMemberships({ id: 'user-1' });

    expect(selectCalls, 'a slow in-flight request was duplicated after the TTL').toBe(1);
    heldResolvers[0]?.();
    await Promise.all([first, second]);
  });

  it('warmUserMemberships() is what the later caller joins', async () => {
    warmUserMemberships();
    await getUserMemberships({ id: 'user-1' });
    expect(selectCalls).toBe(1);
  });

  it('never serves one account the other account request', async () => {
    await getUserMemberships({ id: 'user-1' });
    await getUserMemberships({ id: 'user-2' });
    expect(selectCalls, 'a different user reused the first user cached promise').toBe(2);
  });

  it('does not memoise a failure after the bounded recovery window', async () => {
    vi.useFakeTimers();
    failNext = true;
    const exhausted = expect(getUserMemberships({ id: 'user-1' })).rejects.toBeTruthy();
    await vi.advanceTimersByTimeAsync(7_500);
    await exhausted;
    failNext = false;
    // Without the rejection cleanup this would return the failed promise again
    // for five seconds - a transient blip would look like a broken lobby.
    await expect(getUserMemberships({ id: 'user-1' })).resolves.toEqual([]);
    expect(selectCalls).toBe(6);
  });

  it('is dropped on sign-out', async () => {
    await getUserMemberships({ id: 'user-1' });
    clearUserCaches();
    await getUserMemberships({ id: 'user-1' });
    expect(selectCalls, 'the warm window survived sign-out').toBe(2);
  });
});
