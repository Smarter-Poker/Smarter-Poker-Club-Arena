import { motion } from 'framer-motion';
import { CasinoControlIcon } from '../CasinoControlIcon';
import {
  DAILY_MISSION_REROLL_COST,
  type Tier,
  type ChallengeType,
} from '../../../services/DailyChallengeService';
import { ChallengeCard } from './MissionCard';
import styles from '../../../pages/DailyChallengesPage.module.css';
import { TIER_LABELS, type TieredChallenge } from './missionPresentation';

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
            />
          </motion.div>
        ))
      )}
    </section>
  );
}
