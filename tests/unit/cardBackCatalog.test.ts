/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE CARD BACK CATALOGUE — twelve designs, twelve pictures, no duplicates
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Audit 2026-08-25. The diamond store sold TWELVE card backs by id and painted
 * SEVEN pictures, because its ids were invented rather than taken from the
 * artwork:
 *
 *     classic (50 diamonds)  -> classic_red   same picture as the FREE `red`
 *     burgundy (75 diamonds) -> classic_red   same picture as the FREE `red`
 *     navy (75 diamonds)     -> classic_blue  same picture as the FREE `blue`
 *     black                  -> classic_blue  same picture as `blue`
 *
 * Three PAID designs were pixel-for-pixel a design the player already had for
 * nothing, and four designs that ship with artwork — diamond, dragon, galaxy,
 * neon — were not for sale anywhere in the app.
 *
 * Nothing errored, because from the code's point of view nothing was wrong:
 * every id resolved to a real design. That is precisely why it needs a test.
 * These pin the properties, not the list: add a design and nothing here
 * complains; make two tiles the same picture, or sell one with no artwork, and
 * it fails.
 */
import { describe, it, expect } from 'vitest';
import {
  CARD_BACK_CATALOG,
  CARD_BACK_IDS,
  cardBackDesign,
  cardBackImageUrl,
  hasPurchasedCardBack,
  isCardBackUnlocked,
  isKnownCardBackId,
  normalizeCardBack,
} from '@/components/table/CardImage';

describe('the catalogue covers exactly the designs that exist', () => {
  it('offers every id that has artwork', () => {
    const offered = CARD_BACK_CATALOG.map((d) => d.id).sort();
    expect(offered).toEqual([...CARD_BACK_IDS].sort());
  });

  it('offers no id that does not have artwork', () => {
    for (const design of CARD_BACK_CATALOG) {
      expect(CARD_BACK_IDS as readonly string[]).toContain(design.id);
    }
  });

  it('names every design', () => {
    for (const design of CARD_BACK_CATALOG) {
      expect(design.name.trim().length, design.id).toBeGreaterThan(0);
    }
  });
});

describe('no two tiles are the same picture', () => {
  it('every catalogue id is its own design after normalising', () => {
    // THE ORIGINAL BUG. Twelve store ids collapsed onto seven designs, so
    // three paid tiles were a free tile in a different frame.
    const resolved = CARD_BACK_CATALOG.map((d) => normalizeCardBack(d.id));
    expect(new Set(resolved).size).toBe(CARD_BACK_CATALOG.length);
  });

  it('every catalogue id resolves to itself, never to the default', () => {
    for (const design of CARD_BACK_CATALOG) {
      expect(normalizeCardBack(design.id), design.id).toBe(design.id);
    }
  });

  it('every tile points at its own artwork file', () => {
    const urls = CARD_BACK_CATALOG.map((d) => cardBackImageUrl(d.id));
    expect(new Set(urls).size).toBe(CARD_BACK_CATALOG.length);
  });
});

describe('the price ladder is coherent', () => {
  it('free designs cost nothing and paid designs cost something', () => {
    for (const design of CARD_BACK_CATALOG) {
      if (design.tier === 'standard') expect(design.price, design.id).toBe(0);
      else expect(design.price, design.id).toBeGreaterThan(0);
    }
  });

  it('has at least one design a brand new player can use', () => {
    expect(CARD_BACK_CATALOG.some((d) => d.tier === 'standard')).toBe(true);
  });
});

describe('cardBackDesign never returns undefined', () => {
  it.each(['', 'nonsense', 'CLASSIC_RED', '../../x', 'black', 'standard-red', null, undefined])(
    'answers a real catalogue entry for %p',
    (id) => {
      const design = cardBackDesign(id as string);
      expect(CARD_BACK_CATALOG).toContain(design);
    }
  );
});

describe('one ownership rule, used by the store and by Theme Settings', () => {
  const paid = CARD_BACK_CATALOG.find((d) => d.tier !== 'standard')!;
  const free = CARD_BACK_CATALOG.find((d) => d.tier === 'standard')!;

  it('free designs need nothing', () => {
    expect(isCardBackUnlocked(free.id, {})).toBe(true);
    expect(isCardBackUnlocked(free.id, { isVip: false, owned: [] })).toBe(true);
  });

  it('paid designs are locked to a player with neither VIP nor a purchase', () => {
    expect(isCardBackUnlocked(paid.id, { isVip: false, owned: [] })).toBe(false);
  });

  it('VIP unlocks a paid design (Theme Settings behaviour)', () => {
    expect(isCardBackUnlocked(paid.id, { isVip: true, owned: [] })).toBe(true);
  });

  it('A PURCHASE unlocks it too, VIP or not', () => {
    // The half that was broken: the modal padlocked designs the player had
    // already spent diamonds on, and offered them VIP as the way to get them.
    expect(isCardBackUnlocked(paid.id, { isVip: false, owned: [paid.id] })).toBe(true);
  });

  it('a purchase recorded under a legacy store id still counts', () => {
    // feature_purchases rows written before 2026-08-25 hold ids like `gold`.
    expect(isCardBackUnlocked('gold', { isVip: false, owned: ['gold'] })).toBe(true);
  });

  it('junk in feature_purchases is not a purchase of anything', () => {
    // THE HOLE THIS GUARDS. normalizeCardBack answers classic_blue for
    // ANYTHING it does not recognise, so without isKnownCardBackId a single
    // malformed feature_purchases row reads as owning classic_blue.
    //
    // Asserted through hasPurchasedCardBack rather than isCardBackUnlocked
    // because the latter short-circuits on the free tier and would answer
    // `true` for classic_blue with or without the guard - a test of it passes
    // either way, which is a test of nothing. Verified by sabotage: deleting
    // the isKnownCardBackId call fails this and only this.
    for (const junk of ['', 'not-a-card-back', 'card_back_', '../../etc/passwd', '{}']) {
      expect(isKnownCardBackId(junk), junk).toBe(false);
      expect(hasPurchasedCardBack('classic_blue', [junk]), junk).toBe(false);
      expect(hasPurchasedCardBack(paid.id, [junk]), junk).toBe(false);
    }
  });

  it('a real purchase IS a purchase, canonical or legacy id', () => {
    expect(hasPurchasedCardBack('gold', ['gold'])).toBe(true);
    // 'navy' is a legacy store id that aliases to classic_blue.
    expect(hasPurchasedCardBack('classic_blue', ['navy'])).toBe(true);
    expect(hasPurchasedCardBack('gold', ['carbon'])).toBe(false);
  });
});
