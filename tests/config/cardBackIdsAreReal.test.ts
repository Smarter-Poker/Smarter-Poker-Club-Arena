/**
 * EVERY CARD BACK OFFERED MUST BE A CARD BACK THAT EXISTS (2026-08-25).
 *
 * Two separate menus keep their own copy of the card-back catalogue:
 * ThemeSettingsModal and HamburgerMenu. On 2026-08-20 Dan found the first one
 * offering standard-red / premium-gold / premium-platinum - ids matching
 * nothing in CARD_BACK_IDS or CARD_BACK_ALIASES. normalizeCardBack sent them
 * all to classic_blue, so every tile painted the same navy back and picking any
 * of them changed nothing on the felt.
 *
 * That was fixed in ThemeSettingsModal and left standing in HamburgerMenu,
 * which went on offering default / emerald / crimson / gold / midnight /
 * obsidian / neon - six of eight dead - for another five days. A fix applied to
 * one copy of a duplicated list is not a fix.
 *
 * This pins the property rather than the list: whatever HamburgerMenu offers
 * must be a real id. Add a new back and this test does not care; offer one that
 * does not exist and it fails.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const CARD_IMAGE = read('src/components/table/CardImage.tsx');
const HAMBURGER = read('src/components/navigation/HamburgerMenu.tsx');
const THEME_MODAL = read('src/components/table/ThemeSettingsModal.tsx');

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

  it('every id the hamburger menu offers is real', () => {
    const real = realCardBackIds();
    const offered = offeredIds(HAMBURGER, "id: 'classic_blue'");
    expect(offered.length, 'no card-back presets found in HamburgerMenu').toBeGreaterThan(0);
    const dead = offered.filter((id) => !real.has(id));
    expect(dead, `HamburgerMenu offers ids that are not real card backs: ${dead.join(', ')}`).toEqual(
      []
    );
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

  it('the two menus do not disagree about what is real', () => {
    // Both keep their own copy. Neither may offer something the other calls
    // fictional - that divergence is what let this bug live in one of them for
    // five days after it was fixed in the other.
    const real = realCardBackIds();
    const cardsBlock = THEME_MODAL.slice(THEME_MODAL.indexOf('cards: ['));
    const modal = [...cardsBlock.slice(0, cardsBlock.indexOf('\n  ],')).matchAll(/id: '([a-z0-9_-]+)'/g)].map(
      (m) => m[1]
    );
    expect(modal.length, 'no cards parsed from ThemeSettingsModal').toBeGreaterThan(0);
    const deadInModal = modal.filter((id) => !real.has(id));
    expect(deadInModal, `ThemeSettingsModal offers unreal ids: ${deadInModal.join(', ')}`).toEqual(
      []
    );
  });
});
