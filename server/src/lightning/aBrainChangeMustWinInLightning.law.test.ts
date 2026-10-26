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
  nlh: { maniac: 0, station: 500, nit: 10, reg: 20 },
  // PLO5 lives in aBrainChangeMustWinInLightningPlo5.law.test.ts: three deals of
  // both games in one process ran the test worker out of memory (2026-10-25).
};

/** Fixed deals per archetype; the first is the original 2026-10-24 deal. */
const LEGS = 3;

describe('LAW: a brain change has to prove it still wins in Lightning', () => {
  for (const variant of Object.keys(FLOORS))
    for (const archetype of ['maniac', 'station', 'nit', 'reg'] as const)
      it(`${variant}: the horses beat the ${archetype}`, async () => {
        vi.useFakeTimers({
          toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
        });
        try {
          vi.setSystemTime(Date.UTC(2026, 9, 24));
          // Three fixed deals (the original 2026-10-24 deal first). One deal of
          // 250 hands is a coin flip: on 2026-10-25 the hold'em premium rule
          // moved NLH v nit on the original deal from +39.8 to -22.5 bb/100
          // while 8 seeds x 500 hands measured 124 -> 119 (no change). The
          // floors are unchanged; the mean of three deals is what must clear.
          let won = 0;
          let hands = 0;
          for (let leg = 0; leg < LEGS; leg++) {
            deckState =
              0x9e3779b9 ^ (variant.length * 7919 + archetype.length * 104729 + leg * 15485863);
            const r = await playLightningMatrix({
              archetype,
              variant,
              hands: 250,
              seed: 20261024 + leg,
            });
            console.log(
              `[lightning-matrix] ${variant} ${archetype} deal ${leg}: ${r.horsesBB100.toFixed(1)} bb/100 over ${r.hands}`
            );
            expect(r.hands).toBeGreaterThanOrEqual(240);
            won += r.horsesBB100 * r.hands;
            hands += r.hands;
          }
          const mean = won / hands;
          console.log(`[lightning-matrix] ${variant} ${archetype}: ${mean.toFixed(1)} bb/100 mean`);
          expect(mean).toBeGreaterThan(FLOORS[variant]![archetype]!);
        } finally {
          vi.useRealTimers();
        }
      }, 540_000);
});

it('the fixed Lightning experiment ignores ambient host randomness', async () => {
  const results = [];
  // A fresh module graph gives both experiments the same cold equity caches.
  // Otherwise the first run's memoized MC results also shift the draw stream.
  for (const ambient of [0, 0.999999]) {
    vi.resetModules();
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const random = vi.spyOn(Math, 'random').mockReturnValue(ambient);
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 24));
      deckState = 0x9e3779b9 ^ ('nlh'.length * 7919 + 'maniac'.length * 104729);
      const { playLightningMatrix: freshMatrix } =
        await import('../testing/lightningStrengthMatrix.js');
      results.push(
        await freshMatrix({ archetype: 'maniac', variant: 'nlh', hands: 40, seed: 20261024 })
      );
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  }
  expect(results[0]?.hands).toBe(40);
  expect(results[1]).toEqual(results[0]);
}, 180_000);
