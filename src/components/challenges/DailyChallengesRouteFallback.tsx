import { useParams } from 'react-router-dom';
import type { Tier } from '../../services/DailyChallengeService';
import { mediaUrl } from '../../utils/mediaBase';
import StandardContentLayout from '../layouts/StandardContentLayout';
import styles from '../../pages/DailyChallengesPage.module.css';
import { CasinoControlIcon, type CasinoControlIconVariant } from './CasinoControlIcon';

const HERO_DESKTOP = 'images/challenges/daily-missions-casino-v2.webp';
const HERO_MOBILE = 'images/challenges/daily-missions-casino-v2-mobile.webp';

const TITLES: Record<Tier, string> = {
  daily: 'Daily Challenges',
  weekly: 'Weekly Challenges',
  monthly: 'Monthly Challenges',
};

const EYEBROWS: Record<Tier, string> = {
  daily: 'Club Arena / Daily Challenge Vault',
  weekly: 'Club Arena / Weekly Challenge Circuit',
  monthly: 'Club Arena / Monthly High-Roller Ledger',
};

const CYCLE_ICONS: Record<Tier, CasinoControlIconVariant> = {
  daily: 'cycle-daily',
  weekly: 'cycle-weekly',
  monthly: 'cycle-monthly',
};

function useFallbackTier(): Tier {
  const { cycle } = useParams<{ cycle?: string }>();
  return cycle === 'weekly' || cycle === 'monthly' ? cycle : 'daily';
}

function FallbackHero({ tier, message }: { tier: Tier; message: string }) {
  return (
    <section className={`${styles.hero} ${styles.loadingHero}`}>
      <span className={styles.bevelFrame} aria-hidden="true" />
      <div className={styles.heroPicture} data-hero-cycle={tier} aria-hidden="true">
        <picture>
          <source media="(max-width: 680px)" srcSet={mediaUrl(HERO_MOBILE)} />
          <img
            className={styles.heroArtwork}
            src={mediaUrl(HERO_DESKTOP)}
            alt=""
            width="1717"
            height="916"
            loading="eager"
            decoding="async"
            fetchPriority="high"
          />
        </picture>
        <span className={styles.heroCycleAtmosphere} />
        <span className={styles.heroCycleInstrument} data-cycle-instrument={tier}>
          <CasinoControlIcon variant={CYCLE_ICONS[tier]} state="active" size="lg" />
        </span>
      </div>
      <div className={styles.heroShade} />
      <div className={styles.heroCopy}>
        <span className={styles.eyebrow}>{EYEBROWS[tier]}</span>
        <h1>{TITLES[tier]}</h1>
        <p>{message}</p>
      </div>
    </section>
  );
}

function FallbackMissionCards({ tier }: { tier: Tier }) {
  const cardCount = tier === 'daily' ? 5 : tier === 'weekly' ? 3 : 2;
  return (
    <section className={styles.loadingBoard} aria-hidden="true">
      <span className={styles.bevelFrame} />
      <div className={styles.loadingBoardHeader} />
      <div className={styles.loadingCardGrid}>
        {Array.from({ length: cardCount }, (_, index) => (
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
        ))}
      </div>
    </section>
  );
}

export function DailyChallengesAuthLoading() {
  const tier = useFallbackTier();
  return (
    <StandardContentLayout className={styles.container}>
      <div
        className={styles.page}
        data-arena-surface="missions"
        data-mission-cycle={tier}
        data-daily-missions-auth-loading=""
        role="region"
        aria-busy="true"
        aria-label={`Loading ${TITLES[tier]}`}
      >
        <FallbackHero
          tier={tier}
          message="Opening Your Private Challenge Ledger And Verifying Your Secure Session."
        />
        <FallbackMissionCards tier={tier} />
      </div>
    </StandardContentLayout>
  );
}

export function DailyChallengesCrashFallback({
  error,
  onRetry,
}: {
  error: Error | null;
  onRetry: () => void;
}) {
  const tier = useFallbackTier();
  return (
    <StandardContentLayout className={styles.container}>
      <div
        className={styles.page}
        data-arena-surface="missions"
        data-mission-cycle={tier}
        data-daily-missions-crash-fallback=""
      >
        <FallbackHero
          tier={tier}
          message="Your Challenge Progress Is Protected While This Display Recovers."
        />
        <section className={`${styles.emptyState} ${styles.unavailableState}`} role="alert">
          <span className={styles.bevelFrame} aria-hidden="true" />
          <span className={styles.panelLabel}>Challenge Display Recovery</span>
          <h2>Challenge Display Could Not Render</h2>
          <p>The Failure Was Recorded. Retry This Display Or Return To Your Previous Page.</p>
          {error?.message ? (
            <details>
              <summary>Technical Details</summary>
              <code>{String(error.message).slice(0, 300)}</code>
            </details>
          ) : null}
          <div className={styles.emptyActions}>
            <button type="button" className={styles.retryButton} onClick={onRetry}>
              <CasinoControlIcon variant="retry" state="attention" size="sm" />
              Retry Challenge Display
            </button>
            <button
              type="button"
              className={styles.backButton}
              onClick={() => window.history.back()}
            >
              <CasinoControlIcon variant="back" state="idle" size="sm" />
              Go Back
            </button>
          </div>
        </section>
      </div>
    </StandardContentLayout>
  );
}
