/**
 * TABLE THEME RESOLUTION (2026-08-19).
 *
 * Two lookups, and the only thing they have to get right is the miss: a stored
 * skin or background id that no longer exists must land on a real asset, not on
 * undefined. Undefined here is a table with no felt and a page with no
 * background — and the ids come out of a database, so they outlive renames.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveSkin,
  resolveBackground,
  resolveBackgroundLayers,
  DEFAULT_TABLE_BACKDROP,
  DEFAULT_TABLE_BACKDROP_COLOR,
  TABLE_BACKGROUND_SIZE,
  TABLE_BACKGROUND_POSITION,
  TABLE_BACKGROUND_REPEAT,
} from '../../src/lib/tableTheme';
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

// ═══════════════════════════════════════════════════════════════════════════
// NEVER-BLANK GUARANTEE (2026-08-20)
// ═══════════════════════════════════════════════════════════════════════════
// Dan: "EVERY SINGLE TABLE NEEDS A BACKGROUND... IT SHOULD NEVER BE BLANK."
//
// A resolved URL was never a guarantee that a pixel gets painted: a 404, a
// decode failure or a slow first paint all leave `background-image: url(...)`
// showing nothing, and the player stares at an empty page. The layer helper
// composites the artwork OVER a pure-CSS backdrop that needs no network, so
// no input — and no network outcome — can produce a blank table.

describe('resolveBackgroundLayers — never blank', () => {
  const inputs: Array<string | null | undefined> = [
    'midnight',
    'galaxy',
    'not_a_background',
    'diamond-pattern', // legacy id with no modern asset
    '',
    null,
    undefined,
  ];

  it.each(inputs)('always paints the CSS backdrop for %p', (bid) => {
    const layers = resolveBackgroundLayers(bid as string);
    expect(layers).toContain(DEFAULT_TABLE_BACKDROP);
    expect(layers.trim()).not.toBe('');
    expect(layers).not.toContain('undefined');
    expect(layers).not.toContain('url()');
  });

  it('layers the selected artwork ON TOP of the backdrop', () => {
    const layers = resolveBackgroundLayers('midnight');
    expect(layers.startsWith('url(')).toBe(true);
    expect(layers.indexOf('url(')).toBeLessThan(layers.indexOf(DEFAULT_TABLE_BACKDROP));
  });

  it('an unknown id renders exactly the default design', () => {
    expect(resolveBackgroundLayers('not_a_background')).toBe(resolveBackgroundLayers('midnight'));
  });

  it('declares a solid base colour as the last line of defence', () => {
    expect(DEFAULT_TABLE_BACKDROP_COLOR).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('size/position/repeat lists match the layer count exactly', () => {
    // Mismatched list lengths make the browser cycle the shorter list and
    // mis-size a layer (the artwork silently stops covering).
    const countTopLevel = (value: string): number => {
      let depth = 0;
      let n = 1;
      for (const ch of value) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === ',' && depth === 0) n++;
      }
      return n;
    };
    const layers = countTopLevel(resolveBackgroundLayers('midnight'));
    expect(countTopLevel(TABLE_BACKGROUND_SIZE)).toBe(layers);
    expect(countTopLevel(TABLE_BACKGROUND_POSITION)).toBe(layers);
    expect(countTopLevel(TABLE_BACKGROUND_REPEAT)).toBe(layers);
  });
});
