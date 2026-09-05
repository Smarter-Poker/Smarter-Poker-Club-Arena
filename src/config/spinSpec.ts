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
 * expectation is 2.76, and (3 − 2.76) / 3 = 8.00% — the advertised 8%, at
 * every stake. Had the player been charged buy-in PLUS 8% on top,
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
// RAKE — ONE RATE, because the multiplier table is what actually charges it
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ─── THE BANDS ARE GONE (Dan 2026-08-27, ruling) ────────────────────────────
 *
 * There used to be four buy-in bands here, booking 8 / 7 / 6 / 5% as the stake
 * rose. They were fiction, and expensive fiction, for the reason stated at the
 * top of this file: on a Spin the rake IS the multiplier distribution. There is
 * exactly ONE `SPIN_TIERS` table, its expectation is 2.76 (2.7638 until the
 * 2026-09-05 rebalance below), and the invariant
 *
 *     E[multiplier] = seats × (1 − rake_rate)
 *
 * is an EQUALITY. At three seats it is satisfied at 8% and at no other rate.
 * Lowering the booked rate to 7, 6 or 5% never changed a single frequency, so
 * the player's expected return stayed 92.13% at every stake (92.00% since the
 * 2026-09-05 rebalance) while the ledger
 * recorded a smaller cut. Measured on 2026-08-27, booked against actually
 * charged: 8.00%/8.74%, 7%/8.50%, 6%/8.04%, 5%/8.03%. A player at a 100 stake
 * was told 5% and charged 8.03%.
 *
 * The gap did not go to the house either — it accumulated in `spin_bonus_pools`
 * as 36,723.84 chips belonging to nobody, reconciling exactly with the pool
 * balance minus the operator seed.
 *
 * A banded product is still possible, but it costs a multiplier table PER BAND.
 * One table means one rate, and `assertSpinRakeInvariant` below is what makes
 * the next attempt to split them fail loudly instead of quietly.
 *
 * (The chips already in the pool are a separate remediation decision and were
 * deliberately NOT touched by the change that deleted the bands.)
 */
export const SPIN_RAKE_RATE = 0.08;

/**
 * The house rake rate for a Spin. Flat at every stake — see above.
 *
 * The buy-in parameter is kept so every existing call site still reads as a
 * question about THIS game, and so a genuine future banding has one function to
 * change rather than a dozen. It is deliberately unused today.
 */
export function spinRakeRate(_buyIn?: number): number {
  return SPIN_RAKE_RATE;
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
  /** Blind level length in minutes. */
  levelMinutes: number;
  /**
   * Reserve Pool gate. The multiplier is EXCLUDED from the draw unless the
   * pool holds at least this many times its own full prize pool at the
   * highest stake currently running. 0 = always available.
   */
  reserveThresholdX: number;
}

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
 * advertised at 8.00% (7.87% until the 2026-09-05 rebalance). Taking more
 * from every player as a side effect of
 * a wheel change is exactly the failure this file exists to make impossible.
 *
 * So the mass was MOVED, not deleted, holding both totals invariant:
 *
 *   100x   500 → 1,008    (+508)
 *   2x   4,772,497 → 4,772,073  (−424)
 *   3x   3,968,502 → 3,968,518  (+16)
 *
 *   total freq   10,000,099  (unchanged BY THE RETIREMENT; 10,000,000 since
 *                             the 2026-09-05 rebalance)
 *   Σ mult×freq  27,638,000  (unchanged)
 *   E            2.763773    (unchanged BY THE RETIREMENT; 2.76 exactly
 *                             since the 2026-09-05 rebalance)
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
    /* REBALANCED 2026-09-05 (Dan: the ladder is mine to fix).
       4_772_497 before the 500x retirement, then 4_772_073, and that table
       expected 2.763772x - so the house actually charged 7.874%, not the 8.00%
       SPIN_RAKE_RATE books and fn_spin_settle_game deducts. The 0.126pp
       difference was paid to players in prizes and taken from the reserve,
       which is why spin_bonus_pools kept drifting away from the seed.

       assertSpinRakeInvariant did not catch it because driftPerBuyIn rounds
       BOTH sides to cents, and 2.7638 and 2.7600 both round to 2.76. A guard
       that rounds away the quantity it exists to measure is not a guard; it
       has an exact check beside it now.

       Only the 2x/3x split moves, by 0.38 of a percentage point. Every tier
       from 4x up keeps its frequency to the unit, so the big-win experience is
       byte-identical - and because the denominator is now exactly 10,000,000
       their probabilities read cleaner too (9.000000% rather than 8.999911%).
       Solved as an equality, not fitted: with the upper ladder fixed,
       f2 + f3 = 8,740,492 and 2*f2 + 3*f3 = 21,411,700 has exactly one integer
       solution, and it lands E[m] on 2.76 to the last bit a double holds. */
    freq: 4_809_776,
    payouts: [1],
    levelMinutes: 3,
    reserveThresholdX: 0,
  },
  {
    multiplier: 3,
    // 3_968_502 before the 500x retirement, then 3_968_518. See the 2x tier
    // for why this pair moved on 2026-09-05: they are the only two that did.
    freq: 3_930_716,
    payouts: [1],
    levelMinutes: 3,
    reserveThresholdX: 0,
  },
  {
    multiplier: 4,
    freq: 900_000,
    payouts: [1],
    levelMinutes: 3,
    reserveThresholdX: 0,
  },
  {
    multiplier: 5,
    freq: 250_000,
    payouts: [1],
    levelMinutes: 3,
    reserveThresholdX: 0,
  },
  {
    multiplier: 10,
    freq: 100_000,
    payouts: [0.8, 0.2],
    levelMinutes: 3,
    reserveThresholdX: 0,
  },
  {
    multiplier: 25,
    freq: 7_500,
    payouts: [0.8, 0.12, 0.08],
    levelMinutes: 3,
    reserveThresholdX: 0,
  },
  {
    multiplier: 50,
    freq: 1_000,
    payouts: [0.8, 0.12, 0.08],
    levelMinutes: 3,
    reserveThresholdX: 0,
  },
  {
    multiplier: 100,
    // 500 before the 500x retirement: this tier absorbed that one's frequency
    // plus the extra mass needed to hold the expectation flat.
    freq: 1_008,
    payouts: [0.8, 0.12, 0.08],
    levelMinutes: 3,
    // Deliberately still 1.5, not the 2.0 the 500x used. Raising it would lock
    // the top of the ladder out of thin pools far more often than before, now
    // that this tier is drawn twice as frequently.
    reserveThresholdX: 1.5,
  },
];

/**
 * Denominator for `freq` — DERIVED FROM THE LADDER, never written by hand.
 *
 * It was the literal `10_000_000` while the tiers below actually sum to
 * 10,000,099 (this file's own 500x-retirement note said so in as many words).
 * Since the 2026-09-05 rebalance they sum to exactly 10,000,000 - which is
 * precisely why this constant is DERIVED: the literal would have been wrong
 * twice now. Anything dividing a `freq` by a hand-written literal would have
 * described a distribution totalling 100.00099%, and the
 * only reason no money moved is that the one real consumer
 * (TournamentService's SPEC_TOTAL_FREQ) re-totals the array itself and treats
 * this as a fallback it never reaches.
 *
 * A hand-maintained total of a hand-maintained table is a drift waiting to
 * happen, and this one had already drifted. Summing the ladder makes the two
 * incapable of disagreeing: retune a tier and the denominator follows.
 */
export const SPIN_FREQ_DENOMINATOR: number = SPIN_TIERS.reduce((sum, t) => sum + t.freq, 0);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE STACK BELONGS TO THE BOARD, NOT TO THE MULTIPLIER (Dan, 2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "we used to award more chips depending on if its a higher
 * multiplier... we are no longer doing that, once a player sits down and
 * 'buys in' they either get 300 chips for a turbo, or 1000 chips for a deep
 * stack. as soon as they buy in 300 chips should appear in their action box
 * (not 0)."
 *
 * THIS SUPERSEDES THE 2026-08-23 STACK BANDS. That ruling read "STANDARD /
 * TURBO SHOULD BE 300. DEEP STACK SHOULD BE 1000 CHIPS, ANY MULTIPLIERS OVER
 * 25X SHOULD BE 5000 CHIPS" and was implemented as `SpinTierSpec.startingStack`
 * -- 300/300/1000/1000/1000/1000/5000/5000, chosen by the tier the wheel drew.
 * The 5000 band is retired with it. Do not reintroduce either; a stack that
 * depends on the draw is the thing this replaces.
 *
 * WHY IT MATTERS BEYOND PREFERENCE. A stack that depends on the multiplier
 * cannot be known until the wheel lands, so the seat could not hold a real
 * stack when the player paid: `fn_take_seat_and_buy_in` wrote `stack = 0` and
 * the true number arrived ~14.8 seconds later on the chip-drop beat. The
 * client papered over the gap with the row's placeholder and showed 0 whenever
 * that read failed. Deciding the stack at the BOARD makes it known at buy-in,
 * which is what lets the seat show 300 the moment the money leaves the wallet.
 *
 * Two boards, one blind ladder. Dan, 2026-08-23, still standing: "SPEED
 * SHOULDN'T CHANGE, ONLY THE STARTING STACK. BLIND LEVELS WILL ALWAYS BE THE
 * SAME." Level length stays 3 minutes everywhere, so the only thing separating
 * a Turbo from a Deep Stack is how deep it starts:
 *
 *   Turbo        300 chips   15bb, over fast
 *   Deep Stack  1000 chips   50bb, the same prize played out properly
 */
export type SpinSpeed = 'turbo' | 'deep';

/** The whole stack table. Two numbers, and neither depends on the draw. */
export const SPIN_STACKS: Record<SpinSpeed, number> = {
  turbo: 300,
  deep: 1000,
};

/** What a player sees on the board. Title Case, per the house copy rule. */
export const SPIN_SPEED_LABELS: Record<SpinSpeed, string> = {
  turbo: 'Turbo',
  deep: 'Deep Stack',
};

/**
 * Blind ladder. Identical on both boards and at every multiplier.
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

/**
 * The ladder as a player-facing odds table (2026-08-29, spin buy-in sheet).
 *
 * DERIVED from SPIN_TIERS and nothing else, so a retuned tier reprices the
 * display the moment it lands - a hand-written copy of this table is exactly
 * the drift SPIN_FREQ_DENOMINATOR's own note warns about. `oneIn` is the
 * everyday phrasing of the frequency ("1 In 9,921"); `payoutLabel` is the
 * split by place, already formatted ("Winner Takes All" / "80% / 12% / 8%").
 */
export interface SpinOddsRow {
  multiplier: number;
  oneIn: number;
  payoutLabel: string;
}

export function spinOddsTable(tiers: SpinTierSpec[] = SPIN_TIERS): SpinOddsRow[] {
  const total = tiers.reduce((s, t) => s + t.freq, 0);
  return tiers
    .slice()
    .sort((a, b) => a.multiplier - b.multiplier)
    .map((t) => ({
      multiplier: t.multiplier,
      oneIn: total > 0 && t.freq > 0 ? Math.round(total / t.freq) : 0,
      payoutLabel:
        t.payouts.length <= 1
          ? 'Winner Takes All'
          : t.payouts.map((p) => `${Math.round(p * 100)}%`).join(' / '),
    }));
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  HOW LOUDLY DOES THIS DRAW CELEBRATE? (2026-08-29, round 15)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A 100x lands about once in 9,921 games and a 2x lands about every other
 * game, and until now they celebrated almost identically: the confetti burst
 * was a FLAT 24 pieces for 25x, 50x and 100x alike, the banner read the same
 * "JACKPOT SPIN" for 25x and 50x, and the sound differed only in volume - the
 * same chord, turned up. The rarest event in the product had no moment of its
 * own.
 *
 * This is the one place that decides intensity, so the wheel and the sound
 * can never drift apart (the same discipline as spinOddsTable: derive, never
 * duplicate). Thresholds intentionally match `tierClass`, which already bands
 * the wheel's colour.
 *
 * ANIMATION LAW (CLAUDE.md 10.6): this only ever ADDS. Every band that
 * celebrated before still celebrates, for at least as long and at least as
 * loudly; `mid` is new, so a 10x - a 1-in-100 draw that previously got
 * nothing at all - now gets a modest burst. No band returns zero pieces, and
 * nothing here can gate an animation off.
 */
export type SpinCelebrationBand = 'base' | 'mid' | 'big' | 'mega';

export interface SpinCelebration {
  band: SpinCelebrationBand;
  /** Confetti pieces. Scales with rarity; never zero for a celebrating band. */
  confettiPieces: number;
  /** Banner text, or null when the draw is an ordinary one. */
  label: string | null;
  /** Audio intensity 0..1, consumed by SoundService so the two cannot drift. */
  soundLevel: number;
}

export function spinCelebration(multiplier: number): SpinCelebration {
  const m = Number(multiplier) || 0;
  if (m >= 100) {
    return { band: 'mega', confettiPieces: 72, label: 'MEGA JACKPOT', soundLevel: 1 };
  }
  if (m >= 50) {
    return { band: 'big', confettiPieces: 48, label: 'SUPER JACKPOT', soundLevel: 0.95 };
  }
  if (m >= 25) {
    return { band: 'big', confettiPieces: 32, label: 'JACKPOT SPIN', soundLevel: 0.9 };
  }
  if (m >= 10) {
    // New in round 15. A 1-in-100 draw deserves more than silence.
    return { band: 'mid', confettiPieces: 16, label: 'BIG SPIN', soundLevel: 0.8 };
  }
  return { band: 'base', confettiPieces: 0, label: null, soundLevel: 0.72 };
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
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE INVARIANT, AS AN ASSERTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The rule at the top of this file is an equality:
 *
 *     E[multiplier] = seats × (1 − rake_rate)
 *
 * For three years of this file's life it was prose. Prose does not fail a
 * build, so on 2026-08-20 the rake was banded down to 5% at the top of the
 * ladder without anyone regenerating a frequency — the two halves of the
 * equality drifted apart in silence and 36,723.84 chips ended up unowned.
 *
 * This is that sentence, executable. It compares the two sides TO THE CENT,
 * which is the finest money numeric(15,2) can store and therefore the finest
 * difference that can ever reach a ledger row. Anything coarser would have let
 * the 5% band through (2.85 vs 2.76 is nine cents, but 8.04% vs 8.00% is only
 * 0.0017 of edge — a tolerance loose enough to be "close" is loose enough to
 * be wrong).
 *
 * It THROWS rather than returning a boolean so it cannot be called and ignored,
 * and it is deliberately NOT invoked at module load: a config that refuses to
 * import takes production down, where a red test only stops a deploy. Stopping
 * the deploy is the outcome we want. tests/config/spinSpec.test.ts calls it.
 */
export interface SpinRakeInvariant {
  /** Σ multiplier × freq / Σ freq over the full ladder. */
  expected: number;
  /** seats × (1 − SPIN_RAKE_RATE) — what the booked rate claims to charge. */
  implied: number;
  /** expected − implied, in chips per chip of buy-in. */
  driftPerBuyIn: number;
  /** The edge the table actually charges, whatever the booked rate says. */
  actualEdge: number;
}

export function spinRakeInvariant(
  tiers: SpinTierSpec[] = SPIN_TIERS,
  seats: number = SPIN_SEATS,
  rakeRate: number = SPIN_RAKE_RATE
): SpinRakeInvariant {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const expected = expectedMultiplier(tiers);
  const implied = seats * (1 - rakeRate);
  return {
    expected,
    implied,
    driftPerBuyIn: round2(expected) - round2(implied),
    actualEdge: impliedHouseEdge(tiers, seats),
  };
}

/** Throws with the arithmetic if the table and the booked rate disagree. */
export function assertSpinRakeInvariant(
  tiers: SpinTierSpec[] = SPIN_TIERS,
  seats: number = SPIN_SEATS,
  rakeRate: number = SPIN_RAKE_RATE
): void {
  const inv = spinRakeInvariant(tiers, seats, rakeRate);
  /* CENTS ARE NOT ENOUGH (2026-09-05). driftPerBuyIn rounds both sides to two
     decimals, so the table that expected 2.763772x against an implied 2.76
     satisfied this check for weeks while charging 7.874% instead of the booked
     8.00%. Rounding away the quantity the guard exists to measure is how a
     0.126pp edge survives a green suite. The exact comparison is the real
     invariant; EPSILON only absorbs the last bit or two of double arithmetic
     (3 * (1 - 0.08) is 2.7600000000000002, not 2.76). */
  const EXACT_EPSILON = 1e-9;
  if (Math.abs(inv.expected - inv.implied) > EXACT_EPSILON) {
    throw new Error(
      `SPIN RAKE INVARIANT BROKEN: the multiplier table expects ${inv.expected.toFixed(6)}x ` +
        `but a ${(rakeRate * 100).toFixed(2)}% rake over ${seats} seats implies ` +
        `${inv.implied.toFixed(6)}x. The table actually charges ` +
        `${(inv.actualEdge * 100).toFixed(2)}%. Changing SPIN_RAKE_RATE requires ` +
        `regenerating SPIN_TIERS so the frequencies pay the new rate - the rate ` +
        `alone is a booking entry, the table is what the player is charged.`
    );
  }
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

  /* THE SAME RESIDUAL RULE THE LIVE PAYER USES (2026-08-31 audit).
     This used to hand the rounding remainder to FIRST place while
     payoutMath.computePlacePrize - the function that actually pays a
     tournament - gives it to the LAST PAID PLACE. Both guarantee the parts
     sum to the pool, so no money differed while buy-ins and multipliers are
     whole numbers and no fractional cent ever arises. But this module
     presents itself as "the money for one game", and a model that computes
     the split by a different rule than the payer is a model that will
     eventually be believed over the payer. Same rule, one source of truth. */
  const payouts: number[] = new Array(splits.length).fill(0);
  let remaining = prizePool;
  for (let i = 0; i < splits.length - 1; i++) {
    const amt = round2(prizePool * splits[i]);
    payouts[i] = amt;
    remaining = round2(remaining - amt);
  }
  payouts[splits.length - 1] = remaining;

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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SEED REPAYMENT PLAN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-23: "IMPLEMENT A REPAYMENT PLAN THAT'S STRUCTURED INTO THE
 * ARCHITECTURE OF THE POOL, THAT PAYS BACK A CERTAIN PERCENTAGE TO THE FUNDING
 * WALLET EVERY TIME THE WALLET REACHES A CERTAIN THRESHOLD OF FUNDS."
 *
 * WHY INSTALMENTS ARE NOT JUST NICER, THEY ARE THE ONLY THING THAT WORKS.
 *
 * This pool has ZERO DRIFT by construction. The identity at the top of this
 * file — E[multiplier] = seats × (1 − rake) — means E[reserve_out] equals
 * reserve_in exactly. The rake is taken BEFORE the pool and is the revenue;
 * what is left is a float that random-walks and never grows in expectation.
 *
 * The first repayment rule waited for the pool to hold a whole extra seed's
 * worth before returning anything. On a zero-drift walk that is a wait for a
 * large excursion which may never arrive — the owner's capital could sit in
 * the pool forever. Harvesting the UPSWINGS is the only mechanism available,
 * because upswings are the only thing a zero-drift process reliably produces.
 *
 * THE PLAN
 *
 *   FLOOR    the pool must always be able to pay its biggest advertised prize.
 *            That is requiredSeed(): two top-tier jackpots at the largest
 *            stake offered. Repayment never takes the balance below it, so the
 *            100x on the wheel is always real money.
 *
 *   TRIGGER  nothing is returned until the balance sits 25% clear of the
 *            floor. Skimming the instant it peeks above would nibble the
 *            working capital on every ripple and re-lock the top tiers.
 *
 *   RATE     half of everything above the floor goes back. Half, not all,
 *            because the pool needs to keep some of its own upswing: a wheel
 *            whose top prize flickers in and out of reach as the balance is
 *            shaved to the floor is a worse product than one that pays the
 *            operator back a little more slowly.
 *
 * Repayment STOPS the moment the seed is square. It is a loan being retired,
 * not a rake — Dan, on the same day: "IT RETURNS EVERYTHING IT COLLECTS...
 * ALL PROCEEDS ARE KEPT THERE TO FUND THE MULTIPLIER PAYOUTS." Once the owner
 * is whole, every chip stays in the pool. This is why the old ceiling sweep is
 * gone and is not coming back in a new coat.
 *
 * Worked, at a 100 stake: floor 20,000, so nothing moves until 25,000. At
 * 25,000 the surplus is 5,000 and 2,500 goes home, leaving 22,500 — still
 * clear of the floor. A 20,000 seed retires in eight such visits.
 */
export const SEED_REPAY_TRIGGER_X = 1.25;
export const SEED_REPAY_RATE = 0.5;
/** Below this an instalment is dust and only makes ledger noise. */
export const SEED_REPAY_MIN_INSTALMENT = 1;

/** The balance at which the next instalment becomes due. */
export function seedRepayTriggerAt(highestStake: number): number {
  return Math.round(requiredSeed(highestStake) * SEED_REPAY_TRIGGER_X * 100) / 100;
}

/**
 * What the next instalment would be at this balance, given what is still owed.
 * Returns 0 when nothing is due. Mirrors fn_spin_seed_instalment in the
 * database — a test pins the two together, because a disagreement means the
 * owner menu quotes one number and the wallet moves another.
 */
export function seedInstalmentDue(balance: number, outstandingSeed: number, floor: number): number {
  if (outstandingSeed <= 0 || floor <= 0) return 0;
  if (balance < floor * SEED_REPAY_TRIGGER_X) return 0;
  const surplus = balance - floor;
  if (surplus <= 0) return 0;
  const instalment = Math.min(outstandingSeed, surplus * SEED_REPAY_RATE);
  const rounded = Math.round(instalment * 100) / 100;
  return rounded >= SEED_REPAY_MIN_INSTALMENT ? rounded : 0;
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
  /**
   * AFTER the wheel: the stacks arrive. Dan 2026-08-21: "AFTER THE SPIN
   * COMPLETES, CHIP STACKS GET ADDED, BUTTON RANDOMLY ASSIGNED AND THE SPIN
   * STARTS."
   *
   * This beat exists for the CUE, not because the number is unknown. It used
   * to be the latter: a seat was a RESERVATION at zero chips because stack
   * depth was read off a tier nobody had drawn yet. That is retired — the
   * stack belongs to the board (SPIN_STACKS: Turbo 300, Deep Stack 1000), it
   * is known before anybody sits, and the seat holds it from the moment the
   * buy-in is paid. What survives is the THEATRE: the chips must be SEEN to
   * land after the wheel. Crediting the seats before the reveal meant
   * stacks appeared on the felt while the wheel was still turning: the table
   * had quietly answered the question the wheel was in the middle of asking.
   */
  CHIP_DROP_MS: 900,
  /**
   * Then the button is drawn. Randomly, and visibly — the first button used to
   * be the lowest-numbered occupied seat, which is deterministic and therefore
   * a real (if small) positional edge for whoever sat first.
   */
  BUTTON_DRAW_MS: 900,
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

/** Chips land, then the button is drawn. */
export function spinPostRevealMs(): number {
  return SPIN_REVEAL.CHIP_DROP_MS + SPIN_REVEAL.BUTTON_DRAW_MS;
}

/**
 * Wheel to first card: everything the player must see before a hand may start.
 *
 * This is what the engine holds for. It has to include the post-reveal beats,
 * not just the wheel — hold only for the wheel and the engine is free to deal
 * in the same instant the chips are being written, which is a race the deal
 * usually wins.
 */
export function spinRevealToDealMs(): number {
  return spinRevealTotalMs() + spinPostRevealMs();
}
