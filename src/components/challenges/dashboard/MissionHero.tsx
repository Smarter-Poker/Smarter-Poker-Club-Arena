import { CasinoControlIcon } from '../CasinoControlIcon';
import type { Tier } from '../../../services/DailyChallengeService';
import styles from '../../../pages/DailyChallengesPage.module.css';
import { TIER_LABELS, TIER_PRESENTATION } from './missionPresentation';
import { DiamondMark, MissionHeroArtwork } from './MissionArtwork';
import { MissionCycleCountdown } from './MissionClockLeaves';

export function MissionHero({
  tier,
  diamondBalance,
  syncLabel,
  done,
  total,
  reduceMotion,
  onBackToArena,
  serverClockOffsetMs,
}: {
  tier: Tier;
  diamondBalance: number;
  syncLabel: string;
  done: number;
  total: number;
  reduceMotion: boolean | null;
  onBackToArena: () => void;
  serverClockOffsetMs: number | null;
}) {
  return (
    <section className={styles.hero} aria-labelledby="missions-title">
      <span className={styles.bevelFrame} aria-hidden="true" />
      <MissionHeroArtwork tier={tier} />
      <div className={styles.heroShade} />
      <div className={styles.heroCopy}>
        <span className={styles.eyebrow}>{TIER_PRESENTATION[tier].eyebrow}</span>
        <h1 id="missions-title">{TIER_PRESENTATION[tier].title}</h1>
        <p>{TIER_PRESENTATION[tier].description}</p>
        <div className={styles.heroMeters}>
          <div>
            <span>{TIER_LABELS[tier]} Cycle</span>
            <strong>
              <MissionCycleCountdown tier={tier} serverClockOffsetMs={serverClockOffsetMs} />
            </strong>
            <small>Until {TIER_LABELS[tier]} Reset</small>
          </div>
          <div>
            <span>Available Diamonds</span>
            <strong className={styles.balanceWithGem}>
              <DiamondMark /> {diamondBalance.toLocaleString()}
            </strong>
            <small>Spendable Balance</small>
          </div>
        </div>
        <div className={styles.heroActions}>
          <button
            type="button"
            className={styles.playButton}
            onClick={() => {
              document.getElementById('mission-board-title')?.scrollIntoView({
                behavior: reduceMotion ? 'auto' : 'smooth',
                block: 'start',
              });
              requestAnimationFrame(() => document.getElementById('mission-board-title')?.focus());
            }}
          >
            <CasinoControlIcon variant="ledger" state="active" size="sm" />
            View Challenge Ledger
          </button>
          <button type="button" className={styles.backButton} onClick={onBackToArena}>
            <CasinoControlIcon variant="back" state="idle" size="sm" />
            Back To Arena
          </button>
        </div>
      </div>
      <div className={styles.heroSeal} role="status" aria-live="polite">
        <span>{syncLabel}</span>
        <strong>
          {done}/{total}
        </strong>
        <small>{TIER_LABELS[tier]} Cleared</small>
      </div>
    </section>
  );
}
