/** Entry-field capacity only. Physical table seats have their own finite limit. */
export interface TournamentEntryCapacitySubject {
  tournament_type?: unknown;
  tournamentType?: unknown;
  type?: unknown;
  variant?: unknown;
  max_players?: unknown;
  maxPlayers?: unknown;
  satellite_target_id?: unknown;
  satelliteTargetId?: unknown;
  satellite_target?: unknown;
  satelliteTarget?: unknown;
}

const MTT_TYPES = new Set([
  'mtt',
  'xmtt',
  'satellite',
  'freezeout',
  'bounty',
  'progressive',
  'progressive_bounty',
  'pko',
  'mystery',
  'mystery_bounty',
  'rebuy',
  'reentry',
  'mtt_freezeout',
  'mtt_free_buy',
  'mtt_rebuy',
  'mtt_reentry',
]);
const FIXED_TYPES = new Set(['sng', 'spin', 'hu_sng', 'heads_up']);
const label = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase();
const nonemptyString = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().length > 0;

function hasSatelliteTarget(subject: TournamentEntryCapacitySubject): boolean {
  if (nonemptyString(subject.satellite_target_id) || nonemptyString(subject.satelliteTargetId))
    return true;
  for (const target of [subject.satellite_target, subject.satelliteTarget]) {
    if (nonemptyString(target)) return true;
    if (target && typeof target === 'object') {
      const value = target as { tournamentId?: unknown; tournament_id?: unknown };
      if (nonemptyString(value.tournamentId) || nonemptyString(value.tournament_id)) return true;
    }
  }
  return false;
}

/**
 * Classifies raw NEW configuration. Caller-supplied format markers are ignored;
 * they cannot grant a new satellite the historical seat-first exception.
 * Explicit event type wins over obsolete two-seat or variant projections.
 */
export function isUnlimitedMtt(subject: TournamentEntryCapacitySubject): boolean {
  if (hasSatelliteTarget(subject)) return true;
  const type = label(subject.tournament_type ?? subject.tournamentType ?? subject.type);
  if (MTT_TYPES.has(type)) return true;
  if (FIXED_TYPES.has(type)) return false;
  return MTT_TYPES.has(label(subject.variant));
}

/** NULL is the MTT storage contract. Invalid fixed-format inputs remain unknown. */
export function normalizeTournamentMaxPlayers(
  subject: TournamentEntryCapacitySubject
): number | null {
  if (isUnlimitedMtt(subject)) return null;
  const raw = subject.max_players ?? subject.maxPlayers;
  if (raw === null || raw === undefined || raw === '') return null;
  const capacity = Number(raw);
  return Number.isSafeInteger(capacity) && capacity > 0 ? capacity : null;
}

/** Unknown fixed-format capacity never grants an additional entry. */
export function isTournamentEntryFull(
  subject: TournamentEntryCapacitySubject,
  entrants: number
): boolean {
  if (isUnlimitedMtt(subject)) return false;
  const capacity = normalizeTournamentMaxPlayers(subject);
  return (
    capacity === null || !Number.isSafeInteger(entrants) || entrants < 0 || entrants >= capacity
  );
}

export type TournamentFormatContract =
  | 'mtt-v1'
  | 'mtt-v2'
  | 'seat-first-satellite-v1'
  | 'sng-v1'
  | 'spin-v1';

export interface PersistedTournamentEntryCapacitySubject extends TournamentEntryCapacitySubject {
  format_contract?: unknown;
}

/**
 * Reads a marker returned by the database, never one supplied by a creator.
 * This validates shape, not provenance: callers must supply a persisted row or
 * authoritative launch receipt. Missing projections and unknown versions must
 * stop the affected operation rather than infer a purchased format from labels.
 */
export function readPersistedTournamentFormatContract(subject: unknown): TournamentFormatContract {
  if (
    subject === null ||
    typeof subject !== 'object' ||
    Array.isArray(subject) ||
    !Object.prototype.hasOwnProperty.call(subject, 'format_contract')
  ) {
    throw new TypeError('TOURNAMENT_FORMAT_CONTRACT_INVALID');
  }
  const contract = (subject as PersistedTournamentEntryCapacitySubject).format_contract;
  switch (contract) {
    case 'mtt-v1':
    case 'mtt-v2':
    case 'seat-first-satellite-v1':
    case 'sng-v1':
    case 'spin-v1':
      return contract;
    default:
      throw new TypeError('TOURNAMENT_FORMAT_CONTRACT_INVALID');
  }
}

/**
 * Recorded format only. Both MTT versions are unlimited formats; this does not
 * establish that database admission has activated its unlimited-capacity ABI.
 */
export function isPersistedUnlimitedMtt(subject: PersistedTournamentEntryCapacitySubject): boolean {
  const contract = readPersistedTournamentFormatContract(subject);
  return contract === 'mtt-v1' || contract === 'mtt-v2';
}

/**
 * Keeps purchased fixed fields, including historical target-linked HU events.
 * An explicit canonical NULL remains unknown for fixed formats, even when an
 * obsolete camelCase projection also contains a number. Unknown capacity is
 * never permission to admit; use isPersistedTournamentEntryFull for that check.
 */
export function normalizePersistedTournamentMaxPlayers(
  subject: PersistedTournamentEntryCapacitySubject
): number | null {
  if (isPersistedUnlimitedMtt(subject)) return null;
  const raw = Object.prototype.hasOwnProperty.call(subject, 'max_players')
    ? subject.max_players
    : subject.maxPlayers;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const capacity = Number(raw);
  return Number.isSafeInteger(capacity) && capacity > 0 ? capacity : null;
}

/** Capacity projection only; the owning database transaction authorizes entry. */
export function isPersistedTournamentEntryFull(
  subject: PersistedTournamentEntryCapacitySubject,
  entrants: number
): boolean {
  if (isPersistedUnlimitedMtt(subject)) return false;
  const capacity = normalizePersistedTournamentMaxPlayers(subject);
  return (
    capacity === null || !Number.isSafeInteger(entrants) || entrants < 0 || entrants >= capacity
  );
}

/** Fixed purchased formats; physical table limits remain independent. */
export function isPersistedSpin(subject: PersistedTournamentEntryCapacitySubject): boolean {
  return readPersistedTournamentFormatContract(subject) === 'spin-v1';
}

export function isPersistedSeatFirst(subject: PersistedTournamentEntryCapacitySubject): boolean {
  const format = readPersistedTournamentFormatContract(subject);
  return (
    format === 'spin-v1' ||
    format === 'seat-first-satellite-v1' ||
    (format === 'sng-v1' && normalizePersistedTournamentMaxPlayers(subject) === 2)
  );
}
