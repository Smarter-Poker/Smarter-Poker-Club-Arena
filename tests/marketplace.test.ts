/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  MARKETPLACE — regression suite
 *
 *  Every case here corresponds to a defect that actually shipped and was found
 *  by hand during the 2026-08-19 audit rounds. The point of this file is that
 *  the next person to touch the marketplace cannot silently reintroduce them.
 *
 *  Each test names the behaviour it locks down, not the implementation.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'vitest';
import {
  describeGrant,
  isOwnedRow,
  isMarketplaceItemOwned,
  isUuid,
  safeImageUrl,
  uuid,
  FALLBACK_CATALOG,
  EMPTY_WALLET,
  EMPTY_ENTITLEMENTS,
  type GrantSpec,
} from '../src/pages/marketplace/marketplaceShared';

/* ── Ownership ───────────────────────────────────────────────────────────── */

describe('isOwnedRow — the single definition of "owned"', () => {
  it('treats an unredeemed row as owned', () => {
    expect(isOwnedRow({ status: 'owned' })).toBe(true);
  });

  it('treats a redeemed row as NOT owned, so consumables can be re-bought', () => {
    // Regression: the purchase API used to check purchase HISTORY, which made
    // every item a lifetime one-shot — a redeemed Time Bank could never be
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

describe('describeGrant — what the card promises the buyer', () => {
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

describe('safeImageUrl — a club admin must not be able to beacon members', () => {
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

describe('uuid — idempotency keys must work without crypto.randomUUID', () => {
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

/* ── Catalog fallback ────────────────────────────────────────────────────── */

describe('FALLBACK_CATALOG — used when /store-catalog is unreachable', () => {
  it('maps every category to its REAL grant type, never a blanket "none"', () => {
    // Regression: the fallback mapped every category to grantType 'none'. The
    // admin form sent that verbatim, the server honoured it, and a 5,000-chip
    // "Time Bank" was created that granted nothing while displaying normally.
    const byName = Object.fromEntries(FALLBACK_CATALOG.shopCategories.map((c) => [c.name, c]));
    expect(byName['Time Banks'].grantType).toBe('time_bank');
    expect(byName['Throwables'].grantType).toBe('throwable');
    expect(byName['Emotes'].grantType).toBe('emote_pack');
    expect(byName['Table Skins'].grantType).toBe('table_skin');
    expect(byName['Avatars'].grantType).toBe('avatar');
    expect(Object.values(byName).every((category) => category.grantType !== 'none')).toBe(true);
  });

  it('marks itself as NOT server-truth so callers can avoid asserting a grant', () => {
    expect(FALLBACK_CATALOG.fromServer).toBe(false);
  });

  it('ships usable diamond and VIP tables', () => {
    expect(FALLBACK_CATALOG.diamondPackages.length).toBeGreaterThan(0);
    expect(FALLBACK_CATALOG.vipPlans.length).toBeGreaterThan(0);
  });

  it('offers NO way to buy chips — diamonds never convert to chips', () => {
    // Product rule: diamonds are the global purchasable currency, chips are a
    // per-club gambling balance, and the two must never convert. The path was
    // removed on 2026-08-19 and EXECUTE on fn_purchase_chips /
    // fn_purchase_club_chips is revoked from every role, service_role included.
    //
    // This test previously asserted chipPackages.length > 0 — it ENFORCED the
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
