/** Gameplay degradation is separate from process/routing readiness. */
export const SETTLEMENT_BLOCKED_MS = 30_000;

export interface SettlementTableObservation {
  tableId: string;
  handCount: number;
  settlementAgeMs: number | null;
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
    })),
  };
}

export function settlementPrometheusLines(tables: readonly SettlementTableObservation[]): string[] {
  const health = settlementHealthSnapshot(tables);
  return [
    '# HELP poker_blocked_settlements Tables awaiting an owned settlement for at least 30 seconds, independent of retry heartbeats',
    '# TYPE poker_blocked_settlements gauge',
    `poker_blocked_settlements ${health.blockedSettlementCount}`,
    '# HELP poker_table_settlement_age_ms Continuous settlement age; zero when no settlement is in flight',
    '# TYPE poker_table_settlement_age_ms gauge',
    ...tables.map(
      (table) =>
        `poker_table_settlement_age_ms{table_id="${table.tableId}"} ${table.settlementAgeMs ?? 0}`
    ),
  ];
}
