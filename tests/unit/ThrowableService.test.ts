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
    expect(rpc).toHaveBeenCalledWith('fn_use_throwable', { p_throwable_id: 'beer' });
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
