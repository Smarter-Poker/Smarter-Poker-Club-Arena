import { CasinoControlIcon } from '../CasinoControlIcon';
import styles from '../../../pages/DailyChallengesPage.module.css';
import { MISSION_SYNC_FORMATTER } from './missionPresentation';

export function MissionSyncNotice({
  loadError,
  lastSyncedAt,
  isRefreshing,
  onRetry,
}: {
  loadError: string;
  lastSyncedAt: number | null;
  isRefreshing: boolean;
  onRetry: () => void;
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
