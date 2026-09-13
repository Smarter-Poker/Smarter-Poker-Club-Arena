/** Gameplay degradation is separate from process/routing readiness. */
export const SETTLEMENT_BLOCKED_MS = 30_000;

export interface SettlementTableObservation {
  tableId: string;
  handCount: number;
  settlementAgeMs: number | null;
  loopPhase?: string;
}

export function settlementHealthSnapshot(tables: readonly SettlementTableObservation[]) {
  const blocked = tables
    .filter(
      (table) => table.settlementAgeMs !== null && table.settlementAgeMs >= SETTLEMENT_BLOCKED_MS
    )
    .sort((a, b) => b.settlementAgeMs! - a.settlementAgeMs!);
  return {
    settlementStatus: blocked.length > 0 ? ('blocked' as const) : ('ok' as const),
    blockedSettlementCount: blocked.length,
    blockedSettlements: blocked.slice(0, 20).map((table) => ({
      tableId: table.tableId,
      handCount: table.handCount,
      ageMs: table.settlementAgeMs!,
      // Already captured by the engine's liveness walk. Keep the blocked
      // generation's phase without restoring the full fleet to /health.
      ...(table.loopPhase ? { loopPhase: table.loopPhase } : {}),
    })),
  };
}

export function settlementPrometheusLines(tables: readonly SettlementTableObservation[]): string[] {
  const health = settlementHealthSnapshot(tables);
  return [
    '# HELP poker_blocked_settlements Tables awaiting an owned settlement for at least 30 seconds, independent of retry heartbeats',
    '# TYPE poker_blocked_settlements gauge',
    `poker_blocked_settlements ${health.blockedSettlementCount}`,
    /* ── A SETTLEMENT THAT IS NOT HAPPENING IS NOT A SAMPLE (2026-09-11) ────
     *
     * This emitted one series per table, and the value is zero for every table
     * that is not mid-settlement, which is almost all of them: measured on
     * engine-01, 1,363 samples of this gauge and every single one read 0. The
     * exposition is built on the authoritative event loop, so those samples
     * are paid for in main-loop time every fifteen seconds.
     *
     * A table with no settlement in flight now contributes nothing, and the
     * fleet answer is always present beside it. `poker_blocked_settlements`
     * above is unchanged and remains the alarm; the per-table line survives
     * for exactly the tables an operator would want to name.
     */
    '# HELP poker_settlement_age_max_ms The oldest settlement in flight anywhere on this engine, zero when none is',
    '# TYPE poker_settlement_age_max_ms gauge',
    `poker_settlement_age_max_ms ${tables.reduce((max, t) => Math.max(max, t.settlementAgeMs ?? 0), 0)}`,
    '# HELP poker_settlements_in_flight Tables with a settlement in flight right now',
    '# TYPE poker_settlements_in_flight gauge',
    `poker_settlements_in_flight ${tables.filter((t) => (t.settlementAgeMs ?? 0) > 0).length}`,
    '# HELP poker_table_settlement_age_ms Continuous settlement age; emitted only for a table actually settling',
    '# TYPE poker_table_settlement_age_ms gauge',
    ...tables
      .filter((table) => (table.settlementAgeMs ?? 0) > 0)
      .map(
        (table) =>
          `poker_table_settlement_age_ms{table_id="${table.tableId}"} ${table.settlementAgeMs}`
      ),
  ];
}
