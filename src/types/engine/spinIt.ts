/**
 * Spin-It prize configuration types.
 *
 * Extracted 2026-04-23 (Phase U2 Stage A.1) from `src/engine/SpinItEngine.ts`
 * so that UI components can reference these shapes without pulling in the
 * client-side engine module. The Hetzner game server is the authoritative
 * source for Spin-It game logic; the client only renders.
 */

export type SpinMultiplier = 2 | 3 | 5 | 10 | 25 | 50 | 100;

export interface SpinPrizeConfig {
  multiplier: SpinMultiplier;
  weight: number; // Probability weight (higher = more common)
  label: string;
  color: string;
}
