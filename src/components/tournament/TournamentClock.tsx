/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT CLOCK — Full-Screen Projector-Ready Display
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Shows real-time tournament clock with:
 * - Current blind level SB/BB/ante
 * - Countdown timer to next level (MM:SS)
 * - Next level preview
 * - Players remaining, avg stack, total chips
 * - Break mode with countdown
 * - Sound alerts on level change
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { formatDuration as formatTime } from '@/lib/date';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { tournamentTimerService } from '../../services/TournamentTimerService';
import { tournamentService } from '../../services/TournamentService';
import './TournamentClock.css';
import { reportError } from '../../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface TournamentClockProps {
  tournamentId: string;
  /** Compact mode for embedding in tournament detail pages */
  compact?: boolean;
  /** Full-screen projector mode */
  fullscreen?: boolean;
}

interface ClockState {
  currentLevel: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  nextSmallBlind: number;
  nextBigBlind: number;
  nextAnte: number;
  timeRemaining: number;
  isBreak: boolean;
  breakTimeRemaining: number;
  playersRemaining: number;
  averageStack: number;
  totalChips: number;
  tournamentName: string;
  isPaused: boolean;
  breakStartTime?: number; // Track when break started for countdown
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export const TournamentClock: React.FC<TournamentClockProps> = ({
  tournamentId,
  compact = false,
  fullscreen = false,
}) => {
  const [clock, setClock] = useState<ClockState>({
    currentLevel: 1,
    smallBlind: 25,
    bigBlind: 50,
    ante: 0,
    nextSmallBlind: 50,
    nextBigBlind: 100,
    nextAnte: 0,
    timeRemaining: 900,
    isBreak: false,
    breakTimeRemaining: 0,
    playersRemaining: 0,
    averageStack: 0,
    totalChips: 0,
    tournamentName: '',
    isPaused: false,
    breakStartTime: undefined,
  });

  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshPendingRef = useRef(false); // guard against multiple 0-hit refreshes
  const [isFullscreen, setIsFullscreen] = useState(fullscreen);

  // ── Load tournament data and start clock tick ──
  const refreshState = useCallback(async () => {
    try {
      const tournament = await tournamentService.getTournament(tournamentId);
      if (!tournament) return;

      const levelState = tournamentService.getCurrentLevelState(tournament);
      const timerState = tournamentTimerService.getTimerState(tournamentId);

      // Calculate stats
      const playersRemaining = tournament.current_players || 0;
      const totalChips = (tournament.starting_chips || 0) * playersRemaining;
      const averageStack = playersRemaining > 0 ? Math.round(totalChips / playersRemaining) : 0;

      setClock({
        currentLevel: levelState.levelIndex + 1,
        smallBlind: levelState.currentLevel.smallBlind,
        bigBlind: levelState.currentLevel.bigBlind,
        ante: levelState.currentLevel.ante,
        nextSmallBlind: levelState.nextLevel?.smallBlind || 0,
        nextBigBlind: levelState.nextLevel?.bigBlind || 0,
        nextAnte: levelState.nextLevel?.ante || 0,
        timeRemaining: levelState.timeRemainingSeconds,
        isBreak: false, // Will be updated via BREAK_START event
        breakTimeRemaining: 0,
        playersRemaining,
        averageStack,
        totalChips,
        tournamentName: tournament.name || 'Tournament',
        isPaused: timerState?.isPaused || false,
        breakStartTime: undefined,
      });
    } catch (err) {
      reportError(err, 'TournamentClock.Refresh_error');
    }
  }, [tournamentId]);

  // ── Client-side countdown tick ──
  useEffect(() => {
    refreshState();

    // Tick every second for smooth countdown
    tickRef.current = setInterval(() => {
      setClock((prev) => {
        // Update break countdown if in a break
        if (prev.isBreak && prev.breakStartTime) {
          const elapsed = (Date.now() - prev.breakStartTime) / 1000;
          const breakDuration = 300; // 5 minutes default
          const remaining = Math.max(0, breakDuration - elapsed);
          return {
            ...prev,
            breakTimeRemaining: Math.floor(remaining),
          };
        }
        // Normal level countdown
        const next = Math.max(0, prev.timeRemaining - 1);
        // When countdown hits 0, trigger an immediate DB refresh to advance level
        if (next === 0 && prev.timeRemaining > 0 && !refreshPendingRef.current) {
          refreshPendingRef.current = true;
          // Small delay to let the server state settle (blind check is 30s granularity)
          setTimeout(() => {
            refreshState();
            refreshPendingRef.current = false;
          }, 1500);
        }
        return {
          ...prev,
          timeRemaining: next,
        };
      });
    }, 1000);

    // Full refresh from DB every 30s
    const refreshInterval = setInterval(refreshState, 30_000);

    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      clearInterval(refreshInterval);
    };
  }, [refreshState]);

  // ── Listen for tournament update bus events ──
  useMasterBusSubscription('TOURNAMENT_UPDATED', (payload: any) => {
    if (payload?.tournamentId === tournamentId) {
      refreshState();
    }
  });
  // Instant blind-level update (no DB round-trip latency)
  useMasterBusSubscription('BLIND_LEVEL_CHANGE', (payload: any) => {
    if (payload?.tournamentId === tournamentId) {
      setClock((prev) => ({
        ...prev,
        currentLevel: payload.level,
        smallBlind: payload.smallBlind,
        bigBlind: payload.bigBlind,
        ante: payload.ante,
        isBreak: false, // Clear break status on new level
        breakTimeRemaining: 0,
        breakStartTime: undefined,
      }));
      // Also do a full refresh to get timeRemaining for the new level
      refreshState();
    }
  });
  // Listen for break start/end events (handle both event name variants)
  // TournamentEngine emits TOURNAMENT_BREAK / TOURNAMENT_BREAK_END
  // TournamentTimerService emits BREAK_START / BREAK_END
  const handleBreakStart = useCallback(
    (payload: any) => {
      if (payload?.tournamentId === tournamentId) {
        setClock((prev) => ({
          ...prev,
          isBreak: true,
          breakTimeRemaining: payload.durationMinutes ? payload.durationMinutes * 60 : 300,
          breakStartTime: Date.now(),
        }));
      }
    },
    [tournamentId]
  );
  const handleBreakEnd = useCallback(
    (payload: any) => {
      if (payload?.tournamentId === tournamentId) {
        setClock((prev) => ({
          ...prev,
          isBreak: false,
          breakTimeRemaining: 0,
          breakStartTime: undefined,
        }));
        refreshState();
      }
    },
    [tournamentId, refreshState]
  );
  useMasterBusSubscription('TOURNAMENT_BREAK', handleBreakStart);
  useMasterBusSubscription('BREAK_START', handleBreakStart);
  useMasterBusSubscription('TOURNAMENT_BREAK_END', handleBreakEnd);
  useMasterBusSubscription('BREAK_END', handleBreakEnd);

  // ── Format chip count with K/M abbreviations ──
  const formatChips = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 10_000) return `${(n / 1000).toFixed(0)}K`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toString();
  };

  // ── Timer urgency class ──
  const timerClass =
    clock.timeRemaining <= 30
      ? 'tc-timer--danger'
      : clock.timeRemaining <= 120
        ? 'tc-timer--warning'
        : '';

  const wrapperClass = [
    'tournament-clock',
    compact ? 'tc--compact' : '',
    isFullscreen ? 'tc--fullscreen' : '',
    clock.isBreak ? 'tc--break' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={wrapperClass}>
      {/* ── Header ── */}
      <div className="tc-header">
        <h2 className="tc-name">{clock.tournamentName}</h2>
        {!compact && (
          <button
            className="tc-fullscreen-btn"
            onClick={() => setIsFullscreen(!isFullscreen)}
            title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          >
            {isFullscreen ? '⊟' : '⊞'}
          </button>
        )}
      </div>

      {/* ── Break Mode ── */}
      {clock.isBreak && (
        <div className="tc-break-overlay">
          <span className="tc-break-icon">☕</span>
          <span className="tc-break-text">BREAK</span>
          {clock.breakTimeRemaining > 0 && (
            <span className="tc-break-timer">{formatTime(clock.breakTimeRemaining)}</span>
          )}
        </div>
      )}

      {/* ── Main Clock Display ── */}
      {!clock.isBreak && (
        <>
          <div className="tc-level-badge">LEVEL {clock.currentLevel}</div>

          <div className="tc-blinds">
            <div className="tc-blind-group">
              <span className="tc-blind-label">SB</span>
              <span className="tc-blind-value">{formatChips(clock.smallBlind)}</span>
            </div>
            <span className="tc-blind-separator">/</span>
            <div className="tc-blind-group">
              <span className="tc-blind-label">BB</span>
              <span className="tc-blind-value">{formatChips(clock.bigBlind)}</span>
            </div>
            {clock.ante > 0 && (
              <>
                <span className="tc-blind-separator">+</span>
                <div className="tc-blind-group">
                  <span className="tc-blind-label">ANTE</span>
                  <span className="tc-blind-value tc-ante-value">{formatChips(clock.ante)}</span>
                </div>
              </>
            )}
          </div>

          {/* ── Countdown Timer ── */}
          <div className={`tc-timer ${timerClass}`}>
            <span className="tc-timer-value">{formatTime(clock.timeRemaining)}</span>
          </div>

          {/* ── Next Level Preview ── */}
          {clock.nextSmallBlind > 0 && (
            <div className="tc-next-level">
              <span className="tc-next-label">NEXT</span>
              <span className="tc-next-blinds">
                {formatChips(clock.nextSmallBlind)}/{formatChips(clock.nextBigBlind)}
                {clock.nextAnte > 0 && ` +${formatChips(clock.nextAnte)}`}
              </span>
            </div>
          )}
        </>
      )}

      {/* ── Stats Footer ── */}
      {!compact && (
        <div className="tc-stats">
          <div className="tc-stat">
            <span className="tc-stat-icon">👥</span>
            <span className="tc-stat-value">{clock.playersRemaining}</span>
            <span className="tc-stat-label">Players</span>
          </div>
          <div className="tc-stat">
            <span className="tc-stat-icon">📊</span>
            <span className="tc-stat-value">{formatChips(clock.averageStack)}</span>
            <span className="tc-stat-label">Avg Stack</span>
          </div>
          <div className="tc-stat">
            <span className="tc-stat-icon">🏦</span>
            <span className="tc-stat-value">{formatChips(clock.totalChips)}</span>
            <span className="tc-stat-label">Total Chips</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default TournamentClock;
