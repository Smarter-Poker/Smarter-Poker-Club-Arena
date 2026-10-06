import { surrenderProcessOwnershipOfStrandedTeardown } from '../engine/strandedTeardownOwnership.js';

export interface AsyncTournamentManager {
  stop(): Promise<void>;
}

export interface AsyncTableEngine {
  stop(): Promise<void>;
}

/**
 * Admit a table-engine generation only when the slot is empty (or already
 * contains that exact object). This is deliberately synchronous: two callers
 * cannot both observe an empty slot and install different dealers between the
 * check and the write.
 */
export function admitOwnedTableEngine<T>(
  engines: Map<string, T>,
  tournamentOwnedTableIds: Set<string>,
  tableId: string,
  candidate: T
): boolean {
  const incumbent = engines.get(tableId);
  if (incumbent && incumbent !== candidate) return false;
  engines.set(tableId, candidate);
  tournamentOwnedTableIds.add(tableId);
  return true;
}

/**
 * Replace exactly one table-engine generation, after its teardown completes.
 *
 * Both identity checks are required. The first prevents a stale caller from
 * stopping somebody else's dealer; the second prevents either another
 * replacement or an unregister that won the await race from being overwritten.
 * A teardown failure leaves the incumbent quarantined in the slot.
 */
export async function replaceOwnedTableEngine<T extends AsyncTableEngine>(
  engines: Map<string, T>,
  tournamentOwnedTableIds: Set<string>,
  tableId: string,
  expected: T,
  replacement: T,
  replacementAllowed: () => boolean = () => true,
  adoptCustody: () => boolean = () => true
): Promise<boolean> {
  if (engines.get(tableId) !== expected || !replacementAllowed()) return false;
  await expected.stop();
  if (engines.get(tableId) !== expected || !replacementAllowed()) return false;
  if (!adoptCustody()) return false;
  engines.set(tableId, replacement);
  tournamentOwnedTableIds.add(tableId);
  return true;
}

/**
 * Release one exact tournament table-engine generation from GameServer.
 *
 * A stopped manager can finish after its successor has already registered an
 * engine for the same table id. The identity comparison and both collection
 * updates are synchronous, so the stale manager can neither remove that
 * successor nor make GameServer misclassify it as a cash table.
 */
export function unregisterOwnedTournamentTableEngine<T>(
  engines: Map<string, T>,
  tournamentOwnedTableIds: Set<string>,
  tableId: string,
  expected: T,
  onReleased?: () => void
): boolean {
  if (engines.get(tableId) !== expected) return false;
  if (
    (
      expected as { hasUnretiredStoppedTimeBankCustody?: () => boolean }
    ).hasUnretiredStoppedTimeBankCustody?.()
  )
    return false;
  engines.delete(tableId);
  tournamentOwnedTableIds.delete(tableId);
  onReleased?.();
  return true;
}

/**
 * How long a tournament manager's physical stop may stay unsettled before its
 * retirement stops waiting for it (2026-10-03, see evictStrandedManager).
 * Longer than a full set of bounded database calls (15 s each) inside one
 * teardown, short enough that the event is re-adopted within about a minute.
 */
export const STRANDED_TOURNAMENT_MANAGER_STOP_MS = 45_000;

/** Managers evicted after a stranded stop since boot. Non-zero deserves a look. */
let strandedManagerEvictions = 0;
export function strandedTournamentManagerEvictions(): number {
  return strandedManagerEvictions;
}

/**
 * Retire exactly the generation currently stored under `tournamentId`.
 *
 * The identity checks on both sides of the await are intentional. A caller
 * holding an old manager may wake after a replacement has been installed; it
 * may finish stopping its own object, but it must never delete the replacement
 * from the registry.
 *
 * A STOP THAT NEVER RETURNS DOES NOT KEEP THE EVENT (2026-10-03). Spin
 * 20a7de08 dealt its last hand at 16:33:34; its lease was last renewed at
 * 16:34:22 and kept naming the live instance until about 19:2x while 221
 * sibling leases renewed normally, and the orphan sweep filed a CRITICAL at
 * 16:52, 17:52 and 18:52. GameServer's renewal pass fences a manager whose
 * proof lapsed and retires it through here, and every later pass joins that
 * same retirement. When `stop()` never settles (an await stranded by the
 * 16:34:50 database restart) nothing after it ran: no quarantine record, no
 * lease release, no free slot for re-adoption - a dark event counted as owned.
 * So the wait is bounded. Past it the manager is evicted when that is safe
 * (evictStrandedManager) and the caller releases its exact lease as after any
 * stop; otherwise this returns false like a failed stop, so the quarantine
 * names it on /health and retries it on its own schedule.
 */
export async function stopOwnedTournamentManager<T extends AsyncTournamentManager>(
  managers: Map<string, T>,
  tournamentId: string,
  expected: T,
  onStopError?: (error: unknown) => void,
  strandedAfterMs: number = STRANDED_TOURNAMENT_MANAGER_STOP_MS
): Promise<boolean> {
  if (managers.get(tournamentId) !== expected) return false;
  let boundTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const physicalStop = expected.stop().then(() => 'stopped' as const);
    const bound = new Promise<'stranded'>((resolve) => {
      boundTimer = setTimeout(() => resolve('stranded'), strandedAfterMs);
      boundTimer.unref?.();
    });
    if ((await Promise.race([physicalStop, bound])) === 'stranded') {
      // The stranded teardown keeps running; observe its eventual failure.
      physicalStop.catch((error) => onStopError?.(error));
      return await evictStrandedManager(managers, tournamentId, expected, onStopError);
    }
  } catch (error) {
    onStopError?.(error);
    // A failed teardown is still the owner. Releasing the slot here would let
    // a replacement start while the old generation may still have live table
    // engines or callbacks. Keep it quarantined for the next cleanup pass.
    return false;
  } finally {
    if (boundTimer) clearTimeout(boundTimer);
  }
  if (managers.get(tournamentId) !== expected) return false;
  managers.delete(tournamentId);
  return true;
}

/** The slice of a TournamentManagerBase the eviction reads (structural). */
type StrandedManagerView = {
  isF06RecoveryOwner?: () => boolean;
  fenceForTournamentLeaseLoss?: () => void;
  hasCurrentTournamentLeaseAuthority?: () => boolean;
  tableEngines?: Map<string, StrandedEngineView>;
  gameServer?: {
    unregisterTournamentTableEngine?: (tableId: string, engine: never) => boolean;
  } | null;
};
type StrandedEngineView = {
  isRunning(): boolean;
  hasClaimedTournamentMoveBoundary(): boolean;
  hasUnretiredStoppedTimeBankCustody?: () => boolean;
  persistStoppedTimeBankCustody?: () => Promise<void>;
};

/** One bounded attempt to put a stopped table's time banks on disk. */
const STRANDED_CUSTODY_PERSIST_MS = 15_000;

/**
 * Evict one exact manager whose physical stop has not settled in time, so its
 * lease can be released and the event re-adopted by a fresh generation. True
 * only when the slot was freed. Why this is safe while the old teardown is
 * still pending:
 *
 *   - the manager is fenced first (synchronous, idempotent): its lease proof
 *     is expired and its stop already made every table engine terminal, so
 *     this generation can no longer deal or pass a local authority check;
 *   - every database write of the old generation stays fenced by the database
 *     on the exact lease generation (the manager request fence and hand
 *     submissions read instance, generation and heartbeat), and a successor
 *     can hold the row only under a NEW generation, after this generation's
 *     exact release or its 30 s staleness;
 *   - each engine gives its process-wide table slot back only through
 *     surrenderProcessOwnershipOfStrandedTeardown, and leaves GameServer's
 *     registry only through its identity-CAS unregister, which still refuses
 *     a table whose stopped time banks are not on disk; every later step of
 *     the stranded teardown is identity-CAS too, so it never removes a
 *     successor.
 *
 * It refuses - and the caller's quarantine names it and retries it - for an
 * F06 recovery owner, a table holding a claimed seat-move boundary (the
 * custody a fresh generation cannot rebuild from the database), time banks
 * that cannot be written down, and anything that is not a fenceable manager.
 */
async function evictStrandedManager<T>(
  managers: Map<string, T>,
  tournamentId: string,
  expected: T,
  onStopError?: (error: unknown) => void
): Promise<boolean> {
  if (managers.get(tournamentId) !== expected) return false;
  const manager = expected as unknown as StrandedManagerView;
  const refuse = (reason: string): false => {
    onStopError?.(
      new Error(
        `Tournament ${tournamentId} manager stop has not settled in ` +
          `${STRANDED_TOURNAMENT_MANAGER_STOP_MS} ms and was not evicted: ${reason}`
      )
    );
    return false;
  };
  if (
    typeof manager.fenceForTournamentLeaseLoss !== 'function' ||
    typeof manager.hasCurrentTournamentLeaseAuthority !== 'function'
  ) {
    return refuse('not_a_fenceable_manager');
  }
  if (manager.isF06RecoveryOwner?.()) return refuse('f06_recovery_owner');
  manager.fenceForTournamentLeaseLoss();
  if (manager.hasCurrentTournamentLeaseAuthority()) return refuse('lease_authority_current');
  const engines = [...(manager.tableEngines ?? new Map<string, StrandedEngineView>())];
  for (const [tableId, engine] of engines) {
    if (engine.isRunning()) return refuse(`table_running:${tableId}`);
    if (engine.hasClaimedTournamentMoveBoundary()) return refuse(`seat_move_boundary:${tableId}`);
  }
  for (const [tableId, engine] of engines) {
    if (!surrenderProcessOwnershipOfStrandedTeardown(engine as never)) {
      return refuse(`table_not_terminal:${tableId}`);
    }
  }
  // The stranded stop never reached the step that writes stopped time banks
  // down; do it here, bounded, so the registry may let the table go.
  for (const [, engine] of engines) {
    if (!engine.hasUnretiredStoppedTimeBankCustody?.()) continue;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.resolve()
        .then(() => engine.persistStoppedTimeBankCustody?.())
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STRANDED_CUSTODY_PERSIST_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
  if (managers.get(tournamentId) !== expected) return false;
  for (const [tableId, engine] of engines) {
    if (engine.hasUnretiredStoppedTimeBankCustody?.()) {
      return refuse(`time_bank_custody_not_on_disk:${tableId}`);
    }
  }
  for (const [tableId, engine] of engines) {
    manager.gameServer?.unregisterTournamentTableEngine?.(tableId, engine as never);
  }
  managers.delete(tournamentId);
  strandedManagerEvictions++;
  onStopError?.(
    new Error(
      `Tournament ${tournamentId} manager stop had not settled after ` +
        `${STRANDED_TOURNAMENT_MANAGER_STOP_MS} ms; evicted the fenced manager and ` +
        `${engines.length} terminal table engine(s) so its exact lease is released ` +
        `and the event re-adopted`
    )
  );
  return true;
}
