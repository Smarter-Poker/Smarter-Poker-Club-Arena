import {
  PLINKO_DENOMINATIONS,
  plinkoDropChoices,
  validPlinkoDenomination as validPlinkoDrop,
} from './diamondBonusPayout';

/** Spin pricing and Plinko drops are amounts of diamonds, not prize multipliers. */
export const MIN_DIAMOND_SPIN = 25;
export const MAX_DIAMOND_SPIN = 2500;
/**
 * THE PLAYER CHOOSES THE DROP (Dan, 2026-09-21, R6: "On Plinko the player must
 * choose how many diamonds to drop and the value of each drop. Today it is just
 * defaulted at 10 diamonds"). The value of one drop comes from the listed
 * values, or is the whole stake as a single drop; it must divide the stake
 * exactly, and the stake split by it is the number of drops, which the server
 * keeps between PLINKO_MIN_DROPS and PLINKO_MAX_DROPS. Nothing is pre-selected:
 * a budget whose `denomination` is null has not been chosen yet and cannot
 * start.
 *
 * ONE MIRROR OF ONE SERVER RULE. The rule itself lives in
 * utils/diamondBonusPayout (plinkoDropChoices), which mirrors migration
 * 20260921203512 byte for byte; this module only dresses it for the setup
 * panel. Written twice they disagreed: a stake with no listed divisor inside
 * the drop ceiling (2,497 diamonds, say) offered the player nothing to choose
 * and could never be played, while the server would have taken it as one drop.
 */
export { PLINKO_MIN_DROPS, PLINKO_MAX_DROPS } from './diamondBonusPayout';
export const PLINKO_DIAMONDS_PER_DROP = PLINKO_DENOMINATIONS;

export function validSpinAmount(amount: number): boolean {
  return Number.isSafeInteger(amount) && amount >= MIN_DIAMOND_SPIN && amount <= MAX_DIAMOND_SPIN;
}

export interface PlinkoAllocation {
  diamondsPerDrop: number;
  drops: number;
  totalDiamonds: number;
}
/** True when `value` is an offered drop value that splits `totalDiamonds` into an allowed number of drops. */
export function validPlinkoDenomination(
  totalDiamonds: number,
  value: number | null
): value is number {
  return typeof value === 'number' && validPlinkoDrop(totalDiamonds, value);
}
/** Every drop value the player may choose for this stake, smallest value (most drops) first. */
export function plinkoAllocations(totalDiamonds: number): PlinkoAllocation[] {
  return plinkoDropChoices(totalDiamonds).map((choice) => ({
    diamondsPerDrop: choice.denomination,
    drops: choice.drops,
    totalDiamonds,
  }));
}

export interface BonusBudget {
  base: number;
  doubled: boolean;
  /** Plinko only: the diamonds each drop plays, chosen by the player. Null until chosen. */
  denomination: number | null;
  /** The server-funded wheel entitlement. The original stake alone may be added. */
  award?: { id: string; entryDiamonds: number; boostMultiplier: 1 | 2 };
}
export const defaultBonusBudget = (): BonusBudget => ({
  base: 100,
  doubled: false,
  denomination: null,
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
/**
 * The same budget with a drop value that no longer fits its stake cleared, so
 * the player chooses again rather than starting on a split the server refuses.
 * A drop value is never invented here.
 */
export function plinkoBudget(budget: BonusBudget): BonusBudget {
  if (budget.denomination === null || !validBonusBudget(budget)) return budget;
  return validPlinkoDenomination(bonusTotal(budget), budget.denomination)
    ? budget
    : { ...budget, denomination: null };
}
/** True when the player has chosen a drop value the server accepts for this stake. */
export const validPlinkoBudget = (budget: BonusBudget) =>
  validBonusBudget(budget) && validPlinkoDenomination(bonusTotal(budget), budget.denomination);
/** How many drops a chosen budget plays, or null before the choice is made. */
export const plinkoDrops = (budget: BonusBudget): number | null =>
  validPlinkoBudget(budget) ? bonusTotal(budget) / (budget.denomination as number) : null;

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
    // A Plinko receipt names the drop value it was dealt; every other game has none.
    denomination: typeof value.diamonds_per_drop === 'number' ? value.diamonds_per_drop : null,
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
