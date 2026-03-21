/**
 * ClubStatsPanel - Optimized version with image + CSS overlays
 *
 * Performance optimization:
 * - Uses SVG as background image (browser caches it)
 * - Dynamic numbers rendered as CSS positioned text
 * - Reduces bundle size by not inlining SVG
 */

import React from 'react';
import './ClubStatsPanel.css';

interface ClubStatsPanelProps {
  totalMembers: number;
  clubLevel: number;
  activePlayers: number;
}

export const ClubStatsPanel: React.FC<ClubStatsPanelProps> = ({
  totalMembers,
  clubLevel,
  activePlayers,
}) => {
  return (
    <div className="club-stats-panel">
      {/* Background SVG/JPG loaded as image (browser caches) */}
      <img
        src={`${import.meta.env.BASE_URL || '/'}images/shark-club-card-v25.jpg`}
        alt="Shark Club Card"
        className="club-stats-bg"
        loading="lazy"
        decoding="async"
      />

      <div className="stats-overlay">
        <div className="stats-group members-group">
          <span className="stat-label">MEMBERS</span>
          <span className="stat-value">{Math.max(1, totalMembers).toLocaleString()}</span>
        </div>

        <div className="stats-group level-group">
          <span className="stat-label">LEVEL</span>
          <span className="stat-value">{Math.max(1, clubLevel)}</span>
        </div>

        <div className="stats-group active-group">
          <span className="stat-label">ACTIVE</span>
          <span className="stat-value">{activePlayers?.toLocaleString() || '0'}</span>
        </div>
      </div>
    </div>
  );
};

export default ClubStatsPanel;
