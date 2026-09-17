/** Spin pricing and Plinko denominations are amounts of diamonds, not prize multipliers. */
export const MIN_DIAMOND_SPIN = 25;
export const MAX_DIAMOND_SPIN = 2500;
export const PLINKO_DIAMONDS_PER_DROP = [1, 2, 4, 5, 10, 20, 25, 50, 100] as const;

export function validSpinAmount(amount: number): boolean {
  return Number.isSafeInteger(amount) && amount >= MIN_DIAMOND_SPIN && amount <= MAX_DIAMOND_SPIN;
}

export function plinkoAllocations(balance: number) {
  if (!Number.isSafeInteger(balance) || balance < MIN_DIAMOND_SPIN) {
    throw new Error('Choose A Valid Diamond Balance');
  }
  return PLINKO_DIAMONDS_PER_DROP.filter((value) => balance % value === 0).map((value) => ({
    diamondsPerDrop: value,
    drops: balance / value,
    totalDiamonds: balance,
  }));
}

export interface BonusBudget {
  base: number;
  doubled: boolean;
  denomination: number;
  /** The server-funded wheel entitlement. The original stake alone may be added. */
  award?: { id: string; entryDiamonds: number; boostMultiplier: 1 | 2 };
}
export const defaultBonusBudget = (): BonusBudget => ({
  base: 100,
  doubled: false,
  denomination: 1,
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
    ? budget
    : null;
}
/** Monetary prizes keep their cents even below the compact-number threshold. */
export const gameChips = (amount: number) =>
  amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
