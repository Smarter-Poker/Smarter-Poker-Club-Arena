import { describe, expect, it } from 'vitest';
import {
  potViewportPoint,
  viewportPointInFrame,
  winnerViewportPoint,
} from '../../src/lib/chipAwardGeometry';
function rect(element: Element, left: number, top: number, width: number, height: number) {
  element.getBoundingClientRect = () => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON() {},
  });
}
describe('payout geometry follows each rendered recipient', () => {
  it('targets the actual plate after hero lift, top-pod translation and a viewport resize', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<div data-player-id="top"><div class="seat__info"></div></div><div data-player-id="hero"><div class="seat__info"></div></div><div class="pot-display"><div class="pot-display__pile"></div></div>';
    const top = root.querySelector('[data-player-id="top"] .seat__info')!;
    const hero = root.querySelector('[data-player-id="hero"] .seat__info')!;
    rect(top, 150, 65, 80, 40);
    rect(hero, 140, 720, 100, 48);
    expect(winnerViewportPoint(root, 'top', { x: 0, y: 0 })).toEqual({ x: 190, y: 85 });
    expect(winnerViewportPoint(root, 'hero', { x: 0, y: 0 })).toEqual({ x: 190, y: 744 });
    rect(hero, 160, 650, 90, 44);
    expect(winnerViewportPoint(root, 'hero', { x: 0, y: 0 })).toEqual({ x: 205, y: 672 });
    rect(root.querySelector('.pot-display__pile')!, 180, 300, 40, 16);
    expect(potViewportPoint(root, { x: 0, y: 0 })).toEqual({ x: 200, y: 308 });
  });
  it('converts viewport endpoints through an offset and scaled table tile exactly once', () => {
    const frame = { left: 400, top: 120, width: 200, height: 400 };
    expect(viewportPointInFrame({ x: 500, y: 420 }, frame, 400, 800)).toEqual({ x: 200, y: 600 });
    expect(
      viewportPointInFrame({ x: 20, y: 60 }, { left: 0, top: 0, width: 400, height: 800 }, 400, 800)
    ).toEqual({ x: 20, y: 60 });
  });
});
