import { createHash } from 'node:crypto';
import { computePrizeLadder, prizePoolAvailableToPlaces } from '../tournament/payoutMath.js';
import { tournamentUnitCents } from '../tournament/tournamentUnit.js';

export interface HorseFinalizedPrizeLadder {
  version: 'horse-finalized-prize-ladder-v1';
  finalized: true;
  tournamentId: string;
  source: 'tournaments+clubs/canonical-payout-v1';
  poolCents: number;
  unitCents: number;
  prizesCents: number[];
  bubbleProtection: boolean;
  bubbleReserveCents: number;
  /** Content binding of these original observed terms, not a settlement certificate. */
  sourceDigest: string;
}

/** Absent version means legacy/unread, never finalized or cent-denominated. */
export interface HorseTournamentPayoutTerms {
  payoutTermsVersion?: 1;
  prizePoolFinalized?: boolean | null;
  bubbleProtection?: boolean | null;
  prizeUnitCents?: number | null;
  finalizedPrizeLadder?: HorseFinalizedPrizeLadder;
}

function ladderDigest(value: Omit<HorseFinalizedPrizeLadder, 'sourceDigest'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        value.version,
        value.finalized,
        value.tournamentId,
        value.source,
        value.poolCents,
        value.unitCents,
        value.prizesCents,
        value.bubbleProtection,
        value.bubbleReserveCents,
      ])
    )
    .digest('hex');
}

export function captureHorseTournamentPayoutTerms(
  row: {
    id?: string;
    prize_pool_finalized?: unknown;
    bubble_protection?: unknown;
    payout_club?: unknown;
    prize_pool: unknown;
    buy_in_amount?: unknown;
    is_bounty?: unknown;
    is_pko?: unknown;
    is_mystery_bounty?: unknown;
  },
  places: Array<{ place: number; percentage: number }> | null,
  finalField: number,
  isSatellite: boolean
): HorseTournamentPayoutTerms {
  const finalized = typeof row.prize_pool_finalized === 'boolean' ? row.prize_pool_finalized : null;
  const bubble = typeof row.bubble_protection === 'boolean' ? row.bubble_protection : null;
  const club = row.payout_club;
  const observedClub =
    club === null ||
    (club !== undefined &&
      typeof club === 'object' &&
      !Array.isArray(club) &&
      typeof (club as any).asset === 'string' &&
      (typeof (club as any).is_platform === 'boolean' || (club as any).is_platform === null) &&
      (typeof (club as any).union_id === 'string' || (club as any).union_id === null));
  const unit = observedClub
    ? tournamentUnitCents(club as Parameters<typeof tournamentUnitCents>[0])
    : null;
  const captured: HorseTournamentPayoutTerms = {
    payoutTermsVersion: 1,
    prizePoolFinalized: finalized,
    bubbleProtection: bubble,
    prizeUnitCents: unit,
  };
  // These terms describe the observed source interval already carried by the
  // context provenance. They neither close entry nor authorize an award.
  if (
    finalized !== true ||
    bubble === null ||
    unit === null ||
    !row.id ||
    !places?.length ||
    isSatellite ||
    row.is_bounty === true ||
    row.is_pko === true ||
    row.is_mystery_bounty === true
  )
    return captured;
  const sorted = places.slice().sort((a, b) => a.place - b.place);
  if (
    !Number.isSafeInteger(finalField) ||
    finalField < sorted.length ||
    sorted.some((place, i) => place.place !== i + 1)
  )
    return captured;
  const pool = Number(row.prize_pool);
  const ladderPool = prizePoolAvailableToPlaces(
    pool,
    sorted,
    finalField,
    bubble,
    Number(row.buy_in_amount)
  );
  if (ladderPool === null || !(pool > 0)) return captured;
  const poolCents = Math.round(pool * 100);
  const ladder = computePrizeLadder(ladderPool, sorted, unit);
  const prizesCents = sorted.map(({ place }) => Math.round((ladder.get(place) ?? 0) * 100));
  const bubbleReserveCents = poolCents - Math.round(ladderPool * 100);
  if (
    !Number.isSafeInteger(poolCents) ||
    poolCents % unit !== 0 ||
    prizesCents.some((prize) => !Number.isSafeInteger(prize) || prize < 0 || prize % unit !== 0) ||
    prizesCents.reduce((sum, prize) => sum + prize, bubbleReserveCents) !== poolCents
  )
    return captured;
  const terms: Omit<HorseFinalizedPrizeLadder, 'sourceDigest'> = {
    version: 'horse-finalized-prize-ladder-v1',
    finalized: true,
    tournamentId: row.id,
    source: 'tournaments+clubs/canonical-payout-v1',
    poolCents,
    unitCents: unit,
    prizesCents,
    bubbleProtection: bubble,
    bubbleReserveCents,
  };
  captured.finalizedPrizeLadder = { ...terms, sourceDigest: ladderDigest(terms) };
  return captured;
}

/** New captures validate strictly; absence remains compatible with legacy replay. */
export function validHorseTournamentPayoutTerms(
  value: HorseTournamentPayoutTerms & { tournamentId?: string | null }
): boolean {
  if (value.payoutTermsVersion === undefined)
    return (
      value.prizePoolFinalized === undefined &&
      value.bubbleProtection === undefined &&
      value.prizeUnitCents === undefined &&
      value.finalizedPrizeLadder === undefined
    );
  if (
    value.payoutTermsVersion !== 1 ||
    ![true, false, null].includes(value.prizePoolFinalized as any) ||
    ![true, false, null].includes(value.bubbleProtection as any) ||
    ![1, 100, null].includes(value.prizeUnitCents as any)
  )
    return false;
  const ladder = value.finalizedPrizeLadder;
  if (ladder === undefined) return true;
  if (
    !ladder ||
    ladder.version !== 'horse-finalized-prize-ladder-v1' ||
    ladder.finalized !== true ||
    value.prizePoolFinalized !== true ||
    ladder.source !== 'tournaments+clubs/canonical-payout-v1' ||
    ladder.tournamentId !== value.tournamentId ||
    typeof ladder.tournamentId !== 'string' ||
    !ladder.tournamentId ||
    ladder.unitCents !== value.prizeUnitCents ||
    ladder.bubbleProtection !== value.bubbleProtection ||
    !Number.isSafeInteger(ladder.poolCents) ||
    ladder.poolCents <= 0 ||
    ladder.poolCents % ladder.unitCents !== 0 ||
    !Number.isSafeInteger(ladder.bubbleReserveCents) ||
    ladder.bubbleReserveCents < 0 ||
    ladder.bubbleReserveCents % ladder.unitCents !== 0 ||
    (!ladder.bubbleProtection && ladder.bubbleReserveCents !== 0) ||
    !Array.isArray(ladder.prizesCents) ||
    !ladder.prizesCents.length ||
    ladder.prizesCents.some(
      (prize) => !Number.isSafeInteger(prize) || prize < 0 || prize % ladder.unitCents !== 0
    ) ||
    ladder.prizesCents.reduce((sum, prize) => sum + prize, ladder.bubbleReserveCents) !==
      ladder.poolCents
  )
    return false;
  return ladder.sourceDigest === ladderDigest(ladder);
}
