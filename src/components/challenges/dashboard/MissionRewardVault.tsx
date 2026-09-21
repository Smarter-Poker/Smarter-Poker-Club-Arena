import { CasinoControlIcon } from '../CasinoControlIcon';
import type { DailyChallengeRewardVault } from '../../../services/DailyChallengeService';
import { mediaUrl } from '../../../utils/mediaBase';
import styles from '../../../pages/DailyChallengesPage.module.css';

// Integration seam: the presentation tables and artwork helpers still live on the
// page while the sibling extraction moves them to `missionPresentation.ts`,
// `MissionArtwork.tsx` and `MissionClockLeaves.tsx`. Until that lands they are
// handed in as props under their own names so this body stays verbatim.

export function MissionRewardVault({
  unclaimed,
  claimingAll,
  economyBusy,
  onClaimAll,
  MISSION_REWARD_ARTWORK,
}: {
  unclaimed: DailyChallengeRewardVault;
  claimingAll: boolean;
  economyBusy: boolean;
  onClaimAll: () => void;
  MISSION_REWARD_ARTWORK: string;
}) {
  return (
    <aside className={styles.unclaimedBar} aria-label="Unclaimed Challenge Rewards">
      <span className={styles.bevelFrame} aria-hidden="true" />
      <img
        className={styles.vaultArtwork}
        src={mediaUrl(MISSION_REWARD_ARTWORK)}
        alt=""
        width="640"
        height="474"
        loading="lazy"
        decoding="async"
        aria-hidden="true"
      />
      <div className={styles.vaultCopy}>
        <span className={styles.panelLabel}>Reward Vault Open</span>
        <strong>
          {unclaimed.count} Challenge{unclaimed.count === 1 ? '' : 's'} Ready
        </strong>
        <small>+{unclaimed.diamonds.toLocaleString()} Diamonds</small>
      </div>
      <button
        type="button"
        className={styles.claimAllButton}
        onClick={onClaimAll}
        disabled={claimingAll || economyBusy}
      >
        <CasinoControlIcon
          variant="claim"
          state={claimingAll ? 'pending' : economyBusy ? 'disabled' : 'active'}
          size="sm"
        />
        {claimingAll
          ? 'Claiming Rewards...'
          : unclaimed.hasMore
            ? `Claim Next ${unclaimed.items.length} Of ${unclaimed.count}`
            : `Claim All ${unclaimed.count}`}
      </button>
    </aside>
  );
}
