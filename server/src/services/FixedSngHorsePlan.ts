/** A database plan is permission to attempt the existing paid registration door. */
export function fixedSngHorseCount(
  plan: unknown,
  seats: number,
  current: number,
  requested: number
): number {
  if (!plan || typeof plan !== 'object') return 0;
  const row = plan as { ok?: unknown; target_players?: unknown };
  const target = row.target_players;
  if (
    row.ok !== true ||
    !Number.isInteger(target) ||
    typeof target !== 'number' ||
    target < 0 ||
    target > seats ||
    !Number.isInteger(current) ||
    current < 0 ||
    !Number.isFinite(requested) ||
    requested <= 0
  )
    return 0;
  return Math.min(Math.floor(requested), Math.max(0, target - current));
}
