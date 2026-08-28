/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BLIND ESCALATION PAST THE END OF THE STRUCTURE — pure, stateless, restart-safe
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every preset structure on the platform is 10-12 levels and tournaments
 * routinely run past the last one, so the engine has always had to invent the
 * levels beyond it. It used to do that by MUTATING the cached structure:
 *
 *     const escalationFactor = Math.pow(2, currentLevel - blindStructure.length + 1);
 *     ...
 *     blindStructure.push(autoLevel);
 *
 * The factor is anchored to `blindStructure.length` and the push MOVES that
 * anchor. In steady state the two stay in lockstep — every push happens with
 * `currentLevel === length`, so the factor is always 2 and the blinds double
 * once per level, correctly. A RESTART breaks the lockstep: `resume()` re-reads
 * `blind_structure` fresh from the row (nothing was ever persisted — the column
 * is TEXT holding the ORIGINAL advertised JSON) while `current_level` comes back
 * from the database. Length 10 with level 13 gives
 *
 *     first overflow   2^(14-10+1) = 32     -> base x 32        (correct)
 *     push             length becomes 11
 *     next overflow    2^(15-11+1) = 32     -> base x 1,024     (32 x 32)
 *     next                                  -> base x 1,048,576, then clamped
 *
 * Three levels from a restart to a 10,000,000 big blind, measured live as
 * 24,000 -> 48,000 -> 1,536,000. Every reader that clamped to the last
 * persisted row went on showing 750/1500 while the felt played 12,000/24,000.
 *
 * THE FIX IS TO STOP STORING THE ANSWER. Anchored to the PERSISTED length,
 * which nothing mutates, `2^(index - length + 1)` is the same number on every
 * call, in every process, before and after a restart. Nothing to persist, and
 * nothing that can drift.
 *
 * Zero imports on purpose (same reasoning as payoutStructure.ts and
 * startRules.ts): this is money-adjacent arithmetic inside a 3,000-line class
 * against live Supabase, and it must be unit-testable on its own.
 */

/** DECIMAL(10,2) ceiling. A blind above this fails the column outright. */
export const MAX_BLIND_VALUE = 10_000_000;

/**
 * Cap on the doubling exponent. 2^40 times any real small blind is orders of
 * magnitude past MAX_BLIND_VALUE, and the cap is what keeps a very long-lived
 * tournament from producing `Infinity` — and then `Infinity * 0 = NaN` for a
 * zero ante, which would be written to `tables.ante` as NaN.
 */
export const MAX_ESCALATION_EXPONENT = 40;

export interface BlindLevelLike {
  level?: number;
  smallBlind?: unknown;
  bigBlind?: unknown;
  ante?: unknown;
  isBreak?: boolean;
}

/**
 * The last PLAYABLE row of a structure. A structure whose final rows are break
 * rows (smallBlind 0) would otherwise double zero forever and freeze the blinds
 * at nothing.
 */
export function lastPlayableIndex(structure: readonly BlindLevelLike[]): number {
  let i = structure.length - 1;
  while (i > 0 && structure[i]?.isBreak) i--;
  return i;
}

/**
 * How many times the last playable level doubles to reach `index`.
 *
 * `persistedLength` is the length of the structure AS STORED. Passing a mutated
 * length here is the entire defect above, so callers must never grow the array.
 */
export function escalationFactor(index: number, persistedLength: number): number {
  const exponent = Math.min(Math.max(1, index - persistedLength + 1), MAX_ESCALATION_EXPONENT);
  return Math.pow(2, exponent);
}

/**
 * The synthesized level for `index`, which must be at or past `persistedLength`.
 *
 * `durationMinutes` is supplied by the caller rather than derived here, because
 * level length is format-normalized (`durationMinutes` / `duration_minutes` /
 * `duration` in seconds) and an accelerated MTT halves it once late
 * registration closes — engine state this module deliberately has no access to.
 */
export function escalatedBlindLevel(
  lastPlayable: BlindLevelLike | undefined,
  index: number,
  persistedLength: number,
  durationMinutes: number
): {
  level: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  durationMinutes: number;
  autoEscalated: true;
} {
  const factor = escalationFactor(index, persistedLength);
  const scale = (v: unknown) => {
    const n = Number(v);
    return Math.min((Number.isFinite(n) ? n : 0) * factor, MAX_BLIND_VALUE);
  };
  return {
    level: index + 1,
    smallBlind: scale(lastPlayable?.smallBlind),
    bigBlind: scale(lastPlayable?.bigBlind),
    ante: scale(lastPlayable?.ante),
    durationMinutes: Math.max(durationMinutes, 2),
    autoEscalated: true,
  };
}
