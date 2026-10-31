import { describe, expect, it } from 'vitest';
import { seatPodPx } from '../src/components/table/tableGeometry';

describe('all occupied player pods use the hero size', () => {
  it.each([320, 375, 393, 600, 1024])(
    'keeps first-paint fallback pods equal at %spx',
    (viewport) => {
      expect(seatPodPx(viewport, false)).toEqual(seatPodPx(viewport, true));
    }
  );
  for (const [viewport, width, height] of [
    [320, 262, 324],
    [375, 307, 450],
    [393, 322, 530],
    [600, 490, 790],
    [1024, 650, 1100],
  ]) {
    it(`keeps hero and every opponent equal at ${viewport}px`, () => {
      for (const seats of [2, 6, 7, 8, 9]) {
        const ring = { seats, canvasHeightPx: height };
        const hero = seatPodPx(viewport, true, width, ring);
        expect(seatPodPx(viewport, false, width, ring)).toEqual(hero);
        // Preserve the existing hero width, rather than making the hero smaller.
        const full = (Math.min(124, Math.max(50, width * 0.158)) * 4) / 3;
        const slot =
          viewport <= 480 && height > width
            ? Math.min(
                full,
                viewport <= 340
                  ? Math.max(32, 32 + (height - 324) * 0.75)
                  : Math.max(36, 40 + (height - 324) * 0.25)
              )
            : full;
        expect(hero.w).toBeCloseTo(
          Math.max(Math.min(112, Math.max(66, width * 0.235)), (slot * 8) / 7)
        );
      }
    });
  }
});
