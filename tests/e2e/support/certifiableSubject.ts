/**
 * certifiableSubject.ts - an absent subject is not a broken subject.
 *
 * WHY (2026-09-30, CLAUDE.md 10.86 rule 1)
 *
 * `production-live-table-realtime.spec.ts` certifies that AN ALREADY-RUNNING
 * table stays realtime through a disruption. It does not create that table:
 * production has to be running one, in the fixture club, in the right format,
 * with enough dealable seats, and (for the MTT) inside a tournament whose blind
 * clock can still yield a natural level after recovery.
 *
 * That is a precondition production cannot always supply. Post-deploy run
 * 36748751745 is the worked example: SPIN, SNG and the cash network-loss case
 * all passed, and the MTT case failed with
 *
 *   production exposed no already-running MTT table with 3+ dealable players
 *   ... whose tournament can yield an eligible natural HUD clock ... inside 90000ms
 *
 * while the fleet was demonstrably alive. Nothing was wrong with the live site.
 * The suite simply had no name for "there was nothing to observe", so it used
 * the only one it had: failure.
 *
 * There are two genuinely different states behind one empty candidate list, and
 * `classifyMissingTournamentSubject` separates them from the scoped evidence:
 *
 *   stalled  a table of this format, in this club, with enough dealable seats
 *            and not paused by design, has stopped making progress. Production
 *            IS broken and the case stays red, naming the table.
 *   absent   no such table was running at all, or none could satisfy the
 *            case's own clock requirement. Nothing was observed, so nothing is
 *            certified and nothing is condemned: a named non-verdict.
 *
 * The distinction is deliberately conservative. `absent` requires that not one
 * table in scope was both in the certifiable shape and silent; the moment one
 * is, the verdict is `stalled`.
 */

/**
 * The engine's own visibility threshold for a stalled table: 2+ dealable seats,
 * not paused by design, no observable progress for 2 minutes
 * (server/src/GameServer.ts, `stalledTables`, and `poker_stalled_tables`).
 * Reused rather than re-guessed so the harness and the engine mean one thing.
 */
export const ENGINE_STALL_REPORT_MS = 120_000;

export interface LivenessRow {
  tableId: string;
  gameFormat: string | null;
  clubId: string | null;
  seated: number;
  dealable: number;
  handCount: number;
  msSinceProgress: number;
  loopPhase: string;
  paused: boolean;
}

export interface StalledSubject {
  tableId: string;
  gameFormat: string | null;
  clubId: string | null;
  dealable: number;
  secsIdle: number;
  loopPhase: string;
}

function asStalled(row: LivenessRow): StalledSubject {
  return {
    tableId: row.tableId,
    gameFormat: row.gameFormat,
    clubId: row.clubId,
    dealable: row.dealable,
    secsIdle: Math.round(row.msSinceProgress / 1000),
    loopPhase: row.loopPhase,
  };
}

/**
 * Tables inside the scope THIS read requested that have stopped dealing.
 *
 * The scope is what the certificate is about. `stalledTableCount` and
 * `deadStalledCount` on /health are fleet-wide aggregates that ignore the
 * scope entirely, and the engine itself refuses to condemn a fleet for a
 * minority of them - that is what `wholeFleetStalled` is for, after
 * `poker_engine_liveness` spent 136 of 139 minutes at zero because of one
 * table out of 312 (server/src/GameServer.ts).
 */
export function scopedStalledTables(rows: readonly LivenessRow[]): StalledSubject[] {
  return rows
    .filter(
      (row) => !row.paused && row.dealable >= 2 && row.msSinceProgress > ENGINE_STALL_REPORT_MS
    )
    .map(asStalled);
}

export type MissingSubjectVerdict =
  | { verdict: 'stalled'; stalled: StalledSubject[]; inScope: number; runningShape: number }
  | { verdict: 'absent'; stalled: []; inScope: number; runningShape: number };

/**
 * Why there was no table to certify: production is broken, or production had
 * nothing running for this case to watch.
 */
export function classifyMissingTournamentSubject(options: {
  rows: readonly LivenessRow[];
  gameFormat: string;
  clubIds: readonly string[];
  minimumStableSeats: number;
  maxGameplaySilenceMs: number;
}): MissingSubjectVerdict {
  const { rows, gameFormat, clubIds, minimumStableSeats, maxGameplaySilenceMs } = options;
  const inScope = rows.filter(
    (row) => row.gameFormat === gameFormat && clubIds.includes(String(row.clubId))
  );
  /* The shape this case can certify at all: seated, dealable, dealing, and not
     parked by design. Whether such a table is SILENT is the whole question. */
  const runningShape = inScope.filter(
    (row) =>
      !row.paused &&
      row.handCount >= 1 &&
      row.seated >= minimumStableSeats &&
      row.dealable >= minimumStableSeats
  );
  const stalled = runningShape
    .filter((row) => row.msSinceProgress > Math.max(maxGameplaySilenceMs, ENGINE_STALL_REPORT_MS))
    .map(asStalled);
  if (stalled.length > 0) {
    return {
      verdict: 'stalled',
      stalled,
      inScope: inScope.length,
      runningShape: runningShape.length,
    };
  }
  return {
    verdict: 'absent',
    stalled: [],
    inScope: inScope.length,
    runningShape: runningShape.length,
  };
}
