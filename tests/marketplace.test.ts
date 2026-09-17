/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  MARKETPLACE : regression suite
 *
 *  Every case here corresponds to a defect that actually shipped and was found
 *  by hand during the 2026-08-19 audit rounds. The point of this file is that
 *  the next person to touch the marketplace cannot silently reintroduce them.
 *
 *  Each test names the behaviour it locks down, not the implementation.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi } from 'vitest';
import {
  diamondCheckoutOfferConfirmation,
  describeGrant,
  effectivePrice,
  isOwnedRow,
  isMarketplaceItemOwned,
  isUuid,
  safeImageUrl,
  sortMarketplaceItems,
  subscriptionCheckoutOfferConfirmation,
  unavailableReason,
  uuid,
  FALLBACK_CATALOG,
  isVerifiedCheckoutPrecommitRefusal,
  isVerifiedCheckoutTerminalExpiration,
  isVerifiedVipPurchasePrecommitRefusal,
  loadStoreCatalog,
  marketplaceCheckoutReturnUrls,
  marketplaceNativeReturnPath,
  marketplacePurchaseScope,
  readMarketplacePurchaseIntent,
  readOrCreateMarketplacePurchaseIntent,
  retireMarketplacePurchaseIntent,
  storeFetch,
  verifiedStripeCheckoutResponse,
  verifiedStripeCheckoutUrl,
  verifiedVipDiamondPurchaseReceipt,
  verifiedWalletInfo,
  verifiedMarketplaceItems,
  verifiedMarketplaceCardCheckoutStatus,
  EMPTY_WALLET,
  EMPTY_ENTITLEMENTS,
  type GrantSpec,
} from '../src/pages/marketplace/marketplaceShared';
import { supabase } from '../src/lib/supabase';

const STRICT_SERVER_CATALOG = {
  success: true,
  warnings: [],
  diamondCatalogSource: 'database',
  chipPackages: [],
  diamondsPerDollar: 100,
  diamondPackages: FALLBACK_CATALOG.diamondPackages.map((pkg) => ({
    ...pkg,
    priceCents: Math.round(pkg.priceUsd * 100),
    cardCheckoutReady: true,
    diamondCheckoutReady: false,
  })),
  vipPlans: FALLBACK_CATALOG.vipPlans.map((plan) => ({
    ...plan,
    cardCheckoutReady: plan.planKey !== 'lifetime',
    diamondCheckoutReady: true,
  })),
  shopCategories: [
    { name: 'Time Banks', grantType: 'time_bank', grantUnit: 'uses', secondsPerUse: 20 },
    { name: 'Throwables', grantType: 'throwable', grantUnit: 'throws' },
  ],
};

describe('server-authoritative Marketplace quote state', () => {
  const verifiedTimeBank = {
    id: 'fade0000-0000-4000-8000-000000000001',
    club_id: 'fade0000-0000-4000-8000-000000000002',
    name: 'Time Bank Pack',
    category: 'Time Banks',
    item_type: 'time_bank',
    stackable: true,
    grant_spec: { type: 'time_bank' as const, qty: 3 },
    price: 2000,
    effective_price: 1800,
    list_price: 2000,
    available: true,
    availability_reason: null,
    card_checkout_available: false,
    card_checkout_reason: 'unsupported_item_price',
    card_quote: null,
  };

  it('accepts only fully verified, currently deliverable shopper offers', () => {
    expect(verifiedMarketplaceItems([verifiedTimeBank])).toEqual([verifiedTimeBank]);
    expect(verifiedMarketplaceItems([{ ...verifiedTimeBank, available: undefined }])).toBeNull();
    expect(
      verifiedMarketplaceItems([{ ...verifiedTimeBank, effective_price: undefined }])
    ).toBeNull();
    expect(verifiedMarketplaceItems([{ ...verifiedTimeBank, stackable: false }])).toBeNull();
  });

  it('accepts only the canonical ten-use All Throwables offer', () => {
    const throwables = {
      ...verifiedTimeBank,
      id: 'fade0000-0000-4000-8000-000000000003',
      name: 'All Throwables Pack (10)',
      category: 'Throwables',
      item_type: 'throwable',
      grant_spec: { type: 'throwable' as const, qty: 10 },
    };
    expect(verifiedMarketplaceItems([throwables])).toEqual([throwables]);
    expect(
      verifiedMarketplaceItems([
        { ...throwables, name: 'Tomato Pack', grant_spec: { type: 'throwable', qty: 1 } },
      ])
    ).toBeNull();
  });

  it('requires a complete server quote before Card checkout can be advertised', () => {
    expect(
      verifiedMarketplaceItems([
        { ...verifiedTimeBank, card_checkout_available: true, card_quote: null },
      ])
    ).toBeNull();
  });

  it('uses the verified effective price when the server supplies it', () => {
    expect(effectivePrice({ price: 5000, sale_price: 4000, effective_price: 3500 })).toBe(3500);
  });

  it('fails closed when server availability verification is unavailable', () => {
    expect(
      unavailableReason(
        { available: false, availability_reason: 'verification_unavailable' },
        false,
        true
      )
    ).toBe('unavailable');
  });

  it('maps server availability reasons to the existing buyer states', () => {
    expect(
      unavailableReason({ available: false, availability_reason: 'not_yet_available' }, false, true)
    ).toBe('not_yet');
    expect(
      unavailableReason(
        { available: false, availability_reason: 'no_longer_available' },
        false,
        true
      )
    ).toBe('ended');
    expect(
      unavailableReason({ available: false, availability_reason: 'already_owned' }, false, false)
    ).toBe('owned');
  });

  it('sorts sale-priced cards from the same effective price the buyer sees', () => {
    const items = [
      { price: 900, sale_price: 800, effective_price: 750 },
      { price: 700, sale_price: null, effective_price: 700 },
    ];
    expect(items.sort((a, b) => effectivePrice(a) - effectivePrice(b)).map(effectivePrice)).toEqual(
      [700, 750]
    );
  });

  it('sorts both price directions while unavailable inventory stays last', () => {
    const items = [
      { id: 'sold-cheap', club_id: 'c', name: 'Sold Cheap', price: 1, available: false },
      { id: 'live-mid', club_id: 'c', name: 'Live Mid', price: 50, available: true },
      { id: 'live-low', club_id: 'c', name: 'Live Low', price: 10, available: true },
      { id: 'live-high', club_id: 'c', name: 'Live High', price: 90, available: true },
    ];

    expect(sortMarketplaceItems(items, 'price-low').map((item) => item.id)).toEqual([
      'live-low',
      'live-mid',
      'live-high',
      'sold-cheap',
    ]);
    expect(sortMarketplaceItems(items, 'price-high').map((item) => item.id)).toEqual([
      'live-high',
      'live-mid',
      'live-low',
      'sold-cheap',
    ]);
  });
});

describe('account-bound Marketplace mutations', () => {
  it('refuses a switched account before a VIP Diamond purchase reaches the network', async () => {
    const expectedUserId = 'fade0000-0000-4000-8000-000000000010';
    const switchedUserId = 'fade0000-0000-4000-8000-000000000011';
    const sessionSpy = vi.spyOn(supabase.auth, 'getSession').mockResolvedValueOnce({
      data: {
        session: {
          access_token: 'test-token',
          user: { id: switchedUserId },
        },
      },
      error: null,
    } as never);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('The Network Must Not Be Reached'));

    try {
      await expect(
        storeFetch('/api/store/purchase-vip-with-diamonds', {
          body: { plan: 'monthly', idempotencyKey: 'fade0000-0000-4000-8000-000000000012' },
          idempotencyKey: 'fade0000-0000-4000-8000-000000000012',
          expectedUserId,
        })
      ).rejects.toThrow('Your Player Account Changed');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      sessionSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});

/* ── Ownership ───────────────────────────────────────────────────────────── */

describe('isOwnedRow : the single definition of "owned"', () => {
  it('treats an unredeemed row as owned', () => {
    expect(isOwnedRow({ status: 'owned' })).toBe(true);
  });

  it('treats a redeemed row as NOT owned, so consumables can be re-bought', () => {
    // Regression: the purchase API used to check purchase HISTORY, which made
    // every item a lifetime one-shot : a redeemed Time Bank could never be
    // bought again.
    expect(isOwnedRow({ status: 'redeemed' })).toBe(false);
  });

  it('fails safe for an unknown status rather than offering a Buy button', () => {
    // Regression: the Store used status === 'owned' while My Items used
    // status !== 'redeemed'. Any third status made the two disagree, so the
    // Store offered to re-sell something My Items called Owned.
    expect(isOwnedRow({ status: 'pending' })).toBe(true);
    expect(isOwnedRow({ status: null })).toBe(true);
    expect(isOwnedRow({})).toBe(true);
  });
});

/* ── Grant descriptions ──────────────────────────────────────────────────── */

describe('describeGrant : what the card promises the buyer', () => {
  // Copy is Title Case per the 2026-08-23 rebuild: The First Letter Of Every
  // Word On Every Marketplace Page Is Capitalized (Dan, binding).
  it('converts time-bank uses into seconds using the server rate', () => {
    expect(describeGrant({ type: 'time_bank', qty: 3 })).toBe('+60s Table Time (3 Uses)');
  });

  it('honours a server-supplied seconds-per-use instead of a hard-coded 20', () => {
    expect(describeGrant({ type: 'time_bank', qty: 2 }, 30)).toBe('+60s Table Time (2 Uses)');
  });

  it('pluralises correctly', () => {
    expect(describeGrant({ type: 'time_bank', qty: 1 })).toContain('(1 Use)');
    expect(describeGrant({ type: 'throwable', qty: 1 })).toBe(
      '1 Use Across All 49 Table Throwables'
    );
    expect(describeGrant({ type: 'throwable', qty: 5 })).toBe(
      '5 Uses Across All 49 Table Throwables'
    );
  });

  it('never renders a fractional or zero quantity', () => {
    // The DB CHECK forbids these, but the renderer must not produce
    // "+54s Table Time (2.7 Uses)" if one ever slips through.
    expect(describeGrant({ type: 'time_bank', qty: 2.7 })).toBe('+40s Table Time (2 Uses)');
    expect(describeGrant({ type: 'time_bank', qty: 0 })).toBe('+20s Table Time (1 Use)');
  });

  it('returns null for items that grant nothing, so no badge is shown', () => {
    expect(describeGrant({ type: 'none' })).toBeNull();
    expect(describeGrant(null)).toBeNull();
    expect(describeGrant(undefined)).toBeNull();
  });

  it('returns null for an unrecognised grant type instead of throwing', () => {
    expect(describeGrant({ type: 'wormhole' } as unknown as GrantSpec)).toBeNull();
  });

  it('describes permanent unlocks', () => {
    expect(describeGrant({ type: 'emote_pack' })).toMatch(/emote/i);
    expect(describeGrant({ type: 'table_skin' })).toMatch(/theme/i);
    expect(describeGrant({ type: 'avatar' })).toMatch(/avatar/i);
  });
});

/* ── Image safety ────────────────────────────────────────────────────────── */

describe('safeImageUrl : a club admin must not be able to beacon members', () => {
  it('allows https', () => {
    expect(safeImageUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
  });

  it('allows a same-origin absolute path', () => {
    expect(safeImageUrl('/hub/club-arena/images/shop/a.svg')).toBe(
      '/hub/club-arena/images/shop/a.svg'
    );
  });

  it('rejects a protocol-relative URL that only LOOKS same-origin', () => {
    // Regression: '//evil.example/pixel.gif' starts with '/', so it passed the
    // same-origin branch on both client and server and loaded third-party.
    expect(safeImageUrl('//evil.example/pixel.gif')).toBeNull();
  });

  it('rejects http, javascript: and garbage', () => {
    expect(safeImageUrl('http://evil.example/a.png')).toBeNull();
    expect(safeImageUrl('javascript:alert(1)')).toBeNull();
    expect(safeImageUrl('not a url')).toBeNull();
  });

  it('treats blank input as no image', () => {
    expect(safeImageUrl('')).toBeNull();
    expect(safeImageUrl('   ')).toBeNull();
    expect(safeImageUrl(null)).toBeNull();
    expect(safeImageUrl(undefined)).toBeNull();
  });
});

/* ── ids ─────────────────────────────────────────────────────────────────── */

describe('isUuid', () => {
  it('accepts a real uuid in either case', () => {
    expect(isUuid('fade0000-0000-0000-0000-000000000001')).toBe(true);
    expect(isUuid('FADE0000-0000-0000-0000-000000000001')).toBe(true);
  });

  it('rejects legacy numeric club codes and junk', () => {
    expect(isUuid('25450')).toBe(false);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});

describe('uuid : idempotency keys must work without crypto.randomUUID', () => {
  it('produces a v4 uuid', () => {
    expect(uuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('produces distinct values', () => {
    const seen = new Set(Array.from({ length: 200 }, () => uuid()));
    expect(seen.size).toBe(200);
  });

  it('still works when crypto.randomUUID is unavailable (http origins, old Safari)', () => {
    // Regression: callClubArenaApi called crypto.randomUUID() unguarded, so
    // every purchase threw before the fetch on those browsers.
    const original = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', {
        value: { getRandomValues: (a: Uint8Array) => a.map(() => 7) },
        configurable: true,
      });
      expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}/i);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });
});

describe('durable Marketplace purchase identities', () => {
  it('survives a reload-shaped reread, binds exact terms, and rotates only when retired', () => {
    const values = new Map<string, string>();
    const storage = {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    };
    vi.stubGlobal('sessionStorage', storage);
    try {
      const scope = marketplacePurchaseScope(
        'fade0000-0000-4000-8000-000000000001',
        'vip-diamonds',
        'monthly'
      );
      const terms = JSON.stringify({ plan: 'monthly', priceDiamonds: 1999 });
      const first = readOrCreateMarketplacePurchaseIntent(scope, terms);

      expect(first.resumed).toBe(false);
      expect(readMarketplacePurchaseIntent(scope, terms)).toMatchObject({
        requestId: first.requestId,
        payloadKey: terms,
        resumed: true,
      });
      expect(readOrCreateMarketplacePurchaseIntent(scope, terms).requestId).toBe(first.requestId);
      expect(() =>
        readOrCreateMarketplacePurchaseIntent(
          scope,
          JSON.stringify({ plan: 'monthly', priceDiamonds: 2499 })
        )
      ).toThrow(/Different Terms/);

      // An ambiguous outcome does not retire anything: another component
      // runtime sees and reuses the same protected request.
      expect(readOrCreateMarketplacePurchaseIntent(scope, terms).requestId).toBe(first.requestId);
      expect(retireMarketplacePurchaseIntent(scope, first.requestId)).toBe(true);
      expect(readMarketplacePurchaseIntent(scope, terms)).toBeNull();
      expect(readOrCreateMarketplacePurchaseIntent(scope, terms).requestId).not.toBe(
        first.requestId
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('binds the browser scope to a real account, payment channel, and offer', () => {
    expect(() => marketplacePurchaseScope('not-a-user', 'vip-card', 'vip-monthly')).toThrow(
      /Identity Is Invalid/
    );
    expect(() =>
      marketplacePurchaseScope(
        'fade0000-0000-4000-8000-000000000001',
        'diamond-package-card',
        'unsafe offer'
      )
    ).toThrow(/Identity Is Invalid/);
    expect(
      marketplacePurchaseScope('fade0000-0000-4000-8000-000000000001', 'vip-card', 'vip-monthly')
    ).toContain(':vip-card:fade0000-0000-4000-8000-000000000001:vip-monthly');
  });
});

describe('Card checkout return verification', () => {
  const accountId = 'fade0000-0000-4000-8000-000000000001';
  const requestId = 'fade0000-0000-4000-8000-000000000002';
  const sessionId = 'cs_test_verified123';
  const expected = { accountId, requestId, sessionId, type: 'diamonds' as const };
  const complete = {
    success: true,
    data: {
      status: 'complete',
      sessionId,
      requestId,
      accountId,
      type: 'diamonds',
      paymentStatus: 'paid',
      sessionStatus: 'complete',
      orderId: 'order-verified-1',
      walletBalance: 550,
    },
  };

  it('accepts only an exact paid terminal receipt for the protected account and request', () => {
    expect(verifiedMarketplaceCardCheckoutStatus(complete, expected)).toMatchObject({
      status: 'complete',
      sessionId,
      requestId,
      accountId,
      type: 'diamonds',
      paymentStatus: 'paid',
      orderId: 'order-verified-1',
      walletBalance: 550,
    });
    for (const [field, value] of [
      ['sessionId', 'cs_test_different123'],
      ['requestId', 'fade0000-0000-4000-8000-000000000003'],
      ['accountId', 'fade0000-0000-4000-8000-000000000004'],
      ['type', 'subscription'],
    ] as const) {
      expect(
        verifiedMarketplaceCardCheckoutStatus(
          { ...complete, data: { ...complete.data, [field]: value } },
          expected
        )
      ).toBeNull();
    }
    expect(
      verifiedMarketplaceCardCheckoutStatus(
        { ...complete, data: { ...complete.data, status: 'failed', paymentStatus: 'paid' } },
        expected
      )
    ).toBeNull();
  });

  it('keeps a coherent pending receipt recoverable and accepts only unpaid failure', () => {
    expect(
      verifiedMarketplaceCardCheckoutStatus(
        {
          success: true,
          data: {
            ...complete.data,
            status: 'pending',
            paymentStatus: 'unpaid',
            sessionStatus: 'open',
            orderId: null,
            walletBalance: null,
          },
        },
        expected
      )
    ).toMatchObject({ status: 'pending', paymentStatus: 'unpaid', orderId: null });
    expect(
      verifiedMarketplaceCardCheckoutStatus(
        {
          success: true,
          data: {
            ...complete.data,
            status: 'failed',
            paymentStatus: 'unpaid',
            sessionStatus: 'expired',
            orderId: null,
            walletBalance: null,
          },
        },
        expected
      )
    ).toMatchObject({ status: 'failed', paymentStatus: 'unpaid', orderId: null });
  });

  it('routes every success through Marketplace recovery and returns cancellation in place', () => {
    const urls = marketplaceCheckoutReturnUrls(
      'https://smarter.poker/hub/club-arena/table/table-1?seat=2#action',
      'from=table',
      requestId,
      '/hub/club-arena/'
    );
    expect(urls?.successUrl).toContain('https://smarter.poker/hub/club-arena/marketplace?');
    expect(urls?.successUrl).toContain('session_id={CHECKOUT_SESSION_ID}');
    expect(urls?.successUrl).toContain(`checkout_request_id=${requestId}`);
    expect(new URL(urls?.successUrl || '').searchParams.get('next')).toBe(
      '/table/table-1?seat=2#action'
    );
    expect(urls?.cancelUrl).toContain('/hub/club-arena/table/table-1?');
    expect(new URL(urls?.cancelUrl || '').searchParams.get('seat')).toBe('2');
    expect(new URL(urls?.cancelUrl || '').searchParams.get('purchase')).toBe('canceled');
    expect(new URL(urls?.cancelUrl || '').hash).toBe('#action');

    const rootUrls = marketplaceCheckoutReturnUrls(
      'https://smarter.poker/hub/club-arena',
      'from=home',
      requestId,
      '/hub/club-arena/'
    );
    expect(new URL(rootUrls?.successUrl || '').searchParams.has('next')).toBe(false);

    const boundaryUrls = marketplaceCheckoutReturnUrls(
      'https://smarter.poker/hub/club-arena/marketplace-evil?seat=4',
      'from=table',
      requestId,
      '/hub/club-arena/'
    );
    expect(new URL(boundaryUrls?.successUrl || '').searchParams.get('next')).toBe(
      '/marketplace-evil?seat=4'
    );

    const marketplaceUrls = marketplaceCheckoutReturnUrls(
      'https://smarter.poker/hub/club-arena/marketplace?tab=diamonds&keep=1&purchase=stale&session_id=stale#market-anchor',
      'tab=membership',
      requestId,
      '/hub/club-arena/'
    );
    const marketplaceSuccess = new URL(marketplaceUrls?.successUrl || '');
    expect(marketplaceSuccess.searchParams.get('tab')).toBe('membership');
    expect(marketplaceSuccess.searchParams.get('keep')).toBe('1');
    expect(marketplaceSuccess.searchParams.get('purchase')).toBe('success');
    expect(marketplaceSuccess.searchParams.get('session_id')).toBe('{CHECKOUT_SESSION_ID}');
    expect(marketplaceSuccess.searchParams.get('checkout_request_id')).toBe(requestId);
    expect(marketplaceSuccess.hash).toBe('#market-anchor');
    const marketplaceCancel = new URL(marketplaceUrls?.cancelUrl || '');
    expect(marketplaceCancel.searchParams.get('tab')).toBe('membership');
    expect(marketplaceCancel.searchParams.get('keep')).toBe('1');
    expect(marketplaceCancel.searchParams.get('purchase')).toBe('canceled');
    expect(marketplaceCancel.searchParams.has('session_id')).toBe(false);
    expect(marketplaceCancel.searchParams.get('checkout_request_id')).toBe(requestId);
    expect(marketplaceCancel.hash).toBe('#market-anchor');
  });

  it('preserves the latest native route query and hash without a stale session receipt', () => {
    const path = marketplaceNativeReturnPath(
      'https://smarter.poker/hub/club-arena/marketplace?tab=diamonds&keep=1&purchase=stale&session_id=old&checkout_request_id=old#market-anchor',
      'tab=membership',
      'canceled',
      requestId
    );
    const parsed = new URL(path || '', 'https://smarter.poker');
    expect(parsed.pathname).toBe('/hub/club-arena/marketplace');
    expect(parsed.searchParams.get('tab')).toBe('membership');
    expect(parsed.searchParams.get('keep')).toBe('1');
    expect(parsed.searchParams.get('purchase')).toBe('canceled');
    expect(parsed.searchParams.has('session_id')).toBe(false);
    expect(parsed.searchParams.get('checkout_request_id')).toBe(requestId);
    expect(parsed.hash).toBe('#market-anchor');
  });
});

describe('wallet response verification', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');

  it('loads only coherent inactive, recurring, or Lifetime VIP state', () => {
    expect(
      verifiedWalletInfo({ diamonds: 0, isVip: false, vipTier: null, vipExpiresAt: null }, now)
    ).toMatchObject({ diamonds: 0, isVip: false, vipTier: null, loaded: true });
    expect(
      verifiedWalletInfo(
        {
          diamonds: 1999,
          isVip: true,
          vipTier: 'monthly',
          vipExpiresAt: '2026-10-15T12:00:00Z',
        },
        now
      )
    ).toMatchObject({ isVip: true, vipTier: 'monthly', loaded: true });
    expect(
      verifiedWalletInfo(
        {
          diamonds: 49900,
          isVip: false,
          vipTier: 'yearly',
          vipExpiresAt: '2026-09-14T12:00:00+00:00',
        },
        now
      )
    ).toMatchObject({ isVip: false, vipTier: 'yearly', loaded: true });
    expect(
      verifiedWalletInfo(
        { diamonds: 50, isVip: true, vipTier: 'lifetime', vipExpiresAt: null },
        now
      )
    ).toMatchObject({ isVip: true, vipTier: 'lifetime', loaded: true });
  });

  it('rejects malformed balances, coerced VIP flags, and incoherent tier or expiry state', () => {
    const inactive = { diamonds: 10, isVip: false, vipTier: null, vipExpiresAt: null };
    expect(verifiedWalletInfo({ ...inactive, diamonds: -1 }, now)).toBeNull();
    expect(verifiedWalletInfo({ ...inactive, diamonds: 1.5 }, now)).toBeNull();
    expect(verifiedWalletInfo({ ...inactive, diamonds: '10' }, now)).toBeNull();
    expect(verifiedWalletInfo({ ...inactive, isVip: 0 }, now)).toBeNull();
    expect(verifiedWalletInfo({ ...inactive, vipTier: 'founder' }, now)).toBeNull();
    expect(verifiedWalletInfo({ ...inactive, isVip: true }, now)).toBeNull();
    expect(
      verifiedWalletInfo(
        {
          diamonds: 10,
          isVip: true,
          vipTier: 'lifetime',
          vipExpiresAt: '2099-01-01T00:00:00Z',
        },
        now
      )
    ).toBeNull();
    expect(
      verifiedWalletInfo(
        {
          diamonds: 10,
          isVip: true,
          vipTier: 'monthly',
          vipExpiresAt: '2026-09-14T12:00:00Z',
        },
        now
      )
    ).toBeNull();
    expect(
      verifiedWalletInfo(
        {
          diamonds: 10,
          isVip: false,
          vipTier: 'yearly',
          vipExpiresAt: '2026-10-15T12:00:00Z',
        },
        now
      )
    ).toBeNull();
    expect(
      verifiedWalletInfo(
        {
          diamonds: 10,
          isVip: true,
          vipTier: 'monthly',
          vipExpiresAt: '2026-10-15T12:00:00',
        },
        now
      )
    ).toBeNull();
  });
});

describe('VIP Diamond purchase receipt verification', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');
  const accountId = 'fade0000-0000-4000-8000-000000000001';
  const requestId = 'fade0000-0000-4000-8000-000000000002';
  const expectedMonthly = { accountId, requestId, plan: 'monthly' as const, cost: 1999 };
  const monthlyReceipt = {
    success: true,
    accountId,
    requestId,
    idempotent: false,
    duplicate: false,
    isVip: true,
    plan: 'monthly',
    tier: 'monthly',
    cost: 1999,
    daysAdded: 30,
    expiresAt: '2026-10-15T12:00:00Z',
    newBalance: 8001,
  };

  it('accepts only the exact successful plan, cost, VIP, balance, replay, and expiry receipt', () => {
    expect(verifiedVipDiamondPurchaseReceipt(monthlyReceipt, expectedMonthly, now)).toEqual(
      monthlyReceipt
    );
    expect(
      verifiedVipDiamondPurchaseReceipt(
        { ...monthlyReceipt, idempotent: true, duplicate: true },
        expectedMonthly,
        now
      )
    ).not.toBeNull();
    expect(
      verifiedVipDiamondPurchaseReceipt({ ...monthlyReceipt, tier: 'yearly' }, expectedMonthly, now)
    ).not.toBeNull();
    expect(
      verifiedVipDiamondPurchaseReceipt(
        { ...monthlyReceipt, tier: 'lifetime', expiresAt: null },
        expectedMonthly,
        now
      )
    ).toBeNull();
    expect(
      verifiedVipDiamondPurchaseReceipt(
        {
          ...monthlyReceipt,
          idempotent: true,
          duplicate: true,
          expiresAt: '2026-09-14T12:00:00Z',
        },
        expectedMonthly,
        now
      )
    ).not.toBeNull();
    expect(
      verifiedVipDiamondPurchaseReceipt(
        {
          ...monthlyReceipt,
          plan: 'lifetime',
          tier: 'lifetime',
          cost: 49900,
          daysAdded: null,
          expiresAt: null,
          newBalance: 0,
        },
        { accountId, requestId, plan: 'lifetime', cost: 49900 },
        now
      )
    ).not.toBeNull();
  });

  it('fails closed on every receipt field that gives success its meaning', () => {
    expect(
      verifiedVipDiamondPurchaseReceipt({ ...monthlyReceipt, success: false }, expectedMonthly, now)
    ).toBeNull();
    expect(
      verifiedVipDiamondPurchaseReceipt({ ...monthlyReceipt, isVip: false }, expectedMonthly, now)
    ).toBeNull();
    expect(
      verifiedVipDiamondPurchaseReceipt({ ...monthlyReceipt, plan: 'yearly' }, expectedMonthly, now)
    ).toBeNull();
    expect(
      verifiedVipDiamondPurchaseReceipt(
        {
          ...monthlyReceipt,
          plan: 'yearly',
          tier: 'monthly',
          cost: 19999,
          daysAdded: 365,
        },
        { accountId, requestId, plan: 'yearly', cost: 19999 },
        now
      )
    ).toBeNull();
    expect(
      verifiedVipDiamondPurchaseReceipt({ ...monthlyReceipt, cost: 1 }, expectedMonthly, now)
    ).toBeNull();
    expect(
      verifiedVipDiamondPurchaseReceipt({ ...monthlyReceipt, newBalance: -1 }, expectedMonthly, now)
    ).toBeNull();
    expect(
      verifiedVipDiamondPurchaseReceipt(
        { ...monthlyReceipt, accountId: 'fade0000-0000-4000-8000-000000000003' },
        expectedMonthly,
        now
      )
    ).toBeNull();
    expect(
      verifiedVipDiamondPurchaseReceipt(
        { ...monthlyReceipt, requestId: 'fade0000-0000-4000-8000-000000000004' },
        expectedMonthly,
        now
      )
    ).toBeNull();
    expect(
      verifiedVipDiamondPurchaseReceipt(
        { ...monthlyReceipt, idempotent: true, duplicate: false },
        expectedMonthly,
        now
      )
    ).toBeNull();
    expect(
      verifiedVipDiamondPurchaseReceipt({ ...monthlyReceipt, daysAdded: 365 }, expectedMonthly, now)
    ).toBeNull();
    expect(
      verifiedVipDiamondPurchaseReceipt(
        { ...monthlyReceipt, expiresAt: '2026-10-15T12:00:00' },
        expectedMonthly,
        now
      )
    ).toBeNull();
    expect(
      verifiedVipDiamondPurchaseReceipt(
        { ...monthlyReceipt, expiresAt: '2026-09-15T11:59:59Z' },
        expectedMonthly,
        now
      )
    ).toBeNull();
  });
});

describe('Card checkout response and request retirement verification', () => {
  it('accepts only a string HTTPS redirect on the exact Stripe Checkout origin', () => {
    const valid =
      'https://checkout.stripe.com/c/pay/cs_test_AbC123?prefilled_email=test%40example.com';
    expect(verifiedStripeCheckoutUrl(valid)).toBe(valid);
    expect(verifiedStripeCheckoutUrl(new URL(valid))).toBeNull();
    expect(verifiedStripeCheckoutUrl(` ${valid}`)).toBeNull();
    expect(verifiedStripeCheckoutUrl('http://checkout.stripe.com/c/pay/cs_test_123')).toBeNull();
    expect(
      verifiedStripeCheckoutUrl('https://checkout.stripe.com.evil.example/c/pay/x')
    ).toBeNull();
    expect(verifiedStripeCheckoutUrl('https://user@checkout.stripe.com/c/pay/x')).toBeNull();
    expect(verifiedStripeCheckoutUrl('https://checkout.stripe.com:444/c/pay/x')).toBeNull();
  });

  it('binds the Stripe session and URL to the exact durable Card request', () => {
    const requestId = 'fade0000-0000-4000-8000-000000000001';
    const offer = diamondCheckoutOfferConfirmation('fade0000-0000-4000-8000-000000000002', {
      id: 'starter',
      name: 'Starter',
      diamonds: 500,
      bonus: 50,
      priceUsd: 3.99,
      priceCents: 399,
      cardCheckoutReady: true,
      diamondCheckoutReady: false,
    });
    expect(offer).not.toBeNull();
    if (!offer) throw new Error('Test Offer Was Not Built');
    const sessionId = 'cs_test_AbC123';
    const url = `https://checkout.stripe.com/c/pay/${sessionId}`;
    const response = {
      success: true,
      duplicate: false,
      data: { session_id: sessionId, request_id: requestId, url, offer },
    };

    expect(verifiedStripeCheckoutResponse(response, requestId, offer)).toEqual({
      url,
      sessionId,
      requestId,
      duplicate: false,
      offer,
    });
    expect(
      verifiedStripeCheckoutResponse({ ...response, duplicate: true }, requestId, offer)?.duplicate
    ).toBe(true);
    expect(
      verifiedStripeCheckoutResponse(
        { ...response, data: { ...response.data, request_id: uuid() } },
        requestId,
        offer
      )
    ).toBeNull();
    expect(
      verifiedStripeCheckoutResponse(
        { ...response, data: { ...response.data, session_id: 'cs_test_short' } },
        requestId,
        offer
      )
    ).toBeNull();
    expect(
      verifiedStripeCheckoutResponse(
        { ...response, data: { ...response.data, url: `${url}Different` } },
        requestId,
        offer
      )
    ).toBeNull();
    expect(
      verifiedStripeCheckoutResponse(
        {
          ...response,
          data: { ...response.data, offer: { ...offer, totalCents: offer.totalCents + 1 } },
        },
        requestId,
        offer
      )
    ).toBeNull();
    expect(
      verifiedStripeCheckoutResponse({ ...response, duplicate: 'false' }, requestId, offer)
    ).toBeNull();
    expect(
      verifiedStripeCheckoutResponse({ ...response, success: 'true' }, requestId, offer)
    ).toBeNull();
  });

  it('builds only exact account-bound Diamond and subscription confirmations', () => {
    const accountId = 'fade0000-0000-4000-8000-000000000010';
    expect(
      diamondCheckoutOfferConfirmation(accountId, {
        id: 'starter',
        name: 'Starter',
        diamonds: 500,
        bonus: 50,
        priceUsd: 3.99,
        priceCents: 399,
        cardCheckoutReady: true,
        diamondCheckoutReady: false,
      })
    ).toMatchObject({
      accountId,
      type: 'diamonds',
      totalCents: 399,
      totalDiamonds: 500,
      totalBonus: 50,
    });
    expect(
      diamondCheckoutOfferConfirmation(accountId, {
        id: 'starter',
        name: 'Starter',
        diamonds: 500,
        bonus: 50,
        priceUsd: 3.99,
        priceCents: 398,
      })
    ).toBeNull();
    expect(
      subscriptionCheckoutOfferConfirmation(accountId, {
        id: 'vip-monthly',
        planKey: 'monthly',
        checkoutPlan: 'vip-monthly',
        cardCheckoutReady: true,
        diamondCheckoutReady: true,
        name: 'Monthly VIP',
        period: 'Per Month',
        priceUsd: 19.99,
        priceDiamonds: 1999,
        features: ['Everything Included'],
      })
    ).toEqual({
      version: 1,
      accountId,
      type: 'subscription',
      currency: 'usd',
      plan: 'monthly',
      interval: 'month',
      quantity: 1,
      unitCents: 1999,
      totalCents: 1999,
    });
  });

  it('rotates a VIP Diamond key only after a route-matched definitive precommit refusal', () => {
    const responsePath = '/api/store/purchase-vip-with-diamonds';
    const expected = {
      accountId: 'fade0000-0000-4000-8000-000000000001',
      requestId: 'fade0000-0000-4000-8000-000000000002',
    };
    expect(
      isVerifiedVipPurchasePrecommitRefusal(
        {
          responseReceived: true,
          responsePath,
          status: 400,
          data: { success: false, ...expected, code: 'INSUFFICIENT_DIAMONDS' },
        },
        expected
      )
    ).toBe(true);
    expect(
      isVerifiedVipPurchasePrecommitRefusal(
        {
          responseReceived: true,
          responsePath,
          status: 409,
          data: { success: false, ...expected, code: 'OFFER_PRICE_CHANGED' },
        },
        expected
      )
    ).toBe(true);
    expect(
      isVerifiedVipPurchasePrecommitRefusal(
        {
          responseReceived: true,
          responsePath,
          status: 409,
          data: { success: false, ...expected, code: 'IDEMPOTENCY_CONFLICT' },
        },
        expected
      )
    ).toBe(false);
    expect(isVerifiedVipPurchasePrecommitRefusal(new Error('network lost'), expected)).toBe(false);
    expect(
      isVerifiedVipPurchasePrecommitRefusal(
        { responseReceived: true, responsePath, status: '400' },
        expected
      )
    ).toBe(false);
    expect(
      isVerifiedVipPurchasePrecommitRefusal(
        { responseReceived: true, responsePath, status: 500 },
        expected
      )
    ).toBe(false);
    expect(
      isVerifiedVipPurchasePrecommitRefusal(
        {
          responseReceived: true,
          responsePath,
          status: 409,
          data: { duplicate: true, error: 'A VIP purchase is already in progress.' },
        },
        expected
      )
    ).toBe(false);
    expect(
      isVerifiedVipPurchasePrecommitRefusal(
        {
          responseReceived: true,
          responsePath: '/api/other-route',
          status: 400,
        },
        expected
      )
    ).toBe(false);
    expect(
      isVerifiedVipPurchasePrecommitRefusal(
        {
          responseReceived: true,
          responsePath,
          status: 409,
          data: {
            success: false,
            ...expected,
            accountId: 'fade0000-0000-4000-8000-000000000003',
            code: 'ALREADY_LIFETIME',
          },
        },
        expected
      )
    ).toBe(false);
    expect(
      isVerifiedVipPurchasePrecommitRefusal(
        { checkoutPrecommitRefusal: true },
        { ...expected, requestId: 'not-a-uuid' }
      )
    ).toBe(false);
  });

  it('rotates a Card key only after a route-matched definitive precommit refusal', () => {
    const responsePath = '/api/store/create-checkout-session';
    expect(
      isVerifiedCheckoutPrecommitRefusal({ responseReceived: true, responsePath, status: 422 })
    ).toBe(true);
    expect(
      isVerifiedCheckoutPrecommitRefusal({
        responseReceived: true,
        responsePath,
        status: 409,
        data: { error: { code: 'IDEMPOTENCY_CONFLICT' } },
      })
    ).toBe(false);
    expect(
      isVerifiedCheckoutPrecommitRefusal({
        responseReceived: true,
        responsePath,
        status: 409,
        data: { error: { code: 'OFFER_CONFIRMATION_MISMATCH' } },
      })
    ).toBe(true);
    expect(isVerifiedCheckoutPrecommitRefusal({ checkoutPrecommitRefusal: true })).toBe(true);
    expect(
      isVerifiedCheckoutTerminalExpiration({
        responseReceived: true,
        responsePath,
        status: 409,
        data: { error: { code: 'CHECKOUT_EXPIRED' } },
      })
    ).toBe(true);
    expect(
      isVerifiedCheckoutTerminalExpiration({
        responseReceived: true,
        responsePath,
        status: 409,
        data: { error: { code: 'IDEMPOTENCY_CONFLICT' } },
      })
    ).toBe(false);
    expect(isVerifiedCheckoutPrecommitRefusal(new Error('timeout'))).toBe(false);
    expect(
      isVerifiedCheckoutPrecommitRefusal({ responseReceived: true, responsePath, status: '422' })
    ).toBe(false);
    expect(
      isVerifiedCheckoutPrecommitRefusal({ responseReceived: true, responsePath, status: 429 })
    ).toBe(false);
    expect(
      isVerifiedCheckoutPrecommitRefusal({ responseReceived: true, responsePath, status: 503 })
    ).toBe(false);
    expect(
      isVerifiedCheckoutPrecommitRefusal({
        responseReceived: true,
        responsePath,
        status: 409,
        data: { code: 'CHECKOUT_PROCESSING' },
      })
    ).toBe(false);
  });
});

/* ── Catalog fallback ────────────────────────────────────────────────────── */

describe('FALLBACK_CATALOG : used when /store-catalog is unreachable', () => {
  it('maps every category to its REAL grant type, never a blanket "none"', () => {
    // Regression: the fallback mapped every category to grantType 'none'. The
    // admin form sent that verbatim, the server honoured it, and a 5,000-chip
    // "Time Bank" was created that granted nothing while displaying normally.
    const byName = Object.fromEntries(FALLBACK_CATALOG.shopCategories.map((c) => [c.name, c]));
    expect(byName['Time Banks'].grantType).toBe('time_bank');
    expect(byName['Throwables'].grantType).toBe('throwable');
    expect(Object.values(byName).every((category) => category.grantType !== 'none')).toBe(true);
    expect(Object.keys(byName).sort()).toEqual(['Throwables', 'Time Banks']);
  });

  it('marks itself as NOT server-truth so callers can avoid asserting a grant', () => {
    expect(FALLBACK_CATALOG.fromServer).toBe(false);
  });

  it('ships usable diamond and VIP tables', () => {
    expect(FALLBACK_CATALOG.diamondPackages.length).toBeGreaterThan(0);
    expect(FALLBACK_CATALOG.vipPlans.length).toBeGreaterThan(0);
  });

  it('offers NO way to buy chips : diamonds never convert to chips', () => {
    // Product rule: diamonds are the global purchasable currency, chips are a
    // per-club gambling balance, and the two must never convert. The path was
    // removed on 2026-08-19 and EXECUTE on fn_purchase_chips /
    // fn_purchase_club_chips is revoked from every role, service_role included.
    //
    // This test previously asserted chipPackages.length > 0 : it ENFORCED the
    // forbidden path, and would have blocked anyone trying to remove it.
    //
    // The catalog loader falls back to bundled tables whenever the server sends
    // an empty list, so leaving a populated chip table in the client would have
    // silently restored the offer the server had just withdrawn.
    expect('chipPackages' in FALLBACK_CATALOG).toBe(false);
    expect(JSON.stringify(FALLBACK_CATALOG)).not.toMatch(/chips/i);
  });

  it('quantity-bearing categories declare a unit so the admin form asks for one', () => {
    const qtyCats = FALLBACK_CATALOG.shopCategories.filter((c) =>
      ['time_bank', 'throwable'].includes(c.grantType)
    );
    expect(qtyCats.every((c) => !!c.grantUnit)).toBe(true);
  });
});

describe('live Marketplace catalog verification', () => {
  it('does not turn an aborted catalog authorization into a fallback result', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      loadStoreCatalog({ force: true, signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('never marks fallback, drift, warnings, or partially malformed server data as verified', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });
      expect((await loadStoreCatalog({ force: true })).fromServer).toBe(false);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...STRICT_SERVER_CATALOG,
          vipPlans: STRICT_SERVER_CATALOG.vipPlans.map((plan) =>
            plan.planKey === 'monthly' ? { ...plan, priceUsd: 29.99, priceDiamonds: 2999 } : plan
          ),
        }),
      });
      expect((await loadStoreCatalog({ force: true })).fromServer).toBe(false);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...STRICT_SERVER_CATALOG,
          shopCategories: STRICT_SERVER_CATALOG.shopCategories.slice(0, 1),
        }),
      });
      expect((await loadStoreCatalog({ force: true })).fromServer).toBe(false);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...STRICT_SERVER_CATALOG,
          diamondPackages: [...STRICT_SERVER_CATALOG.diamondPackages, { id: 'invalid' }],
        }),
      });
      expect((await loadStoreCatalog({ force: true })).fromServer).toBe(false);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...STRICT_SERVER_CATALOG,
          warnings: ['vip-monthly price drift'],
        }),
      });
      expect((await loadStoreCatalog({ force: true })).fromServer).toBe(false);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...STRICT_SERVER_CATALOG,
          diamondCatalogSource: 'fallback',
        }),
      });
      expect((await loadStoreCatalog({ force: true })).fromServer).toBe(false);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...STRICT_SERVER_CATALOG,
          shopCategories: [
            ...STRICT_SERVER_CATALOG.shopCategories,
            STRICT_SERVER_CATALOG.shopCategories[0],
          ],
        }),
      });
      expect((await loadStoreCatalog({ force: true })).fromServer).toBe(false);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...STRICT_SERVER_CATALOG,
          shopCategories: STRICT_SERVER_CATALOG.shopCategories.map((category, index) =>
            index === 1 ? { ...category, name: 'Unknown Category' } : category
          ),
        }),
      });
      expect((await loadStoreCatalog({ force: true })).fromServer).toBe(false);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...STRICT_SERVER_CATALOG,
          shopCategories: STRICT_SERVER_CATALOG.shopCategories.map((category, index) =>
            index === 0 ? { ...category, grantUnit: 'seconds' } : category
          ),
        }),
      });
      expect((await loadStoreCatalog({ force: true })).fromServer).toBe(false);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => STRICT_SERVER_CATALOG,
      });
      expect((await loadStoreCatalog({ force: true })).fromServer).toBe(true);

      fetchMock.mockRejectedValueOnce(new Error('strict refresh unavailable'));
      expect((await loadStoreCatalog({ force: true })).fromServer).toBe(false);

      fetchMock.mockRejectedValueOnce(new Error('ordinary refresh unavailable'));
      expect((await loadStoreCatalog()).fromServer).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(12);
      expect(fetchMock).toHaveBeenCalledWith('/api/club-arena/store-catalog?strict=1', {
        signal: undefined,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('permanent marketplace ownership', () => {
  const entitlements = {
    ...EMPTY_ENTITLEMENTS,
    loaded: true,
    emotePack: true,
    themes: ['neon-blue'],
    avatars: ['vip-people-007'],
  };

  it('blocks a theme already present in the category entitlement ledger', () => {
    expect(
      isMarketplaceItemOwned(
        {
          id: 'theme-item',
          club_id: 'club',
          name: 'Neon',
          price: 100,
          grant_spec: { type: 'table_skin', theme_id: 'neon' },
        },
        entitlements
      )
    ).toBe(true);
  });

  it('blocks an owned avatar and permanent emote pack after activation', () => {
    expect(
      isMarketplaceItemOwned(
        {
          id: 'avatar-item',
          club_id: 'club',
          name: 'Avatar',
          price: 100,
          grant_spec: { type: 'avatar', avatar_id: 'vip-people-007' },
        },
        entitlements
      )
    ).toBe(true);
    expect(
      isMarketplaceItemOwned(
        {
          id: 'emoji-item',
          club_id: 'club',
          name: 'Emoji',
          price: 100,
          grant_spec: { type: 'emote_pack' },
        },
        entitlements
      )
    ).toBe(true);
  });

  it('does not mistake consumable balances for permanent ownership', () => {
    expect(
      isMarketplaceItemOwned(
        {
          id: 'throws',
          club_id: 'club',
          name: 'Throws',
          price: 10,
          grant_spec: { type: 'throwable', qty: 5 },
        },
        { ...entitlements, throwables: 5 }
      )
    ).toBe(false);
  });
});

/* ── Wallet / entitlement defaults ───────────────────────────────────────── */

describe('empty states', () => {
  it('an unloaded wallet does not claim the player has zero diamonds', () => {
    // Regression: a failed balance read rendered "You have 0 diamonds" and
    // silently disabled every buy button with no explanation.
    expect(EMPTY_WALLET.loaded).toBe(false);
    expect(EMPTY_WALLET.error).toBeNull();
  });

  it('constants are frozen so one consumer cannot poison every later mount', () => {
    expect(Object.isFrozen(EMPTY_WALLET)).toBe(true);
    expect(Object.isFrozen(EMPTY_ENTITLEMENTS)).toBe(true);
  });

  it('unloaded entitlements report nothing held', () => {
    expect(EMPTY_ENTITLEMENTS.loaded).toBe(false);
    expect(EMPTY_ENTITLEMENTS.timeBankSeconds).toBe(0);
    expect(EMPTY_ENTITLEMENTS.throwables).toBe(0);
    expect(EMPTY_ENTITLEMENTS.avatars).toEqual([]);
    expect(EMPTY_ENTITLEMENTS.avatarCosmetics).toEqual([]);
  });
});
