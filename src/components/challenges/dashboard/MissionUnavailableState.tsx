import StandardContentLayout from '../../layouts/StandardContentLayout';
import styles from '../../../pages/DailyChallengesPage.module.css';
import type { Tier } from '../../../services/DailyChallengeService';
import { CasinoControlIcon } from '../CasinoControlIcon';
import { MissionHeroArtwork } from './MissionArtwork';
import { TIER_PRESENTATION } from './missionPresentation';

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
        <section className={`${styles.hero} ${styles.unavailableHero}`}>
          <span className={styles.bevelFrame} aria-hidden="true" />
          <MissionHeroArtwork tier={tier} />
          <div className={styles.heroShade} />
          <div className={styles.heroCopy}>
            <span className={styles.eyebrow}>{presentation.eyebrow}</span>
            <h1>{presentation.title}</h1>
            <p>Your Challenge Progress Is Protected While The Private Ledger Reconnects.</p>
          </div>
        </section>
        <section className={`${styles.emptyState} ${styles.unavailableState}`} role="alert">
          <span className={styles.bevelFrame} aria-hidden="true" />
          <span className={styles.panelLabel}>Secure Ledger Connection</span>
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
