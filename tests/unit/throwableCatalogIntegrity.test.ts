/**
 * THROWABLE CATALOG ↔ ARTWORK MANIFEST
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS
 *
 * The card-back picker shipped offering eight ids of which six matched no file.
 * Every tile painted the same fallback image and selecting one did nothing at
 * all - and nothing failed, because an <img> that 404s just swaps to its
 * onError source. That is the shape of defect a picker cannot report on itself.
 *
 * The throwable selector is the same construction: `Throwable.id` IS the
 * storage filename stem (`throwables/<id>.jpg`), and ThrowableImage falls back
 * through a sized URL, a raw URL and finally a neutral glyph. A catalog entry
 * with no render would therefore appear in the grid, look plausible, cost the
 * player a diamond, and throw a placeholder.
 *
 * So the catalog is pinned against the real bucket listing, captured
 * 2026-08-25 from `storage.objects` on project kuklfnapbkmacvwxktbh:
 *
 *   select name from storage.objects
 *   where bucket_id = 'images' and name like 'throwables/%';
 *
 * 49 `.jpg` renders (each with an `_animated.png` sibling). If someone adds a
 * throwable without uploading its art, this fails. If someone uploads art and
 * wires it up, they add the id here in the same commit - which is the point:
 * the manifest is a second pair of eyes, not a chore.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import stillManifest from '../../src/throwables/stills.generated.json';
import { throwableService } from '../../src/services/ThrowableService';

/** Every `throwables/<stem>.jpg` present in the `images` bucket. */
const STORAGE_RENDERS = [
  'alien',
  'angry_emoji',
  'anvil',
  'banana_peel',
  'basketball',
  'bear',
  'beer',
  'bomb',
  'bowling_ball',
  'boxing_glove',
  'cake',
  'cash_stack',
  'champagne',
  'chicken',
  'coffee',
  'cool_sunglasses_emoji',
  'cracked_egg',
  'crying_emoji',
  'diamond',
  'dice',
  'doge',
  'fireworks',
  'football',
  'ghost',
  'heart',
  'horseshoe',
  'laughing_emoji',
  'lightning_bolt',
  'magic_8_ball',
  'magnet',
  'mouse_card',
  'pizza_slice',
  'poop',
  'robot',
  'rocket',
  'rose',
  'rubber_duck',
  'shark',
  'skull',
  'snowman',
  'star',
  'tennis_ball',
  'thumbs_down',
  'thumbs_up',
  'tomato',
  'trash_can',
  'trophy',
  'ufo',
  'water_gun',
];

describe('throwable catalog integrity', () => {
  const catalog = throwableService.getThrowables();

  it('every catalog id has a local delivery render or a verified storage render', () => {
    const local: Record<string, Record<string, string>> = stillManifest;
    const orphanIds = catalog
      .map((t) => t.id)
      .filter(
        (id) =>
          !STORAGE_RENDERS.includes(id) &&
          ![192, 320, 640].every(
            (size) => local[id]?.[size] && existsSync(`public/${local[id][size]}`)
          )
      );

    expect(
      orphanIds,
      `These throwables are offered in the picker but have no throwables/<id>.jpg: ${orphanIds.join(', ')}`
    ).toEqual([]);
  });

  it('the catalog holds 51 items and no duplicate ids', () => {
    expect(catalog).toHaveLength(51);
    expect(new Set(catalog.map((t) => t.id)).size).toBe(51);
  });

  it('ids are storage-safe stems, because the id IS the filename', () => {
    for (const t of catalog) {
      expect(t.id, `${t.id} is not a lowercase snake_case stem`).toMatch(
        /^[a-z0-9]+(_[a-z0-9]+)*$/
      );
    }
  });

  it('every catalog item has a non-empty display name', () => {
    // An unnamed tile is a blank label under a picture: the player cannot tell
    // what they are about to spend a diamond on.
    for (const t of catalog) {
      expect(t.name.trim().length, `${t.id} has no name`).toBeGreaterThan(0);
    }
  });

  it('every category the selector renders has at least one item', () => {
    // The VIP avatar tab was a permanently empty tab for months because nothing
    // in the codebase ever produced that category. A tab that can never fill is
    // a dead control, so each of the five is asserted to be reachable.
    const byCategory = throwableService.getThrowablesByCategory();
    for (const cat of ['reactions', 'throws', 'sports', 'cheers', 'premium'] as const) {
      expect(byCategory[cat].length, `category ${cat} is empty`).toBeGreaterThan(0);
    }
  });

  it('the by-category split loses nothing from the flat catalog', () => {
    const byCategory = throwableService.getThrowablesByCategory();
    const total = Object.values(byCategory).reduce((n, list) => n + list.length, 0);
    expect(total).toBe(catalog.length);
  });
});
