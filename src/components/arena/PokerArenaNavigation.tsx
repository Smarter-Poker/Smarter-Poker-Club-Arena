import { useAppNavigate } from '../../context/InTabLobbyContext';

/** Reuses the home carousel, including when the lobby lives beside running tables. */
export default function PokerArenaNavigation() {
  const navigate = useAppNavigate();
  return (
    <nav aria-label="Poker Arena">
      <button type="button" className="btn btn-secondary" onClick={() => navigate('/')}>
        Poker Arena · Choose Arena
      </button>
    </nav>
  );
}
