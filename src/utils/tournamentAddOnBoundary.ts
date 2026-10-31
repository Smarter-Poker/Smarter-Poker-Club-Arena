/** Presentation follows the locked purchase authority; it never grants eligibility. */
export function tournamentAddOnEntryBoundaryPassed(
  row: Record<string, unknown> | null | undefined,
  now: number
): boolean {
  if (!row || row.status !== 'RUNNING' || row.current_level == null) return false;
  const level = Number(row.current_level);
  const cap = Number(row.late_reg_levels ?? row.rebuy_levels ?? 0);
  if (!Number.isFinite(level) || !Number.isFinite(cap) || level < cap) return false;
  if (cap <= 0 && Number(row.late_reg_mins) > 0) {
    const started = Date.parse(String(row.started_at ?? ''));
    if (!Number.isFinite(started) || now < started + Number(row.late_reg_mins) * 60_000)
      return false;
  }
  const start = Date.parse(String(row.addon_period_started_at ?? ''));
  const end = Date.parse(String(row.addon_period_ends_at ?? ''));
  return !(row.addon_from_start === true && end - start > 60_000);
}
