import { useFitText } from '../lobby/game-cards/useFitText';
import './WaitlistCallToAction.css';

/**
 * THE FULL-TABLE CALL TO ACTION, ON THE PAINTED SHELL (Dan 2026-10-15)
 *
 * Dan, with a screenshot of the old flat green pill: "THE 'TABLE FULL - JOIN
 * WAITING LIST' NEEDS TO BE IMPROVED, THIS IS TOO CHEAP, IT NEEDS A PREMIUM
 * LOOK AND FEEL TO IT."
 *
 * Paint what never changes, print what does (#ClubArenaConsole). The control
 * is the approved action shell (`action-primary-shell`: chrome rim, black glass
 * face, crystal end caps and a socket on the left) and nothing here draws a
 * border, a pill or a gradient. Three live strings are printed into zones
 * measured on that art at its native 1280 x 315:
 *
 *   socket  the number of players waiting, or the hero's own place in line
 *   eyebrow lit blue caps: what state the table is in
 *   title   engraved silver: the action, or where the hero stands
 *
 * Every string is fitted to its face (useFitText), so a long title shrinks
 * before it can touch the chrome.
 */
export interface WaitlistCallToActionProps {
  onClick: () => void;
  /** Lightning joins its pool through the original buy-in, never a chair queue. */
  lightning?: boolean;
  /** Players currently on this table's waiting list. */
  waitingCount: number;
  /** The hero's 1-based place on the list, or null when not on it. */
  position: number | null;
}

export function WaitlistCallToAction({ onClick, waitingCount, position, lightning = false }: WaitlistCallToActionProps) {
  const onList = !lightning && position != null;
  const socket = lightning ? '' : onList ? `#${position}` : String(waitingCount);
  const eyebrow = lightning ? 'Lightning Games' : onList ? 'You Are On The Waiting List' : `Table Full · ${waitingCount} Waiting`;
  const title = lightning ? 'Join Lightning' : onList ? `Position ${position} Of ${waitingCount}` : 'Join The Waiting List';

  const socketRef = useFitText<HTMLSpanElement>(socket, 1, 0.5);
  const eyebrowRef = useFitText<HTMLSpanElement>(eyebrow, 1, 0.5);
  const titleRef = useFitText<HTMLSpanElement>(title, 1, 0.5);

  return (
    <button
      type="button"
      className="waitlist-cta"
      data-on-list={onList ? 'true' : 'false'}
      onClick={onClick}
      aria-label={onList ? `${eyebrow}, ${title}` : `${eyebrow}. ${title}`}
    >
      <span className="waitlist-cta__socket" aria-hidden="true">
        <span ref={socketRef} className="waitlist-cta__socket-text">
          {socket}
        </span>
      </span>
      <span className="waitlist-cta__face" aria-hidden="true">
        <span className="waitlist-cta__line">
          <span ref={eyebrowRef} className="waitlist-cta__eyebrow">
            {eyebrow}
          </span>
        </span>
        <span className="waitlist-cta__line">
          <span ref={titleRef} className="waitlist-cta__title">
            {title}
          </span>
        </span>
      </span>
    </button>
  );
}
