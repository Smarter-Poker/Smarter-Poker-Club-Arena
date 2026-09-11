/**
 * OPERATION STABLE HAND - pure core.
 *
 * Occupancy curve, table shape, stake mix, tagging, bankroll math, entry caps,
 * booking lines and human-yield timing. No IO, no clock, no randomness: every
 * function here is a pure function of its arguments, and every "random" choice
 * is a sha256 of a stable key. That is deliberate - Section 16 requires the
 * 34 tests to be deterministic, and `Math.random` in a seating engine is a
 * heisenbug you cannot reproduce from a player complaint.
 *
 * THE ONE CORRECTION TO THE OPORD (see
 * docs/changelog/2026-09-04-operation-stable-hand-recon.md):
 * occupancy is capped PER HOST, not per club. JAQK is a strict subset of
 * Shark (580 of 580 measured), so a per-club cap counts the same body twice
 * and yields 80% peak occupancy where Dan asked for 40%. club_id still picks
 * the WALLET; the host picks the bucket.
 */

import { createHash } from 'crypto';
import { stakeBandForBigBlind, type HorseStakeBand } from './HorseBehavior.js';

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

export const STABLE_HAND_SEED = 'stable-hand-v3';

export const MIDWAY_UNION_ID = 'fade0000-0000-0000-0000-000000000001';
export const JAQK_CLUB_ID = 'a0000000-0000-0000-0000-000000000001';
export const SHARK_CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
export const DSS_CLUB_ID = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';

/** A host owns tables and is the unit of occupancy. */
export type HostId = typeof MIDWAY_UNION_ID | typeof DSS_CLUB_ID;

/** Wallets legal for each host. Midway Union tables are bought into from a
 *  JAQK or Shark wallet; DSS tables from the DSS wallet. Measured live:
 *  396 DSS seats, 158 Shark, 155 JAQK, 0 Midway-Union-wallet. */
export const WALLETS_FOR_HOST: Record<string, string[]> = {
  [MIDWAY_UNION_ID]: [JAQK_CLUB_ID, SHARK_CLUB_ID],
  [DSS_CLUB_ID]: [DSS_CLUB_ID],
};

export function hostForWallet(clubId: string): HostId | null {
  if (clubId === JAQK_CLUB_ID || clubId === SHARK_CLUB_ID) return MIDWAY_UNION_ID;
  if (clubId === DSS_CLUB_ID) return DSS_CLUB_ID;
  return null;
}

/** Section 1.2: sit(horse, club, table) is legal only when the wallet's host
 *  is the table's host. This is the whole of the cross-host rule. */
export function sitIsLegalForHost(clubId: string, tableHostId: string): boolean {
  return hostForWallet(clubId) === tableHostId;
}

/* ------------------------------------------------------------------ */
/* Deterministic hashing                                               */
/* ------------------------------------------------------------------ */

/** Stable 32-bit unsigned hash. sha256 so the ordering is reproducible
 *  across processes and node versions, unlike a JS string hash. */
export function shHash(...parts: string[]): number {
  const h = createHash('sha256').update(parts.join('|')).digest();
  return h.readUInt32BE(0);
}

/** Full hex digest, for total orderings where 32 bits would collide. */
export function shDigest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Section 1.1 / 11 - population and occupancy                         */
/* ------------------------------------------------------------------ */

export interface HostPopulation {
  hostId: string;
  /** Unique horse BODIES eligible to play this host. */
  n: number;
}

export function peakCap(n: number): number {
  return Math.floor(0.4 * n);
}
/**
 * The overnight hard ceiling, 03:00-08:00 Chicago.
 *
 * FIVE PERCENT, NOT TEN (Dan, 2026-09-04). The OPORD wrote 10%, and the first
 * night the curve was actually enforced Dan read the numbers it produced -
 * 58 bodies on Midway Union and 41 on Deep Stack Society - and said:
 * "there should not be 89 people playing in the middle of the night, cut that
 * from 10% to 5%. thats a more reasonable and accurate number we should see."
 *
 * It is the only night knob that needs to move: the curve reaches 10, 8, 7, 8
 * and 9 percent across those five hours, so a 5% ceiling binds every one of
 * them and the whole window lands on 5%. Midway Union 29, Deep Stack 20.
 */
export const NIGHT_CAP_PCT = 0.05;

export function nightCap(n: number): number {
  return Math.floor(NIGHT_CAP_PCT * n);
}

/** Section 7.2 tag split, recomputed from live N as the OPORD instructs. */
export function tagSplit(n: number): {
  cash: number;
  tourney: number;
  both: number;
  cashFreeroll: number;
} {
  const cash = Math.floor(0.3 * n);
  const tourney = Math.floor(0.3 * n);
  const both = n - cash - tourney;
  const cashFreeroll = Math.floor(0.15 * cash);
  return { cash, tourney, both, cashFreeroll };
}

/**
 * Section 11 hourly occupancy curve, as a PERCENT OF N, keyed on the
 * America/Chicago hour. Values are the OPORD's table verbatim.
 */
export const OCCUPANCY_CURVE_PCT: Record<number, number> = {
  0: 35,
  1: 28,
  2: 16,
  3: 10,
  4: 8,
  5: 7,
  6: 8,
  7: 9,
  8: 10,
  9: 14,
  10: 18,
  11: 22,
  12: 26,
  13: 28,
  14: 30,
  15: 33,
  16: 36,
  17: 38,
  18: 40,
  19: 40,
  20: 40,
  21: 39,
  22: 38,
  23: 36,
};

/**
 * LATE NIGHT HAS NO SHORT-HANDED GAMES (Dan, 2026-09-04).
 *
 * "fewer tables, more players at each table. late night shouldn't have any
 * 2-3 handed games."
 *
 * Four is the smallest table that is not 2-3 handed. A shaped table below it
 * inside the night window is parked - drained of horses and closed until
 * morning - so the night's seats concentrate rather than spread.
 */
export const NIGHT_MIN_PLAYERS = 4;

/**
 * The floor under how many tables a host keeps open overnight.
 *
 * Without a floor the parking cascades: the wind-down thins tables as it runs,
 * every table falls under NIGHT_MIN_PLAYERS, every table is parked, and the
 * host has nowhere left to seat anybody.
 */
export const NIGHT_MIN_OPEN_TABLES = 6;

/** A full ring. What one kept-open table is assumed to hold. */
export const NIGHT_SEATS_PER_TABLE = 6;

/**
 * How many tables this host must keep open tonight to seat the people it is
 * allowed to have.
 *
 * A FIXED floor was not enough on its own: Midway Union's 5% cap is 29 bodies
 * holding up to 1.3 seats each, which is 38 seats and needs seven full rings,
 * not six. Parking down to six would have left the seeder unable to place
 * everyone the curve asks for - the head count would then sit under target for
 * no reason a player could see.
 *
 * Rounded UP and against the WIDEST end of the seats-per-horse band, because
 * one extra open table is a far cheaper mistake than having nowhere to seat.
 */
export function nightTablesNeeded(maxBodies: number, chicagoHour: number): number {
  const seats = Math.max(0, maxBodies) * seatsPerHorseBand(chicagoHour).max;
  return Math.max(NIGHT_MIN_OPEN_TABLES, Math.ceil(seats / NIGHT_SEATS_PER_TABLE));
}

/** Night hard cap applies 03:00-08:00 Chicago inclusive of 03, exclusive of 08
 *  per the OPORD ("night hard cap starts" at 03:00, "ends" at 08:00). */
export function isNightWindow(chicagoHour: number): boolean {
  return chicagoHour >= 3 && chicagoHour < 8;
}

/** Linear interpolation between the two bracketing hours, so there is no
 *  cliff at 01:00 (the OPORD calls that out explicitly). */
export function curvePctAt(chicagoHour: number, minute = 0): number {
  const h = ((Math.floor(chicagoHour) % 24) + 24) % 24;
  const next = (h + 1) % 24;
  const a = OCCUPANCY_CURVE_PCT[h];
  const b = OCCUPANCY_CURVE_PCT[next];
  const f = Math.min(59, Math.max(0, minute)) / 60;
  return a + (b - a) * f;
}

export interface OccupancyTarget {
  /** Unique horses that SHOULD be live on this host right now. */
  target: number;
  /** Acceptable band, +/- 2 percentage points of N. */
  min: number;
  max: number;
  peakCap: number;
  nightCap: number;
  /** Which hard cap bound the result, if any. */
  clampedBy: 'none' | 'peak' | 'night';
}

/**
 * Section 11. Target unique-live horses for a host at a Chicago wall time,
 * with the +/-2pp band and both hard caps applied.
 */
export function occupancyTargetForHost(
  n: number,
  chicagoHour: number,
  minute = 0
): OccupancyTarget {
  const pk = peakCap(n);
  const nt = nightCap(n);
  const pct = curvePctAt(chicagoHour, minute);

  const raw = Math.round((pct / 100) * n);
  let target = raw;
  let clampedBy: OccupancyTarget['clampedBy'] = 'none';

  if (target > pk) {
    target = pk;
    clampedBy = 'peak';
  }
  if (isNightWindow(chicagoHour) && target > nt) {
    target = nt;
    clampedBy = 'night';
  }

  // +/-2pp of N, then re-clamp: a band must never lift you over a hard cap.
  const band = Math.round(0.02 * n);
  let min = Math.max(0, target - band);
  let max = target + band;
  max = Math.min(max, pk);
  if (isNightWindow(chicagoHour)) max = Math.min(max, nt);
  if (min > max) min = max;

  return { target, min, max, peakCap: pk, nightCap: nt, clampedBy };
}

/** Section 11 avg-seats-per-active-horse guidance, used by the dashboard
 *  and by the add-seat decision to know whether to widen or deepen. */
export function seatsPerHorseBand(chicagoHour: number): { min: number; max: number } {
  return isNightWindow(chicagoHour) ? { min: 1.0, max: 1.3 } : { min: 1.6, max: 2.2 };
}

/* ------------------------------------------------------------------ */
/* Section 5 - table shape                                             */
/* ------------------------------------------------------------------ */

export type ShapeBucket = 'FULL' | 'ONE_OPEN' | 'JOINABLE';

export interface ShapeTargets {
  n: number;
  full: number;
  oneOpen: number;
  joinable: number;
}

/**
 * Section 5.2 rounding function, implemented to the letter including the
 * small-n special cases. The order matters: the n==1/2/3 cases override the
 * proportional split, and the n>=5 rule guarantees at least one joinable
 * table so a human always has somewhere to sit down.
 */
export function shapeTargets(n: number): ShapeTargets {
  if (n <= 0) return { n: 0, full: 0, oneOpen: 0, joinable: 0 };
  if (n === 1) return { n, full: 1, oneOpen: 0, joinable: 0 };
  if (n === 2) return { n, full: 1, oneOpen: 1, joinable: 0 };
  if (n === 3) return { n, full: 2, oneOpen: 1, joinable: 0 };

  let full = Math.round(n * 0.6);
  let oneOpen = Math.round(n * 0.2);
  let joinable = n - full - oneOpen;

  while (joinable < 0 && full > 0) {
    full -= 1;
    joinable += 1;
  }

  // n >= 5 must always offer at least one joinable table.
  if (n >= 5 && joinable < 1) {
    if (full > 0) {
      full -= 1;
      joinable += 1;
    } else if (oneOpen > 0) {
      oneOpen -= 1;
      joinable += 1;
    }
  }

  return { n, full, oneOpen, joinable };
}

/** Occupied-seat count that puts a table in each bucket. */
export function seatsForBucket(
  bucket: ShapeBucket,
  maxPlayers: number
): { min: number; max: number } {
  switch (bucket) {
    case 'FULL':
      return { min: maxPlayers, max: maxPlayers };
    case 'ONE_OPEN':
      return { min: maxPlayers - 1, max: maxPlayers - 1 };
    case 'JOINABLE': {
      // 3 or 4 empty seats, minimum 2 occupied. Never list a 1-player table.
      const min = Math.max(2, maxPlayers - 4);
      const max = Math.max(min, maxPlayers - 3);
      return { min, max };
    }
  }
}

/** Which bucket a table currently sits in, from its occupied count. */
export function bucketOf(occupied: number, maxPlayers: number): ShapeBucket | 'UNDER' | 'OVER' {
  if (occupied >= maxPlayers) return 'FULL';
  if (occupied === maxPlayers - 1) return 'ONE_OPEN';
  const j = seatsForBucket('JOINABLE', maxPlayers);
  if (occupied >= j.min && occupied <= j.max) return 'JOINABLE';
  if (occupied > j.max) return 'OVER'; // between joinable and one-open
  return 'UNDER'; // 0 or 1 seat - must never be listed as joinable
}

/* ------------------------------------------------------------------ */
/* Section 5.4 - stake mix, and the phase clamp                        */
/* ------------------------------------------------------------------ */

export interface Stake {
  sb: number;
  bb: number;
}

/**
 * The name a table of this variant carries in the lobby.
 *
 * Title Case with no em dash, per CLAUDE.md section 5: a table name is copy a
 * player reads. Unknown variants fall back to their own key upper-cased rather
 * than to "NLH", because a table labelled as a game it is not dealing is worse
 * than one labelled awkwardly.
 */
export const VARIANT_LABEL: Record<string, string> = {
  nlh: 'NLH',
  plo4: 'PLO',
  plo5: 'PLO5',
  plo6: 'PLO6',
  plo8: 'PLO8',
  pineapple: 'Crazy Pineapple',
  short_deck: 'Short Deck',
  flh: 'Limit Holdem',
  flo8: 'Limit Omaha8',
};

export function variantLabel(variant: string): string {
  const key = String(variant ?? '').toLowerCase();
  return VARIANT_LABEL[key] ?? key.toUpperCase();
}

/**
 * THE STAKE LADDER - every rung the platform actually deals.
 *
 * THERE IS NO CAP (Dan, 2026-09-05): "THERE ISN'T A 'CAP'. HORSES CAN ONLY
 * PLAY ABOVE 1/2 IF THEY HAVE THE 'PROPER BANKROLL' TO PLAY A BIGGER STAKE."
 *
 * This list used to stop at 1/2 and a `PHASE_MAX_BB = 2` clamp refused
 * everything above it "however rich the wallet". Nothing asked for that
 * clamp. Measured on production 2026-09-05, its effect was that
 * `stable_hand_membership_tags.preferred_stakes` held only 0.02 through 2.00
 * for all 1,000 horses, so every 2/5, 5/10, 10/20 and 25/50 game on the
 * platform was permanently unpopulated and the fleet logged "No available
 * horses ... band mid" every cycle - while 814 of those horses held 20+
 * buy-ins for 2/5 and 289 held 20+ buy-ins for 25/50. The bankroll is the
 * only gate now, and it is the one Dan named.
 *
 * The rungs are READ from `cash_games`, not invented (measured 2026-09-05).
 * Two live (sb, bb) pairs are deliberately NOT here:
 *   - 0.13/0.25 - one classic game, a stray small blind on a rung whose
 *     canonical blinds are 0.10/0.25 (23 games). Every gate that matters
 *     keys on the BIG blind, so a horse tagged for 0.25 plays it anyway;
 *     what the ladder decides is the blinds a NEW table opens at, and that
 *     must be the canonical pair.
 *   - 2.00/4.00 - one classic game, disabled, on a rung whose canonical
 *     blinds are 2.00/5.00 (16 enabled games). Same reasoning, and nothing
 *     is dealing it.
 *
 * 25/50 IS THE TOP RUNG, matching the DEFAULT_TABLES comment in
 * HorseFleetManager: 25/50 is the top by order and "anything above it is not
 * added here and must not be". That is the ladder's own ceiling, not a phase
 * clamp - a rung nobody deals is not a stake.
 */
export const STAKE_LADDER: Stake[] = [
  { sb: 0.01, bb: 0.02 },
  { sb: 0.02, bb: 0.05 },
  { sb: 0.05, bb: 0.1 },
  { sb: 0.1, bb: 0.25 },
  { sb: 0.25, bb: 0.5 },
  { sb: 0.5, bb: 1 },
  { sb: 1, bb: 2 },
  { sb: 2, bb: 5 },
  { sb: 5, bb: 10 },
  { sb: 10, bb: 20 },
  { sb: 25, bb: 50 },
];

/** The biggest big blind the platform deals. Derived from the ladder so it
 *  cannot drift from it: add a rung and the ceiling moves with it. */
export const LADDER_MAX_BB = STAKE_LADDER[STAKE_LADDER.length - 1].bb;

/** Is this a stake the platform deals at all? A table above the top rung is
 *  not a stake a horse declines on bankroll grounds - it is a table that
 *  should not exist. */
export function stakeIsOnLadder(bb: number): boolean {
  return STAKE_LADDER.some((s) => Math.abs(s.bb - bb) < 1e-9);
}

/** Everything at or below the ladder's top rung. This is the ONLY stake
 *  ceiling left; a stake below it is decided by the bankroll and nothing
 *  else. */
export function stakeIsWithinLadder(bb: number): boolean {
  return Number.isFinite(bb) && bb > 0 && bb <= LADDER_MAX_BB + 1e-9;
}

/**
 * THE BANDS ARE ONE DEFINITION (2026-09-05).
 *
 * This module used to carry its own three-band `stakeBandOf` (micro / low /
 * top, null above 2) while HorseBehavior carried a four-band
 * `stakeBandForBigBlind` (micro / low / mid / high, no ceiling). Two band
 * functions that disagree is a coin flip decided by whichever one a caller
 * happened to import. The four-band one is canonical - it is the one the
 * database writes (`fn_assign_horse_stake_bands` stores micro/low/mid/high
 * into `profiles.horse_profile`), the one `stakeBandAllows` gates seats on,
 * and the one Dan named. StableHand re-exports it rather than restating it.
 *
 * ('low' is the band Dan calls small. The name is the one already stored in
 * the database and in `profiles.horse_profile`; renaming it here would make
 * every stored band unreadable, so it stays.)
 */
export type StakeBand = HorseStakeBand;
export const stakeBandOf: (bb: number) => StakeBand = stakeBandForBigBlind;

export const STAKE_BANDS: readonly StakeBand[] = ['micro', 'low', 'mid', 'high'] as const;

/**
 * The share of seats each band should hold.
 *
 * These are the fleet's own band proportions, already measured and already
 * written down in HorseBehavior: 22/52/15/11 follows live seat demand, "so
 * merit decides WHO is in a band and demand decides HOW MANY - no stake level
 * ends up without enough horses to fill it". Using the same four numbers here
 * means the floor the planner shapes and the fleet that populates it are
 * working from ONE distribution rather than two.
 *
 * The old 40/35/25 could not be carried forward: it was written over three
 * bands that all sat at or below 1/2, so every share of it lived inside what
 * is now the micro and low bands, and mid and high would have had a target of
 * zero seats forever.
 */
export const STAKE_MIX: Record<StakeBand, number> = {
  micro: 0.22,
  low: 0.52,
  mid: 0.15,
  high: 0.11,
};

/** Which band is furthest below its share right now. Drives which stake the
 *  launcher reaches for next.
 *
 *  A band with a target of ZERO is skipped rather than compared: an empty
 *  band with a zero target has a deficit of exactly 0, which beats every
 *  oversubscribed band's negative deficit and would make the launcher chase
 *  a band nobody asked for.
 *
 *  A BAND THE HOST HAS NO ENABLED GAME IN IS NOT NEEDY, IT IS CLOSED
 *  (2026-09-11). `eligible` is the set of bands with at least one enabled
 *  game on the host; a band outside it is never returned. Without it the
 *  planner asked for `high` on Midway Union on every under-curve cycle -
 *  the operator closed every game above 2/5 on 2026-09-04, so `high` held
 *  zero seats, a deficit of 0.11 beat every other band, and the seeder
 *  refused the same 25/50 order 328 times in 90 minutes on 2026-09-09
 *  ("switched off by an operator"). Returns null when no band is eligible. */
export function neediestStakeBand(
  seatsByBand: Record<StakeBand, number>,
  eligible?: ReadonlySet<StakeBand>
): StakeBand | null {
  const bands = STAKE_BANDS.filter((b) => !eligible || eligible.has(b));
  if (bands.length === 0) return null;
  const total = STAKE_BANDS.reduce((n, b) => n + (seatsByBand[b] ?? 0), 0);
  if (total === 0) return bands[0];
  let best: StakeBand | null = null;
  let largestDeficit = -Infinity;
  bands.forEach((b) => {
    if (STAKE_MIX[b] <= 0) return;
    const deficit = STAKE_MIX[b] - (seatsByBand[b] ?? 0) / total;
    if (deficit > largestDeficit) {
      largestDeficit = deficit;
      best = b;
    }
  });
  return best ?? bands[0];
}

/** An empty per-band seat tally. One helper so a new band cannot be
 *  forgotten at one of the call sites that counts seats. */
export function emptyBandSeats(): Record<StakeBand, number> {
  return { micro: 0, low: 0, mid: 0, high: 0 };
}

/* ------------------------------------------------------------------ */
/* Section 6 - exotics                                                 */
/* ------------------------------------------------------------------ */

/** The exotic set is ENUMERATED by the OPORD: Pineapple, Short Deck, PLO8o.
 *  A variant that is not in this map is not exotic and is not trimmed.
 *  That is why flh and flo8 (fixed-limit Hold'em and fixed-limit Omaha 8,
 *  ~20 live tables) are untouched - inventing a fourth exotic would be
 *  exactly the failure CLAUDE.md 10.5 records. */
const EXOTIC_ALIASES: Record<string, string> = {
  PINEAPPLE: 'pineapple',
  PINE: 'pineapple',
  SHORT_DECK: 'short_deck',
  SHORTDECK: 'short_deck',
  SIX_PLUS: 'short_deck',
  '6PLUS': 'short_deck',
  '6+': 'short_deck',
  PLO8O: 'plo8',
  PLO8: 'plo8',
  PLO_8: 'plo8',
  OMAHA8: 'plo8',
  OMAHA_HILO: 'plo8',
  '8OB': 'plo8',
};

/** Explicitly NOT exotic - never mass-close these. */
const NON_EXOTIC = new Set(['nlh', 'nlhe', 'plo', 'plo4', 'plo5', 'plo6']);

/* LIMIT GAMES - Dan 2026-09-04: "OMAHA 8 IS PLO8o. and we should have a
   handful of limit games open and available."

   Two rulings in one sentence, and they pull in opposite directions unless
   the cap is read carefully:

   1. `flo8` (Fixed Limit Omaha 8-or-better) IS Omaha 8, so it belongs to the
      PLO8o exotic family and inherits the exotic ceiling: never above 1/2.
   2. Limit games must nonetheless stay OPEN AND AVAILABLE, so they cannot be
      folded into `plo8`'s cap of 2 - the pot-limit tables would consume the
      whole allowance and the fixed-limit floor would go dark, which is the
      opposite of what was asked.

   So each limit variant carries its OWN cap of 2 and its own floor of 1.
   Across two variants and two hosts that is up to 8 limit tables with at
   least 2 always lit: a handful, open, and available. */
export const LIMIT_VARIANTS = new Set(['flh', 'flo8']);
export const LIMIT_MAX_TABLES_PER_VARIANT = 2;
export const LIMIT_MIN_TABLES_PER_VARIANT = 1;

export function isLimitGame(variant: string): boolean {
  return LIMIT_VARIANTS.has((variant || '').trim().toLowerCase());
}

/** `flo8` is Omaha 8 and therefore of the PLO8o family, which is what earns
 *  it the <= 1/2 ceiling. It is still capped separately - see above. */
export function isOmahaEightFamily(variant: string): boolean {
  const v = (variant || '').trim().toLowerCase();
  return v === 'flo8' || canonicalExotic(variant) === 'plo8';
}

export function canonicalExotic(variant: string): string | null {
  if (!variant) return null;
  const raw = variant.trim();
  if (NON_EXOTIC.has(raw.toLowerCase())) return null;
  const hit = EXOTIC_ALIASES[raw.toUpperCase().replace(/[\s-]/g, '_')];
  return hit ?? null;
}

export function isExotic(variant: string): boolean {
  return canonicalExotic(variant) !== null;
}

export const EXOTIC_MAX_TABLES_PER_VARIANT = 2;
export const EXOTIC_MAX_BB = 2; // 1/2
export const EXOTIC_AUTOSPAWN_ABOVE_12 = false;

export interface ExoticTable {
  tableId: string;
  variant: string;
  bb: number;
  seated: number;
}

export interface ExoticPlan {
  close: string[];
  keep: string[];
  /** May open this many new tables of the variant, at <= 1/2. */
  mayOpen: number;
  doNotAutoReopen: string[];
}

/**
 * Section 6. Per host, per variant. Closes everything above 1/2 outright,
 * then trims to 2, fewest-seated first so the fewest hands are disturbed.
 */
export function planExoticTrim(tables: ExoticTable[], taggedLegalHorses: number): ExoticPlan {
  const close: string[] = [];
  const doNotAutoReopen: string[] = [];

  const legal = tables.filter((t) => {
    if (t.bb > EXOTIC_MAX_BB) {
      close.push(t.tableId);
      doNotAutoReopen.push(t.tableId);
      return false;
    }
    return true;
  });

  legal.sort((a, b) => a.seated - b.seated || a.tableId.localeCompare(b.tableId));
  while (legal.length > EXOTIC_MAX_TABLES_PER_VARIANT) {
    const victim = legal.shift();
    if (victim) close.push(victim.tableId);
  }

  const keep = legal.map((t) => t.tableId);
  // Section 6: "If tagged legal horses < 4, leave 0." That rule is absolute -
  // it gates ALL opening, not just the empty-floor case. Opening a table for
  // three horses produces the one-player table Section 5.2 forbids listing.
  const mayOpen =
    taggedLegalHorses < 4 ? 0 : Math.max(0, EXOTIC_MAX_TABLES_PER_VARIANT - keep.length);

  return { close, keep, mayOpen, doNotAutoReopen };
}

/** Two tables of one exotic variant are shaped 1 FULL, 1 ONE_OPEN. */
export function exoticShape(count: number): ShapeTargets {
  if (count <= 0) return { n: 0, full: 0, oneOpen: 0, joinable: 0 };
  if (count === 1) return { n: 1, full: 1, oneOpen: 0, joinable: 0 };
  return { n: 2, full: 1, oneOpen: 1, joinable: 0 };
}

/* ------------------------------------------------------------------ */
/* Section 7 - tags                                                    */
/* ------------------------------------------------------------------ */

export type HorseMode = 'cash' | 'tourney' | 'both';
export type CashPersona = 'grinder' | 'regular' | 'mixer' | 'night_owl' | 'weekend_heavy';
export type MttPersona = 'mtt_grinder' | 'mtt_regular' | 'mtt_late_reg';

export const CASH_PERSONA_MIX: Array<[CashPersona, number]> = [
  ['grinder', 0.18],
  ['regular', 0.45],
  ['mixer', 0.22],
  ['night_owl', 0.08],
  ['weekend_heavy', 0.07],
];

export const MTT_PERSONA_MIX: Array<[MttPersona, number]> = [
  ['mtt_grinder', 0.3],
  ['mtt_regular', 0.5],
  ['mtt_late_reg', 0.2],
];

/**
 * A HORSE PLAYS FOUR TABLES (Dan 2026-09-02, verbatim: "THEY SHOULD BE PLAYING
 * 4 TABLES AT ONCE"). This table used to hand grinders 4, regulars and weekend
 * players 3, mixers and night owls 2 - a texture nobody asked for that tagged
 * 837 of 1,000 horses BELOW the number Dan set, and the sit verdict then
 * refused them a third or fourth chair (`sit_cap`) while feeders opened on the
 * strength of their count and were abandoned empty. Measured 2026-09-06: 175
 * horses seated at cash, 1.66 tables each, two at four.
 *
 * The persona still shapes WHEN a horse plays (its day, its cap, its session
 * jitter) and HOW it buys in; it no longer shapes how many tables it may hold.
 * Every cash-mode persona is the platform ceiling. Migration
 * 20260906144448 brought the live tags to the same value.
 */
export const MAX_TABLES_BY_PERSONA: Record<CashPersona, number> = {
  grinder: 4,
  regular: 4,
  mixer: 4,
  night_owl: 4,
  weekend_heavy: 4,
};
/** A tourney-only horse holds one MTT slot and never a second table. */
export const MAX_TABLES_TOURNEY_ONLY = 1;

/** Daily cap ranges. The midpoint is stored so the value is sticky and
 *  reproducible; jitter belongs on session start/end, not on the cap. */
const DAILY_CAP_RANGE: Record<CashPersona, [number, number]> = {
  grinder: [600, 720],
  regular: [480, 570],
  mixer: [480, 540],
  night_owl: [480, 540],
  weekend_heavy: [600, 720], // Fri-Sun; other days handled below
};
const WEEKEND_HEAVY_OFFDAY: [number, number] = [300, 420];

export function dailyCapMinutes(persona: CashPersona, weekday: number): number {
  if (persona === 'weekend_heavy') {
    const isWeekend = weekday === 5 || weekday === 6 || weekday === 0; // Fri, Sat, Sun
    const [lo, hi] = isWeekend ? DAILY_CAP_RANGE.weekend_heavy : WEEKEND_HEAVY_OFFDAY;
    return Math.round((lo + hi) / 2);
  }
  const [lo, hi] = DAILY_CAP_RANGE[persona];
  return Math.round((lo + hi) / 2);
}

/**
 * Cumulative-floor allocation. Assigning by cumulative floors rather than
 * per-item rounding keeps every bucket within 1 of its target, which is what
 * T8 asserts.
 */
export function allocateByMix<T extends string>(
  total: number,
  mix: Array<[T, number]>
): Array<{ key: T; count: number }> {
  const out: Array<{ key: T; count: number }> = [];
  let cumPct = 0;
  let assigned = 0;
  mix.forEach(([key, pct], i) => {
    cumPct += pct;
    const upto = i === mix.length - 1 ? total : Math.floor(cumPct * total);
    const count = Math.max(0, upto - assigned);
    assigned += count;
    out.push({ key, count });
  });
  return out;
}

/** Deterministic membership ordering: sha256(club_id || horse_id || seed). */
export function tagOrder(
  memberships: Array<{ horseId: string; clubId: string }>,
  seed = STABLE_HAND_SEED
): Array<{ horseId: string; clubId: string; digest: string }> {
  return memberships
    .map((m) => ({ ...m, digest: shDigest(m.clubId, m.horseId, seed) }))
    .sort((a, b) => a.digest.localeCompare(b.digest));
}

export interface MembershipTag {
  horseId: string;
  clubId: string;
  mode: HorseMode;
  cashFreeroll: boolean;
  personaCash: CashPersona | null;
  personaMtt: MttPersona | null;
  maxTables: number;
  tagSeed: string;
}

/**
 * Section 7.2. Deterministic, idempotent: the same input always produces the
 * same tags, so re-running the tagger without --force is a no-op.
 */
export function assignTags(
  memberships: Array<{ horseId: string; clubId: string }>,
  seed = STABLE_HAND_SEED
): MembershipTag[] {
  const ordered = tagOrder(memberships, seed);
  const n = ordered.length;
  const split = tagSplit(n);

  const modes: HorseMode[] = ordered.map((_, i) => {
    if (i < split.cash) return 'cash';
    if (i < split.cash + split.tourney) return 'tourney';
    return 'both';
  });

  // cash_freeroll: the first 15% of the CASH-ONLY horses in the same order.
  const cashOnlyIdx = modes.map((m, i) => (m === 'cash' ? i : -1)).filter((i) => i >= 0);
  const freerollIdx = new Set(cashOnlyIdx.slice(0, split.cashFreeroll));

  // Cash personas cover cash + both, in the same ordering.
  const cashEligible = modes.map((m, i) => (m !== 'tourney' ? i : -1)).filter((i) => i >= 0);
  const cashAlloc = allocateByMix(cashEligible.length, CASH_PERSONA_MIX);
  const personaCash = new Map<number, CashPersona>();
  let c = 0;
  cashAlloc.forEach(({ key, count }) => {
    for (let k = 0; k < count; k++) personaCash.set(cashEligible[c++], key);
  });

  // MTT personas cover tourney + both.
  const mttEligible = modes.map((m, i) => (m !== 'cash' ? i : -1)).filter((i) => i >= 0);
  const mttAlloc = allocateByMix(mttEligible.length, MTT_PERSONA_MIX);
  const personaMtt = new Map<number, MttPersona>();
  let t = 0;
  mttAlloc.forEach(({ key, count }) => {
    for (let k = 0; k < count; k++) personaMtt.set(mttEligible[t++], key);
  });

  return ordered.map((m, i) => {
    const mode = modes[i];
    const pc = personaCash.get(i) ?? null;
    const pm = personaMtt.get(i) ?? null;
    return {
      horseId: m.horseId,
      clubId: m.clubId,
      mode,
      cashFreeroll: freerollIdx.has(i),
      personaCash: pc,
      personaMtt: pm,
      maxTables:
        mode === 'tourney' ? MAX_TABLES_TOURNEY_ONLY : MAX_TABLES_BY_PERSONA[pc ?? 'regular'],
      tagSeed: seed,
    };
  });
}

/** Rest weekday: index in the unique-horse ordering modulo 7. Sticky - never
 *  overwrite one that is already set. */
export function restWeekdayFor(index: number): number {
  return index % 7;
}

/** Session start/end jitter, +/-20-45 min, hash-derived so a test can assert
 *  it without stubbing a clock. */
export function sessionJitterMinutes(horseId: string, which: 'start' | 'end'): number {
  const h = shHash(horseId, which, STABLE_HAND_SEED);
  const magnitude = 20 + (h % 26); // 20..45
  return h % 2 === 0 ? magnitude : -magnitude;
}

/* ------------------------------------------------------------------ */
/* Section 8 - bankroll                                                */
/* ------------------------------------------------------------------ */

export const BUYINS_TO_LICENSE = 20;
export const BUYINS_TO_STEP_UP = 30;
export const BUYINS_TO_STEP_DOWN = 15;
export const COMMIT_FRACTION = 0.5;
export const STEP_UP_CONSECUTIVE_DAYS = 3;

export function bi100(bb: number): number {
  return 100 * bb;
}

/* SECTION 8.1 IS RETIRED. Dan 2026-09-04: "YOU CAN IGNORE THE 10,000 SEED,
   AND USE THEIR CURRENT BALANCES."

   There is deliberately NO seeding function in this module, and that absence
   is load-bearing. Recon measured every horse wallet already funded (min
   7,420 on DSS, 25,000 on Midway Union), so a seed would only ever have
   OVERWRITTEN a real balance. A wallet's bankroll is whatever the wallet
   currently holds; `availableOf` is the only thing that adjusts it, and it
   subtracts, never adds. Nothing in Stable Hand creates chips. */

/** Section 8.2. Chips already on the felt out of THIS wallet are not
 *  available to sit again. */
export function availableOf(balance: number, chipsOnOpenTables: number): number {
  return balance - chipsOnOpenTables;
}

/**
 * Section 8.3, as Dan ruled it on 2026-09-05: THE BANKROLL IS THE WHOLE RULE.
 *
 * This function used to check a phase clamp FIRST and refuse a wallet rich
 * enough for 2/5 anyway. There is no clamp. Twenty buy-ins of the game is
 * what licenses a horse to sit in it, at every rung of the ladder, and that
 * is the only thing this asks.
 */
export function isLicensed(available: number, bb: number): boolean {
  return available >= BUYINS_TO_LICENSE * bi100(bb);
}

/**
 * The buy-ins a horse must hold behind a stake before it may be TAGGED for
 * it - the same bar the seat gate applies, so a tag can never name a stake
 * the gate would then refuse.
 *
 * Two rules guard a seat and they are not the same number: `isLicensed` here
 * wants BUYINS_TO_LICENSE (20), and HorseBankroll's `canSit` wants the
 * horse's own temperament (a nit 40, a standard 25, a gambler 12). A horse
 * passes a seat only if BOTH say yes, so the tag takes the higher of them.
 * Pass the horse's `buyInsToSit` from `bankrollPolicyFor(horseId)`; omit it
 * and the licence bar alone applies.
 */
export function buyInsRequiredFor(buyInsToSit?: number): number {
  return Math.max(
    BUYINS_TO_LICENSE,
    Number.isFinite(buyInsToSit as number) ? (buyInsToSit as number) : 0
  );
}

/** May a roll of `available` chips play this stake at all? */
export function rollSupportsStake(available: number, bb: number, buyInsToSit?: number): boolean {
  if (!(bb > 0)) return false;
  return available >= buyInsRequiredFor(buyInsToSit) * bi100(bb);
}

/**
 * The biggest ladder rung this roll supports, or null when it supports none.
 *
 * This is the ceiling Dan described: a horse plays the stake its bankroll
 * supports, and nothing above it. It is a CEILING, never a floor - a rich
 * horse is not forced up a ladder it did not draw into.
 */
export function highestStakeSupported(available: number, buyInsToSit?: number): number | null {
  for (let i = STAKE_LADDER.length - 1; i >= 0; i--) {
    if (rollSupportsStake(available, STAKE_LADDER[i].bb, buyInsToSit)) return STAKE_LADDER[i].bb;
  }
  return null;
}

/** The band of the biggest rung this roll supports; null when it supports
 *  nothing on the ladder at all. */
export function highestBandSupported(available: number, buyInsToSit?: number): StakeBand | null {
  const bb = highestStakeSupported(available, buyInsToSit);
  return bb === null ? null : stakeBandOf(bb);
}

/** Section 8.4. Cap measured against the SESSION START balance, so winning
 *  mid-session does not raise it and losing does not retroactively void a
 *  second table that already passed at sit time. */
export function commitAllows(
  sessionStartBalance: number,
  currentCommit: number,
  newBuyIn: number
): boolean {
  return currentCommit + newBuyIn <= COMMIT_FRACTION * sessionStartBalance;
}

export interface BuyInRequest {
  available: number;
  bb: number;
  persona: CashPersona;
  openSeats: number;
  minBuyInBb?: number;
  maxBuyInBb?: number;
}

/**
 * Section 8.5. Default 100bb; 200bb only for a grinder with 30 buy-ins and
 * at most 2 tables open; 40bb as the last rung before dropping a stake.
 * Returns null when the horse should step down instead of sitting.
 */
export function buyInFor(req: BuyInRequest): number | null {
  const { available, bb, persona, openSeats } = req;
  const minBb = req.minBuyInBb ?? 40;
  const maxBb = req.maxBuyInBb ?? 200;
  if (!isLicensed(available, bb)) return null;

  const wants200 =
    persona === 'grinder' && available >= BUYINS_TO_STEP_UP * bi100(bb) && openSeats <= 2;
  if (wants200 && maxBb >= 200) return 200 * bb;

  if (available >= bi100(bb) && minBb <= 100 && maxBb >= 100) return 100 * bb;
  if (available >= 40 * bb && minBb <= 40) return 40 * bb;
  return null;
}

export function shouldStepDown(available: number, currentBb: number): boolean {
  return available < BUYINS_TO_STEP_DOWN * bi100(currentBb);
}

export function mayStepUp(
  available: number,
  nextBb: number,
  consecutiveQualifyingDays: number
): boolean {
  /* The ONLY ceiling: the ladder's own top rung. There is no rung above
     25/50 to step up into, so a request to is a request to play a game the
     platform does not deal. Everything below it is decided by the roll. */
  if (!stakeIsWithinLadder(nextBb)) return false;
  return (
    available >= BUYINS_TO_STEP_UP * bi100(nextBb) &&
    consecutiveQualifyingDays >= STEP_UP_CONSECUTIVE_DAYS
  );
}

/** Section 8.7. A horse may spread across a stake and the ONE adjacent legal
 *  stake, never 1/2 alongside 0.01/0.02. */
export function stakeSpreadAllowed(bbA: number, bbB: number): boolean {
  const ia = STAKE_LADDER.findIndex((s) => s.bb === bbA);
  const ib = STAKE_LADDER.findIndex((s) => s.bb === bbB);
  if (ia < 0 || ib < 0) return false;
  return Math.abs(ia - ib) <= 1;
}

/** Section 8.8. Broke = cannot make 40bb at the cheapest stake. Repair is
 *  rakeback and awards only - never a grant. */
export function isBroke(available: number): boolean {
  const cheapest = STAKE_LADDER[0].bb;
  return available < 40 * cheapest;
}
export function isRepaired(available: number): boolean {
  return available >= BUYINS_TO_LICENSE * bi100(STAKE_LADDER[0].bb);
}

export const MAX_INSEAT_REBUYS = 3;

export function mayRebuyInSeat(opts: {
  stackBb: number;
  available: number;
  bb: number;
  rebuysTaken: number;
  sessionStartBalance: number;
  currentCommit: number;
  rebuyAmount: number;
  inTwoHourWindow: boolean;
}): boolean {
  if (opts.stackBb >= 40) return false;
  if (opts.rebuysTaken >= MAX_INSEAT_REBUYS) return false;
  if (opts.inTwoHourWindow) return false;
  if (!isLicensed(opts.available - opts.rebuyAmount, opts.bb)) return false;
  return commitAllows(opts.sessionStartBalance, opts.currentCommit, opts.rebuyAmount);
}

/* ------------------------------------------------------------------ */
/* Section 9 - booking and leaving                                     */
/* ------------------------------------------------------------------ */

export const STAY_UP_MS = 10 * 60 * 1000;
export const TWO_HOUR_WINDOW_MS = 2 * 60 * 60 * 1000;
export const STOP_LOSS_BI = -2.0;

export const BOOK_LINE_BI: Record<CashPersona, number> = {
  mixer: 1.5,
  night_owl: 2.0,
  regular: 2.5,
  weekend_heavy: 2.5,
  grinder: 3.0,
};

export const COLOR_UP_MULTIPLE: Record<CashPersona, number> = {
  mixer: 2.5,
  night_owl: 2.5,
  regular: 3.0,
  weekend_heavy: 3.0,
  grinder: 3.5,
};

export type LeaveReason =
  | 'stop_loss'
  | 'color_up'
  | 'session_done'
  | 'daily_cap'
  | 'wind_down'
  | 'step_down'
  | 'rest_day'
  | 'rebuys_exhausted'
  | 'table_closing'
  | 'human_yield'
  | 'shape_adjust'
  | 'book_win';

/** Reasons that ignore the stay-up hold. Stop-loss protects the wallet;
 *  human_yield protects the human. Nothing else jumps the queue. */
const STAY_UP_EXEMPT: ReadonlySet<LeaveReason> = new Set<LeaveReason>(['stop_loss', 'human_yield']);

export function stayUpSatisfied(opts: {
  msAtTable: number;
  pnl: number;
  reason: LeaveReason;
}): boolean {
  if (STAY_UP_EXEMPT.has(opts.reason)) return true;
  if (opts.pnl <= 0) return true; // stay-up only holds a WINNER
  return opts.msAtTable >= STAY_UP_MS;
}

/** Section 9.1. A voluntary book needs green, a completed stay-up, and the
 *  persona's line. +0.2 BI after 8 minutes is not a book. */
export function mayBookWin(opts: {
  persona: CashPersona;
  pnlBi: number;
  msAtTable: number;
}): boolean {
  if (opts.pnlBi <= 0) return false;
  if (!stayUpSatisfied({ msAtTable: opts.msAtTable, pnl: opts.pnlBi, reason: 'book_win' }))
    return false;
  return opts.pnlBi >= BOOK_LINE_BI[opts.persona];
}

export function mustColorUp(opts: {
  persona: CashPersona;
  stack: number;
  sitInBuyIn: number;
}): boolean {
  if (!(opts.sitInBuyIn > 0)) return false;
  return opts.stack >= COLOR_UP_MULTIPLE[opts.persona] * opts.sitInBuyIn;
}

/** Section 9.2 force-leave ladder, in the OPORD's priority order. Returns the
 *  first reason that fires, or null. */
export function forceLeaveReason(s: {
  persona: CashPersona;
  pnlBi: number;
  stack: number;
  sitInBuyIn: number;
  minutesInSeat: number;
  /** Planned length of THIS seat session, 90-240 min (Section 9.2 item 3). */
  sessionPlanMinutes: number;
  minutesPlayedToday: number;
  dailyCapMinutes: number;
  windingDown: boolean;
  available: number;
  bb: number;
  isRestDayBoundary: boolean;
  rebuysTaken: number;
  stackBb: number;
  tableClosing: boolean;
  humanYieldDue: boolean;
  shapeAdjust: boolean;
}): LeaveReason | null {
  if (s.pnlBi <= STOP_LOSS_BI) return 'stop_loss';
  if (mustColorUp({ persona: s.persona, stack: s.stack, sitInBuyIn: s.sitInBuyIn }))
    return 'color_up';
  if (s.minutesInSeat >= s.sessionPlanMinutes) return 'session_done';
  if (s.minutesPlayedToday >= s.dailyCapMinutes) return 'daily_cap';
  if (s.windingDown) return 'wind_down';
  if (shouldStepDown(s.available, s.bb)) return 'step_down';
  if (s.isRestDayBoundary) return 'rest_day';
  if (s.rebuysTaken >= MAX_INSEAT_REBUYS && s.stackBb < 40) return 'rebuys_exhausted';
  if (s.tableClosing) return 'table_closing';
  if (s.humanYieldDue) return 'human_yield';
  if (s.shapeAdjust) return 'shape_adjust';
  return null;
}

/** Reasons under which booking a SMALL win is legitimate. Everything else
 *  must clear the persona line. */
export const SMALL_WIN_OK: ReadonlySet<LeaveReason> = new Set<LeaveReason>([
  'session_done',
  'daily_cap',
  'wind_down',
  'rest_day',
]);

/** Section 9.3. One table at a time, biggest winner first, staggered 5-12 min
 *  from a stable hash so three winners never stand on the same tick. */
export function bookStaggerMs(horseId: string, tableId: string): number {
  const h = shHash(horseId, tableId, 'book-stagger');
  return (5 + (h % 8)) * 60 * 1000; // 5..12 min
}

/* ------------------------------------------------------------------ */
/* Section 5.5 - human yield                                           */
/* ------------------------------------------------------------------ */

export const YIELD_MIN_MS = 120_000;
export const YIELD_SPAN_MS = 180_001; // the MODULUS: delays run 2:00 - 5:00 inclusive
export const SEAT_HOLD_MS = 90_000;

export function yieldDelayMs(horseId: string, tableId: string, waitlistId: string): number {
  return YIELD_MIN_MS + (shHash(horseId, tableId, waitlistId) % YIELD_SPAN_MS);
}

/** Section 5.5. One human never empties a table: at most humans_waiting + 1. */
export function yieldCount(humansWaiting: number): number {
  return humansWaiting > 0 ? humansWaiting + 1 : 0;
}

export interface YieldCandidate {
  horseId: string;
  sittingOut: boolean;
  minutesAtTable: number;
  isRed: boolean;
  stack: number;
}

/** Selection order: sitting out, then shortest time at table, then red before
 *  green, then smallest stack. */
export function pickYieldVictims(cands: YieldCandidate[], count: number): string[] {
  return [...cands]
    .sort(
      (a, b) =>
        Number(b.sittingOut) - Number(a.sittingOut) ||
        a.minutesAtTable - b.minutesAtTable ||
        Number(b.isRed) - Number(a.isRed) ||
        a.stack - b.stack ||
        a.horseId.localeCompare(b.horseId)
    )
    .slice(0, Math.max(0, count))
    .map((c) => c.horseId);
}

/* ------------------------------------------------------------------ */
/* Section 10 - entry caps                                             */
/* ------------------------------------------------------------------ */

export function gameKey(p: {
  hostId: string;
  template: string;
  variant: string;
  sb: number;
  bb: number;
}): string {
  return [p.hostId, p.template, p.variant, p.sb, p.bb].join(':');
}

export const SITS_PER_KEY_PER_DAY: Record<CashPersona, number> = {
  grinder: 5,
  regular: 4,
  weekend_heavy: 4,
  mixer: 3,
  night_owl: 3,
};

export function maySitOnKey(persona: CashPersona | null, sitsToday: number): boolean {
  if (!persona) return false; // tourney-only takes no cash sits
  return sitsToday < SITS_PER_KEY_PER_DAY[persona];
}

export const MTT_PAID_BULLET_CAP = 3;

export function mttBulletsAllowed(opts: {
  eventMax: number;
  isFreeroll: boolean;
  allowsReentry: boolean;
}): number {
  if (opts.isFreeroll) return Math.min(opts.eventMax, 3);
  if (!opts.allowsReentry) return 1;
  return Math.min(MTT_PAID_BULLET_CAP, 1 + 2);
}

/** Section 10. An add-on is taken whenever the horse is alive, the event has
 *  one, and the fee is payable. The only legal skips are enumerated. */
export type AddOnSkip = 'busted' | 'cannot_pay' | 'no_addon' | 'late_reg_window_closed';

export function addOnDecision(opts: {
  alive: boolean;
  hasAddOn: boolean;
  fee: number;
  available: number;
  lateRegWindowOpen: boolean;
}): { take: boolean; skip?: AddOnSkip } {
  if (!opts.alive) return { take: false, skip: 'busted' };
  if (!opts.hasAddOn) return { take: false, skip: 'no_addon' };
  if (!opts.lateRegWindowOpen) return { take: false, skip: 'late_reg_window_closed' };
  if (opts.fee > opts.available) return { take: false, skip: 'cannot_pay' };
  return { take: true };
}

/** Late-reg timing by persona, as a fraction of the late-reg window. */
export function lateRegFraction(persona: MttPersona): number {
  if (persona === 'mtt_grinder') return 0.05;
  if (persona === 'mtt_regular') return 0.45;
  return 0.75; // mtt_late_reg enters in the last 30%
}

/* ------------------------------------------------------------------ */
/* Section 11 - the mutex                                              */
/* ------------------------------------------------------------------ */

export type SitRejection =
  | 'ok'
  | 'other_club'
  | 'other_host'
  | 'seat_cap'
  | 'brm'
  | 'sit_cap'
  | 'bullet_cap'
  | 'stake_above_ladder_top'
  | 'rest_day'
  | 'two_hour_window'
  | 'killed';

export interface SitRequest {
  activeClubId: string | null;
  activeHostId: string | null;
  activeSeatCount: number;
  maxTables: number;
  clubId: string;
  tableHostId: string;
  bb: number;
  /**
   * The wallet's balance, or NULL when it could not be read.
   *
   * NULL IS NOT ZERO (2026-09-11). HorseSitVerdict fed this gate
   * `bankrolls.get(...) ?? 0`, so a bankroll read that failed - the map empty,
   * `bankrollsLoaded` false, every OTHER gate in the cycle failing open as the
   * 2026-08-31 doctrine requires - reached `isLicensed(0, bb)` here and
   * refused every tagged horse `brm`. The one gate that fails closed on an
   * unreadable roll is the one that empties the floor; see rollUnknownVerdict
   * below for the doctrine. An unknown roll gets no MONEY opinion and every
   * identity check still applies.
   */
  available: number | null;
  sessionStartBalance: number | null;
  currentCommit: number;
  buyIn: number;
  persona: CashPersona | null;
  sitsOnKeyToday: number;
  isRestDay: boolean;
  /**
   * Has this horse cashed out of THIS game key inside the last two hours?
   *
   * Section 9. The window opens when a horse leaves a key and stops it buying
   * straight back into the same game, which is what a reload looks like and
   * what a real player does not do. `two_hour_window` is written on every
   * cycle by the fleet's state fold and, until 2026-09-11, was read by nothing
   * at all: the column existed, the helper existed, the constant existed, and
   * the rule they were written for was never enforced anywhere. An audit found
   * it as "no live caller"; the answer to a rule with no reader is to give it
   * one, not to delete the rule.
   *
   * It sits with the identity checks rather than the money ones on purpose: it
   * is a statement about what this horse just did, not about what it can
   * afford, and it is knowable without a wallet read.
   */
  inTwoHourWindow: boolean;
  killed: boolean;
}

/**
 * Section 11. The single gate. Order matters: cheap identity checks first,
 * money last, so a rejected sit costs one comparison rather than a wallet
 * read. There is no fail-open branch on IDENTITY - a horse whose club, host,
 * seat count, persona or day is known is judged on them. The MONEY checks
 * are skipped only when the caller says the roll was not read (`available:
 * null`), which is the 2026-08-31 doctrine: solvency is the buy-in RPC's to
 * refuse, and a gate must never refuse on a number it did not measure.
 */
export function evaluateSit(r: SitRequest): SitRejection {
  if (r.killed) return 'killed';
  if (!sitIsLegalForHost(r.clubId, r.tableHostId)) return 'other_host';
  if (r.activeClubId && r.activeClubId !== r.clubId) return 'other_club';
  if (r.activeHostId && r.activeHostId !== r.tableHostId) return 'other_host';
  if (r.activeSeatCount >= Math.min(4, r.maxTables)) return 'seat_cap';
  /* THE ONLY STAKE CEILING LEFT (2026-09-05). This used to be the invented
     `PHASE_MAX_BB = 2` clamp, which refused 2/5 to a wallet that covered it
     and left every game above 1/2 on the platform empty. What remains is the
     ladder's top rung: a table above 25/50 is not a stake this platform
     deals. The bankroll decides everything below it, three lines down. */
  if (!stakeIsWithinLadder(r.bb)) return 'stake_above_ladder_top';
  if (r.isRestDay) return 'rest_day';
  if (r.inTwoHourWindow) return 'two_hour_window';
  if (!maySitOnKey(r.persona, r.sitsOnKeyToday)) return 'sit_cap';
  /* THE MONEY, LAST, AND ONLY WHEN IT WAS READ. `atomic_table_buyin` still
     refuses a seat the wallet cannot cover, so an unread roll is safe for the
     wallet; what it must not do is refuse on a number nobody measured. */
  if (r.available === null) return 'ok';
  if (!isLicensed(r.available, r.bb)) return 'brm';
  if (!commitAllows(r.sessionStartBalance ?? r.available, r.currentCommit, r.buyIn)) return 'brm';
  return 'ok';
}

/**
 * Wallet choice for an IDLE horse on a host that offers more than one wallet
 * (Midway Union: JAQK or Shark). The OPORD's "larger deficit" rule was written
 * for clubs that were separate occupancy buckets; they are not (see recon 2),
 * so the deficit that matters is the WALLET's own capacity to fund the sit.
 * Pick the licensed wallet with the most available, tie-broken by seat count
 * then by hash so the two wallets stay evenly used.
 */
export function pickWallet(
  candidates: Array<{ clubId: string; available: number; liveSeats: number }>,
  bb: number,
  horseId: string
): string | null {
  const legal = candidates.filter((c) => isLicensed(c.available, bb));
  if (legal.length === 0) return null;
  legal.sort(
    (a, b) =>
      b.available - a.available ||
      a.liveSeats - b.liveSeats ||
      shHash(horseId, a.clubId).toString().localeCompare(shHash(horseId, b.clubId).toString())
  );
  return legal[0].clubId;
}

/* ------------------------------------------------------------------ */
/* Section 12 - freerolls                                              */
/* ------------------------------------------------------------------ */

export const FREEROLL_CADENCE_HOURS = 4;

export function freerollEligible(t: { mode: HorseMode; cashFreeroll: boolean }): boolean {
  if (t.mode === 'tourney' || t.mode === 'both') return true;
  return t.mode === 'cash' && t.cashFreeroll;
}

export const FREEROLL_JUMP_RATE: Record<MttPersona, number> = {
  mtt_grinder: 0.55,
  mtt_regular: 0.3,
  mtt_late_reg: 0.2,
};
export const FREEROLL_JUMP_CAP_FRACTION = 0.2;

/** Deterministic per-horse jump decision, so the same tick does not produce a
 *  different field each time it is evaluated. */
export function willJumpToFreeroll(opts: {
  horseId: string;
  eventId: string;
  persona: MttPersona;
  needsRepair: boolean;
}): boolean {
  if (opts.needsRepair) return true; // broke-or-short and eligible: always
  const rate = FREEROLL_JUMP_RATE[opts.persona];
  return shHash(opts.horseId, opts.eventId, 'freeroll-jump') % 1000 < Math.round(rate * 1000);
}

export function freerollJumpCap(seatedBothHorses: number): number {
  return Math.floor(FREEROLL_JUMP_CAP_FRACTION * seatedBothHorses);
}

/* ------------------------------------------------------------------ */
/* Section 0 / 15 - flags                                              */
/* ------------------------------------------------------------------ */

/** House pattern: env var read inline, default ON, pinned by a law test. */
export function controllerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STABLE_HAND_CONTROLLER !== 'false';
}

/** The kill switch stops NEW sits and add-seats. Hands finish. Human yield
 *  still runs - a kill switch that strands a waiting human is not a safety
 *  feature, it is a second outage. */
export function killed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STABLE_HAND_KILL === 'true';
}

export function killAllowsAction(action: 'sit' | 'add_seat' | 'yield' | 'finish_hand'): boolean {
  return action === 'yield' || action === 'finish_hand';
}

/** Section 9.2 item 3. A seat session runs 90-240 minutes, chosen from a
 *  stable hash of the horse and table so it is reproducible in a test and
 *  does not change if the tick re-evaluates the same seat. */
export function sessionPlanMinutes(horseId: string, tableId: string): number {
  return 90 + (shHash(horseId, tableId, 'session-plan') % 151); // 90..240
}

/* ------------------------------------------------------------------ */
/* Limit games (Dan 2026-09-04)                                        */
/* ------------------------------------------------------------------ */

export interface LimitPlan {
  close: string[];
  keep: string[];
  /** Open this many so the limit floor is never dark. */
  mayOpen: number;
}

/**
 * Keeps a handful of limit tables lit. Same <= 1/2 ceiling as the exotics
 * (flo8 is Omaha 8), same fewest-seated-first trim, but its own cap and a
 * FLOOR: if a limit variant has no legal table and there are horses to seat,
 * one is opened. "Available" has to mean a player can actually find one.
 */
export function planLimitGames(tables: ExoticTable[], taggedLegalHorses: number): LimitPlan {
  const close: string[] = [];
  const legal = tables.filter((t) => {
    if (t.bb > EXOTIC_MAX_BB) {
      close.push(t.tableId);
      return false;
    }
    return true;
  });

  legal.sort((a, b) => a.seated - b.seated || a.tableId.localeCompare(b.tableId));
  while (legal.length > LIMIT_MAX_TABLES_PER_VARIANT) {
    const victim = legal.shift();
    if (victim) close.push(victim.tableId);
  }

  const keep = legal.map((t) => t.tableId);
  const mayOpen =
    taggedLegalHorses < 4
      ? 0
      : Math.max(0, Math.max(LIMIT_MIN_TABLES_PER_VARIANT, keep.length) - keep.length);

  return { close, keep, mayOpen };
}

/* ------------------------------------------------------------------ */
/* The bankroll-unknown policy (the 2026-08-31 incident, revisited)    */
/* ------------------------------------------------------------------ */

export type RollUnknownVerdict = 'allow_no_opinion' | 'refuse_not_a_member';

/**
 * WHAT TO DO WHEN A HORSE'S ROLL CANNOT BE READ.
 *
 * On 2026-08-31 this decision was `return false` ("no membership, no seat")
 * and it emptied the entire cash floor for 40 minutes, because the bankroll
 * map was keyed on two club ids that own zero cash tables so EVERY lookup
 * missed. The fix was to fail open, and the reasoning written into
 * HorseFleetManager is sound: `atomic_table_buyin` still refuses a seat the
 * balance cannot cover, so that gate decides which games are SENSIBLE, never
 * which are POSSIBLE.
 *
 * That reasoning covers SOLVENCY and nothing else. `atomic_table_buyin` does
 * not know about the 20-buy-in licence, the 50% session commit cap, the
 * <= 1/2 phase clamp, the per-key daily sit cap, or one-body-one-club. So an
 * unknown roll is safe for the wallet and wide open for every Stable Hand
 * rule, which is why `evaluateSit` has no fail-open branch of its own.
 *
 * The one refinement here: distinguish the two unknowns.
 *
 *   - The whole map failed to load  -> NO OPINION. Fail open, exactly as
 *     today. A database hiccup must never empty the floor again.
 *   - The map loaded, but it holds NO rows at all for the club that funds
 *     this table -> NO OPINION, fail open. This is the 2026-08-31 shape
 *     exactly: the load "succeeded" while being keyed on clubs that own no
 *     cash tables, so every lookup missed and refusing emptied the floor.
 *     "The load completed" is therefore NOT sufficient evidence on its own,
 *     and a version of this policy that checked only that flag would have
 *     re-run the incident.
 *   - The map loaded AND covers this club AND this horse is still absent ->
 *     the horse genuinely is not a member of the funding wallet, so
 *     `atomic_table_buyin` would refuse it anyway. Refuse here, cheaply.
 *
 * Only the third case is a real refusal, and club coverage is the fact that
 * separates it from the outage.
 *
 * DELIBERATELY NOT WIRED INTO HorseFleetManager. I wired it there first and
 * two existing guards stopped me, correctly:
 * HorseBankrollGateClubs.test.ts ("a missing membership row never refuses a
 * seat") and HorseBankrollTelemetry.test.ts, which pins the literal source
 * shape of that branch so nobody can turn the fail-open back into a refusal.
 * They are right and the change was wrong: `resolveSeatClub` already refuses
 * a horse belonging to none of a table's eligible clubs, and zero of 1,903
 * horse memberships carry a null chip_balance, so the branch is UNREACHABLE.
 * Weakening a guard that exists because of a 40-minute outage, to harden a
 * path that cannot currently execute, is a bad trade. The live gate is left
 * exactly as it is.
 *
 * This policy is kept because Stable Hand's OWN seat path needs it: that path
 * enforces the licence, the commit cap, the phase clamp and the sit caps -
 * none of which `atomic_table_buyin` can see - so it cannot inherit the
 * fleet's "the RPC will catch it" reasoning. `evaluateSit` has no fail-open
 * branch for exactly that reason, and this function is how the Stable Hand
 * controller decides whether it is even entitled to an opinion.
 */
export function rollUnknownVerdict(
  mapLoadedSuccessfully: boolean,
  clubHasAnyRolls: boolean
): RollUnknownVerdict {
  if (!mapLoadedSuccessfully) return 'allow_no_opinion';
  if (!clubHasAnyRolls) return 'allow_no_opinion';
  return 'refuse_not_a_member';
}

/** True when the fleet may seat despite having no bankroll reading. */
export function maySeatWithUnknownRoll(
  mapLoadedSuccessfully: boolean,
  clubHasAnyRolls: boolean
): boolean {
  return rollUnknownVerdict(mapLoadedSuccessfully, clubHasAnyRolls) === 'allow_no_opinion';
}

/* ------------------------------------------------------------------ */
/* Section 7.2 - variants and preferred stakes                         */
/* ------------------------------------------------------------------ */

/** Coverage targets. The OPORD states these as ">=" floors and they overlap,
 *  which is why they sum past 100%: a horse carries 1-3 variants.
 *
 *  flh and flo8 are here and are NOT in the OPORD's list. Dan 2026-09-04:
 *  "we should have a handful of limit games open and available." A table
 *  nobody is tagged for can never be seated, so keeping the limit floor lit
 *  requires a tagged population to seat it. 8% of the cash fleet each is
 *  enough to hold two tables per variant per host without pulling meaningful
 *  numbers off the no-limit games. */
export const VARIANT_COVERAGE: Array<[string, number]> = [
  ['nlh', 0.7],
  ['plo4', 0.2],
  ['plo5', 0.18],
  ['plo6', 0.12],
  ['pineapple', 0.1],
  ['short_deck', 0.1],
  ['plo8', 0.1],
  ['flh', 0.08],
  ['flo8', 0.08],
];

export const MAX_VARIANTS_PER_HORSE = 3;

/**
 * Deterministic variant assignment. Each variant gets its OWN hash ordering,
 * so memberships overlap naturally rather than every horse collecting the
 * same first three. Coverage is then exact rather than probabilistic, which
 * is what lets the assert in the tagger be a hard check instead of a hope.
 */
export function assignVariants(
  horseIds: string[],
  seed = STABLE_HAND_SEED,
  /** The variants the host deals (has an enabled game of). Omit for all. A
   *  tag for a variant the host has no game of is a horse that can never sit
   *  there; see PreferredStakeOptions.dealt for the measured cost. */
  allowed?: ReadonlySet<string>
): Map<string, string[]> {
  const out = new Map<string, string[]>(horseIds.map((h) => [h, []]));
  const n = horseIds.length;
  if (n === 0) return out;

  for (const [variant, share] of VARIANT_COVERAGE) {
    if (allowed && !allowed.has(variant)) continue;
    const want = Math.ceil(share * n);
    const ordered = [...horseIds].sort((a, b) =>
      shDigest(variant, a, seed).localeCompare(shDigest(variant, b, seed))
    );
    let taken = 0;
    for (const h of ordered) {
      if (taken >= want) break;
      const cur = out.get(h)!;
      if (cur.length >= MAX_VARIANTS_PER_HORSE) continue;
      if (cur.includes(variant)) continue;
      cur.push(variant);
      taken++;
    }
  }

  // Nobody sits with an empty variant list - NLHE is the fallback floor (or
  // the first variant the host deals, on a host with no NLHE game at all).
  const floor = !allowed || allowed.has('nlh') ? 'nlh' : ([...allowed][0] ?? 'nlh');
  out.forEach((v, k) => {
    if (v.length === 0) out.set(k, [floor]);
  });
  return out;
}

export interface PreferredStakeOptions {
  /**
   * The horse's chip balance in the wallet this tag belongs to
   * (`club_members.chip_balance`), which is what the seat gate reads.
   * Omit it and no ceiling is applied - the draw stands on its own, which is
   * the behaviour a caller with no wallet in hand should get.
   */
  roll?: number;
  /** `bankrollPolicyFor(horseId).buyInsToSit`. See buyInsRequiredFor. */
  buyInsToSit?: number;
  seed?: string;
  /**
   * THE BIG BLINDS THE HOST ACTUALLY DEALS for at least one of this horse's
   * variants (`cash_games` enabled and not closed, on the wallet's host).
   *
   * Omit it and the whole platform ladder is eligible, which is what the tag
   * book was written against until 2026-09-11. Measured that day: the two
   * hosts deal different ladders (Midway Union deals no 0.01/0.02, no
   * 0.02/0.05 and nothing above 2/5 in any variant; 1/2 only in three
   * variants), so 57 Midway tags named stakes the host does not deal and 23
   * more named a stake the host deals only in a variant the horse does not
   * play - 51 of 530 cash-capable Midway bodies that could never sit on their
   * own host, and never fell through to the band either, because the
   * stranded-tag test in the seeder is platform-wide and Deep Stack deals
   * every one of those rungs. A tag is a promise the seat gate keeps; it
   * must name a game the host has.
   */
  dealt?: ReadonlySet<number>;
}

/** Is this rung one the host deals? No `dealt` set means every rung is. */
function rungIsDealt(bb: number, dealt: ReadonlySet<number> | undefined): boolean {
  if (!dealt) return true;
  for (const d of dealt) if (Math.abs(d - bb) < 1e-9) return true;
  return false;
}

/**
 * The stakes a horse is tagged for: an anchor and the one adjacent lower rung
 * (Section 8.7 - a horse plays a stake and the one next to it, never 1/2
 * alongside 0.01/0.02).
 *
 * ── THE DRAW IS A HASH; THE ROLL IS A CEILING (Dan, 2026-09-05) ────────────
 *
 * "THERE ISN'T A 'CAP'. HORSES CAN ONLY PLAY ABOVE 1/2 IF THEY HAVE THE
 * 'PROPER BANKROLL' TO PLAY A BIGGER STAKE."
 *
 * Two things decide the band, in this order:
 *
 *  1. A DETERMINISTIC DRAW from STAKE_MIX, keyed on (horseId, seed). This is
 *     what keeps the floor spread across the ladder instead of every solvent
 *     horse crowding the biggest game it can afford - and 814 of 1,000 could
 *     afford 2/5 today, so "highest affordable" as a rule would empty the
 *     micro floor overnight. It is also what makes a re-tag reproduce the
 *     previous run byte for byte.
 *  2. THE ROLL, applied as a CEILING and never as a floor. A horse drawn into
 *     a band it cannot fund drops to the highest band it can; a horse drawn
 *     into micro stays in micro however rich it is. Within the band, only the
 *     rungs the roll actually supports are eligible.
 *
 * The affordability test is the seat gate's own (see `rollSupportsStake`), so
 * a tag can never name a stake the gate would refuse - which was the other
 * half of the bug: a tag that outran the bankroll would have produced a horse
 * that is a "buyer" for a feeder it can never sit at.
 */
export function assignPreferredStakes(horseId: string, opts: PreferredStakeOptions = {}): number[] {
  const seed = opts.seed ?? STABLE_HAND_SEED;
  const roll = opts.roll;
  const hasRoll = typeof roll === 'number' && Number.isFinite(roll);

  // 1. The draw: cumulative STAKE_MIX over the four bands.
  const draw = (shHash(horseId, 'stake-band', seed) % 10_000) / 10_000;
  let acc = 0;
  let band: StakeBand = STAKE_BANDS[STAKE_BANDS.length - 1];
  for (const b of STAKE_BANDS) {
    acc += STAKE_MIX[b];
    if (draw < acc) {
      band = b;
      break;
    }
  }

  // 2. The ceiling: never a band above what the wallet funds.
  if (hasRoll) {
    const ceiling = highestBandSupported(roll as number, opts.buyInsToSit);
    if (ceiling === null) {
      // Cannot fund even the cheapest rung. It plays the cheapest game there
      // is (the cheapest its host deals), which is where `isBroke` will meet
      // it and send it to a freeroll.
      const cheapestDealt = STAKE_LADDER.find((s) => rungIsDealt(s.bb, opts.dealt));
      return [cheapestDealt ? cheapestDealt.bb : STAKE_LADDER[0].bb];
    }
    const drawnIdx = STAKE_BANDS.indexOf(band);
    const ceilingIdx = STAKE_BANDS.indexOf(ceiling);
    if (ceilingIdx < drawnIdx) band = ceiling;
  }

  const dealt = opts.dealt;
  const eligible = (b: StakeBand): number[] =>
    STAKE_LADDER.filter(
      (s) =>
        stakeBandOf(s.bb) === b &&
        rungIsDealt(s.bb, dealt) &&
        (!hasRoll || rollSupportsStake(roll as number, s.bb, opts.buyInsToSit))
    ).map((s) => s.bb);

  let inBand = eligible(band);

  /* 3. THE HOST'S LADDER, applied the same way the roll is: DOWNWARD ONLY.
     A band the host deals nothing in (for this horse's variants) drops to
     the nearest band below it that it does. Never upward - a horse drawn
     into micro on a host with no micro game is not sent to 2/5 by that fact;
     it gets the cheapest dealt rung the roll supports instead, which is the
     nearest thing to the draw the host can honour. */
  if (inBand.length === 0 && dealt) {
    for (let i = STAKE_BANDS.indexOf(band) - 1; i >= 0 && inBand.length === 0; i--) {
      inBand = eligible(STAKE_BANDS[i]);
    }
    if (inBand.length === 0) {
      const cheapest = STAKE_LADDER.filter(
        (s) =>
          rungIsDealt(s.bb, dealt) &&
          (!hasRoll || rollSupportsStake(roll as number, s.bb, opts.buyInsToSit))
      ).map((s) => s.bb);
      if (cheapest.length > 0) inBand = [cheapest[0]];
    }
    if (inBand.length === 0) {
      /* The host deals nothing this roll supports. The cheapest rung the
         host deals at all, which is where `isBroke` will meet it. */
      const anyDealt = STAKE_LADDER.filter((s) => rungIsDealt(s.bb, dealt)).map((s) => s.bb);
      if (anyDealt.length > 0) return [anyDealt[0]];
    }
  }

  /* A band whose every rung is out of reach cannot happen once the ceiling
     above has run - the ceiling picked this band precisely because one of its
     rungs is affordable - but a caller that hands in a band and a roll that
     disagree gets the cheapest rung rather than a crash. */
  if (inBand.length === 0) return [STAKE_LADDER[0].bb];

  const anchorIdx = shHash(horseId, 'stake-anchor', seed) % inBand.length;
  const anchor = inBand[anchorIdx];
  const ladderIdx = STAKE_LADDER.findIndex((s) => s.bb === anchor);
  const neighbour = STAKE_LADDER[Math.max(0, ladderIdx - 1)].bb;
  /* The adjacent rung rides along only when the host deals it: a tag naming
     a rung nobody deals is not a spread, it is a promise nobody can keep. */
  if (!rungIsDealt(neighbour, dealt)) return [anchor];
  return Array.from(new Set([neighbour, anchor])).sort((a, b) => a - b);
}
