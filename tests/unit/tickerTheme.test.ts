/**
 * THE FLAG CAN NEVER BE ILLEGIBLE AGAIN, AND THIS IS THE PROOF
 *
 * The audit of 2026-09-05 found "STARTING SOON" rendered cyan on cyan at about
 * 1.06:1: the render painted `color` with the club accent over a background the
 * stylesheet had built from that same accent. The management service validated
 * 4.5:1 for the message and never looked at the flag.
 *
 * The fix is not another validator - a validator can be walked around by a
 * direct RPC call, and this one would have had to reject colours a club had
 * already saved. The ink is DERIVED from the fill instead, and the property
 * below is what makes that safe: for every six-digit hex, the better of
 * near-black and near-white clears AA. The worst case is a fill at relative
 * luminance 0.179, where both candidates land on 4.58:1.
 *
 * So this file sweeps the colour cube rather than testing three examples.
 */

import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../src/utils/colorContrast';
import {
  DEFAULT_ACCENT,
  DEFAULT_RAIL_BACKGROUND,
  flagBackground,
  INK_ABSOLUTE_DARK,
  INK_DARK,
  INK_LIGHT,
  railBackground,
  railGlow,
  readableInk,
  safeHex,
  shade,
  TONE_ACCENT,
  withAlpha,
} from '../../src/components/tournament/tickerTheme';

describe('readableInk', () => {
  it('clears AA against every colour on a coarse sweep of the cube', () => {
    let worst = Number.POSITIVE_INFINITY;
    let worstColour = '';
    for (let r = 0; r <= 255; r += 15) {
      for (let g = 0; g <= 255; g += 15) {
        for (let b = 0; b <= 255; b += 15) {
          const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
          const ratio = contrastRatio(readableInk(hex), hex);
          if (ratio < worst) {
            worst = ratio;
            worstColour = hex;
          }
        }
      }
    }
    expect(worst, `worst pairing was ${worstColour}`).toBeGreaterThanOrEqual(4.5);
  });

  it('clears AA on every tone the rail can flag, and on the default accent', () => {
    for (const accent of [...Object.values(TONE_ACCENT), DEFAULT_ACCENT]) {
      expect(contrastRatio(readableInk(accent), accent)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('is the regression: the default accent no longer inks itself', () => {
    // The exact defect, stated as an assertion. `#00d4ff` on `#00d4ff`.
    expect(readableInk(DEFAULT_ACCENT)).not.toBe(DEFAULT_ACCENT);
    expect(contrastRatio(DEFAULT_ACCENT, DEFAULT_ACCENT)).toBeLessThan(1.1);
    expect(contrastRatio(readableInk(DEFAULT_ACCENT), DEFAULT_ACCENT)).toBeGreaterThan(4.5);
  });

  it('picks dark ink on a light fill and light ink on a dark one', () => {
    expect(readableInk('#ffffff')).toBe(INK_DARK);
    expect(readableInk('#000000')).toBe(INK_LIGHT);
  });

  it('keeps the tint where it can and drops it where it cannot', () => {
    /* `#2d78d2` is the colour the cube sweep caught: the tinted pair reaches
       only 4.26:1 on it, so the absolute ink takes over. A club that picks a
       mid-blue accent gets a slightly starker chip and a readable one. */
    expect(readableInk('#0b1a33')).toBe(INK_LIGHT);
    expect(readableInk('#2d78d2')).toBe(INK_ABSOLUTE_DARK);
    expect(contrastRatio(readableInk('#2d78d2'), '#2d78d2')).toBeGreaterThanOrEqual(4.5);
  });

  it('falls back rather than throwing on a colour it cannot read', () => {
    expect(readableInk('not-a-colour')).toBe(readableInk(DEFAULT_ACCENT));
  });
});

describe('shade', () => {
  it('moves toward white and toward black', () => {
    expect(shade('#808080', 1)).toBe('#ffffff');
    expect(shade('#808080', -1)).toBe('#000000');
    expect(shade('#808080', 0)).toBe('#808080');
  });

  it('clamps out-of-range amounts instead of producing an invalid colour', () => {
    expect(shade('#123456', 9)).toBe('#ffffff');
    expect(shade('#123456', -9)).toBe('#000000');
  });

  it('always returns a six-digit hex', () => {
    for (const amount of [-0.9, -0.3, 0.05, 0.42, 0.77]) {
      expect(shade('#0b1a33', amount)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('railBackground', () => {
  it('is a gradient built FROM the managed colour, not a flat fill', () => {
    /* The stylesheet declared a gradient from the first commit and lost to an
       inline single hex on every render, so the bar had been flat since ticker
       management shipped. Built here, it survives the inline style because it
       IS the inline style. */
    const css = railBackground('#0b1a33');
    expect(css).toContain('linear-gradient(90deg');
    expect(css).toContain('#0b1a33');
    expect(css).not.toBe('#0b1a33');
  });

  it('lifts the centre stop so the rail has a middle', () => {
    const css = railBackground('#0b1a33');
    expect(css).toContain(shade('#0b1a33', 0.14));
  });

  it('falls back to the house navy on nonsense', () => {
    expect(railBackground('#zzz')).toContain(DEFAULT_RAIL_BACKGROUND);
  });
});

describe('flagBackground and railGlow', () => {
  it('fills the chip with the accent rather than writing on it', () => {
    expect(flagBackground('#f0b429')).toContain('linear-gradient(180deg');
  });

  it('glows in the accent under the strip', () => {
    expect(railGlow('#00d4ff')).toContain('rgba(0, 212, 255');
  });
});

describe('safeHex and withAlpha', () => {
  it('lower-cases a valid hex and rejects everything else', () => {
    expect(safeHex('#AABBCC', '#000000')).toBe('#aabbcc');
    expect(safeHex('rgb(1,2,3)', '#000000')).toBe('#000000');
    expect(safeHex(null, '#000000')).toBe('#000000');
    expect(safeHex(undefined, '#000000')).toBe('#000000');
  });

  it('clamps alpha into range', () => {
    expect(withAlpha('#00d4ff', 5)).toBe('rgba(0, 212, 255, 1)');
    expect(withAlpha('#00d4ff', -5)).toBe('rgba(0, 212, 255, 0)');
  });
});

describe('the tone palette', () => {
  it('does not paint money in the same colour as time', () => {
    /* An overlay is the strongest thing this room can say. Painting it in the
       routine flag colour is how the loudest message ends up looking like the
       quietest one. */
    expect(TONE_ACCENT.money).not.toBe(TONE_ACCENT.time);
    expect(TONE_ACCENT.service).not.toBe(TONE_ACCENT.time);
    expect(TONE_ACCENT.info).not.toBe(TONE_ACCENT.money);
  });

  it('is all valid hex', () => {
    for (const value of Object.values(TONE_ACCENT)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
