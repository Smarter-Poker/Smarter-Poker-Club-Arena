import { randomInt as nodeRandomInt, randomFillSync } from 'node:crypto';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CRYPTO RANDOM — Cryptographically Secure Random Number Generator
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Provides a secure replacement for Math.random() using crypto.getRandomValues()
 * where available, falling back to node:crypto. There is no Math.random() path:
 * a runtime with neither is a runtime this engine must not deal cards on.
 *
 * Ported from client: src/engine/CryptoRandom.ts (93 lines — identical logic)
 * Server adaptation: None needed — already works in Node.js.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// CORE: Secure random integer in range [0, max)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a cryptographically secure random integer in range [0, exclusiveMax).
 * Uses rejection sampling to avoid modulo bias.
 */
export function secureRandomInt(exclusiveMax: number): number {
  if (exclusiveMax <= 0) return 0;
  if (exclusiveMax === 1) return 0;

  // Browser: crypto.getRandomValues
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    const array = new Uint32Array(1);
    const maxValid = Math.floor(0xffffffff / exclusiveMax) * exclusiveMax;

    // Rejection sampling to eliminate modulo bias
    let value: number;
    do {
      globalThis.crypto.getRandomValues(array);
      value = array[0];
    } while (value >= maxValid);

    return value % exclusiveMax;
  }

  // Dan 2026-07-28 (engine audit D23): this branch used to test
  // `globalThis.crypto?.randomInt`. `globalThis.crypto` is the WebCrypto object,
  // and WebCrypto has no `randomInt` — that method only exists on Node's own
  // `node:crypto` module. So the condition was ALWAYS false and this was never a
  // fallback at all: any runtime that reached here went straight to Math.random()
  // for every shuffle in the process. It only stayed invisible because Node 19+
  // exposes getRandomValues and satisfies the branch above.
  //
  // node:crypto.randomInt is itself rejection-sampled, so this path is uniform.
  return nodeRandomInt(exclusiveMax);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVENIENCE: Secure random float in [0, 1)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a cryptographically secure random float in [0, 1).
 * Precision: 32-bit (same as Math.random in V8).
 */
export function secureRandom(): number {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    const array = new Uint32Array(1);
    globalThis.crypto.getRandomValues(array);
    return array[0] / 0x100000000;
  }

  // Same defect as secureRandomInt: the old `globalThis.crypto.randomInt` test
  // could never be true, so this silently degraded to Math.random(). Draw the
  // bytes from node:crypto instead.
  const buf = new Uint32Array(1);
  randomFillSync(buf);
  return buf[0] / 0x100000000;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHUFFLE: Cryptographically secure Fisher-Yates shuffle
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fisher-Yates in-place shuffle using cryptographically secure random.
 * Drop-in replacement for Math.random()-based shuffles.
 */
export function secureShuffle<T>(array: T[]): void {
  for (let i = array.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
}
