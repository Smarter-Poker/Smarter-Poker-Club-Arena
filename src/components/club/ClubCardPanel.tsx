/**
 * ClubCardPanel — Premium four-zone club/union card
 * ZONES: ID Plate → Image Viewport → Name Plate → Stats Bar
 */

import { useState, useEffect } from 'react';
import './ClubCardPanel.css';

interface ClubCardPanelProps {
  clubName: string;
  totalMembers: number;
  clubLevel: number;
  activePlayers: number;
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

  return (
    <div className={`club-card-panel ${isUnion ? 'club-card-panel--union' : ''}`}>
      {!imgLoaded && <div className="club-card-skeleton" />}

      {/* ZONE 1: ID Plate */}
      <div className="club-card-id-plate">
        {clubId != null && clubId !== '' ? (
          <span className="club-card-id-text">
            {idLabel}: {clubId}
          </span>
        ) : (
          <span className="club-card-id-text">{idLabel}</span>
        )}
      </div>

      {/* ZONE 2: Image Viewport */}
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
          <div className="club-card-logo-container">
            <div className="club-card-logo-backdrop"></div>
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
          </div>
        ) : (
          <div className="club-card-viewport-fallback">
            <span className="club-card-fallback-icon">{isUnion ? '◈' : '♠'}</span>
          </div>
        )}
      </div>

      {/* ZONE 3: Name Plate */}
      <div className="club-card-name-plate">
        <span className="club-card-name-text">{clubName}</span>
      </div>

      {/* ZONE 4: Stats Bar — no badge pill, just stats */}
      <div className="club-card-stats-bar">
        <div className="club-card-stats-row">
          <div className="club-card-stat">
            <span className="club-card-stat-label">MEMBERS</span>
            <span className="club-card-stat-value">
              {Math.max(1, totalMembers).toLocaleString()}
            </span>
          </div>
          {/* Dan 2026-08-20: level is now the 1-55 member ladder, so the bare
              number is worth explaining on hover — which tier it is, and how
              many members away the next one is. */}
          <div
            className="club-card-stat"
            title={
              levelTierLabel
                ? membersToNextLevel != null
                  ? `${levelTierLabel} - ${membersToNextLevel.toLocaleString()} more members to level ${Math.max(1, clubLevel) + 1}`
                  : `${levelTierLabel} - maximum level`
                : undefined
            }
          >
            <span className="club-card-stat-label">LEVEL</span>
            <span className="club-card-stat-value club-card-stat-value--level">
              {Math.max(1, clubLevel)}
            </span>
          </div>
          <div className={`club-card-stat ${activePlayers > 0 ? 'club-card-stat--active' : ''}`}>
            <span className="club-card-stat-label">ACTIVE</span>
            <span className="club-card-stat-value">{activePlayers.toLocaleString()}</span>
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
            aria-label={`Progress To Level ${Math.max(1, clubLevel) + 1}`}
          >
            <span
              className="club-card-level-fill"
              style={{ width: `${Math.max(0, Math.min(100, levelProgressPercent))}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default ClubCardPanel;
