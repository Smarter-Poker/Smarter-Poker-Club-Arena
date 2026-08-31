/**
 * CROSS-DEVICE LOBBY FILTERS — a remote blob is not more trustworthy
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Filters now live in the database so they follow the player between devices
 * (Dan 2026-08-30: "until changed by the user" was only ever true on one
 * browser). The tempting shortcut is to trust the row because "we wrote it".
 *
 * That is wrong for the same reason the localStorage read is validated: a row
 * written by an OLDER build can carry a game type or a feature key this build
 * no longer defines. Filtering on a key that cannot match produces an empty
 * lobby with no explanation and no way back except Reset - the exact failure
 * the local validation was hardened against. Both reads therefore go through
 * one door, sanitizeStore.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeStore } from '../../src/components/lobby/AdvancedFilters';
import { FILTER_SPECS, emptyFilterValue } from '../../src/components/lobby/advancedFilterSpec';

describe('sanitizeStore is the one door for local AND remote filter reads', () => {
  it('drops a game type this build no longer defines', () => {
    const clean = sanitizeStore({ NOT_A_GAME: emptyFilterValue(FILTER_SPECS.HOLDEM) } as never);
    expect(Object.keys(clean)).not.toContain('NOT_A_GAME');
  });

  it('drops feature keys an older build wrote, keeping the rest of the tab', () => {
    const base = emptyFilterValue(FILTER_SPECS.HOLDEM);
    const clean = sanitizeStore({
      HOLDEM: { ...base, mustHave: ['a_feature_that_no_longer_exists'] },
    });
    expect(clean.HOLDEM?.mustHave).toEqual([]);
    // The tab itself survives - one bad key must not discard a whole tab.
    expect(clean.HOLDEM).toBeTruthy();
  });

  it('repairs an inverted range instead of letting it freeze the lobby', () => {
    const spec = FILTER_SPECS.HOLDEM;
    const base = emptyFilterValue(spec);
    const clean = sanitizeStore({
      HOLDEM: { ...base, rangeMin: spec.range.max, rangeMax: spec.range.min },
    });
    expect(clean.HOLDEM!.rangeMin).toBeLessThanOrEqual(clean.HOLDEM!.rangeMax);
  });

  it('survives junk of the wrong shape entirely', () => {
    // JSON.stringify writes NaN as null; an older row really can contain it.
    expect(sanitizeStore(null)).toEqual({});
    expect(sanitizeStore(undefined)).toEqual({});
    expect(sanitizeStore('nonsense' as never)).toEqual({});
    const clean = sanitizeStore({ HOLDEM: { games: 'not-an-array' } } as never);
    expect(Array.isArray(clean.HOLDEM?.games)).toBe(true);
  });
});
