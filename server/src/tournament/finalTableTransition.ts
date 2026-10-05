import {
  isPersistedUnlimitedMtt,
  type PersistedTournamentEntryCapacitySubject,
} from './tournamentEntryCapacity.js';

/** Final Table presentation belongs only to a persisted unlimited MTT contract. */
export function mayBecomeFinalTable(
  row: PersistedTournamentEntryCapacitySubject | null | undefined
): boolean {
  if (!row) return false;
  try {
    return isPersistedUnlimitedMtt(row);
  } catch {
    return false;
  }
}

/** Unknown, empty, or multi-table layouts all fail closed. */
export function hasReachedFinalTableShape(
  remainingPlayers: number | null,
  finalTableSize: number,
  liveTables: number | null
): boolean {
  return (
    Number.isInteger(remainingPlayers) &&
    (remainingPlayers ?? 0) > 0 &&
    (remainingPlayers ?? 0) <= finalTableSize &&
    liveTables === 1
  );
}

export interface FinalTableTransitionAttempt {
  changed: boolean;
  error: Error | null;
}

export interface FinalTableTransitionRead {
  triggered: boolean | null;
  /** Durable token naming the one manager allowed to emit the announcement. */
  ownershipToken: string | null;
  /** True only after the owning manager received a successful broadcast receipt. */
  announced: boolean | null;
  error: Error | null;
}

export interface FinalTableTransitionStore {
  /** Atomically claim the durable transition receipt for one stable manager token. */
  persistIfUnset(ownershipToken: string): Promise<FinalTableTransitionAttempt>;
  /** Reconcile an ambiguous claim response against the durable owner receipt. */
  readPersisted(): Promise<FinalTableTransitionRead>;
}

export type FinalTableTransitionResult =
  | { state: 'newly_persisted' }
  | { state: 'already_persisted' }
  | { state: 'retry'; error: Error };

async function reconcileFinalTableTransition(
  store: FinalTableTransitionStore,
  ownershipToken: string,
  claimError: Error | null
): Promise<FinalTableTransitionResult> {
  let current: FinalTableTransitionRead;
  try {
    current = await store.readPersisted();
  } catch (cause) {
    return {
      state: 'retry',
      error: cause instanceof Error ? cause : new Error(String(cause)),
    };
  }
  if (current.error) return { state: 'retry', error: current.error };
  if (current.triggered === true) {
    if (current.ownershipToken === ownershipToken && current.announced !== true) {
      return { state: 'newly_persisted' };
    }
    return { state: 'already_persisted' };
  }

  return {
    state: 'retry',
    error:
      claimError ??
      new Error(
        'conditional final-table claim returned no receipt and the durable flag is not true'
      ),
  };
}

/** Claim the one durable transition; only its durable owner may announce it. */
export async function claimFinalTableTransition(
  store: FinalTableTransitionStore,
  ownershipToken: string
): Promise<FinalTableTransitionResult> {
  let persisted: FinalTableTransitionAttempt;
  try {
    persisted = await store.persistIfUnset(ownershipToken);
  } catch (cause) {
    return reconcileFinalTableTransition(
      store,
      ownershipToken,
      cause instanceof Error ? cause : new Error(String(cause))
    );
  }
  if (persisted.error) {
    return reconcileFinalTableTransition(store, ownershipToken, persisted.error);
  }
  if (persisted.changed) return { state: 'newly_persisted' };
  return reconcileFinalTableTransition(store, ownershipToken, null);
}
