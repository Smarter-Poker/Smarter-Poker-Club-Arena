/**
 * ONE SETTINGS READ PER USER, NOT ONE PER COMPONENT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `useUserTableSettings` is called from far more places than it looks, because
 * `useButtonImage` calls it too and six table components call `useButtonImage`.
 * Counted on main, nine of those live INSIDE a TablePage — and MultiTablePage
 * keeps up to four TablePages mounted.
 *
 * So opening four tables fired roughly 37 identical
 * `select('*') on user_table_settings`, all for the same user, all inside a
 * second, every one a round trip before the felt could paint.
 *
 * Nothing was wrong with any single call. The hook is used the way a cheap
 * selector is used, while doing the work of a fetch.
 *
 * This pins the de-duplication directly — no component tree, no escape hatch.
 * An earlier draft of this file guarded its assertions behind "if the internal
 * fetcher is not exported, assert something trivial instead", which is a test
 * that passes when the feature is absent. That is the same vacuous-pass failure
 * as the `/\bdvh\b/` bug in feltReserveIsStatic; the seam is exported instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Every query gets its OWN deferred, held in order. A single shared `settle`
 * would be overwritten by the next call, leaving earlier promises pending
 * forever — and because the de-duplication map is module-level, those strays
 * leak into the next test's count. Ask me how I know.
 */
type Deferred = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
let pending: Deferred[] = [];
const queryCount = () => pending.length;

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            new Promise((resolve, reject) => {
              pending.push({ resolve, reject });
            }),
        }),
      }),
    }),
  },
}));

const { fetchUserTableSettingsRow, __inFlightSettingsReadCount, SETTINGS_READ_TIMEOUT_MS } =
  await import('../../src/hooks/useUserTableSettings');

describe('the user_table_settings read is de-duplicated per user', () => {
  beforeEach(() => {
    pending = [];
  });

  it('collapses concurrent readers for one user into a SINGLE query', async () => {
    const a = fetchUserTableSettingsRow('user-a');
    const b = fetchUserTableSettingsRow('user-a');
    const c = fetchUserTableSettingsRow('user-a');

    // The assertion that matters. Before this change it would be 3 — and at
    // four open tables, ~37.
    expect(queryCount(), 'concurrent readers issued more than one query').toBe(1);
    expect(__inFlightSettingsReadCount()).toBe(1);

    pending[0].resolve({ data: null, error: null });
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    // Every caller gets the SAME settled result object, not a copy per caller.
    expect(ra).toEqual({ data: null, error: null });
    expect(rb).toBe(ra);
    expect(rc).toBe(ra);
    expect(__inFlightSettingsReadCount(), 'the settled entry was retained').toBe(0);
  });

  it('does NOT share a read between different users', async () => {
    const a = fetchUserTableSettingsRow('user-b1');
    expect(queryCount()).toBe(1);
    const b = fetchUserTableSettingsRow('user-b2');
    expect(queryCount(), 'a second user was served the first user’s request').toBe(2);
    pending[0].resolve({ data: 1, error: null });
    pending[1].resolve({ data: 2, error: null });
    expect(await a).toEqual({ data: 1, error: null });
    expect(await b).toEqual({ data: 2, error: null });
  });

  it('reaches the database again for a LATER mount — nothing is served stale', async () => {
    const first = fetchUserTableSettingsRow('user-c');
    pending[0].resolve({ data: null, error: null });
    await first;
    expect(__inFlightSettingsReadCount()).toBe(0);

    const second = fetchUserTableSettingsRow('user-c');
    expect(queryCount(), 'a later read reused a settled promise').toBe(2);
    pending[1].resolve({ data: null, error: null });
    await second;
  });

  it('drops the entry when the read REJECTS, so one blip cannot wedge the app', async () => {
    const p = fetchUserTableSettingsRow('user-d');
    pending[0].reject(new Error('network'));
    await expect(p).rejects.toThrow('network');
    expect(
      __inFlightSettingsReadCount(),
      'a failed read stayed cached — every future mount would await a dead promise'
    ).toBe(0);

    // ...and the next attempt genuinely retries rather than replaying the error.
    const retry = fetchUserTableSettingsRow('user-d');
    expect(queryCount(), 'the retry did not reach the network').toBe(2);
    pending[1].resolve({ data: null, error: null });
    await retry;
  });

  it('drops a read that never settles, so loading cannot remain wedged forever', async () => {
    vi.useFakeTimers();
    try {
      const stuck = fetchUserTableSettingsRow('user-timeout');
      expect(__inFlightSettingsReadCount()).toBe(1);

      const rejection = expect(stuck).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(SETTINGS_READ_TIMEOUT_MS);
      await rejection;
      expect(__inFlightSettingsReadCount()).toBe(0);

      const retry = fetchUserTableSettingsRow('user-timeout');
      expect(queryCount(), 'a timed-out read permanently blocked a retry').toBe(2);
      pending[1].resolve({ data: null, error: null });
      await retry;
    } finally {
      vi.useRealTimers();
    }
  });
});
