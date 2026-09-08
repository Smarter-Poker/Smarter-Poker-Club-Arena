interface ReconnectFreeze {
  startMs: number;
  endMs: number;
}
/** Shared by already-restored engines and engines adopted after the thaw. */
let completedFreeze: ReconnectFreeze | null = null;
const tableResumeEnds = new Map<string, number>();
export interface ReconnectClock {
  reconnectDeadlineMs?: number;
  reconnectGrantedAtMs?: number;
  reconnectThawedAtMs?: number;
}
export function completeReconnectFreeze(startMs: number, durationMs: number): void {
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    durationMs > 900_000 ||
    (completedFreeze !== null && startMs < completedFreeze.startMs)
  )
    return;
  if (completedFreeze?.startMs === startMs) {
    completedFreeze.endMs = Math.max(completedFreeze.endMs, startMs + durationMs);
  } else {
    completedFreeze = { startMs, endMs: startMs + durationMs };
    tableResumeEnds.clear();
  }
}
/** Record the actual wave boundary before that table can judge a turn clock. */
export function completeTableReconnectFreeze(
  tableId: string,
  startMs: number,
  endMs: number
): void {
  if (
    !completedFreeze ||
    completedFreeze.startMs !== startMs ||
    !Number.isFinite(endMs) ||
    endMs < completedFreeze.endMs ||
    endMs - startMs > 900_000
  )
    return;
  tableResumeEnds.set(tableId, Math.max(tableResumeEnds.get(tableId) ?? 0, endMs));
}
export function thawTableReconnectClock(tableId: string, clock: ReconnectClock): void {
  if (!completedFreeze) return;
  const endMs = Math.max(completedFreeze.endMs, tableResumeEnds.get(tableId) ?? 0);
  thawReconnectClock(clock, { startMs: completedFreeze.startMs, endMs });
}
/** Mutates only the reconnect clock. The compensated-through marker survives snapshots. */
export function thawReconnectClock(clock: ReconnectClock, freeze = completedFreeze): void {
  if (!freeze) return;
  const alreadyThawed = Number.isFinite(clock.reconnectThawedAtMs)
    ? clock.reconnectThawedAtMs!
    : freeze.startMs;
  if (alreadyThawed >= freeze.endMs) return;
  const deadline = clock.reconnectDeadlineMs;
  const grant = Number.isFinite(clock.reconnectGrantedAtMs)
    ? clock.reconnectGrantedAtMs!
    : freeze.startMs;
  const creditFrom = Math.max(freeze.startMs, grant, alreadyThawed);
  // An allowance exhausted before the uncredited interval cannot be revived.
  if (deadline === undefined || !Number.isFinite(deadline) || deadline <= creditFrom) return;
  clock.reconnectDeadlineMs = deadline + Math.max(0, freeze.endMs - creditFrom);
  clock.reconnectThawedAtMs = freeze.endMs;
}
