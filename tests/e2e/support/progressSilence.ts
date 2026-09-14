/** Keep a sampled inactivity failure from disappearing after a later recovery. */
export function createProgressSilenceGuard(maxSilenceMs: number) {
  const failed = new Set<string>();
  return (table: { tableId: string; msSinceProgress: number } | undefined): boolean => {
    if (!table) return false;
    if (
      !Number.isFinite(table.msSinceProgress) ||
      table.msSinceProgress < 0 ||
      table.msSinceProgress > maxSilenceMs
    ) {
      failed.add(table.tableId);
    }
    return !failed.has(table.tableId);
  };
}
