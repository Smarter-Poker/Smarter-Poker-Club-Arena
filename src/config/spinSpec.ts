/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SPIN SPEC — the single source of truth for the Spin format
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan's specification, 2026-08-20. This file replaces THREE tables that
 * disagreed with each other (see
 * .agent/audits/2026-08-20-spins-economics-research.md):
 *
 *   SPIN_BONUS_TIERS        EV 2.999994   the documented design
 *   TournamentRecurringSvc  EV 2.75       what actually ran
 *   TournamentManagerBase   EV 2.2415     the engine's fallback
 *
 * ─── THE ONE RULE THAT MATTERS ──────────────────────────────────────────────
 *
 *   E[multiplier] = seats × (1 − rake_rate)
 *
 * A Spin is NOT priced like an MTT. There is no "10 + 1": the player pays the
 * listed buy-in and nothing else, and the rake is engineered into the
 * multiplier distribution. Dan: "THEY ARE STRAIGHT JUST 10 BUY IN... NO
 * ADDITIONAL RAKE IS ADDED."
 *
 * The frequency table below is arithmetic proof of that pricing. Its
 * expectation is 2.7638, and (3 − 2.7638) / 3 = 7.87% — the advertised 8% at
 * the stakes it applies to. Had the player been charged buy-in PLUS 8% on top,
 * the true edge would have been 14.7%, which is not what any room advertises.
 * So the buy-in is the whole charge, and `buy_in_fee` MUST be 0 on a Spin.
 *
 * ─── HOW THE MONEY MOVES ────────────────────────────────────────────────────
 *
 * Per game, with B = buy-in and S = seats:
 *
 *   collected   = S × B                    every player pays exactly B
 *   house_rake  = rake_rate × collected    FIXED. Booked every single game.
 *   reserve_in  = collected − house_rake   everything else
 *   reserve_out = B × multiplier           the entire prize pool
 *
 * The Reserve Pool absorbs 100% of the prize variance and the house takes
 * exactly the advertised rake on every game, win or lose. Because
 * E[reserve_out] = E[multiplier] × B = reserve_in by construction, the pool is
 * net-neutral over volume — its balance is therefore a direct, auditable
 * measure of solvency, which is what makes the threshold gating below work.
 *
 * This is deliberately simpler than "a percentage of the surplus from 2x and
 * 3x games plus a fixed contribution": that formulation leaves the house edge
 * varying game to game and the pool's drift hard to reason about. Fixed rake,
 * everything else pooled, gives the same long-run economics with an invariant
 * you can actually assert.
 *
 * ─── MIRRORED ───────────────────────────────────────────────────────────────
 * The client and the server are separate TypeScript projects with no shared
 * module path, so this file exists twice:
 *
 *   src/config/spinSpec.ts          (client)
 *   server/src/config/spinSpec.ts   (server)
 *
 * tests/config/spinSpec.test.ts asserts the two are byte-identical. Drift
 * between copies is precisely how the three conflicting tables happened, so it
 * is now a test failure rather than a slow-motion accident.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// SEATS
// ═══════════════════════════════════════════════════════════════════════════════

/** A Spin is 3-handed by definition. */
export const SPIN_SEATS = 3;

// ═══════════════════════════════════════════════════════════════════════════════
// RAKE — scales down with stake
// ═══════════════════════════════════════════════════════════════════════════════

export interface RakeBand {
  /** Inclusive lower bound of the buy-in band. */
  minBuyIn: number;
  /** Inclusive upper bound. Infinity for the top band. */
  maxBuyIn: number;
  /** Fraction of total collected taken by the house. */
  rate: number;
}

export const SPIN_RAKE_BANDS: RakeBand[] = [
  { minBuyIn: 0, maxBuyIn: 5, rate: 0.08 },
  { minBuyIn: 5.01, maxBuyIn: 10, rate: 0.07 },
  { minBuyIn: 10.01, maxBuyIn: 50, rate: 0.06 },
  { minBuyIn: 50.01, maxBuyIn: Infinity, rate: 0.05 },
];

/** The house rake rate for a given buy-in. */
export function spinRakeRate(buyIn: number): number {
  const band = SPIN_RAKE_BANDS.find((b) => buyIn >= b.minBuyIn && buyIn <= b.maxBuyIn);
  // Unknown stake defaults to the HIGHEST rake, never the lowest: a
  // misconfigured buy-in must not silently hand away margin.
  return band ? band.rate : SPIN_RAKE_BANDS[0].rate;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MULTIPLIER TABLE
// ═══════════════════════════════════════════════════════════════════════════════

export interface SpinTierSpec {
  multiplier: number;
  /** Frequency per 10,000,000 games. */
  freq: number;
  /** Prize split by finishing place, summing to 1. */
  payouts: number[];
  /** Starting stack in chips. */
  startingStack: number;
  /** Blind level length in minutes. */
  levelMinutes: number;
  /**
   * Reserve Pool gate. The multiplier is EXCLUDED from the draw unless the
   * pool holds at least this many times its own full prize pool at the
   * highest stake currently running. 0 = always available.
   */
  reserveThresholdX: number;
}

/** Denominator for `freq`. */
export const SPIN_FREQ_DENOMINATOR = 10_000_000;

/**
 * The ladder. Frequencies are Dan's spec verbatim.
 *
 * Note the payout shape: ~87.4% of games are 2x or 3x and pay one player, and
 * only ~1.1% (10x and up) pay more than first place. That concentration is the
 * format — spreading the money would flatten exactly the variance people show
 * up for.
 *
 * ─── 500x RETIRED, 2026-08-21 ───────────────────────────────────────────────
 *
 * Dan: "REMOVE THE 500X WE WILL ONLY EVER DO 100X." 100x is now the top of the
 * ladder and the tier every derived number keys off.
 *
 * Deleting the row is NOT enough, because the one rule at the top of this file
 * is an equality: E[multiplier] = seats × (1 − rake). The 500x carried
 * 100 × 500 = 50,000 weighted units out of 27,638,000, so simply dropping it
 * would have moved the expectation to 2.7588 — an 8.04% edge on a product
 * advertised at 7.87%. Taking 0.17% more from every player as a side effect of
 * a wheel change is exactly the failure this file exists to make impossible.
 *
 * So the mass was MOVED, not deleted, holding both totals invariant:
 *
 *   100x   500 → 1,008    (+508)
 *   2x   4,772,497 → 4,772,073  (−424)
 *   3x   3,968,502 → 3,968,518  (+16)
 *
 *   total freq   10,000,099  (unchanged)
 *   Σ mult×freq  27,638,000  (unchanged)
 *   E            2.763773    (unchanged to every digit the tests assert)
 *
 * The visible consequence is real and intended: a 100x now lands about 1 in
 * 9,921 games instead of 1 in 20,000. The top prize got smaller, so it has to
 * get commoner, or the money the 500x used to carry would quietly become house
 * margin. Two further numbers move on their own because they are DERIVED from
 * the top tier — `reserveCeiling` and `requiredSeed` both drop 5x, so a club
 * now needs far less operator seed money to switch Spins on.
 */
export const SPIN_TIERS: SpinTierSpec[] = [
  // Dan 2026-08-20, from a seat at a live table, twice in one session: first
  // "change them to 2 min levels", then minutes later "change spins to 3 min
  // levels". The later instruction wins and is FLAT: every tier runs 3-minute
  // levels. Tier identity now lives in stack depth and payout shape alone —
  // the level clock is one number a player can internalise across the ladder.
  {
    multiplier: 2,
    // 4_772_497 before the 500x retirement; see the note above the array.
    freq: 4_772_073,
    payouts: [1],
    startingStack: 300,
    levelMinutes: 3,
    reserveThresholdX: 0,
  },
  {
    multiplier: 3,
    // 3_968_502 before the 500x retirement.
    freq: 3_968_518,
    payouts: [1],
    startingStack: 300,
    levelMinutes: 3,
    reserveThresholdX: 0,
  },
  {
    multiplier: 4,
    freq: 900_000,
    payouts: [1],
    startingStack: 400,
    levelMinutes: 3,
    reserveThresholdX: 0,
  },
  {
    multiplier: 5,
    freq: 250_000,
    payouts: [1],
    startingStack: 400,
    levelMinutes: 3,
    reserveThresholdX: 0,
  },
  {
    multiplier: 10,
    freq: 100_000,
    payouts: [0.8, 0.2],
    startingStack: 500,
    levelMinutes: 3,
    reserveThresholdX: 0,
  },
  {
    multiplier: 25,
    freq: 7_500,
    payouts: [0.8, 0.12, 0.08],
    startingStack: 500,
    levelMinutes: 3,
    reserveThresholdX: 0,
  },
  {
    multiplier: 50,
    freq: 1_000,
    payouts: [0.8, 0.12, 0.08],
    startingStack: 500,
    levelMinutes: 3,
    reserveThresholdX: 0,
  },
  {
    multiplier: 100,
    // 500 before the 500x retirement: this tier absorbed that one's frequency
    // plus the extra mass needed to hold the expectation flat.
    freq: 1_008,
    payouts: [0.8, 0.12, 0.08],
    startingStack: 500,
    levelMinutes: 3,
    // Deliberately still 1.5, not the 2.0 the 500x used. Raising it would lock
    // the top of the ladder out of thin pools far more often than before, now
    // that this tier is drawn twice as frequently.
    reserveThresholdX: 1.5,
  },
];

/**
 * Blind ladder. Identical at every multiplier — only the starting stack
 * changes, which is what turns one structure into eight.
 */
export const SPIN_BLINDS: Array<{ small: number; big: number }> = [
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
];

/**
 * Levels past the published ladder keep climbing rather than stalling. A deep
 * 100x can outrun ten levels, and a structure that stops raising blinds turns
 * a hyper-turbo into a grind.
 */
export function spinBlindsForLevel(level: number): { small: number; big: number } {
  const idx = Math.max(1, Math.floor(level)) - 1;
  if (idx < SPIN_BLINDS.length) return SPIN_BLINDS[idx];
  // Continue the ~1.4x cadence of the published ladder.
  const last = SPIN_BLINDS[SPIN_BLINDS.length - 1];
  const steps = idx - (SPIN_BLINDS.length - 1);
  const big = Math.round((last.big * Math.pow(1.4, steps)) / 10) * 10;
  return { small: Math.round(big / 2), big };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GAME TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export const SPIN_GAME_TYPES = ['NLH', 'PLO4', 'PLO5', 'PLO6'] as const;
export type SpinGameType = (typeof SPIN_GAME_TYPES)[number];

// ═══════════════════════════════════════════════════════════════════════════════
// DERIVED MATH
// ═══════════════════════════════════════════════════════════════════════════════

/** Look up a tier. */
export function spinTier(multiplier: number): SpinTierSpec | undefined {
  return SPIN_TIERS.find((t) => t.multiplier === multiplier);
}

/** Expected multiplier over a set of tiers (default: all of them). */
export function expectedMultiplier(tiers: SpinTierSpec[] = SPIN_TIERS): number {
  const total = tiers.reduce((s, t) => s + t.freq, 0);
  if (total <= 0) return 0;
  return tiers.reduce((s, t) => s + t.multiplier * t.freq, 0) / total;
}

/** Implied house edge for a tier set at a given seat count. */
export function impliedHouseEdge(
  tiers: SpinTierSpec[] = SPIN_TIERS,
  seats: number = SPIN_SEATS
): number {
  return (seats - expectedMultiplier(tiers)) / seats;
}

/**
 * The money for one game. `eligibleTiers` matters: when a high multiplier is
 * gated out by the Reserve Pool, the remaining distribution has a different
 * expectation, and the house rake is a fixed rate so only the pool flow moves.
 */
export interface SpinEconomics {
  collected: number;
  houseRake: number;
  reserveIn: number;
  prizePool: number;
  /** What the pool must fund beyond what this game contributed. */
  reserveNet: number;
  payouts: number[];
}

export function spinEconomics(
  buyIn: number,
  multiplier: number,
  seats: number = SPIN_SEATS
): SpinEconomics {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const collected = round2(buyIn * seats);
  const houseRake = round2(collected * spinRakeRate(buyIn));
  const reserveIn = round2(collected - houseRake);
  const prizePool = round2(buyIn * multiplier);
  const tier = spinTier(multiplier);
  const splits = tier?.payouts ?? [1];

  // Distribute to the last place first and give first place the remainder, so
  // rounding can never make the parts sum to more than the pool. A pool that
  // pays out more than it holds is the one failure mode that costs real money.
  const payouts: number[] = new Array(splits.length).fill(0);
  let remaining = prizePool;
  for (let i = splits.length - 1; i >= 1; i--) {
    const amt = round2(prizePool * splits[i]);
    payouts[i] = amt;
    remaining = round2(remaining - amt);
  }
  payouts[0] = remaining;

  return {
    collected,
    houseRake,
    reserveIn,
    prizePool,
    reserveNet: round2(prizePool - reserveIn),
    payouts,
  };
}

/**
 * Which multipliers may be drawn right now.
 *
 * Dan's core principle: a high multiplier is not eligible to be SELECTED at
 * all until the Reserve Pool can pay it. That is strictly better than drawing
 * first and checking after — it makes an unpayable jackpot structurally
 * impossible rather than merely unlikely, so the pool can never go negative
 * and no player is ever shown a prize that gets taken back.
 *
 * @param reserveBalance current pool balance
 * @param highestStake   the largest buy-in currently running, which is what
 *                       the threshold is measured against — the pool must be
 *                       able to pay the jackpot at the biggest table open, not
 *                       merely at this one.
 */
export function eligibleSpinTiers(
  reserveBalance: number,
  highestStake: number,
  /**
   * This game's buy-in, needed for the affordability check below. Defaults to
   * highestStake so an omitted value errs on the CAUTIOUS side (a larger
   * buy-in means a larger prize, so fewer tiers qualify).
   */
  buyIn: number = highestStake,
  seats: number = SPIN_SEATS
): SpinTierSpec[] {
  // What this game itself puts into the pool, which is available to fund its
  // own prize.
  const contribution = buyIn * seats * (1 - spinRakeRate(buyIn));

  return SPIN_TIERS.filter((t) => {
    // ── Affordability. ───────────────────────────────────────────────────
    // AUDIT FIX 2026-08-20: this check did not exist, and its absence was a
    // real production defect rather than a theoretical one.
    //
    // The jackpot thresholds below only ever guarded the top two tiers (100x
    // and the since-retired 500x). But ANY
    // tier above ~2.76x pays out more than the three buy-ins bring in — a 4x
    // pays 4B against a 2.76B contribution — so on a pool without a cushion
    // even a 4x cannot be covered. In production this aborted the settlement
    // on the non-negative CHECK constraint and left the game UNBOOKED: no
    // ledger row, no rake record, exactly the class of hole this whole system
    // was built to close.
    //
    // Over volume E[prize] = contribution, so this only bites on a thin pool
    // — which is precisely when it must.
    const prize = buyIn * t.multiplier;
    if (reserveBalance + contribution < prize) return false;

    // ── Jackpot thresholds. ──────────────────────────────────────────────
    // A stricter gate on top: the pool must not merely afford one jackpot, it
    // must hold a multiple of it, measured against the biggest stake running.
    if (t.reserveThresholdX <= 0) return true;
    const fullJackpot = highestStake * t.multiplier;
    return reserveBalance >= fullJackpot * t.reserveThresholdX;
  });
}

/**
 * The pool balance below which even a 2x cannot be guaranteed. Used to warn an
 * operator that a club's Spins are running on fumes: nothing breaks, but the
 * ladder silently collapses toward 2x/3x, which players WILL notice long
 * before any alert fires.
 */
export function isReserveThin(
  reserveBalance: number,
  highestStake: number,
  seats: number = SPIN_SEATS
): boolean {
  // Fewer than half the tiers reachable is "thin".
  const eligible = eligibleSpinTiers(reserveBalance, highestStake, highestStake, seats);
  return eligible.length < Math.ceil(SPIN_TIERS.length / 2);
}

/**
 * The reserve balance at which a tier unlocks. Drives the "locked" state on
 * the wheel — showing a locked 100x with its unlock condition is honest and
 * builds anticipation, where hiding it entirely just makes the wheel smaller.
 */
export function unlockThreshold(tier: SpinTierSpec, highestStake: number): number {
  if (tier.reserveThresholdX <= 0) return 0;
  return Math.round(highestStake * tier.multiplier * tier.reserveThresholdX * 100) / 100;
}

/**
 * Ceiling: once the pool holds this much, surplus stops accruing and is
 * returned to the operator. Without a cap the pool grows without bound and
 * money that could be revenue sits idle forever.
 */
export const RESERVE_CEILING_JACKPOTS = 8;

export function reserveCeiling(highestStake: number): number {
  const top = SPIN_TIERS[SPIN_TIERS.length - 1];
  return Math.round(highestStake * top.multiplier * RESERVE_CEILING_JACKPOTS * 100) / 100;
}

/**
 * Mandatory seed before high multipliers are enabled at all: two full
 * top-tier jackpots at the highest stake offered. Operator money, never taken
 * from player contributions.
 */
export function requiredSeed(highestStake: number): number {
  const top = SPIN_TIERS[SPIN_TIERS.length - 1];
  return Math.round(highestStake * top.multiplier * 2 * 100) / 100;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  THE REVEAL — one wheel, watched together (Dan 2026-08-21)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Verbatim: "THE WHEEL STARTS SPINNING THE MOMENT THE 3RD PLAYER PAYS FOR HIS
// SEAT... ONE SECOND LATER, A 3...2...1... COUNT DOWN CLOCK MUST BEGIN WITH A
// WHEEL SPIN." (PokerBros reference video.)
//
// WHY THIS IS A SHARED CLOCK AND NOT A LOCAL ONE. The wheel used to be decided
// per client: each one loaded the tournament row, saw a multiplier stamped
// within the last 90 seconds, and started its own wheel whenever it happened to
// finish loading. Three players therefore watched three different wheels at
// three different moments, and anyone who arrived late — or simply refreshed —
// missed the reveal entirely and had it marked as seen forever. The reveal is
// the whole drama of the format; it has to be one moment the table shares.
//
// So the ENGINE names the moment. It stamps `reveal_at` when the last seat is
// bought, broadcasts it to every seat, and HOLDS THE DEAL for the full sequence
// below. Clients render against that timestamp, so they are in step with each
// other regardless of when they connected, and cards can no longer be dealt
// underneath a spinning wheel.
//
// (Before this, nothing reserved the moment at all: the wheel only escaped
// being dealt over because engine start-up happened to take ~22 seconds. That
// was luck, not a contract.)

export const SPIN_REVEAL = {
  /** Dan: "ONE SECOND LATER" — the beat between the last buy-in and the count. */
  LEAD_IN_MS: 1000,
  /**
   * 3 ... 2 ... 1 on the starting tree: red, then yellow, then green, one
   * second apart. Dan 2026-08-21: "THE 3, 2, 1 SHOULD FEEL LIKE A NASCAR
   * COUNT DOWN." A NASCAR tree is evenly spaced whole seconds; anything
   * quicker reads as a stopwatch rather than a start.
   */
  COUNTDOWN_MS: 3000,
  /**
   * The chase light runs the disc and lands on the drawn tier.
   *
   * Dan 2026-08-21: "THE ROTATING SELECTOR SHOULD GO A LITTLE FASTER AND LAST
   * A LITTLE LONGER." Both at once, which is only possible by adding laps: the
   * chase went from 3 laps in 4200ms (5.5 steps/sec) to 5 laps in 6000ms
   * (~7.7 steps/sec). Faster light, longer sequence.
   */
  SPIN_MS: 6000,
  /**
   * The winning multiplier's outline flashes on its own before the result
   * card takes the screen. Dan: "FLASH ALONG THE OUTER EDGES OF THE
   * MULTIPLIER THAT ONE" — which needs a beat of its own, or the result card
   * lands on top of the thing it is announcing.
   */
  WINNER_FLASH_MS: 1600,
  /** The prize is read. Long enough that the choral landing is not cut off. */
  RESULT_HOLD_MS: 3200,
} as const;

/** Total wall time from the last buy-in to the first card being dealt. */
/**
 * The whole sequence, and therefore exactly how long the engine holds the
 * deal. Every beat is summed here rather than hand-totalled anywhere else:
 * the client used to carry its OWN result duration (4200ms) against an engine
 * hold built from 2200ms, so for two full seconds a player could be dealt
 * cards on top of the card announcing what they were playing for. Same class
 * of bug as the hand-completion hold, same fix — one number, derived.
 */
export function spinRevealTotalMs(): number {
  const R = SPIN_REVEAL;
  return R.LEAD_IN_MS + R.COUNTDOWN_MS + R.SPIN_MS + R.WINNER_FLASH_MS + R.RESULT_HOLD_MS;
}
