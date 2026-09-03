import React, { useState, useEffect } from 'react';
import './Timer.css';

interface TimerProps {
  seconds: number;
  onComplete?: () => void;
  autoStart?: boolean;
  showLabel?: boolean;
}

export const Timer: React.FC<TimerProps> = ({
  seconds,
  onComplete,
  autoStart = true,
  showLabel = false,
}) => {
  const [remaining, setRemaining] = useState(seconds);
  const [isRunning, setIsRunning] = useState(autoStart);

  useEffect(() => {
    if (!isRunning || remaining <= 0) {
      if (remaining <= 0) onComplete?.();
      return;
    }

    const interval = setInterval(() => {
      setRemaining((prev) => prev - 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [isRunning, remaining, onComplete]);

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const progress = (remaining / seconds) * 100;

  return (
    <div className="timer">
      {showLabel && <div className="timer-label">Time Remaining</div>}
      <div className="timer-display">
        {mins}:{secs.toString().padStart(2, '0')}
      </div>
      <div className="timer-bar">
        <div className="timer-fill" style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
};

export default Timer;
