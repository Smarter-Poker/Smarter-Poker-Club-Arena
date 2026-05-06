import { reportError } from '../services/errorReporter.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CRYPTO RANDOM — Cryptographically Secure Random Number Generator
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Provides a secure replacement for Math.random() using crypto.getRandomValues()
 * (browser) or crypto.randomInt (Node.js). Falls back to Math.random() only
 * when no crypto API is available.
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

  // Node.js: use globalThis.crypto if available (Node 19+)
  if (typeof globalThis !== 'undefined' && (globalThis as any).crypto?.randomInt) {
    return (globalThis as any).crypto.randomInt(exclusiveMax);
  }

  // Fallback: Math.random() (non-crypto, log warning once)
  if (!_warnedFallback) {
    _warnedFallback = true;
    reportError(
      new Error('[CryptoRandom] No crypto API available — falling back to Math.random()'),
      'CryptoRandom.No_crypto_API_available__falli'
    );
  }
  return Math.floor(Math.random() * exclusiveMax);
}

let _warnedFallback = false;

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

  if (typeof globalThis !== 'undefined' && (globalThis as any).crypto?.randomInt) {
    return (globalThis as any).crypto.randomInt(0x100000000) / 0x100000000;
  }

  return Math.random();
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
