import { CasinoControlIcon } from '../CasinoControlIcon';
import styles from '../../../pages/DailyChallengesPage.module.css';

export function MissionFooter({ onBrowseArena }: { onBrowseArena: () => void }) {
  return (
    <footer className={styles.footer}>
      <span className={styles.bevelFrame} aria-hidden="true" />
      <div>
        <span className={styles.eyebrow}>Casino Floor Concierge</span>
        <h2>Play Poker. Your Challenge Ledger Updates Automatically.</h2>
        <p>
          Hand Results, Pots, Showdowns, Tournaments, And Social Goals Update Automatically. Daily
          Challenges Reset At Midnight UTC, Weekly Challenges Each Monday, And Monthly Challenges On
          The First.
        </p>
      </div>
      <button type="button" className={styles.playButton} onClick={onBrowseArena}>
        <CasinoControlIcon variant="play" state="active" size="sm" />
        Browse Cash Games
      </button>
    </footer>
  );
}
