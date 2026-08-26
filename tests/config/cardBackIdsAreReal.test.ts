/**
 * EVERY CARD BACK OFFERED MUST BE A CARD BACK THAT EXISTS — AND MUST SAVE THE
 * ONE IT SHOWS (2026-08-25).
 *
 * Three menus sell card backs: the diamond store (CardBackSelector), Theme
 * Settings' Cards tab, and the table hamburger menu. Each kept its own copy of
 * the catalogue, and this repo has now fixed the same defect in each copy
 * separately, days apart:
 *
 *   - 2026-08-20  ThemeSettingsModal offered standard-red / premium-gold /
 *                 premium-platinum. Matched nothing. normalizeCardBack sent
 *                 all of them to classic_blue.
 *   - 2026-08-25  HamburgerMenu offered default / emerald / crimson /
 *                 midnight / obsidian. Same outcome, five days later.
 *   - 2026-08-25  CardBackSelector sold twelve ids that painted seven
 *                 pictures, three of the paid ones identical to a free one.
 *
 * The store and the modal now GENERATE their tiles from CARD_BACK_CATALOG, so
 * for them the defect is structurally impossible and cardBackCatalog.test.ts
 * covers it. The hamburger still keeps a literal list (it carries its own
 * swatch gradients), so it still needs pinning here.
 *
 * The 2026-08-25 hamburger fix is also the reason for the second suite below.
 * That fix corrected the list of ids and left the TRANSLATION TABLE that
 * existed only to translate the old ones — so the menu went on saving
 * classic_blue for eight of its ten tiles, while now looking correct in the
 * picker. Offering a real id is only half the property; saving the one you
 * offered is the other half.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { CARD_BACK_CATALOG, CARD_BACK_IDS } from '@/components/table/CardImage';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const CARD_IMAGE = read('src/components/table/CardImage.tsx');
const HAMBURGER = read('src/components/navigation/HamburgerMenu.tsx');
const THEME_MODAL = read('src/components/table/ThemeSettingsModal.tsx');
const STORE = read('src/components/customization/CardBackSelector.tsx');

/** The authoritative ids, read from where the artwork is actually named. */
function realCardBackIds(): Set<string> {
  const block = CARD_IMAGE.match(/CARD_BACK_IDS[^=]*=\s*\[([\s\S]*?)\]/);
  expect(block, 'CARD_BACK_IDS not found in CardImage.tsx').toBeTruthy();
  const ids = [...block![1].matchAll(/'([a-z0-9_-]+)'/g)].map((m) => m[1]);
  expect(ids.length, 'CARD_BACK_IDS parsed empty').toBeGreaterThan(0);
  return new Set(ids);
}

/** Ids offered by the card-back picker inside a component's source. */
function offeredIds(src: string, afterMarker: string): string[] {
  const at = src.indexOf(afterMarker);
  expect(at, `marker ${afterMarker} not found`).toBeGreaterThan(-1);
  const window = src.slice(at, at + 2600);
  return [...window.matchAll(/id: '([a-z0-9_-]+)'/g)].map((m) => m[1]);
}

describe('a card back you can pick is a card back that exists', () => {
  it('CardImage names at least the six shipped designs', () => {
    const real = realCardBackIds();
    for (const id of ['classic_blue', 'classic_red', 'royal', 'gold']) {
      expect(real.has(id), `${id} missing from CARD_BACK_IDS`).toBe(true);
    }
  });

  it('the parsed ids agree with the exported ones', () => {
    expect([...realCardBackIds()].sort()).toEqual([...CARD_BACK_IDS].sort());
  });

  it('every id the hamburger menu offers is real', () => {
    const real = realCardBackIds();
    const offered = offeredIds(HAMBURGER, "id: 'classic_blue'");
    expect(offered.length, 'no card-back presets found in HamburgerMenu').toBeGreaterThan(0);
    const dead = offered.filter((id) => !real.has(id));
    expect(
      dead,
      `HamburgerMenu offers ids that are not real card backs: ${dead.join(', ')}`
    ).toEqual([]);
  });

  it('the ids that silently did nothing are gone for good', () => {
    // These are the exact ids that normalizeCardBack collapsed to classic_blue.
    const offered = offeredIds(HAMBURGER, "id: 'classic_blue'");
    // neon IS a real design (CARD_BACK_IDS + neon.webp on disk) - it was the
    // one id in the old list that worked, and it stays.
    for (const dead of ['default', 'emerald', 'crimson', 'midnight', 'obsidian']) {
      expect(offered).not.toContain(dead);
    }
  });
});

describe('the hamburger menu saves the design it shows', () => {
  it('does not translate the id before storing it', () => {
    // A translation table between the tile and the write is what let the
    // 2026-08-25 fix look right and behave worse: every id it did not know
    // fell through `|| 'black'`, and 'black' aliases to classic_blue.
    expect(HAMBURGER, 'HamburgerMenu must store the preset id it displayed, untranslated').toMatch(
      /const realCardId = preset\.id;/
    );
  });

  it('keeps no lookup table between the tile and the write', () => {
    expect(HAMBURGER, 'a presetMap is exactly how this broke twice').not.toMatch(/presetMap/);
  });
});

describe('the menus no longer keep their own copies', () => {
  it('Theme Settings generates its Cards tab from the catalogue', () => {
    expect(
      THEME_MODAL,
      'ThemeSettingsModal must build its Cards tab from CARD_BACK_CATALOG'
    ).toMatch(/CARD_BACK_CATALOG\.map/);
    expect(THEME_MODAL).toMatch(/cards: CARD_ASSETS/);
  });

  it('the diamond store sells the catalogue, not a list of its own', () => {
    expect(STORE, 'CardBackSelector must render CARD_BACK_CATALOG').toMatch(
      /CARD_BACK_CATALOG\.map/
    );
    // The invented store ids are what made three paid designs identical to a
    // free one. They survive only as normalizeCardBack aliases, for rows
    // already written; nothing may SELL them again.
    for (const invented of ["id: 'burgundy'", "id: 'navy'", "id: 'white'", "id: 'black'"]) {
      expect(STORE, `${invented} is not a card back design`).not.toContain(invented);
    }
  });

  it('Theme Settings generates its Table tab from the felt catalogue', () => {
    expect(THEME_MODAL).toMatch(/TABLE_FELT_CATALOG\.map/);
    expect(THEME_MODAL).toMatch(/table: TABLE_ASSETS/);
  });

  /* 2026-08-26 sweep: this used to read `customization/TableFeltSelector.tsx`,
     which was DELETED — it was a complete, correct felt picker with no call
     site anywhere, reachable only through a barrel that nothing imported. A
     test asserting the quality of a component nobody can open is measuring
     the wrong thing: it passes while the feature is, in practice, absent.

     The property it was really guarding — "the felt picker offers the
     CATALOGUE, not a hand-typed list of colours that are not skins" — still
     matters, and now belongs to the picker players can actually reach: the
     Theme modal's Table tab, asserted directly above. This keeps the second
     half of the old test (the dead flat-colour ids must not come back) and
     points it at the live surface. */
  it('the felt catalogue holds no flat colours that were never skins', () => {
    /* Asserted against the CATALOGUE, not against the modal's source. First
       attempt at this port checked the whole modal and failed on
       `background_id: 'midnight'` — a perfectly real BACKGROUND id. The dead
       ids were flat FELT colours, so the felt catalogue is the thing to ask,
       and asking it directly cannot be confused by a neighbouring field. */
    const felt = read('src/lib/tableTheme.ts');
    const catalogue = felt.slice(felt.indexOf('TABLE_FELT_CATALOG'));
    for (const dead of ["id: 'charcoal'", "id: 'purple'", "id: 'midnight'"]) {
      expect(catalogue, `${dead} is not a felt skin`).not.toContain(dead);
    }
  });
});

describe('a paid card back is not free somewhere else', () => {
  it('the hamburger menu actually reads its own vipOnly flag', () => {
    // It declared vipOnly on all ten presets and read it NOWHERE, so seven
    // designs the store charges 75-300 diamonds for, and Theme Settings
    // padlocks behind VIP, were one tap away for free.
    expect(HAMBURGER, 'HamburgerMenu must gate paid card backs').toMatch(/isCardBackUnlocked\(/);
    expect(HAMBURGER).toMatch(/const locked = !isCardBackUnlocked/);
  });

  it('all three surfaces use the SAME unlock rule', () => {
    for (const [name, src] of [
      ['HamburgerMenu', HAMBURGER],
      ['ThemeSettingsModal', THEME_MODAL],
      ['CardBackSelector', STORE],
    ] as const) {
      expect(src, `${name} must use isCardBackUnlocked`).toMatch(/isCardBackUnlocked/);
    }
  });

  it('Theme Settings considers purchases, not only VIP', () => {
    // The direction that was broken: a player who had spent 150 diamonds on
    // Premium Gold found it padlocked here, with an offer to buy VIP to get it.
    expect(THEME_MODAL).toMatch(/feature_purchases/);
    expect(THEME_MODAL).toMatch(/ownedCardBacks/);
  });
});

describe('the three menus do not disagree about what is real', () => {
  it('everything the hamburger offers is in the shared catalogue', () => {
    const catalogue = new Set(CARD_BACK_CATALOG.map((d) => d.id));
    const offered = offeredIds(HAMBURGER, "id: 'classic_blue'");
    const strangers = offered.filter((id) => !catalogue.has(id));
    expect(strangers, `HamburgerMenu offers ids the catalogue does not: ${strangers}`).toEqual([]);
  });
});
