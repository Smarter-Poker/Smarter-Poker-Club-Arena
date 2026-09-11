import { useAppNavigate } from '../../context/InTabLobbyContext';
import styles from './PokerArenaNavigation.module.css';

/** Reuses the home carousel, including when the lobby lives beside running tables. */
export default function PokerArenaNavigation() {
  const navigate = useAppNavigate();
  return (
    <nav aria-label="Poker Arena">
      {/* Built on the approved club-nav-shell frame, not a CSS box (Dan
          2026-09-10: the plain gunmetal was "a boring basic button, instead of
          a dynamic one"). The bevelled frame, its blue LED corners and the
          chrome lettering are the button; only the label is live DOM. No
          `btn-secondary` here, so nothing paints a fill behind the art. */}
      <button type="button" className={styles.button} onClick={() => navigate('/')}>
        <span className={styles.label}>
          Poker Arena<span className={styles.dot}>·</span>Choose Arena
        </span>
      </button>
    </nav>
  );
}
