import { useAppNavigate } from '../../context/InTabLobbyContext';
import styles from './PokerArenaNavigation.module.css';

/** Reuses the home carousel, including when the lobby lives beside running tables. */
export default function PokerArenaNavigation() {
  const navigate = useAppNavigate();
  return (
    <nav aria-label="Poker Arena">
      <button
        type="button"
        className={`btn btn-secondary ${styles.button}`}
        onClick={() => navigate('/')}
      >
        Poker Arena · Choose Arena
      </button>
    </nav>
  );
}
