/**
 * ♠ CLUB ARENA — Session Replay
 * Review completed sessions with timeline scrubbing
 */

import React, { useState, useEffect, useRef } from 'react';
import { formatDuration } from '@/lib/date';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import './SessionReplay.css';
import { reportError } from '../../utils/errorReporter';

interface ReplayAction {
  timestamp: number;
  type: 'deal' | 'bet' | 'fold' | 'call' | 'raise' | 'check' | 'showdown' | 'win';
  player?: string;
  amount?: number;
  cards?: string[];
}

interface ReplayData {
  sessionId: string;
  tableName: string;
  stakes: string;
  startTime: string;
  endTime: string;
  handsPlayed: number;
  totalProfit: number;
  actions: ReplayAction[];
}

interface SessionReplayProps {
  sessionId: string;
  onClose?: () => void;
}

export const SessionReplay: React.FC<SessionReplayProps> = ({ sessionId, onClose }) => {
  const isMounted = useIsMounted();
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [replay, setReplay] = useState<ReplayData | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [loading, setLoading] = useState(true);
  const [visibleStats, setVisibleStats] = useState<boolean[]>([]);
  const [visibleActions, setVisibleActions] = useState<boolean[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    loadSession();
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [sessionId]);

  useEffect(() => {
    if (replay) {
      staggerTimersRef.current.forEach(clearTimeout);
      staggerTimersRef.current = [];
      setVisibleStats([]);
      staggerTimersRef.current.push(
        ...[0, 1, 2, 3].map((i) =>
          setTimeout(() => setVisibleStats((prev) => [...prev, true]), i * 60)
        )
      );
      setVisibleActions([]);
      staggerTimersRef.current.push(
        ...replay.actions
          .slice(0, 20)
          .map((_: any, i: number) =>
            setTimeout(() => setVisibleActions((prev) => [...prev, true]), i * 40)
          )
      );
    }
  }, [replay]);

  const loadSession = async () => {
    try {
      // Replaced seeded test data with null (session not found locally)
      setReplay(null);
    } catch (error) {
      reportError(error, 'SessionReplay.Failed_to_load_session');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  };

  const generateMockActions = (): ReplayAction[] => {
    const actions: ReplayAction[] = [];
    let time = 0;
    for (let i = 0; i < 50; i++) {
      const types: ReplayAction['type'][] = [
        'deal',
        'bet',
        'fold',
        'call',
        'raise',
        'check',
        'showdown',
        'win',
      ];
      actions.push({
        timestamp: time,
        type: types[Math.floor(Math.random() * types.length)],
        player: `Player${Math.floor(Math.random() * 6) + 1}`,
        amount: Math.floor(Math.random() * 500),
      });
      time += Math.floor(Math.random() * 5000) + 1000;
    }
    return actions;
  };

  const togglePlay = () => {
    if (isPlaying) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setIsPlaying(false);
    } else {
      setIsPlaying(true);
      intervalRef.current = setInterval(() => {
        setCurrentTime((prev) => {
          const maxTime = replay?.actions[replay.actions.length - 1]?.timestamp || 0;
          if (prev >= maxTime) {
            if (intervalRef.current) clearInterval(intervalRef.current);
            setIsPlaying(false);
            return prev;
          }
          return prev + 100 * playbackSpeed;
        });
      }, 100);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value, 10);
    setCurrentTime(value);
    if (isPlaying) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setIsPlaying(false);
    }
  };

  const skipTo = (direction: 'prev' | 'next') => {
    if (!replay) return;
    const currentIndex = replay.actions.findIndex((a) => a.timestamp >= currentTime);
    const newIndex =
      direction === 'next'
        ? Math.min(currentIndex + 1, replay.actions.length - 1)
        : Math.max(currentIndex - 1, 0);
    setCurrentTime(replay.actions[newIndex]?.timestamp || 0);
  };

  const formatTime = (ms: number) => formatDuration(Math.floor(ms / 1000));

  const currentAction = replay?.actions.find((a) => a.timestamp >= currentTime);
  const maxTime = replay?.actions[replay.actions.length - 1]?.timestamp || 0;

  if (loading) {
    return (
      <div className="session-replay loading">
        <div className="spinner" />
        <p>Loading Session...</p>
      </div>
    );
  }

  if (!replay) {
    return (
      <div className="session-replay error">
        <h2>Session Not Found</h2>
        <button onClick={onClose}>Close</button>
      </div>
    );
  }

  return (
    <div className="session-replay">
      {/* Header */}
      <div className="replay-header">
        <div className="session-info">
          <h2> {replay.tableName}</h2>
          <span className="stakes">{replay.stakes}</span>
        </div>
        <button className="close-btn" onClick={onClose}>
          ✕
        </button>
      </div>

      {/* Stats */}
      <div className="replay-stats">
        {[
          { value: replay.handsPlayed, label: 'Hands' },
          {
            value: `${replay.totalProfit >= 0 ? '+' : ''}${replay.totalProfit}`,
            label: 'Profit',
            color: replay.totalProfit >= 0 ? 'positive' : 'negative',
          },
          { value: '1h 02m', label: 'Duration' },
        ].map((stat, idx) => (
          <div
            key={idx}
            className="stat"
            style={{
              opacity: visibleStats[idx] ? 1 : 0,
              transform: visibleStats[idx] ? 'translateY(0)' : 'translateY(8px)',
              transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            <span className={`stat-value ${stat.color || ''}`}>{stat.value}</span>
            <span className="stat-label">{stat.label}</span>
          </div>
        ))}
      </div>

      {/* Playback Area */}
      <div className="playback-area">
        <div className="current-action">
          {currentAction ? (
            <>
              <span className="action-type">{currentAction.type.toUpperCase()}</span>
              {currentAction.player && (
                <span className="action-player">{currentAction.player}</span>
              )}
              {currentAction.amount && (
                <span className="action-amount">{currentAction.amount}</span>
              )}
            </>
          ) : (
            <span className="action-type">Session Start</span>
          )}
        </div>
      </div>

      {/* Timeline */}
      <div className="timeline-section">
        <input
          type="range"
          className="timeline-slider"
          min={0}
          max={maxTime}
          value={currentTime}
          onChange={handleSeek}
        />
        <div className="timeline-labels">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(maxTime)}</span>
        </div>
      </div>

      {/* Controls */}
      <div className="playback-controls">
        <button className="control-btn" onClick={() => skipTo('prev')}>
          ⏮
        </button>
        <button className="control-btn play" onClick={togglePlay}>
          {isPlaying ? '▮' : '▶'}
        </button>
        <button className="control-btn" onClick={() => skipTo('next')}>
          ⏭
        </button>
        <div className="speed-selector">
          {[0.5, 1, 2, 4].map((speed) => (
            <button
              key={speed}
              className={`speed-btn ${playbackSpeed === speed ? 'active' : ''}`}
              onClick={() => setPlaybackSpeed(speed)}
            >
              {speed}x
            </button>
          ))}
        </div>
      </div>

      {/* Action List */}
      <div className="action-list">
        <h4>Action Log</h4>
        <div className="actions-scroll">
          {replay.actions.slice(0, 20).map((action, i) => (
            <div
              key={i}
              className={`action-item ${action.timestamp <= currentTime ? 'passed' : ''}`}
              onClick={() => setCurrentTime(action.timestamp)}
              style={{
                opacity: visibleActions[i] ? 1 : 0,
                transform: visibleActions[i] ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <span className="action-time">{formatTime(action.timestamp)}</span>
              <span className="action-desc">
                {action.player} {action.type}s {action.amount && `${action.amount}`}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default SessionReplay;
