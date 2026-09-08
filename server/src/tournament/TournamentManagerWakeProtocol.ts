/**
 * One manager wake row is a level-triggered receipt. Repeated actions may
 * advance its generation while it is still pending, so completion is exact on
 * both identity and generation rather than identity alone.
 */
export interface TournamentManagerWakeReceipt {
  id: number;
  generation: number;
}

export interface TournamentManagerWakeDatabaseState extends TournamentManagerWakeReceipt {
  consumed: boolean;
}

/** Keep the RPC well below PostgreSQL/PostgREST payload and lock-set limits. */
export const MAX_TOURNAMENT_MANAGER_WAKE_ACK_BATCH = 200;

export function chunkTournamentManagerWakeReceipts(
  receipts: readonly TournamentManagerWakeReceipt[],
  batchSize = MAX_TOURNAMENT_MANAGER_WAKE_ACK_BATCH
): TournamentManagerWakeReceipt[][] {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('Tournament manager wake acknowledgement batch must be positive');
  }
  const chunks: TournamentManagerWakeReceipt[][] = [];
  for (let index = 0; index < receipts.length; index += batchSize) {
    chunks.push(receipts.slice(index, index + batchSize));
  }
  return chunks;
}

/**
 * Return only generations that still need a subsequent full manager sweep.
 * null means the database response did not describe the exact captured set and
 * must not authorize any local receipt deletion.
 */
export function reconcileTournamentManagerWakeAcknowledgement(
  captured: readonly TournamentManagerWakeReceipt[],
  current: readonly TournamentManagerWakeDatabaseState[]
): Map<number, number> | null {
  if (captured.length !== current.length) return null;

  const capturedById = new Map<number, number>();
  for (const receipt of captured) {
    if (
      !Number.isSafeInteger(receipt.id) ||
      receipt.id <= 0 ||
      !Number.isSafeInteger(receipt.generation) ||
      receipt.generation <= 0 ||
      capturedById.has(receipt.id)
    ) {
      return null;
    }
    capturedById.set(receipt.id, receipt.generation);
  }

  const stillPending = new Map<number, number>();
  const seen = new Set<number>();
  for (const state of current) {
    const capturedGeneration = capturedById.get(state.id);
    if (
      capturedGeneration === undefined ||
      seen.has(state.id) ||
      !Number.isSafeInteger(state.generation) ||
      state.generation < capturedGeneration
    ) {
      return null;
    }
    seen.add(state.id);

    if (state.generation === capturedGeneration && state.consumed) continue;
    if (state.generation > capturedGeneration && !state.consumed) {
      stillPending.set(state.id, state.generation);
      continue;
    }
    // Same generation still pending, or an advanced generation already marked
    // consumed, contradicts the acknowledgement transaction's contract.
    return null;
  }

  return seen.size === capturedById.size ? stillPending : null;
}
