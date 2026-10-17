import StandardContentLayout from '../../layouts/StandardContentLayout';
import styles from '../../../pages/DailyChallengesPage.module.css';
import type { Tier } from '../../../services/DailyChallengeService';
import { CasinoControlIcon } from '../CasinoControlIcon';
import { TIER_PRESENTATION } from './missionPresentation';

/* A cold-ledger failure prints the failure and its retry, first on the page,
   with no hero above it to push the retry below the fold. */
export function MissionUnavailableState({
  tier,
  message,
  retryLabel = 'Retry Challenge Ledger',
  onRetry,
}: {
  tier: Tier;
  message: string;
  retryLabel?: string;
  onRetry: () => void;
}) {
  const presentation = TIER_PRESENTATION[tier];
  return (
    <StandardContentLayout className={styles.container}>
      <div className={styles.page} data-mission-cycle={tier}>
        <h1 className={styles.srOnly}>{presentation.title}</h1>
        <section className={styles.emptyState} role="alert">
          <span className={styles.bevelFrame} aria-hidden="true" />
          <h2>Challenge Ledger Unavailable</h2>
          <p>{message}</p>
          <button type="button" className={styles.retryButton} onClick={onRetry}>
            <CasinoControlIcon variant="retry" state="attention" size="sm" />
            {retryLabel}
          </button>
        </section>
      </div>
    </StandardContentLayout>
  );
}
