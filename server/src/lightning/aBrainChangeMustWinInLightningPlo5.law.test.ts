/**
 * LAW (Dan, 2026-10-24): A BRAIN CHANGE HAS TO PROVE IT STILL WINS IN LIGHTNING (PLO5).
 *
 * The PLO5 half of aBrainChangeMustWinInLightning.law.test.ts, in its own file
 * (its own test process) since 2026-10-25, when each archetype went from one
 * fixed deal to three and both games together exhausted one worker's memory.
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
  plo5: { maniac: 0, station: 500, nit: 0, reg: 20 },
  // PLO5 v nit measured 8.1 bb/100 after main's V53 aggressive-human pressure (#7957, #7958), down from 54.7: still a win, so the floor is "win".
};

/** Fixed deals per archetype; the first is the original 2026-10-24 deal. */
const LEGS = 3;

describe('LAW: a brain change has to prove it still wins in Lightning (PLO5)', () => {
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
