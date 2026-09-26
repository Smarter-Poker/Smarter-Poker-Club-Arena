import { describe, expect, it } from 'vitest';
import { sparkleScatter } from '../../src/components/plinko/plinkoCabinet';

/**
 * The sparkle trail scatters its sparkles without Math.random (the render
 * surface law): the n-th sparkle always lands in the same place, inside [0, 1).
 */
describe('the Plinko sparkle scatter', () => {
  it('is deterministic, inside [0, 1), and spread across the range', () => {
    const values = Array.from({ length: 400 }, (_, n) => sparkleScatter(n));
    expect(values).toEqual(Array.from({ length: 400 }, (_, n) => sparkleScatter(n)));
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    const buckets = new Array(10).fill(0);
    for (const v of values) buckets[Math.floor(v * 10)] += 1;
    for (const count of buckets) expect(count).toBeGreaterThan(15);
  });
});
