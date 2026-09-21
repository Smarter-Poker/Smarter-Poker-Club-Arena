import type { ReactNode } from 'react';
import type { DailyChallengeStats, Tier } from '../../../services/DailyChallengeService';
import styles from '../../../pages/DailyChallengesPage.module.css';

// Integration seam: the presentation tables and artwork helpers still live on the
// page while the sibling extraction moves them to `missionPresentation.ts`,
// `MissionArtwork.tsx` and `MissionClockLeaves.tsx`. Until that lands they are
// handed in as props under their own names so this body stays verbatim.

export function MissionSummaryGrid({
  tier,
  done,
  total,
  stats,
  diamondMark,
  TIER_LABELS,
}: {
  tier: Tier;
  done: number;
  total: number;
  stats: DailyChallengeStats | null;
  /** `<DiamondMark />`, rendered by the page. */
  diamondMark: ReactNode;
  TIER_LABELS: Record<Tier, string>;
}) {
  return (
    <div className={styles.summaryGrid}>
      <span className={styles.bevelFrame} aria-hidden="true" />
      <div className={styles.summaryTile}>
        <span className={styles.summaryLabel}>{TIER_LABELS[tier]} Cycle</span>
        <strong className={styles.summaryValue}>
          {done}/{total}
        </strong>
        <small>Completed</small>
      </div>
      <div className={styles.summaryTile}>
        <span className={styles.summaryLabel}>Career</span>
        <strong className={styles.summaryValue}>
          {(stats?.totalCompleted || 0).toLocaleString()}
        </strong>
        <small>Challenges Cleared</small>
      </div>
      <div className={styles.summaryTile}>
        <span className={styles.summaryLabel}>Earned Here</span>
        <strong className={`${styles.summaryValue} ${styles.diamond} ${styles.balanceWithGem}`}>
          {diamondMark} {(stats?.totalDiamondsEarned || 0).toLocaleString()}
        </strong>
        <small>Lifetime Diamonds</small>
      </div>
      <div className={styles.summaryTile}>
        <span className={styles.summaryLabel}>Next Milestone</span>
        <strong className={`${styles.summaryValue} ${styles.gold}`}>
          +{(stats?.milestoneReward || 0).toLocaleString()}
        </strong>
        <small>Bonus Diamonds</small>
      </div>
    </div>
  );
}
