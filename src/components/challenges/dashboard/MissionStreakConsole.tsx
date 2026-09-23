import { motion } from 'framer-motion';
import { CasinoControlIcon } from '../CasinoControlIcon';
import type { ChallengeStreak, DailyChallengeStats } from '../../../services/DailyChallengeService';
import styles from '../../../pages/DailyChallengesPage.module.css';
import { MISSION_DATE_FORMATTER } from './missionPresentation';
import { DiamondMark } from './MissionArtwork';

export function MissionStreakConsole({
  streak,
  stats,
  diamondBalance,
  buyingFreeze,
  economyBusy,
  reduceMotion,
  onRequestFreeze,
}: {
  streak: ChallengeStreak | null;
  stats: DailyChallengeStats | null;
  diamondBalance: number;
  buyingFreeze: boolean;
  economyBusy: boolean;
  reduceMotion: boolean | null;
  onRequestFreeze: () => void;
}) {
  return (
    <div className={styles.streakConsole}>
      <span className={styles.bevelFrame} aria-hidden="true" />
      <div className={styles.streakCore}>
        <span className={styles.streakFireVisual} aria-hidden="true">
          <CasinoControlIcon
            variant="streak"
            state={(streak?.streak ?? stats?.currentStreak ?? 0) > 0 ? 'active' : 'idle'}
            size="lg"
          />
        </span>
        <div className={styles.streakInfo}>
          <span className={styles.panelLabel}>Daily Streak Circuit</span>
          <h2 id="streak-console-title" className={styles.streakCount} tabIndex={-1}>
            {(streak?.streak ?? stats?.currentStreak ?? 0).toLocaleString()} Day Streak
          </h2>
          <span className={styles.streakDesc}>Play Every Day To Keep The Circuit Alive.</span>
        </div>
      </div>
      <div className={styles.milestoneTracker}>
        <div className={styles.milestoneLabels}>
          <span>{(streak?.streak ?? stats?.currentStreak ?? 0).toLocaleString()} Days</span>
          <span>Next Reward At {stats?.nextMilestone.toLocaleString()}</span>
        </div>
        <div
          className={styles.milestoneBar}
          role="progressbar"
          aria-label="Progress Toward The Next Streak Reward"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(stats?.milestoneProgressPercent ?? 0)}
          aria-valuetext={`${(streak?.streak ?? stats?.currentStreak ?? 0).toLocaleString()} Days, Next Reward At ${stats?.nextMilestone.toLocaleString() ?? 0}`}
        >
          <motion.div
            className={styles.milestoneFill}
            initial={reduceMotion ? false : { width: 0 }}
            animate={{
              width: `${stats?.milestoneProgressPercent ?? 0}%`,
            }}
            transition={{ duration: reduceMotion ? 0 : 1, ease: 'easeOut' }}
          />
        </div>
      </div>
      {streak && (
        <div className={styles.freezeLine}>
          <div className={styles.freezeInfo}>
            <span>{streak.freezesAvailable} Banked</span>
            <small>
              {streak.nextFreezeIn != null
                ? `Next Free Freeze In ${streak.nextFreezeIn} Day${streak.nextFreezeIn === 1 ? '' : 's'}`
                : 'Freeze Inventory Ready'}
            </small>
            {streak.usedFreeze && streak.lastFrozenDate && (
              <div
                className={styles.freezeReceipt}
                role="status"
                aria-label={`Streak Freeze Applied For ${MISSION_DATE_FORMATTER.format(new Date(`${streak.lastFrozenDate}T00:00:00Z`))}`}
              >
                <CasinoControlIcon variant="freeze" state="success" size="md" />
                <div>
                  <strong>Streak Freeze Applied</strong>
                  <small>
                    {MISSION_DATE_FORMATTER.format(new Date(`${streak.lastFrozenDate}T00:00:00Z`))}{' '}
                    Cycle Protected
                  </small>
                  {streak.honoredFrozenDates > 1 && (
                    <small>
                      {streak.honoredFrozenDates.toLocaleString()} Protected Cycles In Current
                      Streak
                    </small>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className={styles.freezeAction}>
            <button
              id="buy-streak-freeze"
              type="button"
              className={styles.buyFreezeBtn}
              onClick={onRequestFreeze}
              disabled={
                buyingFreeze || economyBusy || diamondBalance < 5000 || streak.freezesAvailable >= 3
              }
              aria-describedby="freeze-action-hint"
              aria-haspopup="dialog"
            >
              <CasinoControlIcon
                variant="freeze"
                state={
                  buyingFreeze
                    ? 'pending'
                    : economyBusy || diamondBalance < 5000 || streak.freezesAvailable >= 3
                      ? 'disabled'
                      : 'active'
                }
                size="sm"
              />
              {buyingFreeze
                ? 'Securing...'
                : streak.freezesAvailable >= 3
                  ? 'Freeze Vault Full'
                  : diamondBalance < 5000
                    ? 'Need More Diamonds'
                    : 'Buy Streak Freeze'}
              {streak.freezesAvailable < 3 && (
                <span className={styles.buttonPrice}>
                  <DiamondMark /> 5,000
                  <span className={styles.srOnly}>Diamonds</span>
                </span>
              )}
            </button>
            <small id="freeze-action-hint" className={styles.actionHint}>
              {streak.freezesAvailable >= 3
                ? 'Use A Banked Freeze Before Buying Another.'
                : diamondBalance < 5000
                  ? 'Requires 5,000 Spendable Diamonds.'
                  : 'Protects One Missed Daily Cycle.'}
            </small>
          </div>
        </div>
      )}
    </div>
  );
}
