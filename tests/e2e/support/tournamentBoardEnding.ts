/**
 * How the live-table certificate tells a tournament board that ENDED (a
 * result) from a table that was LOST (a defect), and how it prefers boards
 * that will not end while it is watching.
 *
 * Measured 2026-09-29 (production, engine c0c986ad): a heads-up Sit & Go lasts
 * 2 to 28 minutes and its finishing hand is nobody's fault. What the database
 * shows the instant the last hand settles is NOT `status = 'COMPLETED'`:
 *
 *   tournaments.status = RUNNING, current_players = 1, tables.status = waiting,
 *   tournament_players = winner (chips 2000) + loser (chips 0, still 'playing')
 *
 * and it stays that way for 10 to 20 minutes before the tournament is stamped
 * COMPLETED. So "natural completion" cannot be read from `status` alone; it is
 * the survivor count plus a table that has stopped dealing.
 *
 * Nothing here retries. A failure is reclassified only when the rows prove the
 * board finished AFTER the certificate had already seen it running, and every
 * other failure keeps its own message and evidence.
 */

export type TournamentBoardFacts = {
  tableId: string;
  tournamentId: string | null;
  tournamentStatus: string | null;
  currentPlayers: number | null;
  tableStatus: string | null;
  endedAt: string | null;
  bigBlind: number | null;
  /** Chip stacks of the players still seated (left_at is null), when readable. */
  seatStacks: number[];
  seatedUserIds?: string[];
  /** All selected players accounted for by authoritative same-tournament rows. */
  relocatedUserIds?: string[];
  eliminatedUserIds?: string[];
};

export type BoardEnding = 'running' | 'natural-completion' | 'not-a-completion' | 'unknown';

/** Statuses a tournament reaches only by finishing its play. */
const COMPLETED_STATUSES = new Set(['COMPLETED', 'FINISHED', 'ENDED']);
/** Statuses that end a tournament WITHOUT a result: a defect or an operator, never "the game finished". */
const ABORTED_STATUSES = new Set(['CANCELLED', 'CANCELED', 'ABORTED', 'VOIDED']);

export function classifyBoardEnding(facts: TournamentBoardFacts | null | undefined): BoardEnding {
  if (!facts || !facts.tournamentId || facts.tournamentStatus === null) return 'unknown';
  const status = facts.tournamentStatus.toUpperCase();
  if (ABORTED_STATUSES.has(status)) return 'not-a-completion';
  if (COMPLETED_STATUSES.has(status)) return 'natural-completion';
  if (status !== 'RUNNING') return 'unknown';
  if (facts.currentPlayers === null || !Number.isSafeInteger(facts.currentPlayers))
    return 'unknown';
  // One survivor AND a table that stopped dealing. A running two-handed
  // board reports current_players = 2 and tables.status = 'running'.
  if (facts.currentPlayers <= 1 && facts.tableStatus !== null && facts.tableStatus !== 'running') {
    return 'natural-completion';
  }
  return 'running';
}

/**
 * The shorter stack, in big blinds. In a heads-up board the shorter stack is
 * what one all-in away from the end looks like, so the deepest boards are the
 * ones least likely to finish inside a two-minute case. Unknown depth sorts
 * last rather than being guessed.
 */
export function boardEnduranceBigBlinds(facts: TournamentBoardFacts | null | undefined): number {
  if (!facts || !facts.bigBlind || facts.bigBlind <= 0) return 0;
  const stacks = facts.seatStacks.filter((stack) => Number.isFinite(stack) && stack >= 0);
  if (stacks.length < 2) return 0;
  return Math.min(...stacks) / facts.bigBlind;
}

/** Deepest boards first; the caller's own order breaks ties. */
export function orderByEndurance<T extends { tableId: string }>(
  tables: readonly T[],
  facts: ReadonlyMap<string, TournamentBoardFacts>
): T[] {
  return tables
    .map((table, index) => ({
      table,
      index,
      endurance: boardEnduranceBigBlinds(facts.get(table.tableId)),
    }))
    .sort((a, b) => b.endurance - a.endurance || a.index - b.index)
    .map((entry) => entry.table);
}

/** A board already ended, or already one hand from ending, is not a running board. */
export function selectableWhileRunning(facts: TournamentBoardFacts | null | undefined): boolean {
  return classifyBoardEnding(facts) === 'running';
}

/** Events a table emits at the seam between hands. Silence after one of these can be an ending. */
export const HAND_BOUNDARY_EVENT_TYPES: ReadonlySet<string> = new Set([
  'pot_win',
  'pot_distributed',
  'hand_complete',
]);

export type CaseFailureOutcome =
  | { kind: 'natural-completion'; reason: string }
  | { kind: 'table-engine-restarted'; reason: string }
  | { kind: 'unproven'; reason: string };

/**
 * Why a case failed, from evidence only.
 *
 * - A closed, empty board with a durable result or complete relocation proof
 *   can explain the generic teardown frame. Otherwise engine_restarting
 *   remains a named failure, including an active or merely waiting table.
 * - `natural-completion` needs the board seen RUNNING at selection, ended by
 *   the time of failure, AND the last thing the browser saw must be a hand
 *   boundary (silence that begins mid-hand is a stall, not a finish).
 * - everything else is `unproven` and the original failure stands.
 */
export function classifyCaseFailure(input: {
  engineRestartFrames: number;
  /** The only teardown frame follows the last live hand-boundary event. */
  terminalTeardownOnly?: boolean;
  atSelection: TournamentBoardFacts | null | undefined;
  atFailure: TournamentBoardFacts | null | undefined;
  lastGameplayEventType: string | null;
}): CaseFailureOutcome {
  const start = input.atSelection;
  const end = input.atFailure;
  const witnessedBoundary =
    input.lastGameplayEventType !== null &&
    HAND_BOUNDARY_EVENT_TYPES.has(input.lastGameplayEventType);
  const sameBoard =
    start &&
    end &&
    start.tableId === end.tableId &&
    start.tournamentId !== null &&
    start.tournamentId === end.tournamentId;
  const closedEmpty =
    end?.tableStatus === 'closed' && end.seatStacks.length === 0 && end.seatedUserIds?.length === 0;
  const selectedPlayers = start?.seatedUserIds ?? [];
  const accounted = new Set([...(end?.relocatedUserIds ?? []), ...(end?.eliminatedUserIds ?? [])]);
  const verifiedBreak =
    end?.tournamentStatus === 'RUNNING' &&
    selectedPlayers.length >= 2 &&
    new Set(selectedPlayers).size === selectedPlayers.length &&
    (end.relocatedUserIds?.length ?? 0) > 0 &&
    selectedPlayers.every((id) => accounted.has(id));
  // dropTable also announces engine_restarting for normal terminal/break
  // unregister. Only an independently proven closed outcome supersedes it.
  if (
    sameBoard &&
    classifyBoardEnding(start) === 'running' &&
    witnessedBoundary &&
    (input.engineRestartFrames === 0 || input.terminalTeardownOnly === true) &&
    closedEmpty &&
    ((COMPLETED_STATUSES.has(end.tournamentStatus?.toUpperCase() ?? '') &&
      Number.isFinite(Date.parse(end.endedAt ?? ''))) ||
      verifiedBreak)
  ) {
    return {
      kind: 'natural-completion',
      reason: verifiedBreak
        ? `closed table ${end.tableId}: every selected player is durably relocated or eliminated`
        : `tournament ${end.tournamentId} completed at ${end.endedAt} after the witnessed hand boundary`,
    };
  }
  if (input.engineRestartFrames > 0) {
    return {
      kind: 'table-engine-restarted',
      reason: `the engine told the browser it rebuilt the table (${input.engineRestartFrames} engine_restarting frame(s))`,
    };
  }
  if (!sameBoard || classifyBoardEnding(input.atSelection) !== 'running') {
    return {
      kind: 'unproven',
      reason: 'the board was not proven running at selection, so a later ending proves nothing',
    };
  }
  const ending = classifyBoardEnding(input.atFailure);
  if (ending !== 'natural-completion') {
    return { kind: 'unproven', reason: `the database does not show a finished board (${ending})` };
  }
  if (!witnessedBoundary) {
    return {
      kind: 'unproven',
      reason: `the board finished, but the last live event was ${input.lastGameplayEventType}, not a hand boundary`,
    };
  }
  const f = input.atFailure!;
  return {
    kind: 'natural-completion',
    reason:
      `tournament ${f.tournamentId} was RUNNING with 2+ players at selection and shows ` +
      `${f.tournamentStatus} / current_players=${f.currentPlayers} / table=${f.tableStatus} at failure`,
  };
}

/**
 * A tournament's add-on break is an authoritative hold, not a frozen table.
 *
 * The engine persists one add-on window (`addon_period_ends_at`) and holds
 * every table for its final `addon_break_minutes` (clamped to 1..10, exactly
 * as TournamentManagerBase.addOnBreakDurationMs does). Selection already
 * refuses a board whose window is open; this names the case where the window
 * opened while the browser watched. The hold explains ONLY the time inside
 * the break: silence before the break began, and after it ended, must each
 * still fit the ordinary gameplay silence limit, so a table that stalls into
 * a break or fails to resume after one is still a failure.
 */
export type AddOnBreakHold =
  | { held: true; breakStartedAt: number; breakEndsAt: number; reason: string }
  | { held: false; reason: string };

export function classifyAddOnBreakHold(input: {
  addonPeriodEndsAt: string | null | undefined;
  addonBreakMinutes: number | null | undefined;
  silenceStartedAt: number;
  observedAt: number;
  maxSilenceMs: number;
}): AddOnBreakHold {
  const breakEndsAt = Date.parse(String(input.addonPeriodEndsAt ?? ''));
  if (!Number.isFinite(breakEndsAt)) return { held: false, reason: 'no persisted add-on window' };
  const minutes = 1;
  const breakStartedAt = breakEndsAt - 60_000;
  if (
    !Number.isFinite(input.silenceStartedAt) ||
    !Number.isFinite(input.observedAt) ||
    !(input.maxSilenceMs > 0)
  )
    return { held: false, reason: 'the observed silence is not measurable' };
  if (input.silenceStartedAt >= breakEndsAt || input.observedAt <= breakStartedAt)
    return { held: false, reason: 'the silence does not overlap the persisted add-on break' };
  const beforeBreakMs = Math.max(0, breakStartedAt - input.silenceStartedAt);
  if (beforeBreakMs > input.maxSilenceMs)
    return {
      held: false,
      reason: `the table was silent ${beforeBreakMs}ms before the add-on break began`,
    };
  const afterBreakMs = Math.max(0, input.observedAt - breakEndsAt);
  if (afterBreakMs > input.maxSilenceMs)
    return {
      held: false,
      reason: `the table did not resume within ${input.maxSilenceMs}ms after the add-on break ended`,
    };
  return {
    held: true,
    breakStartedAt,
    breakEndsAt,
    reason:
      `the silence lies inside the persisted ${minutes}-minute add-on break ` +
      `(${new Date(breakStartedAt).toISOString()} to ${new Date(breakEndsAt).toISOString()})`,
  };
}

/**
 * The hourly synchronized tournament break is an authoritative hold too.
 *
 * Since the October 20, 2026 owner change the ENGINE resets once a day at
 * 04:00 America/Chicago, so the old hourly platform freeze no longer stops the
 * post-deploy lanes at :55. Tournaments that take the synchronized break still
 * park at :55 and persist `break_started_at` / `break_ends_at` (five minutes).
 * Measured on post-deploy run 39694814807: MTT table 0260b54a dealt its last
 * hand at 23:54:27Z, `break_started_at` was 23:55:00Z, and the case failed at
 * 45 s of silence inside that break. The same bounds as the add-on hold apply:
 * silence before the break began and after it ended must each still fit the
 * ordinary gameplay silence limit, so a stall into or out of a break still fails.
 */
export const SYNCHRONIZED_BREAK_MS = 5 * 60_000;

export function classifySynchronizedBreakHold(input: {
  breakStartedAt: string | null | undefined;
  breakEndsAt: string | null | undefined;
  silenceStartedAt: number;
  observedAt: number;
  maxSilenceMs: number;
}): AddOnBreakHold {
  const startedAt = Date.parse(String(input.breakStartedAt ?? ''));
  if (!Number.isFinite(startedAt))
    return { held: false, reason: 'no persisted synchronized break' };
  const persistedEnd = Date.parse(String(input.breakEndsAt ?? ''));
  const endsAt =
    Number.isFinite(persistedEnd) && persistedEnd > startedAt
      ? persistedEnd
      : startedAt + SYNCHRONIZED_BREAK_MS;
  if (
    !Number.isFinite(input.silenceStartedAt) ||
    !Number.isFinite(input.observedAt) ||
    !(input.maxSilenceMs > 0)
  )
    return { held: false, reason: 'the observed silence is not measurable' };
  if (input.silenceStartedAt >= endsAt || input.observedAt <= startedAt)
    return { held: false, reason: 'the silence does not overlap the persisted synchronized break' };
  const beforeBreakMs = Math.max(0, startedAt - input.silenceStartedAt);
  if (beforeBreakMs > input.maxSilenceMs)
    return {
      held: false,
      reason: `the table was silent ${beforeBreakMs}ms before the synchronized break began`,
    };
  const afterBreakMs = Math.max(0, input.observedAt - endsAt);
  if (afterBreakMs > input.maxSilenceMs)
    return {
      held: false,
      reason: `the table did not resume within ${input.maxSilenceMs}ms after the synchronized break ended`,
    };
  return {
    held: true,
    breakStartedAt: startedAt,
    breakEndsAt: endsAt,
    reason:
      `the silence lies inside the persisted synchronized tournament break ` +
      `(${new Date(startedAt).toISOString()} to ${new Date(endsAt).toISOString()})`,
  };
}

/** A re-selection needs room for a whole case: selection, one hand, an outage, one more hand. */
export const MIN_RESELECTION_BUDGET_MS = 150_000;
export const MAX_NATURAL_COMPLETION_RESELECTIONS = 2;

export type ReselectionDecision = { reselect: true } | { reselect: false; reason: string };

export function decideReselection(input: {
  reselectionsUsed: number;
  remainingMs: number;
}): ReselectionDecision {
  if (input.reselectionsUsed >= MAX_NATURAL_COMPLETION_RESELECTIONS) {
    return {
      reselect: false,
      reason: `${input.reselectionsUsed} candidate replacements already used during this case`,
    };
  }
  if (!Number.isFinite(input.remainingMs) || input.remainingMs < MIN_RESELECTION_BUDGET_MS) {
    return {
      reselect: false,
      reason: `${Math.max(0, Math.round(input.remainingMs))}ms remain, below the ${MIN_RESELECTION_BUDGET_MS}ms a whole case needs`,
    };
  }
  return { reselect: true };
}
