import { describe, it, expect } from 'vitest';
import {
  anticipationFrame,
  ANTICIPATION_STEP,
  approachFrame,
  APPROACH_COMMITTED,
  APPROACH_REST_Z,
  APPROACH_STOPPED,
  collisionAt,
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

/**
 * EVERY STREET GETS A BEAT (review 2026-09-22). The donkey stood still through
 * the network wait, and a safe street was a hop across a lane the scene had
 * cleared of traffic: there was never a car to time a crossing against. The
 * same car comes to every street now and either brakes or does not, and until
 * it is too late to tell the two apart it drives exactly the same line.
 */
describe('the same car comes to every street and either brakes or does not', () => {
  const ROLL = [0, 100, 200, 260, 330, 460, 600, 745, 900, 1100, 1270, 1600];
  it('steps the donkey toward the kerb without ever reaching the lane', () => {
    expect(anticipationFrame(0, 1)).toBe(0);
    expect(anticipationFrame(130, 1)).toBeGreaterThan(0);
    expect(anticipationFrame(260, 1)).toBeCloseTo(ANTICIPATION_STEP, 10);
    for (const speed of [0.5, 1, 2])
      for (const ms of [-50, 0, 60, 200, 400, 5000]) {
        const step = anticipationFrame(ms, speed);
        expect(step).toBeGreaterThanOrEqual(0);
        expect(step).toBeLessThanOrEqual(ANTICIPATION_STEP);
        // The kerb of the street the donkey is standing on, less its own width.
        expect(step).toBeLessThanOrEqual(STREET_WIDTH / 2 - 0.2);
      }
    // A slower setting takes longer to reach the same kerb, never further.
    expect(anticipationFrame(260, 2)).toBeLessThan(anticipationFrame(260, 1));
    expect(anticipationFrame(0, 1, true)).toBe(0);
    expect(anticipationFrame(9000, 1, true)).toBe(0);
  });

  it('drives one line for both outcomes until it is too late to tell them apart', () => {
    for (const speed of [0.5, 1, 2])
      for (const ms of ROLL) {
        const safe = approachFrame(ms * speed, speed, 'safe');
        const hit = approachFrame(ms * speed, speed, 'hit');
        expect(hit).toMatchObject(collisionAt(ms * speed, speed));
        expect(hit.brake).toBe(0);
        if (safe.t <= APPROACH_COMMITTED) expect(safe.carZ).toBeCloseTo(hit.carZ, 10);
        expect(safe.carZ).toBeGreaterThanOrEqual(APPROACH_REST_Z);
        expect(safe.hit).toBe(false);
        expect(safe.fall).toBe(0);
      }
  });

  it('brings the braking car to rest on the line, level with the hit', () => {
    const at = (t: number) => approachFrame(220 + t * 1050, 1, 'safe');
    expect(at(APPROACH_COMMITTED).carZ).toBeCloseTo(4.5, 10);
    expect(at(APPROACH_COMMITTED).brake).toBe(0);
    expect(at(0.36).brake).toBeGreaterThan(0);
    expect(at(0.36).resting).toBe(false);
    expect(at(APPROACH_STOPPED).carZ).toBeCloseTo(APPROACH_REST_Z, 10);
    expect(at(APPROACH_STOPPED).brake).toBe(1);
    expect(at(APPROACH_STOPPED).resting).toBe(true);
    // It is still there a street later; it leaves when the donkey has moved on.
    expect(at(0.9).carZ).toBeCloseTo(APPROACH_REST_Z, 10);
    // The hit lands within a frame or two of the brake coming to rest.
    expect(collisionFrame(APPROACH_STOPPED * 1050).hit).toBe(false);
    expect(collisionFrame(0.5 * 1050).hit).toBe(true);
  });

  it('draws the final frame of either outcome under reduced motion', () => {
    expect(approachFrame(0, 1, 'safe', true)).toMatchObject({
      carZ: APPROACH_REST_Z,
      brake: 1,
      resting: true,
      hit: false,
    });
    expect(approachFrame(0, 1, 'hit', true)).toMatchObject({
      carZ: -9,
      hit: true,
      fall: 1,
      resting: true,
    });
  });
});
