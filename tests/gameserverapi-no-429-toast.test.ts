/**
 * Dan 2026-08-19, bug list item 13: "'Server error (429)' popup must never
 * happen on a live game."
 *
 * A 429 means the request was NOT processed, so retrying is always safe. The
 * old code retried exactly once and then put the raw status code on screen.
 * These tests pin that a burst is retried through, that different tables are
 * not serialised against each other, and that the string "429" can never reach
 * the player even in the worst case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/lib/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) } },
  getAuthUser: async () => ({ id: 'u1' }),
}));
vi.mock('../src/services/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../src/lib/errorReporter', () => ({ reportError: vi.fn() }));

const ok = () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
const tooMany = () => ({ ok: false, status: 429, json: async () => ({ success: false }) });

let submitAction: (typeof import('../src/services/GameServerAPI'))['submitAction'];
let reset: () => void;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import('../src/services/GameServerAPI');
  submitAction = mod.submitAction;
  reset = mod.__resetActionSpacingForTests;
  reset();
});
afterEach(() => vi.restoreAllMocks());

describe('submitAction — a 429 never reaches the player', () => {
  it('retries a rate-limited action and succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tooMany())
      .mockResolvedValueOnce(tooMany())
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);

    const res = await submitAction('table-1', 'u1', 'call');
    expect(res.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 15000);

  it('never surfaces the status code, even when every retry is rate limited', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(tooMany()));
    const res = await submitAction('table-1', 'u1', 'fold');
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
    expect(res.error).not.toMatch(/429/);
    expect(res.error).not.toMatch(/Server error/i);
  }, 15000);

  it('still reports other server errors plainly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    );
    const res = await submitAction('table-1', 'u1', 'fold');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/500/);
  });

  it('does not make one table wait on another', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok()));
    await submitAction('table-1', 'u1', 'call');
    const startedAt = Date.now();
    await submitAction('table-2', 'u1', 'fold');
    // A second table must go out immediately, not after the 260ms window.
    expect(Date.now() - startedAt).toBeLessThan(200);
  });

  it('spaces two actions at the SAME table so the engine window is respected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok()));
    await submitAction('table-1', 'u1', 'call');
    const startedAt = Date.now();
    await submitAction('table-1', 'u1', 'fold');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
  }, 15000);
});
