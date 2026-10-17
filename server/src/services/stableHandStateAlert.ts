/**
 * THE STABLE HAND COUNTER ALERT CLOSES WHEN THE COUNTERS WRITE AGAIN
 * (2026-10-17).
 *
 * `HorseFleet.stableHandState` is raised by the fleet when a cycle folded
 * counter rows and none were accepted. It describes a condition - "the three
 * counter-driven gates are reading zero" - that ends the moment a write is
 * accepted again. Nothing closed it: all three rows ever raised (2026-09-22,
 * 2026-10-11, 2026-10-16) were transient and each was closed by hand, the last
 * one after the counters had been writing for a day.
 *
 * Read from the database, not from this process's memory, so an alert raised
 * by the engine a restart replaced is still closed (the Free Buy watch's
 * f2c43ab2 lesson).
 */
export const STABLE_HAND_STATE_ALERT_SOURCE = 'HorseFleet.stableHandState';

export interface StableHandAlertStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: 'financial_alerts'): any;
}

export function stableHandStateClearedResolution(written: number, atIso: string): string {
  return (
    `Cleared by the fleet at ${atIso}: a Stable Hand counter write was accepted again ` +
    `(${written} of ${written} row(s)), so the sit count, daily minute cap and two-hour ` +
    're-buy window read their real counters.'
  );
}

/**
 * Resolve every open `HorseFleet.stableHandState` row after a write in which
 * every folded row was accepted. Returns how many rows it closed; throws on a
 * database error so the caller reports it.
 */
export async function closeStableHandStateAlert(
  db: StableHandAlertStore,
  written: number,
  nowMs: number
): Promise<number> {
  const at = new Date(nowMs).toISOString();
  const { data, error } = (await db
    .from('financial_alerts')
    .update({
      resolved: true,
      resolved_at: at,
      resolution: stableHandStateClearedResolution(written, at),
    })
    .eq('source', STABLE_HAND_STATE_ALERT_SOURCE)
    .eq('resolved', false)
    .select('id')) as { data: Array<{ id: string }> | null; error: { message: string } | null };
  if (error) throw new Error(`stable_hand_state_alert_close_failed: ${error.message}`);
  return (data ?? []).length;
}
