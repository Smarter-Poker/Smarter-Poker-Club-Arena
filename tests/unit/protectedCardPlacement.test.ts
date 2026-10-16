import { describe, expect, it } from 'vitest';
import { placeProtectedCardRow, type CardBox } from '../../src/lib/protectedCardPlacement';
const overlap = (a: CardBox, b: CardBox) =>
  a.left < b.left + b.width &&
  a.left + a.width > b.left &&
  a.top < b.top + b.height &&
  a.top + a.height > b.top;
describe('revealed cards leave boards and totals clear', () => {
  for (const width of [320, 375, 393, 430, 768, 1440]) {
    for (const boards of [1, 2, 3]) {
      it(`${width}px, ${boards} boards: protects both runs, totals and player boxes`, () => {
        const bounds = { left: 0, top: 0, width, height: 852 };
        const protectedBoxes: CardBox[] = [
          { left: width * 0.2, top: 300, width: width * 0.6, height: 70 * boards },
          { left: width * 0.35, top: 240, width: width * 0.3, height: 48 },
          { left: 0, top: 420, width: width * 0.23, height: 40 },
        ];
        const row = { left: width * 0.08, top: 360, width: width * 0.23, height: 32 };
        const placed = placeProtectedCardRow(row, protectedBoxes, bounds);
        expect(placed).not.toBeNull();
        expect(protectedBoxes.every((box) => !overlap(placed!, box))).toBe(true);
        expect(placed!.width).toBe(row.width);
        expect(placed!.left).toBeGreaterThanOrEqual(0);
        expect(placed!.left + placed!.width).toBeLessThanOrEqual(width);
      });
    }
  }
  it('leaves an already clear hand beside its own seat', () => {
    const row = { left: 10, top: 30, width: 80, height: 32 };
    expect(placeProtectedCardRow(row, [], { left: 0, top: 0, width: 393, height: 852 })).toEqual(
      row
    );
  });
});
