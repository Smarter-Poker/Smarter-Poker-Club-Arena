/** Spin pricing and Plinko drops are amounts of diamonds, not prize multipliers. */
export const MIN_DIAMOND_SPIN = 25;
export const MAX_DIAMOND_SPIN = 2500;
/**
 * Every Plinko game is ten drops of a tenth of the entry. Nobody chooses a drop
 * value: at one to five diamonds a drop a 2,500-diamond award was hundreds of
 * drops whose average could only ever be the table's 0.80, so the game could
 * never return more than its entry. Ten drops is one setting, built into the
 * payout maths, and the server refuses any other split.
 */
export const PLINKO_DROPS = 10;

export function validSpinAmount(amount: number): boolean {
  return Number.isSafeInteger(amount) && amount >= MIN_DIAMOND_SPIN && amount <= MAX_DIAMOND_SPIN;
}

/** The diamonds each of the ten drops plays, or null when the entry does not split into whole diamonds. */
export function plinkoDenomination(totalDiamonds: number): number | null {
  return Number.isSafeInteger(totalDiamonds) &&
    totalDiamonds > 0 &&
    totalDiamonds % PLINKO_DROPS === 0
    ? totalDiamonds / PLINKO_DROPS
    : null;
}

export interface BonusBudget {
  base: number;
  doubled: boolean;
  /** Plinko only: the diamonds each drop plays. Always the tenth of the entry. */
  denomination: number;
  /** The server-funded wheel entitlement. The original stake alone may be added. */
  award?: { id: string; entryDiamonds: number; boostMultiplier: 1 | 2 };
}
export const defaultBonusBudget = (): BonusBudget => ({
  base: 100,
  doubled: false,
  denomination: 10,
});
export const bonusAdded = (budget: BonusBudget) =>
  budget.doubled ? (budget.award?.entryDiamonds ?? budget.base) : 0;
export const bonusTotal = (budget: BonusBudget) => budget.base + bonusAdded(budget);
export const bonusWalletDebit = (budget: BonusBudget) =>
  budget.award ? bonusAdded(budget) : bonusTotal(budget);
export function validBonusBudget(budget: BonusBudget): boolean {
  const award = budget.award;
  return (
    typeof budget.doubled === 'boolean' &&
    (award
      ? /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(award.id) &&
        validSpinAmount(award.entryDiamonds) &&
        [1, 2].includes(award.boostMultiplier) &&
        budget.base === award.entryDiamonds * award.boostMultiplier
      : validSpinAmount(budget.base))
  );
}
/** The same budget with its Plinko drop value derived from the entry, never chosen. */
export function plinkoBudget(budget: BonusBudget): BonusBudget {
  const denomination = validBonusBudget(budget) ? plinkoDenomination(bonusTotal(budget)) : null;
  return denomination === null || denomination === budget.denomination
    ? budget
    : { ...budget, denomination };
}
/** True when the budget's drop value is the tenth of its entry, as the server requires. */
export const validPlinkoBudget = (budget: BonusBudget) =>
  validBonusBudget(budget) && plinkoDenomination(bonusTotal(budget)) === budget.denomination;

/** A larger game receipt is valid only with the complete wheel funding identity. */
export function earnedReceiptBudget(value: Record<string, unknown>): BonusBudget | null {
  const bonus = value.bonus as Record<string, unknown> | undefined;
  if (
    !bonus ||
    typeof value.award_id !== 'string' ||
    ![
      bonus.base_diamonds,
      bonus.entry_diamonds,
      bonus.boost_multiplier,
      bonus.added_diamonds,
      bonus.total_diamonds,
    ].every((v) => typeof v === 'number')
  )
    return null;
  const budget: BonusBudget = {
    base: Number(bonus.base_diamonds),
    doubled: bonus.added_diamonds !== 0,
    denomination: 1,
    award: {
      id: value.award_id,
      entryDiamonds: Number(bonus.entry_diamonds),
      boostMultiplier: Number(bonus.boost_multiplier) as 1 | 2,
    },
  };
  return validBonusBudget(budget) &&
    bonusAdded(budget) === bonus.added_diamonds &&
    bonusTotal(budget) === bonus.total_diamonds &&
    bonus.total_diamonds === value.bet_diamonds
    ? plinkoBudget(budget)
    : null;
}
/** Monetary prizes keep their cents even below the compact-number threshold. */
export const gameChips = (amount: number) =>
  amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
