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

import React, { useState, useMemo, useEffect, useRef } from 'react';
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
  avgWaitTimeMinutes?: number;
}

/*
 * REMOVED 2026-08-20: `onAutoSeatChange` / `autoSeatEnabled`.
 *
 * The auto-seat switch was gated on `onAutoSeatChange` being supplied, and no
 * caller ever supplied it, so it never rendered. That was the only thing
 * keeping it honest: there is no `auto_seat` column on `table_waitlist` and
 * nothing anywhere that seats a waiting player automatically, so the switch had
 * nothing behind it. Rendering it would have promised a feature the platform
 * does not have. Re-add it together with the server side, not before.
 */

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
  avgWaitTimeMinutes = 5,
}: WaitListModalProps) {
  const [showConfirmLeave, setShowConfirmLeave] = useState(false);
  const [visiblePlayers, setVisiblePlayers] = useState<Set<number>>(new Set());

  // Same stale-confirm trap as SitOutModal: the confirm step survived a close,
  // so reopening the wait list dropped the destructive "Leave" button exactly
  // where the player's thumb had last been.
  useEffect(() => {
    if (!isOpen) setShowConfirmLeave(false);
  }, [isOpen]);
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  useEffect(() => {
    staggerTimersRef.current.forEach((t) => clearTimeout(t));
    staggerTimersRef.current = players.map((_, i) =>
      setTimeout(() => setVisiblePlayers((prev) => new Set(prev).add(i)), i * 50)
    );
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
                Est. Wait: {formatDuration(estimatedWait)}
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
              <div className="waitlist-modal__empty">No Players Waiting</div>
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

        {/* Actions */}
        <div className="waitlist-modal__actions">
          {myPosition > 0 && !showConfirmLeave && (
            <button
              type="button"
              className="waitlist-modal__leave-btn"
              onClick={() => setShowConfirmLeave(true)}
            >
              Leave Wait List
            </button>
          )}

          {showConfirmLeave && (
            <div className="waitlist-modal__confirm">
              <span>Are You Sure You Want To Leave?</span>
              <div className="waitlist-modal__confirm-actions">
                <button
                  type="button"
                  className="waitlist-modal__confirm-no"
                  onClick={() => setShowConfirmLeave(false)}
                  autoFocus
                >
                  Cancel
                </button>
                <button
                  type="button"
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
