/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ⏸️ TOURNAMENT BREAK SCREEN — Break Timer Overlay
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Full-screen overlay during tournament breaks:
 * - Countdown timer
 * - Current standings
 * - Badge level info
 * - Average stack display
 */

import React, { useState, useEffect, useMemo } from 'react';
import { serverNow } from '../../utils/serverClock';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import './TournamentBreakScreen.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TournamentPlayer {
  playerId: string;
  playerName: string;
  avatar?: string;
  stack: number;
  rank: number;
  isCurrentUser?: boolean;
}

export interface BlindLevel {
  level: number;
  smallBlind: number;
  bigBlind: number;
  ante?: number;
  /**
   * OPTIONAL since 2026-08-27. The server's break payload has never carried
   * it (pauseForBreak broadcasts smallBlind, bigBlind and ante only), so
   * declaring it required did not make it present — it just meant the
   * component divided by `undefined` and rendered NaN into the progress ring
   * and the bar width on every single break. Nothing in this screen reads it
   * any more; the break's own length drives the progress.
   */
  duration?: number; // minutes
}

export interface TournamentBreakScreenProps {
  isVisible: boolean;
  breakTimeRemaining: number; // seconds
  /**
   * THE BREAK HAS TWO PHASES AND THE SCREEN MUST SAY WHICH (2026-08-27).
   *
   * At :55 the server announces the LAST HAND. The five minutes do not start
   * until every table across every tournament has finished it, which is why a
   * break runs a little over five minutes end to end. The server deliberately
   * writes `break_ends_at` as NULL for that window.
   *
   * This screen used to be handed a flat 300 seconds at :55 and count it down
   * locally, so it hit 0:00 up to two minutes BEFORE play resumed and then sat
   * frozen at 0:00 under a full-screen opaque overlay. 'last_hand' renders the
   * honest thing instead: the break has started, the clock has not.
   */
  phase?: 'last_hand' | 'counting_down';
  /**
   * Absolute end of the break, epoch ms, once the countdown has actually
   * started. Preferred over breakTimeRemaining when present: an absolute
   * instant survives a backgrounded tab, a slow render and a missed tick,
   * where a local decrement silently drifts.
   */
  breakEndsAtMs?: number | null;
  tournamentName: string;
  /**
   * THE SCREEN READS ITS OWN FACTS (final sweep 2026-09-08). TableModalsLayer
   * used to hand this `currentLevel={0}`, `topPlayers={[]}`, `prizePool={0}`
   * and no `myPlayer`, so every break announced "Coming Next: Level 1", a
   * prize pool of 0, an empty leader board and no hero line - on every
   * tournament, all the way to the final table. Given the tournament id the
   * screen reads the level, the pool, the field and the top stacks from the
   * same rows the HUD and the info panel read, once when it opens. Every prop
   * below stays as an override for a caller that already knows better.
   */
  tournamentId?: string | null;
  /** The hero, to mark their line in the leaders and fill "Your Status". */
  heroUserId?: string | null;
  /** 0-based array index, as `tournaments.current_level` is stored. */
  currentLevel?: number;
  nextLevel: BlindLevel;
  playersRemaining?: number;
  totalPlayers?: number;
  averageStack?: number;
  topPlayers?: TournamentPlayer[];
  myPlayer?: TournamentPlayer;
  prizePool?: number;
  currency?: string;
  onDismiss?: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// EXACT precision — no abbreviations, no rounding
function formatStack(amount: number): string {
  // Tournament chips are integers; only show decimals if sub-chip precision exists
  const truncated = Math.trunc(amount * 100) / 100;
  if (truncated === Math.trunc(truncated)) {
    return Math.trunc(truncated).toLocaleString('en-US');
  }
  return truncated.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function TournamentBreakScreen({
  isVisible,
  breakTimeRemaining,
  phase = 'counting_down',
  breakEndsAtMs = null,
  tournamentName,
  tournamentId = null,
  heroUserId = null,
  currentLevel: currentLevelProp,
  nextLevel,
  playersRemaining: playersRemainingProp,
  totalPlayers: totalPlayersProp,
  averageStack: averageStackProp,
  topPlayers: topPlayersProp,
  myPlayer: myPlayerProp,
  prizePool: prizePoolProp,
  currency = '',
  onDismiss,
}: TournamentBreakScreenProps) {
  const [minimized, setMinimized] = useState(false);

  /* What the rows say, read when the screen opens for a tournament. */
  const [facts, setFacts] = useState<{
    currentLevel: number;
    prizePool: number;
    playersRemaining: number;
    totalPlayers: number;
    averageStack: number;
    topPlayers: TournamentPlayer[];
    myPlayer?: TournamentPlayer;
  } | null>(null);
  useEffect(() => {
    if (!isVisible || !tournamentId) return;
    let mounted = true;
    (async () => {
      try {
        const [tRes, pRes] = await Promise.all([
          supabase
            .from('tournaments')
            .select('current_level, prize_pool, current_players, max_players')
            .eq('id', tournamentId)
            .maybeSingle(),
          supabase
            .from('tournament_players')
            .select('user_id, username, chips, status')
            .eq('tournament_id', tournamentId)
            .in('status', ['playing', 'registered'])
            .limit(500),
        ]);
        if (!mounted) return;
        if (tRes.error || pRes.error) {
          reportError(tRes.error ?? pRes.error, 'TournamentBreakScreen.load', { tournamentId });
          return;
        }
        const t = (tRes.data ?? {}) as {
          current_level?: number | null;
          prize_pool?: number | string | null;
          current_players?: number | null;
          max_players?: number | null;
        };
        const active = (
          (pRes.data ?? []) as Array<{
            user_id?: string;
            username?: string | null;
            chips?: number | null;
          }>
        ).map((r) => ({
          playerId: String(r.user_id ?? ''),
          playerName: String(r.username ?? 'Player'),
          stack: Number(r.chips) || 0,
        }));
        const sorted = [...active].sort((a, b) => b.stack - a.stack);
        /* Rank = 1 + players with strictly more chips; ties share the better
           rank, as every tournament lobby counts it. */
        const ranked: TournamentPlayer[] = sorted.map((r) => ({
          ...r,
          rank: 1 + sorted.filter((o) => o.stack > r.stack).length,
          isCurrentUser: !!heroUserId && r.playerId === heroUserId,
        }));
        const totalChips = active.reduce((sum, r) => sum + r.stack, 0);
        setFacts({
          currentLevel: Math.max(0, Number(t.current_level) || 0),
          prizePool: Number(t.prize_pool) || 0,
          playersRemaining: active.length,
          totalPlayers: Math.max(Number(t.current_players) || 0, active.length),
          averageStack: active.length ? Math.trunc(totalChips / active.length) : 0,
          topPlayers: ranked.slice(0, 5),
          myPlayer: ranked.find((r) => r.isCurrentUser),
        });
      } catch (err) {
        if (mounted) reportError(err, 'TournamentBreakScreen.load', { tournamentId });
      }
    })();
    return () => {
      mounted = false;
    };
  }, [isVisible, tournamentId, heroUserId]);

  const currentLevel = currentLevelProp ?? facts?.currentLevel ?? 0;
  const playersRemaining = playersRemainingProp ?? facts?.playersRemaining ?? 0;
  const totalPlayers = totalPlayersProp ?? facts?.totalPlayers ?? playersRemaining;
  const averageStack = averageStackProp ?? facts?.averageStack ?? 0;
  const topPlayers = topPlayersProp ?? facts?.topPlayers ?? [];
  const myPlayer = myPlayerProp ?? facts?.myPlayer;
  const prizePool = prizePoolProp ?? facts?.prizePool ?? 0;
  const countingDown = phase === 'counting_down';
  const [displayTime, setDisplayTime] = useState(() =>
    breakEndsAtMs
      ? Math.max(0, Math.round((breakEndsAtMs - serverNow()) / 1000))
      : breakTimeRemaining
  );

  /**
   * Tick against the wall clock, not by subtracting one.
   *
   * The old loop decremented local state and re-armed itself on every change
   * of `displayTime`, which meant a tab throttled in the background, a slow
   * render or a single missed tick was lost time that was never given back.
   * Worse, it self-terminated at `displayTime <= 0` and never restarted, so
   * once it reached zero the screen was frozen there for good. When the real
   * end time is known the remaining seconds are recomputed from it every tick,
   * so the display cannot drift and re-seeding is automatic.
   */
  useEffect(() => {
    if (!isVisible || !countingDown) {
      if (!countingDown) setDisplayTime(0);
      return;
    }
    const read = () =>
      breakEndsAtMs
        ? Math.max(0, Math.round((breakEndsAtMs - serverNow()) / 1000))
        : Math.max(0, breakTimeRemaining);
    setDisplayTime(read());
    // Without an absolute end time all we can do is count the seeded value
    // down, but the seed is re-sent when the countdown truly starts.
    let fallback = read();
    const timer = setInterval(() => {
      if (breakEndsAtMs) {
        setDisplayTime(read());
      } else {
        fallback = Math.max(0, fallback - 1);
        setDisplayTime(fallback);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [isVisible, countingDown, breakEndsAtMs, breakTimeRemaining]);

  /**
   * The ring and the bar are a fraction of THIS BREAK, not of the next blind
   * level.
   *
   * They used to divide by `nextLevel.duration`, a field the server has never
   * once sent on a break payload (pauseForBreak broadcasts only smallBlind,
   * bigBlind and ante). `undefined * 60` is NaN, so this rendered
   * `strokeDasharray="NaN 283"` and `width: NaN%` on every break, and the
   * timer colour fell to the "urgent" red for the whole five minutes because
   * every comparison against NaN is false. The fallback object supplied by
   * TableModalsLayer used `duration: 0`, which is NaN by a second route.
   */
  const breakTotalSeconds = useMemo(() => {
    const seeded = Math.max(0, Math.round(breakTimeRemaining));
    return seeded > 0 ? seeded : 300;
  }, [breakTimeRemaining]);

  const progressPercent = useMemo(() => {
    if (!countingDown) return 100;
    const pct = (displayTime / breakTotalSeconds) * 100;
    return Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
  }, [countingDown, displayTime, breakTotalSeconds]);

  // Calculate timer color based on remaining time
  const getTimerColor = () => {
    if (!countingDown) return '#3b82f6';
    if (progressPercent > 50) return '#3b82f6';
    if (progressPercent > 25) return '#f59e0b';
    return '#ef4444';
  };

  if (!isVisible) return null;

  // Minimized view — small floating badge showing time remaining
  if (minimized) {
    return (
      <div className="break-screen__minimized" onClick={() => setMinimized(false)}>
        <span className="break-screen__mini-badge">
          {countingDown ? ` Break: ${formatTime(displayTime)}` : ' Break: Last Hand In Play'}
        </span>
      </div>
    );
  }

  return (
    <div className="break-screen" role="dialog" aria-modal="true" aria-labelledby="break-title">
      <div className="break-screen__overlay" aria-hidden="true" />
      <div className="break-screen__content">
        <span className="break-screen__medallion" aria-hidden="true" />
        {/* Header */}
        {/* Dan 2026-08-30: an X, not a "Minimize" button. Closing collapses
            to the floating badge so the countdown stays reachable. */}
        <button
          className="break-screen__close"
          onClick={() => setMinimized(true)}
          aria-label="Close Break Screen"
        >
          X
        </button>
        <div className="break-screen__header">
          <span className="break-screen__badge">Tournament On Break</span>
          <h1 id="break-title" className="break-screen__title">
            {tournamentName}
          </h1>
        </div>

        {/* Timer */}
        <div className="break-screen__timer-container">
          <div className="break-screen__timer-ring break-screen__timer-ring--animated">
            <svg viewBox="0 0 100 100">
              <circle className="break-screen__ring-bg" cx="50" cy="50" r="45" />
              <circle
                className="break-screen__ring-fill"
                cx="50"
                cy="50"
                r="45"
                strokeDasharray={`${progressPercent * 2.83} 283`}
                style={{ stroke: getTimerColor() }}
              />
            </svg>
            <div className="break-screen__timer-text">
              <span className="break-screen__time" style={{ color: getTimerColor() }}>
                {countingDown ? formatTime(displayTime) : 'Last Hand'}
              </span>
              <span className="break-screen__time-label">
                {countingDown ? 'Until Play Resumes' : 'Break Starts When Every Table Finishes'}
              </span>
            </div>
          </div>
          <div
            className="break-screen__progress-bar"
            style={{ width: `${progressPercent}%`, backgroundColor: getTimerColor() }}
          />
        </div>

        {/* Next Level Info */}
        <div className="break-screen__next-level">
          <span className="break-screen__section-title">Coming Next: Level {currentLevel + 1}</span>
          <div className="break-screen__blinds">
            <div className="break-screen__blind-item">
              <span className="break-screen__blind-label">Blinds</span>
              <span className="break-screen__blind-value">
                {formatStack(nextLevel.smallBlind)}/{formatStack(nextLevel.bigBlind)}
              </span>
            </div>
            {nextLevel.ante && nextLevel.ante > 0 && (
              <div className="break-screen__blind-item">
                <span className="break-screen__blind-label">Ante</span>
                <span className="break-screen__blind-value">{formatStack(nextLevel.ante)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Stats Grid */}
        <div className="break-screen__stats">
          <div className="break-screen__stat">
            <span className="break-screen__stat-label">Players</span>
            <span className="break-screen__stat-value">{playersRemaining}</span>
            <span className="break-screen__stat-sub">Of {totalPlayers}</span>
          </div>
          <div className="break-screen__stat">
            <span className="break-screen__stat-label">Avg Stack</span>
            <span className="break-screen__stat-value">{formatStack(averageStack)}</span>
            <span className="break-screen__stat-sub">
              {Math.trunc(averageStack / Math.max(nextLevel.bigBlind, 1))} BB
            </span>
          </div>
          <div className="break-screen__stat">
            <span className="break-screen__stat-label">Prize Pool</span>
            <span className="break-screen__stat-value">{formatStack(prizePool)}</span>
            <span className="break-screen__stat-sub">{currency ? currency + ' Total' : ''}</span>
          </div>
        </div>

        {/* My Position */}
        {myPlayer && (
          <div className="break-screen__my-position">
            <span className="break-screen__section-title">Your Status</span>
            <div className="break-screen__my-info">
              <div className="break-screen__my-rank">
                <span className="break-screen__rank-label">Rank</span>
                <span className="break-screen__rank-number">#{myPlayer.rank}</span>
                <span className="break-screen__rank-of">Of {playersRemaining}</span>
              </div>
              <div className="break-screen__divider"></div>
              <div className="break-screen__my-stack">
                <span className="break-screen__stack-label">Stack</span>
                <span className="break-screen__stack-value">{formatStack(myPlayer.stack)}</span>
                <span className="break-screen__stack-bb">
                  {Math.trunc(myPlayer.stack / Math.max(nextLevel.bigBlind, 1))} BB
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Leaders */}
        <div className="break-screen__leaders">
          <span className="break-screen__section-title">Chip Leaders</span>
          <div className="break-screen__leader-list">
            {topPlayers.length > 0 ? (
              topPlayers.slice(0, 5).map((player) => (
                <div
                  key={player.playerId}
                  className={`break-screen__leader ${player.isCurrentUser ? 'break-screen__leader--me' : ''}`}
                >
                  <span className="break-screen__leader-rank">#{player.rank}</span>
                  {player.avatar ? (
                    <img
                      className="break-screen__leader-avatar"
                      src={player.avatar}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <span className="break-screen__leader-avatar" aria-hidden="true" />
                  )}
                  <span className="break-screen__leader-name">{player.playerName}</span>
                  <span className="break-screen__leader-stack">{formatStack(player.stack)}</span>
                </div>
              ))
            ) : (
              <p className="break-screen__leaders-empty">Standings Update During The Break</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default TournamentBreakScreen;
