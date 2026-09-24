import {
  readPersistedTournamentFormatContract,
  normalizePersistedTournamentMaxPlayers,
  type TournamentFormatContract,
  type PersistedTournamentEntryCapacitySubject,
} from '../../server/src/tournament/tournamentEntryCapacity';

/** Presentation can show an unresolved historical row without inventing its format. */
export function readTournamentFormat(row: unknown): TournamentFormatContract | null {
  try {
    return readPersistedTournamentFormatContract(row);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

export function isKnownTournamentFormat(row: unknown): boolean {
  return readTournamentFormat(row) !== null;
}

export function isUnlimitedTournamentFormat(row: unknown): boolean {
  const format = readTournamentFormat(row);
  return format === 'mtt-v1' || format === 'mtt-v2';
}

/** NULL means no displayable denominator, including unresolved historical formats. */
export function getTournamentEntryCapacity(row: unknown): number | null {
  return isKnownTournamentFormat(row)
    ? normalizePersistedTournamentMaxPlayers(row as PersistedTournamentEntryCapacitySubject)
    : null;
}

/** A missing marker never authorizes registration, waitlisting or a seat purchase. */
export function isTournamentEntryUnavailable(row: unknown, entrants: number): boolean {
  if (!isKnownTournamentFormat(row) || !Number.isSafeInteger(entrants) || entrants < 0) return true;
  const status = String((row as { status?: unknown }).status ?? '').toUpperCase();
  if (['COMPLETING', 'COMPLETED', 'CANCELLED', 'ABORTED', 'FINISHED'].includes(status)) return true;
  // Multi-day, between days: entries are closed (the registration core admits
  // nobody into a BAGGED event), though the event is not over.
  if (status === 'BAGGED') return true;
  if (isUnlimitedTournamentFormat(row)) return false;
  const capacity = getTournamentEntryCapacity(row);
  return capacity === null || entrants >= capacity;
}

export function isSeatFirstTournamentFormat(row: unknown): boolean {
  const format = readTournamentFormat(row);
  const capacity = getTournamentEntryCapacity(row);
  if (capacity === null) return false;
  if (format === 'spin-v1' || format === 'seat-first-satellite-v1') return true;
  return format === 'sng-v1' && capacity === 2;
}

export function getTournamentFormatKind(row: unknown): 'mtt' | 'sng' | 'spin' | 'unknown' {
  switch (readTournamentFormat(row)) {
    case 'mtt-v1':
    case 'mtt-v2':
      return 'mtt';
    case 'seat-first-satellite-v1':
    case 'sng-v1':
      return 'sng';
    case 'spin-v1':
      return 'spin';
    default:
      return 'unknown';
  }
}
