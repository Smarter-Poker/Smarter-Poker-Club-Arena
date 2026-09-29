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
 * - `table-engine-restarted` outranks everything: the engine told the browser
 *   it rebuilt the table (`engine_restarting`). That is a defect to name, not
 *   an ending to route around, even when the board later finishes.
 * - `natural-completion` needs the board seen RUNNING at selection, ended by
 *   the time of failure, AND the last thing the browser saw must be a hand
 *   boundary (silence that begins mid-hand is a stall, not a finish).
 * - everything else is `unproven` and the original failure stands.
 */
export function classifyCaseFailure(input: {
  engineRestartFrames: number;
  atSelection: TournamentBoardFacts | null | undefined;
  atFailure: TournamentBoardFacts | null | undefined;
  lastGameplayEventType: string | null;
}): CaseFailureOutcome {
  if (input.engineRestartFrames > 0) {
    return {
      kind: 'table-engine-restarted',
      reason: `the engine told the browser it rebuilt the table (${input.engineRestartFrames} engine_restarting frame(s))`,
    };
  }
  if (classifyBoardEnding(input.atSelection) !== 'running') {
    return {
      kind: 'unproven',
      reason: 'the board was not proven running at selection, so a later ending proves nothing',
    };
  }
  const ending = classifyBoardEnding(input.atFailure);
  if (ending !== 'natural-completion') {
    return { kind: 'unproven', reason: `the database does not show a finished board (${ending})` };
  }
  if (
    input.lastGameplayEventType !== null &&
    !HAND_BOUNDARY_EVENT_TYPES.has(input.lastGameplayEventType)
  ) {
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
      reason: `${input.reselectionsUsed} boards already ended naturally during this case`,
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
