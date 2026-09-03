/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT BLIND STRUCTURE — Display Blind Levels
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React from 'react';
import { formatDuration as formatTime } from '@/lib/date';
import './BlindStructure.css';

interface BlindStructureProps {
  levels: BlindLevel[];
  currentLevel: number;
  timeRemaining?: number;
  isPaused?: boolean;
}

export interface BlindLevel {
  level: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  duration: number;
  isBreak?: boolean;
}

export function BlindStructure({
  levels,
  currentLevel,
  timeRemaining = 0,
  isPaused = false,
}: BlindStructureProps) {
  return (
    <div className="blind-structure">
      <div className="blind-structure__header">
        <h3> Blind Structure</h3>
        {currentLevel > 0 && (
          <div className={`time-remaining ${isPaused ? 'paused' : ''}`}>
            <span className="time">{formatTime(timeRemaining)}</span>
            {isPaused && <span className="paused-badge">PAUSED</span>}
          </div>
        )}
      </div>

      <div className="blind-structure__table">
        <div className="table-header">
          <span>Level</span>
          <span>Blinds</span>
          <span>Ante</span>
          <span>Time</span>
        </div>

        <div className="table-body">
          {levels.map((level, idx) => (
            <div
              key={level.level}
              className={`table-row ${
                level.level === currentLevel ? 'current' : ''
              } ${level.level < currentLevel ? 'past' : ''} ${level.isBreak ? 'break' : ''}`}
            >
              <span className="level">{level.isBreak ? '◇' : level.level}</span>
              <span className="blinds">
                {level.isBreak
                  ? 'Break'
                  : `${level.smallBlind.toLocaleString()}/${level.bigBlind.toLocaleString()}`}
              </span>
              <span className="ante">{level.isBreak ? '-' : level.ante.toLocaleString()}</span>
              <span className="duration">{level.duration}m</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default BlindStructure;
