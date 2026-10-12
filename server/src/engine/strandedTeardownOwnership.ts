/**
 * A STOP THAT NEVER RETURNS DOES NOT KEEP THE TABLE (2026-10-03).
 *
 * ServerTableEngineBase.performStop joins every in-flight writer BEFORE it
 * releases this generation's process-wide slot (`liveEngines`, the shared
 * heartbeat and turn deadlines). If one of those writers never settles - an
 * await stranded by a database connection reset - the slot is held forever and
 * no successor engine for the table can claim it (`claimCurrentEngine` never
 * evicts a live generation). Spin 20a7de08 sat dark from 16:34 to 19:23 on
 * 2026-10-03 with exactly that kind of stop pending.
 *
 * The only caller is TournamentManagerOwnership's stranded-stop eviction, for
 * a TERMINAL engine of a fenced tournament manager whose stop has not settled
 * within its bound. This gives the slot back and cancels that generation's own
 * shared deadlines. The stranded teardown, if it ever resumes, then sees a
 * superseded instance and drops in-memory state only (performStop re-reads
 * ownership after every await). Nothing is abandoned to authority: the engine
 * cannot deal (terminal, not running, proof expired) and every money write is
 * still fenced by the database on the exact lease generation.
 *
 * It lives here, beside the engine but outside its 500 KB base file, and
 * reaches the base class's own private slot bookkeeping through a structural
 * cast, on purpose and only for the members named in SlotInternals and
 * SlotStatics.
 */
import { deadlineScheduler } from './DeadlineScheduler.js';
import { ServerTableEngineBase } from './ServerTableEngineBase.js';

type SlotInternals = {
  tableId: string;
  terminal: boolean;
  running: boolean;
  claimedProcessOwnership: boolean;
  heartbeatActive: boolean;
  clearTurnTimer(): void;
};

type SlotStatics = {
  isCurrentEngineFor(tableId: string, engine: unknown): boolean;
  releaseCurrentEngine(tableId: string, engine: unknown): void;
  HEARTBEAT_EVENT_ID: string;
};

/**
 * Give back the process-wide table slot of a terminal engine whose teardown
 * is stranded. True when the engine no longer holds the slot (released here or
 * already gone); false, changing nothing, unless the engine is terminal and
 * stopped. Never touches a slot held by any other engine.
 */
export function surrenderProcessOwnershipOfStrandedTeardown(
  engine: ServerTableEngineBase
): boolean {
  const self = engine as unknown as SlotInternals;
  const statics = ServerTableEngineBase as unknown as SlotStatics;
  if (!self.terminal || self.running) return false;
  if (!self.claimedProcessOwnership || !statics.isCurrentEngineFor(self.tableId, engine)) {
    return true;
  }
  self.heartbeatActive = false;
  try {
    self.clearTurnTimer();
  } catch {
    /* the slot release below is the point; a timer already gone is fine */
  }
  deadlineScheduler.cancel(self.tableId, statics.HEARTBEAT_EVENT_ID);
  statics.releaseCurrentEngine(self.tableId, engine);
  return true;
}
