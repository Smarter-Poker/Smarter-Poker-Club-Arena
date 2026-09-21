import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { CasinoControlIcon } from '../CasinoControlIcon';
import {
  DAILY_MISSION_REROLL_COST,
  type TieredUserChallenge,
  type Tier,
  type ChallengeType,
} from '../../../services/DailyChallengeService';
import { ChallengeCard } from './MissionCard';
import styles from '../../../pages/DailyChallengesPage.module.css';

type TieredChallenge = TieredUserChallenge;

// Integration seam: the presentation tables and artwork helpers still live on the
// page while the sibling extraction moves them to `missionPresentation.ts`,
// `MissionArtwork.tsx` and `MissionClockLeaves.tsx`. Until that lands they are
// handed in as props under their own names so this body stays verbatim.

export function MissionLedgerList({
  visible,
  activeTier,
  loadError,
  isRefreshing,
  onRefresh,
  claimingIds,
  rerollingIds,
  economyBusy,
  diamondBalance,
  confirmingRerollId,
  celebratingIds,
  reduceMotion,
  onClaim,
  onRequestReroll,
  onCancelReroll,
  onConfirmReroll,
  onOpenMission,
  diamondMark,
  TIER_COLORS,
  TIER_LABELS,
  MISSION_DIAMOND_ARTWORK,
}: {
  visible: TieredChallenge[];
  activeTier: Tier;
  loadError: string | null;
  isRefreshing: boolean;
  onRefresh: () => void;
  claimingIds: Set<string>;
  rerollingIds: Set<string>;
  economyBusy: boolean;
  diamondBalance: number;
  confirmingRerollId: string | null;
  celebratingIds: Set<string>;
  reduceMotion: boolean | null;
  onClaim: (c: TieredChallenge) => void;
  onRequestReroll: (c: TieredChallenge) => void;
  onCancelReroll: () => void;
  onConfirmReroll: (c: TieredChallenge) => void;
  onOpenMission: (type: ChallengeType) => void;
  /** `<DiamondMark />`, rendered by the page. */
  diamondMark: ReactNode;
  TIER_COLORS: Record<Tier, string>;
  TIER_LABELS: Record<Tier, string>;
  MISSION_DIAMOND_ARTWORK: string;
}) {
  return (
    <section
      id="mission-panel"
      className={styles.list}
      role="tabpanel"
      aria-labelledby={`mission-tab-${activeTier}`}
      tabIndex={0}
    >
      {visible.length === 0 ? (
        <div className={styles.emptyState}>
          <span className={styles.bevelFrame} aria-hidden="true" />
          <h3>{loadError ? 'Challenge Ledger Offline' : 'No Challenges Assigned'}</h3>
          <p>
            {loadError
              ? 'Use Retry Sync Above To Reconnect. Your Recorded Progress Is Safe.'
              : `Your Next ${TIER_LABELS[activeTier]} Challenge Set Is Being Prepared.`}
          </p>
          {!loadError && (
            <button
              type="button"
              className={styles.retryButton}
              onClick={onRefresh}
              disabled={isRefreshing}
            >
              <CasinoControlIcon
                variant="retry"
                state={isRefreshing ? 'pending' : 'attention'}
                size="sm"
              />
              {isRefreshing ? 'Preparing...' : 'Refresh Challenge Ledger'}
            </button>
          )}
        </div>
      ) : (
        visible.map((c, i) => (
          <motion.div
            key={c.id}
            initial={reduceMotion ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={
              reduceMotion ? { duration: 0 } : { duration: 0.22, delay: Math.min(i * 0.035, 0.14) }
            }
            layout={!reduceMotion}
          >
            <ChallengeCard
              challenge={c}
              tier={c.tier}
              claiming={claimingIds.has(c.id)}
              rerolling={rerollingIds.has(c.id)}
              economyBusy={economyBusy}
              canAffordReroll={diamondBalance >= DAILY_MISSION_REROLL_COST}
              confirmingReroll={confirmingRerollId === c.id}
              rerollConfirmationOpen={confirmingRerollId !== null}
              celebrating={celebratingIds.has(c.id)}
              onClaim={onClaim}
              onRequestReroll={onRequestReroll}
              onCancelReroll={onCancelReroll}
              onConfirmReroll={onConfirmReroll}
              onOpenMission={onOpenMission}
              diamondMark={diamondMark}
              TIER_COLORS={TIER_COLORS}
              TIER_LABELS={TIER_LABELS}
              MISSION_DIAMOND_ARTWORK={MISSION_DIAMOND_ARTWORK}
            />
          </motion.div>
        ))
      )}
    </section>
  );
}
