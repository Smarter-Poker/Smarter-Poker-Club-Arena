import type { RosterConnectionState } from '../../utils/rosterReadReliability';
import './RosterConnectionStatus.css';

interface RosterConnectionStatusProps {
  state: RosterConnectionState;
  hasData: boolean;
  lastSuccessfulSyncAt?: number | null;
  isRefreshing?: boolean;
  isSlow?: boolean;
  onRetry: () => void;
}

function syncTime(value: number | null | undefined): string | null {
  if (!value || !Number.isFinite(value)) return null;
  return new Date(value).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function RosterConnectionStatus({
  state,
  hasData,
  lastSuccessfulSyncAt,
  isRefreshing = false,
  isSlow = false,
  onRetry,
}: RosterConnectionStatusProps) {
  if (state === 'live' && !isRefreshing && !isSlow) return null;

  const lastSync = syncTime(lastSuccessfulSyncAt);
  let message = 'Connecting To The Live Roster...';
  let retryable = false;

  if (isRefreshing) {
    message = hasData
      ? 'Refreshing The Live Roster. The Last Verified Results Remain Available.'
      : 'Connecting To The Live Roster...';
  } else if (state === 'offline') {
    message = hasData
      ? 'Connection Lost. Showing The Last Verified Roster.'
      : 'Connection Lost. Reconnect To Load The Roster.';
    retryable = true;
  } else if (state === 'stale') {
    message = hasData
      ? 'Live Sync Failed. Showing The Last Verified Roster.'
      : 'The Live Roster Could Not Be Loaded.';
    retryable = true;
  } else if (state === 'reconnecting') {
    message = hasData
      ? 'Live Updates Interrupted. Reconnecting While The Last Verified Roster Remains Available.'
      : 'Live Updates Interrupted. Reconnecting...';
    retryable = true;
  } else if (hasData) {
    message = 'Verifying The Live Roster. The Last Verified Results Remain Available.';
  } else if (isSlow) {
    message = 'The Live Roster Is Taking Longer Than Expected. It Is Still Connecting...';
  }

  return (
    <div className="members-refreshing members-connection-status" data-connection-state={state}>
      <span role="status" aria-live="polite" aria-atomic="true" data-connection-state={state}>
        {message}
        {lastSync ? ` Last Live Sync ${lastSync}.` : ''}
      </span>
      {retryable && (
        <button
          type="button"
          className="members-refresh members-connection-status__retry"
          onClick={onRetry}
        >
          Retry Live Sync
        </button>
      )}
    </div>
  );
}
