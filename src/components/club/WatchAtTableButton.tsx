import { useFitText } from '../lobby/game-cards/useFitText';
import './WatchAtTableButton.css';

/**
 * WATCH AT TABLE, ON THE PAINTED SHELL (Dan 2026-10-16)
 *
 * Dan: "THERE SHOULD BE AN 'WATCH AT TABLE' BUTTON WHEN THEY ARE PLAYING TO
 * EASILY WATCH THEM" - on Find A Player, and on the Player Record when the
 * player is At A Table.
 *
 * Paint what never changes, print what does (#ClubArenaConsole). The control
 * is the approved action shell (`action-primary-shell`, 1280 x 315: chrome rim,
 * black glass face, crystal end caps, a round socket on the left) - the same
 * art the Join The Waiting List call to action stands on. Nothing here draws a
 * border, a pill or a gradient. Three live strings print into zones measured
 * on that art:
 *
 *   socket  the kind of game: Cash or MTT
 *   eyebrow lit blue caps: which table
 *   title   engraved silver: the action (Watch At Table, or the one thing a
 *           non-member has to do first)
 *
 * Every string is fitted to its face, so a long table name shrinks before it
 * can touch the chrome.
 */
export interface WatchAtTableButtonProps {
  onClick: () => void;
  /** Cash or MTT, printed in the socket. */
  socket: string;
  /** Which table, in lit caps above the action. */
  eyebrow: string;
  /** The action itself. */
  title: string;
  /** 'watch' lights the action; 'gated' prints it in gold (join first). */
  tone?: 'watch' | 'gated';
  disabled?: boolean;
  /** Spoken name. Defaults to "<title>, <eyebrow>". */
  ariaLabel?: string;
}

export function WatchAtTableButton({
  onClick,
  socket,
  eyebrow,
  title,
  tone = 'watch',
  disabled = false,
  ariaLabel,
}: WatchAtTableButtonProps) {
  const socketRef = useFitText<HTMLSpanElement>(socket, 1, 0.5);
  const eyebrowRef = useFitText<HTMLSpanElement>(eyebrow, 1, 0.5);
  const titleRef = useFitText<HTMLSpanElement>(title, 1, 0.5);

  return (
    <button
      type="button"
      className="watch-cta"
      data-tone={tone}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel ?? `${title}, ${eyebrow}`}
    >
      <span className="watch-cta__socket" aria-hidden="true">
        <span ref={socketRef} className="watch-cta__socket-text">
          {socket}
        </span>
      </span>
      <span className="watch-cta__face" aria-hidden="true">
        <span className="watch-cta__line">
          <span ref={eyebrowRef} className="watch-cta__eyebrow">
            {eyebrow}
          </span>
        </span>
        <span className="watch-cta__line">
          <span ref={titleRef} className="watch-cta__title">
            {title}
          </span>
        </span>
      </span>
    </button>
  );
}

export default WatchAtTableButton;
