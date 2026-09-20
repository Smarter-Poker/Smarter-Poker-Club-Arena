import { describe, it, expect } from 'vitest';
import {
  collisionFrame,
  crossingTrafficVisible,
  DONKEY_SCALE,
  STREET_WIDTH,
  streetCenter,
} from '../../src/utils/crossingScene';
import { isDiamondGameRoute } from '../../src/utils/diamondGameRoute';
describe('the road is clear until a confirmed failed crossing', () => {
  it('keeps the current and prospective street clear for every playable step', () => {
    for (let step = 0; step < 15; step++) {
      expect(crossingTrafficVisible(step, step, false)).toBe(false);
      expect(crossingTrafficVisible(step + 1, step, false)).toBe(false);
      expect(crossingTrafficVisible(step + 2, step, false)).toBe(true);
      expect(crossingTrafficVisible(step, step + 1, true)).toBe(false);
      expect(crossingTrafficVisible(step + 1, step + 1, true)).toBe(false);
    }
  });
  it('fits the complete sculpt within one street around its center', () => {
    // Sculpt extent x=-1.05..1.24, offset=-.12; both extrema must stay inside the lane.
    expect(1.05 * DONKEY_SCALE + 0.12).toBeLessThan(STREET_WIDTH / 2);
    expect(1.24 * DONKEY_SCALE - 0.12).toBeLessThan(STREET_WIDTH / 2);
    expect(streetCenter(3) - streetCenter(2)).toBeCloseTo(STREET_WIDTH, 10);
  });
  it('drives the collision car through the donkey before completing the loss', () => {
    expect(collisionFrame(0)).toMatchObject({ carZ: 9, hit: false, finished: false });
    expect(collisionFrame(525)).toMatchObject({ carZ: 0, hit: true, finished: false });
    expect(collisionFrame(1050)).toMatchObject({ carZ: -9, hit: true, finished: true, fall: 1 });
    expect(collisionFrame(0, true).finished).toBe(true);
  });
});
describe('the wheel and playable Diamond games hide the surrounding app chrome', () => {
  it('matches the wheel and four game routes while preserving operations and other pages', () => {
    for (const game of ['wheel', 'plinko', 'crash', 'crossing', 'mines'])
      expect(isDiamondGameRoute(`/clubs/example/${game}`)).toBe(true);
    for (const route of [
      '/clubs/example/diamond-games',
      '/clubs/example/diamond-games-operations',
      '/clubs/example',
      '/clubs/example/mines/history',
    ])
      expect(isDiamondGameRoute(route)).toBe(false);
  });
});
