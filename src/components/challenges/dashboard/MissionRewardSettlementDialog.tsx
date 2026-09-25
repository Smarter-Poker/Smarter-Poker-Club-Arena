import type { RefObject } from 'react';
import styles from '../../../pages/DailyChallengesPage.module.css';
import { ConfettiEffect } from '../../effects/ConfettiEffect';
import { mediaUrl } from '../../../utils/mediaBase';
import { CasinoControlIcon } from '../CasinoControlIcon';
import { MISSION_REWARD_ARTWORK } from './missionPresentation';

/* No `chips` field: a mission reward is diamonds (Dan 2026-09-05). */
export interface MissionRewardSettlement {
  name: string;
  diamonds: number;
  challengeDiamonds: number;
  milestoneDiamonds: number;
  diamondBalance: number;
}

export function MissionRewardSettlementDialog({
  reward,
  reduceMotion,
  dialogRef,
  onDismiss,
}: {
  reward: MissionRewardSettlement;
  reduceMotion: boolean | null;
  dialogRef: RefObject<HTMLDivElement | null>;
  onDismiss: () => void;
}) {
  return (
    <div
      className={styles.celebrateOverlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="challenge-reward-title"
      aria-describedby="challenge-reward-description"
      onClick={onDismiss}
    >
      {!reduceMotion && (
        <ConfettiEffect
          isActive={true}
          intensity="heavy"
          colors={['#00f0ff', '#0ff', '#ffffff']}
          duration={4000}
        />
      )}
      <div
        ref={dialogRef}
        className={styles.celebrateCard}
        data-dialog-card="fixed-frame"
        onClick={(event) => event.stopPropagation()}
      >
        <span className={styles.bevelFrame} data-dialog-frame="fixed" aria-hidden="true" />
        <div className={styles.celebrateCardScroll} data-dialog-scroll="true">
          <img
            className={styles.celebrateArtwork}
            src={mediaUrl(MISSION_REWARD_ARTWORK)}
            alt=""
            width="640"
            height="474"
            decoding="async"
            aria-hidden="true"
          />
          <h2 id="challenge-reward-title" className={styles.celebrateTitle} tabIndex={-1}>
            Reward Settled
          </h2>
          <p id="challenge-reward-description" className={styles.celebrateName}>
            {reward.name}
          </p>

          <div className={styles.celebratePayouts} role="group" aria-label="Rewards Earned">
            {reward.challengeDiamonds > 0 && (
              <div className={styles.celebrateDiamondPayout}>
                <span className={styles.celebratePayoutValue}>
                  +{reward.challengeDiamonds.toLocaleString()}
                </span>
                <span className={styles.celebratePayoutLabel}>
                  Challenge {reward.challengeDiamonds === 1 ? 'Diamond' : 'Diamonds'}
                </span>
              </div>
            )}
            {reward.milestoneDiamonds > 0 && (
              <div className={styles.celebrateMilestonePayout}>
                <span className={styles.celebratePayoutValue}>
                  +{reward.milestoneDiamonds.toLocaleString()}
                </span>
                <span className={styles.celebratePayoutLabel}>Streak Bonus Diamonds</span>
              </div>
            )}
          </div>

          {reward.diamonds > 0 && (
            <div className={styles.celebrateBalanceLedger}>
              <p className={styles.celebrateTotal}>
                Total Credited: +{reward.diamonds.toLocaleString()} Diamonds
              </p>
              <p className={styles.celebrateBalance}>
                New Balance: {reward.diamondBalance.toLocaleString()} Diamonds
              </p>
            </div>
          )}

          <p className={styles.celebrateReceipt} role="status">
            Added To Your Club Arena Diamond Balance
          </p>

          <button type="button" className={styles.celebrateButton} onClick={onDismiss}>
            <CasinoControlIcon variant="continue" state="success" size="sm" />
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
