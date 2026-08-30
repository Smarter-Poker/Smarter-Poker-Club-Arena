import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearTableStudioCheckoutReturnUrl,
  readTableStudioCheckoutIntent,
  rememberTableStudioCheckoutIntent,
  tableStudioCheckoutResult,
} from '../../src/lib/tableStudioCheckoutResume';

describe('Table Studio checkout resume', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/table/abc?club=club-1');
    vi.useRealTimers();
  });

  it('retains only the identity of the design, not client-owned price data', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    rememberTableStudioCheckoutIntent({
      userId: 'user-1',
      tab: 'background',
      assetId: 'place_monaco',
    });

    expect(readTableStudioCheckoutIntent('user-1')).toEqual({
      userId: 'user-1',
      tab: 'background',
      assetId: 'place_monaco',
      createdAt: 1_000_000,
    });
    expect(window.sessionStorage.getItem('table-studio-checkout-intent:v1')).not.toContain('price');
    vi.restoreAllMocks();
  });

  it('rejects another account, malformed data, and expired hand-offs', () => {
    rememberTableStudioCheckoutIntent({
      userId: 'user-1',
      tab: 'cards',
      assetId: 'gold',
    });
    expect(readTableStudioCheckoutIntent('user-2')).toBeNull();

    window.sessionStorage.setItem('table-studio-checkout-intent:v1', '{broken');
    expect(readTableStudioCheckoutIntent('user-1')).toBeNull();

    window.sessionStorage.setItem(
      'table-studio-checkout-intent:v1',
      JSON.stringify({
        userId: 'user-1',
        tab: 'table',
        assetId: 'neon_city',
        createdAt: Date.now() - 3 * 60 * 60 * 1_000,
      })
    );
    expect(readTableStudioCheckoutIntent('user-1')).toBeNull();
  });

  it('recognizes only Table Studio Stripe returns and preserves unrelated route keys', () => {
    expect(tableStudioCheckoutResult('?from=table-studio&purchase=success')).toBe('success');
    expect(tableStudioCheckoutResult('?from=table-studio&purchase=canceled')).toBe('canceled');
    expect(tableStudioCheckoutResult('?from=vip&purchase=success')).toBeNull();

    window.history.replaceState(
      {},
      '',
      '/table/abc?club=club-1&game=plo&from=table-studio&purchase=success#seat-4'
    );
    clearTableStudioCheckoutReturnUrl();

    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      '/table/abc?club=club-1&game=plo#seat-4'
    );
  });
});
