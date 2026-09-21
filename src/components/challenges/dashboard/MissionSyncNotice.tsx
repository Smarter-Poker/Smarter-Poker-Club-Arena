import { CasinoControlIcon } from '../CasinoControlIcon';
import styles from '../../../pages/DailyChallengesPage.module.css';

// Integration seam: the presentation tables and artwork helpers still live on the
// page while the sibling extraction moves them to `missionPresentation.ts`,
// `MissionArtwork.tsx` and `MissionClockLeaves.tsx`. Until that lands they are
// handed in as props under their own names so this body stays verbatim.

export function MissionSyncNotice({
  loadError,
  lastSyncedAt,
  isRefreshing,
  onRetry,
  MISSION_SYNC_FORMATTER,
}: {
  loadError: string;
  lastSyncedAt: number | null;
  isRefreshing: boolean;
  onRetry: () => void;
  MISSION_SYNC_FORMATTER: Intl.DateTimeFormat;
}) {
  return (
    <aside className={`${styles.syncNotice} ${styles.syncNoticeError}`} role="alert">
      <span className={styles.bevelFrame} aria-hidden="true" />
      <div>
        <span className={styles.panelLabel}>Challenge Ledger Interrupted</span>
        <strong>{loadError}</strong>
        {lastSyncedAt && (
          <small>Last Successful Sync: {MISSION_SYNC_FORMATTER.format(lastSyncedAt)}</small>
        )}
      </div>
      <button
        type="button"
        className={styles.retryButton}
        onClick={onRetry}
        disabled={isRefreshing}
      >
        <CasinoControlIcon
          variant="sync"
          state={isRefreshing ? 'pending' : 'attention'}
          size="sm"
        />
        {isRefreshing ? 'Reconnecting...' : 'Retry Sync'}
      </button>
    </aside>
  );
}
