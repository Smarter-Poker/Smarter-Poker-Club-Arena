/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THROWABLE CUTOUT — the keying algorithm, on synthetic frames
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The renders are JPGs on black and were previously shown with
 * `mix-blend-mode: screen`, which left a grey box around every throw because
 * JPEG "black" is 8/8/8 with ringing. ThrowableCutout replaces that with a
 * real alpha channel.
 *
 * The part that must be right is the flood fill. A naive "dark pixel =>
 * transparent" rule would punch holes through the dark PARTS of dark items —
 * the bomb body, the skull's sockets, the trash can. Flooding inward from the
 * border only removes background reachable from outside, so enclosed dark
 * pixels survive. These tests pin exactly that.
 */

import { describe, it, expect } from 'vitest';
import { knockOutBackground } from '../src/services/ThrowableCutout';

/** Build an RGBA frame from a per-pixel luminance function. */
function frame(w: number, h: number, lum: (x: number, y: number) => number) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = lum(x, y);
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return data;
}

const alphaAt = (d: Uint8ClampedArray, w: number, x: number, y: number) => d[(y * w + x) * 4 + 3];

describe('throwable cutout keying', () => {
  it('clears a black border and keeps a bright subject', () => {
    const w = 32;
    const h = 32;
    // Bright 12x12 block in the middle, pure black around it.
    const d = frame(w, h, (x, y) => (x >= 10 && x < 22 && y >= 10 && y < 22 ? 230 : 0));
    knockOutBackground(d, w, h);

    expect(alphaAt(d, w, 0, 0)).toBe(0); // corner background
    expect(alphaAt(d, w, 5, 16)).toBe(0); // side background
    expect(alphaAt(d, w, 16, 16)).toBe(255); // subject centre
  });

  it('KEEPS dark pixels enclosed by the subject (the bomb-body case)', () => {
    const w = 32;
    const h = 32;
    // Bright ring 8..24 with a pure-black 4x4 hole at its centre. The hole is
    // unreachable from the border without crossing the bright ring.
    const d = frame(w, h, (x, y) => {
      const inRing = x >= 8 && x < 24 && y >= 8 && y < 24;
      const inHole = x >= 14 && x < 18 && y >= 14 && y < 18;
      if (inHole) return 0;
      return inRing ? 230 : 0;
    });
    knockOutBackground(d, w, h);

    expect(alphaAt(d, w, 1, 1)).toBe(0); // outside stays cleared
    expect(alphaAt(d, w, 15, 15)).toBe(255); // enclosed black SURVIVES
    expect(alphaAt(d, w, 9, 9)).toBe(255); // ring itself opaque
  });

  it('treats JPEG-grade near-black as background, not as content', () => {
    const w = 24;
    const h = 24;
    // Background is noisy 4..14 rather than 0 — exactly what lossy JPEG gives.
    const d = frame(w, h, (x, y) =>
      x >= 8 && x < 16 && y >= 8 && y < 16 ? 220 : 4 + ((x * 7 + y * 13) % 11)
    );
    knockOutBackground(d, w, h);

    expect(alphaAt(d, w, 0, 0)).toBe(0);
    expect(alphaAt(d, w, 3, 20)).toBe(0);
    expect(alphaAt(d, w, 12, 12)).toBe(255);
  });

  it('feathers the edge band instead of cutting it hard', () => {
    const w = 24;
    const h = 24;
    // A mid-grey (luminance 50) ring sits between HARD(26) and SOFT(74), so it
    // should come out partially transparent — that band is the JPEG halo.
    const d = frame(w, h, (x, y) => {
      const dx = Math.abs(x - 12);
      const dy = Math.abs(y - 12);
      const r = Math.max(dx, dy);
      if (r <= 3) return 220;
      if (r <= 5) return 50;
      return 0;
    });
    knockOutBackground(d, w, h);

    const feathered = alphaAt(d, w, 12, 7); // in the grey band
    expect(feathered).toBeGreaterThan(0);
    expect(feathered).toBeLessThan(255);
    expect(alphaAt(d, w, 12, 12)).toBe(255); // core still solid
    expect(alphaAt(d, w, 0, 0)).toBe(0); // far background still gone
  });

  // ── Dan 2026-08-21: "a couple are white" ──────────────────────────────────
  // The keyer samples the background instead of assuming black, so a render
  // generated on a light ground keys exactly like the 47 black ones.

  it('keys a WHITE background as cleanly as a black one', () => {
    const w = 32;
    const h = 32;
    // Dark subject on a white ground — the inverse of the normal asset.
    const d = frame(w, h, (x, y) => (x >= 10 && x < 22 && y >= 10 && y < 22 ? 30 : 255));
    knockOutBackground(d, w, h);

    expect(alphaAt(d, w, 0, 0)).toBe(0); // white ground cleared
    expect(alphaAt(d, w, 5, 16)).toBe(0);
    expect(alphaAt(d, w, 16, 16)).toBe(255); // dark subject kept
  });

  it('keeps BRIGHT pixels enclosed by a subject on white (inverse bomb-body)', () => {
    const w = 32;
    const h = 32;
    // Dark ring with a pure-WHITE hole at its centre, on a white ground. The
    // hole matches the background exactly but is unreachable from the border.
    const d = frame(w, h, (x, y) => {
      const inRing = x >= 8 && x < 24 && y >= 8 && y < 24;
      const inHole = x >= 14 && x < 18 && y >= 14 && y < 18;
      if (inHole) return 255;
      return inRing ? 30 : 255;
    });
    knockOutBackground(d, w, h);

    expect(alphaAt(d, w, 1, 1)).toBe(0); // outside cleared
    expect(alphaAt(d, w, 15, 15)).toBe(255); // enclosed white SURVIVES
    expect(alphaAt(d, w, 9, 9)).toBe(255); // ring opaque
  });

  it('keys a mid-grey background too (nothing is special about 0 or 255)', () => {
    const w = 24;
    const h = 24;
    const d = frame(w, h, (x, y) => (x >= 8 && x < 16 && y >= 8 && y < 16 ? 240 : 128));
    knockOutBackground(d, w, h);

    expect(alphaAt(d, w, 0, 0)).toBe(0);
    expect(alphaAt(d, w, 12, 12)).toBe(255);
  });

  it('reports how much was cleared, for the plausibility guard', () => {
    const w = 20;
    const h = 20;
    const d = frame(w, h, (x, y) => (x >= 6 && x < 14 && y >= 6 && y < 14 ? 200 : 0));
    const cleared = knockOutBackground(d, w, h);
    // 400 pixels total, 64 are subject -> 336 cleared.
    expect(cleared).toBe(336);
  });
});
