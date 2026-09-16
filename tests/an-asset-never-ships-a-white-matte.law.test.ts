/**
 * AN ASSET NEVER SHIPS A WHITE MATTE.
 *
 * Several painted shells were exported with their glow rendered as WHITE
 * rather than cut out - a smooth neutral ramp at full alpha outside the
 * frame, with a torn edge where the export clipped it. The top of a plate
 * looked right because the art was cropped flush there; the bottom and sides
 * carried the matte, and it reached production. Four plates were cleaned by
 * hand on 2026-09-10. Nothing stopped the next export putting it back, which
 * is what scripts/art/check-asset-matte.mjs and this law now do.
 *
 * See docs/laws.d/an-asset-never-ships-a-white-matte.md.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { judgeReadings, matteFraction, MIN_FRACTION } from '../scripts/art/matte-detector.mjs';

const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, 'docs/art/matte-baseline.json');
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as {
  assets: Record<string, { pct: number; reason: string }>;
};

/** An RGBA buffer, painted by `fill(set, w, h)`. */
function image(w: number, h: number, fill: (set: Set, w: number, h: number) => void) {
  const a = new Uint8ClampedArray(w * h * 4);
  const set: Set = (x, y, r, g, b, alpha = 255) => {
    const i = (y * w + x) * 4;
    a[i] = r;
    a[i + 1] = g;
    a[i + 2] = b;
    a[i + 3] = alpha;
  };
  fill(set, w, h);
  return a;
}
type Set = (x: number, y: number, r: number, g: number, b: number, alpha?: number) => void;

describe('the detector knows a matte from a frame', () => {
  it('leaves dark art alone: an outline is never matte, however smooth', () => {
    // 8x8 of #202020 (luminance 32) floating in transparency. Below FLOOR,
    // so no pixel is passable and the flood cannot enter from the border.
    const a = image(16, 16, (set) => {
      for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) set(x, y, 32, 32, 32);
    });
    expect(matteFraction(a, 16, 16)).toBe(0);
  });

  it('takes a plate that is nothing BUT matte down to nothing', () => {
    // The same block in #C8C8C8: bright, neutral, and flat, so every pixel is
    // matte and every pixel is reachable from the transparent border.
    const a = image(16, 16, (set) => {
      for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) set(x, y, 200, 200, 200);
    });
    expect(matteFraction(a, 16, 16)).toBe(1);
  });

  it('stops at the first structured pixel, which is the whole premise', () => {
    // A fully opaque 20x20: a 3px bright neutral ring around a 14x14 dark
    // core. The flood eats the ring from the border inward and stops one
    // layer short of the core - that layer has the core in its 3x3
    // neighbourhood, so its local range is 184 and it reads as structure, not
    // matte. 400 - 16*16 = 144 pixels go, and the core is untouched.
    const a = image(20, 20, (set) => {
      for (let y = 0; y < 20; y++)
        for (let x = 0; x < 20; x++) {
          const core = x >= 3 && x <= 16 && y >= 3 && y <= 16;
          if (core) set(x, y, 16, 16, 16);
          else set(x, y, 200, 200, 200);
        }
    });
    expect(matteFraction(a, 20, 20)).toBeCloseTo(144 / 400, 10);
  });

  it('never eats a blue bevel, because a bevel is not neutral', () => {
    // Same shape, but the ring is #B4C3E6 - the LED-lit chamfer colour. |B-R|
    // is 50, far outside NEUTRAL, so not one pixel of it is passable.
    const a = image(20, 20, (set) => {
      for (let y = 0; y < 20; y++)
        for (let x = 0; x < 20; x++) {
          const core = x >= 3 && x <= 16 && y >= 3 && y <= 16;
          if (core) set(x, y, 16, 16, 16);
          else set(x, y, 180, 195, 230);
        }
    });
    expect(matteFraction(a, 20, 20)).toBe(0);
  });
});

describe('the gate fails a reading that rises, and only a reading that rises', () => {
  const FLOOR = Math.round(MIN_FRACTION * 1000) / 10; // 0.5

  it('lets an unrecorded asset through only while it stays under the floor', () => {
    const { failures } = judgeReadings([{ rel: 'a.png', pct: 0.4 }], {}, FLOOR);
    expect(failures).toEqual([]);
  });

  it('fails an unrecorded asset that reaches the floor', () => {
    const { failures } = judgeReadings([{ rel: 'a.png', pct: 0.5 }], {}, FLOOR);
    expect(failures).toEqual([{ rel: 'a.png', pct: 0.5, allowed: 0.4 }]);
  });

  it('fails a recorded asset that reads one tick above what was recorded', () => {
    const recorded = { 'a.png': { pct: 7.8, reason: 'artwork' } };
    expect(judgeReadings([{ rel: 'a.png', pct: 7.8 }], recorded, FLOOR).failures).toEqual([]);
    expect(judgeReadings([{ rel: 'a.png', pct: 7.9 }], recorded, FLOOR).failures).toEqual([
      { rel: 'a.png', pct: 7.9, allowed: 7.8 },
    ]);
  });

  it('fails the exact regression that shipped: a cleaned plate re-exported with its matte', () => {
    // club-nav-shell.png read 12.7% before it was cleaned on 2026-09-10 and
    // reads 0.0% now. Swapping the pre-clean file back in was run against the
    // real gate and produced exactly this.
    const { failures } = judgeReadings(
      [{ rel: 'public/assets/club-buttons/club-nav-shell.png', pct: 12.7 }],
      {},
      FLOOR
    );
    expect(failures).toEqual([
      { rel: 'public/assets/club-buttons/club-nav-shell.png', pct: 12.7, allowed: 0.4 },
    ]);
  });

  it('notices a baseline entry whose asset is gone, so the file cannot rot', () => {
    const { stale } = judgeReadings([], { 'deleted.png': { pct: 1, reason: 'x' } }, FLOOR);
    expect(stale).toEqual(['deleted.png']);
  });
});

describe('the baseline is a record of work done, not a list of excuses', () => {
  const entries = Object.entries(baseline.assets);

  it('holds only assets that actually exist', () => {
    const missing = entries.filter(([rel]) => !existsSync(join(ROOT, rel))).map(([rel]) => rel);
    expect(missing, 'baseline entries with no file').toEqual([]);
  });

  it('gives every entry a reason that says what was looked at', () => {
    for (const [rel, entry] of entries) {
      expect(entry.reason, `${rel} has no reason`).toBeTruthy();
      expect(entry.reason.startsWith('TODO'), `${rel} still says TODO`).toBe(false);
      // A reason is an argument from evidence. Sixty characters is not a
      // threshold anyone should tune; it is the length below which nobody has
      // said which picture they opened.
      expect(entry.reason.length, `${rel} reason is too short to be one`).toBeGreaterThan(60);
    }
  });

  it('records nothing below the floor, because below the floor needs no excuse', () => {
    const floor = Math.round(MIN_FRACTION * 1000) / 10;
    for (const [rel, entry] of entries) {
      expect(entry.pct, `${rel} is recorded but reads below the floor`).toBeGreaterThanOrEqual(
        floor
      );
    }
  });

  it('still names the inspected artwork the detector was proven wrong about', () => {
    // If one of these leaves the baseline it means somebody cleaned it. That
    // is a decision about Dan's art, not a refactor, and it should be read as
    // one - the reasons above say what cleaning each of them destroys.
    expect(Object.keys(baseline.assets).sort()).toEqual([
      'public/assets/club-buttons/club/club-identity-icon-club-v1.png',
      'public/assets/club-buttons/club/club-identity-icon-player-v1.png',
      'public/assets/club-buttons/console/riveted-console-v1/mid.png',
      'public/assets/club-buttons/console/spade-console-v1/mid.png',
      'public/assets/club-buttons/game-cards/plo/shark-four-bay-v1/live-dot.png',
      'public/assets/club-buttons/wallets/mobile/wallet-union-bank-v1.webp',
      'public/assets/club-buttons/wallets/square/wallet-promo-wallet-square-v1.png',
    ]);
  });

  it('accepts the measured riveted rail and refuses a new white strip on the same pixels', async () => {
    const rel = 'public/assets/club-buttons/console/riveted-console-v1/mid.png';
    const sharp = (await import('sharp')).default;
    const { data, info } = await sharp(join(ROOT, rel))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([729, 8]);
    const reading = (pixels: Uint8Array) =>
      Math.round(matteFraction(pixels, info.width, info.height) * 1000) / 10;
    const floor = Math.round(MIN_FRACTION * 1000) / 10;
    expect(reading(data)).toBe(1.5);
    expect(judgeReadings([{ rel, pct: reading(data) }], baseline.assets, floor).failures).toEqual(
      []
    );

    // Re-export fault on a private pixel buffer, never on the shipped asset.
    const withMatte = new Uint8Array(data);
    for (let y = 0; y < info.height; y++) {
      for (let x = 100; x < 132; x++) {
        withMatte.set([220, 220, 220, 255], (y * info.width + x) * 4);
      }
    }
    const increased = reading(withMatte);
    expect(increased).toBeGreaterThan(1.5);
    expect(judgeReadings([{ rel, pct: increased }], baseline.assets, floor).failures).toEqual([
      { rel, pct: increased, allowed: 1.5 },
    ]);
  });
});

describe('the port agrees with the Python the artists run', () => {
  // scripts/art/clean-shell-matte.py is the authority and is what cleans a
  // plate. This is the Node reading of the same files, and the two were run
  // side by side over all 148 assets on 2026-09-11 with no disagreement. The
  // numbers below are the ones both produced; a change to either that moves
  // them shows up here and in the baseline at once.
  const PINNED: ReadonlyArray<readonly [string, number]> = [
    // Original passing inputs are versioned to avoid overwriting encoded pool URLs.
    ['public/assets/club-buttons/club-nav-shell-d45f56465bad.png', 0.0],
    ['public/assets/club-buttons/wallet-row-shell-e7964bb1791f.webp', 0.3],
    ['public/assets/club-buttons/club/club-identity-icon-club-v1.png', 7.8],
    ['public/assets/club-buttons/console/spade-console-v1/mid.png', 4.2],
  ];

  // Written out rather than `it.each`: its printf titles render this set as
  // "reads 0% undefined", and a CI line nobody can read is a CI line nobody
  // reads.
  for (const [rel, expected] of PINNED) {
    it(`${rel} reads ${expected} percent`, async () => {
      const sharp = (await import('sharp')).default;
      const { data, info } = await sharp(join(ROOT, rel))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const pct = Math.round(matteFraction(data, info.width, info.height) * 1000) / 10;
      expect(pct).toBe(expected);
    });
  }
});
