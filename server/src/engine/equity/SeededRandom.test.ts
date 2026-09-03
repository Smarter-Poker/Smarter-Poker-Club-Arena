import { describe, it, expect } from 'vitest';
import { SeededRandom, hashSeed } from './SeededRandom.js';

describe('SeededRandom', () => {
  it('is reproducible: same seed => identical sequence', () => {
    const a = new SeededRandom(12345);
    const b = new SeededRandom(12345);
    const seqA = Array.from({ length: 100 }, () => a.next());
    const seqB = Array.from({ length: 100 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('differs across seeds', () => {
    const a = new SeededRandom(1);
    const b = new SeededRandom(2);
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it('next() stays within [0, 1)', () => {
    const r = new SeededRandom(999);
    for (let i = 0; i < 100000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('nextInt is uniform across buckets (chi-square sanity)', () => {
    const r = new SeededRandom(7);
    const k = 10;
    const N = 200000;
    const counts = new Array(k).fill(0);
    for (let i = 0; i < N; i++) counts[r.nextInt(k)]++;
    const expected = N / k;
    // Each bucket within 5% of expectation is comfortably uniform for N=200k.
    for (const c of counts) {
      expect(Math.abs(c - expected) / expected).toBeLessThan(0.05);
    }
  });

  it('shuffle is a permutation (no loss/dup) and reproducible', () => {
    const base = Array.from({ length: 52 }, (_, i) => i);
    const a = base.slice();
    const b = base.slice();
    new SeededRandom(42).shuffle(a);
    new SeededRandom(42).shuffle(b);
    expect(a).toEqual(b); // reproducible
    expect(a.slice().sort((x, y) => x - y)).toEqual(base); // permutation
  });

  it('hashSeed is deterministic and order-sensitive', () => {
    expect(hashSeed('a', 1, 'b')).toBe(hashSeed('a', 1, 'b'));
    expect(hashSeed('a', 'b')).not.toBe(hashSeed('b', 'a'));
  });
});
