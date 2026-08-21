import React, { useState, useEffect } from 'react';
import './CountdownTimer.css';

interface CountdownTimerProps {
  targetDate: Date;
  onComplete?: () => void;
  showDays?: boolean;
  size?: 'small' | 'medium' | 'large';
  label?: string;
}

interface TimeRemaining {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export const CountdownTimer: React.FC<CountdownTimerProps> = ({
  targetDate,
  onComplete,
  showDays = true,
  size = 'medium',
  label,
}) => {
  const [timeRemaining, setTimeRemaining] = useState<TimeRemaining>({
    days: 0,
    hours: 0,
    minutes: 0,
    seconds: 0,
  });
  const [isExpired, setIsExpired] = useState(false);

  useEffect(() => {
    const calculateTime = () => {
      const now = new Date().getTime();
      const target = targetDate.getTime();
      const diff = target - now;

      if (diff <= 0) {
        setIsExpired(true);
        onComplete?.();
        return;
      }

      setTimeRemaining({
        days: Math.floor(diff / 86400000),
        hours: Math.floor((diff % 86400000) / 3600000),
        minutes: Math.floor((diff % 3600000) / 60000),
        seconds: Math.floor((diff % 60000) / 1000),
      });
    };

    calculateTime();
    const interval = setInterval(calculateTime, 1000);
    return () => clearInterval(interval);
  }, [targetDate, onComplete]);

  if (isExpired) {
    return (
      <div className={`countdown-timer ${size} expired`}>
        <span className="expired-text">Event Ended</span>
      </div>
    );
  }

  return (
    <div className={`countdown-timer ${size}`}>
      {label && <span className="countdown-label">{label}</span>}

      <div className="countdown-blocks">
        {showDays && (
          <div className="time-block">
            <span className="time-value">{String(timeRemaining.days).padStart(2, '0')}</span>
            <span className="time-unit">Days</span>
          </div>
        )}
        <div className="time-block">
          <span className="time-value">{String(timeRemaining.hours).padStart(2, '0')}</span>
          <span className="time-unit">Hrs</span>
        </div>
        <div className="time-separator">:</div>
        <div className="time-block">
          <span className="time-value">{String(timeRemaining.minutes).padStart(2, '0')}</span>
          <span className="time-unit">Min</span>
        </div>
        <div className="time-separator">:</div>
        <div className="time-block">
          <span className="time-value">{String(timeRemaining.seconds).padStart(2, '0')}</span>
          <span className="time-unit">Sec</span>
        </div>
      </div>
    </div>
  );
};

export default CountdownTimer;
