import { remainingVariantSpot } from './RemainingVariantPolicyEvidence.js';
import { evaluateRemainingVariantPolicy } from '../engine/remainingVariants/RemainingVariantLivePolicy.js';
import { remainingVariantSeatCap } from '../engine/remainingVariants/RemainingVariantPolicyPack.js';
import { seedFastRandom, saveFastRandom, restoreFastRandom } from '../engine/HorseEval.js';

/** Measured wall-clock probe, separate from deterministic strategy evidence.
 * Includes core facts, public-range sampling and policy. Actual fleet utility
 * and host queue latency remain separate natural-deployment proof. */
export async function runRemainingVariantPerformance(repeats = 30) {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 100)
    throw new Error('Invalid timing repetitions');
  const saved = saveFastRandom();
  const rows = [];
  try {
    for (const variant of ['short_deck', 'pineapple', 'flh', 'flo8'] as const)
      for (const mode of ['cash', 'tournament'] as const)
        for (const seats of remainingVariantSeatCap(variant, mode)
          ? [2, remainingVariantSeatCap(variant, mode)]
          : [])
          for (const street of ['preflop', 'flop', 'turn', 'river'] as const) {
            const spot = remainingVariantSpot(variant, street, seats, mode);
            const times: number[] = [],
              samples: number[] = [];
            const reasons: Record<string, number> = {};
            let fired = 0,
              eligible = 0;
            for (let i = -5; i < repeats; i++) {
              seedFastRandom(121001 + Math.max(0, i));
              const r = evaluateRemainingVariantPolicy(
                spot.hero,
                spot.state,
                spot.baseline,
                null,
                'shadow'
              ).receipt;
              if (i < 0) continue;
              times.push(r.latencyMs);
              samples.push(r.equity?.samples ?? 0);
              fired += Number(r.fired);
              eligible += Number(r.eligible);
              reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
            }
            times.sort((a, b) => a - b);
            rows.push({
              variant,
              mode,
              seats,
              street,
              repeats,
              eligible,
              fired,
              completedShare: fired / repeats,
              p50Ms: times[Math.ceil(times.length * 0.5) - 1],
              p99Ms: times[Math.ceil(times.length * 0.99) - 1],
              maximumMs: times.at(-1),
              reasons,
              samples,
              times,
            });
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
    return {
      scope: 'isolated_policy_not_fleet_latency',
      repeats,
      rows,
      total: rows.reduce((n, r) => n + r.repeats, 0),
      fired: rows.reduce((n, r) => n + r.fired, 0),
    };
  } finally {
    restoreFastRandom(saved);
  }
}
