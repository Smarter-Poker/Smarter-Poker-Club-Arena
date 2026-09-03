/**
 * Formats a timestamp into a human-readable relative time string.
 * Compact mode returns short form (e.g., "5m", "2h"), full mode returns long form (e.g., "5m ago", "2h ago").
 */
export function formatTimeAgo(dateStr: string, compact = false): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return compact ? 'Now' : 'Active now';
  if (mins < 60) return compact ? `${mins}m` : `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return compact ? `${hrs}h` : `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return compact ? `${days}d` : `${days}d ago`;
}
