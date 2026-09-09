/**
 * Scale winners' pre-rake amounts down to the post-rake total in whole cents.
 * Shared by authoritative settlement and the off-thread all-in EV oracle so
 * both use identical penny placement and never drift on side pots or ties.
 */
export function scaleWinnerCentsForRake(
  preRakeAmounts: readonly number[],
  totalWinnings: number
): number[] {
  const totalCents = Math.round(totalWinnings * 100);
  const entitlementCents = preRakeAmounts.map((amount) => Math.round(amount * 100));
  const totalWinnerCents = entitlementCents.reduce((sum, cents) => sum + cents, 0) || 1;
  const adjusted = entitlementCents.map((cents) =>
    Math.round((cents * totalCents) / totalWinnerCents)
  );

  let remainder = totalCents - adjusted.reduce((sum, cents) => sum + cents, 0);
  let placedOne = true;
  while (remainder > 0 && placedOne) {
    placedOne = false;
    for (let index = 0; index < adjusted.length && remainder > 0; index++) {
      if (adjusted[index] >= entitlementCents[index]) continue;
      adjusted[index]++;
      remainder--;
      placedOne = true;
    }
  }

  let pulledOne = true;
  while (remainder < 0 && pulledOne) {
    pulledOne = false;
    for (let index = 0; index < adjusted.length && remainder < 0; index++) {
      if (adjusted[index] <= 0) continue;
      adjusted[index]--;
      remainder++;
      pulledOne = true;
    }
  }
  return adjusted;
}
