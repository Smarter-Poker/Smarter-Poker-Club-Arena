/** A positively observed policy decision, never a substitute for a lease. */
export interface CashTablePolicyRefusal {
  readonly code: 'diamond_cash_disabled';
  readonly tableId: string;
  readonly arenaId: string;
}

export class DiamondCashPolicyClosedError extends Error implements CashTablePolicyRefusal {
  readonly code = 'diamond_cash_disabled' as const;

  constructor(
    readonly tableId: string,
    readonly arenaId: string
  ) {
    super('Diamond Cash Games Are Not Open');
    this.name = 'DiamondCashPolicyClosedError';
  }
}

/** Only an error-free, correctly bound explicit false is a normal closure. */
export function assertDiamondCashSettingsOpen(
  tableId: string,
  arenaId: string,
  data: unknown,
  error: unknown
): void {
  if (error !== null) {
    const message =
      error &&
      typeof error === 'object' &&
      typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : 'unknown read error';
    // Preserve transient classification as well as the original error object.
    throw new Error(`Diamond cash settings read failed: ${message}`, { cause: error });
  }
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    (data as { club_id?: unknown }).club_id !== arenaId ||
    typeof (data as { cash_games_enabled?: unknown }).cash_games_enabled !== 'boolean'
  ) {
    throw new Error('Diamond cash settings are unavailable or malformed');
  }
  if ((data as { cash_games_enabled: boolean }).cash_games_enabled === false) {
    throw new DiamondCashPolicyClosedError(tableId, arenaId);
  }
}
