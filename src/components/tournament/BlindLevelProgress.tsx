/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BLIND LEVEL PROGRESS — Live blind level tracking with progress and countdown
 * Shows current and upcoming blind levels with visual progress bar and timer
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useRef } from 'react';
import { formatDuration as formatTime } from '@/lib/date';
import './BlindLevelProgress.css';

export interface BlindLevel {
  level: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  duration: number; // minutes
  isBreak?: boolean;
}

interface BlindLevelProgressProps {
  levels: BlindLevel[];
  currentLevel: number;
  levelStartTime: string;
  isPaused?: boolean;
  onLevelChange?: (level: number) => void;
}

export const BlindLevelProgress: React.FC<BlindLevelProgressProps> = ({
  levels,
  currentLevel,
  levelStartTime,
  isPaused = false,
  onLevelChange,
}) => {
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [isUrgent, setIsUrgent] = useState(false);
  const [mounted, setMounted] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
    const _mountTimer = setTimeout(() => setMounted(true), 50);
    return () => clearTimeout(_mountTimer);
  }, []);

  const current = levels[currentLevel - 1];
  const next = levels[currentLevel];
  const prev = currentLevel > 1 ? levels[currentLevel - 2] : null;

  useEffect(() => {
    if (!current) return;

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
    if (amount >= 1000000) {
      return (amount / 1000000).toFixed(1) + 'M';
    }
    if (amount >= 1000) {
      return (amount / 1000).toFixed(1) + 'K';
    }
    return amount.toLocaleString();
  };

  const getBlindColor = (level: number) => {
    const totalLevels = levels.length;
    const progress = level / totalLevels;

    if (progress < 0.33) return 'early';
    if (progress < 0.67) return 'middle';
    return 'late';
  };

  const progressPercent = ((current.duration * 60 - timeRemaining) / (current.duration * 60)) * 100;

  if (!current) return null;

  return (
    <div
      className="blind-level-progress"
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(12px)',
        transition: 'all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        transitionDelay: '0.05s',
      }}
    >
      {/* Header */}
      <div className="blp-header">
        <div className="blp-title">
          <span className="blp-label">Current Level</span>
          {isPaused && <span className="blp-badge paused">PAUSED</span>}
        </div>
        <div className="blp-level-number">
          {current.isBreak ? '☕ BREAK' : `Level ${currentLevel}`}
        </div>
      </div>

      {/* Current Blinds */}
      <div className={`blp-blinds ${getBlindColor(currentLevel)}`}>
        <div className="blp-blind-item sb">
          <span className="blp-amount">{formatChips(current.smallBlind)}</span>
          <span className="blp-label">SB</span>
        </div>
        <div className="blp-divider">/</div>
        <div className="blp-blind-item bb">
          <span className="blp-amount">{formatChips(current.bigBlind)}</span>
          <span className="blp-label">BB</span>
        </div>
        {current.ante > 0 && (
          <>
            <div className="blp-divider">+</div>
            <div className="blp-blind-item ante">
              <span className="blp-amount">{formatChips(current.ante)}</span>
              <span className="blp-label">Ante</span>
            </div>
          </>
        )}
      </div>

      {/* Countdown Timer */}
      <div className={`blp-timer ${isUrgent ? 'urgent' : ''}`}>
        <span className="blp-time">{formatTime(timeRemaining)}</span>
        <span className="blp-timer-label">Time Remaining</span>
      </div>

      {/* Progress Bar */}
      <div className="blp-progress-bar">
        <div
          className={`blp-progress-fill ${getBlindColor(currentLevel)} ${isUrgent ? 'urgent' : ''}`}
          style={{ width: `${progressPercent}%` }}
        />
        <div className="blp-progress-marker" style={{ left: `${progressPercent}%` }} />
      </div>

      {/* Time Elapsed / Duration */}
      <div className="blp-time-info">
        <span className="blp-elapsed">
          {formatTime(current.duration * 60 - timeRemaining)} / {current.duration}m
        </span>
      </div>

      {/* Next Level Preview */}
      {next && (
        <div className="blp-next-level">
          <div className="blp-next-label">Up Next</div>
          <div className="blp-next-content">
            <div className="blp-next-level-num">
              {next.isBreak ? '☕' : `Level ${currentLevel + 1}`}
            </div>
            <div className="blp-next-blinds">
              {next.isBreak ? (
                <span>Break ({next.duration}m)</span>
              ) : (
                <>
                  <span>
                    {formatChips(next.smallBlind)}/{formatChips(next.bigBlind)}
                  </span>
                  {next.ante > 0 && (
                    <span className="blp-next-ante">+{formatChips(next.ante)}</span>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* All Blind Levels Scrollable List */}
      <div className="blp-all-levels">
        <div className="blp-all-levels-scroll">
          {levels.map((level, idx) => (
            <div
              key={level.level}
              className={`blp-level-item ${level.level === currentLevel ? 'current' : ''} ${level.level < currentLevel ? 'past' : ''} ${level.isBreak ? 'break' : ''} ${getBlindColor(level.level)}`}
            >
              <span className="blp-item-level">{level.isBreak ? '☕' : `L${level.level}`}</span>
              <span className="blp-item-blinds">
                {level.isBreak
                  ? 'Break'
                  : `${formatChips(level.smallBlind)}/${formatChips(level.bigBlind)}`}
              </span>
              {!level.isBreak && level.ante > 0 && (
                <span className="blp-item-ante">+{formatChips(level.ante)}</span>
              )}
              <span className="blp-item-time">{level.duration}m</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default BlindLevelProgress;
