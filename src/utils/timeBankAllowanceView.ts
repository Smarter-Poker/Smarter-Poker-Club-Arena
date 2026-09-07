export interface VisibleTimeBankAllowance {
  remaining: number | null;
  unlimited: boolean;
}

/**
 * Account-scoped Time Bank state must be masked during the render in which an
 * auth identity changes. Waiting for an effect would expose the previous
 * account's finite balance and could temporarily enable the wrong controls.
 */
export function visibleTimeBankAllowance(
  ownerUserId: string | undefined,
  activeUserId: string | undefined,
  remaining: number | null,
  unlimited: boolean
): VisibleTimeBankAllowance {
  if (ownerUserId !== activeUserId) return { remaining: null, unlimited: false };
  return { remaining, unlimited: unlimited === true };
}
