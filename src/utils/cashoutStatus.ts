/**
 * How a cash-out request reads in the Transaction History (Dan 2026-10-24):
 * a request nobody has decided yet shows how long it has waited.
 */

/** How a cash-out request reads on its receipt. */
export function cashoutStatusLabel(status: string | null | undefined): string | null {
  switch (status) {
    case 'pending':
    case 'acknowledged':
      return 'Waiting';
    case 'approved':
    case 'completed':
      return 'Accepted';
    case 'rejected':
    case 'denied':
    case 'cancelled':
      return 'Cancelled';
    case 'expired':
      return 'Expired';
    default:
      return null;
  }
}

/** "Waiting 2h 5m": how long a cash-out request has waited for a decision. */
export function waitingFor(since: string | null | undefined, now: number = Date.now()): string {
  const started = since ? new Date(since).getTime() : NaN;
  if (!Number.isFinite(started)) return 'Waiting';
  const minutes = Math.max(0, Math.floor((now - started) / 60000));
  if (minutes < 1) return 'Waiting Under 1m';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `Waiting ${days}d ${hours}h`;
  if (hours > 0) return `Waiting ${hours}h ${mins}m`;
  return `Waiting ${mins}m`;
}
