/** A request ID binds the original amount, even if a wallet refresh changes the shortfall. */
export interface AutoTopUpRequest {
  hand: number;
  key: string;
  amount: number;
}

export function autoTopUpRequest(
  previous: AutoTopUpRequest | null,
  hand: number,
  amount: number,
  createId: () => string = () => crypto.randomUUID()
): AutoTopUpRequest | null {
  if (!Number.isSafeInteger(hand) || hand < 0) return null;
  if (previous?.hand === hand) return previous;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { hand, amount, key: createId() };
}
