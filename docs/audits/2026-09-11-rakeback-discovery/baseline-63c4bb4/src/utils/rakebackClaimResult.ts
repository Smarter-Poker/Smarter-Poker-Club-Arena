type ClaimResult =
  | { kind: 'paid'; amount: number; periods: number }
  | { kind: 'unpaid' }
  | { kind: 'refused'; message: string }
  | { kind: 'unconfirmed' };

function nonnegativeNumber(value: unknown): number {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER ? number : NaN;
}

/** Decode the installed fn_claim_rakeback aggregate, never infer success from RPC resolution. */
export function readRakebackClaimResult(value: unknown): ClaimResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'unconfirmed' };
  const result = value as Record<string, unknown>;
  if (result.success === false) {
    return {
      kind: 'refused',
      message:
        typeof result.error === 'string' && result.error.trim()
          ? result.error
          : 'Rakeback Claim Was Refused.',
    };
  }
  if (result.success !== true || (result.error !== undefined && result.error !== null)) {
    return { kind: 'unconfirmed' };
  }
  const amount = nonnegativeNumber(result.total_payout);
  const periods = nonnegativeNumber(result.periods_claimed);
  if (!Number.isFinite(amount) || !Number.isSafeInteger(periods)) return { kind: 'unconfirmed' };
  if (amount === 0 && periods === 0) return { kind: 'unpaid' };
  // The installed owner counts only successful positive lower-owner payouts.
  if (amount > 0 && periods > 0) return { kind: 'paid', amount, periods };
  return { kind: 'unconfirmed' };
}
