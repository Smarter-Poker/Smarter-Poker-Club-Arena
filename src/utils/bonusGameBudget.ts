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
}
export const defaultBonusBudget = (): BonusBudget => ({
  base: 100,
  doubled: false,
  denomination: 1,
});
export const bonusTotal = (budget: BonusBudget) => budget.base * (budget.doubled ? 2 : 1);
/** Monetary prizes keep their cents even below the compact-number threshold. */
export const gameChips = (amount: number) =>
  amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
