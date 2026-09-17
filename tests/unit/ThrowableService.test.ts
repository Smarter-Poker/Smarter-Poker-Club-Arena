/**
 * ThrowableService — REWRITTEN 2026-08-21 against the CURRENT catalog.
 *
 * The old file pinned "exactly 25 throwables, 5 per category" from the launch
 * catalog; the shipped catalog has since grown (49 items, new 'sports'
 * category) and the counts rotted because client tests did not run in CI.
 * These pins are structural — id uniqueness, category integrity, physics
 * completeness — plus a floor on the catalog size, so the catalog can GROW
 * without touching this file but can never silently shrink or corrupt.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { throwableService } from '../../src/services/ThrowableService';
import { supabase } from '../../src/lib/supabase';

const CATEGORIES = ['reactions', 'throws', 'sports', 'cheers', 'premium'] as const;

describe('ThrowableService catalog', () => {
  const all = throwableService.getThrowables();

  it('has at least the launch catalog size and never shrinks below it', () => {
    expect(all.length).toBeGreaterThanOrEqual(25);
  });

  it('every item has a unique id', () => {
    const ids = all.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every item carries a known category', () => {
    for (const t of all) {
      expect(CATEGORIES).toContain(t.category);
    }
  });

  it('every category tab has content', () => {
    const grouped = throwableService.getThrowablesByCategory();
    for (const c of CATEGORIES) {
      expect(grouped[c].length, `category ${c} is empty`).toBeGreaterThan(0);
    }
  });

  it('grouping is a partition: no item lost, none duplicated across tabs', () => {
    const grouped = throwableService.getThrowablesByCategory();
    const total = CATEGORIES.reduce((n, c) => n + grouped[c].length, 0);
    expect(total).toBe(all.length);
  });

  it('every item is renderable: name, sound, physics, impact, color present', () => {
    for (const t of all) {
      expect(t.name?.length, t.id).toBeGreaterThan(0);
      expect(t.sound?.length, t.id).toBeGreaterThan(0);
      expect(t.physics, t.id).toBeTruthy();
      expect(t.impact, t.id).toBeTruthy();
      expect(t.color?.length, t.id).toBeGreaterThan(0);
    }
  });
});

describe('throwable purchase failures stay handled without telemetry', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('returns an RPC failure and never retries a charge', async () => {
    const failure = {
      success: false as const,
      data: null,
      error: {
        name: 'PostgrestError',
        message: 'unavailable',
        details: '',
        hint: '',
        code: '503',
        toJSON: () => ({
          name: 'PostgrestError',
          message: 'unavailable',
          details: '',
          hint: '',
          code: '503',
        }),
      },
      count: null,
      status: 503,
      statusText: 'Unavailable',
    };
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValueOnce(failure);
    await expect(throwableService.useThrowable('test-user', 'beer')).resolves.toEqual({
      success: false,
      error: 'Throw unavailable, please try again',
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('fn_use_throwable_v2', {
      p_throwable_id: 'beer',
      p_request_id: expect.any(String),
    });
  });

  it('returns a rejected request as an error result', async () => {
    const rpc = vi.spyOn(supabase, 'rpc').mockRejectedValueOnce(new Error('network unavailable'));
    await expect(throwableService.useThrowable('test-user', 'beer')).resolves.toEqual({
      success: false,
      error: 'Unexpected error',
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('uncertain throw receipts', () => {
  beforeEach(() => vi.clearAllMocks());
  it('retains the request for a malformed success response', async () => {
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockResolvedValue({ data: { status: 'unknown' }, error: null } as never);
    await throwableService.useThrowable('malformed-user', 'beer');
    await throwableService.useThrowable('malformed-user', 'beer');
    expect(rpc.mock.calls[0][1]).toEqual(rpc.mock.calls[1][1]);
  });
  it('retains an in-memory retry identity when session storage is disabled', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('disabled');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('disabled');
    });
    const rpc = vi.spyOn(supabase, 'rpc').mockRejectedValue(new Error('lost'));
    await throwableService.useThrowable('no-storage-user', 'beer');
    await throwableService.useThrowable('no-storage-user', 'beer');
    expect(rpc.mock.calls[0][1]).toEqual(rpc.mock.calls[1][1]);
  });

  afterEach(() => vi.restoreAllMocks());
  it('reuses the request after a lost response and starts a new intent after success', async () => {
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValue({ data: { success: true, idempotent: true }, error: null } as never);
    await throwableService.useThrowable('receipt-retry-user', 'beer');
    const first = rpc.mock.calls[0][1] as { p_request_id: string };
    expect(sessionStorage.getItem('throwable-pending:receipt-retry-user:beer')).toBe(
      first.p_request_id
    );
    await expect(throwableService.useThrowable('receipt-retry-user', 'beer')).resolves.toEqual({
      success: true,
      requestId: first.p_request_id,
    });
    expect(rpc.mock.calls[1][1]).toEqual(rpc.mock.calls[0][1]);
    expect(sessionStorage.getItem('throwable-pending:receipt-retry-user:beer')).toBeNull();
    await throwableService.useThrowable('receipt-retry-user', 'beer');
    expect((rpc.mock.calls[2][1] as { p_request_id: string }).p_request_id).not.toBe(
      first.p_request_id
    );
  });
  it('recovers a persisted request and clears a definite server rejection', async () => {
    const key = 'throwable-pending:receipt-restored-user:beer';
    const id = '00000000-0000-4000-8000-000000000055';
    sessionStorage.setItem(key, id);
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: { success: false, error: 'Insufficient Diamonds' },
      error: null,
    } as never);
    await expect(throwableService.useThrowable('receipt-restored-user', 'beer')).resolves.toEqual({
      success: false,
      error: 'Insufficient Diamonds',
    });
    expect(rpc).toHaveBeenCalledWith('fn_use_throwable_v2', {
      p_throwable_id: 'beer',
      p_request_id: id,
    });
    expect(sessionStorage.getItem(key)).toBeNull();
  });
  it('does not reuse a request across users or items', async () => {
    const rpc = vi.spyOn(supabase, 'rpc').mockRejectedValue(new Error('offline'));
    await throwableService.useThrowable('scope-user-a', 'beer');
    await throwableService.useThrowable('scope-user-a', 'tomato');
    await throwableService.useThrowable('scope-user-b', 'beer');
    const ids = rpc.mock.calls.map((c) => (c[1] as { p_request_id: string }).p_request_id);
    expect(new Set(ids).size).toBe(3);
  });
});
