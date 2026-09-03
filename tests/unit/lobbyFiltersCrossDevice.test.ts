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
import { readFileSync } from 'node:fs';
import { sliceStatement } from '../helpers/sourceWindow';
import { join } from 'node:path';
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

describe('a late remote value can never land on top of a live edit', () => {
  /**
   * The sheet opens from this device's cache and the saved row arrives a
   * moment later. If it applied unconditionally it would overwrite whatever
   * the player had touched in between - the chip they just tapped, or a
   * deliberate Reset - which is the worst possible moment to be overruled by
   * a different device.
   *
   * `touchedRef` is what prevents it, and the danger is not that the guard is
   * wrong today: it is that a FUTURE setStore is added without it, exactly as
   * Phase 1 found a second waitlist writer that did not know the rule. So this
   * reads the source and insists every setStore is either the hydration itself
   * or immediately preceded by the guard.
   */
  it('every setStore is either the hydration or marks the sheet touched', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src/components/lobby/AdvancedFilters.tsx'),
      'utf8'
    );
    const lines = src.split('\n');
    const offenders: string[] = [];

    lines.forEach((line, i) => {
      if (!line.includes('setStore(')) return;
      // The hydration line is the one allowed exception - it is itself gated
      // on touchedRef being false, a few lines above.
      const isHydration = line.includes('JSON.stringify(prev)');
      if (isHydration) return;
      const preceding = lines.slice(Math.max(0, i - 4), i).join('\n');
      if (!preceding.includes('touchedRef.current = true')) {
        offenders.push(`line ${i + 1}: ${line.trim()}`);
      }
    });

    expect(offenders).toEqual([]);
  });

  it('the hydration is gated on the sheet being untouched', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src/components/lobby/AdvancedFilters.tsx'),
      'utf8'
    );
    /* Bounded by the STATEMENT, never by a byte count. A window measured in
       characters drifts off the end of the thing it guards the moment a
       comment is added above it - and the silent direction is worse, because
       it can drift while staying green. That exact mistake cost this estate a
       39-minute publish outage on 2026-08-28, and the repo has a meta-test
       forbidding it, which is what caught this on the first CI run. */
    const effect = sliceStatement(src, 'void fetchRemoteFilters(clubId)');
    expect(effect).toMatch(/touchedRef\.current/);
  });
});
