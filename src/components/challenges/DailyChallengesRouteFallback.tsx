import { useNavigate, useParams } from 'react-router-dom';
import { useClubWorkspace } from '../../contexts/ClubWorkspaceContext';
import type { Tier } from '../../services/DailyChallengeService';
import StandardContentLayout from '../layouts/StandardContentLayout';
import { CasinoControlIcon } from './CasinoControlIcon';
import styles from './DailyChallengesRouteFallback.module.css';

const TITLES: Record<Tier, string> = {
  daily: 'Daily Challenges',
  weekly: 'Weekly Challenges',
  monthly: 'Monthly Challenges',
};

function useFallbackTier(): Tier {
  const { cycle } = useParams<{ cycle?: string }>();
  return cycle === 'weekly' || cycle === 'monthly' ? cycle : 'daily';
}

/* The route shell prints the page's name for screen readers and, when it has
   one, its state - never the hero's eyebrow, giant title and art (Dan,
   2026-10-17: "PAGES DON'T NEED TITLES LIKE THIS"). */
function FallbackHeading({ tier }: { tier: Tier }) {
  return <h1 className={styles.srOnly}>{TITLES[tier]}</h1>;
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
        <FallbackHeading tier={tier} />
        <p className={styles.stateLine} role="status">
          Opening Your Private Challenge Ledger And Verifying Your Secure Session.
        </p>
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
  const navigate = useNavigate();
  const { routeClubId } = useClubWorkspace();
  /* A shared link opens this route with nothing behind it, and history.back()
     from the first entry does nothing. Then Go Back opens the club home the
     link named, the same place the page's Back To Arena door goes, or the
     arena when it named no club. */
  const goBack = () => {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    navigate(routeClubId ? `/clubs/${routeClubId}` : '/');
  };
  return (
    <StandardContentLayout className={styles.container}>
      <div
        className={styles.page}
        data-arena-surface="missions"
        data-mission-cycle={tier}
        data-daily-missions-crash-fallback=""
      >
        <FallbackHeading tier={tier} />
        <section className={styles.emptyState} role="alert">
          <span className={styles.bevelFrame} aria-hidden="true" />
          <h2>Challenge Display Could Not Render</h2>
          <p>
            Your Challenge Progress Is Protected. The Failure Was Recorded. Retry This Display Or
            Return To Your Previous Page.
          </p>
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
            <button type="button" className={styles.backButton} onClick={goBack}>
              <CasinoControlIcon variant="back" state="idle" size="sm" />
              Go Back
            </button>
          </div>
        </section>
      </div>
    </StandardContentLayout>
  );
}
