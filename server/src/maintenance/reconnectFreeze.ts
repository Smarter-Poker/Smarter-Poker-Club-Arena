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
/**
 * The absence clocks a break must not burn (CLAUDE.md 13 rule 4).
 *
 * Three engine-memory stamps start a five-minute removal clock at a cash
 * table: `sitOutSince` (the sit-out limit), `disconnectedAt` and `pageLeftAt`
 * (the abandoned-seat limit). The database copy of the first, `sit_out_at`,
 * is moved forward by fn_thaw_platform, but the engine judges the eviction on
 * its own copy, and the park written for the restart restores that copy
 * unmoved. So a player who sat out or dropped a minute before the :55 break
 * was removed on the first sweep after the thaw, having used one minute of
 * the five.
 *
 * `presenceThawedAtMs` is the compensated-through marker and travels with the
 * FSM entry, so a restore before or after the thaw credits the interval once.
 */
export interface PresenceClock {
  sitOutSince?: number | null;
  disconnectedAt?: number;
  pageLeftAt?: number | null;
  presenceThawedAtMs?: number;
}
export function completeReconnectFreeze(startMs: number, durationMs: number): void {
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    !Number.isFinite(startMs + durationMs) ||
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
    !Number.isFinite(endMs - startMs)
  )
    return;
  tableResumeEnds.set(tableId, Math.max(tableResumeEnds.get(tableId) ?? 0, endMs));
}
export function thawTableReconnectClock(tableId: string, clock: ReconnectClock): void {
  if (!completedFreeze) return;
  const endMs = Math.max(completedFreeze.endMs, tableResumeEnds.get(tableId) ?? 0);
  thawReconnectClock(clock, { startMs: completedFreeze.startMs, endMs });
}
export function thawTablePresenceClock(tableId: string, clock: PresenceClock): void {
  if (!completedFreeze) return;
  const endMs = Math.max(completedFreeze.endMs, tableResumeEnds.get(tableId) ?? 0);
  thawPresenceClock(clock, { startMs: completedFreeze.startMs, endMs });
}
/** Moves each absence stamp forward by the frozen time it has not yet been credited. */
export function thawPresenceClock(clock: PresenceClock, freeze = completedFreeze): void {
  if (!freeze) return;
  const alreadyThawed = Number.isFinite(clock.presenceThawedAtMs)
    ? clock.presenceThawedAtMs!
    : freeze.startMs;
  if (alreadyThawed >= freeze.endMs) return;
  const shifted = (stamp: number | null | undefined): number | null | undefined => {
    // A stamp made after the frozen interval lost nothing to it.
    if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp >= freeze.endMs) return stamp;
    const creditFrom = Math.max(freeze.startMs, stamp, alreadyThawed);
    return stamp + Math.max(0, freeze.endMs - creditFrom);
  };
  clock.sitOutSince = shifted(clock.sitOutSince) as number | null | undefined;
  clock.disconnectedAt = shifted(clock.disconnectedAt) as number | undefined;
  clock.pageLeftAt = shifted(clock.pageLeftAt) as number | null | undefined;
  clock.presenceThawedAtMs = freeze.endMs;
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
