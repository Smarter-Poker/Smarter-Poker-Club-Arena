/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SpectatorOverlay — Enhanced Viewer Experience
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Top-right overlay showing spectator count, expandable viewer list, and
 * follow-player functionality. Replaces the basic SpectatorBadge with
 * a full spectator HUD.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { haptic } from '../../services/SoundService';
import { resolveAvatarDisplay } from '../../utils/avatarUtils';
import './SpectatorOverlay.css';

export interface SpectatorInfo {
  userId: string;
  displayName: string;
  avatarUrl: string;
  joinedAt: Date;
}

export interface SpectatorOverlayProps {
  spectators: SpectatorInfo[];
  isSpectator: boolean;
  followingPlayerId?: string | null;
  onFollowPlayer?: (playerId: string | null) => void;
  tableId?: string;
}

export function SpectatorOverlay({
  spectators,
  isSpectator,
  followingPlayerId,
  onFollowPlayer,
  tableId,
}: SpectatorOverlayProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [pulseCount, setPulseCount] = useState(false);
  const prevCountRef = useRef(spectators.length);

  // Pulse animation when spectator count changes (skip initial mount)
  useEffect(() => {
    if (prevCountRef.current !== spectators.length) {
      prevCountRef.current = spectators.length;
      setPulseCount(true);
      const timer = setTimeout(() => setPulseCount(false), 600);
      return () => clearTimeout(timer);
    }
  }, [spectators.length]);

  const handleToggleExpand = useCallback(() => {
    haptic.light();
    setIsExpanded((prev) => !prev);
  }, []);

  const handleUnfollow = useCallback(() => {
    haptic.light();
    onFollowPlayer?.(null);
  }, [onFollowPlayer]);

  if (spectators.length === 0 && !isSpectator) return null;

  return (
    <div className="spectator-overlay">
      {/* Compact Badge */}
      <button
        className={`so-badge ${pulseCount ? 'so-badge--pulse' : ''}`}
        onClick={handleToggleExpand}
        title={`${spectators.length} Watching`}
      >
        <span className="so-badge__icon">◉</span>
        <span className="so-badge__count">{spectators.length}</span>
      </button>

      {/* Following indicator */}
      {isSpectator && followingPlayerId && (
        <div className="so-following">
          <span className="so-following__label">Following</span>
          <button className="so-following__unfollow" onClick={handleUnfollow}>
            ✕
          </button>
        </div>
      )}

      {/* Expanded Viewer List */}
      {isExpanded && (
        <div className="so-panel">
          <div className="so-panel__header">
            <h4 className="so-panel__title">Spectators ({spectators.length})</h4>
            <button className="so-panel__close" onClick={handleToggleExpand}>
              ×
            </button>
          </div>

          <div className="so-panel__list">
            {spectators.length === 0 ? (
              <div className="so-panel__empty">No Spectators</div>
            ) : (
              spectators.map((spec) => (
                <div key={spec.userId} className="so-viewer">
                  <img
                    loading="lazy"
                    decoding="async"
                    className="so-viewer__avatar"
                    src={resolveAvatarDisplay(spec.avatarUrl, spec.userId)}
                    alt={spec.displayName}
                  />
                  <span className="so-viewer__name">{spec.displayName}</span>
                  <span className="so-viewer__time">{getTimeAgo(spec.joinedAt)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function getTimeAgo(date: Date): string {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  return `${Math.floor(diff / 3600)}h`;
}

export default SpectatorOverlay;
