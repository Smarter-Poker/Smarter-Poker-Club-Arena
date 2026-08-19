/**
 * TABLE THEME RESOLUTION (2026-08-19).
 *
 * Two lookups, and the only thing they have to get right is the miss: a stored
 * skin or background id that no longer exists must land on a real asset, not on
 * undefined. Undefined here is a table with no felt and a page with no
 * background — and the ids come out of a database, so they outlive renames.
 */
import { describe, it, expect } from 'vitest';
import { resolveSkin, resolveBackground } from '../../src/lib/tableTheme';
import { TABLE_SKINS, TABLE_BACKGROUNDS } from '../../src/assets/tableAssets';

describe('resolveSkin', () => {
  it('returns the asset for every id in the registry', () => {
    for (const id of Object.keys(TABLE_SKINS)) {
      expect(resolveSkin(id)).toBe(TABLE_SKINS[id]);
    }
  });

  it.each(['', 'not_a_skin', 'CLASSIC_GREEN', 'null', 'undefined'])(
    'falls back to classic green for %p',
    (id) => {
      expect(resolveSkin(id)).toBe(TABLE_SKINS.classic_green);
    }
  );

  it('never returns undefined, whatever it is handed', () => {
    for (const id of ['', 'x', 'classic_green', '../../etc/passwd', '123']) {
      expect(resolveSkin(id)).toBeTruthy();
    }
  });

  it('has a real classic_green to fall back to', () => {
    // If this default ever goes missing the fallback silently becomes undefined.
    expect(TABLE_SKINS.classic_green).toBeTruthy();
  });
});

describe('resolveBackground', () => {
  it('returns the asset for every id in the registry', () => {
    for (const id of Object.keys(TABLE_BACKGROUNDS)) {
      expect(resolveBackground(id)).toBe(TABLE_BACKGROUNDS[id]);
    }
  });

  it.each(['', 'not_a_background', 'MIDNIGHT', 'blurred_skin'])(
    'falls back to midnight for %p',
    (id) => {
      expect(resolveBackground(id)).toBe(TABLE_BACKGROUNDS.midnight);
    }
  );

  it('never returns undefined, whatever it is handed', () => {
    for (const id of ['', 'x', 'midnight', '999']) {
      expect(resolveBackground(id)).toBeTruthy();
    }
  });

  it('has a real midnight to fall back to', () => {
    expect(TABLE_BACKGROUNDS.midnight).toBeTruthy();
  });
});

describe('the registries themselves', () => {
  it('are not empty', () => {
    expect(Object.keys(TABLE_SKINS).length).toBeGreaterThan(0);
    expect(Object.keys(TABLE_BACKGROUNDS).length).toBeGreaterThan(0);
  });

  it('have no entry that resolves to nothing', () => {
    for (const [id, asset] of Object.entries(TABLE_SKINS)) {
      expect(asset, `skin ${id}`).toBeTruthy();
    }
    for (const [id, asset] of Object.entries(TABLE_BACKGROUNDS)) {
      expect(asset, `background ${id}`).toBeTruthy();
    }
  });
});
