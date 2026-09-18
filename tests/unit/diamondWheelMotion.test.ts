import { describe, expect, it } from 'vitest';
import {
  wheelTravel,
  wheelLandingRotation,
  wheelPegTimes,
  WHEEL_SPIN_MS,
} from '../../src/utils/diamondWheelMotion';

describe('the wheel motion follows the server result', () => {
  it.each([4, 12])('lands every one of %i slots at the fixed pointer from any heading', (count) => {
    for (const from of [0, 17.5, 359.9, 5081]) {
      for (let index = 0; index < count; index += 1) {
        const result = wheelLandingRotation(from, index, count);
        expect(result - from).toBeGreaterThanOrEqual(7 * 360);
        const position = (result + ((index + 0.5) * 360) / count) % 360;
        expect(Math.min(position, 360 - position)).toBeLessThan(0.00001);
      }
    }
  });

  it('accelerates, coasts and slows smoothly without reversing or overshooting', () => {
    expect(wheelTravel(0)).toBe(0);
    expect(wheelTravel(1)).toBeCloseTo(1, 12);
    const samples = Array.from({ length: 1001 }, (_, i) => wheelTravel(i / 1000));
    expect(samples.every((v, i) => v >= 0 && v <= 1 && (!i || v >= samples[i - 1]))).toBe(true);
    const velocity = (t: number) => (wheelTravel(t + 0.0001) - wheelTravel(t)) / 0.0001;
    expect(velocity(0.01)).toBeLessThan(velocity(0.1));
    expect(velocity(0.15)).toBeCloseTo(velocity(0.3), 6);
    expect(velocity(0.5)).toBeGreaterThan(velocity(0.8));
    expect(velocity(0.999)).toBeLessThan(0.0001);
  });

  it('schedules one tick at each real seam and no tick at the final centre', () => {
    const from = 17;
    const to = wheelLandingRotation(from, 9, 12);
    const ticks = wheelPegTimes(from, to, 12, WHEEL_SPIN_MS);
    expect(ticks.length).toBe(Math.floor(to / 30) - Math.floor(from / 30));
    ticks.forEach((ms, i) => {
      expect(ms).toBeGreaterThan(i ? ticks[i - 1] : 0);
      expect(ms).toBeLessThan(WHEEL_SPIN_MS);
      const actualAngle = from + (to - from) * wheelTravel(ms / WHEEL_SPIN_MS);
      expect(actualAngle).toBeCloseTo((i + 1) * 30, 4);
    });
    const fast = wheelPegTimes(from, to, 12, WHEEL_SPIN_MS / 2);
    expect(fast[10]).toBeCloseTo(ticks[10] / 2, 7);
  });
});
