import type { ReactNode } from 'react';
import { CasinoControlIcon } from '../CasinoControlIcon';
import type { Tier } from '../../../services/DailyChallengeService';
import styles from '../../../pages/DailyChallengesPage.module.css';

// Integration seam: the presentation tables and artwork helpers still live on the
// page while the sibling extraction moves them to `missionPresentation.ts`,
// `MissionArtwork.tsx` and `MissionClockLeaves.tsx`. Until that lands they are
// handed in as props under their own names so this body stays verbatim.

export function MissionHero({
  tier,
  diamondBalance,
  syncLabel,
  done,
  total,
  reduceMotion,
  onBackToArena,
  artwork,
  countdown,
  diamondMark,
  TIER_PRESENTATION,
  TIER_LABELS,
}: {
  tier: Tier;
  diamondBalance: number;
  syncLabel: string;
  done: number;
  total: number;
  reduceMotion: boolean | null;
  onBackToArena: () => void;
  /** `<MissionHeroArtwork tier={tier} />`, rendered by the page. */
  artwork: ReactNode;
  /** `<MissionCycleCountdown tier={tier} serverClockOffsetMs={ms} />`, rendered by the page. */
  countdown: ReactNode;
  /** `<DiamondMark />`, rendered by the page. */
  diamondMark: ReactNode;
  TIER_PRESENTATION: Record<Tier, { title: string; eyebrow: string; description: string }>;
  TIER_LABELS: Record<Tier, string>;
}) {
  return (
    <section className={styles.hero} aria-labelledby="missions-title">
      <span className={styles.bevelFrame} aria-hidden="true" />
      {artwork}
      <div className={styles.heroShade} />
      <div className={styles.heroCopy}>
        <span className={styles.eyebrow}>{TIER_PRESENTATION[tier].eyebrow}</span>
        <h1 id="missions-title">{TIER_PRESENTATION[tier].title}</h1>
        <p>{TIER_PRESENTATION[tier].description}</p>
        <div className={styles.heroMeters}>
          <div>
            <span>{TIER_LABELS[tier]} Cycle</span>
            <strong>{countdown}</strong>
            <small>Until {TIER_LABELS[tier]} Reset</small>
          </div>
          <div>
            <span>Available Diamonds</span>
            <strong className={styles.balanceWithGem}>
              {diamondMark} {diamondBalance.toLocaleString()}
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
