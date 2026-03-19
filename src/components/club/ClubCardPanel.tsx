/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ClubCardPanel — Reusable club card with metal frame + stats overlay
 * ═══════════════════════════════════════════════════════════════════════════════
 * Two rendering modes:
 *  1. BAKED CARD (preferred) — When cardImageUrl is provided, renders the
 *     pre-composited card image (frame + logo + name baked in) exactly like
 *     ClubStatsPanel does for Shark Club. This is the standard for all clubs.
 *  2. FALLBACK — When only logoUrl is available, overlays the raw logo image
 *     on the frame template with the club name text overlay.
 */

import React, { useState } from 'react';
import './ClubCardPanel.css';

interface ClubCardPanelProps {
  clubName: string;
  totalMembers: number;
  clubLevel: number;
  activePlayers: number;
  cardImageUrl?: string | null;
  logoUrl?: string | null;
}

export const ClubCardPanel: React.FC<ClubCardPanelProps> = ({
  clubName,
  totalMembers,
  clubLevel,
  activePlayers,
  cardImageUrl,
  logoUrl,
}) => {
  const [cardFailed, setCardFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);

  // Prefer baked card image (frame + logo + name composited) — like Shark Club
  const useBakedCard = cardImageUrl && !cardFailed;
  const showLogo = !useBakedCard && logoUrl && !logoFailed;

  return (
    <div className="club-card-panel">
      {useBakedCard ? (
        /* ── MODE 1: Baked composite card (matches Shark Club exactly) ──── */
        <img
          src={cardImageUrl}
          alt={`${clubName} Card`}
          className="club-card-panel-bg"
          loading="lazy"
          onError={() => setCardFailed(true)}
        />
      ) : (
        /* ── MODE 2: Fallback — frame template + logo overlay ──────────── */
        <>
          <img
            src={`${import.meta.env.BASE_URL || '/'}images/club-card-frame-template.jpg`}
            alt={`${clubName} Card`}
            className="club-card-panel-bg"
            loading="lazy"
          />

          {/* Club name at the top */}
          <div className="club-card-name-overlay">
            <span className="club-card-name">{clubName}</span>
          </div>

          {/* Logo in the center viewport area */}
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
        </>
      )}

      {/* Stats overlay — same positions as ClubStatsPanel */}
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
