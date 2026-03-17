/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WAIT LIST MODAL — Queue Management Component
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Modal for managing wait list position:
 * - Current position display
 * - Estimated wait time
 * - Leave wait list option
 * - Auto-seat toggle
 */

import React, { useState, useMemo, useEffect } from 'react';
import { haptic } from '../../services/SoundService';
import './WaitListModal.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface WaitListPlayer {
  playerId: string;
  playerName: string;
  avatar?: string;
  position: number;
  joinedAt: Date;
}

export interface WaitListModalProps {
  isOpen: boolean;
  onClose: () => void;
  tableName: string;
  blinds: string;
  players: WaitListPlayer[];
  myPlayerId: string;
  onLeaveWaitList: () => void;
  onAutoSeatChange?: (enabled: boolean) => void;
  autoSeatEnabled?: boolean;
  avgWaitTimeMinutes?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function formatDuration(minutes: number): string {
  if (minutes < 1) return 'Less than 1 min';
  if (minutes < 60) return `~${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return `~${hours}h ${mins}m`;
}

function formatWaitTime(joinedAt: Date): string {
  const ms = Date.now() - joinedAt.getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function WaitListModal({
  isOpen,
  onClose,
  tableName,
  blinds,
  players,
  myPlayerId,
  onLeaveWaitList,
  onAutoSeatChange,
  autoSeatEnabled = true,
  avgWaitTimeMinutes = 5,
}: WaitListModalProps) {
  const [showConfirmLeave, setShowConfirmLeave] = useState(false);
  const [visiblePlayers, setVisiblePlayers] = useState<Set<number>>(new Set());

  useEffect(() => {
    players.forEach((_, i) => {
      setTimeout(() => setVisiblePlayers((prev) => new Set(prev).add(i)), i * 50);
    });
  }, [players.length]);

  // Find my position
  const myPosition = useMemo(() => {
    return players.findIndex((p) => p.playerId === myPlayerId) + 1;
  }, [players, myPlayerId]);

  // Estimated wait time
  const estimatedWait = useMemo(() => {
    if (myPosition <= 0) return 0;
    return (myPosition - 1) * avgWaitTimeMinutes;
  }, [myPosition, avgWaitTimeMinutes]);

  // Update wait times every minute
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(interval);
  }, []);

  // Handle leave
  const handleLeave = () => {
    onLeaveWaitList();
    setShowConfirmLeave(false);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="waitlist-overlay" onClick={onClose}>
      <div className="waitlist-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="waitlist-modal__header">
          <h2 className="waitlist-modal__title">Wait List</h2>
          <button className="waitlist-modal__close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Table Info */}
        <div className="waitlist-modal__table-info">
          <span className="waitlist-modal__table-name">{tableName}</span>
          <span className="waitlist-modal__table-blinds">{blinds}</span>
        </div>

        {/* My Position */}
        {myPosition > 0 && (
          <div className="waitlist-modal__position">
            <div className="waitlist-modal__position-number">#{myPosition}</div>
            <div className="waitlist-modal__position-info">
              <span className="waitlist-modal__position-label">Your Position</span>
              <span className="waitlist-modal__position-eta">
                Est. wait: {formatDuration(estimatedWait)}
              </span>
            </div>
          </div>
        )}

        {/* Queue List */}
        <div className="waitlist-modal__queue">
          <div className="waitlist-modal__queue-header">
            <span>Position</span>
            <span>Player</span>
            <span>Waiting</span>
          </div>
          <div className="waitlist-modal__queue-body">
            {players.length === 0 ? (
              <div className="waitlist-modal__empty">No players waiting</div>
            ) : (
              players.map((player, i) => (
                <div
                  key={player.playerId}
                  className={`waitlist-modal__player ${player.playerId === myPlayerId ? 'waitlist-modal__player--me' : ''}`}
                  style={{
                    opacity: visiblePlayers.has(i) ? 1 : 0,
                    transform: visiblePlayers.has(i) ? 'translateY(0)' : 'translateY(8px)',
                    transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  }}
                >
                  <span className="waitlist-modal__player-position">#{player.position}</span>
                  <div className="waitlist-modal__player-info">
                    <div className="waitlist-modal__player-avatar">
                      {player.avatar ? (
                        <img
                          loading="lazy"
                          decoding="async"
                          src={player.avatar}
                          alt=""
                          onError={(e) => {
                            (e.target as HTMLImageElement).src = generateDefaultAvatar();
                          }}
                        />
                      ) : (
                        <span>{player.playerName[0]?.toUpperCase()}</span>
                      )}
                    </div>
                    <span className="waitlist-modal__player-name">
                      {player.playerName}
                      {player.playerId === myPlayerId && ' (You)'}
                    </span>
                  </div>
                  <span className="waitlist-modal__player-wait">
                    {formatWaitTime(player.joinedAt)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Auto-Seat Toggle */}
        {myPosition > 0 && onAutoSeatChange && (
          <label className="waitlist-modal__auto-seat">
            <input
              type="checkbox"
              checked={autoSeatEnabled}
              onChange={(e) => onAutoSeatChange(e.target.checked)}
            />
            <span className="waitlist-modal__toggle-slider" />
            <span className="waitlist-modal__toggle-label">Auto-seat when available</span>
          </label>
        )}

        {/* Actions */}
        <div className="waitlist-modal__actions">
          {myPosition > 0 && !showConfirmLeave && (
            <button className="waitlist-modal__leave-btn" onClick={() => setShowConfirmLeave(true)}>
              Leave Wait List
            </button>
          )}

          {showConfirmLeave && (
            <div className="waitlist-modal__confirm">
              <span>Are you sure you want to leave?</span>
              <div className="waitlist-modal__confirm-actions">
                <button
                  className="waitlist-modal__confirm-no"
                  onClick={() => setShowConfirmLeave(false)}
                >
                  Cancel
                </button>
                <button
                  className="waitlist-modal__confirm-yes"
                  onClick={() => {
                    haptic.light();
                    handleLeave();
                  }}
                >
                  Leave
                </button>
              </div>
            </div>
          )}

          {myPosition <= 0 && (
            <button className="waitlist-modal__close-btn" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default WaitListModal;
