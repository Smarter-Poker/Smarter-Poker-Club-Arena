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
import { LightningSessionSummaryCard } from '../lightning/LightningSessionSummary';
import './LightningFoldBar.css';

export default function LightningEndedNotice({
  onViewGame,
  session = null,
  eyebrow = LIGHTNING_ENDED_EYEBROW,
  text = LIGHTNING_ENDED_TEXT,
}: {
  onViewGame: () => void;
  /**
   * LIGHTNING PHASE 8: the session that just ended, summarised under the
   * notice (VIEW SESSION opens its hands). No PLAY AGAIN: the Cluster is
   * MUST MOVE now, and the player's way back is VIEW GAME.
   */
  session?: { poolSessionId: string; clusterId: string; name: string | null } | null;
  /**
   * LIGHTNING PHASE 9: the ending's own words (a timed-out session, or one
   * that ended while the player was away). The MUST MOVE defaults stand for
   * every existing caller.
   */
  eyebrow?: string;
  text?: string;
}) {
  return (
    <div className="lightning-ended" data-testid="lightning-ended" role="alert">
      <p className="lightning-ended__eyebrow">{eyebrow}</p>
      <p className="lightning-ended__text">{text}</p>
      <button
        type="button"
        className="lightning-ended__go"
        data-testid="lightning-ended-view-game"
        onClick={onViewGame}
      >
        {LIGHTNING_RETURN_LABEL}
      </button>
      {session ? (
        <LightningSessionSummaryCard
          poolSessionId={session.poolSessionId}
          clusterId={session.clusterId}
          name={session.name}
          offerPlayAgain={false}
        />
      ) : null}
    </div>
  );
}
