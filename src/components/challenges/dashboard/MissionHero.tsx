import { CasinoControlIcon } from '../CasinoControlIcon';
import type { Tier } from '../../../services/DailyChallengeService';
import PageBar from '../../help/PageBar';
import type { TutorialStep } from '../../help/PageHelp';
import styles from '../../../pages/DailyChallengesPage.module.css';
import { TIER_LABELS, TIER_PRESENTATION } from './missionPresentation';
import { DiamondMark } from './MissionArtwork';
import { MissionCycleCountdown } from './MissionClockLeaves';

/* The hero's eyebrow, giant title and paragraph moved behind the "?" (Dan,
   2026-10-17: "ALL THESE WORDS ARE DISTRACTING"). What stays is what a
   player reads or presses: the cycle clock, the spendable balance, the
   cleared count, and the two doors. Each tour step lights the real control. */
const MISSION_TOUR: TutorialStep[] = [
  {
    title: 'Cycle Clock And Balance',
    body: 'The Clock Counts Down To The Next Reset, Beside The Diamonds You Can Spend Right Now.',
    target: '[data-mission-console]',
  },
  {
    title: 'Daily Streak',
    body: 'Play Every Day To Keep Your Streak Alive. A Streak Freeze Protects It For One Missed Day.',
    target: '#streak-console-title',
  },
  {
    title: 'Daily, Weekly And Monthly',
    body: 'Switch Cycles Here. Each Cycle Has Its Own Challenges And Its Own Reset.',
    target: '#mission-tab-daily',
  },
  {
    title: 'Challenge Ledger',
    body: 'Every Challenge Shows Its Progress And Reward. Claim A Finished One To Settle Its Diamonds.',
    target: '#mission-panel',
  },
  {
    title: 'Play Poker',
    body: 'Play Poker. Your Challenge Ledger Updates Automatically. Hand Results, Pots, Showdowns, Tournaments, And Social Goals All Count.',
    target: '[data-mission-browse]',
  },
  {
    title: 'Reset Times',
    body: 'Daily Challenges Reset At Midnight UTC, Weekly Challenges Each Monday, And Monthly Challenges On The First.',
  },
];

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
    <>
      <PageBar
        title={TIER_PRESENTATION[tier].title}
        titleId="missions-title"
        summary={TIER_PRESENTATION[tier].description}
        steps={MISSION_TOUR}
      />
      <section className={styles.hero} aria-labelledby="missions-title" data-mission-console="">
        <span className={styles.bevelFrame} aria-hidden="true" />
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
        <div className={styles.heroSeal} role="status" aria-live="polite">
          <span>{syncLabel}</span>
          <strong>
            {done}/{total}
          </strong>
          <small>{TIER_LABELS[tier]} Cleared</small>
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
      </section>
    </>
  );
}
