/**
 * ♠ CLUB ARENA — Tournament Blind Timer
 * Displays current blinds, levels, and countdown
 */

import React, { useState, useEffect, useRef } from 'react';
import { formatDuration as formatTime } from '@/lib/date';
import './BlindTimer.css';

interface BlindLevel {
  level: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  duration: number; // minutes
  isBreak?: boolean; // Indicates if this is a break level
}

interface BlindTimerProps {
  levels: BlindLevel[];
  currentLevel: number;
  levelStartTime: string;
  isPaused?: boolean;
  onLevelChange?: (level: number) => void;
}

export const BlindTimer: React.FC<BlindTimerProps> = ({
  levels,
  currentLevel,
  levelStartTime,
  isPaused = false,
  onLevelChange,
}) => {
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [isUrgent, setIsUrgent] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [isBreak, setIsBreak] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
    const _mountTimer = setTimeout(() => setMounted(true), 50);
    return () => clearTimeout(_mountTimer);
  }, []);

  const current = levels[currentLevel - 1];

  // Find next non-break level for preview
  const findNextNonBreakLevel = (startIdx: number): BlindLevel | undefined => {
    for (let i = startIdx; i < levels.length; i++) {
      if (!levels[i]?.isBreak) {
        return levels[i];
      }
    }
    return undefined;
  };

  const next = findNextNonBreakLevel(currentLevel);

  useEffect(() => {
    if (!current) return;

    // Check if current level is a break
    setIsBreak(current.isBreak || false);

    const calculateRemaining = () => {
      const start = new Date(levelStartTime).getTime();
      const now = Date.now();
      const elapsed = Math.floor((now - start) / 1000);
      const remaining = current.duration * 60 - elapsed;
      return Math.max(0, remaining);
    };

    setTimeRemaining(calculateRemaining());

    if (!isPaused) {
      intervalRef.current = setInterval(() => {
        const remaining = calculateRemaining();
        setTimeRemaining(remaining);
        setIsUrgent(remaining <= 60);

        if (remaining <= 0) {
          onLevelChange?.(currentLevel + 1);
        }
      }, 1000);
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [currentLevel, levelStartTime, isPaused, current, onLevelChange]);

  const formatChips = (amount: number) => {
    return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  if (!current) return null;

  return (
    <div
      className={`blind-timer ${isUrgent ? 'urgent' : ''} ${isPaused ? 'paused' : ''} ${isBreak ? 'break' : ''}`}
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(8px)',
        transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        transitionDelay: '0.1s',
      }}
    >
      {/* Current Level */}
      <div className="timer-header">
        {isBreak ? (
          <>
            <span className="level-label break-label">☕ BREAK</span>
            {isPaused && <span className="paused-badge">PAUSED</span>}
          </>
        ) : (
          <>
            <span className="level-label">Level {currentLevel}</span>
            {isPaused && <span className="paused-badge">PAUSED</span>}
          </>
        )}
      </div>

      {/* Blinds Display or Break Message */}
      {!isBreak ? (
        <div className="blinds-display">
          <div className="blind-value">
            <span className="blind-amount">{formatChips(current.smallBlind)}</span>
            <span className="blind-label">SB</span>
          </div>
          <span className="blind-separator">/</span>
          <div className="blind-value">
            <span className="blind-amount">{formatChips(current.bigBlind)}</span>
            <span className="blind-label">BB</span>
          </div>
          {current.ante > 0 && (
            <>
              <span className="ante-separator">+</span>
              <div className="blind-value ante">
                <span className="blind-amount">{formatChips(current.ante)}</span>
                <span className="blind-label">Ante</span>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="blinds-display break-message">
          <span>Tournament on Break</span>
        </div>
      )}

      {/* Countdown */}
      <div className={`countdown ${isUrgent ? 'pulse' : ''}`}>
        <span className="time">{formatTime(timeRemaining)}</span>
      </div>

      {/* Next Level Preview */}
      {next && !isBreak && (
        <div className="next-level">
          <span className="next-label">Next:</span>
          <span className="next-blinds">
            {formatChips(next.smallBlind)}/{formatChips(next.bigBlind)}
            {next.ante > 0 && ` +${formatChips(next.ante)}`}
          </span>
        </div>
      )}

      {/* Progress Bar */}
      <div className="level-progress">
        <div
          className="progress-fill"
          style={{
            width: `${((current.duration * 60 - timeRemaining) / (current.duration * 60)) * 100}%`,
          }}
        />
      </div>
    </div>
  );
};

export default BlindTimer;
