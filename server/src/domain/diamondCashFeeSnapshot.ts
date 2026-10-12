import { priceDiamondCashRake, type DiamondCashRakeSchedule } from './diamondCashRakeSchedule.js';
import { priceDiamondCashJackpotDrop } from './diamondCashJackpotSchedule.js';

/** JSON-safe hand-frozen schedule for worker action economics. */
export type DiamondCashFeeSnapshot = string;
export function snapshotDiamondCashFees(schedule: DiamondCashRakeSchedule): DiamondCashFeeSnapshot {
  return JSON.stringify(schedule, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  );
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
  const schedule = JSON.parse(snapshot, (key, value) =>
    key === 'units' ? BigInt(value) : value
  ) as DiamondCashRakeSchedule;
  const rake = priceDiamondCashRake(schedule, facts);
  const bbjFee = schedule.jackpot ? priceDiamondCashJackpotDrop(schedule.jackpot, facts) : 0;
  if (rake + bbjFee > facts.pot) throw new Error('diamond_jackpot_deductions_exceed_pot');
  return { rake, bbjFee };
}
