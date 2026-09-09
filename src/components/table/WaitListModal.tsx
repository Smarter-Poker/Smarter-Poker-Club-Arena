/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WAIT LIST MODAL - the queue for a full table, on the spade console
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * - The table in the header well, your place in line in the painted pill slot
 * - Estimated wait, then the queue printed on the glass
 * - CLOSE / LEAVE WAIT LIST on the painted plates; leaving asks once
 *
 * THE CONSOLE (2026-09-08). This was a rounded navy sheet with a circled
 * position badge, avatar discs, a grey table header and a red pill button -
 * a generic list dressed as a popup. It is now the spade console (the same
 * master every Omaha card is drawn from): the table name is the eyebrow,
 * WAIT LIST is engraved in the header well, #3 sits in the well's painted
 * pill slot, the queue prints between the rails in the master's own inks
 * (lit blue numerals, silver names, your own row in white), and the two
 * actions are the plates painted into the foot. Nothing is drawn; no
 * avatars, no discs, no header bar.
 */

import React, { useState, useMemo, useEffect } from 'react';
import { haptic } from '../../services/SoundService';
import { SpadeConsole } from '../console/SpadeConsole';
import './WaitListModal.css';

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

/* Whole minutes, Title Case, no tilde and no decimal: this is a forward
   facing figure. */
function formatDuration(minutes: number): string {
  if (minutes < 1) return 'Under A Minute';
  if (minutes < 60) return `About ${Math.round(minutes)} Min`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return mins > 0 ? `About ${hours}h ${mins}m` : `About ${hours}h`;
}

function formatWaitTime(joinedAt: Date): string {
  const ms = Date.now() - joinedAt.getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'Just Now';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
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

  // Same stale-confirm trap as SitOutModal: the confirm step survived a close,
  // so reopening the wait list dropped the destructive "Leave" button exactly
  // where the player's thumb had last been.
  useEffect(() => {
    if (!isOpen) setShowConfirmLeave(false);
  }, [isOpen]);

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

  const inLine = myPosition > 0;
  const pill = !inLine
    ? players.length === 0
      ? 'Empty'
      : 'Watching'
    : myPosition === 1
      ? 'Next Up'
      : `#${myPosition}`;
  const pillInk = !inLine ? 'muted' : myPosition === 1 ? 'green' : 'blue';

  const plates = showConfirmLeave
    ? {
        secondary: {
          label: 'Cancel',
          onClick: () => setShowConfirmLeave(false),
          autoFocus: true,
          'aria-label': 'Stay On The Wait List',
        },
        primary: {
          label: 'Leave',
          ink: 'red' as const,
          onClick: () => {
            haptic.light();
            handleLeave();
          },
          'aria-label': 'Leave Wait List',
        },
      }
    : {
        secondary: { label: 'Close', onClick: onClose, 'aria-label': 'Close Wait List' },
        primary: inLine
          ? {
              label: 'Leave Wait List',
              ink: 'red' as const,
              onClick: () => setShowConfirmLeave(true),
            }
          : { label: 'Not In Line', ink: 'muted' as const, disabled: true },
      };

  return (
    <div className="waitlist-modal__overlay" onClick={onClose}>
      <div
        className="waitlist-modal ac-popup"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="waitlist-modal-title"
      >
        <SpadeConsole
          as="div"
          eyebrow={blinds && !tableName.includes(blinds) ? `${tableName} ${blinds}` : tableName}
          title="Wait List"
          titleId="waitlist-modal-title"
          pill={pill}
          pillInk={pillInk}
          plates={plates}
        >
          {showConfirmLeave ? (
            <div className="waitlist-modal__confirm">
              <span className="sc-label sc-ink--red">Leave The Line?</span>
              <p className="sc-copy sc-copy--center">
                You Are {ordinal(myPosition)} In Line. Leaving Gives Up Your Place, And Joining
                Again Starts You At The Back.
              </p>
            </div>
          ) : (
            <>
              {inLine && (
                <p className="sc-copy sc-copy--center waitlist-modal__eta">
                  {myPosition === 1
                    ? 'You Are Next. Stay Close To The Table.'
                    : `You Are ${ordinal(myPosition)} In Line. Estimated Wait ${formatDuration(estimatedWait)}.`}
                </p>
              )}
              {players.length === 0 ? (
                <p className="sc-copy sc-copy--center sc-ink--muted">No Players Waiting</p>
              ) : (
                <ol className="waitlist-modal__queue" aria-label="Players Waiting">
                  <li className="waitlist-modal__row waitlist-modal__row--head" aria-hidden="true">
                    <span className="sc-label sc-ink--muted">Spot</span>
                    <span className="sc-label sc-ink--muted">Player</span>
                    <span className="sc-label sc-ink--muted waitlist-modal__wait">Waiting</span>
                  </li>
                  {players.map((player) => {
                    const me = player.playerId === myPlayerId;
                    return (
                      <li
                        key={player.playerId}
                        className={`waitlist-modal__row ${me ? 'waitlist-modal__row--me' : ''}`.trim()}
                        aria-current={me ? 'true' : undefined}
                      >
                        <span className="waitlist-modal__position sc-ink--blue">
                          {player.position}
                        </span>
                        <span
                          className={`waitlist-modal__name ${me ? 'sc-ink--white' : 'sc-ink--silver'}`}
                        >
                          {player.playerName}
                          {me && <span className="waitlist-modal__you sc-ink--gold">You</span>}
                        </span>
                        <span className="waitlist-modal__wait sc-ink--muted">
                          {formatWaitTime(player.joinedAt)}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </>
          )}
        </SpadeConsole>
      </div>
    </div>
  );
}

export default WaitListModal;
