/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SeededRandom — fast, seedable, NON-cryptographic PRNG for equity estimation
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Monte-Carlo equity does NOT need a CSPRNG: the deck it shuffles is a throwaway
 * simulation deck, never a real deal. The production card deck still uses
 * CryptoRandom (crypto.getRandomValues). Using a mulberry32 PRNG here removes the
 * ~45 crypto syscalls PER shuffle (thousands per equity call) that were freezing
 * the event loop, and makes every estimate deterministic per (seed, inputs) so
 * results are reproducible and cacheable.
 *
 * mulberry32: 32-bit state, excellent speed, passes standard smallcrush-level
 * uniformity for our use (win/tie counting), single imul per step.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    // Force to uint32; avoid the degenerate all-zero state.
    this.state = seed >>> 0;
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number {
    if (maxExclusive <= 1) return 0;
    return Math.floor(this.next() * maxExclusive);
  }

  /** In-place Fisher-Yates shuffle using this PRNG. */
  shuffle<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
  }
}

/** Deterministic 32-bit FNV-1a hash of the given parts — used to derive seeds. */
export function hashSeed(...parts: Array<string | number>): number {
  let h = 0x811c9dc5;
  const str = parts.join('|');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
