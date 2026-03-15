import React, { useState, useEffect } from 'react';
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

  const formatTime = (secs: number) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return `${h > 0 ? h + ':' : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="stopwatch">
      <div className="stopwatch-display">{formatTime(elapsed)}</div>
      <div className="stopwatch-controls">
        <button
          onClick={() => setIsRunning(!isRunning)}
          aria-label={isRunning ? 'Pause stopwatch' : 'Start stopwatch'}
        >
          {isRunning ? '⏸' : '▶'}
        </button>
        <button
          onClick={() => {
            setElapsed(0);
            setIsRunning(false);
          }}
          aria-label="Reset stopwatch"
        >
          ↺
        </button>
      </div>
    </div>
  );
};

export default Stopwatch;
