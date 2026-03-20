/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ClubCardPanel — Premium four-zone club/union card
 * ═══════════════════════════════════════════════════════════════════════════════
 * Structured flexbox layout with dedicated zones:
 *   1. ID Plate   — "CLUB ID: XXXXX" or "UNION ID: XXXXX"
 *   2. Viewport   — Club logo / baked card image
 *   3. Name Plate — Club or union name
 *   4. Stats Bar  — Type badge + Total Members / Club Level / Active Players
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
  entityType?: 'club' | 'union';
}

export const ClubCardPanel: React.FC<ClubCardPanelProps> = ({
  clubName,
  totalMembers,
  clubLevel,
  activePlayers,
  clubId,
  cardImageUrl,
  logoUrl,
  entityType = 'club',
}) => {
  const [cardFailed, setCardFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);

  const useBakedCard = cardImageUrl && !cardFailed;
  const showLogo = !useBakedCard && logoUrl && !logoFailed;

  const isUnion = entityType === 'union';
  const idLabel = isUnion ? 'UNION ID' : 'CLUB ID';
  const typeBadgeLabel = isUnion ? '🤝 UNION' : '♠ CLUB';

  return (
    <div className={`club-card-panel ${isUnion ? 'club-card-panel--union' : ''}`}>
      {/* Skeleton shimmer — shown until primary image loads */}
      {!imgLoaded && <div className="club-card-skeleton" />}

      {/* ── ZONE 1: ID Plate ──────────────────────────────────────────────── */}
      <div className="club-card-id-plate">
        {clubId != null && clubId !== '' ? (
          <span className="club-card-id-text">
            {idLabel}: {clubId}
          </span>
        ) : (
          <span className="club-card-id-text">{idLabel}</span>
        )}
      </div>

      {/* ── ZONE 2: Image Viewport ────────────────────────────────────────── */}
      <div className="club-card-viewport">
        {useBakedCard ? (
          <img
            src={cardImageUrl}
            alt={`${clubName} Card`}
            className="club-card-viewport-img"
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            onError={() => {
              setCardFailed(true);
            }}
          />
        ) : showLogo ? (
          <img
            src={logoUrl}
            alt={`${clubName} Logo`}
            className="club-card-viewport-logo"
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            onError={() => {
              setLogoFailed(true);
              setImgLoaded(true);
            }}
          />
        ) : (
          <div
            className="club-card-viewport-fallback"
            ref={() => {
              if (!imgLoaded) setImgLoaded(true);
            }}
          >
            <span className="club-card-fallback-icon">{isUnion ? '🤝' : '♠'}</span>
          </div>
        )}
      </div>

      {/* ── ZONE 3: Name Plate ────────────────────────────────────────────── */}
      <div className="club-card-name-plate">
        <span className="club-card-name-text">{clubName}</span>
      </div>

      {/* ── ZONE 4: Stats Bar ─────────────────────────────────────────────── */}
      <div className="club-card-stats-bar">
        <div className={`club-card-type-badge ${isUnion ? 'club-card-type-badge--union' : ''}`}>
          {typeBadgeLabel}
        </div>
        <div className="club-card-stats-row">
          <div className="club-card-stat">
            <span className="club-card-stat-label">
              TOTAL
              <br />
              MEMBERS
            </span>
            <span className="club-card-stat-value">
              {Math.max(1, totalMembers).toLocaleString()}
            </span>
          </div>
          <div className="club-card-stat">
            <span className="club-card-stat-label">CLUB LEVEL</span>
            <span className="club-card-stat-value club-card-stat-value--level">
              {Math.max(1, clubLevel)}
            </span>
          </div>
          <div className={`club-card-stat ${activePlayers > 0 ? 'club-card-stat--active' : ''}`}>
            <span className="club-card-stat-label">
              ACTIVE
              <br />
              PLAYERS
            </span>
            <span className="club-card-stat-value">{activePlayers?.toLocaleString() || '0'}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ClubCardPanel;
