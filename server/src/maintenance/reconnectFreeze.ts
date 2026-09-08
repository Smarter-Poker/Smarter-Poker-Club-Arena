/** Shared by already-restored engines and engines adopted after the thaw. */
let completedFreeze: { startMs: number; endMs: number } | null = null;
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
    durationMs > 900_000
  )
    return;
  completedFreeze = { startMs, endMs: startMs + durationMs };
}
/** Mutates only the reconnect clock. The freeze marker survives snapshots. */
export function thawReconnectClock(clock: ReconnectClock, freeze = completedFreeze): void {
  if (!freeze || (clock.reconnectThawedAtMs ?? 0) >= freeze.startMs) return;
  const deadline = clock.reconnectDeadlineMs;
  if (deadline === undefined || !Number.isFinite(deadline) || deadline <= freeze.startMs) return;
  const grant = Number.isFinite(clock.reconnectGrantedAtMs)
    ? clock.reconnectGrantedAtMs!
    : freeze.startMs;
  const shift = Math.max(0, freeze.endMs - Math.max(freeze.startMs, grant));
  clock.reconnectDeadlineMs = deadline + shift;
  clock.reconnectThawedAtMs = freeze.endMs;
}
