/**
 * ClubStatsPanel - Optimized version with image + CSS overlays
 *
 * Performance optimization:
 * - Uses SVG as background image (browser caches it)
 * - Dynamic numbers rendered as CSS positioned text
 * - Reduces bundle size by not inlining SVG
 */

import { type FC } from 'react';
import { MEDIA_BASE } from '../../utils/mediaBase';
import './ClubStatsPanel.css';

interface ClubStatsPanelProps {
  totalMembers: number | null;
  clubLevel: number | null;
  activePlayers: number | null;
}

export const ClubStatsPanel: FC<ClubStatsPanelProps> = ({
  totalMembers,
  clubLevel,
  activePlayers,
}) => {
  return (
    <div className="club-stats-panel">
      {/* Background SVG/JPG loaded as image (browser caches) */}
      <img
        src={`${MEDIA_BASE}images/shark-club-card-v25.jpg`}
        alt="Shark Club Card"
        className="club-stats-bg"
        loading="lazy"
        decoding="async"
      />

      <div className="stats-overlay">
        <div className="stats-group members-group">
          <span className="stat-label">MEMBERS</span>
          <span className={totalMembers !== null ? 'stat-value' : 'stat-value loading-pulse'}>
            {totalMembers !== null ? Math.max(1, totalMembers).toLocaleString() : '...'}
          </span>
        </div>

        <div className="stats-group level-group">
          <span className="stat-label">LEVEL</span>
          <span className={clubLevel !== null ? 'stat-value' : 'stat-value loading-pulse'}>
            {clubLevel !== null ? Math.max(1, clubLevel) : '•'}
          </span>
        </div>

        <div className="stats-group active-group">
          <span className="stat-label">ACTIVE</span>
          <span className={activePlayers !== null ? 'stat-value' : 'stat-value loading-pulse'}>
            {activePlayers !== null ? activePlayers.toLocaleString() : '...'}
          </span>
        </div>
      </div>
    </div>
  );
};

export default ClubStatsPanel;
