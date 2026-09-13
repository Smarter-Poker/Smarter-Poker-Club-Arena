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
export function escalationFactor(
  index: number,
  persistedLength: number,
  /**
   * THE RATIO IS NO LONGER 2 (2026-08-31).
   *
   * This function doubled the blinds once per level past the end of a
   * structure, and 95.7% of MTTs measured on production ran past the end of
   * theirs — so doubling was not an edge case, it was the late game of nearly
   * every tournament on the platform. 38.1% of events finished with every chip
   * in play worth under three big blinds.
   *
   * The ladder's OWN cadence is the right ratio, so callers pass what they
   * observed (blindLadder.observedStepRatio), clamped there to [1.15, 1.6].
   * The default is the middle of that range rather than 2, so a caller that has
   * not been updated still gets a sane ladder instead of the defect.
   *
   * The anchoring contract above is unchanged, and is why this stays a pure
   * function of (index, persistedLength): the same answer in every process,
   * before and after a restart.
   */
  ratio: number = 1.4
): number {
  const exponent = Math.min(Math.max(1, index - persistedLength + 1), MAX_ESCALATION_EXPONENT);
  const r = Number.isFinite(ratio) && ratio > 1 ? ratio : 1.4;
  return Math.pow(r, exponent);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A BIG BLIND MAY NOT EXCEED THE TOURNAMENT (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Chips are conserved: the sum of every stack is the starting stack times the
 * number of entrants, plus rebuys and add-ons. That total is the entire supply
 * of the game, and it is the number a blind has to be measured against.
 *
 * Deep ladders (blindLadder.ts) mean the overflow path is now rarely reached at
 * all. This is the guard that makes the failure mode IMPOSSIBLE rather than
 * merely unlikely — a tournament that runs for a week, a structure somebody
 * authors badly, a restart loop that advances the level counter: none of them
 * can produce a blind larger than the chips that exist.
 *
 * MIN_TOTAL_BB_IN_PLAY is the floor on how much poker is left. At 20, a
 * heads-up finish has ~10 big blinds each, which is a decisive endgame that is
 * still poker. Below about 3 it is a forced all-in lottery on the blind, which
 * is what 221 of 579 events actually finished as.
 */
export const MIN_TOTAL_BB_IN_PLAY = 20;

export interface CappedLevel {
  smallBlind: number;
  bigBlind: number;
  ante: number;
  /** True when the cap actually bit, so callers can log it once. */
  capped: boolean;
}

/**
 * Scale a level down so the whole tournament still holds MIN_TOTAL_BB_IN_PLAY
 * big blinds. Ratios between small blind, big blind and ante are preserved — a
 * capped level is the same shape of level, just smaller.
 *
 * An unknown or nonsensical chip total caps NOTHING. Guessing a total and then
 * shrinking the blinds against it would be its own defect, and the blinds are
 * already bounded by MAX_BLIND_VALUE.
 */
export function capLevelToChipsInPlay(
  level: { smallBlind?: unknown; bigBlind?: unknown; ante?: unknown },
  totalChipsInPlay: number | null | undefined,
  minTotalBigBlinds: number = MIN_TOTAL_BB_IN_PLAY
): CappedLevel {
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const smallBlind = num(level?.smallBlind);
  const bigBlind = num(level?.bigBlind);
  const ante = num(level?.ante);

  const total = Number(totalChipsInPlay);
  const minBB = Number(minTotalBigBlinds);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(minBB) || minBB <= 0) {
    return { smallBlind, bigBlind, ante, capped: false };
  }

  const maxBigBlind = total / minBB;
  if (!(bigBlind > maxBigBlind) || maxBigBlind < 2) {
    return { smallBlind, bigBlind, ante, capped: false };
  }

  const scale = maxBigBlind / bigBlind;
  return {
    // Floor, never round up past the cap. Never below 2/1, or the table cannot
    // post a blind at all.
    bigBlind: Math.max(2, Math.floor(bigBlind * scale)),
    smallBlind: Math.max(1, Math.floor(smallBlind * scale)),
    ante: ante > 0 ? Math.max(1, Math.floor(ante * scale)) : 0,
    capped: true,
  };
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
  durationMinutes: number,
  /** The ladder's own observed cadence — see escalationFactor. Defaults to the
   *  same sane 1.4x, never the old 2x. */
  ratio?: number
): {
  level: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  durationMinutes: number;
  autoEscalated: true;
} {
  const factor = escalationFactor(index, persistedLength, ratio);
  /**
   * ROUND. `Math.min` IS NOT A ROUND (2026-09-09).
   *
   * The ratio is 1.4 by default and is whatever cadence the ladder observed
   * otherwise, so `n * factor` is a fraction for almost every level: a small
   * blind of 1000 one level past the structure is 1316.0740129524924. Neither
   * clamp here rounds it, and neither one bites on a healthy ladder — the
   * MAX_BLIND_VALUE ceiling below and `capLevelToChipsInPlay` above both
   * return the value UNCHANGED when they do not fire (blindEscalation.ts:160,
   * :165; TournamentManagerBase.ts:5902), which is the ordinary case.
   *
   * That fraction is written to `tables.small_blind` / `big_blind` / `ante`,
   * DECIMAL(10,2), so the felt posts fractional-chip blinds and antes into
   * integer stacks; and into `tables.stakes` as the raw JS float string that
   * the table masthead, the lobby rows and every BB-depth badge render.
   *
   * Both sibling ladder generators already round: blindLadder.ts:92-95 says
   * why (`15 * 10^3` is 15000.000000000002 in IEEE754 and fails the column),
   * and config/spinSpec.ts:360 rounds its own 1.4x continuation to the nearest
   * ten. This was the one generator that did not.
   */
  const scale = (v: unknown) => {
    const n = Number(v);
    return Math.min(Math.round((Number.isFinite(n) ? n : 0) * factor), MAX_BLIND_VALUE);
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
