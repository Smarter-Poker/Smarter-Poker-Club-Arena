/**
 * The one authoritative engine-liveness computation.
 *
 * `/health` drives Docker autoheal while `/metrics` drives alerts. They used
 * to reimplement this rule independently, so Prometheus could say the process
 * was dead while Docker correctly kept it alive. Keep every threshold and
 * derived predicate here; callers provide only raw observations.
 */

export const ENGINE_STARTUP_GRACE_MS = 180_000;
export const TABLE_RECENT_PROGRESS_MS = 120_000;
export const TABLE_DEAD_STALL_MS = 300_000;
export const DISCOVERY_SOFT_STALL_MS = 60_000;
export const DISCOVERY_HARD_STALL_MS = 900_000;
export const BARREN_DISCOVERY_STALE_MS = 600_000;

export interface EngineLivenessTable {
  dealable: number;
  paused: boolean;
  msSinceProgress: number;
}

export interface EngineLivenessObservation {
  isLeader: boolean;
  processUptimeMs: number;
  discoveryLoopStalledMs: number;
  discoveryStaleMs: number;
  dbConfirmedDead: boolean;
  tables: readonly EngineLivenessTable[];
}

export interface EngineLivenessVerdict {
  status: 'ok' | 'standby' | 'dead';
  prometheusValue: 0 | 1;
  stillBooting: boolean;
  anyTableProgressedRecently: boolean;
  deadStalledCount: number;
  dealableTableCount: number;
  wholeFleetStalled: boolean;
  discoveryLoopDead: boolean;
  barrenLeaderDead: boolean;
  dbConfirmedDead: boolean;
}

export function evaluateEngineLiveness(
  observation: EngineLivenessObservation
): EngineLivenessVerdict {
  const dealableTables = observation.tables.filter((table) => table.dealable >= 2 && !table.paused);
  const deadStalledCount = dealableTables.filter(
    (table) => table.msSinceProgress > TABLE_DEAD_STALL_MS
  ).length;
  const dealableTableCount = dealableTables.length;
  const wholeFleetStalled = dealableTableCount > 0 && deadStalledCount >= dealableTableCount;

  const stillBooting = observation.processUptimeMs < ENGINE_STARTUP_GRACE_MS;
  const anyTableProgressedRecently = observation.tables.some(
    (table) => table.msSinceProgress < TABLE_RECENT_PROGRESS_MS
  );
  const discoveryLoopDead =
    !stillBooting &&
    (observation.discoveryLoopStalledMs > DISCOVERY_HARD_STALL_MS ||
      (observation.discoveryLoopStalledMs > DISCOVERY_SOFT_STALL_MS &&
        !anyTableProgressedRecently));
  const barrenLeaderDead =
    !stillBooting &&
    observation.tables.length === 0 &&
    observation.discoveryStaleMs > BARREN_DISCOVERY_STALE_MS;

  const leaderDead =
    observation.isLeader &&
    (wholeFleetStalled || discoveryLoopDead || barrenLeaderDead || observation.dbConfirmedDead);
  const status = !observation.isLeader ? 'standby' : leaderDead ? 'dead' : 'ok';

  return {
    status,
    // Standby is intentionally healthy to Docker and therefore 1 here too.
    prometheusValue: leaderDead ? 0 : 1,
    stillBooting,
    anyTableProgressedRecently,
    deadStalledCount,
    dealableTableCount,
    wholeFleetStalled,
    discoveryLoopDead,
    barrenLeaderDead,
    dbConfirmedDead: observation.dbConfirmedDead,
  };
}
