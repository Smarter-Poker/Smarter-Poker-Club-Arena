import { priceDiamondCashRake, type DiamondCashRakeSchedule } from './diamondCashRakeSchedule.js';
import { priceDiamondCashJackpotDrop } from './diamondCashJackpotSchedule.js';

/** JSON-safe hand-frozen schedule for worker action economics. */
export type DiamondCashFeeSnapshot = string;
export function snapshotDiamondCashFees(schedule: DiamondCashRakeSchedule): DiamondCashFeeSnapshot {
  return JSON.stringify(schedule, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  );
}
export function decodeDiamondCashFees(snapshot: DiamondCashFeeSnapshot): DiamondCashRakeSchedule {
  const invalid = () => {
    throw new Error('diamond_cash_fee_snapshot_invalid');
  };
  if (typeof snapshot !== 'string' || snapshot.length > 20000) return invalid();
  const schedule = JSON.parse(snapshot, (key, value) => {
    if (key !== 'units') return value;
    if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return invalid();
    return BigInt(value);
  }) as DiamondCashRakeSchedule;
  if (
    !schedule ||
    typeof schedule.enabled !== 'boolean' ||
    !Number.isSafeInteger(schedule.bigBlind) ||
    schedule.bigBlind <= 0
  )
    return invalid();
  const exact = (value: unknown) => {
    const d = value as { units: bigint; scale: number } | null;
    return (
      !!d &&
      typeof d.units === 'bigint' &&
      d.units >= 0n &&
      Number.isInteger(d.scale) &&
      d.scale >= 0 &&
      d.scale <= 15
    );
  };
  if (
    schedule.enabled &&
    (typeof schedule.noFlopNoDrop !== 'boolean' ||
      schedule.rounding !== 'down' ||
      !exact(schedule.minPot) ||
      !['_heads_up', '_three_handed', ''].every(
        (k) =>
          exact(schedule.percent?.[k as keyof typeof schedule.percent]) &&
          exact(schedule.cap?.[k as keyof typeof schedule.cap])
      ))
  )
    return invalid();
  const jackpot = schedule.jackpot;
  if (
    jackpot &&
    (typeof jackpot.enabled !== 'boolean' ||
      typeof jackpot.miniEnabled !== 'boolean' ||
      ![
        jackpot.drop,
        jackpot.minDealtIn,
        jackpot.minPot,
        jackpot.miniAmount,
        jackpot.miniReserveFloor,
      ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      (jackpot.enabled && (jackpot.minDealtIn < 2 || jackpot.minDealtIn > 10)) ||
      !Array.isArray(jackpot.excludedVariants) ||
      !jackpot.excludedVariants.every((v) => typeof v === 'string') ||
      !jackpot.qualifyingHands ||
      typeof jackpot.qualifyingHands !== 'object' ||
      Object.values(jackpot.qualifyingHands).some((v) => typeof v !== 'string' || !v))
  )
    return invalid();
  return schedule;
}
export function priceDiamondCashFees(
  snapshot: DiamondCashFeeSnapshot,
  facts: {
    pot: number;
    dealtIn: number;
    sawFlop: boolean;
    variant: string;
    doubleBoard: boolean;
  }
): { rake: number; bbjFee: number } {
  const schedule = decodeDiamondCashFees(snapshot);
  const rake = priceDiamondCashRake(schedule, facts);
  const bbjFee = schedule.jackpot ? priceDiamondCashJackpotDrop(schedule.jackpot, facts) : 0;
  if (rake + bbjFee > facts.pot) throw new Error('diamond_jackpot_deductions_exceed_pot');
  return { rake, bbjFee };
}
