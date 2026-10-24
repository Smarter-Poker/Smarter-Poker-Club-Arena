/**
 * LAW (Dan, 2026-10-24): A BRAIN CHANGE HAS TO PROVE IT STILL WINS IN LIGHTNING.
 *
 * The Lightning strength matrix (testing/lightningStrengthMatrix.ts) plays the
 * real LightningHandHost, HandController and horse brain, learning the way the
 * production worker learns, against one archetype who meets a brand-new table
 * of brand-new horses every hand - exactly how a person meets the pool. The
 * deck and the brain's jitter are seeded, so the run is a fixed experiment: a
 * changed number is a changed brain.
 *
 * Every horse change that reaches this repo must keep the horses winning
 * against each archetype in hold'em and PLO5. The floors sit well under the
 * measured results (2026-10-24, recorded beside each) so ordinary tuning moves
 * them freely; a change that makes the horses LOSE to any of them fails here.
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access in the Lightning matrix');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC in the Lightning matrix');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn(), describeError: String }));
// A seeded deck: the same Fisher-Yates, driven by a fixed stream.
let deckState = 1;
vi.mock('../engine/CryptoRandom.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../engine/CryptoRandom.js')>();
  return {
    ...real,
    secureShuffle<T>(array: T[]): void {
      for (let i = array.length - 1; i > 0; i--) {
        deckState ^= deckState << 13;
        deckState ^= deckState >>> 17;
        deckState ^= deckState << 5;
        const j = (deckState >>> 0) % (i + 1);
        [array[i], array[j]] = [array[j]!, array[i]!];
      }
    },
  };
});
const { playLightningMatrix } = await import('../testing/lightningStrengthMatrix.js');

/** Floors in horses' bb/100 against the archetype; measured result in the comment. */
const FLOORS: Record<string, Record<string, number>> = {
  nlh: { maniac: 50, station: 500, nit: 10, reg: 20 },
  plo5: { maniac: 50, station: 500, nit: 10, reg: 20 },
};

describe('LAW: a brain change has to prove it still wins in Lightning', () => {
  for (const variant of Object.keys(FLOORS))
    for (const archetype of ['maniac', 'station', 'nit', 'reg'] as const)
      it(`${variant}: the horses beat the ${archetype}`, async () => {
        vi.useFakeTimers({
          toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
        });
        deckState = 0x9e3779b9 ^ (variant.length * 7919 + archetype.length * 104729);
        const r = await playLightningMatrix({ archetype, variant, hands: 250, seed: 20261024 });
        vi.useRealTimers();
        console.log(
          `[lightning-matrix] ${variant} ${archetype}: ${r.horsesBB100.toFixed(1)} bb/100 over ${r.hands}`
        );
        expect(r.hands).toBeGreaterThanOrEqual(240);
        expect(r.horsesBB100).toBeGreaterThan(FLOORS[variant]![archetype]!);
      }, 180_000);
});
