import React, { useState, useEffect } from 'react';
import { formatDuration as formatTime } from '@/lib/date';
import './Stopwatch.css';

interface StopwatchProps {
  autoStart?: boolean;
  onTick?: (elapsed: number) => void;
}

export const Stopwatch: React.FC<StopwatchProps> = ({ autoStart = false, onTick }) => {
  const [elapsed, setElapsed] = useState(0);
  const [isRunning, setIsRunning] = useState(autoStart);

  useEffect(() => {
    if (!isRunning) return;

    const interval = setInterval(() => {
      setElapsed((prev) => {
        const newVal = prev + 1;
        onTick?.(newVal);
        return newVal;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [isRunning, onTick]);

  return (
    <div className="stopwatch">
      <div className="stopwatch-display">{formatTime(elapsed)}</div>
      <div className="stopwatch-controls">
        <button
          onClick={() => setIsRunning(!isRunning)}
          aria-label={isRunning ? 'Pause Stopwatch' : 'Start Stopwatch'}
        >
          {isRunning ? '▮' : '▶'}
        </button>
        <button
          onClick={() => {
            setElapsed(0);
            setIsRunning(false);
          }}
          aria-label="Reset Stopwatch"
        >
          ↺
        </button>
      </div>
    </div>
  );
};

export default Stopwatch;
