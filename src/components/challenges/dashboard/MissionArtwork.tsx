import { CasinoControlIcon } from '../CasinoControlIcon';
import styles from '../../../pages/DailyChallengesPage.module.css';
import { mediaUrl } from '../../../utils/mediaBase';
import type { Tier } from '../../../services/DailyChallengeService';
import {
  MISSION_DIAMOND_ARTWORK,
  MISSION_FREEZE_ARTWORK,
  MISSION_HERO_DESKTOP,
  MISSION_HERO_MOBILE,
  TIER_CONTROL_ICONS,
} from './missionPresentation';

export function MissionHeroArtwork({ tier }: { tier: Tier }) {
  return (
    <div className={styles.heroPicture} data-hero-cycle={tier} aria-hidden="true">
      <picture>
        <source media="(max-width: 680px)" srcSet={mediaUrl(MISSION_HERO_MOBILE)} />
        <img
          className={styles.heroArtwork}
          src={mediaUrl(MISSION_HERO_DESKTOP)}
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
        <CasinoControlIcon variant={TIER_CONTROL_ICONS[tier]} state="active" size="lg" />
      </span>
    </div>
  );
}

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
