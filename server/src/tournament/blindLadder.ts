/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BLIND LADDERS — generated, deep, chip-friendly, pure
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (measured on production, 2026-08-31, 579 completed MTTs):
 *
 *   avg levels DEFINED in a structure ............  8.1
 *   avg level actually REACHED ...................  14.0
 *   highest level reached ........................  124
 *   events that ran PAST their own structure ..... 554 / 579  = 95.7%
 *
 * Every structure on the platform was 5-12 levels long, and blindEscalation
 * then invented the rest by DOUBLING once per level. The consequences, same
 * window:
 *
 *   ended with peak BB at the DECIMAL(10,2) ceiling (10,000,000) ..  41  (7.1%)
 *   ended with peak BB > every chip ever issued in the event ......  72 (12.4%)
 *   ended with all chips in play worth under 3 big blinds ......... 221 (38.1%)
 *   ended in a healthy > 20 BB state ..............................  18  (3.1%)
 *
 * Seven of the eight largest fields (486-500 entrants, 12k-30k stacks) ended
 * with the big blind at 10,000,000 — a blind larger than the sum of every chip
 * in the tournament. That endgame is a forced all-in lottery, not poker.
 *
 * THE LADDER IS A MANTISSA CYCLE, NOT A MULTIPLIER. Real tournament ladders do
 * not multiply by a constant; they walk a repeating set of chip-friendly
 * mantissas and step up a decade each time round: 50, 75, 100, 150, 200, 300,
 * 400, 500, 600, 800, 1000, 1500, ... Two properties fall out of that, and both
 * matter more than the average ratio:
 *
 *   1. every value is a real chip denomination, so no level ever asks for a
 *      blind the chips cannot make;
 *   2. the ladder is defined for any depth, so 40 levels costs no more thought
 *      than 8 and the overflow path stops being load-bearing.
 *
 * Zero imports, on purpose — the same reasoning as payoutStructure.ts,
 * startRules.ts and blindEscalation.ts. This is money-adjacent arithmetic that
 * must be unit-testable without a database.
 */

/**
 * Mantissas within one decade. Ascending, first entry is the decade base.
 * The average step ratio is what gives each speed its character:
 *
 *   SLOW     10 steps/decade -> ~1.26x   deep-stack, long levels
 *   STANDARD  8 steps        -> ~1.33x   the reference MTT ladder
 *   TURBO     5 steps        -> ~1.58x
 *   HYPER     4 steps        -> ~1.78x
 *
 * A real ladder never doubles every level. 2x per level — what this platform
 * did past the end of every structure — is faster than HYPER_TURBO, forever.
 */
export const LADDER_CYCLES = {
  SLOW: [10, 12, 15, 20, 25, 30, 40, 50, 60, 80],
  STANDARD: [10, 15, 20, 30, 40, 50, 60, 80],
  TURBO: [10, 15, 25, 40, 60],
  HYPER_TURBO: [10, 20, 30, 50],
} as const;

export type LadderSpeed = keyof typeof LADDER_CYCLES;

export interface GeneratedBlindLevel {
  level: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  durationMinutes: number;
}

export interface LadderSpec {
  /** Big blind of level 1. The ladder starts here exactly, so advertised copy
   *  ("25/50") stays true. */
  startBigBlind: number;
  speed: LadderSpeed;
  /** How many levels to emit. */
  levels: number;
  /** Minutes for level 1. */
  openingMinutes: number;
  /** Levels never get shorter than this. */
  floorMinutes: number;
  /** Ante appears from this level (1-based). 0 disables antes entirely. */
  anteFromLevel?: number;
  /** Ante as a fraction of the big blind, rounded to a chip-friendly value. */
  anteFraction?: number;
}

/**
 * Chip-friendly values strictly above `min`, walking `cycle` and stepping a
 * decade each time the cycle wraps.
 *
 * `Math.round` on the decade multiply, not raw float multiplication: 15 * 10^3
 * is 15000.000000000002 in IEEE754 for some decades, and a blind of
 * 15000.000000000002 fails a DECIMAL(10,2) column.
 */
function niceValuesFrom(cycle: readonly number[], min: number, count: number): number[] {
  const out: number[] = [];
  if (!Number.isFinite(min) || min <= 0 || count <= 0) return out;

  // Start a couple of decades below and walk up; cheap, and avoids log() edge
  // cases at exact powers of ten.
  let decade = Math.max(0, Math.floor(Math.log10(min / cycle[0])) - 1);
  let guard = 0;

  while (out.length < count) {
    if (++guard > 10_000) break; // cannot happen; never loop forever on money code
    for (const m of cycle) {
      const v = Math.round(m * Math.pow(10, decade));
      if (v > min && out.length < count) out.push(v);
    }
    decade++;
  }
  return out;
}

/**
 * Round an ante to something the chips can actually make, never to zero once
 * antes have started.
 */
function niceAnte(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (raw < 5) return 1;
  const decade = Math.pow(10, Math.floor(Math.log10(raw)));
  const lead = raw / decade;
  const snapped =
    lead < 1.25
      ? 1
      : lead < 1.75
        ? 1.5
        : lead < 2.5
          ? 2
          : lead < 4
            ? 3
            : lead < 5.5
              ? 5
              : lead < 7
                ? 6
                : lead < 9
                  ? 8
                  : 10;
  return Math.round(snapped * decade);
}

/**
 * Level durations taper: the opening levels are the longest, and the ladder
 * settles at `floorMinutes`. Real structures shorten as the field thins because
 * fewer players see fewer hands per level, not to hurry anybody out.
 */
function durationForLevel(level: number, opening: number, floor: number): number {
  const span = Math.max(0, opening - floor);
  const steps = Math.max(0, Math.floor((level - 1) / 3));
  const mins = opening - Math.min(span, steps * Math.max(1, Math.round(span / 4)));
  return Math.max(floor, Math.round(mins));
}

/**
 * Build a full ladder. Deterministic and side-effect free: the same spec always
 * produces the same array, which is what makes it safe to persist at creation
 * and to re-derive after a restart.
 */
export function buildLadder(spec: LadderSpec): GeneratedBlindLevel[] {
  const cycle = LADDER_CYCLES[spec.speed] ?? LADDER_CYCLES.STANDARD;
  const levels = Math.max(1, Math.floor(spec.levels));
  const startBB = Math.max(2, Math.round(spec.startBigBlind));
  const anteFrom = spec.anteFromLevel ?? 2;
  const anteFraction = spec.anteFraction ?? 0.125;

  // Level 1 is exactly the advertised blind; the rest walk the cycle upward.
  const bigBlinds = [startBB, ...niceValuesFrom(cycle, startBB, levels - 1)];

  return bigBlinds.slice(0, levels).map((bb, i) => {
    const level = i + 1;
    const ante = anteFrom > 0 && level >= anteFrom ? niceAnte(bb * anteFraction) : 0;
    return {
      // Half the big blind, floored to a whole chip, never zero.
      level,
      smallBlind: Math.max(1, Math.floor(bb / 2)),
      bigBlind: bb,
      ante,
      durationMinutes: durationForLevel(level, spec.openingMinutes, spec.floorMinutes),
    };
  });
}

/**
 * The observed step ratio of a ladder, used by blindEscalation when a
 * tournament somehow still runs past the end of one. Measured across the last
 * few PLAYABLE levels so it reflects the ladder's own late-game cadence rather
 * than its gentler opening.
 *
 * Clamped hard. A structure with a freak jump in it must not hand the overflow
 * path a 4x-per-level ratio, and a structure with a flat tail must not stall
 * the blinds at a standstill.
 */
export const MIN_OVERFLOW_RATIO = 1.15;
export const MAX_OVERFLOW_RATIO = 1.6;
export const DEFAULT_OVERFLOW_RATIO = 1.4;

export function observedStepRatio(bigBlinds: readonly number[]): number {
  const clean = bigBlinds.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0);
  if (clean.length < 2) return DEFAULT_OVERFLOW_RATIO;

  // Geometric mean of the last few steps.
  const tail = clean.slice(-5);
  const first = tail[0];
  const last = tail[tail.length - 1];
  if (!(first > 0) || !(last > 0) || tail.length < 2) return DEFAULT_OVERFLOW_RATIO;

  const ratio = Math.pow(last / first, 1 / (tail.length - 1));
  if (!Number.isFinite(ratio) || ratio <= 1) return DEFAULT_OVERFLOW_RATIO;
  return Math.min(MAX_OVERFLOW_RATIO, Math.max(MIN_OVERFLOW_RATIO, ratio));
}
