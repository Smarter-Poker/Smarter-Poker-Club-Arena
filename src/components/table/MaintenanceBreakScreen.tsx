/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  MAINTENANCE BREAK OVERLAY
 *  Dan, 2026-09-01
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * What a player sees for the five minutes that contain the engine restart.
 *
 * Deliberately a sibling of TournamentBreakScreen rather than a variant of it:
 * that screen is about the tournament (standings, next level, prize pool) and
 * none of that exists at a cash table, which is most of the fleet. What the
 * two share is the thing that matters - the countdown is driven from an
 * ABSOLUTE end instant, so it keeps correct time through the two minutes when
 * there is no engine to ask.
 *
 * COPY RULES (CLAUDE.md 5.7 and 10.7). Every string here reaches a player, so
 * it is Title Case and contains no em dashes.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { serverNow } from '../../utils/serverClock';
import './MaintenanceBreakScreen.css';
import type { MaintenanceBreakState } from '../../hooks/useMaintenanceBreak';

export interface MaintenanceBreakScreenProps {
  isVisible: boolean;
  phase: MaintenanceBreakState['phase'];
  /** Absolute instant, epoch ms. Null while the last hand is still in play. */
  breakEndsAtMs: number | null;
  reason?: string;
}

function formatTime(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function MaintenanceBreakScreen({
  isVisible,
  phase,
  breakEndsAtMs,
  reason = 'Scheduled Engine Maintenance',
}: MaintenanceBreakScreenProps) {
  const [minimized, setMinimized] = useState(false);
  const countingDown = phase === 'counting_down' && !!breakEndsAtMs;
  const waitingLabel =
    phase === 'resuming'
      ? 'Resuming Tables'
      : phase === 'finalizing'
        ? 'Finalizing Maintenance'
        : 'Last Hand In Play';

  const read = useMemo(
    () => () => (breakEndsAtMs ? Math.max(0, Math.round((breakEndsAtMs - serverNow()) / 1000)) : 0),
    [breakEndsAtMs]
  );
  const [remaining, setRemaining] = useState(read);

  /**
   * Recompute from the wall clock every tick rather than decrementing.
   *
   * A local decrement loses every tick a throttled background tab does not
   * get, and this overlay is up precisely while the tab is most likely to be
   * in the background - the player has been told to go away for five minutes.
   * TournamentBreakScreen carries the same note for the same reason.
   */
  useEffect(() => {
    if (!isVisible || !countingDown) return;
    setRemaining(read());
    const timer = setInterval(() => setRemaining(read()), 1000);
    return () => clearInterval(timer);
  }, [isVisible, countingDown, read]);

  // Reset the collapsed state between breaks, so minimizing one break does not
  // silently hide the next one.
  useEffect(() => {
    if (!isVisible) setMinimized(false);
  }, [isVisible]);

  const progressPercent = useMemo(() => {
    if (!countingDown) return 100;
    const pct = (remaining / 300) * 100;
    return Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
  }, [countingDown, remaining]);

  if (!isVisible) return null;

  if (minimized) {
    return (
      <div
        className="maintenance-break__minimized"
        onClick={() => setMinimized(false)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setMinimized(false);
        }}
      >
        <span className="maintenance-break__mini-badge">
          {countingDown
            ? `Maintenance Break: ${formatTime(remaining)}`
            : `Maintenance Break: ${waitingLabel}`}
        </span>
      </div>
    );
  }

  return (
    <div
      className="maintenance-break"
      role="dialog"
      aria-modal="true"
      aria-labelledby="maintenance-break-title"
    >
      <div className="maintenance-break__overlay" aria-hidden="true" />
      <div className="maintenance-break__content">
        <button
          className="maintenance-break__close"
          onClick={() => setMinimized(true)}
          aria-label="Close Maintenance Break Screen"
        >
          X
        </button>

        <div className="maintenance-break__header">
          <span className="maintenance-break__badge">Scheduled Maintenance</span>
          <h1 id="maintenance-break-title" className="maintenance-break__title">
            {countingDown ? 'All Tables On Break' : waitingLabel}
          </h1>
        </div>

        <div className="maintenance-break__timer-container">
          <div className="maintenance-break__timer-ring">
            <svg viewBox="0 0 100 100">
              <circle className="maintenance-break__ring-bg" cx="50" cy="50" r="45" />
              <circle
                className="maintenance-break__ring-fill"
                cx="50"
                cy="50"
                r="45"
                strokeDasharray={`${progressPercent * 2.83} 283`}
              />
            </svg>
            <div className="maintenance-break__timer-text">
              <span className="maintenance-break__time">
                {countingDown
                  ? formatTime(remaining)
                  : phase === 'last_hand'
                    ? 'Last Hand'
                    : 'Please Wait'}
              </span>
              <span className="maintenance-break__time-label">
                {countingDown
                  ? 'Expected Resume Time'
                  : phase === 'last_hand'
                    ? 'The Break Starts When Every Table Finishes'
                    : 'Play Resumes When Your Table Is Ready'}
              </span>
            </div>
          </div>
          <div
            className="maintenance-break__progress-bar"
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        {/* The three things a player actually wants to know, in the order they
            worry about them. "Your Seat And Chips Are Safe" is first on
            purpose: the felt is about to go blank for two minutes, and without
            this line that reads as having been disconnected and busted. */}
        <ul className="maintenance-break__facts">
          <li>
            <span className="maintenance-break__fact-title">Your Seat And Chips Are Safe</span>
            <span className="maintenance-break__fact-body">
              Nothing Is Lost During The Break. Every Stack, Seat And Tournament Position Is Held
              Exactly As It Was.
            </span>
          </li>
          <li>
            <span className="maintenance-break__fact-title">No Hand Was Interrupted</span>
            <span className="maintenance-break__fact-body">
              Every Table Finished The Hand It Was On Before The Break Started.
            </span>
          </li>
          <li>
            <span className="maintenance-break__fact-title">The Table May Briefly Go Quiet</span>
            <span className="maintenance-break__fact-body">
              You Do Not Need To Reload. Play Resumes Automatically When Maintenance Is Complete.
            </span>
          </li>
        </ul>

        <p className="maintenance-break__reason">{reason}</p>
      </div>
    </div>
  );
}

export default MaintenanceBreakScreen;
