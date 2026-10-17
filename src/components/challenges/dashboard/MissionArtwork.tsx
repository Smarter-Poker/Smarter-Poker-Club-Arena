import styles from '../../../pages/DailyChallengesPage.module.css';
import { mediaUrl } from '../../../utils/mediaBase';
import { MISSION_DIAMOND_ARTWORK, MISSION_FREEZE_ARTWORK } from './missionPresentation';

export function DiamondMark({ className = '' }: { className?: string }) {
  return (
    <img
      className={`${styles.inlineDiamond} ${className}`}
      src={mediaUrl(MISSION_DIAMOND_ARTWORK)}
      alt=""
      width="96"
      height="96"
      loading="lazy"
      decoding="async"
      aria-hidden="true"
    />
  );
}

export function FreezeVaultGraphic() {
  return (
    <div className={styles.freezeVaultGraphic} aria-hidden="true">
      <span className={styles.freezeVaultHalo} />
      <img
        className={styles.freezeVaultArtwork}
        src={mediaUrl(MISSION_FREEZE_ARTWORK)}
        alt=""
        width="720"
        height="720"
        loading="eager"
        decoding="async"
      />
      <span className={styles.freezeVaultScan} />
    </div>
  );
}
