/**
 * Prove that a launch snapshot still contains every chip bought into the
 * field. A normal MTT may carry an explicitly funded bonus above the starting
 * floor. A played-Spin recovery is different: its database proof identifies
 * the exact three bought stacks, so even one unreceipted excess chip is a
 * refusal.
 */
export function launchStacksMeetFundingFloor(
  rawStacks: readonly unknown[],
  startingChips: number,
  fundedSeatCount = rawStacks.length,
  requireExactTotal = false
): boolean {
  if (!Number.isFinite(startingChips) || startingChips < 0) return false;
  if (!Number.isInteger(fundedSeatCount) || fundedSeatCount < rawStacks.length) return false;

  let total = 0;
  for (const rawStack of rawStacks) {
    const stack = Number(rawStack);
    if (!Number.isFinite(stack) || stack < 0) return false;
    total += stack;
  }
  const fundedTotal = fundedSeatCount * startingChips;
  return requireExactTotal ? total === fundedTotal : total >= fundedTotal;
}
