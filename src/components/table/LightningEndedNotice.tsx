/**
 * LIGHTNING PHASE 7: THE ROOM AFTER LIGHTNING ENDS.
 *
 * The Cluster went back to MUST MOVE once every Lightning hand had settled,
 * so this room will never deal again. Instead of a dead felt it says so, in
 * one line, and offers the player's own table. The player moves themselves
 * (CLAUDE.md 10.6): nothing here navigates without the button.
 */
import {
  LIGHTNING_ENDED_EYEBROW,
  LIGHTNING_ENDED_TEXT,
  LIGHTNING_RETURN_LABEL,
} from '../../lightning/lightningReversion';
import './LightningFoldBar.css';

export default function LightningEndedNotice({ onViewGame }: { onViewGame: () => void }) {
  return (
    <div className="lightning-ended" data-testid="lightning-ended" role="alert">
      <p className="lightning-ended__eyebrow">{LIGHTNING_ENDED_EYEBROW}</p>
      <p className="lightning-ended__text">{LIGHTNING_ENDED_TEXT}</p>
      <button
        type="button"
        className="lightning-ended__go"
        data-testid="lightning-ended-view-game"
        onClick={onViewGame}
      >
        {LIGHTNING_RETURN_LABEL}
      </button>
    </div>
  );
}
