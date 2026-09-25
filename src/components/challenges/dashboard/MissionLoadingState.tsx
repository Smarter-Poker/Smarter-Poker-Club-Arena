import StandardContentLayout from '../../layouts/StandardContentLayout';
import styles from '../../../pages/DailyChallengesPage.module.css';
import type { Tier } from '../../../services/DailyChallengeService';
import { CasinoControlIcon } from '../CasinoControlIcon';
import { MissionHeroArtwork } from './MissionArtwork';
import { TIER_PRESENTATION } from './missionPresentation';

export function MissionLoadingState({ tier }: { tier: Tier }) {
  const presentation = TIER_PRESENTATION[tier];
  return (
    <StandardContentLayout className={styles.container}>
      <div
        className={styles.page}
        data-mission-cycle={tier}
        role="region"
        aria-busy="true"
        aria-label={`Loading ${presentation.title}`}
      >
        <section className={`${styles.hero} ${styles.loadingHero}`}>
          <span className={styles.bevelFrame} aria-hidden="true" />
          <MissionHeroArtwork tier={tier} />
          <div className={styles.heroShade} />
          <div className={styles.heroCopy}>
            <span className={styles.eyebrow}>{presentation.eyebrow}</span>
            <h1>{presentation.title}</h1>
            <p>Preparing Your Challenge Ledger, Streak, And Diamond Reward Vault.</p>
            <div className={styles.loadingSignal} role="status">
              <span className={styles.loadingSignalBar} />
              <strong>Preparing Challenge Ledger</strong>
            </div>
          </div>
        </section>
        <section className={styles.loadingBoard} aria-hidden="true">
          <span className={styles.bevelFrame} />
          <div className={styles.loadingBoardHeader} />
          <div className={styles.loadingCardGrid}>
            {Array.from({ length: tier === 'daily' ? 5 : tier === 'weekly' ? 3 : 2 }).map(
              (_, index) => (
                <div key={index} className={styles.loadingCard} data-loading-mission-card="">
                  <span className={styles.bevelFrame} />
                  <span className={styles.loadingCardInstrument}>
                    <CasinoControlIcon variant="sync" state="pending" size="lg" />
                  </span>
                  <span className={styles.loadingCardTitle} />
                  <span className={styles.loadingCardCopy} />
                  <span className={styles.loadingCardProgress} />
                  <span className={styles.loadingCardAction} />
                </div>
              )
            )}
          </div>
        </section>
      </div>
    </StandardContentLayout>
  );
}
