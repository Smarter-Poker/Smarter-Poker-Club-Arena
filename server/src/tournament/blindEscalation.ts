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

interface PlayableBlindLevel {
  smallBlind: number;
  bigBlind: number;
  ante: number;
  adjusted: boolean;
}

/**
 * Preserve the relationship between the three numbers after any independent
 * ceiling or scale. A shared numeric ceiling can turn a valid 1:2 level into
 * SB = BB; applying another common scale cannot repair that equality.
 */
export function enforcePlayableBlindLevel(
  level: {
    smallBlind?: unknown;
    bigBlind?: unknown;
    ante?: unknown;
  },
  /**
   * The row `level` was grown from, when the caller has it. `level`'s own
   * numbers are each a rounded product, so their quotients are rounded shares
   * and can sit a fraction of a chip under the authored ones - enough for the
   * floors below to shave a whole chip off a level that was already correct.
   * The anchor row is authored, exact, and the share the SQL resolver reads,
   * for the ante (2026-09-25) exactly as for the small blind. Omitted, the
   * level speaks for itself.
   */
  authoredShareFrom?: { smallBlind?: unknown; bigBlind?: unknown; ante?: unknown }
): PlayableBlindLevel {
  const positive = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_BLIND_VALUE) : fallback;
  };
  const rawSmallBlind = positive(level?.smallBlind, 1);
  const rawBigBlind = positive(level?.bigBlind, 2);
  const rawAnte = Number(level?.ante);
  const bigBlind = Math.max(2, rawBigBlind);
  let smallBlind = rawSmallBlind < bigBlind ? rawSmallBlind : Math.max(1, Math.floor(bigBlind / 2));

  /**
   * THE SMALL BLIND KEEPS ITS REQUESTED SHARE OF THE BIG BLIND (2026-09-21).
   *
   * The line above repairs SB >= BB, which is the END of the distortion and
   * not the whole of it. `positive()` applies MAX_BLIND_VALUE to the small
   * blind and to the big blind INDEPENDENTLY, so between the level where the
   * big blind reaches the ceiling and the level where the small blind reaches
   * it too, the big blind is pinned at MAX_BLIND_VALUE while the small blind
   * is still growing underneath it. SB < BB the whole way, nothing above
   * fires, and an authored 1:2 walks up through 0.63 and 0.84 towards 1:1.
   *
   * Production on 2026-09-21: of 12,371 published levels past the end of their
   * ladder, 5,298 carried a small blind above its authored share - 4,770 at
   * SB = BB exactly and 528 inside that band, 48 of them at 0.9762 of their
   * big blind. Every one of the 21 structures on the platform authors 0.5.
   *
   * So hold the small blind to the share the level it was HANDED asked for,
   * read before either ceiling touched it. This is the same rule the SQL
   * resolver applies to the ante (`the_overflow_ante_keeps_its_authored_share
   * _of_the_big_blind`) and to the small blind (`the_overflow_small_blind
   * _keeps_its_authored_share_of_the_big`). It is a CEILING and never a floor:
   * it only ever lowers a small blind, so no level becomes more expensive than
   * it is today. A request that already asks for SB >= BB is left to the
   * repair above, which has put the small blind at half the big blind;
   * raising it back is not this ceiling's job.
   */
  const shareSource = authoredShareFrom ?? level;
  const requestedSmallBlind = Number(shareSource?.smallBlind);
  const requestedBigBlind = Number(shareSource?.bigBlind);
  /* Only where the ceiling actually BIT. Below it the pair is already in
     proportion, and two independently rounded whole-chip products can sit a
     fraction of a chip over the authored share - 200/400 at the ladder's own
     1.27787 cadence grows to 256/511, which is 0.5009 and is whole chips
     (2026-09-11), not this defect. Shaving that to 255 would be a different
     bug wearing this one's clothes. */
  const levelBigBlind = Number(level?.bigBlind);
  if (
    Number.isFinite(levelBigBlind) &&
    levelBigBlind > MAX_BLIND_VALUE &&
    Number.isFinite(requestedSmallBlind) &&
    requestedSmallBlind > 0 &&
    Number.isFinite(requestedBigBlind) &&
    requestedBigBlind > 0 &&
    requestedSmallBlind < requestedBigBlind
  ) {
    // Multiply before dividing, so a share like 1,333,333/4,000,000 is not
    // rounded to a quotient before it is applied.
    const ceiling = (bigBlind * requestedSmallBlind) / requestedBigBlind;
    // Compared unrounded, assigned rounded: a level already sitting at its
    // requested share is left alone rather than shaved by the floor.
    if (Number.isFinite(ceiling) && smallBlind > ceiling) {
      smallBlind = Math.max(1, Math.floor(ceiling));
    }
  }

  let ante = Number.isFinite(rawAnte) && rawAnte >= 0 ? Math.min(rawAnte, MAX_BLIND_VALUE) : 0;

  /**
   * THE ANTE KEEPS ITS AUTHORED SHARE OF THE BIG BLIND (2026-09-25).
   *
   * The small blind got this ceiling on 2026-09-21 and the SQL resolver got
   * the ante's on 2026-09-20 (`the_overflow_ante_keeps_its_authored_share_of
   * _the_big_blind`). This file did not, and this file is what the manager
   * actually publishes from: `Math.min(rawAnte, MAX_BLIND_VALUE)` above is
   * the independent ceiling the header warns about, applied to the ante. On a
   * deep overflow the grown ante and the grown big blind both saturate to
   * 10,000,000, `capLevelToChipsInPlay` then rescales all three by one
   * factor, and the level leaves here with ante = bigBlind.
   *
   * Production, 2026-09-25: 158 live (non-closed) tables carried
   * ante >= big_blind. 6 of them are the one genuine big blind ante on the
   * board (Sunday $200 Deep Stack, an authored share of 1). The other 131
   * tournament tables, across 15 RUNNING events, author 0.120-0.133 x bigBlind
   * and were dealing ante = bigBlind - seven to eight times the authored ante.
   * Calling fn_tournament_current_blinds on the same 15 events returned the
   * correct ante every time (24,500/49,000 ante 6,125 where the published
   * level said ante 49,000), which is what proves the distortion is this
   * function's and not the resolver's.
   *
   * So hold the ante to the share the anchor row authored, read before either
   * ceiling touched it, exactly as the small blind above is held. A CEILING
   * and never a floor: it only ever lowers an ante, so no level becomes more
   * expensive than it is today. A structure that authors ante = bigBlind (a
   * big blind ante; AnteMath.ts reads `ante >= bigBlind` as "this structure
   * authored a TOTAL" and counts two of them) is left alone, so its saturated
   * level still publishes sb = bb = ante. A structure with no ante never
   * reaches here with one.
   */
  const requestedAnte = Number(shareSource?.ante);
  if (
    ante > 0 &&
    Number.isFinite(levelBigBlind) &&
    levelBigBlind > MAX_BLIND_VALUE &&
    Number.isFinite(requestedAnte) &&
    requestedAnte > 0 &&
    Number.isFinite(requestedBigBlind) &&
    requestedBigBlind > 0 &&
    requestedAnte < requestedBigBlind
  ) {
    // Multiply before dividing, so a share like 200,000/1,500,000 is not
    // rounded to a quotient before it is applied.
    const anteCeiling = (bigBlind * requestedAnte) / requestedBigBlind;
    // Compared unrounded, assigned rounded: a level already sitting at its
    // requested share is left alone rather than shaved by the floor.
    if (Number.isFinite(anteCeiling) && ante > anteCeiling) {
      ante = Math.max(1, Math.floor(anteCeiling));
    }
  }

  return {
    smallBlind,
    bigBlind,
    ante,
    adjusted:
      smallBlind !== Number(level?.smallBlind) ||
      bigBlind !== Number(level?.bigBlind) ||
      ante !== Number(level?.ante),
  };
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
  const playable = enforcePlayableBlindLevel(level);
  const { smallBlind, bigBlind, ante } = playable;

  const total = Number(totalChipsInPlay);
  const minBB = Number(minTotalBigBlinds);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(minBB) || minBB <= 0) {
    return { smallBlind, bigBlind, ante, capped: playable.adjusted };
  }

  const maxBigBlind = total / minBB;
  if (!(bigBlind > maxBigBlind) || maxBigBlind < 2) {
    return { smallBlind, bigBlind, ante, capped: playable.adjusted };
  }

  const scale = maxBigBlind / bigBlind;
  const scaled = enforcePlayableBlindLevel({
    bigBlind: Math.max(2, Math.floor(bigBlind * scale)),
    smallBlind: Math.max(1, Math.floor(smallBlind * scale)),
    ante: ante > 0 ? Math.max(1, Math.floor(ante * scale)) : 0,
  });
  return {
    // Floor, never round up past the cap. Never below 2/1, or the table cannot
    // post a blind at all.
    bigBlind: scaled.bigBlind,
    smallBlind: scaled.smallBlind,
    ante: scaled.ante,
    capped: true,
  };
}

/**
 * The synthesized level for `index`, which must be at or past `persistedLength`.
 *
 * `durationMinutes` is supplied by the caller rather than derived here, because
 * level length is format-normalized (`durationMinutes` / `duration_minutes` /
 * `duration` in seconds). Preserve the supplied duration, including levels
 * shorter than two minutes. The owner applies acceleration once.
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
   * WHOLE CHIPS (2026-09-11). ratio^k is fractional at every ratio but 2, and
   * tournament chips are whole: `tournament_players.chips` is an INTEGER
   * column. At the observed 1.278 cadence, 200/400 became 255.58/511.15 and
   * dealt pots of fractional chips. The hand commit writes the integer column,
   * compares it with the exact numeric stack it was asked to write, finds they
   * differ, and rolls the WHOLE hand back ("did not durably sync every final
   * seat stack"): 11, 9 and 2 refused hands on three heads-up SNGs between
   * 00:00 and 00:02 UTC, and 12 more SNGs by 01:37. The persisted ladders are
   * already whole (blindLadder.niceValuesFrom); this is the one place a level
   * is invented, so this is where it becomes whole.
   */
  const scale = (v: unknown) => {
    const n = Number(v);
    /* MAX_BLIND_VALUE used to be applied HERE, to each of the three numbers on
       its own. That is the independent ceiling this file's header warns about:
       it saturates the pair to 10,000,000/10,000,000 before
       enforcePlayableBlindLevel below can see how far past the ceiling the
       level really was, and a level that arrives already saturated cannot be
       told apart from one that legitimately asks for 10,000,000. The ceiling
       has not moved or softened - it is applied once, below. A product so
       large that it overflows the double cannot express a share at all and
       saturates exactly as this line always did. */
    const grown = (Number.isFinite(n) ? n : 0) * factor;
    return Number.isFinite(grown) ? Math.round(grown) : MAX_BLIND_VALUE;
  };
  const playable = enforcePlayableBlindLevel(
    {
      smallBlind: scale(lastPlayable?.smallBlind),
      bigBlind: scale(lastPlayable?.bigBlind),
      ante: scale(lastPlayable?.ante),
    },
    // scale() saturates each number at MAX_BLIND_VALUE on its own, so past the
    // ceiling the grown pair no longer carries the share. The anchor row does.
    lastPlayable
  );
  return {
    level: index + 1,
    smallBlind: playable.smallBlind,
    bigBlind: playable.bigBlind,
    ante: playable.ante,
    durationMinutes: Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : 2,
    autoEscalated: true,
  };
}
