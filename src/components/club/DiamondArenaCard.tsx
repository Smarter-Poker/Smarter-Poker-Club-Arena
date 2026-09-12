/**
 * DiamondArenaCard - the Diamond Arena entry, on the club card chassis.
 *
 * Dan 2026-09-09: "THE DIAMOND ARENA CARD HAS TO LOOK AND FEEL EXACTLY LIKE
 * THE CLUB ARENA CARDS DO, SAME SQUARE SHAPE, ON THE BOTTOM HAVE AN ACTIVE
 * PLAYERS TAB, AND NEXT FREE ROLL STARTS IN X:XX TIMER."
 *
 * So this is the same four-zone card every club and union gets (ID plate,
 * square viewport, name plate, stats bar) drawn from ClubCardPanel.css, with
 * the approved Diamond Arena art in the viewport and two live figures on the
 * bottom rail: the players seated in the arena right now, and a countdown to
 * the next freeroll. The art is a square window cut from the original
 * public/cards/diamond-arena.png at native resolution - the same picture,
 * never a generated substitute (Poker Arena phase 5).
 *
 * It is a picture, not a control: the carousel owns the tap, exactly as it
 * does for ClubCardPanel.
 */
import { useEffect, useMemo, useState } from 'react';
import { figureOr, readFigures, rememberFigures } from '../../lib/lobbyFigureCache';
import { formatDuration } from '../../lib/date';
import { useNextDiamondFreeroll } from '../../hooks/useNextDiamondFreeroll';
import './ClubCardPanel.css';

const ARENA_FIGURE_SCOPE = 'arena:diamond';
/** Under this many seconds the countdown turns red (console law). */
const IMMINENT_SECONDS = 10;

interface DiamondArenaCardProps {
  activePlayers: number | null;
  /** Test seam: a fixed start for the countdown instead of the live read. */
  nextFreerollAt?: number | null;
}

/** "M:SS" under an hour, "H:MM:SS" under a day, "2d 4h" beyond. */
export function formatFreerollCountdown(seconds: number): string {
  if (seconds >= 86_400) {
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3_600);
    return `${days}d ${hours}h`;
  }
  return formatDuration(Math.max(0, seconds));
}

export const DiamondArenaCard: React.FC<DiamondArenaCardProps> = ({
  activePlayers,
  nextFreerollAt,
}) => {
  const [imgLoaded, setImgLoaded] = useState(false);
  const live = useNextDiamondFreeroll(nextFreerollAt === undefined);
  const startsAt = nextFreerollAt === undefined ? live.startsAt : nextFreerollAt;

  /* Same count cache the club cards use (Dan 2026-09-02: zeros until the
     card loads, then the last known figure, then the live one). */
  const cached = useMemo(() => readFigures(ARENA_FIGURE_SCOPE), []);
  useEffect(() => {
    rememberFigures(ARENA_FIGURE_SCOPE, { active: activePlayers });
  }, [activePlayers]);
  const activeText = figureOr(
    activePlayers == null ? null : activePlayers.toLocaleString(),
    cached.active
  );

  /* The countdown ticks locally once a second; the hook only re-reads the
     database once a minute and when this clock runs out. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startsAt == null) return;
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [startsAt]);

  const remaining = startsAt == null ? null : Math.max(0, Math.floor((startsAt - now) / 1000));
  const expired = remaining === 0;
  const isLive = nextFreerollAt === undefined;
  const { refresh } = live;
  useEffect(() => {
    if (expired && isLive) refresh();
  }, [expired, isLive, refresh]);

  const timerText = remaining == null ? '0:00' : formatFreerollCountdown(remaining);
  const imminent = remaining != null && remaining > 0 && remaining <= IMMINENT_SECONDS;
  const timerTitle =
    startsAt == null
      ? 'No Freeroll Scheduled Yet'
      : `${live.name ?? 'Freeroll'} Starts ${new Date(startsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

  return (
    <div className="club-card-panel club-card-panel--arena">
      {!imgLoaded && <div className="club-card-skeleton" />}

      {/* ZONE 1: ID Plate. A club prints its join code here; the arena has
          none and never says "automatic entry" (Dan 2026-09-09), so the plate
          carries the house name instead, as the table in the art does. */}
      <div className="club-card-id-plate">
        <span className="club-card-id-text">SMARTER.POKER</span>
      </div>

      {/* ZONE 2: Image Viewport */}
      <div className="club-card-viewport">
        <img
          src={`${import.meta.env.BASE_URL}cards/diamond-arena-square.jpg`}
          alt="Diamond Arena Card"
          className="club-card-viewport-img"
          decoding="async"
          draggable={false}
          onLoad={() => setImgLoaded(true)}
          onError={() => setImgLoaded(true)}
        />
      </div>

      {/* ZONE 3: Name Plate */}
      <div className="club-card-name-plate">
        <span className="club-card-name-text">DIAMOND ARENA</span>
      </div>

      {/* ZONE 4: Stats Bar */}
      <div className="club-card-stats-bar">
        <div className="club-card-stats-row club-card-stats-row--two">
          <div
            className={`club-card-stat ${(activePlayers ?? 0) > 0 ? 'club-card-stat--active' : ''}`}
          >
            {/* Dan 2026-09-11, of this card: "HAVE IT SAY JUST 'ACTIVE' AND
                THE NUMBER UNDER IT." It said ACTIVE PLAYERS, which was also
                the one label on the carousel that did not match its
                neighbours: every chip club card says ACTIVE. */}
            <span className="club-card-stat-label">ACTIVE</span>
            <span className="club-card-stat-value">{activeText}</span>
          </div>
          <div
            className={`club-card-stat club-card-stat--timer ${imminent ? 'club-card-stat--imminent' : ''}`}
            title={timerTitle}
          >
            <span className="club-card-stat-label">NEXT FREEROLL</span>
            <span
              className="club-card-stat-value club-card-stat-value--timer"
              role="timer"
              aria-live="off"
              aria-label={`Next Freeroll Starts In ${timerText}`}
            >
              {timerText}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DiamondArenaCard;
