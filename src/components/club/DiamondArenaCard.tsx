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
import { countText, isCountUnknown, type CountFigure } from '../../lib/countFigure';
import { isUnknownFigure, readFigures, rememberFigures } from '../../lib/lobbyFigureCache';
import { formatDuration } from '../../lib/date';
import {
  freerollClockTitle,
  freerollClockWord,
  useNextDiamondFreeroll,
  type FreerollClockState,
} from '../../hooks/useNextDiamondFreeroll';
import './ClubCardPanel.css';

const ARENA_FIGURE_SCOPE = 'arena:diamond';
/** Under this many seconds the countdown turns red (console law). */
const IMMINENT_SECONDS = 10;

interface DiamondArenaCardProps {
  /** Seats filled in the arena right now. `COUNT_UNKNOWN` when the read
   *  answered and could not tell; null while nothing has asked yet. */
  activePlayers: CountFigure;
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
  /* The seam is two-valued on purpose: a number is a scheduled freeroll and
     null is a known "none". Loading and error only ever come from the live
     read, which is the only place they can happen. */
  const clockState: FreerollClockState =
    nextFreerollAt === undefined ? live.state : nextFreerollAt === null ? 'none' : 'scheduled';

  /* Same count cache the club cards use (Dan 2026-09-02: zeros until the
     card loads, then the last known figure, then the live one). A cached zero
     is not a last known figure, so it cannot hand this rail a stale one. */
  const cached = useMemo(() => readFigures(ARENA_FIGURE_SCOPE), []);
  useEffect(() => {
    rememberFigures(ARENA_FIGURE_SCOPE, {
      active: typeof activePlayers === 'number' ? activePlayers : null,
    });
  }, [activePlayers]);

  /* A COUNT NOBODY COULD READ IS NOT ZERO (2026-09-20). This rail printed `0`
     whenever the figure was null, and the figure was null for a STRUCTURAL
     reason rather than a transient one: the count came from a club_members
     join that cannot see a Diamond entitlement, so the answer was always going
     to be zero however many players were seated. The cache then filed that
     zero as the last known figure and served it back on the next visit.

     The count now comes from live seats (get_club_players_playing). The three
     answers a count can give are in src/lib/countFigure.ts; a read that could
     not tell prints the word, and the cache is consulted only for a figure
     somebody genuinely read - a stored zero is not one. */
  const activeIsUnknown = isCountUnknown(activePlayers);
  const lastKnown =
    cached.active !== undefined && !isUnknownFigure(cached.active) ? cached.active : undefined;
  const activeText =
    activePlayers == null && lastKnown !== undefined ? lastKnown : countText(activePlayers);

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

  /* A COUNTDOWN WITH NOTHING TO COUNT TO IS NOT ZERO (2026-09-19). With no
     Diamond freeroll on the calendar this printed 0:00, which on a clock reads
     "starting now". Each non-clock answer prints its own word instead, and a
     failed read prints an unknown rather than a confident zero. */
  const timerWord = remaining == null ? freerollClockWord(clockState) : null;
  const timerText = timerWord ?? formatFreerollCountdown(remaining ?? 0);
  const imminent = remaining != null && remaining > 0 && remaining <= IMMINENT_SECONDS;
  const timerTitle = freerollClockTitle(clockState, startsAt, live.name);
  /* Loading prints zeros like every other figure on the rail; the two words
     get a modifier so they fit the half-rail a clock was sized for. */
  const timerIsWord = timerWord !== null && clockState !== 'loading';
  const timerAria = timerIsWord
    ? `Next Freeroll ${timerText}`
    : `Next Freeroll Starts In ${timerText}`;

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
            className={`club-card-stat ${!activeIsUnknown && Number(activeText.replace(/,/g, '')) > 0 ? 'club-card-stat--active' : ''}`}
          >
            {/* Dan 2026-09-11, of this card: "HAVE IT SAY JUST 'ACTIVE' AND
                THE NUMBER UNDER IT." It said ACTIVE PLAYERS, which was also
                the one label on the carousel that did not match its
                neighbours: every chip club card says ACTIVE. */}
            <span className="club-card-stat-label">ACTIVE</span>
            <span
              className={`club-card-stat-value${activeIsUnknown ? ' club-card-stat-value--word' : ''}`}
              aria-label={activeIsUnknown ? `Active ${activeText}` : undefined}
            >
              {activeText}
            </span>
          </div>
          <div
            className={`club-card-stat club-card-stat--timer ${imminent ? 'club-card-stat--imminent' : ''}`}
            title={timerTitle}
          >
            <span className="club-card-stat-label">NEXT FREEROLL</span>
            <span
              className={`club-card-stat-value club-card-stat-value--timer${timerIsWord ? ' club-card-stat-value--word' : ''}`}
              role="timer"
              aria-live="off"
              aria-label={timerAria}
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
