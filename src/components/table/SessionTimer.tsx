/**
 * ♠ CLUB ARENA — Session Timer
 * Track session duration with break reminders
 */

import React, { useState, useEffect, useRef } from 'react';
import { formatDuration as formatTime } from '@/lib/date';
import './SessionTimer.css';

interface SessionTimerProps {
  startTime?: string;
  breakInterval?: number; // minutes
  onBreakSuggested?: () => void;
  showProfit?: boolean;
  profit?: number;
}

export const SessionTimer: React.FC<SessionTimerProps> = ({
  startTime = new Date().toISOString(),
  breakInterval = 60,
  onBreakSuggested,
  showProfit = false,
  profit = 0,
}) => {
  const [elapsed, setElapsed] = useState(0);
  const [showBreakReminder, setShowBreakReminder] = useState(false);
  const [breaksTaken, setBreaksTaken] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastBreakRef = useRef(0);

  useEffect(() => {
    const start = new Date(startTime).getTime();

    const updateElapsed = () => {
      const now = Date.now();
      const elapsedSec = Math.floor((now - start) / 1000);
      setElapsed(elapsedSec);

      // Check for break reminder (use functional update to avoid stale closure)
      const minutesSinceBreak = (elapsedSec - lastBreakRef.current) / 60;
      if (minutesSinceBreak >= breakInterval) {
        setShowBreakReminder((prev) => {
          if (!prev) {
            onBreakSuggested?.();
            return true;
          }
          return prev;
        });
      }
    };

    updateElapsed();
    intervalRef.current = setInterval(updateElapsed, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [startTime, breakInterval, onBreakSuggested]);

  const dismissBreak = () => {
    setShowBreakReminder(false);
    lastBreakRef.current = elapsed;
    setBreaksTaken((prev) => prev + 1);
  };

  const getSessionStatus = () => {
    const hours = elapsed / 3600;
    if (hours >= 4) return { label: 'Long Session', color: 'var(--accent-red)' };
    if (hours >= 2) return { label: 'Extended', color: 'var(--accent-gold)' };
    if (hours >= 1) return { label: 'Active', color: 'var(--accent-green)' };
    return { label: 'Fresh', color: 'var(--fb-blue)' };
  };

  const status = getSessionStatus();

  return (
    <div className="session-timer">
      <div className="timer-display">
        <span className="timer-icon" aria-hidden>
          T
        </span>
        <span className="timer-value">{formatTime(elapsed)}</span>
        <span className="session-status" style={{ background: status.color }}>
          {status.label}
        </span>
      </div>

      {showProfit && (
        <div className="session-profit">
          <span className="profit-label">Session:</span>
          <span className={`profit-value ${profit >= 0 ? 'positive' : 'negative'}`}>
            {profit >= 0 ? '+' : ''}
            {profit.toLocaleString()}
          </span>
        </div>
      )}

      {/* Break Reminder */}
      {showBreakReminder && (
        <div className="break-reminder">
          <div className="reminder-content">
            <span className="reminder-icon">◇</span>
            <div className="reminder-text">
              <strong>Time For A Break!</strong>
              <p>You've Been Playing For Over {breakInterval} Minutes</p>
            </div>
          </div>
          <div className="reminder-actions">
            <button className="snooze-btn" onClick={dismissBreak}>
              Snooze 30Min
            </button>
            <button className="take-btn" onClick={dismissBreak}>
              Take Break
            </button>
          </div>
        </div>
      )}

      {breaksTaken > 0 && (
        <div className="breaks-count">
          {breaksTaken} Break{breaksTaken > 1 ? 's' : ''} Taken
        </div>
      )}
    </div>
  );
};

export default SessionTimer;
