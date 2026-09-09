import {
  SPIN_BLINDS,
  SPIN_SEATS,
  SPIN_TIERS,
  spinBlindsForLevel,
  spinRakeRate,
} from '../config/spinSpec.js';
import { isDeepStrictEqual } from 'node:util';

export type SpinBlind = {
  level: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  duration: number;
  spinContinuation?: {
    version: 1;
    anchorLevel: number;
    anchorBigBlind: number;
    growth: number;
    roundBigTo: number;
  };
};
export type SpinPayout = { place: number; percentage: number };
export type SpinLockedTier = { multiplier: number; reason?: string; unlocksAt?: number };
export type FundedSpinDraw = {
  multiplier: number;
  prizePool: number;
  startingChips: number;
  blinds: SpinBlind[];
  payouts: SpinPayout[];
  locked: SpinLockedTier[];
  ruleHash: string;
  provenance: 'at_draw' | 'legacy_projection';
};

// Freeze all selection and play rules before entering the one database call.
// The approved Spin specification remains the only source of future rules.
export function spinRuleManifest(buyIn: number, startingChips: number) {
  return {
    version: 1,
    buy_in: buyIn,
    seats: SPIN_SEATS,
    rake_rate: spinRakeRate(buyIn),
    starting_chips: startingChips,
    tiers: SPIN_TIERS.map((tier) => ({
      ...tier,
      payouts: [...tier.payouts],
      blind_structure: Array.from({ length: 12 }, (_, i) => {
        const b = spinBlindsForLevel(i + 1);
        return {
          level: i + 1,
          smallBlind: b.small,
          bigBlind: b.big,
          ante: 0,
          duration: tier.levelMinutes * 60,
          ...(i === 11
            ? {
                spinContinuation: {
                  version: 1 as const,
                  anchorLevel: SPIN_BLINDS.length,
                  anchorBigBlind: SPIN_BLINDS[SPIN_BLINDS.length - 1].big,
                  growth: 1.4,
                  roundBigTo: 10,
                },
              }
            : {}),
        };
      }),
      payout_structure: tier.payouts.map((pct, i) => ({
        place: i + 1,
        percentage: Math.round(pct * 10000) / 100,
      })),
    })),
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Spin receipt contains a missing or malformed object');
  }
  return value as Record<string, unknown>;
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// No local tier fallback. Recovery takes every play rule from the booked
// receipt, even when this binary's specification has since changed.
export function readFundedSpinDraw(
  value: unknown,
  expected: { tournamentId: string; launchId: string; buyIn: number }
): FundedSpinDraw {
  const r = object(value);
  const manifest = object(r.rule_manifest);
  if (
    r.ok !== true ||
    r.tournament_id !== expected.tournamentId ||
    r.launch_id !== expected.launchId ||
    r.buy_in !== expected.buyIn ||
    !positive(r.multiplier) ||
    !positive(r.prize_pool) ||
    r.prize_pool !== Math.round(expected.buyIn * r.multiplier * 100) / 100 ||
    r.pool_covered !== r.prize_pool ||
    r.operator_shortfall !== 0 ||
    !positive(r.starting_chips) ||
    !Number.isInteger(r.starting_chips) ||
    typeof r.rule_sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(r.rule_sha256) ||
    !['at_draw', 'legacy_projection'].includes(String(r.rule_provenance)) ||
    manifest.version !== 1 ||
    manifest.buy_in !== expected.buyIn ||
    manifest.seats !== SPIN_SEATS ||
    manifest.starting_chips !== r.starting_chips
  ) {
    throw new Error('Spin receipt does not prove the exact funded result and rule version');
  }
  if (
    !Array.isArray(r.entrants) ||
    r.entrants.length !== SPIN_SEATS ||
    new Set(r.entrants.map((p) => object(p).user_id)).size !== SPIN_SEATS ||
    new Set(r.entrants.map((p) => object(p).registration_id)).size !== SPIN_SEATS ||
    r.entrants.some(
      (p) => typeof object(p).user_id !== 'string' || typeof object(p).registration_id !== 'string'
    )
  ) {
    throw new Error('Spin receipt has no complete distinct funded entrant set');
  }
  if (
    !Array.isArray(r.blind_structure) ||
    r.blind_structure.length !== 12 ||
    r.blind_structure.some((b, i) => {
      const row = object(b);
      return (
        row.level !== i + 1 ||
        !positive(row.smallBlind) ||
        !positive(row.bigBlind) ||
        row.bigBlind < row.smallBlind ||
        !positive(row.duration) ||
        row.ante !== 0
      );
    }) ||
    !Array.isArray(r.payout_structure) ||
    r.payout_structure.length < 1 ||
    r.payout_structure.length > SPIN_SEATS ||
    r.payout_structure.some(
      (p, i) => object(p).place !== i + 1 || !positive(object(p).percentage)
    ) ||
    Math.abs(r.payout_structure.reduce((sum, p) => sum + Number(object(p).percentage), 0) - 100) >
      1e-9
  ) {
    throw new Error('Spin receipt has no valid stored blind and payout structure');
  }
  const continuation = continueBookedSpinBlinds(object(r.blind_structure[11]), 13);
  if (r.rule_provenance === 'at_draw' && !continuation) {
    throw new Error('Spin receipt is missing its frozen overflow blind rules');
  }
  const rules =
    r.rule_provenance === 'at_draw'
      ? Array.isArray(manifest.tiers)
        ? manifest.tiers.map(object).find((t) => t.multiplier === r.multiplier)
        : undefined
      : manifest;
  if (
    !rules ||
    !isDeepStrictEqual(rules.blind_structure, r.blind_structure) ||
    !isDeepStrictEqual(rules.payout_structure, r.payout_structure) ||
    (r.rule_provenance === 'legacy_projection' &&
      (manifest.probability_snapshot !== null || manifest.multiplier !== r.multiplier))
  ) {
    throw new Error('Spin result disagrees with its frozen rules');
  }
  if (
    !Array.isArray(r.locked) ||
    r.locked.some((tier) => {
      const t = object(tier);
      return !positive(t.multiplier) || (t.unlocksAt !== undefined && !positive(t.unlocksAt));
    })
  ) {
    throw new Error('Spin receipt contains malformed locked tiers');
  }
  return {
    multiplier: r.multiplier,
    prizePool: r.prize_pool,
    startingChips: r.starting_chips,
    blinds: r.blind_structure as SpinBlind[],
    payouts: r.payout_structure as SpinPayout[],
    locked: r.locked as SpinLockedTier[],
    ruleHash: r.rule_sha256,
    provenance: r.rule_provenance as FundedSpinDraw['provenance'],
  };
}

// This versioned formula and its anchor travel in the persisted final blind
// row. Running recovery therefore needs no new database read, and newer local
// specification constants cannot change levels beyond the first twelve.
export function continueBookedSpinBlinds(
  lastRow: Record<string, unknown>,
  level: number
): { small: number; big: number } | null {
  if (lastRow.spinContinuation === undefined) return null; // legacy projection
  const c = object(lastRow.spinContinuation);
  if (
    c.version !== 1 ||
    !positive(c.anchorLevel) ||
    !Number.isInteger(c.anchorLevel) ||
    !positive(c.anchorBigBlind) ||
    !positive(c.growth) ||
    c.growth <= 1 ||
    !positive(c.roundBigTo) ||
    !positive(level)
  ) {
    throw new Error('Spin blind continuation is missing its frozen formula');
  }
  const big =
    Math.round((c.anchorBigBlind * Math.pow(c.growth, level - c.anchorLevel)) / c.roundBigTo) *
    c.roundBigTo;
  if (!positive(big)) throw new Error('Spin blind continuation overflowed its stored formula');
  return { small: Math.round(big / 2), big };
}
