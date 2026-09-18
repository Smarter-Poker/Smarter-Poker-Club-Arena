/** Private Phase 6 source observations, never database transaction authority.
 * The cache reads several relations independently. Its identity binds the exact
 * successful publication, not an atomic database snapshot or GTO certificate. */
import type { HorseGameStateV2 } from './HorseLogic.js';
import type { SeatPlayer } from '../types.js';
import {
  TOURNAMENT_CONTEXT_INCOMPLETE,
  type TournamentContextStatus,
} from './HorseTournamentPreflop.js';

export const HORSE_TOURNAMENT_CONTEXT_STALE_MS = 60_000;

export interface HorseTournamentContextSource {
  version: 1;
  tournamentId: string;
  cacheId: string;
  generation: number;
  readStartedAtMs: number;
  readCompletedAtMs: number;
  contextDigest: string;
  contextStatus: 'complete' | 'incomplete';
  contextIssues: string[];
}

export interface HorseTournamentContextProvenance {
  version: 1;
  readAtMs: number;
  status: TournamentContextStatus;
  issues: string[];
  ageMs: number | null;
  source: HorseTournamentContextSource | null;
}

export interface HorseTournamentDecisionProvenance extends HorseTournamentContextProvenance {
  projection: {
    tableId: string;
    handNumber: number;
    actorId: string;
    actorSeat: number;
    dealerSeat: number | null;
    dealtSeatIds: number[];
    smallBlind: number;
    bigBlind: number;
    ante: number;
    gameVariant: string;
  };
}

const obj = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x: unknown, keys: string[]): x is Record<string, unknown> =>
  obj(x) && Object.keys(x).length === keys.length && keys.every((k) => Object.hasOwn(x, k));
const uint = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const text = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 512;
const seat = (x: unknown): x is number => uint(x) && x >= 1 && x <= 10;
function issuesMatch(status: unknown, issues: unknown): issues is string[] {
  return (
    ['complete', 'incomplete', 'warming', 'stale'].includes(status as string) &&
    Array.isArray(issues) &&
    issues.every(text) &&
    new Set(issues).size === issues.length &&
    (status === 'complete' ? issues.length === 0 : issues.includes(TOURNAMENT_CONTEXT_INCOMPLETE))
  );
}

/** Validate before trusting/copying worker evidence; no I/O, clock or RNG. */
export function horseTournamentProvenanceIsValid(
  value: unknown
): value is HorseTournamentDecisionProvenance {
  if (
    !exact(value, ['version', 'readAtMs', 'status', 'issues', 'ageMs', 'source', 'projection']) ||
    value.version !== 1 ||
    !uint(value.readAtMs) ||
    !issuesMatch(value.status, value.issues)
  )
    return false;
  const s = value.source;
  if (s === null) {
    if (value.ageMs !== null || !['warming', 'incomplete'].includes(value.status as string))
      return false;
  } else {
    if (
      !exact(s, [
        'version',
        'tournamentId',
        'cacheId',
        'generation',
        'readStartedAtMs',
        'readCompletedAtMs',
        'contextDigest',
        'contextStatus',
        'contextIssues',
      ]) ||
      s.version !== 1 ||
      !text(s.tournamentId) ||
      typeof s.cacheId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.cacheId) ||
      !uint(s.generation) ||
      s.generation < 1 ||
      !uint(s.readStartedAtMs) ||
      !uint(s.readCompletedAtMs) ||
      !['complete', 'incomplete'].includes(s.contextStatus as string) ||
      !issuesMatch(s.contextStatus, s.contextIssues) ||
      typeof s.contextDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(s.contextDigest) ||
      value.ageMs !== Math.max(0, value.readAtMs - s.readCompletedAtMs)
    )
      return false;
    // Preserve the existing cache clock semantics, including a wall-clock rollback.
    // The two wall-clock readings expose that discontinuity, not a fabricated interval.
    if ((value.ageMs as number) > HORSE_TOURNAMENT_CONTEXT_STALE_MS) {
      if (value.status !== 'stale' || !value.issues.includes('tournament_context_stale'))
        return false;
    } else if (value.status !== s.contextStatus) return false;
    const snapshotIssues = value.issues;
    if (!s.contextIssues.every((issue) => snapshotIssues.includes(issue))) return false;
  }
  const p = value.projection;
  return (
    exact(p, [
      'tableId',
      'handNumber',
      'actorId',
      'actorSeat',
      'dealerSeat',
      'dealtSeatIds',
      'smallBlind',
      'bigBlind',
      'ante',
      'gameVariant',
    ]) &&
    text(p.tableId) &&
    uint(p.handNumber) &&
    text(p.actorId) &&
    seat(p.actorSeat) &&
    (p.dealerSeat === null || seat(p.dealerSeat)) &&
    Array.isArray(p.dealtSeatIds) &&
    p.dealtSeatIds.length <= 10 &&
    p.dealtSeatIds.every(seat) &&
    new Set(p.dealtSeatIds).size === p.dealtSeatIds.length &&
    finite(p.smallBlind) &&
    finite(p.bigBlind) &&
    finite(p.ante) &&
    text(p.gameVariant)
  );
}

export function horseTournamentProvenanceMatchesSnapshot(snapshot: {
  gameState: HorseGameStateV2;
  player: SeatPlayer;
  fence?: string;
}): boolean {
  const gs = snapshot.gameState,
    t = gs.tournament,
    value = t?.contextProvenance;
  if (value === undefined) return true; // Historical evidence remains explicitly legacy.
  if (!horseTournamentProvenanceIsValid(value) || !t) return false;
  const p = value.projection;
  return (
    gs.gameMode === 'tournament' &&
    (value.source === null || value.source.tournamentId === t.tournamentId) &&
    value.ageMs === t.sourceAgeMs &&
    value.issues.every((issue) => t.contextIssues?.includes(issue)) &&
    (value.status === 'complete'
      ? t.contextStatus === 'complete' || t.contextStatus === 'incomplete'
      : t.contextStatus === value.status) &&
    p.actorId === snapshot.player.user_id &&
    p.actorSeat === snapshot.player.seat &&
    p.dealerSeat === (gs.dealerSeat ?? null) &&
    JSON.stringify(p.dealtSeatIds) === JSON.stringify(gs.players.map((player) => player.seat)) &&
    p.smallBlind === t.currentSmallBlind &&
    p.bigBlind === t.currentBigBlind &&
    p.bigBlind === gs.bigBlind &&
    p.ante === t.currentAnte &&
    p.ante === (gs.ante ?? 0) &&
    p.gameVariant === gs.gameVariant &&
    (snapshot.fence === undefined ||
      snapshot.fence.startsWith(`${p.tableId}:${p.handNumber}:${p.actorSeat}:`))
  );
}
