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
  replacement: T
): Promise<boolean> {
  if (engines.get(tableId) !== expected) return false;
  await expected.stop();
  if (engines.get(tableId) !== expected) return false;
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
  engines.delete(tableId);
  tournamentOwnedTableIds.delete(tableId);
  onReleased?.();
  return true;
}

/**
 * Retire exactly the generation currently stored under `tournamentId`.
 *
 * The identity checks on both sides of the await are intentional. A caller
 * holding an old manager may wake after a replacement has been installed; it
 * may finish stopping its own object, but it must never delete the replacement
 * from the registry.
 */
export async function stopOwnedTournamentManager<T extends AsyncTournamentManager>(
  managers: Map<string, T>,
  tournamentId: string,
  expected: T,
  onStopError?: (error: unknown) => void
): Promise<boolean> {
  if (managers.get(tournamentId) !== expected) return false;
  try {
    await expected.stop();
  } catch (error) {
    onStopError?.(error);
    // A failed teardown is still the owner. Releasing the slot here would let
    // a replacement start while the old generation may still have live table
    // engines or callbacks. Keep it quarantined for the next cleanup pass.
    return false;
  }
  if (managers.get(tournamentId) !== expected) return false;
  managers.delete(tournamentId);
  return true;
}
