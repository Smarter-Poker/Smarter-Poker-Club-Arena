import type { ClubEntryFlags } from '../../services/ClubEntryTrustService';
import { mediaUrl } from '../../utils/mediaBase';
import styles from '../../pages/HomePage.module.css';

interface ClubEntryActionBarProps {
  flags: ClubEntryFlags;
  onCreate: () => void;
  onFind: () => void;
  onJoin: () => void;
}

/** The reusable, semantic control surface for all three Club Arena entry flows. */
export default function ClubEntryActionBar({
  flags,
  onCreate,
  onFind,
  onJoin,
}: ClubEntryActionBarProps) {
  return (
    <nav className={styles.actionBarRow} aria-label="Club Arena actions">
      <div className={styles.actionBarWrapper}>
        <img
          className={styles.actionBarArtwork}
          src={mediaUrl('images/club-arena/approved-club-entry-action-pill-v1.webp')}
          width="2065"
          height="399"
          alt=""
          aria-hidden="true"
          draggable="false"
        />
        <button
          type="button"
          className={styles.actionControl}
          onClick={onCreate}
          disabled={!flags.create_club}
          title={flags.create_club ? 'Create a Club (C)' : 'Club creation is unavailable'}
          aria-label="Create A Club"
          aria-keyshortcuts="C"
        >
          <span className={styles.srOnly}>Create A Club</span>
        </button>
        <button
          type="button"
          className={styles.actionControl}
          onClick={onFind}
          disabled={!flags.find_player}
          title={flags.find_player ? 'Find a Player (F)' : 'Player search is unavailable'}
          aria-label="Find A Player"
          aria-keyshortcuts="F"
        >
          <span className={styles.srOnly}>Find A Player</span>
        </button>
        <button
          type="button"
          className={styles.actionControl}
          onClick={onJoin}
          disabled={!flags.join_club}
          title={flags.join_club ? 'Join a Club (J)' : 'Club joining is unavailable'}
          aria-label="Join A Club"
          aria-keyshortcuts="J"
        >
          <span className={styles.srOnly}>Join A Club</span>
        </button>
      </div>
    </nav>
  );
}
