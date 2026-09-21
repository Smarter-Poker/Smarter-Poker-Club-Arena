import type { DailyChallengeStats, Tier } from '../../../services/DailyChallengeService';
import styles from '../../../pages/DailyChallengesPage.module.css';
import { TIER_LABELS } from './missionPresentation';
import { DiamondMark } from './MissionArtwork';

export function MissionSummaryGrid({
  tier,
  done,
  total,
  stats,
}: {
  tier: Tier;
  done: number;
  total: number;
  stats: DailyChallengeStats | null;
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
          <DiamondMark /> {(stats?.totalDiamondsEarned || 0).toLocaleString()}
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
