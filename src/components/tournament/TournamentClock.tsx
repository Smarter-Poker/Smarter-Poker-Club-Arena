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
import { tournamentTimerService } from '../../services/TournamentTimerService';
import { tournamentService } from '../../services/TournamentService';
import { masterBus } from '../../core/MasterBus';
import './TournamentClock.css';

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
  });

  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
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
        isBreak: timerState?.isPaused || false,
        breakTimeRemaining: 0,
        playersRemaining,
        averageStack,
        totalChips,
        tournamentName: tournament.name || 'Tournament',
        isPaused: timerState?.isPaused || false,
      });
    } catch (err) {
      console.error('[TournamentClock] Refresh error:', err);
    }
  }, [tournamentId]);

  // ── Client-side countdown tick ──
  useEffect(() => {
    refreshState();

    // Tick every second for smooth countdown
    tickRef.current = setInterval(() => {
      setClock((prev) => ({
        ...prev,
        timeRemaining: Math.max(0, prev.timeRemaining - 1),
      }));
    }, 1000);

    // Full refresh from DB every 30s
    const refreshInterval = setInterval(refreshState, 30_000);

    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      clearInterval(refreshInterval);
    };
  }, [refreshState]);

  // ── Listen for tournament update bus events ──
  useEffect(() => {
    const unsubTournament = masterBus.subscribe('TOURNAMENT_UPDATED', (event: any) => {
      if (event?.payload?.tournamentId === tournamentId) {
        refreshState();
      }
    });
    // Instant blind-level update (no DB round-trip latency)
    const unsubBlinds = masterBus.subscribe('BLIND_LEVEL_CHANGE', (event: any) => {
      const data = event?.payload;
      if (data?.tournamentId === tournamentId) {
        setClock((prev) => ({
          ...prev,
          currentLevel: data.level,
          smallBlind: data.smallBlind,
          bigBlind: data.bigBlind,
          ante: data.ante,
        }));
      }
    });
    return () => {
      if (typeof unsubTournament === 'function') unsubTournament();
      if (typeof unsubBlinds === 'function') unsubBlinds();
    };
  }, [tournamentId, refreshState]);

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
