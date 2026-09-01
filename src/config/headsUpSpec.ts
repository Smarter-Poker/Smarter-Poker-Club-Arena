/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  HEADS-UP SPEC — THE 2-MAX PRODUCT'S SINGLE SOURCE OF TRUTH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Spin has had `spinSpec.ts` since it was built. The other heads-up
 * product -- the true 2-max duel, ~11,000 games a week -- had nothing. Its
 * truth was spread across `SNG_BOARD_SHAPES` (stacks and seats),
 * `BLIND_STRUCTURES.HEADS_UP_3MIN` (the ladder), `src/utils/buyIn.ts` (the
 * rake), a payout array written inline three deep in a `flatMap`, and a JSON
 * blob inside a migration. Nothing tied those together, so each could drift
 * without the others noticing, and several already had.
 *
 * This file is that tie. It is DATA ONLY -- no imports, no engine state, no
 * I/O -- and it exists twice, byte for byte:
 *
 *     src/config/headsUpSpec.ts          (client)
 *     server/src/config/headsUpSpec.ts   (server)
 *
 * `tests/config/headsUpSpecMirror.test.ts` fails if the two ever differ by a
 * single character, which is the same guard `spinSpec` carries and the reason
 * that one has never drifted.
 *
 * WHAT IS AUTHORITATIVE HERE, and what merely records a decision:
 *   - seats, stacks, the blind ladder, level length, the rake rate, the payout
 *     shape and the buy-in ladder are AUTHORITATIVE. Change them here and the
 *     board changes.
 *   - `HEADS_UP_SYNCHRONIZED_BREAKS` records a ruling the ENGINE already
 *     enforces on format (breakEligibility.ts): a two-handed game never takes
 *     the :55 break. It is written down so the seed rows and the docs stop
 *     disagreeing with the engine.
 */

/**
 * Two. Not a per-config choice.
 *
 * Dan 2026-08-21: "WE AREN'T DOING ANY OTHER SIT N GO'S." Heads-Up is the only
 * sit-n-go shape the platform runs -- Spins cover the three-handed fast game,
 * MTTs cover the field -- so the seat count belongs to the FORMAT.
 */
export const HEADS_UP_SEATS = 2;

/**
 * Both bands are two-handed and both run the SAME clock. Dan 2026-08-23, about
 * Spins and repeated for this board: "SPEED SHOULDN'T CHANGE, ONLY THE
 * STARTING STACK."
 *
 * So the turbo is not a faster structure, it is a SHALLOWER one: at 10/20 the
 * turbo opens at 15 big blinds and the deep stack at 50, which makes the two
 * feel entirely different with only one ladder to reason about.
 */
export const HEADS_UP_STACKS = {
  /** "Heads-Up <buy-in>" — 50bb at level 1. */
  deep: 1000,
  /** "Heads-Up <buy-in> Regular" — 25bb at level 1. */
  regular: 500,
  /** "Heads-Up <buy-in> Turbo" — 15bb at level 1. */
  turbo: 300,
  /** "Heads-Up <buy-in> Hyper" — 7.5bb at level 1. */
  hyper: 150,
} as const;

export type HeadsUpBand = keyof typeof HEADS_UP_STACKS;

/**
 * The band's place in the game NAME, which is also the board's config key --
 * ensureBoardOpen keys on the name, so these suffixes are load-bearing:
 * changing one retires the old queue and opens a new one.
 *
 * Dan's locked catalog (2026-09-01) names four speeds; his 2026-08-23 ruling
 * ("SPEED SHOULDN'T CHANGE, ONLY THE STARTING STACK") means every band runs
 * the SAME three-minute clock and differs only in depth, exactly like the
 * original deep/turbo pair.
 */
export const HEADS_UP_BAND_SUFFIX: Record<HeadsUpBand, string> = {
  deep: '',
  regular: ' Regular',
  turbo: ' Turbo',
  hyper: ' Hyper',
};

/** Every level is this long, at every buy-in, in both bands. */
export const HEADS_UP_LEVEL_MINUTES = 3;

/**
 * The published ladder. Twelve levels, and a duel that outruns them continues
 * through `headsUpBlindsForLevel` rather than falling off the end.
 *
 * The steps are the Spin's own ladder for the first ten rows -- the same
 * gentle ~1.3x cadence -- because both heads-up products are meant to feel
 * like the same game at different depths.
 */
export const HEADS_UP_BLINDS: Array<{ small: number; big: number }> = [
  { small: 10, big: 20 },
  { small: 15, big: 30 },
  { small: 20, big: 40 },
  { small: 30, big: 60 },
  { small: 40, big: 80 },
  { small: 50, big: 100 },
  { small: 60, big: 120 },
  { small: 75, big: 150 },
  { small: 90, big: 180 },
  { small: 105, big: 210 },
  { small: 150, big: 300 },
  { small: 200, big: 400 },
];

/**
 * Blinds past the published ladder, DERIVED rather than stored -- the same
 * rule `spinBlindsForLevel` follows, and for the same reason: a structure that
 * stops raising turns a fast game into a grind, and a structure that DOUBLES
 * past the end (the generic MTT overflow) turns it into a coin flip.
 *
 * Deterministic: the same level always returns the same blinds, in every
 * process, before and after a restart, so there is nothing to persist and
 * nothing that can drift.
 */
export function headsUpBlindsForLevel(level: number): { small: number; big: number } {
  const idx = Math.max(1, Math.floor(level)) - 1;
  if (idx < HEADS_UP_BLINDS.length) return HEADS_UP_BLINDS[idx];
  const last = HEADS_UP_BLINDS[HEADS_UP_BLINDS.length - 1];
  const steps = idx - (HEADS_UP_BLINDS.length - 1);
  const big = Math.round((last.big * Math.pow(1.4, steps)) / 10) * 10;
  return { small: Math.round(big / 2), big };
}

/**
 * Five percent of what the player pays, on top of the buy-in, and it is a
 * RULE rather than a convention.
 *
 * The database cap was a flat 10% for every tournament shape
 * (`tournaments_rake_within_10_pct`), and the history shows what that permits:
 * through 25 August, 1,869 duels were charged 10%, 464 at 8% and 9 at 6.67%.
 * Everything since 26 August is 5% because the CODE says so in one place --
 * which is exactly one edit away from being wrong again.
 */
export const HEADS_UP_RAKE_RATE = 0.05;

/** Winner takes all. There is no second place in a two-handed game. */
export const HEADS_UP_PAYOUTS: Array<{ place: number; percentage: number }> = [
  { place: 1, percentage: 100 },
];

/** The buy-in rungs the board opens, in chips the player pays in total. */
/**
 * The locked nine-step ladder (Dan's catalog, 2026-09-01). The old 20 was
 * retired with it -- open 20-chip duels play out and their queue simply stops
 * reopening, which is how a config leaves this board.
 */
export const HEADS_UP_BUYINS = [1, 2, 5, 10, 25, 50, 100, 250, 500] as const;

/** The variants the board opens. */
export const HEADS_UP_GAME_TYPES = ['nlh', 'plo4', 'plo5', 'short_deck'] as const;
export type HeadsUpGameType = (typeof HEADS_UP_GAME_TYPES)[number];

/**
 * A heads-up game never takes the synchronized :55 break.
 *
 * The ENGINE already refuses it on format (`breakEligibility.ts` -- a short
 * format is never eligible, whatever the column says), but the duel seed rows
 * and the docs both said `synchronized_breaks: true`, so three places
 * disagreed and only one of them was consulted. Written down here so a seed
 * that copies this file cannot reintroduce the disagreement.
 */
export const HEADS_UP_SYNCHRONIZED_BREAKS = false;

/** One published level, in the shape the tournament row stores. */
export interface HeadsUpBlindLevel {
  level: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  durationMinutes: number;
}

/**
 * The ladder as a tournament row carries it. Derived, never hand-typed: this
 * is the artefact that used to be a separate hand-maintained array, which is
 * how a board came to advertise a structure it would never play.
 */
export const HEADS_UP_BLIND_STRUCTURE: HeadsUpBlindLevel[] = HEADS_UP_BLINDS.map((b, i) => ({
  level: i + 1,
  smallBlind: b.small,
  bigBlind: b.big,
  ante: 0,
  durationMinutes: HEADS_UP_LEVEL_MINUTES,
}));

/** Starting depth in big blinds, which is the number that actually describes a band. */
export function headsUpStartingBigBlinds(band: HeadsUpBand): number {
  return HEADS_UP_STACKS[band] / HEADS_UP_BLINDS[0].big;
}
