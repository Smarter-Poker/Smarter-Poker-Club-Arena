/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE FELT CATALOGUE — a felt you can pick is a felt that exists
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Audit 2026-08-25. TableFeltSelector offered eight felts:
 *
 *     classic_green  navy  burgundy  charcoal  purple  crimson  midnight  emerald
 *
 * Only TWO of those eight painted what their label said. Five - navy,
 * burgundy, charcoal, purple and midnight (a BACKGROUND id, not a felt) - match
 * no skin at all, so resolveSkin sent every one of them to classic green:
 * Royal Purple, Charcoal and Burgundy all produced the identical green table,
 * and the picker gave no hint of it. The eighth, `emerald`, is a legacy alias
 * for the GOLDEN SAND skin, so that tile was mislabelled rather than dead.
 *
 * That is the same defect, in the same week, as the card backs: a second
 * hand-typed copy of a catalogue. Both pickers now read TABLE_FELT_CATALOG,
 * which is generated from TABLE_SKIN_IDS, so an id cannot be offered unless a
 * skin file exists behind it.
 */
import { describe, it, expect } from 'vitest';
import {
  TABLE_FELT_CATALOG,
  feltDesign,
  isFeltUnlocked,
  normalizeFeltId,
  normalizeBackgroundId,
  resolveSkin,
} from '../../src/lib/tableTheme';
import {
  TABLE_SKINS,
  TABLE_SKIN_IDS,
  TABLE_BACKGROUNDS,
  TABLE_BACKGROUND_IDS,
} from '../../src/assets/tableAssets';

describe('every felt offered is a felt that exists', () => {
  it('covers exactly the canonical skin ids', () => {
    expect([...TABLE_FELT_CATALOG.map((f) => f.id)].sort()).toEqual([...TABLE_SKIN_IDS].sort());
  });

  it('every tile resolves to its OWN skin, not to the classic green fallback', () => {
    // The exact assertion the old eight-colour list failed five times:
    // resolveSkin(id) landing on classic green for an id that is not
    // classic green means the tile is a lie.
    for (const felt of TABLE_FELT_CATALOG) {
      expect(resolveSkin(felt.id), felt.id).toBe(TABLE_SKINS[felt.id]);
      if (felt.id !== 'classic_green') {
        expect(resolveSkin(felt.id), felt.id).not.toBe(TABLE_SKINS.classic_green);
      }
    }
  });

  it('no two tiles are the same picture', () => {
    const assets = TABLE_FELT_CATALOG.map((f) => resolveSkin(f.id));
    expect(new Set(assets).size).toBe(TABLE_FELT_CATALOG.length);
  });

  it('the ids that silently painted the wrong felt are gone', () => {
    const offered = TABLE_FELT_CATALOG.map((f) => f.id);
    // The five that were not skins at all and fell back to classic green.
    for (const dead of ['navy', 'burgundy', 'charcoal', 'purple', 'midnight']) {
      expect(offered, `${dead} is not a table skin`).not.toContain(dead);
    }
    // And the mislabelled one: `emerald` IS a TABLE_SKINS key, but it is a
    // legacy alias for Golden Sand, so a tile called Emerald painted sand.
    expect(offered, 'emerald is an alias for golden_sand, not a design').not.toContain('emerald');
  });

  it('names every felt', () => {
    for (const felt of TABLE_FELT_CATALOG) {
      expect(felt.name.trim().length, felt.id).toBeGreaterThan(0);
      expect(felt.thumbnail, felt.id).toMatch(/gradient/);
    }
  });
});

describe('feltDesign never returns undefined', () => {
  it.each(['', 'not_a_skin', 'dark-felt', 'midnight', '123', null, undefined])(
    'answers a real catalogue entry for %p',
    (id) => {
      expect(TABLE_FELT_CATALOG).toContain(feltDesign(id as string));
    }
  );
});

describe('normalizeFeltId maps a stored id onto the tile that represents it', () => {
  it('leaves a canonical id alone', () => {
    for (const felt of TABLE_FELT_CATALOG) {
      expect(normalizeFeltId(felt.id), felt.id).toBe(felt.id);
    }
  });

  it('resolves the legacy aliases that are live in the database', () => {
    // A production row on 2026-08-25 held table_id 'dark-felt'. It painted
    // Neon City and highlighted no tile, so the tab looked like it had
    // forgotten the player's choice.
    expect(normalizeFeltId('dark-felt')).toBe('neon_city');
    expect(normalizeFeltId('green-casino')).toBe('classic_green');
    expect(normalizeFeltId('red-leather')).toBe('crimson');
  });

  it('always answers something the picker can highlight', () => {
    for (const id of ['', 'nonsense', 'MIDNIGHT', '../../x', null, undefined]) {
      const normalized = normalizeFeltId(id as string);
      expect(
        TABLE_FELT_CATALOG.some((f) => f.id === normalized),
        `${id} -> ${normalized}`
      ).toBe(true);
    }
  });

  it('agrees with what resolveSkin actually paints', () => {
    // If these two ever disagree the tick sits on one felt while the table
    // shows another, which is worse than no tick at all.
    for (const id of ['dark-felt', 'brown-felt', 'neon-blue-felt', 'nonsense', '']) {
      expect(resolveSkin(normalizeFeltId(id)), id).toBe(resolveSkin(id));
    }
  });
});

describe('normalizeBackgroundId does the same for the Background tab', () => {
  it('leaves a canonical id alone', () => {
    for (const id of TABLE_BACKGROUND_IDS) {
      expect(normalizeBackgroundId(id), id).toBe(id);
    }
  });

  it('resolves the legacy ids that are live in the database', () => {
    expect(normalizeBackgroundId('diamond-pattern')).toBe('midnight');
    expect(normalizeBackgroundId('galaxy-nebula')).toBe('galaxy');
  });

  it('always answers a tile, and agrees with what gets painted', () => {
    for (const id of ['', 'nonsense', 'diamond-pattern', 'teal-tile', null, undefined]) {
      const normalized = normalizeBackgroundId(id as string);
      expect(TABLE_BACKGROUND_IDS, `${id}`).toContain(normalized);
      expect(TABLE_BACKGROUNDS[normalized], `${id}`).toBe(
        TABLE_BACKGROUNDS[id as string] ?? TABLE_BACKGROUNDS.midnight
      );
    }
  });
});

describe('felt VIP gating', () => {
  it('free felts need nothing and VIP felts need VIP', () => {
    const free = TABLE_FELT_CATALOG.find((f) => f.tier === 'standard')!;
    const vip = TABLE_FELT_CATALOG.find((f) => f.tier === 'vip')!;
    expect(isFeltUnlocked(free.id, { isVip: false })).toBe(true);
    expect(isFeltUnlocked(vip.id, { isVip: false })).toBe(false);
    expect(isFeltUnlocked(vip.id, { isVip: true })).toBe(true);
  });

  it('has both tiers, or the gate is not doing anything', () => {
    expect(TABLE_FELT_CATALOG.some((f) => f.tier === 'standard')).toBe(true);
    expect(TABLE_FELT_CATALOG.some((f) => f.tier === 'vip')).toBe(true);
  });
});
