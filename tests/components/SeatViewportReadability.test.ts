import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SEAT_LAYOUTS } from '../../src/lib/tableSeatGeometry';
import { fitSeatToViewport, seatPodPx } from '../../src/components/table/tableGeometry';

describe('larger player plates remain visible on the narrow phone', () => {
  for (const width of [320, 375, 393, 430, 784, 1440]) {
    it(`keeps every occupied ring inside a ${width}px viewport`, () => {
      const canvas = { w: Math.min(width, 600), h: (Math.min(width, 600) * 1000) / 605 };
      const left = (width - canvas.w) / 2;
      for (const ring of Object.values(SEAT_LAYOUTS))
        for (const seat of ring) {
          const pod = seatPodPx(width, seat.y >= 100 && seat.x === 50, canvas.w);
          const fitted = fitSeatToViewport(seat, canvas, width, pod, left);
          const centre = left + (fitted.x / 100) * canvas.w;
          expect(centre - pod.w / 2).toBeGreaterThanOrEqual(2 - 1e-8);
          expect(centre + pod.w / 2).toBeLessThanOrEqual(width - 2 + 1e-8);
          expect(fitted.y).toBe(seat.y);
        }
    });
  }
  it('preserves a chair with enough room instead of moving the whole ring', () => {
    const seat = { x: 8, y: 25 };
    expect(fitSeatToViewport(seat, { w: 400, h: 660 }, 1440, { w: 98, h: 132 })).toBe(seat);
  });
  it('the shared fitted ring drives every table visual consumer', () => {
    const source = readFileSync('src/pages/TablePage.tsx', 'utf8');
    expect(source).toMatch(/seatRotationMap\.map\(\(\{ pos \}\) =>\s*fitSeatToViewport/);
    expect(source).toContain('seatPositionsRef.current = seatPositions');
    expect(source).toContain('seatPositions.map((pos, idx)');
    expect(source).toContain('seatPositions={seatPositions}');
  });
});
