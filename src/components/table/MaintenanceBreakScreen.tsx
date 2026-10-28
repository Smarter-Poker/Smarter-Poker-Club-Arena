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
  /**
   * Controlled by the table (Dan 2026-10-14). A closed break no longer leaves a
   * pill floating under the hero: it becomes a line in the table masthead,
   * directly under the bomb pot clock, drawn by `MaintenanceBreakLine`.
   */
  minimized: boolean;
  onMinimize: () => void;
}

function formatTime(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function waitingLabelFor(phase: MaintenanceBreakState['phase']): string {
  return phase === 'resuming'
    ? 'Resuming Tables'
    : phase === 'finalizing'
      ? 'Finalizing Maintenance'
      : 'Last Hand In Play';
}

/** Seconds left on the break, read from the wall clock every second. */
function useBreakRemaining(active: boolean, breakEndsAtMs: number | null): number {
  const read = useMemo(
    () => () => (breakEndsAtMs ? Math.max(0, Math.round((breakEndsAtMs - serverNow()) / 1000)) : 0),
    [breakEndsAtMs]
  );
  const [remaining, setRemaining] = useState(read);
  useEffect(() => {
    if (!active) return;
    setRemaining(read());
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setRemaining(read());
    }, 1000);

    const onVisible = () => {
      if (!document.hidden) setRemaining(read());
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, read]);
  return remaining;
}

export interface MaintenanceBreakLineProps {
  phase: MaintenanceBreakState['phase'];
  breakEndsAtMs: number | null;
  onOpen: () => void;
}

/**
 * THE CLOSED BREAK, AS A MASTHEAD LINE (Dan 2026-10-14, with a screenshot of
 * the pill under KingFish): "THIS NEEDS TO APPEAR BELOW 'BOMB POT IN 2:47' NOT
 * UNDER THE HERO." It is a `.table-brand__line` like the bomb clock above it,
 * so it shares that column and type scale on every layout. Tapping it reopens
 * the full break card.
 */
export function MaintenanceBreakLine({ phase, breakEndsAtMs, onOpen }: MaintenanceBreakLineProps) {
  const countingDown = phase === 'counting_down' && !!breakEndsAtMs;
  const remaining = useBreakRemaining(countingDown, breakEndsAtMs);
  const text = countingDown
    ? `Maintenance Break: ${formatTime(remaining)}`
    : `Maintenance Break: ${waitingLabelFor(phase)}`;
  return (
    <span
      className="table-brand__line table-brand__line--bomb table-brand__line--maintenance"
      role="button"
      tabIndex={0}
      aria-live="polite"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpen();
      }}
    >
      <span className="table-brand__maintenance">{text}</span>
    </span>
  );
}

export function MaintenanceBreakScreen({
  isVisible,
  phase,
  breakEndsAtMs,
  reason = 'Scheduled Engine Maintenance',
  minimized,
  onMinimize,
}: MaintenanceBreakScreenProps) {
  const countingDown = phase === 'counting_down' && !!breakEndsAtMs;
  const waitingLabel = waitingLabelFor(phase);
  /* The countdown reads `breakEndsAtMs - serverNow()` every tick (one server clock). */
  const remaining = useBreakRemaining(isVisible && countingDown, breakEndsAtMs);

  const progressPercent = useMemo(() => {
    if (!countingDown) return 100;
    const pct = (remaining / 300) * 100;
    return Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
  }, [countingDown, remaining]);

  if (!isVisible) return null;

  /* Closed: the table masthead carries it (MaintenanceBreakLine). */
  if (minimized) return null;

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
          onClick={onMinimize}
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
