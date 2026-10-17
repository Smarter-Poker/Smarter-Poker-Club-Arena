import { CasinoControlIcon } from '../CasinoControlIcon';
import styles from '../../../pages/DailyChallengesPage.module.css';

/* The footer used to explain how the ledger updates and when each cycle
   resets. Those words live behind the page's "?" now; the band keeps only
   its door to the tables. */
export function MissionFooter({ onBrowseArena }: { onBrowseArena: () => void }) {
  return (
    <footer className={styles.footer} aria-label="Play Poker">
      <span className={styles.bevelFrame} aria-hidden="true" />
      <button
        type="button"
        className={styles.playButton}
        onClick={onBrowseArena}
        data-mission-browse=""
      >
        <CasinoControlIcon variant="play" state="active" size="sm" />
        Browse Cash Games
      </button>
    </footer>
  );
}
