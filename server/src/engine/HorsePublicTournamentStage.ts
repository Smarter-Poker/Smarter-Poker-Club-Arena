import type { HandConfig } from '../types.js';
import type { TournamentBrainContextSnapshot } from '../services/TournamentBrainContext.js';

// Public action nodes read only the public projection, never private Horse provenance.
export type HorsePublicTournamentReader = () => Pick<
  TournamentBrainContextSnapshot,
  'context' | 'status' | 'issues' | 'ageMs'
>;

export type HorsePublicTournamentStage =
  | Readonly<{ version: 1; status: 'not_applicable' }>
  | Readonly<{
      version: 1;
      status: 'unavailable';
      reason:
        | 'context_missing'
        | 'context_warming'
        | 'context_stale'
        | 'context_incomplete'
        | 'context_read_failed'
        | 'invalid_public_context'
        | 'hand_level_mismatch';
      /** Which validity check failed when reason is invalid_public_context. */
      detail?:
        | 'format'
        | 'age'
        | 'counts'
        | 'players_left'
        | 'capacity'
        | 'flags'
        | 'mystery_stage'
        | 'schema_version';
    }>
  | Readonly<{
      version: 1;
      status: 'captured';
      rules: 'tournament-stage-public-v1';
      ageMs: number;
      format: 'mtt' | 'sng' | 'spin' | 'hu_sng';
      entrants: number;
      playersLeft: number;
      spotsPaid: number;
      seatsPerTable: number;
      currentLevel: number;
      inMoney: boolean;
      nearBubble: boolean;
      finalTable: boolean;
      handForHand: boolean;
      onBreak: boolean;
      registrationOpen: boolean;
      lateRegistrationOpen: boolean;
      reentryOpen: boolean;
      rebuyOpen: boolean;
      addOnPeriodOpen: boolean;
      isPko: boolean;
      isBounty: boolean;
      isMysteryBounty: boolean;
      mysteryBountyStage: 'none' | 'pending' | 'active' | 'complete';
      satellite: boolean;
      satelliteSeats: number;
    }>;

/** Bounded public stage only. This is not a full Phase 7 utility context.
 * Never copy the cache's per-user wallets, recovery eligibility or stack maps.
 * The reader is owned by the dealing layer and performs a synchronous cache read.
 */
export function captureHorsePublicTournamentStage(
  config: HandConfig,
  read?: HorsePublicTournamentReader
): HorsePublicTournamentStage {
  const unavailable = (
    reason: Extract<HorsePublicTournamentStage, { status: 'unavailable' }>['reason'],
    detail?: Extract<HorsePublicTournamentStage, { status: 'unavailable' }>['detail']
  ): HorsePublicTournamentStage =>
    Object.freeze(
      detail
        ? { version: 1 as const, status: 'unavailable' as const, reason, detail }
        : { version: 1 as const, status: 'unavailable' as const, reason }
    );
  if (!config.isTournament) return Object.freeze({ version: 1, status: 'not_applicable' });
  if (!read) return unavailable('context_missing');
  let s: ReturnType<HorsePublicTournamentReader>;
  try {
    s = read();
  } catch {
    return unavailable('context_read_failed');
  }
  if (!s) return unavailable('context_missing');
  if (s.status === 'warming') return unavailable('context_warming');
  if (s.status === 'stale') return unavailable('context_stale');
  if (
    s.status !== 'complete' ||
    !s.context ||
    s.context.contextStatus !== 'complete' ||
    !Array.isArray(s.issues) ||
    s.issues.length ||
    !Array.isArray(s.context.contextIssues) ||
    s.context.contextIssues.length
  )
    return unavailable('context_incomplete');
  const c = s.context;
  const count = (v: number) => Number.isSafeInteger(v) && v >= 0;
  // The first failing check is NAMED (2026-10-19): 29% of sampled tournament
  // hands read invalid_public_context and the single reason could not say
  // which of these eight checks was refusing them.
  const invalid = (
    detail: NonNullable<Extract<HorsePublicTournamentStage, { status: 'unavailable' }>['detail']>
  ) => unavailable('invalid_public_context', detail);
  if (c.schemaVersion !== 1) return invalid('schema_version');
  if (!['mtt', 'sng', 'spin', 'hu_sng'].includes(c.format)) return invalid('format');
  if (s.ageMs === null || !Number.isFinite(s.ageMs) || s.ageMs < 0 || s.ageMs > 60_000)
    return invalid('age');
  if (![c.entrants, c.playersLeft, c.spotsPaid, c.currentLevel, c.satelliteSeats].every(count))
    return invalid('counts');
  if (c.playersLeft < 2) return invalid('players_left');
  // TournamentBrainContext and the persisted blind clock use zero-based levels.
  if (c.entrants < c.playersLeft || c.spotsPaid > c.entrants) return invalid('counts');
  if (!Number.isInteger(c.seatsPerTable) || c.seatsPerTable < 2 || c.seatsPerTable > 10)
    return invalid('capacity');
  if (
    ![
      c.inMoney,
      c.nearBubble,
      c.finalTable,
      c.handForHandExpected,
      c.onBreak,
      c.registrationOpen,
      c.lateRegistrationOpen,
      c.reentryOpen,
      c.rebuyOpen,
      c.addOnPeriodOpen,
      c.isPko,
      c.isBounty,
      c.isMysteryBounty,
      c.satellite,
    ].every((v) => typeof v === 'boolean')
  )
    return invalid('flags');
  if (!['none', 'pending', 'active', 'complete'].includes(c.mysteryBountyStage))
    return invalid('mystery_stage');
  // A hand retains its dealt stakes when the clock advances during play. The
  // decision projection already recognizes this exact previous-level case;
  // retain that hand's level here too, without inventing a missing snapshot.
  const sameHandStakes = (smallBlind: number, bigBlind: number, ante: number) =>
    smallBlind === config.smallBlind && bigBlind === config.bigBlind && ante === (config.ante ?? 0);
  const currentLevelMatches = sameHandStakes(c.currentSmallBlind, c.currentBigBlind, c.currentAnte);
  const previous = c.previousLevel;
  const previousLevelMatches =
    !currentLevelMatches &&
    previous != null &&
    Number.isSafeInteger(previous.level) &&
    previous.level >= 0 &&
    previous.level < c.currentLevel &&
    typeof previous.durationMin === 'number' &&
    Number.isFinite(previous.durationMin) &&
    previous.durationMin > 0 &&
    sameHandStakes(previous.smallBlind, previous.bigBlind, previous.ante);
  if (
    (!currentLevelMatches && !previousLevelMatches) ||
    ((config.ante ?? 0) > 0 && c.anteType !== (config.bigBlindAnte ? 'big_blind' : 'per_player'))
  )
    return unavailable('hand_level_mismatch');
  return Object.freeze({
    version: 1,
    status: 'captured',
    rules: 'tournament-stage-public-v1',
    ageMs: s.ageMs,
    format: c.format,
    entrants: c.entrants,
    playersLeft: c.playersLeft,
    spotsPaid: c.spotsPaid,
    seatsPerTable: c.seatsPerTable,
    currentLevel: previousLevelMatches ? previous!.level : c.currentLevel,
    inMoney: c.inMoney,
    nearBubble: c.nearBubble,
    finalTable: c.finalTable,
    handForHand: c.handForHandExpected,
    onBreak: c.onBreak,
    registrationOpen: c.registrationOpen,
    lateRegistrationOpen: c.lateRegistrationOpen,
    reentryOpen: c.reentryOpen,
    rebuyOpen: c.rebuyOpen,
    addOnPeriodOpen: c.addOnPeriodOpen,
    isPko: c.isPko,
    isBounty: c.isBounty,
    isMysteryBounty: c.isMysteryBounty,
    mysteryBountyStage: c.mysteryBountyStage,
    satellite: c.satellite,
    satelliteSeats: c.satelliteSeats,
  });
}
