/**
 * P12.2 SHORT DECK / CRAZY PINEAPPLE / FLH / FLO8 STRENGTH QUALIFICATION
 * CONTRACT (Horse Brain Phase 12)
 *
 * The one immutable, versioned statement of what a strength run of each Phase
 * 12 pack must measure and what it must show before that pack can be called
 * qualified. It is locked by the merge that introduces it: no held-out run may
 * precede that merge, and a run, an assembly or a verdict made against any
 * other contract (a different digest) is refused by name.
 *
 * Four packs, four separate qualifications. `packs.short_deck`,
 * `packs.pineapple`, `packs.flh` and `packs.flo8` each carry their own
 * population, profiles, held-out seeds, matrix, design pilot and regression
 * margin. The verdict `summarizeRemainingVariantStrength(variant, shards)`
 * reads one pack's shards only and refuses any shard of another pack, so a
 * pass for one pack never certifies another.
 *
 * It mirrors the Phase 11 machinery (OmahaVariantStrengthContract.ts) but
 * reads none of that contract's constants: every number below is this
 * contract's own, and the statistic and verdict functions are parametrized by
 * this object. What differs from Phase 11, and why:
 *
 *  (a) each pack measures the seat ceiling it actually supports as a sixth
 *      profile (Short Deck, Pineapple and FLH nine-handed, FLO8 eight-handed),
 *      because the cash creator offers these games above six seats;
 *  (b) FLH and FLO8 add the legacy 1,000 BB exposure the league supports, as a
 *      seventh profile and its own depth band;
 *  (c) the fixed-limit packs carry a fixed-limit regression margin (two big
 *      bets per 100 hands), because the no-limit margin (one 100 BB buy-in per
 *      1,000 hands) is several times a whole fixed-limit winning edge;
 *  (d) the candidate arm runs behind the P10.3 `illegal_candidate` guard
 *      (HorseLogic, added with this contract for Phase 12), and every shard
 *      counts the candidate proposals that guard refused, beside `changed`;
 *  (e) Pineapple discard decisions are not betting candidates: both arms
 *      discard through the same seeded chooser, discards are counted
 *      separately, and a discard never counts as a candidate change.
 *
 * TOURNAMENT (prize and bounty): refused by name for every pack; Pineapple has
 * no tournament format at all. Nothing here is a calibrated solver claim.
 */
import { createHash } from 'node:crypto';
import {
  REMAINING_VARIANT_DOMAIN,
  REMAINING_VARIANT_PACKS,
  remainingVariantSeatCap,
  type RemainingPolicyVariant,
} from '../engine/remainingVariants/RemainingVariantPolicyPack.js';
import { positionForOffset, type Plo4Position } from '../engine/plo4/Plo4PolicyPack.js';
import { getFullRakeConfig, getPlayerCountCaps } from '../config/RakeConfig.js';
import { CASH_MAX_BB, CASH_MIN_BB } from '../config/cashBuyIn.js';
import { maxSeatsForVariant } from '../config/tableSeating.js';
// Pure functions and the style roster only. Plo4PowerAccumulator is exact
// integer arithmetic, and the seat-style function and roster describe the
// production horse population, which is the same for every variant. No PLO4
// or Phase 11 contract constant (seeds, thresholds, matrix, interval) is read.
import {
  PRODUCTION_HORSE_STYLES,
  Plo4PowerAccumulator,
  plo4StrengthSeatStyle,
  type Plo4PowerSums,
} from './Plo4StrengthContract.js';

type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export const REMAINING_VARIANT_STRENGTH_VARIANTS: readonly RemainingPolicyVariant[] = Object.freeze(
  ['short_deck', 'pineapple', 'flh', 'flo8']
);
export function isRemainingVariantStrengthVariant(value: unknown): value is RemainingPolicyVariant {
  return (REMAINING_VARIANT_STRENGTH_VARIANTS as readonly unknown[]).includes(value);
}
const FIXED_LIMIT: readonly RemainingPolicyVariant[] = ['flh', 'flo8'];
const isFixedLimit = (v: RemainingPolicyVariant) => FIXED_LIMIT.includes(v);

/** The league's chip unit: SB 1, BB 2, amounts in chip dollars with cents. */
export const REMAINING_VARIANT_STRENGTH_BB = 2;
const STAKE = { smallBlind: 1, bigBlind: REMAINING_VARIANT_STRENGTH_BB } as const;
const SIX_MAX = 6;
/** The legacy fixed-limit exposure the league and the live pack support. */
const LEGACY_FIXED_LIMIT_BB = REMAINING_VARIANT_DOMAIN.fixedLimitMaxStackBB;

/** The live decision clock replacement (liveConditions, mood): a deterministic
 * time of day derived from the deal seed, identical in both arms of a pair.
 * The league computes the same value (`omahaVariantMoodClockMs`, the shared
 * `moodClock: 'deal_seed_time_of_day'` profile option); a test proves they
 * agree on every seed it draws. */
export function remainingVariantMoodClockMs(dealSeed: number): number {
  return (dealSeed % 86_400) * 1000;
}

export { PRODUCTION_HORSE_STYLES };
/** The same production style roster and per-seat draw as Phases 10 and 11:
 * uniform over the five production styles by deal seed and seat, hero
 * included, identical in the candidate and reference arms. */
export const remainingVariantStrengthSeatStyle = plo4StrengthSeatStyle;

export type RemainingVariantDepthBand = 'short' | 'standard' | 'deep' | 'legacy_deep';
export interface RemainingVariantStrengthProfile {
  id: string;
  variant: RemainingPolicyVariant;
  /** Dealt seats; every seat is occupied and dealt. */
  seats: number;
  /** The table's max_players, which gates the player-count cap ladder. */
  tableSeats: number;
  stackBB: number;
  depthBand: RemainingVariantDepthBand;
  /** Shards per held-out seed (each pairsPerShard pairs of this pack). */
  shards: number;
  /** Design pilot paired-difference standard deviation, BB per hand (dispersion
   * only; used to size `shards`). */
  pilotSdBB: number;
  /** Design pilot wall time per pair (candidate and reference hand), ms. */
  pilotMsPerPair: number;
  /** Design pilot kurtosis of the paired difference (m4 / m2^2). */
  pilotKurtosis: number;
}

type ProfileKey = '2dealt' | '4dealt' | '40bb' | '100bb' | '200bb' | 'ceiling' | '1000bb';
/** Design pilot, per pack and profile: [paired-difference SD in BB per hand,
 * ms per pair, kurtosis]. Development seed 12101101
 * (REMAINING_VARIANT_LEAGUE_SEEDS[0]), runRemainingVariantStrengthShard
 * development mode, shard 0, the smallest whole number of rotations at or
 * above 288 pairs per profile (288 at 2, 4 and 6 dealt, 320 at 8, 324 at 9),
 * in this repository's Linux container (Intel Xeon at 2.80GHz, 2 vCPU, shared
 * with another agent, one pilot process at a time). Never a held-out seed and
 * never a mean. Every validity counter was 0 and all 15,256 pilot hands were
 * independently settled (FLO8 settled 1,274 low halves). The logs are
 * docs/evidence/phase12/pilot-<variant>.json. */
const PILOT: Record<
  RemainingPolicyVariant,
  Partial<Record<ProfileKey, readonly [number, number, number]>>
> = {
  short_deck: {
    '2dealt': [11.07, 14.9, 50.5],
    '4dealt': [12.96, 23.8, 32.7],
    '40bb': [7.52, 24.2, 20],
    '100bb': [9.99, 24.9, 65.1],
    '200bb': [16.29, 29, 85.6],
    ceiling: [16.21, 36, 36.9],
  },
  pineapple: {
    '2dealt': [14.78, 14.8, 37.5],
    '4dealt': [16.38, 19.8, 30.9],
    '40bb': [7.91, 24, 22.3],
    '100bb': [18.8, 26, 25],
    '200bb': [17.99, 27.7, 64.1],
    ceiling: [19.24, 37.7, 49.5],
  },
  flh: {
    '2dealt': [2.16, 14.1, 8.7],
    '4dealt': [2.43, 30.7, 8.9],
    '40bb': [2.09, 33.5, 9.8],
    '100bb': [2.25, 37.3, 11.8],
    '200bb': [2.39, 36.9, 10.3],
    ceiling: [2.27, 43.5, 36.6],
    '1000bb': [2.53, 33.7, 11.5],
  },
  flo8: {
    '2dealt': [2.01, 23.9, 16],
    '4dealt': [2.21, 74.3, 12.7],
    '40bb': [2.22, 97.9, 11.5],
    '100bb': [2.42, 112.4, 10.9],
    '200bb': [2.45, 122.7, 10.5],
    ceiling: [2.19, 131.2, 16.6],
    '1000bb': [2.45, 127.5, 10.5],
  },
};
/** Shards per held-out seed, per pack, in profile order (2-dealt, 4-dealt,
 * 40 BB, 100 BB, 200 BB, seat ceiling, then 1,000 BB for the fixed-limit
 * packs): the smallest total shard count (then the least runner time) for
 * which every gating cell's planned 99% half-width is at most the pack's
 * planned maximum at 1.2 times the pilot deviations, with at least 10,000
 * pairs per profile in every gating cell, found by exhaustive search over the
 * per-profile counts (docs/evidence/phase12/p12-2-sizing.mts.txt). */
const SHARDS: Record<RemainingPolicyVariant, readonly number[]> = {
  short_deck: [4, 5, 5, 6, 10, 10],
  pineapple: [7, 8, 6, 15, 14, 15],
  flh: [1, 2, 2, 2, 2, 3, 2],
  flo8: [3, 4, 5, 5, 5, 7, 5],
};
/** Rotation blocks per shard, per pack: the largest whole number that keeps
 * the slowest profile's shard under about 25 minutes on a GitHub-hosted runner
 * at 2.5 times the pilot time per pair (Phase 10's budget rule): Short Deck 12
 * (9-max, 36.0 ms, about 23.3 minutes), Pineapple 12 (9-max, 37.7 ms, about
 * 24.4 minutes), FLH 10 (9-max, 43.5 ms, about 23.5 minutes) and FLO8 7
 * (8-max, 131.2 ms, about 22.0 minutes). Every pack then fits the 256-job
 * matrix ceiling (120, 195, 42 and 102 jobs), so no exception is needed. */
const SHARD_BLOCKS: Record<RemainingPolicyVariant, number> = {
  short_deck: 12,
  pineapple: 12,
  flh: 10,
  flo8: 7,
};
/** GitHub Actions runs at most this many jobs from one matrix (one dispatch). */
export const REMAINING_VARIANT_MATRIX_JOB_CEILING = 256;

/** Held-out seeds, chosen and written here before any run. Never used by any
 * test, development league, pilot or tuning run. Disjoint from every seed in
 * the repository (PLO4 development and held-out, the Phase 11 development and
 * held-out seeds, REMAINING_VARIANT_LEAGUE_SEEDS, the Phase 8 and 13 league
 * seeds), from each other and across packs; none of the twelve numbers
 * occurred anywhere in the repository when they were chosen
 * (docs/evidence/phase12/p12-2-seeds.log). runOmahaPolicyLeague,
 * runPlo4StrengthShard and runOmahaVariantStrengthShard refuse them, and only
 * runRemainingVariantStrengthShard in contract mode, for its own pack, accepts
 * them. */
const HOLDOUT: Record<RemainingPolicyVariant, readonly [number, number, number]> = {
  short_deck: [12201119, 12202241, 12203363],
  pineapple: [12301123, 12302251, 12303373],
  flh: [12401129, 12402257, 12403381],
  flo8: [12501131, 12502263, 12503387],
};
/** The Phase 12 development league seeds (REMAINING_VARIANT_LEAGUE_SEEDS). */
const DEVELOPMENT_SEEDS = [12101101, 12102203, 12103307];

/** Phi^-1(0.995): the two-sided 99% normal quantile. */
const Z99 = 2.5758293035489004;
/** Planning rule: every gating cell's planned 99% half-width is at most 0.85
 * of the pack's regression margin (Phase 10's 8.5 against 10), at
 * PLANNING_SD_FACTOR times the pilot deviations. */
const HALF_WIDTH_TO_MARGIN = 0.85;
const PLANNING_SD_FACTOR = 1.2;
const MINIMUM_PAIRS_PER_PROFILE_IN_CELL = 10_000;
/** The regression margins, bb/100, by betting structure (thresholds.nonregression). */
const NO_LIMIT_MARGIN = 10;
const FIXED_LIMIT_MARGIN = 4;
const marginOf = (v: RemainingPolicyVariant) =>
  isFixedLimit(v) ? FIXED_LIMIT_MARGIN : NO_LIMIT_MARGIN;
const plannedMaxOf = (v: RemainingPolicyVariant) =>
  Math.round(HALF_WIDTH_TO_MARGIN * marginOf(v) * 100) / 100;

const POSITIONS: Plo4Position[] = [
  'button',
  'small_blind',
  'big_blind',
  'cutoff',
  'middle',
  'early',
];

const ceilingOf = (v: RemainingPolicyVariant) => remainingVariantSeatCap(v, 'cash');
/** The smallest block that is a multiple of every profile's seats squared, so
 * each shard of a whole number of blocks visits every (hero seat, button) pair
 * the same number of times: 1,296 (lcm of 4, 16, 36, 81) for the nine-handed
 * packs, 576 (lcm of 4, 16, 36, 64) for FLO8. */
function rotationBlockOf(v: RemainingPolicyVariant): number {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  return [2, 4, 6, ceilingOf(v)].reduce((l, s) => (l * s * s) / gcd(l, s * s), 1);
}

function profilesFor(variant: RemainingPolicyVariant): RemainingVariantStrengthProfile[] {
  const pilot = PILOT[variant];
  const shards = SHARDS[variant];
  const ceiling = ceilingOf(variant);
  const p = (
    suffix: string,
    key: ProfileKey,
    seats: number,
    tableSeats: number,
    stackBB: number,
    depthBand: RemainingVariantDepthBand,
    index: number
  ): RemainingVariantStrengthProfile => ({
    id: `p12c-${variant}-${suffix}`,
    variant,
    seats,
    tableSeats,
    stackBB,
    depthBand,
    shards: shards[index],
    pilotSdBB: pilot[key]![0],
    pilotMsPerPair: pilot[key]![1],
    pilotKurtosis: pilot[key]![2],
  });
  return [
    p('6max-2dealt-100bb', '2dealt', 2, SIX_MAX, 100, 'standard', 0),
    p('6max-4dealt-100bb', '4dealt', 4, SIX_MAX, 100, 'standard', 1),
    p('6max-40bb', '40bb', SIX_MAX, SIX_MAX, CASH_MIN_BB, 'short', 2),
    p('6max-100bb', '100bb', SIX_MAX, SIX_MAX, 100, 'standard', 3),
    p('6max-200bb', '200bb', SIX_MAX, SIX_MAX, CASH_MAX_BB, 'deep', 4),
    p(`${ceiling}max-100bb`, 'ceiling', ceiling, ceiling, 100, 'standard', 5),
    ...(isFixedLimit(variant)
      ? [
          p(
            `6max-${LEGACY_FIXED_LIMIT_BB}bb`,
            '1000bb' as const,
            SIX_MAX,
            SIX_MAX,
            LEGACY_FIXED_LIMIT_BB,
            'legacy_deep' as const,
            6
          ),
        ]
      : []),
  ];
}
const depthBandsOf = (v: RemainingPolicyVariant): RemainingVariantDepthBand[] =>
  isFixedLimit(v) ? ['short', 'standard', 'deep', 'legacy_deep'] : ['short', 'standard', 'deep'];

/** Members, and pairs per member, of each gating cell for a profile set. */
function gatingCellPlan(
  profiles: readonly RemainingVariantStrengthProfile[],
  pairsPerShard: number
) {
  const seeds = 3;
  const pairsOf = (p: RemainingVariantStrengthProfile) => p.shards * pairsPerShard * seeds;
  const cells: { cell: string; members: { p: RemainingVariantStrengthProfile; n: number }[] }[] =
    [];
  for (const p of profiles)
    cells.push({ cell: `profile:${p.id}`, members: [{ p, n: pairsOf(p) }] });
  for (const position of POSITIONS) {
    const members = profiles
      .map((p) => {
        const offsets = Array.from({ length: p.seats }, (_, o) => o).filter(
          (o) => positionForOffset(o, p.seats) === position
        ).length;
        return { p, n: (pairsOf(p) * offsets) / p.seats };
      })
      .filter((m) => m.n > 0);
    cells.push({ cell: `position:${position}`, members });
  }
  const bands = [...new Set(profiles.map((p) => p.depthBand))];
  for (const band of (['short', 'standard', 'deep', 'legacy_deep'] as const).filter((b) =>
    bands.includes(b)
  ))
    cells.push({
      cell: `depth:${band}`,
      members: profiles.filter((p) => p.depthBand === band).map((p) => ({ p, n: pairsOf(p) })),
    });
  return cells;
}
/** Planned 99% half-width (bb/100) of each gating cell at PLANNING_SD_FACTOR
 * times the pilot deviations, the smallest per-profile pair count in it, and
 * the largest relative standard error of a member's variance estimate at its
 * pilot kurtosis, sqrt((kurtosis - 1) / n) (the assumption behind
 * interval.minimumPairsPerProfileInCell is that this stays under 0.1). The
 * sizing script calls this same function on candidate shard counts. */
export function remainingVariantPlannedHalfWidths(
  profiles: readonly RemainingVariantStrengthProfile[],
  pairsPerShard: number
) {
  return Object.fromEntries(
    gatingCellPlan(profiles, pairsPerShard).map(({ cell, members }) => {
      const w = 1 / members.length;
      const variance = members.reduce(
        (s, m) => s + (w * w * (PLANNING_SD_FACTOR * m.p.pilotSdBB) ** 2) / m.n,
        0
      );
      // BB per hand to bb/100.
      const halfWidth = Z99 * Math.sqrt(variance) * 100;
      return [
        cell,
        {
          halfWidthBbPer100: Math.round(halfWidth * 100) / 100,
          minimumProfilePairs: Math.min(...members.map((m) => m.n)),
          varianceRelativeSeAtPilotKurtosis:
            Math.round(
              Math.max(...members.map((m) => Math.sqrt((m.p.pilotKurtosis - 1) / m.n))) * 1000
            ) / 1000,
        },
      ];
    })
  );
}

function tournamentSection(variant: RemainingPolicyVariant) {
  const common = {
    id: 'tournament_prize_bounty',
    status: 'unavailable dependency',
    objectiveOwner: 'HorseTournamentUtility.evaluateTournamentUtilityDetailed (Phase 7)',
  };
  if (variant === 'pineapple')
    return {
      ...common,
      requiredOutcomeModel: 'none: there is no Pineapple tournament to model',
      refusals: ['tournament:pineapple_tournament_format_unavailable'],
      why: 'Pineapple has no tournament format: the tournament catalog excludes it, the tournament allowlist (supabase/migrations/20260912044409_remaining_tournament_variant_allowlist.sql) refuses it, remainingVariantSeatCap("pineapple", "tournament") is 0 and the live pack refuses a Pineapple tournament decision (pineapple_tournament_unapproved)',
    };
  return {
    ...common,
    requiredOutcomeModel:
      'paired whole tournaments to realized prize and bounty share of the funded pool (HorseTournamentLeague.realizedTournamentReturn), the Phase 8 contract shape',
    refusals: [
      `tournament:${variant}_whole_tournament_outcome_model_unavailable`,
      `tournament:qualified_${variant}_tournament_reference_population_unavailable`,
      `tournament:${variant}_tournament_thresholds_not_specified`,
    ],
    why: `HorseTournamentLeague deals NLH only; the ${variant} league tournament profile measures single-hand chip EV, which is not a prize objective; no source-qualified ${variant} tournament structure population exists; Spin never offers ${variant}; NLH tournament thresholds are not borrowed`,
  };
}

const TEMPLATES: Record<RemainingPolicyVariant, string> = {
  short_deck:
    'fn_cash_template_defaults (family shortdeck): six seats by default, the host may choose 2 to 8, not locked',
  pineapple:
    'fn_cash_template_defaults (family pineapple): six seats by default, the host may choose 2 to 8, not locked',
  flh: 'fn_cash_template_defaults (family holdem): Classic nine seats by default (choices 9 or 6), Action and Madness six by default (choices 2 to 9), not locked',
  flo8: 'fn_cash_template_defaults (family plo): six seats, locked',
};

function packSection(variant: RemainingPolicyVariant) {
  const pack = REMAINING_VARIANT_PACKS[variant];
  const published = getFullRakeConfig(STAKE.smallBlind, STAKE.bigBlind, variant);
  const profiles = profilesFor(variant);
  const rotationBlock = rotationBlockOf(variant);
  const pairsPerShard = rotationBlock * SHARD_BLOCKS[variant];
  const seeds = HOLDOUT[variant];
  const ceiling = ceilingOf(variant);
  const fixedLimit = isFixedLimit(variant);
  const depthBands = depthBandsOf(variant);
  const margin = marginOf(variant);
  return {
    variant,
    domain: `${variant}-cash-single-board-after-rake-horse-population`,
    structure: pack.structure,
    candidate: {
      owner: `HorseLogic.decide with phase12Remaining "candidate" (RemainingVariantLivePolicy over ${pack.version}), behind the P10.3 illegal_candidate guard`,
      packVersion: pack.version,
      packSource: REMAINING_VARIANT_DOMAIN.source,
      calibratedConfidence: REMAINING_VARIANT_DOMAIN.calibratedConfidence,
      structure: pack.structure,
      holes: pack.holes,
      deck: pack.deck,
      splitLow: pack.splitLow,
      discard:
        variant === 'pineapple'
          ? 'the flop discard is not a betting candidate: both arms discard through HorseLogic.decideDiscard seeded by (deal seed, seat), discards are counted separately (discards) and never as candidate changes'
          : 'none',
    },
    reference: {
      owner: 'HorseLogic.decide with phase12Remaining "off"',
      claim:
        'the action live tables execute today (Phase 12 runs in shadow, so live play takes the off action), under the harness conditions in liveConditions; not an external solver',
    },
    population: {
      variant,
      stake: STAKE,
      rake: {
        source: `getFullRakeConfig(1, 2, "${variant}") and getPlayerCountCaps(cap, tableSeats), server/src/config/RakeConfig.ts, as ServerTableEngineBase builds a cash hand`,
        percent: published.rakePercent,
        cap: published.rakeCap,
        noFlopNoDrop: true,
        playerCountCaps: {
          [SIX_MAX]: getPlayerCountCaps(published.rakeCap, SIX_MAX),
          [ceiling]: getPlayerCountCaps(published.rakeCap, ceiling),
        },
      },
      bbj: {
        source: `getFullRakeConfig(1, 2, "${variant}").bbjEnabled, bbjFeeBB and rules (a variant the jackpot does not cover drops nothing)`,
        enabled: published.bbjEnabled,
        feeBB: published.bbjFeeBB,
        minPotBB: published.rules.minPotBB,
        minPlayersDealt: published.rules.minPlayersDealt,
      },
      buyInBandBB: [CASH_MIN_BB, CASH_MAX_BB],
      ...(fixedLimit
        ? {
            legacyDepthBB: LEGACY_FIXED_LIMIT_BB,
            legacyDepthReason:
              'REMAINING_VARIANT_DOMAIN.fixedLimitMaxStackBB: an observed legacy FLO8 cash table permits a buy-in from 400 BB, and the pack supports fixed-limit depth through 1,000 BB with canonical wager and cap bounds (docs/horse-brain-phase12-round1.md); the deep-stack hand thresholds saturate at the existing deep endpoint, so this measures that exposure, not a calibrated 1,000 BB range',
          }
        : {}),
      cashSeatCeiling: maxSeatsForVariant(variant),
      tableSeats: [SIX_MAX, ceiling],
      currentTemplates: TEMPLATES[variant],
      tableSeatsReason: `six seats is the creator default for every template of ${variant} (${TEMPLATES[variant]}); ${ceiling} seats is the variant cash ceiling (maxSeatsForVariant and remainingVariantSeatCap), the largest table the pack supports, so it is measured as its own profile rather than assumed`,
      styles: PRODUCTION_HORSE_STYLES,
      styleRule:
        'remainingVariantStrengthSeatStyle(dealSeed, seat) (the Phase 10 production-style draw): uniform over the five production styles for every seat, hero included, identical in both arms',
      opponents:
        'HorseLogic.decide seats at the evaluated source with the production style mix, every one with phase12Remaining off, under the harness conditions in liveConditions',
      humanPopulation:
        'unavailable dependency (qualified human reference and independent holdout are P14-D); the cash qualification is scoped to the Horse population',
      excludedFromQualifiedDomain: [
        'antes and straddles (no profile; the Action and Madness templates carry antes and double-board bombs)',
        `tables other than six and ${ceiling} seats, dealt counts other than 2, 4, 6 and ${ceiling}, and stakes other than the published 1/2 row`,
        fixedLimit
          ? `depth outside the 40 to 200 BB cash buy-in band other than the legacy ${LEGACY_FIXED_LIMIT_BB} BB profile`
          : 'depth outside the 40 to 200 BB cash buy-in band',
        'bomb pots, multi-board and run-it-twice (Phase 13 boundaries)',
        variant === 'pineapple'
          ? 'every tournament format (Pineapple has none)'
          : 'every tournament format, Spin included (refused in tournament)',
      ],
    },
    tournament: tournamentSection(variant),
    holdout: {
      seeds,
      developmentSeeds: DEVELOPMENT_SEEDS,
      dealSeedRule:
        '(seed ^ Math.imul(pairIndex + 1, 2654435761)) >>> 0 || 1, as runOmahaPolicyLeague',
      seatingRule: 'plo4LeagueSeating(pairIndex, seats)',
    },
    regressionMargin: {
      lowerBoundAtLeastBbPer100: -margin,
      plannedHalfWidthMaxBbPer100: plannedMaxOf(variant),
      reason: fixedLimit
        ? 'fixed limit: 4 bb/100 is two big bets per 100 hands (the big bet is 2 BB), about a whole winning edge in fixed-limit cash, where strong edges are one to two big bets per 100; the no-limit margin of 10 bb/100 would be two and a half such edges and could not catch a domain that loses its whole edge'
        : 'no limit: 10 bb/100 is one 100 BB buy-in per 1,000 hands, about the size of a whole winning edge in no-limit cash (the Phase 10 and 11 number and reasoning)',
    },
    gatingCells: {
      count: profiles.length + POSITIONS.length + depthBands.length,
      depthBands,
    },
    matrix: {
      profiles,
      seeds,
      rotationBlock,
      pairsPerShard,
      pairsPerProfile: Object.fromEntries(
        profiles.map((p) => [p.id, p.shards * pairsPerShard * seeds.length])
      ),
      requiredShards: profiles.reduce((n, p) => n + p.shards, 0) * seeds.length,
      plannedGatingCells: remainingVariantPlannedHalfWidths(profiles, pairsPerShard),
      runner: `server/src/scripts/remainingVariantStrengthEvaluate.ts --variant=${variant} --output=<dir> --profile=<id> --seed=<s> --shard=<k> --contract`,
    },
  };
}

export const REMAINING_VARIANT_STRENGTH_CONTRACT = deepFreeze({
  schema: 'horse-phase12-strength-contract',
  version: 'remaining-variant-strength-contract-v1',
  phase: 'P12.2',
  locked:
    'by the merge of the pull request that introduced this file; the matrix of a pack is dispatched only against a commit on main that contains it, and no held-out hand is dealt before',
  independence:
    'each pack (short_deck, pineapple, flh, flo8) is qualified on its own matrix, seeds, margin and verdict; a pass for one pack never certifies another, and a shard of one pack is refused by name in another pack verdict',
  objectives: {
    cash: {
      id: 'cash_after_rake',
      status: 'measured',
      metric:
        'paired difference of the hero seat net chips per hand (final stack minus starting stack) after the engine rake and BBJ drop, candidate minus reference, reported in bb/100',
      excluded:
        'BBJ jackpot awards (paid by the database from the external pool after the hand, not in hand settlement)',
      verdict:
        'summarizeRemainingVariantStrength(variant, shards), server/src/benchmark/RemainingVariantStrengthContract.ts',
    },
    tournament:
      'refused by name per pack (packs.<variant>.tournament), never in the top-level verdict reasons',
  },
  packs: {
    short_deck: packSection('short_deck'),
    pineapple: packSection('pineapple'),
    flh: packSection('flh'),
    flo8: packSection('flo8'),
  },
  matrixRules: {
    shardRule: 'shard k plays pair indices [k * pairsPerShard, (k + 1) * pairsPerShard)',
    designPilot:
      'per pack: development seed 12101101, the smallest whole number of rotations (a multiple of seats squared) at or above 288 pairs per profile (288 at 2, 4 and 6 dealt, 320 at 8, 324 at 9), runRemainingVariantStrengthShard development mode, shard 0; recorded paired-difference standard deviation, kurtosis and time per pair only (never a mean, never a held-out seed); logs docs/evidence/phase12/pilot-<variant>.json',
    sizingRule: `shards per profile chosen so every gating cell's planned 99% half-width is at most ${HALF_WIDTH_TO_MARGIN} times the pack's regression margin at ${PLANNING_SD_FACTOR} times the pilot deviations, with at least ${MINIMUM_PAIRS_PER_PROFILE_IN_CELL} pairs per profile in every gating cell; pairsPerShard = rotationBlock x k, k the largest whole number keeping the slowest profile under about 25 minutes per shard on a GitHub-hosted runner at 2.5 times the pilot time per pair`,
    jobCeiling: `a pack's requiredShards is at most ${REMAINING_VARIANT_MATRIX_JOB_CEILING}, the GitHub Actions limit on jobs from one matrix; it overrides the 25-minute budget where both cannot hold`,
    kurtosisCheck:
      'every gating cell member has sqrt((pilot kurtosis - 1) / planned pairs) under 0.1 (matrix.plannedGatingCells), so the 10,000-pair floor assumption holds at the planned sizes',
    halfWidthToMargin: HALF_WIDTH_TO_MARGIN,
    planningSdFactor: PLANNING_SD_FACTOR,
    hostedBudget: { minutesPerShard: 25, pilotTimeFactor: 2.5 },
  },
  statistic: {
    unit: 'chip cents per paired hand (exact integers); bb/100 = mean cents / (BB * 100) * 100',
    pairing:
      'one deal seed per pair: identical cards, hero seat, button, seat styles, Pineapple discards and decision clock in both arms; candidate arm then reference arm',
    strata:
      'profile x seed x dealer-relative hero offset x divergence street, exact integer power sums n, S1..S4',
    divergence:
      'street of the first action at which the two arms differ (none, preflop, flop, turn, river; a Pineapple discard belongs to the flop, where it is made); identical action traces with a nonzero difference count as a paired replay mismatch',
    estimator:
      'stratified mean: equal weight per profile among the profiles in a cell, pairs pooled within a profile across seeds and shards',
  },
  interval: {
    method:
      'two-sided 99% normal (Wald) interval on the stratified mean: T +/- z * sqrt(sum w_p^2 s_p^2 / n_p), z = Phi^-1(0.995), s_p^2 the unbiased within-profile variance',
    z: Z99,
    // Validity of the normal approximation (Phase 10's guard, kept): the first
    // Edgeworth term of a one-sided bound's coverage error is
    // |k|(2z^2 + 1)phi(z)/6, k the skewness of the estimator itself. Capping it
    // at 0.001 keeps the one-sided 0.5% error rate below 0.6%. A cell that
    // fails it carries no claim (refused, never relaxed).
    edgeworthCoverageErrorMax: 0.001,
    // The variance estimate's relative standard error is about
    // sqrt((kurtosis - 1) / n): under 10% for kurtosis up to 100 at n = 10,000.
    // Fewer pairs in any profile of a gating cell and the interval is not
    // trusted. Every gating cell is planned well above this floor.
    minimumPairsPerProfileInCell: MINIMUM_PAIRS_PER_PROFILE_IN_CELL,
  },
  thresholds: {
    primary: {
      gate: "cash_after_rake 99% lower bound > 0 bb/100, the pack's profiles pooled with equal weight",
      lowerBoundAboveBbPer100: 0,
      // Zero is break-even after the house's take: any positive value means the
      // horse keeps more money than the reference against the same population
      // at the published rake and BBJ drop. The lower end of a two-sided 99%
      // interval bounds a false promotion at 0.5%. No positive effect-size
      // floor is set because no calibrated cost of switching exists in source.
      // Phase 10's reasoning, which depends neither on the variant nor on the
      // betting structure.
    },
    seedReplication: {
      gate: 'each held-out seed block of the pack: pooled stratified point estimate > 0 bb/100',
      pointEstimateAboveBbPer100: 0,
      // Three independent replication blocks fixed in advance. Requiring each
      // to point the same way keeps the improvement from resting on one block;
      // a zero true effect passes all three with probability 1/8 on top of the
      // primary bound. Phase 10's reasoning, unchanged.
    },
    nonregression: {
      gate: "every gating cell 99% lower bound >= the pack's regression margin (packs.<variant>.regressionMargin): -10 bb/100 for Short Deck and Pineapple, -4 bb/100 for FLH and FLO8",
      noLimitLowerBoundAtLeastBbPer100: -NO_LIMIT_MARGIN,
      fixedLimitLowerBoundAtLeastBbPer100: -FIXED_LIMIT_MARGIN,
      // The margin is about one whole winning edge for the game's betting
      // structure (reasons per pack). A domain that may lose more than that
      // against the reference can turn a break-even reference into a clear
      // loser there, whatever the pooled result. The shard counts plan every
      // gating cell's 99% half-width at or below 0.85 of the margin (1.2 times
      // the pilot deviations), so a cell that truly breaks even can show it.
      // Each cell is tested at 99% with no multiplicity relief: all must pass
      // (intersection-union).
    },
  },
  gatingCells: {
    rule: 'per pack: every profile, the six positions and every depth band the pack has (packs.<variant>.gatingCells.count: 15 for Short Deck and Pineapple, 17 for FLH and FLO8)',
    positions: POSITIONS,
    positionRule:
      'positionForOffset(offset, seats), the pack position names; heads-up offset 0 is button; at eight and nine seats the extra offsets are middle',
    effective:
      "every gating cell holds only pairs of its own domain (no zero padding), so its estimate is the domain mean; its 99% lower bound sits below the true domain mean with probability 99.5%, so a true domain loss of the pack's margin or more fails the gate with at least that probability, and at the planned half-widths (at most 0.85 of the margin) a domain that truly breaks even can pass",
    streetFamilies: {
      gate: false,
      families: ['preflop', 'flop', 'turn', 'river'],
      reported:
        'diagnostic only: each family as its contribution to the pooled bb/100 (zero for pairs that diverged elsewhere), with the share of pairs diverging there; the four contributions and the no-divergence pairs sum exactly to the primary estimate',
      whyNotAGate:
        "a contribution cell is diluted by every pair that did not diverge on its street, so a breach of the margin needs a conditional loss many times the margin and the cell cannot fail in practice (Phase 10: its four street cells spanned about +/-2.3 bb/100); a conditional cell (pairs diverging on that street only) has the right scale, but late-street divergences are a small and run-dependent share of pairs, so its pair count and skewness are not fixed before the run and its interval cannot be planned to resolve the margin at feasible sample sizes (Phase 11's handling, kept)",
    },
  },
  selectionGuard: {
    owner:
      'HorseLogic variant_policy: an applied Phase 12 candidate the legalizer would rewrite is refused (receipt.applied false, selectionRefusal "illegal_candidate") and the reference retained, the P10.3 law as P11.3 applies it',
    counted:
      'per shard as illegalCandidates (candidate-arm hero decisions refused by the guard), beside changed (applied candidate decisions), so the evidence shows how much of the candidate arm played the reference',
    gate: false,
    why: 'a refused candidate is the guarded candidate behaving as it would under admission (the reference is executed); it is reported, never gated, and never counted as changed',
  },
  liveConditions: {
    rule: 'each difference between this harness and a live cash table, with its handling: "addressed" means the harness now matches live play; "named limit" means it does not, and a qualification carries the limit',
    differences: [
      {
        id: 'mood',
        live: 'v9 mood on by default (HorseLogic.ts, (opts.v9Mood ?? opts.v9) !== false; the worker never sets it): moodOf(user_id, decisionTimeMs) shifts bluff frequency and aggression by the hour',
        harness:
          'v9 mood on in both arms; decisionTimeMs = remainingVariantMoodClockMs(dealSeed) = (dealSeed % 86400) * 1000, fixed by the deal seed and identical in both arms, so each seat mood is spread over the 24 hours of a day',
        handling: 'addressed',
      },
      {
        id: 'style_modifiers',
        live: 'resolveHorseStyle(player.horse_profile, ...).mods (ServerTableEngineTurns.ts), which carries the self-tuned multipliers',
        harness: 'empty style modifiers {}',
        handling:
          'named limit: the production self-tuned multipliers are per-horse database state that changes over time and is not available offline; no fixed snapshot is source-qualified',
      },
      {
        id: 'horsemind_history',
        live: 'opponent reads from accumulated HorseMind statistics',
        harness: 'a fresh HorseMind.createSandbox() per hand: no opponent history',
        handling:
          'named limit: the Phase 12 variant sampler (RemainingVariantSampler) conditions on the public action line only and reads no HorseMind statistic; but the reference path is HorseLogic, which does read HorseMind, and the candidate also takes from it the decision equity ceiling (phase12DecisionEquityCeiling) and falls back to the reference action wherever it does not fire, so both arms play without the opponent history they have live',
      },
      {
        id: 'policy_clock',
        live: `the real clock: RemainingVariantLivePolicy falls back to the reference action (reason work_budget) beyond REMAINING_VARIANT_DOMAIN.liveBudgetMs (${REMAINING_VARIANT_DOMAIN.liveBudgetMs} ms), and the sampler stops starting work at ${REMAINING_VARIANT_DOMAIN.samplingDeadlineMs} ms, which can truncate sampling`,
        harness:
          'phase12EvidenceMode: a fixed policy clock, so the fallback never fires and sampling completes its fixed work',
        handling:
          'named limit; P12.3 admission must also require natural completion-share evidence (admissionAlsoRequires)',
      },
      {
        id: 'second_look',
        live: 'the decision worker may take a deep second look at a decision',
        harness: 'HorseLogic.decide is called directly, once per decision',
        handling:
          'named limit: the second look is worker scheduling over live read frames, not reproducible offline',
      },
      {
        id: 'pineapple_discard',
        live: 'the worker chooses each Pineapple discard with HorseLogic.decideDiscard on the live random stream and clock, and the controller retains the private dead card',
        harness:
          'HorseLogic.decideDiscard seeded by (deal seed, seat) through the real HandController.performDiscard, identical in both arms; the controller retains the private dead card and the hero sees only its own',
        handling:
          'design: the discard is not a betting candidate and is the same in both arms, so the paired difference measures the betting policy only',
      },
      {
        id: 'field',
        live: 'under activation every cash horse seat of the variant switches to candidate together',
        harness:
          'one candidate seat against a reference field (every other seat phase12Remaining off)',
        handling:
          'design: the only design that measures strength against the horse population as it plays today; an all-candidate field measures self-play, which has no reference to beat',
      },
    ],
    admissionAlsoRequires: [
      'natural completion-share evidence for the pack: on the release under admission, the share of eligible live candidate-path betting decisions that complete without the work_budget fallback, per street, measured from natural decisions with the release unchanged throughout the window (Pineapple discard receipts counted apart from betting receipts); P12.3 must state and meet its own floor for that share before admitting the pack, because this contract measures strength only for decisions that complete',
    ],
  },
  softwareValidity: {
    perShard: {
      complete: 'pairs completed equals pairsPerShard',
      positionCoverage: 'every dealer-relative offset visited equally',
      illegalActions: 0,
      conservationErrors: 0,
      cardErrors: 0,
      truncatedHands: 0,
      settlementMismatches: 0,
      deductionMismatches: 0,
      pairedReplayMismatches: 0,
      fixedWork:
        'EQUITY_GOVERNOR off, scale 1, fixed-work policy clock, mood clock from the deal seed',
    },
    reportedNotGated: {
      illegalCandidates: 'candidate proposals the selection guard refused (selectionGuard)',
      discards: 'Pineapple discards made in each arm (never betting decisions)',
    },
    settlementReference:
      'settleRemainingReference (RemainingVariantReference.ts, Phase 12) for the pack variant: an independent high-hand scorer with the Short Deck wheel and flush-over-full-house order, the Pineapple retained pair (its discards and the third card of a seat folded before the discard checked as dead cards), and the exact-two/exact-three Omaha reference for FLO8, which settles high and low halves; no seat receives more than its independent gross award, losers receive nothing, and the shortfall equals rake plus BBJ drop',
    deductionReference:
      'effectiveRake and effectiveBbjDrop (config/rakeSpec.ts, the arithmetic the database implements) for the pack variant on the contested pot (Short Deck drops no jackpot fee)',
  },
  notStrengthGates: [
    'atlas coordinate count',
    'changed proposal count',
    'eligible decision count',
    'illegal candidate count',
  ],
  promotionEligible: false,
});

export type RemainingVariantStrengthContract = typeof REMAINING_VARIANT_STRENGTH_CONTRACT;
type PackSection = RemainingVariantStrengthContract['packs'][RemainingPolicyVariant];

/** sha256 of the contract's JSON. Runs, assemblies and qualification files bind it. */
export function remainingVariantStrengthContractDigest(): string {
  return createHash('sha256')
    .update(JSON.stringify(REMAINING_VARIANT_STRENGTH_CONTRACT))
    .digest('hex');
}
export function remainingVariantStrengthPack(variant: RemainingPolicyVariant): PackSection {
  if (!isRemainingVariantStrengthVariant(variant))
    throw new Error('Unknown Phase 12 strength variant');
  return REMAINING_VARIANT_STRENGTH_CONTRACT.packs[variant];
}
export function remainingVariantStrengthDomain(variant: RemainingPolicyVariant): string {
  return remainingVariantStrengthPack(variant).domain;
}
export function remainingVariantStrengthProfile(
  variant: RemainingPolicyVariant,
  id: string
): Readonly<RemainingVariantStrengthProfile> | undefined {
  if (!isRemainingVariantStrengthVariant(variant)) return undefined;
  return remainingVariantStrengthPack(variant).matrix.profiles.find((p) => p.id === id);
}
/** True for a held-out seed of the named pack. */
export function isRemainingVariantHoldoutSeedOf(
  variant: RemainingPolicyVariant,
  seed: number
): boolean {
  return (
    isRemainingVariantStrengthVariant(variant) &&
    (remainingVariantStrengthPack(variant).holdout.seeds as readonly number[]).includes(seed)
  );
}
/** True for a held-out seed of any Phase 12 pack. */
export function isRemainingVariantHoldoutSeed(seed: number): boolean {
  return REMAINING_VARIANT_STRENGTH_VARIANTS.some((v) => isRemainingVariantHoldoutSeedOf(v, seed));
}
export function remainingVariantStrengthShardKey(profileId: string, seed: number, shard: number) {
  return `${profileId}-${seed}-s${shard}`;
}
/** Every (profile, seed, shard) one pack's matrix requires, in a fixed order. */
export function remainingVariantStrengthRequiredShards(variant: RemainingPolicyVariant) {
  const pack = remainingVariantStrengthPack(variant);
  const out: {
    key: string;
    variant: string;
    profileId: string;
    seed: number;
    shard: number;
  }[] = [];
  for (const p of pack.matrix.profiles)
    for (const seed of pack.matrix.seeds)
      for (let shard = 0; shard < p.shards; shard++)
        out.push({
          key: remainingVariantStrengthShardKey(p.id, seed, shard),
          variant,
          profileId: p.id,
          seed,
          shard,
        });
  return out;
}

export const REMAINING_VARIANT_DIVERGENCE_STREETS = [
  'none',
  'preflop',
  'flop',
  'turn',
  'river',
] as const;
export type RemainingVariantDivergenceStreet =
  (typeof REMAINING_VARIANT_DIVERGENCE_STREETS)[number];

export interface RemainingVariantStrengthShardResult {
  schema: 'horse-phase12-strength-shard-v1';
  variant: RemainingPolicyVariant;
  contractVersion: string;
  contractDigest: string;
  packVersion: string;
  evidenceMode: 'contract' | 'development';
  profileId: string;
  seed: number;
  shard: number;
  firstPair: number;
  requestedPairs: number;
  pairs: number;
  complete: boolean;
  positionCoverageComplete: boolean;
  offsetCounts: number[];
  /** key `${offset}|${street}` */
  strata: Record<string, Plo4PowerSums>;
  pairDigest: string;
  candidateNetCents: number;
  referenceNetCents: number;
  changedPairs: number;
  decisions: number;
  eligible: number;
  /** Candidate-arm hero decisions whose applied proposal reached the table. */
  changed: number;
  /** Candidate-arm hero decisions whose proposal the selection guard refused
   * (`illegal_candidate`): the reference was played instead. Never in changed. */
  illegalCandidates: number;
  /** Pineapple discards made, both arms (zero for the other packs). Never a
   * betting decision and never a candidate change. */
  discards: number;
  illegalActions: number;
  conservationErrors: number;
  cardErrors: number;
  truncatedHands: number;
  settlementMismatches: number;
  deductionMismatches: number;
  pairedReplayMismatches: number;
  showdownsChecked: number;
  foldWinsChecked: number;
  /** Showdowns at which the reference awarded a low half (flo8 only). */
  lowHalvesChecked: number;
  totalRake: number;
  totalBbj: number;
  nodeCounts: Record<string, number>;
  reasons: Record<string, number>;
  equityWork: Record<string, number>;
  fixedWork: {
    governor: 'off';
    scale: 1;
    policyClock: string;
    moodClock: 'deal_seed_time_of_day';
  };
  durationMs: number;
  promotionEligible: false;
}

/** One profile's contribution to a cell: its weight and the selected pairs' sums
 * (n counts every pair in the profile sample; s1..s3 only the selected ones,
 * so unselected pairs enter as zeros where a contribution is measured). */
export interface RemainingVariantCellGroup {
  profileId: string;
  weight: number;
  n: number;
  s1: bigint;
  s2: bigint;
  s3: bigint;
}
export interface RemainingVariantCellStatistic {
  cell: string;
  profiles: string[];
  pairs: number;
  minimumProfilePairs: number;
  meanBbPer100: number;
  standardErrorBbPer100: number;
  confidence99BbPer100: [number, number];
  estimatorSkewness: number;
  edgeworthCoverageError: number;
  intervalTrusted: boolean;
}
const CENTS_PER_BB = REMAINING_VARIANT_STRENGTH_BB * 100;
const toBbPer100 = (cents: number) => (cents / CENTS_PER_BB) * 100;
const phi = (z: number) => Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI);

/** The stratified mean, its exact-sum standard error, the two-sided 99%
 * interval and the interval-validity guards, all from this contract. */
export function remainingVariantCellStatistic(
  cell: string,
  groups: RemainingVariantCellGroup[]
): RemainingVariantCellStatistic {
  const c = REMAINING_VARIANT_STRENGTH_CONTRACT.interval;
  let mean = 0,
    variance = 0,
    third = 0;
  for (const g of groups) {
    const n = BigInt(g.n);
    if (g.n < 2) {
      variance = Infinity;
      continue;
    }
    mean += g.weight * (Number(g.s1) / g.n);
    // Exact numerators, converted once: n(n-1)s^2 = n S2 - S1^2 and
    // n^3 mu3 = n^2 S3 - 3 n S1 S2 + 2 S1^3 (biased central third moment).
    const s2 = Number(n * g.s2 - g.s1 * g.s1) / (g.n * (g.n - 1));
    const mu3 = Number(n * n * g.s3 - 3n * n * g.s1 * g.s2 + 2n * g.s1 * g.s1 * g.s1) / g.n ** 3;
    variance += (g.weight ** 2 * s2) / g.n;
    third += (g.weight ** 3 * mu3) / g.n ** 2;
  }
  const se = Math.sqrt(variance);
  const skew = variance > 0 && Number.isFinite(variance) ? third / variance ** 1.5 : 0;
  const coverage = (Math.abs(skew) * (2 * c.z * c.z + 1) * phi(c.z)) / 6;
  const minimum = groups.length ? Math.min(...groups.map((g) => g.n)) : 0;
  const lo = mean - c.z * se,
    hi = mean + c.z * se;
  return {
    cell,
    profiles: groups.map((g) => g.profileId),
    pairs: groups.reduce((s, g) => s + g.n, 0),
    minimumProfilePairs: minimum,
    meanBbPer100: toBbPer100(mean),
    standardErrorBbPer100: toBbPer100(se),
    confidence99BbPer100: [toBbPer100(lo), toBbPer100(hi)],
    estimatorSkewness: skew,
    edgeworthCoverageError: coverage,
    intervalTrusted:
      groups.length > 0 &&
      Number.isFinite(se) &&
      minimum >= c.minimumPairsPerProfileInCell &&
      coverage <= c.edgeworthCoverageErrorMax,
  };
}

const COUNTERS = ['illegalCandidates', 'discards'] as const;
/** Reasons a shard cannot enter the named pack's verdict. Empty means it can. */
export function remainingVariantStrengthShardReasons(
  variant: RemainingPolicyVariant,
  r: RemainingVariantStrengthShardResult
): string[] {
  const c = REMAINING_VARIANT_STRENGTH_CONTRACT;
  const pack = remainingVariantStrengthPack(variant);
  const key = remainingVariantStrengthShardKey(r.profileId, r.seed, r.shard);
  const out: string[] = [];
  const profile = remainingVariantStrengthProfile(variant, r.profileId);
  if (r.schema !== 'horse-phase12-strength-shard-v1') out.push(`${key}:schema_mismatch`);
  if (r.variant !== variant) out.push(`${key}:variant_mismatch`);
  if (r.contractVersion !== c.version) out.push(`${key}:contract_version_mismatch`);
  if (r.contractDigest !== remainingVariantStrengthContractDigest())
    out.push(`${key}:contract_digest_mismatch`);
  if (r.packVersion !== pack.candidate.packVersion) out.push(`${key}:pack_version_mismatch`);
  if (r.evidenceMode !== 'contract') out.push(`${key}:not_contract_mode`);
  if (!profile) out.push(`${key}:unknown_profile`);
  if (!isRemainingVariantHoldoutSeedOf(variant, r.seed)) out.push(`${key}:not_holdout_seed`);
  if (!Number.isInteger(r.shard) || r.shard < 0 || !profile || r.shard >= profile.shards)
    out.push(`${key}:shard_outside_matrix`);
  if (r.firstPair !== r.shard * pack.matrix.pairsPerShard) out.push(`${key}:first_pair_mismatch`);
  if (r.requestedPairs !== pack.matrix.pairsPerShard) out.push(`${key}:pairs_below_contract`);
  if (!r.complete || r.pairs !== r.requestedPairs) out.push(`${key}:incomplete`);
  if (!r.positionCoverageComplete) out.push(`${key}:position_coverage_incomplete`);
  if (profile && r.offsetCounts.length !== profile.seats) out.push(`${key}:offset_count_mismatch`);
  if (new Set(r.offsetCounts).size > 1) out.push(`${key}:position_coverage_unbalanced`);
  const strataPairs = Object.values(r.strata).reduce((s, v) => s + v.n, 0);
  if (strataPairs !== r.pairs) out.push(`${key}:strata_pair_count_mismatch`);
  for (const k of Object.keys(r.strata)) {
    const [offset, street] = k.split('|');
    if (
      !profile ||
      !/^\d+$/.test(offset) ||
      Number(offset) >= profile.seats ||
      !(REMAINING_VARIANT_DIVERGENCE_STREETS as readonly string[]).includes(street)
    )
      out.push(`${key}:unknown_stratum:${k}`);
  }
  const none = Object.entries(r.strata).filter(([k]) => k.endsWith('|none'));
  if (none.some(([, v]) => v.s1 !== '0' || v.s2 !== '0')) out.push(`${key}:paired_replay_mismatch`);
  for (const field of [
    'illegalActions',
    'conservationErrors',
    'cardErrors',
    'truncatedHands',
    'settlementMismatches',
    'deductionMismatches',
    'pairedReplayMismatches',
  ] as const)
    if (r[field] !== 0) out.push(`${key}:${field}`);
  // Reported, never gated; but a shard that does not carry them is not one this
  // contract's runner wrote.
  for (const field of COUNTERS)
    if (!Number.isInteger(r[field]) || r[field] < 0) out.push(`${key}:${field}_unrecorded`);
  if (variant !== 'pineapple' && r.discards !== 0) out.push(`${key}:discards_outside_pineapple`);
  if (
    r.fixedWork?.governor !== 'off' ||
    r.fixedWork?.scale !== 1 ||
    r.fixedWork?.moodClock !== 'deal_seed_time_of_day'
  )
    out.push(`${key}:fixed_work_not_proven`);
  if (r.promotionEligible !== false) out.push(`${key}:shard_claims_promotion`);
  return out;
}

export interface RemainingVariantStreetDiagnostic extends RemainingVariantCellStatistic {
  gate: false;
  divergingPairs: number;
}
export interface RemainingVariantStrengthVerdict {
  variant: RemainingPolicyVariant;
  packVersion: string;
  domain: string;
  contractVersion: string;
  contractDigest: string;
  qualified: boolean;
  /** Cash failures only; they alone decide `qualified`. */
  reasons: string[];
  cash: {
    qualified: boolean;
    primary: RemainingVariantCellStatistic | null;
    seeds: RemainingVariantCellStatistic[];
    profiles: RemainingVariantCellStatistic[];
    positions: RemainingVariantCellStatistic[];
    depthBands: RemainingVariantCellStatistic[];
    gatingCells: number;
    regressionMarginBbPer100: number;
  };
  streetFamiliesDiagnostic: {
    gate: false;
    families: RemainingVariantStreetDiagnostic[];
    noDivergenceContributionBbPer100: number | null;
  };
  selectionGuard: { gate: false; illegalCandidates: number; changed: number };
  tournament: { status: string; qualified: false; reasons: readonly string[] };
  shardsUsed: number;
  promotionEligible: false;
}

/** One pack's whole-matrix verdict. Every required shard of that pack must be
 * present exactly once and valid; every gate is evaluated and every failure is
 * named. A shard of another pack is refused by name and never enters a cell. */
export function summarizeRemainingVariantStrength(
  variant: RemainingPolicyVariant,
  shards: RemainingVariantStrengthShardResult[]
): RemainingVariantStrengthVerdict {
  const c = REMAINING_VARIANT_STRENGTH_CONTRACT;
  const pack = remainingVariantStrengthPack(variant);
  const reasons: string[] = [];
  const seen = new Map<string, number>();
  const required = remainingVariantStrengthRequiredShards(variant);
  const requiredKeys = new Set(required.map((r) => r.key));
  const own: RemainingVariantStrengthShardResult[] = [];
  for (const s of shards) {
    const key = remainingVariantStrengthShardKey(s.profileId, s.seed, s.shard);
    seen.set(key, (seen.get(key) ?? 0) + 1);
    reasons.push(...remainingVariantStrengthShardReasons(variant, s));
    if (requiredKeys.has(key) && s.variant === variant) own.push(s);
  }
  for (const r of required) {
    const count = seen.get(r.key) ?? 0;
    if (count === 0) reasons.push(`${r.key}:missing_shard`);
    if (count > 1) reasons.push(`${r.key}:duplicate_shard`);
  }
  for (const key of seen.keys())
    if (!requiredKeys.has(key)) reasons.push(`${key}:unexpected_shard`);

  // Merge exact sums per profile x seed x offset x street, this pack only.
  const sums = new Map<string, Plo4PowerAccumulator>();
  for (const s of own)
    for (const [k, v] of Object.entries(s.strata)) {
      const key = `${s.profileId}|${s.seed}|${k}`;
      const acc = sums.get(key) ?? new Plo4PowerAccumulator();
      acc.merge(v);
      sums.set(key, acc);
    }
  const profiles = pack.matrix.profiles;
  type P = Readonly<RemainingVariantStrengthProfile>;
  type Pick = (p: P, seed: number, offset: number, street: string) => boolean;
  const group = (p: P, weight: number, inSample: Pick, selected: Pick) => {
    const g: RemainingVariantCellGroup & { selectedPairs: number } = {
      profileId: p.id,
      weight,
      n: 0,
      s1: 0n,
      s2: 0n,
      s3: 0n,
      selectedPairs: 0,
    };
    for (const [key, acc] of sums) {
      const [pid, seed, offset, street] = key.split('|');
      if (pid !== p.id || !inSample(p, Number(seed), Number(offset), street)) continue;
      g.n += acc.n;
      if (!selected(p, Number(seed), Number(offset), street)) continue;
      g.selectedPairs += acc.n;
      g.s1 += acc.s1;
      g.s2 += acc.s2;
      g.s3 += acc.s3;
    }
    return g;
  };
  const all: Pick = () => true;
  const equal = (cell: string, members: readonly P[], inSample: Pick, selected: Pick = inSample) =>
    remainingVariantCellStatistic(
      cell,
      members.map((p) => group(p, 1 / members.length, inSample, selected))
    );

  const primary = sums.size ? equal('primary', profiles, all) : null;
  const seeds = pack.matrix.seeds.map((seed) =>
    equal(`seed:${seed}`, profiles, (_p, s) => s === seed)
  );
  const profileCells = profiles.map((p) => equal(`profile:${p.id}`, [p], all));
  const positions = c.gatingCells.positions.map((position) => {
    const members = profiles.filter((p) =>
      Array.from({ length: p.seats }, (_, o) => positionForOffset(o, p.seats)).includes(position)
    );
    return equal(
      `position:${position}`,
      members,
      (p, _s, offset) => positionForOffset(offset, p.seats) === position
    );
  });
  const depthBands = pack.gatingCells.depthBands.map((band) =>
    equal(
      `depth:${band}`,
      profiles.filter((p) => p.depthBand === band),
      all
    )
  );
  const families = c.gatingCells.streetFamilies.families.map((street) => {
    const onStreet: Pick = (_p, _s, _o, st) => st === street;
    const stat = equal(`street:${street}`, profiles, all, onStreet);
    const divergingPairs = profiles
      .map((p) => group(p, 1, all, onStreet).selectedPairs)
      .reduce((s, n) => s + n, 0);
    return { ...stat, gate: false as const, divergingPairs };
  });
  const noDivergence = sums.size
    ? equal('street:none', profiles, all, (_p, _s, _o, st) => st === 'none').meanBbPer100
    : null;

  const t = c.thresholds;
  const margin = pack.regressionMargin.lowerBoundAtLeastBbPer100;
  if (!primary) reasons.push('cash:no_shard_results');
  else {
    if (!primary.intervalTrusted) reasons.push('cash:primary:interval_not_trusted');
    if (!(primary.confidence99BbPer100[0] > t.primary.lowerBoundAboveBbPer100))
      reasons.push('cash:primary:lower_bound_not_above_zero');
  }
  for (const s of seeds)
    if (!(s.meanBbPer100 > t.seedReplication.pointEstimateAboveBbPer100))
      reasons.push(`cash:${s.cell}:point_estimate_not_above_zero`);
  // The gating cells. Street families are diagnostics and never enter here.
  const gating = [...profileCells, ...positions, ...depthBands];
  for (const cell of gating) {
    if (!cell.intervalTrusted) reasons.push(`cash:${cell.cell}:interval_not_trusted`);
    if (!(cell.confidence99BbPer100[0] >= margin))
      reasons.push(`cash:${cell.cell}:regression_margin_exceeded`);
  }
  const cashQualified = reasons.length === 0;
  return {
    variant,
    packVersion: pack.candidate.packVersion,
    domain: pack.domain,
    contractVersion: c.version,
    contractDigest: remainingVariantStrengthContractDigest(),
    // The cash qualification of this pack is the only one this verdict can
    // grant; the tournament objective stays an unavailable dependency.
    qualified: cashQualified,
    reasons,
    cash: {
      qualified: cashQualified,
      primary,
      seeds,
      profiles: profileCells,
      positions,
      depthBands,
      gatingCells: gating.length,
      regressionMarginBbPer100: margin,
    },
    streetFamiliesDiagnostic: {
      gate: false,
      families,
      noDivergenceContributionBbPer100: noDivergence,
    },
    selectionGuard: {
      gate: false,
      illegalCandidates: own.reduce((n, s) => n + s.illegalCandidates, 0),
      changed: own.reduce((n, s) => n + s.changed, 0),
    },
    tournament: {
      status: pack.tournament.status,
      qualified: false,
      reasons: pack.tournament.refusals,
    },
    shardsUsed: own.length,
    promotionEligible: false,
  };
}
