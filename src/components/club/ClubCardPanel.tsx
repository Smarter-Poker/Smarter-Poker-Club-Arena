/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ClubCardPanel — Reusable club card with metal frame + stats overlay
 * ═══════════════════════════════════════════════════════════════════════════════
 * Mirrors ClubStatsPanel (Shark Club) exactly:
 *  - Frame template as background (WebP with JPG fallback)
 *  - Logo sits inside the recessed viewport
 *  - Club ID + Club Name overlays at top/bottom (matching Shark Club baked text)
 *  - Dark stats bar div covers the template's white labels
 *  - Cyan labels + glowing values overlay at 79.5% (matching Shark Club)
 */

import React, { useState } from 'react';
import './ClubCardPanel.css';

interface ClubCardPanelProps {
  clubName: string;
  totalMembers: number;
  clubLevel: number;
  activePlayers: number;
  clubId?: number | string;
  cardImageUrl?: string | null;
  logoUrl?: string | null;
}

export const ClubCardPanel: React.FC<ClubCardPanelProps> = ({
  clubName,
  totalMembers,
  clubLevel,
  activePlayers,
  clubId,
  cardImageUrl,
  logoUrl,
}) => {
  const [cardFailed, setCardFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);

  const useBakedCard = cardImageUrl && !cardFailed;
  const showLogo = !useBakedCard && logoUrl && !logoFailed;
  const basePath = import.meta.env.BASE_URL || '/';

  return (
    <div className="club-card-panel">
      {/* Skeleton shimmer — shown until primary image loads */}
      {!imgLoaded && <div className="club-card-skeleton" />}

      {useBakedCard ? (
        /* ── MODE 1: Baked composite card ──────────────────────────────── */
        <picture>
          <source srcSet={cardImageUrl.replace(/\.jpg$/, '.webp')} type="image/webp" />
          <img
            src={cardImageUrl}
            alt={`${clubName} Card`}
            className="club-card-panel-bg"
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            onError={() => {
              setCardFailed(true);
              setImgLoaded(true);
            }}
          />
        </picture>
      ) : (
        /* ── MODE 2: Fallback — frame template + logo overlay ──────── */
        <>
          <picture>
            <source srcSet={`${basePath}images/club-card-frame-template.webp`} type="image/webp" />
            <img
              src={`${basePath}images/club-card-frame-template.jpg`}
              alt={`${clubName} Card`}
              className="club-card-panel-bg club-card-frame-bg"
              loading="lazy"
              onLoad={() => setImgLoaded(true)}
            />
          </picture>

          {/* Club ID text at top — matches Shark Club's baked "CLUB ID: 25450" */}
          {clubId && <div className="club-card-id-overlay">CLUB ID: {clubId}</div>}

          <div className="club-card-logo-container">
            {showLogo ? (
              <img
                src={logoUrl}
                alt=""
                className="club-card-logo-img"
                loading="lazy"
                onError={() => setLogoFailed(true)}
              />
            ) : (
              <div className="club-card-logo-fallback">♠</div>
            )}
          </div>

          {/* Club name at bottom — matches Shark Club's baked "SHARK CLUB" */}
          <div className="club-card-name-overlay">{clubName}</div>
        </>
      )}

      {/* Dark stats bar — covers the template's white baked-in labels */}
      <div className="club-card-stats-bar-bg" />

      {/* Stats overlay — EXACT COPY of ClubStatsPanel layout */}
      <div className="club-card-stats-overlay">
        <div className="club-card-stats-group club-card-members-group">
          <span className="club-card-stat-label">
            TOTAL
            <br />
            MEMBERS
          </span>
          <span className="club-card-stat-value">{Math.max(1, totalMembers).toLocaleString()}</span>
        </div>

        <div className="club-card-stats-group club-card-level-group">
          <span className="club-card-stat-label">CLUB LEVEL</span>
          <span className="club-card-stat-value">{Math.max(1, clubLevel)}</span>
        </div>

        <div className="club-card-stats-group club-card-active-group">
          <span className="club-card-stat-label">
            ACTIVE
            <br />
            PLAYERS
          </span>
          <span className="club-card-stat-value">{activePlayers?.toLocaleString() || '0'}</span>
        </div>
      </div>
    </div>
  );
};

export default ClubCardPanel;
