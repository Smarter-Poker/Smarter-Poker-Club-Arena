/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE ONE RAKE SPECIFICATION (Chip Accounting Standard, rule R7; 2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Before this file the rake spec lived in four places that could not read each
 * other: `tables.rake_percent = -1 / rake_cap_bb = -1` (a sentinel),
 * `ca_rake_schedule` (per-stake percent + cap + BBJ drop, no player-count
 * dimension), `ca_rake_tier` (bands), and engine constants scattered across
 * RakeConfig.ts (`getPlayerCountCaps`, `BBJ_RULES.minPlayersDealt`) and
 * PokerEngine.ts (`HEADS_UP_RAKE_PERCENT`, `noFlopNoDrop`). The database audit
 * (`fn_rake_law_check`) therefore could not reproduce the engine's number and
 * its "under-rake" findings were noise: 421 of 2,044 flop hands flagged where
 * the engine was right every time (heads-up 5% and half cap, 3-dealt 67% cap,
 * 3.00 BB priced by tier fallback, ineligible variants dropping no BBJ).
 *
 * This object is now the engine's ONLY source for every number below.
 * RakeConfig.ts re-exports from it; PokerEngine.calculateRake reads the
 * heads-up percent from it. The database holds the same spec in
 * `ca_rake_schedule`, `ca_rake_schedule_caps`, `ca_rake_tier` and
 * `ca_rake_rules`, and `fn_effective_rake` / `fn_effective_bbj_drop` implement
 * exactly the arithmetic in `effectiveRake` / `effectiveBbjDrop` here.
 *
 * TWO GUARANTEES HOLD THE TWO SIDES TOGETHER:
 *
 *   1. `rakeSpecChecksum()` is the md5 of `rakeSpecCanonical()`, and
 *      `fn_rake_spec_checksum()` is the md5 of the same text built in SQL. At
 *      boot the engine compares the two (services/rakeSpecGuard.ts). If they
 *      differ it raises a CRITICAL `RakeSpec.drift` financial alert carrying
 *      both checksums and both canonical texts, logs it, and KEEPS DEALING on
 *      the compiled-in spec. Dan's risk ruling (2026-09-02, binding): nothing
 *      that is high risk for live play is enforced, so the guard never holds
 *      a table, never refuses a hand and never stops a boot. The alert is the
 *      enforcement; a drift is loud, not silent.
 *
 *   2. `RakeSpecParity.law.test.ts` proves `calculateRake` (the money path)
 *      and `effectiveRake` (the SQL mirror) agree on a 500-case table, and
 *      pins the checksum the migration asserts.
 *
 * CANONICAL TEXT RULE (identical in fn_rake_spec_canonical(), keep in sync):
 *   - compact JSON, no whitespace, keys in exactly the order written below;
 *   - every money/percent/factor number is a STRING with exactly two decimals
 *     (`toFixed(2)` here, `round(x, 2)::text` in SQL) so "7.5" vs "7.50" and
 *     JSON number formatting can never split the checksum;
 *   - counts (players dealt, min players) are bare integers; flags are
 *     true/false; an open-ended tier upper bound is null;
 *   - caps sorted by (bb asc, dealt asc); schedule by (bb asc, sb asc);
 *     tiers by min_bb asc; rules keys in alphabetical order.
 *
 * This module imports nothing from the engine so it can be imported from
 * anywhere (PokerEngine, RakeConfig, the dealing loop, the watchdog) without
 * a cycle. Keep it that way.
 */
import { createHash } from 'node:crypto';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface RakeScheduleEntry {
  sb: number;
  bb: number;
  rakePercent: number;
  /** ABSOLUTE chip amount, not big blinds. */
  rakeCap: number;
  /** BBJ drop per qualifying hand, in big blinds. */
  bbjFeeBB: number;
}

export interface StakesTier {
  label: string;
  blindRange: string;
  minBB: number;
  maxBB: number;
  rakePercent: number;
  rakeCap: number;
  rakeCapBB: number;
  bbjFeeBB: number;
  /** % of BBJ pool paid out when jackpot hits at this stakes level */
  bbjPayoutTotalPercent: number;
}

export interface RakeRules {
  /** Two-handed (or fewer) pots are raked at this percent, as a CEILING. */
  headsUpPercent: number;
  /** Two-handed cap = round(fullCap * headsUpCapFactor, 2). */
  headsUpCapFactor: number;
  /** Three-handed cap = round(fullCap * shortHandedCapFactor, 2). */
  shortHandedCapFactor: number;
  /** Player count at which the short-handed factor applies (exactly). */
  shortHandedMaxPlayers: number;
  /** No flop, no drop: a hand that never saw a flop is raked nothing. */
  noFlopNoDrop: boolean;
  /** The BBJ drop is collected only when at least this many were dealt in. */
  bbjMinPlayersDealt: number;
  /** PAYOUT floor only: a jackpot pays only when pot > bbjMinPotBB big blinds. */
  bbjMinPotBB: number;
  /** An owner override may never rake above this percent... */
  maxRakePercent: number;
  /** ...nor cap above this many big blinds. */
  maxRakeCapBB: number;
  /** Variants that never drop a BBJ fee (and can never win one). */
  bbjIneligibleVariants: readonly string[];
}

export interface RakeCapRow {
  bb: number;
  /** 2 = heads-up, 3 = three-handed, 4 = four or more (the full cap). */
  playersDealt: number;
  rakeCap: number;
  source: 'schedule' | 'tier_fallback';
}

// ═══════════════════════════════════════════════════════════════════════════════
// OFFICIAL RAKE SCHEDULE - per-stakes lookup table (moved from RakeConfig.ts)
// rakeCap is an ABSOLUTE CHIP AMOUNT (not BB-based).
// ═══════════════════════════════════════════════════════════════════════════════

const SCHEDULE: readonly RakeScheduleEntry[] = [
  { sb: 0.1, bb: 0.2, rakePercent: 10, rakeCap: 3, bbjFeeBB: 0.6 },
  { sb: 0.2, bb: 0.4, rakePercent: 10, rakeCap: 3, bbjFeeBB: 0.6 },
  { sb: 0.25, bb: 0.5, rakePercent: 10, rakeCap: 3, bbjFeeBB: 0.6 },
  { sb: 0.3, bb: 0.6, rakePercent: 10, rakeCap: 5, bbjFeeBB: 0.6 },
  { sb: 0.5, bb: 1.0, rakePercent: 10, rakeCap: 5, bbjFeeBB: 0.25 },
  { sb: 1, bb: 2, rakePercent: 10, rakeCap: 5, bbjFeeBB: 0.25 },
  { sb: 2, bb: 4, rakePercent: 10, rakeCap: 7.5, bbjFeeBB: 0.12 },
  { sb: 2, bb: 5, rakePercent: 10, rakeCap: 7.5, bbjFeeBB: 0.12 },
  // A 5/5 row sat here until 2026-09-01 (sb 5, bb 5). Nothing could ever
  // match it: fn_tables_creation_guard refuses a cash table whose big blind
  // does not exceed its small blind, so no 5/5 table has ever existed and no
  // hand was ever priced by it. It also sorted out of order, between 2/5 and
  // 3/6, which is the tell that it was a typo placed by big blind. Dan ruled
  // it a typo; deleted, not legalised. Do not re-add it - if a 5-small-blind
  // stake is wanted, 5/10 already exists and 2.5/5 would fit the ladder.
  // Removed from the DB mirror by
  // supabase/migrations/20260901050000_the_rake_row_no_table_can_match.sql.
  { sb: 3, bb: 6, rakePercent: 10, rakeCap: 8, bbjFeeBB: 0.12 },
  { sb: 4, bb: 8, rakePercent: 10, rakeCap: 10, bbjFeeBB: 0.12 },
  { sb: 5, bb: 10, rakePercent: 10, rakeCap: 12.5, bbjFeeBB: 0.06 },
  { sb: 10, bb: 20, rakePercent: 10, rakeCap: 15, bbjFeeBB: 0.06 },
  { sb: 10, bb: 25, rakePercent: 10, rakeCap: 15, bbjFeeBB: 0.06 },
  // ── ADDED 2026-08-31 (Dan, binding) ──────────────────────────────────────
  // Dan: "WE HAVE A SCALE THAT WE USE FOR THE CASH GAME FOR RAKE AND BBJ, USE
  // THE SAME PERCENTAGES WE USE FOR THE OTHER GAMES, IF YOU DON'T HAVE A RAKE
  // OR BBJ SCHEDULE FOR A SPECIFIC GAME."
  //
  // Six of the twelve blind presets the create-table form offers had no row
  // here, so findScheduleMatch returned null and the price fell through to
  // getTierForBB - a tier whose cap is an ABSOLUTE DOLLAR AMOUNT applied
  // regardless of stake. At the bottom of the ladder that is not a small
  // discrepancy, it is an order of magnitude:
  //
  //     0.01/0.02   $3 flat  =  150 BB
  //     0.02/0.05   $3 flat  =   60 BB
  //     0.05/0.10   $3 flat  =   30 BB   <- THE DEFAULT PRESET
  //     0.10/0.25   $3 flat  =   12 BB
  //
  // against a published ladder whose most generous row (0.1/0.2) is 15 BB and
  // whose typical row is 1-6 BB.
  //
  // HOW THESE NUMBERS WERE DERIVED - no rate is invented:
  //   rakePercent  10 at every stake, as every existing row already is.
  //   rakeCap      the same BB proportion the schedule's own cheapest
  //                published row charges (0.1/0.2 at $3 = 15 BB), so the
  //                three sub-0.2 stakes are 15 BB in dollars. 0.10/0.25 sits
  //                inside the schedule's existing flat-$3 band (0.2, 0.4 and
  //                0.5 are all $3) and takes $3. The two nosebleed rows take
  //                the Nosebleeds tier's own $20, which is what they are
  //                charged today - adding the row changes no price, it just
  //                makes the price published rather than inherited.
  //   bbjFeeBB     the tier's fee for that stake, unchanged: Nano/Micro 0.6,
  //                Nosebleeds 0.03.
  { sb: 0.01, bb: 0.02, rakePercent: 10, rakeCap: 0.3, bbjFeeBB: 0.6 },
  { sb: 0.02, bb: 0.05, rakePercent: 10, rakeCap: 0.75, bbjFeeBB: 0.6 },
  { sb: 0.05, bb: 0.1, rakePercent: 10, rakeCap: 1.5, bbjFeeBB: 0.6 },
  { sb: 0.1, bb: 0.25, rakePercent: 10, rakeCap: 3, bbjFeeBB: 0.6 },
  { sb: 25, bb: 50, rakePercent: 10, rakeCap: 20, bbjFeeBB: 0.03 },
  { sb: 50, bb: 100, rakePercent: 10, rakeCap: 20, bbjFeeBB: 0.03 },
];

// ═══════════════════════════════════════════════════════════════════════════════
// STAKES TIERS - fallback for a stake with no published row (moved from
// RakeConfig.ts). The database mirror is `ca_rake_tier` (label, min_bb,
// max_bb, rake_percent, rake_cap, bbj_fee_bb); `bbjPayoutTotalPercent` is a
// PAYOUT parameter, not a collection one, and is not part of the checksum.
// ═══════════════════════════════════════════════════════════════════════════════

const TIERS: Readonly<Record<string, StakesTier>> = {
  nano: {
    label: 'Nano',
    blindRange: '0.05/0.10 - 0.1/0.2',
    minBB: 0.1,
    maxBB: 0.2,
    rakePercent: 10,
    rakeCap: 3,
    rakeCapBB: 3,
    bbjFeeBB: 0.6,
    bbjPayoutTotalPercent: 15, // 7.5% loser / 3.75% winner / 3.75% table
  },
  micro: {
    label: 'Micro',
    blindRange: '0.2/0.4 - 0.4/0.8',
    minBB: 0.3,
    maxBB: 0.8,
    rakePercent: 10,
    rakeCap: 3,
    rakeCapBB: 3,
    bbjFeeBB: 0.6, // Per PDF rake schedule: .20/.40 and .30/.60 are both 0.6bb
    bbjPayoutTotalPercent: 25, // 12.5% loser / 6.25% winner / 6.25% table
  },
  small: {
    label: 'Small',
    blindRange: '0.5/1 - 1.5/3',
    minBB: 1,
    maxBB: 3,
    rakePercent: 10,
    rakeCap: 5,
    rakeCapBB: 5,
    bbjFeeBB: 0.25,
    bbjPayoutTotalPercent: 40, // 20% loser / 10% winner / 10% table
  },
  mid: {
    label: 'Mid',
    blindRange: '2/4 - 4/8',
    minBB: 3.5,
    maxBB: 8,
    rakePercent: 10,
    rakeCap: 8,
    rakeCapBB: 8,
    bbjFeeBB: 0.12,
    bbjPayoutTotalPercent: 55, // 27.5% loser / 13.75% winner / 13.75% table
  },
  high: {
    label: 'High',
    blindRange: '5/10 - 20/40',
    minBB: 9,
    maxBB: 40,
    rakePercent: 10,
    rakeCap: 15,
    rakeCapBB: 15,
    bbjFeeBB: 0.06,
    bbjPayoutTotalPercent: 70, // 35% loser / 17.5% winner / 17.5% table
  },
  nosebleeds: {
    label: 'Nosebleeds',
    blindRange: '25/50+',
    minBB: 41,
    maxBB: Infinity,
    rakePercent: 10,
    rakeCap: 20,
    rakeCapBB: 20,
    bbjFeeBB: 0.03,
    bbjPayoutTotalPercent: 85, // 42.5% loser / 21.25% winner / 21.25% table
  },
};

/** Tier lookup order: the first tier whose maxBB the big blind does not exceed. */
const TIER_ORDER: readonly string[] = ['nano', 'micro', 'small', 'mid', 'high', 'nosebleeds'];

// ═══════════════════════════════════════════════════════════════════════════════
// RULES - every constant that used to be scattered
// ═══════════════════════════════════════════════════════════════════════════════

const RULES: RakeRules = {
  // Dan 2026-08-27: "Rake is 10% with a max cap. Heads up is 5% rake."
  headsUpPercent: 5,
  // FIX 166 / Bible V8 §7.19: heads-up 50% of cap, 3-handed 67%, 4+ full.
  headsUpCapFactor: 0.5,
  shortHandedCapFactor: 0.67,
  shortHandedMaxPlayers: 3,
  // Bible V8 §2.9 / Appendix A, and Dan 2026-08-29: no flop, no drop.
  noFlopNoDrop: true,
  // FIX 145: BBJ requires 3+ players dealt in.
  bbjMinPlayersDealt: 3,
  // PAYOUT floor only (Dan 2026-08-29); never a fee gate.
  bbjMinPotBB: 10,
  // Owner override ceilings (RakeConfig.ts getFullRakeConfig).
  maxRakePercent: 10,
  maxRakeCapBB: 10,
  bbjIneligibleVariants: ['plo6', 'short_deck'],
};

/**
 * Stakes with NO published row that live cash tables are dealt at today, and
 * are therefore priced by the tier fallback. They get a `ca_rake_schedule_caps`
 * row so the database can publish the cap the engine actually charges at
 * every stake it deals, not just the scheduled ones. Measured 2026-09-02: of
 * the nine big blinds in play (0.02 .. 4.00), 3.00 was the only one without
 * a row. Adding a schedule row for it would not change its price (the small
 * tier's 10% / 5.00 / 0.25 BB is exactly what a row would say); listing it
 * here makes that price published rather than inherited, without inventing a
 * schedule entry Dan did not write.
 */
const TIER_PRICED_BIG_BLINDS: readonly number[] = [3];

// ═══════════════════════════════════════════════════════════════════════════════
// DERIVED VALUES
// ═══════════════════════════════════════════════════════════════════════════════

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * THE MOST GENEROUS SHARE OF A BIG BLIND ANY PUBLISHED ROW TAKES (15 BB from
 * the 0.1/0.2 row). Derived, never written down, so it cannot drift from the
 * ladder it describes. Binds ONLY the tier fallback for an unscheduled stake.
 * SQL: fn_unscheduled_cap_bb().
 */
const UNSCHEDULED_CAP_BB = SCHEDULE.reduce(
  (worst, row) => (row.bb > 0 ? Math.max(worst, row.rakeCap / row.bb) : worst),
  0
);

export function tierForBB(bigBlind: number): StakesTier {
  for (const key of TIER_ORDER) {
    const tier = TIERS[key];
    if (bigBlind <= tier.maxBB) return tier;
  }
  return TIERS.nosebleeds;
}

/**
 * The tier's KEY, not its config. `bbj_mini_tiers` is keyed on the same six
 * ids as `bbj_stakes_tiers` in the database, so the Mini BBJ needs the string
 * a row is filed under rather than the numbers filed under it. Derived from
 * the same ladder as tierForBB so the two can never disagree about where a
 * stake sits.
 */
export function tierIdForBB(bigBlind: number): string {
  for (const key of TIER_ORDER) {
    if (bigBlind <= TIERS[key].maxBB) return key;
  }
  return 'nosebleeds';
}

/** The cap for a stake with no published row: the tier's, held to the ladder. */
export function unscheduledCapFor(bigBlind: number, tierCap: number): number {
  if (!(bigBlind > 0)) return tierCap;
  return Math.min(tierCap, round2(bigBlind * UNSCHEDULED_CAP_BB));
}

export function scheduleMatch(smallBlind: number, bigBlind: number): RakeScheduleEntry | null {
  return (
    SCHEDULE.find(
      (row) => Math.abs(row.sb - smallBlind) < 0.001 && Math.abs(row.bb - bigBlind) < 0.001
    ) || null
  );
}

/**
 * The cap ladder by players dealt: the engine finds the highest tier where
 * playersDealt >= players and applies that cap. Materialised here from the
 * factors so `ca_rake_schedule_caps` and this list are one derivation.
 */
export function capsByPlayersDealt(fullCap: number): { players: number; cap: number }[] {
  return [
    { players: 2, cap: round2(fullCap * RULES.headsUpCapFactor) },
    { players: RULES.shortHandedMaxPlayers, cap: round2(fullCap * RULES.shortHandedCapFactor) },
    { players: RULES.shortHandedMaxPlayers + 1, cap: fullCap },
  ];
}

function buildCapRows(): RakeCapRow[] {
  const rows: RakeCapRow[] = [];
  for (const s of SCHEDULE) {
    for (const c of capsByPlayersDealt(s.rakeCap)) {
      rows.push({ bb: s.bb, playersDealt: c.players, rakeCap: c.cap, source: 'schedule' });
    }
  }
  for (const bb of TIER_PRICED_BIG_BLINDS) {
    if (SCHEDULE.some((s) => Math.abs(s.bb - bb) < 0.001)) continue;
    const tier = tierForBB(bb);
    const fullCap = unscheduledCapFor(bb, tier.rakeCap);
    for (const c of capsByPlayersDealt(fullCap)) {
      rows.push({ bb, playersDealt: c.players, rakeCap: c.cap, source: 'tier_fallback' });
    }
  }
  return rows.sort((a, b) => a.bb - b.bb || a.playersDealt - b.playersDealt);
}

export interface RakeSpec {
  schedule: readonly RakeScheduleEntry[];
  tiers: Readonly<Record<string, StakesTier>>;
  tierOrder: readonly string[];
  rules: RakeRules;
  unscheduledCapBB: number;
  tierPricedBigBlinds: readonly number[];
  caps: readonly RakeCapRow[];
}

export const RAKE_SPEC: RakeSpec = Object.freeze({
  schedule: SCHEDULE,
  tiers: TIERS,
  tierOrder: TIER_ORDER,
  rules: RULES,
  unscheduledCapBB: UNSCHEDULED_CAP_BB,
  tierPricedBigBlinds: TIER_PRICED_BIG_BLINDS,
  caps: buildCapRows(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// THE ARITHMETIC - the SQL mirror of fn_effective_rake / fn_effective_bbj_drop
// ═══════════════════════════════════════════════════════════════════════════════

export interface EffectiveRakeInput {
  bb: number;
  pot: number;
  playersDealt: number;
  sawFlop: boolean;
  /** When omitted the stake is resolved by big blind alone (unique in the schedule). */
  sb?: number | null;
  /** Owner override, whole-percent units. -1 / null / undefined = inherit. */
  overridePercent?: number | null;
  /** Owner override cap in BIG BLINDS. -1 / null / undefined = inherit. */
  overrideCapBB?: number | null;
}

export interface EffectiveRakeResult {
  rake: number;
  cap: number;
  percent: number;
  /** Base price for the stake before player-count and override adjustments. */
  fullCap: number;
  bbjFeeBB: number;
  scheduled: boolean;
}

const isSet = (v: number | null | undefined): v is number =>
  v !== null && v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0;

/** Resolve the base price for a stake: schedule row, else tier fallback. */
export function resolveStake(
  bb: number,
  sb?: number | null,
  spec: RakeSpec = RAKE_SPEC
): { percent: number; cap: number; bbjFeeBB: number; scheduled: boolean } {
  const row =
    sb === null || sb === undefined
      ? spec.schedule.find((r) => Math.abs(r.bb - bb) < 0.001) || null
      : spec.schedule.find((r) => Math.abs(r.sb - sb) < 0.001 && Math.abs(r.bb - bb) < 0.001) ||
        null;
  if (row) {
    return { percent: row.rakePercent, cap: row.rakeCap, bbjFeeBB: row.bbjFeeBB, scheduled: true };
  }
  const tier = tierForBB(bb);
  return {
    percent: tier.rakePercent,
    cap: unscheduledCapFor(bb, tier.rakeCap),
    bbjFeeBB: tier.bbjFeeBB,
    scheduled: false,
  };
}

/**
 * Exactly `calculateRake(pot, sawFlop, getRakeConfig(sb, bb), playersDealt)`,
 * written against the spec object instead of the engine's config plumbing.
 * The parity law test holds the two together.
 *
 * Arithmetic, in order (and the same order in fn_effective_rake):
 *   1. base percent/cap from the schedule row, else the tier fallback;
 *   2. an owner override may only move DOWNWARD: clamp to the ceilings, then
 *      min() against the published price;
 *   3. heads-up (dealt <= 2): percent = min(percent, headsUpPercent);
 *   4. cap by players dealt: 2 -> round2(cap * 0.5), 3 -> round2(cap * 0.67),
 *      4+ -> cap, and fewer than 2 (never dealt) -> the full cap;
 *   5. no flop, no drop -> 0; else rake = min(Math.round(pot * percent) / 100, cap).
 */
export function effectiveRake(
  input: EffectiveRakeInput,
  spec: RakeSpec = RAKE_SPEC
): EffectiveRakeResult {
  const base = resolveStake(input.bb, input.sb, spec);
  const rules = spec.rules;

  let percent = base.percent;
  let fullCap = base.cap;
  if (isSet(input.overridePercent)) {
    const ov = Math.min(rules.maxRakePercent, Math.max(0, Number(input.overridePercent)));
    percent = Math.min(ov, percent);
  }
  if (isSet(input.overrideCapBB)) {
    const ovBB = Math.min(rules.maxRakeCapBB, Math.max(0, Number(input.overrideCapBB)));
    fullCap = Math.min(round2(ovBB * input.bb), fullCap);
  }

  if (input.playersDealt <= 2) percent = Math.min(percent, rules.headsUpPercent);

  let cap = fullCap;
  const ladder = capsByPlayersDealt(fullCap).sort((a, b) => b.players - a.players);
  const tier = ladder.find((t) => input.playersDealt >= t.players);
  if (tier) cap = tier.cap;

  if (rules.noFlopNoDrop && !input.sawFlop) {
    return { rake: 0, cap, percent, fullCap, bbjFeeBB: base.bbjFeeBB, scheduled: base.scheduled };
  }
  const rake = Math.min(Math.round(input.pot * percent) / 100, cap);
  return { rake, cap, percent, fullCap, bbjFeeBB: base.bbjFeeBB, scheduled: base.scheduled };
}

export interface EffectiveBbjInput {
  bb: number;
  playersDealt: number;
  sawFlop: boolean;
  variant?: string;
  sb?: number | null;
  /** `tables.bbj_percent`; null/undefined means the column default (enabled). */
  tableBbjPercent?: number | null;
  /** When given with `rake`, the pot ceiling applies: rake + drop <= pot, drop yields first. */
  pot?: number | null;
  rake?: number | null;
}

/**
 * Exactly HandController.priceDeductions' BBJ leg. The drop is collected on
 * every flop with 3+ dealt, on an eligible variant, on a table whose
 * `bbj_percent` is not an explicit 0 - pot size never gates it - and it
 * yields to the pot ceiling before rake does.
 */
export function effectiveBbjDrop(input: EffectiveBbjInput, spec: RakeSpec = RAKE_SPEC): number {
  const rules = spec.rules;
  const variant = (input.variant || 'nlh').toLowerCase();
  if (rules.bbjIneligibleVariants.includes(variant)) return 0;
  if (!input.sawFlop) return 0;
  if (input.playersDealt < rules.bbjMinPlayersDealt) return 0;
  const tablePercent =
    input.tableBbjPercent === null || input.tableBbjPercent === undefined
      ? 100
      : Number(input.tableBbjPercent);
  if (!(tablePercent > 0)) return 0;
  const base = resolveStake(input.bb, input.sb, spec);
  let fee = Math.round(input.bb * base.bbjFeeBB * 100) / 100;
  if (
    input.pot !== null &&
    input.pot !== undefined &&
    input.rake !== null &&
    input.rake !== undefined
  ) {
    if (input.rake + fee > input.pot) {
      const overage = round2(input.rake + fee - input.pot);
      fee = overage <= fee ? round2(fee - overage) : 0;
    }
  }
  return fee;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CANONICAL TEXT + CHECKSUM (see the header for the rule; SQL twin is
// fn_rake_spec_canonical() / fn_rake_spec_checksum())
// ═══════════════════════════════════════════════════════════════════════════════

const n2 = (v: number): string => v.toFixed(2);
const q = (s: string): string => JSON.stringify(s);

export function rakeSpecCanonical(spec: RakeSpec = RAKE_SPEC): string {
  const caps = [...spec.caps]
    .sort((a, b) => a.bb - b.bb || a.playersDealt - b.playersDealt)
    .map((c) => `{"bb":${q(n2(c.bb))},"dealt":${c.playersDealt},"cap":${q(n2(c.rakeCap))}}`)
    .join(',');
  const r = spec.rules;
  const rules =
    `{"bbj_ineligible_variants":[${[...r.bbjIneligibleVariants].sort().map(q).join(',')}],` +
    `"bbj_min_players_dealt":${r.bbjMinPlayersDealt},` +
    `"bbj_min_pot_bb":${r.bbjMinPotBB},` +
    `"heads_up_cap_factor":${q(n2(r.headsUpCapFactor))},` +
    `"heads_up_percent":${q(n2(r.headsUpPercent))},` +
    `"max_rake_cap_bb":${q(n2(r.maxRakeCapBB))},` +
    `"max_rake_percent":${q(n2(r.maxRakePercent))},` +
    `"no_flop_no_drop":${r.noFlopNoDrop ? 'true' : 'false'},` +
    `"short_handed_cap_factor":${q(n2(r.shortHandedCapFactor))},` +
    `"short_handed_max_players":${r.shortHandedMaxPlayers},` +
    `"unscheduled_cap_bb":${q(n2(spec.unscheduledCapBB))}}`;
  const schedule = [...spec.schedule]
    .sort((a, b) => a.bb - b.bb || a.sb - b.sb)
    .map(
      (s) =>
        `{"sb":${q(n2(s.sb))},"bb":${q(n2(s.bb))},"rake_percent":${q(n2(s.rakePercent))},` +
        `"rake_cap":${q(n2(s.rakeCap))},"bbj_fee_bb":${q(n2(s.bbjFeeBB))}}`
    )
    .join(',');
  const tiers = spec.tierOrder
    .map((k) => spec.tiers[k])
    .sort((a, b) => a.minBB - b.minBB)
    .map(
      (t) =>
        `{"label":${q(t.label.toLowerCase())},"min_bb":${q(n2(t.minBB))},` +
        `"max_bb":${Number.isFinite(t.maxBB) ? q(n2(t.maxBB)) : 'null'},` +
        `"rake_percent":${q(n2(t.rakePercent))},"rake_cap":${q(n2(t.rakeCap))},` +
        `"bbj_fee_bb":${q(n2(t.bbjFeeBB))}}`
    )
    .join(',');
  return `{"caps":[${caps}],"rules":${rules},"schedule":[${schedule}],"tiers":[${tiers}]}`;
}

export function rakeSpecChecksum(spec: RakeSpec = RAKE_SPEC): string {
  return createHash('md5').update(rakeSpecCanonical(spec), 'utf8').digest('hex');
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE DRIFT STATE - published on /health, never consulted by the deal loop
// ═══════════════════════════════════════════════════════════════════════════════
//
// Dan's risk ruling (2026-09-02, binding): a checksum mismatch is REPORTED
// (CRITICAL `RakeSpec.drift`, once per boot) and dealing continues on the
// compiled-in spec. There is deliberately no "blocked" flag here and nothing
// in the engine reads this state to decide whether to deal. A guard that can
// stop a fleet over a hash is a bigger live-play risk than the drift it
// would catch; the alert is the enforcement.

export interface RakeSpecDriftState {
  /** True while the last successful comparison disagreed. Informational only. */
  drifted: boolean;
  compiledChecksum: string;
  databaseChecksum: string | null;
  /** What the last comparison found; for /health and the alert. */
  detail: string;
  checkedAt: number;
}

let driftState: RakeSpecDriftState = {
  drifted: false,
  compiledChecksum: rakeSpecChecksum(),
  databaseChecksum: null,
  detail: 'not yet verified against the database',
  checkedAt: 0,
};

export function rakeSpecDriftState(): RakeSpecDriftState {
  return { ...driftState };
}

/** Set only by services/rakeSpecGuard.ts. */
export function setRakeSpecDriftState(next: Omit<RakeSpecDriftState, 'compiledChecksum'>): void {
  driftState = { ...next, compiledChecksum: rakeSpecChecksum() };
}
