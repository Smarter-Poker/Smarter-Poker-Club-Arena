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
  'mtt', 'xmtt', 'satellite', 'freezeout', 'bounty', 'progressive',
  'progressive_bounty', 'pko', 'mystery', 'mystery_bounty', 'rebuy', 'reentry',
  'mtt_freezeout', 'mtt_free_buy', 'mtt_rebuy', 'mtt_reentry',
]);
const FIXED_TYPES = new Set(['sng', 'spin', 'hu_sng', 'heads_up']);
const label = (value: unknown): string => String(value ?? '').trim().toLowerCase();
const nonemptyString = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().length > 0;

function hasSatelliteTarget(subject: TournamentEntryCapacitySubject): boolean {
  if (nonemptyString(subject.satellite_target_id) || nonemptyString(subject.satelliteTargetId)) return true;
  for (const target of [subject.satellite_target, subject.satelliteTarget]) {
    if (nonemptyString(target)) return true;
    if (target && typeof target === 'object') {
      const value = target as { tournamentId?: unknown; tournament_id?: unknown };
      if (nonemptyString(value.tournamentId) || nonemptyString(value.tournament_id)) return true;
    }
  }
  return false;
}

/** Explicit event type wins over obsolete two-seat or variant projections. */
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
  return capacity === null || !Number.isSafeInteger(entrants) || entrants < 0 || entrants >= capacity;
}
