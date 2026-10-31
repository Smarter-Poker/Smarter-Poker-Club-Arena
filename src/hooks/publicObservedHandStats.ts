/** Mini-HUD observations require a server-proved committed public summary. */
export interface ObservedTendency {
  playerId: string;
  vpip: boolean;
  pfr: boolean;
  won: boolean;
  aggressiveActions?: number;
  callActions?: number;
}
const receipts = new Set<string>();

export function observePublicHandStats(
  observer: string,
  tableId: string,
  type: string,
  data: Record<string, unknown>
): ObservedTendency[] {
  if (
    !observer ||
    !tableId ||
    type.toUpperCase() !== 'HAND_PUBLIC_STATS' ||
    data.public_stats_version !== 1 ||
    typeof data.hand_id !== 'string' ||
    !data.hand_id ||
    !Array.isArray(data.players) ||
    data.players.length < 1 ||
    data.players.length > 10
  )
    return [];
  const key = JSON.stringify([observer, data.hand_id]);
  if (receipts.has(key)) return [];
  const ids = new Set<string>();
  const result: ObservedTendency[] = [];
  for (const value of data.players) {
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    if (
      typeof row.user_id !== 'string' ||
      !row.user_id ||
      ids.has(row.user_id) ||
      typeof row.vpip !== 'boolean' ||
      typeof row.pfr !== 'boolean' ||
      typeof row.won !== 'boolean' ||
      (row.pfr && !row.vpip)
    )
      return [];
    const hasAggression = row.aggressive_actions !== undefined || row.call_actions !== undefined;
    if (
      hasAggression &&
      (!Number.isSafeInteger(row.aggressive_actions) ||
        Number(row.aggressive_actions) < 0 ||
        !Number.isSafeInteger(row.call_actions) ||
        Number(row.call_actions) < 0)
    )
      return [];
    ids.add(row.user_id);
    result.push({
      playerId: row.user_id,
      vpip: row.vpip,
      pfr: row.pfr,
      won: row.won,
      ...(hasAggression
        ? {
            aggressiveActions: Number(row.aggressive_actions),
            callActions: Number(row.call_actions),
          }
        : {}),
    });
  }
  receipts.add(key);
  return result;
}
export function publicObservedReceiptKeys(): string[] {
  return [...receipts];
}
export function restorePublicObservedReceiptKeys(value: unknown): void {
  if (Array.isArray(value))
    for (const key of value) if (typeof key === 'string' && key.length <= 256) receipts.add(key);
}
export function resetPublicObservedHandStats(): void {
  receipts.clear();
}
