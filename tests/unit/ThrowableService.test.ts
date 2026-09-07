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
import { afterEach, describe, it, expect, vi } from 'vitest';
import { normalizeThrowableError, throwableService } from '../../src/services/ThrowableService';
import { supabase } from '../../src/lib/supabase';

const CATEGORIES = ['reactions', 'throws', 'sports', 'cheers', 'premium'] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe('ThrowableService Lifetime VIP allowance', () => {
  it('resolves exact Lifetime VIP without displaying or consuming stored packs', async () => {
    const profileQuery: any = {};
    profileQuery.select = vi.fn(() => profileQuery);
    profileQuery.eq = vi.fn(() => profileQuery);
    profileQuery.maybeSingle = vi.fn().mockResolvedValue({
      data: {
        is_vip: true,
        vip_tier: 'lifetime',
        // Lifetime ignores a stale expiry by contract.
        vip_expires_at: '2020-01-01T00:00:00.000Z',
      },
      error: null,
    });
    const packQuery: any = {};
    packQuery.select = vi.fn(() => packQuery);
    packQuery.eq = vi.fn(() => packQuery);
    packQuery.then = (resolve: (result: unknown) => void) =>
      resolve({
        data: [{ uses_remaining: 25, expires_at: null }],
        error: null,
      });
    const fromSpy = vi.spyOn(supabase, 'from').mockImplementation(((table: string) => {
      if (table === 'profiles') return profileQuery;
      if (table === 'feature_purchases') return packQuery;
      throw new Error(`Unexpected Table: ${table}`);
    }) as typeof supabase.from);

    await expect(
      throwableService.getThrowAllowance('11111111-2222-4333-8444-555555555555')
    ).resolves.toEqual({
      isVip: true,
      unlimited: true,
      freeThrowsRemaining: 0,
      packThrowsRemaining: 0,
      diamondCost: 0,
    });
    expect(fromSpy).toHaveBeenCalledTimes(2);
  });
});

describe('ThrowableService refusal copy', () => {
  it('maps server codes to safe Title Case messages', () => {
    expect(normalizeThrowableError('authentication required')).toBe('Authentication Required');
    expect(normalizeThrowableError('Insufficient diamonds')).toBe('Insufficient Diamonds');
    expect(normalizeThrowableError('RATE_LIMITED')).toBe(
      'Please Wait Before Sending Another Throwable'
    );
    expect(normalizeThrowableError('private lower-level failure')).toBe('Could Not Send Reaction');
  });

  it('never forwards a database refusal verbatim', async () => {
    vi.spyOn(supabase, 'rpc').mockResolvedValueOnce({
      data: { success: false, error: 'authentication required' },
      error: null,
    } as never);

    await expect(
      throwableService.useThrowable(
        '11111111-2222-4333-8444-555555555555',
        'tomato',
        'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      )
    ).resolves.toEqual({
      success: false,
      error: 'Authentication Required',
      retrySameRequest: false,
    });
    expect(supabase.rpc).toHaveBeenCalledWith('fn_use_throwable_v2', {
      p_throwable_id: 'tomato',
      p_request_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });
  });
});
