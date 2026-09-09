/**
 * ClubCardPanel — the club's card in the lobby carousel, on the spade console
 *
 * THE CONSOLE (#ClubArenaConsole). This was four CSS-drawn zones: a 10px
 * rounded shell with a 4px brushed-nickel border, a gradient fill and two
 * shadows; a gradient "ID plate" with an inset rivet line; a recessed gradient
 * viewport; a gradient "name plate"; and a gradient stats bar. Five drawn
 * plates around one picture, and the union variant re-coloured every one of
 * their borders.
 *
 * It is now Dan's approved spade master. The head well IS the id plate and the
 * name plate: CLUB ID (or UNION ID) is the eyebrow, the club's name is
 * engraved beside it, and the number prints into the master's PAINTED pill
 * slot. The club's own square art - what ClubCardGenerator bakes, viewport art
 * with no frame of its own, so nothing is laid over anything - prints on the
 * black glass between the rails, and MEMBERS / LEVEL / ACTIVE are rows under
 * it. The foot is the flat closing cap: this card has no actions, and the foot
 * never paints a plate with nothing on it.
 *
 * The union dress varies by INK, not by structure (Dan: "I don't want every
 * single frame and button to be 100% exactly the same, just the same style") -
 * the pill and the fallback mark go gold, and everything else is the master.
 *
 * NOTHING IN THE DATA LAYER MOVED. The image/logo/fallback ladder, the
 * load-and-error state resets, the lobbyFigureCache read and write (Dan
 * 2026-09-02: "the game cards should never say unavailable, they should have
 * 0's until the card loads"), the level tooltip and the progressbar's ARIA are
 * all exactly as they were.
 *
 * EVERY ANIMATION STILL PLAYS (CLAUDE.md 10.6): clubCardShimmer on the
 * skeleton, clubCardFadeIn on the art, the staggered label and value reveals,
 * and the infinite pulse on a live ACTIVE count - same durations, same delays,
 * same chain. Two of them were named `statLabelReveal` and `activePulse`;
 * @keyframes is a global namespace in a plain stylesheet, so both now carry
 * this component's prefix.
 */

import { useState, useEffect, useMemo } from 'react';
import { figureOr, readFigures, rememberFigures } from '../../lib/lobbyFigureCache';
import { SpadeConsole } from '../console/SpadeConsole';
import './ClubCardPanel.css';

interface ClubCardPanelProps {
  clubName: string;
  totalMembers: number | null;
  clubLevel: number | null;
  activePlayers: number | null;
  clubId?: number | string;
  /**
   * Where the club sits between its current level and the next, 0-100, on the
   * 1-55 member ladder. Omit to hide the progress line entirely.
   */
  levelProgressPercent?: number;
  /** Members still needed for the next level. null at the cap. */
  membersToNextLevel?: number | null;
  /** "Regional Operator" etc, for the level tile's tooltip. */
  levelTierLabel?: string;
  cardImageUrl?: string | null;
  logoUrl?: string | null;
  entityType?: 'club' | 'union';
}

export const ClubCardPanel: React.FC<ClubCardPanelProps> = ({
  clubName,
  totalMembers,
  clubLevel,
  activePlayers,
  clubId,
  levelProgressPercent,
  membersToNextLevel,
  levelTierLabel,
  cardImageUrl,
  logoUrl,
  entityType = 'club',
}) => {
  const [cardFailed, setCardFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  // Initialize as loaded if no images to wait for (eliminates 1-frame skeleton flash)
  const [imgLoaded, setImgLoaded] = useState(!cardImageUrl && !logoUrl);

  // Reset error/load states when image URLs change (e.g. after backfill or re-upload)
  // Without this, a stale cardFailed=true would permanently block a valid new URL
  useEffect(() => {
    setCardFailed(false);
    setLogoFailed(false);
    setImgLoaded(false);
  }, [cardImageUrl, logoUrl]);

  const useBakedCard = cardImageUrl && !cardFailed;
  const showLogo = !useBakedCard && logoUrl && !logoFailed;

  // When neither baked card nor logo is available, mark as loaded immediately
  // (no image to wait for — fallback emoji renders instantly)
  useEffect(() => {
    if (!useBakedCard && !showLogo && !imgLoaded) {
      setImgLoaded(true);
    }
  }, [useBakedCard, showLogo, imgLoaded]);

  const isUnion = entityType === 'union';
  const idLabel = isUnion ? 'UNION ID' : 'CLUB ID';

  /* ═══════════════════════════════════════════════════════════════════════
     NO "UNAVAILABLE" IN A NUMBER BAY (Dan 2026-09-02)
     -----------------------------------------------------------------------
     "THE GAME CARDS SHOULD NEVER SAY UNAVAILABLE, THEY SHOULD HAVE 0'S UNTIL
     THE CARD LOADS. BUT THIS SHOULD HAVE A CACHE FEATURE, THAT ALWAYS SAVES
     THE LAST KNOWN NUMBERS, SAVED AS THE DEFAULT, AND UPDATES WHEN IT HAS
     THE REAL NUMBERS UPDATED."

     The three stats arrive from a separate live-stats read, so this card is
     drawn with all of them null and printed the word three times across a
     row of numerals. Now it opens with whatever it knew last, falls back to
     0 when it has never seen this club, and overwrites with the live figure
     the moment it lands.

     This is a COUNT cache and nothing else - see the header of
     lobbyFigureCache.ts. Members, level and active players are public facts
     about a club; showing yesterday's briefly costs nobody anything. The
     same trick on money would be the bug clubPageHardening.test.ts exists
     to prevent, and no money passes through here. */
  const scope = clubId != null && clubId !== '' ? `club:${clubId}` : '';
  const cached = useMemo(() => readFigures(scope), [scope]);

  useEffect(() => {
    if (!scope) return;
    rememberFigures(scope, {
      members: totalMembers,
      level: clubLevel == null ? null : Math.max(1, clubLevel),
      active: activePlayers,
    });
  }, [scope, totalMembers, clubLevel, activePlayers]);

  const membersText = figureOr(
    totalMembers == null ? null : totalMembers.toLocaleString(),
    cached.members
  );
  const levelText = figureOr(clubLevel == null ? null : Math.max(1, clubLevel), cached.level);
  const activeText = figureOr(
    activePlayers == null ? null : activePlayers.toLocaleString(),
    cached.active
  );

  const hasId = clubId != null && clubId !== '';

  return (
    <SpadeConsole
      as="div"
      className={`club-card-panel ${isUnion ? 'club-card-panel--union' : ''}`}
      eyebrow={idLabel}
      title={clubName}
      pill={hasId ? String(clubId) : undefined}
      pillInk={isUnion ? 'gold' : 'blue'}
      foot="foot"
    >
      {!imgLoaded && <div className="club-card-skeleton" />}

      {/* The club's own art, on the glass. It is viewport art with no frame of
          its own (ClubCardGenerator bakes 600x600 and nothing else), so no
          picture is laid over another picture. */}
      <div className="club-card-viewport">
        {useBakedCard ? (
          <img
            src={cardImageUrl}
            alt={`${clubName} Card`}
            className="club-card-viewport-img"
            loading="lazy"
            decoding="async"
            onLoad={() => setImgLoaded(true)}
            onError={() => setCardFailed(true)}
          />
        ) : showLogo ? (
          <img
            src={logoUrl}
            alt={`${clubName} Logo`}
            className="club-card-viewport-logo"
            loading="lazy"
            decoding="async"
            onLoad={() => setImgLoaded(true)}
            onError={() => {
              setLogoFailed(true);
              setImgLoaded(true);
            }}
          />
        ) : (
          <span
            className={`club-card-fallback-icon ${isUnion ? 'sc-ink--gold' : 'sc-ink--blue'}`}
            aria-hidden="true"
          >
            {isUnion ? '◈' : '♠'}
          </span>
        )}
      </div>

      {/* Three figures, three engraved rows. */}
      <div className="club-card-stats">
        <div className="club-card-stat">
          <span className="club-card-stat-label sc-label sc-ink--blue">MEMBERS</span>
          <span className="club-card-stat-value sc-ink--silver">{membersText}</span>
        </div>
        {/* Dan 2026-08-20: level is now the 1-55 member ladder, so the bare
            number is worth explaining on hover — which tier it is, and how
            many members away the next one is. */}
        <div
          className="club-card-stat"
          title={
            levelTierLabel
              ? membersToNextLevel != null
                ? `${levelTierLabel} - ${membersToNextLevel.toLocaleString()} More Members To Level ${Math.max(1, clubLevel ?? 1) + 1}`
                : `${levelTierLabel} - Maximum Level`
              : undefined
          }
        >
          <span className="club-card-stat-label sc-label sc-ink--blue">LEVEL</span>
          <span className="club-card-stat-value sc-ink--silver">{levelText}</span>
        </div>
        <div className={`club-card-stat ${(activePlayers ?? 0) > 0 ? 'club-card-stat--live' : ''}`}>
          <span className="club-card-stat-label sc-label sc-ink--blue">ACTIVE</span>
          <span
            className={`club-card-stat-value ${(activePlayers ?? 0) > 0 ? 'sc-ink--green' : 'sc-ink--silver'}`}
          >
            {activeText}
          </span>
        </div>
      </div>

      {/* Progress toward the next level. A bare number does not say whether a
          club just levelled or is one member short of the next; this does,
          in 3px. Hidden entirely when no progress was supplied. */}
      {levelProgressPercent != null && (
        <div
          className="club-card-level-track"
          role="progressbar"
          aria-valuenow={Math.round(levelProgressPercent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Progress To Level ${Math.max(1, clubLevel ?? 1) + 1}`}
        >
          <span
            className="club-card-level-fill"
            style={{ width: `${Math.max(0, Math.min(100, levelProgressPercent))}%` }}
          />
        </div>
      )}
    </SpadeConsole>
  );
};

export default ClubCardPanel;
