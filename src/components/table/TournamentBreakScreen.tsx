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

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { serverNow } from '../../utils/serverClock';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import { SpadeConsole } from '../console/SpadeConsole';
import { compactChips } from '../../utils/format';
import { titleCase } from '../../utils/titleCase';
import { publicOrigin, IS_NATIVE_BUILD, isNativePlatform } from '../../lib/appBase';
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
  /** The owning table canvas, so the minimized clock never covers its action bar. */
  tableAnchorRef?: React.RefObject<HTMLElement | null>;
  breakTimeRemaining: number; // seconds
  /**
   * THE BREAK HAS TWO PHASES AND THE SCREEN MUST SAY WHICH (2026-08-27).
   *
   * At :55 the server announces the LAST HAND. The five minutes do not start
   * until every table of THIS tournament has finished it (Dan 2026-10-25:
   * every tournament starts and stops its own five minutes), which is why a
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

// This is the break summary, outside the felt. Full amounts remain available
// on the value's title; compactChips floors rather than overstating a stack.
function formatStack(amount: number): string {
  return compactChips(amount);
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function TournamentBreakScreen({
  isVisible,
  tableAnchorRef,
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
  const sharing = useRef(false);
  const [shareMessage, setShareMessage] = useState('');
  const shareTournament = async () => {
    if (sharing.current) return;
    if (!tournamentId) {
      setShareMessage('Tournament Link Unavailable');
      return;
    }
    sharing.current = true;
    setShareMessage('');
    const url = `${publicOrigin()}/hub/club-arena/tournaments/${encodeURIComponent(tournamentId)}`;
    try {
      if (IS_NATIVE_BUILD && isNativePlatform()) {
        const { nativeShareText } = await import('../../lib/native/share');
        await nativeShareText(tournamentName, '', url);
      } else if (typeof navigator.share === 'function') {
        await navigator.share({ title: tournamentName, url });
      } else {
        await navigator.clipboard.writeText(url);
        setShareMessage('Tournament Link Copied');
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        setShareMessage('Could Not Share Tournament. Please Try Again.');
      }
    } finally {
      sharing.current = false;
    }
  };

  const [factsFailed, setFactsFailed] = useState(false);

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
    setFacts(null);
    setFactsFailed(false);
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
          setFactsFailed(true);
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
        if (mounted) {
          setFactsFailed(true);
          reportError(err, 'TournamentBreakScreen.load', { tournamentId });
        }
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
  const factsPending = Boolean(tournamentId) && facts === null;
  const unknownValue = factsFailed ? 'N/A' : '...';
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

  const getTimerColor = () => {
    if (!countingDown) return '#45adff';
    return displayTime <= 10 ? '#ff5b6e' : '#ffd700';
  };
  const waitingForResume = countingDown && displayTime === 0;

  // Expiry retires this presentation only. The engine still owns all play
  // and pause authority, including a delayed resume.
  if (!isVisible || (countingDown && displayTime <= 0)) return null;

  // A real button keeps the clock reachable by keyboard as well as touch.
  if (minimized) {
    const tableAnchor = tableAnchorRef?.current;
    const button = (
      <button
        type="button"
        className={`break-screen__minimized${tableAnchor ? ' break-screen__minimized--on-table' : ''}`}
        onClick={() => setMinimized(false)}
        aria-label="Open Break Screen"
      >
        <span className="break-screen__mini-face">
          <span className="break-screen__mini-badge">
            {countingDown ? `Break: ${formatTime(displayTime)}` : 'Break: Last Hand'}
          </span>
          <span className="break-screen__mini-state">Paused</span>
        </span>
      </button>
    );
    return tableAnchor ? createPortal(button, tableAnchor) : button;
  }

  return (
    <div
      className="break-screen"
      role="dialog"
      aria-modal="false"
      aria-labelledby="break-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setMinimized(true);
      }}
    >
      <div className="break-screen__frame">
        <button
          type="button"
          className="break-screen__share"
          aria-label="Share Tournament"
          onClick={shareTournament}
        />
        <SpadeConsole
          className="break-screen__content"
          title="Tournament Break"
          onClose={() => setMinimized(true)}
          pill="Share"
          pillInk="gold"
          foot="foot"
        >
          {shareMessage && (
            <p className="break-screen__share-message" role="alert">
              {shareMessage}
            </p>
          )}
          <h1 id="break-title" className="break-screen__title">
            {titleCase(tournamentName)}
          </h1>

          <div className="break-screen__resumption">
            <div className="break-screen__timer-container">
              <span className="break-screen__time-label">
                {countingDown ? 'Play Resumes In' : 'Finishing The Last Hand'}
              </span>
              <span
                className={`break-screen__time ${!countingDown ? 'break-screen__time--waiting' : ''}`}
                role="timer"
                aria-label={countingDown ? 'Time Until Play Resumes' : 'Last Hand In Play'}
                style={{ color: getTimerColor() }}
              >
                {countingDown ? formatTime(displayTime) : 'Last Hand'}
              </span>
              <svg className="break-screen__progress" viewBox="0 0 200 4" aria-hidden="true">
                <path className="break-screen__progress-track" d="M0 2 H200" />
                <path
                  d="M0 2 H200"
                  pathLength="100"
                  strokeDasharray={`${progressPercent} 100`}
                  style={{ stroke: getTimerColor() }}
                />
              </svg>
            </div>
            <div className="break-screen__next-level">
              <span className="break-screen__section-title">
                Coming Next: Level {currentLevel + 1}
              </span>
              <span className="break-screen__blind-label">Blinds</span>
              <span
                className="break-screen__blind-value"
                title={`${nextLevel.smallBlind.toLocaleString('en-US')} / ${nextLevel.bigBlind.toLocaleString('en-US')}`}
              >
                {formatStack(nextLevel.smallBlind)} / {formatStack(nextLevel.bigBlind)}
              </span>
              {nextLevel.ante && nextLevel.ante > 0 ? (
                <span className="break-screen__ante">
                  Ante <strong>{formatStack(nextLevel.ante)}</strong>
                </span>
              ) : null}
            </div>
          </div>
          <p className="break-screen__resume-note" role="status">
            {!countingDown
              ? 'Break Starts When Every Table Finishes'
              : waitingForResume
                ? 'Waiting For Play To Resume'
                : 'Play Resumes Automatically'}
          </p>

          <div className="break-screen__stats">
            <div className="break-screen__stat">
              <span className="break-screen__stat-label">Players</span>
              <span className="break-screen__stat-value">
                {factsPending && playersRemainingProp === undefined
                  ? unknownValue
                  : playersRemaining}
              </span>
              <span className="break-screen__stat-sub">
                {factsPending && totalPlayersProp === undefined
                  ? 'Remaining'
                  : `Of ${totalPlayers}`}
              </span>
            </div>
            <div className="break-screen__stat">
              <span className="break-screen__stat-label">Avg Stack</span>
              <span
                className="break-screen__stat-value"
                title={
                  factsPending && averageStackProp === undefined
                    ? undefined
                    : averageStack.toLocaleString('en-US')
                }
              >
                {factsPending && averageStackProp === undefined
                  ? unknownValue
                  : formatStack(averageStack)}
              </span>
              <span className="break-screen__stat-sub">
                {factsPending && averageStackProp === undefined
                  ? 'Chips'
                  : `${Math.trunc(averageStack / Math.max(nextLevel.bigBlind, 1))} BB`}
              </span>
            </div>
            <div className="break-screen__stat">
              <span className="break-screen__stat-label">Prize Pool</span>
              <span
                className="break-screen__stat-value"
                title={
                  factsPending && prizePoolProp === undefined
                    ? undefined
                    : prizePool.toLocaleString('en-US')
                }
              >
                {factsPending && prizePoolProp === undefined
                  ? unknownValue
                  : formatStack(prizePool)}
              </span>
              <span className="break-screen__stat-sub">
                {currency ? titleCase(currency) + ' Total' : 'Total Chips'}
              </span>
            </div>
          </div>

          {myPlayer && (
            <div className="break-screen__my-position">
              <span className="break-screen__section-title">Your Status</span>
              <span className="break-screen__my-rank">
                #{myPlayer.rank} <small>Of {playersRemaining}</small>
              </span>
              <span
                className="break-screen__my-stack"
                title={myPlayer.stack.toLocaleString('en-US')}
              >
                {formatStack(myPlayer.stack)}{' '}
                <small>{Math.trunc(myPlayer.stack / Math.max(nextLevel.bigBlind, 1))} BB</small>
              </span>
            </div>
          )}

          <section className="break-screen__leaders" aria-label="Chip Leaders">
            <div className="break-screen__leader-heading">
              <h2 className="break-screen__section-title">Chip Leaders</h2>
              <span className="break-screen__stat-sub">Chips</span>
            </div>
            <ol className="break-screen__leader-list">
              {topPlayers.length > 0 ? (
                topPlayers.slice(0, 5).map((player) => (
                  <li
                    key={player.playerId}
                    className={`break-screen__leader ${player.isCurrentUser ? 'break-screen__leader--me' : ''}`}
                  >
                    <span className="break-screen__leader-rank">{player.rank}</span>
                    {player.avatar ? (
                      <img
                        className="break-screen__leader-avatar"
                        src={player.avatar}
                        alt=""
                        loading="lazy"
                      />
                    ) : null}
                    <span className="break-screen__leader-name">{player.playerName}</span>
                    {player.isCurrentUser && <span className="break-screen__you">You</span>}
                    <span
                      className="break-screen__leader-stack"
                      title={player.stack.toLocaleString('en-US')}
                    >
                      {formatStack(player.stack)}
                    </span>
                  </li>
                ))
              ) : (
                <li className="break-screen__leaders-empty" role="status">
                  {factsFailed
                    ? 'Standings Unavailable'
                    : factsPending
                      ? 'Loading Standings'
                      : 'Standings Update During The Break'}
                </li>
              )}
            </ol>
          </section>
        </SpadeConsole>
      </div>
    </div>
  );
}

export default TournamentBreakScreen;
