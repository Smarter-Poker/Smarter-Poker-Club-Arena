/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WAIT LIST MODAL — Queue Management Component
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Modal for managing wait list position:
 * - Current position display
 * - Estimated wait time
 * - Leave wait list option
 *
 * REBUILT ON THE CONSOLE 2026-09-14 (#ClubArenaConsole, the shark family).
 * Re-rendered, not rewritten: every prop, the confirm step and its reset on
 * close, the stagger timers, the one-minute tick, the position and estimate
 * maths, the haptic on leave and the pinned strings ("#2", "Est. Wait",
 * "No Players Waiting") are the ones that were here before. What changed is
 * the picture: the frame is Dan's shark heads-up master, the queue prints as
 * rows on the glass, and the one action sits on the painted plate.
 */

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { haptic } from '../../services/SoundService';
import { SpadeConsole } from '../console/SpadeConsole';
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
  /* No default (final sweep 2026-09-08). This used to default to 5, and no
     caller ever passed it, so every player on every wait list was quoted
     "(position - 1) x 5 min" - a number nobody measured. A wait estimate is
     printed only when the caller supplies a real one; otherwise the position
     stands alone, which is true. */
  avgWaitTimeMinutes,
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
    if (myPosition <= 0) return null;
    if (typeof avgWaitTimeMinutes !== 'number' || !(avgWaitTimeMinutes >= 0)) return null;
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

  const inLine = myPosition > 0;

  /* ONE PLATE, THREE STATES. The shark foot paints one plate, so the action
     changes with the step instead of a second plate appearing: Close when the
     player is not in line, Leave Wait List when they are, and Leave in red
     ink once they have said they mean it. Cancel is the lit word on the glass
     beside the question - the control Club Rules uses for its second action. */
  const plate = !inLine
    ? { label: 'Close', ink: 'silver' as const, onClick: onClose }
    : showConfirmLeave
      ? {
          label: 'Leave',
          ink: 'red' as const,
          onClick: () => {
            haptic.light();
            handleLeave();
          },
        }
      : {
          label: 'Leave Wait List',
          ink: 'silver' as const,
          onClick: () => setShowConfirmLeave(true),
        };

  return (
    <div className="wl-overlay" onClick={onClose}>
      <div
        className="wl-dialog sc-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wl-title"
        onClick={(e) => e.stopPropagation()}
      >
        <SpadeConsole
          as="section"
          family="shark"
          eyebrow={tableName}
          title="Wait List"
          titleId="wl-title"
          pill={inLine ? `#${myPosition}` : blinds}
          pillInk={inLine ? 'gold' : 'blue'}
          plates={{ primary: plate }}
        >
          <div className="wl-rows">
            {inLine && (
              <div className="wl-row">
                <span className="sc-label sc-ink--blue">Your Position</span>
                <span className="wl-row__value sc-ink--silver">#{myPosition}</span>
              </div>
            )}
            {inLine && estimatedWait !== null && (
              <div className="wl-row">
                <span className="sc-label sc-ink--blue">Est. Wait</span>
                <span className="wl-row__value sc-ink--silver">
                  {formatDuration(estimatedWait)}
                </span>
              </div>
            )}
            <div className="wl-row">
              <span className="sc-label sc-ink--blue">Blinds</span>
              <span className="wl-row__value sc-ink--silver">{blinds}</span>
            </div>
          </div>

          {showConfirmLeave ? (
            <div className="wl-confirm">
              <span className="sc-copy sc-copy--center sc-ink--red">
                Are You Sure You Want To Leave?
              </span>
              <button
                type="button"
                className="wl-word sc-ink--blue"
                onClick={() => setShowConfirmLeave(false)}
                autoFocus
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="wl-queue" aria-label="Queue">
              <div className="wl-queue__head">
                <span className="sc-label sc-ink--muted">Position</span>
                <span className="sc-label sc-ink--muted">Player</span>
                <span className="sc-label sc-ink--muted wl-queue__right">Waiting</span>
              </div>
              {players.length === 0 ? (
                <p className="sc-copy sc-copy--center sc-ink--muted wl-queue__empty">
                  No Players Waiting
                </p>
              ) : (
                players.map((player, i) => (
                  <div
                    key={player.playerId}
                    className={`wl-player${player.playerId === myPlayerId ? ' wl-player--me' : ''}`}
                    style={{
                      opacity: visiblePlayers.has(i) ? 1 : 0,
                      transform: visiblePlayers.has(i) ? 'translateY(0)' : 'translateY(8px)',
                      transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                    }}
                  >
                    <span className="wl-player__position sc-ink--blue">#{player.position}</span>
                    <span className="wl-player__who">
                      <span className="wl-player__avatar" aria-hidden="true">
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
                      </span>
                      <span className="wl-player__name sc-ink--silver">
                        {player.playerName}
                        {player.playerId === myPlayerId && ' (You)'}
                      </span>
                    </span>
                    <span className="wl-player__wait sc-ink--muted">
                      {formatWaitTime(player.joinedAt)}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}

          {inLine && !showConfirmLeave && (
            <button type="button" className="wl-word sc-ink--muted wl-close" onClick={onClose}>
              Close
            </button>
          )}
        </SpadeConsole>
      </div>
    </div>
  );
}

export default WaitListModal;
