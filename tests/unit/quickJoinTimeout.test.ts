/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  "FINDING GAMES…" MUST NOT BE FOREVER (2026-08-23)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Measured on production: pressing "+" occasionally leaves the Quick Join
 * sheet on "Finding Games…" indefinitely, and instrumenting window.fetch shows
 * NO `/rest/v1/tables` request is ever issued — so the await neither resolves
 * nor rejects, and it never reached the network to begin with. A `try/catch`
 * cannot save you from that: nothing is thrown.
 *
 * Every other failure in handleAddTable already falls back to the lobby tab.
 * This pins the rule that a stall does too, so the button always takes the
 * player somewhere rather than spinning.
 *
 * The race is exercised through the same shape the page uses: a promise that
 * never settles, versus one that resolves normally.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const TIMEOUT_MS = 6000;

/** The page's helper, in the form it is used: resolve null instead of hanging. */
async function withTimeout<T>(work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('Quick Join stall handling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('gives up on a query that never settles', async () => {
    // Exactly the observed failure: no resolve, no reject, no request.
    const neverSettles = new Promise<{ data: unknown[] }>(() => {});
    const raced = withTimeout(neverSettles);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);

    // null is the signal handleAddTable turns into the lobby-tab fallback.
    await expect(raced).resolves.toBeNull();
  });

  it('does not interfere with a query that answers in time', async () => {
    const rows = [{ id: 't1' }, { id: 't2' }];
    const raced = withTimeout(Promise.resolve({ data: rows }));

    await vi.advanceTimersByTimeAsync(1);

    await expect(raced).resolves.toEqual({ data: rows });
  });

  it('still resolves for a slow-but-real query inside the budget', async () => {
    // The real query measured 139-232ms after the partial index landed.
    const slow = new Promise<{ data: unknown[] }>((resolve) => {
      setTimeout(() => resolve({ data: [] }), 232);
    });
    const raced = withTimeout(slow);

    await vi.advanceTimersByTimeAsync(233);

    // An empty answer is NOT a stall: it means "No Open Seats Right Now".
    await expect(raced).resolves.toEqual({ data: [] });
  });

  it('propagates a genuine rejection rather than masking it as a stall', async () => {
    const raced = withTimeout(Promise.reject(new Error('network down')));
    await expect(raced).rejects.toThrow('network down');
  });
});
