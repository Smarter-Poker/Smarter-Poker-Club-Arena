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
import { serverNow } from '../../utils/serverClock';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { tournamentTimerService } from '../../services/TournamentTimerService';
import { tournamentService } from '../../services/TournamentService';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
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
  /** Total entries. Shown next to the remaining count so "12 / 48" reads as
   *  a real field, and so a busted field is visibly a busted field. */
  entrants: number;
  averageStack: number;
  totalChips: number;
  tournamentName: string;
  isPaused: boolean;
  /**
   * WHEN THE BREAK ENDS, IN WALL-CLOCK MS. Replaces the old `breakStartTime`
   * plus `breakDurationSeconds` pair (2026-08-27).
   *
   * `breakStartTime` was an anchor the client stamped with its OWN `Date.now()`
   * and then counted a seeded duration from, because the end was assumed rather
   * than known. Two things followed. The countdown could not survive a reload —
   * there was no anchor to restore — and it could not be right even when it did
   * run: `pauseForBreak` broadcasts one estimated end, then
   * `beginBreakCountdown` writes the REAL `break_ends_at` afterwards, so the
   * assumed five minutes expired up to two minutes before play resumed.
   *
   * An absolute instant fixes both. It is `tournaments.break_ends_at` (or the
   * `breakEndsAt` / `resumeAt` the break broadcast carries), it survives a
   * reload because it is persisted, and it cannot drift because nothing
   * decrements it — `breakTimeRemaining` is subtraction, done at render.
   *
   * null = on a break whose end is not yet stamped (the gap between
   * `tournament_break` and `tournament_break_started`). The overlay shows BREAK
   * and the phase label rather than inventing a clock.
   *
   * THAT LAST SENTENCE WAS NOT TRUE UNTIL 2026-09-09, and it is worth knowing
   * why. `tournament_break` carries `breakEndsAt: null` and
   * `breakDurationMinutes: 5`, and tournamentEventBridge forwarded the duration,
   * so the `Date.now() + durationMinutes` fallback below reconstructed exactly
   * the fabricated instant the engine had stopped sending — a 5:00 countdown at
   * :55 that then jumped back up to 5:00 when the real end arrived. The bridge
   * now offers a seed only once a countdown has genuinely started, which is what
   * makes this comment describe the code.
   */
  breakEndsAtMs?: number | null;
  /**
   * Which half of the break this is, straight off the engine's own `phase`
   * field. 'last_hand' is the :55 window: announced, no end time yet, and the
   * overlay says so instead of showing a clock (the same rule
   * TournamentBreakScreen.tsx:352 applies at the table). null when not on a
   * break.
   */
  breakPhase?: 'last_hand' | 'counting_down' | null;
}

/** Epoch ms, or null for absent/unparseable. Never NaN, never a silent zero. */
function epochMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** Seconds left until `endsAtMs`, floored at 0. 0 when there is no deadline. */
function secondsUntil(endsAtMs: number | null | undefined): number {
  if (endsAtMs === null || endsAtMs === undefined) return 0;
  return Math.max(0, Math.floor((endsAtMs - serverNow()) / 1000));
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
    entrants: 0,
    averageStack: 0,
    totalChips: 0,
    tournamentName: '',
    isPaused: false,
    breakEndsAtMs: null,
    breakPhase: null,
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

      // ── Live field stats ──────────────────────────────────────────────
      // FIX 2026-08-15: every number in this footer was wrong once a single
      // player busted.
      //
      //   playersRemaining = tournament.current_players
      //
      // `current_players` is the ENTRY count. It is incremented by
      // fn_register_for_tournament and decremented only by UNregistration;
      // no elimination path touches it (the server itself calls it
      // `totalEntries` -- TournamentManagerEliminations.ts). So the clock
      // showed the starting field for the whole tournament. Measured against
      // production while writing this: "Union Mystery Bounty (PLO5)" was down
      // to its last player and the clock read 21; "Late Night PKO" had 4 left
      // and read 20.
      //
      // Worse, both other stats were derived from it:
      //   totalChips   = starting_chips * playersRemaining   (ignores every
      //                  chip won, lost, rebought or added on)
      //   averageStack = totalChips / playersRemaining       (algebraically
      //                  ALWAYS starting_chips -- a constant, displayed as if
      //                  it were live. The same tournament above showed 8,000
      //                  when the real average stack was 168,700.)
      //
      // Count and sum the actual seats instead. tournament_players is in the
      // realtime publication, so the subscription below keeps this current
      // between the 15s polls.
      let playersRemaining = tournament.current_players || 0;
      let entrants = tournament.current_players || 0;
      let totalChips = (tournament.starting_chips || 0) * playersRemaining;
      let averageStack = tournament.starting_chips || 0;

      const { data: seatRows, error: seatErr } = await supabase
        .from('tournament_players')
        .select('chips, status')
        .eq('tournament_id', tournamentId);

      if (seatErr) {
        // Fall back to the (stale) tournament row rather than showing zeros.
        reportError(seatErr, 'TournamentClock.Seat_stats_failed');
      } else if (seatRows) {
        const alive = seatRows.filter((r: { status?: string }) => r.status === 'playing');
        entrants = seatRows.length || entrants;
        playersRemaining = alive.length;
        totalChips = alive.reduce(
          (sum: number, r: { chips?: number }) => sum + (Number(r.chips) || 0),
          0
        );
        averageStack = playersRemaining > 0 ? Math.round(totalChips / playersRemaining) : 0;
      }

      /**
       * ═══════════════════════════════════════════════════════════════════════
       *  THE BREAK IS A COLUMN, NOT AN EVENT (2026-08-27)
       * ═══════════════════════════════════════════════════════════════════════
       *
       * The two lines below used to read, in full:
       *
       *     isBreak: false, // Will be updated via BREAK_START event
       *     breakTimeRemaining: 0,
       *
       * and this function runs on mount AND on a 30-second interval. So break
       * state existed only for a client that happened to be connected at the
       * instant one broadcast went out, and even that client had it ERASED
       * within thirty seconds by its own poll. Reload, reconnect, or arrive
       * mid-break and you saw an ordinary tournament clock counting a level
       * down while no cards were being dealt anywhere.
       *
       * `tournaments.on_break` and `tournaments.break_ends_at` have been
       * written by TournamentManagerBase the whole time (pauseForBreak,
       * beginBreakCountdown, clearPersistedBreak). Nothing in src/ read them.
       * They are the state; the broadcasts are only a fast path to it.
       *
       * `break_ends_at > now` on its own is enough to be on a break: a
       * tournament that ENDS on a break can leave `on_break` true with nothing
       * alive to clear it, so the expiring timestamp is what makes a stale flag
       * self-correct.
       */
      const breakEndsAtMs = epochMs(
        (tournament as { break_ends_at?: string | null }).break_ends_at
      );
      const onBreak =
        Boolean((tournament as { on_break?: boolean | null }).on_break) ||
        (breakEndsAtMs !== null && breakEndsAtMs > serverNow());

      setClock({
        currentLevel: levelState.levelIndex + 1,
        smallBlind: levelState.currentLevel.smallBlind,
        bigBlind: levelState.currentLevel.bigBlind,
        ante: levelState.currentLevel.ante,
        nextSmallBlind: levelState.nextLevel?.smallBlind || 0,
        nextBigBlind: levelState.nextLevel?.bigBlind || 0,
        nextAnte: levelState.nextLevel?.ante || 0,
        timeRemaining: levelState.timeRemainingSeconds,
        isBreak: onBreak,
        breakTimeRemaining: onBreak ? secondsUntil(breakEndsAtMs) : 0,
        playersRemaining,
        entrants,
        averageStack,
        totalChips,
        tournamentName: tournament.name || 'Tournament',
        isPaused: timerState?.isPaused || false,
        breakEndsAtMs: onBreak ? breakEndsAtMs : null,
        /* From the row: a break with `break_ends_at` stamped is counting down,
           one without it is still waiting on the last hand. */
        breakPhase: onBreak ? (breakEndsAtMs === null ? 'last_hand' : 'counting_down') : null,
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
        /* On a break: recompute from the ABSOLUTE end instant. Nothing is
           decremented, so a throttled background tab cannot accumulate drift —
           it can only render one second late. The old arithmetic counted a
           seeded 300 assumed seconds from a client-stamped start, which is both
           the drift and the two-minutes-early zero. A break whose end is not
           stamped yet (the :55 last-hand window) shows no clock at all rather
           than an invented one. */
        if (prev.isBreak) {
          return {
            ...prev,
            breakTimeRemaining: secondsUntil(prev.breakEndsAtMs),
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
    const refreshInterval = setInterval(() => {
      if (document.hidden) return;
      refreshState();
    }, 30_000);

    // Eliminations and chip movements must reach the clock immediately, not up
    // to 30s later — the whole point of the fix above is that this footer
    // tracks the live field. tournament_players is in the realtime publication.
    const channelKey = `clock-players-${tournamentId}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournament_players',
          filter: `tournament_id=eq.${tournamentId}`,
        },
        () => {
          refreshState();
        }
      )
      .subscribe((status: string, err?: Error) => {
        // The 30s poll above is the backstop, so a dead channel degrades
        // rather than breaks. Still report it.
        if (status === 'CHANNEL_ERROR' && err) {
          reportError(err?.message || err, 'TournamentClock.Realtime_channel_error');
        }
      });

    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      clearInterval(refreshInterval);
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [refreshState, tournamentId]);

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
        /**
         * NO `+ 1`: THE PAYLOAD IS ALREADY THE DISPLAY LEVEL (2026-08-29).
         *
         * `clock.currentLevel` is rendered raw as `LEVEL {n}` and the DB path
         * above converts for itself (`levelState.levelIndex + 1`), so this fast
         * path has to arrive at the same convention. It used to add one on the
         * stated grounds that "BLIND_LEVEL_CHANGE.level is the identical value
         * stored in tournaments.current_level". It is not.
         * TournamentTimerService.handleLevelChange computes
         * `const displayLevel = newLevel + 1`, writes the raw index to the row
         * and emits the DISPLAY level here.
         *
         * So the 2026-08-26 fix corrected a clock that flashed one level
         * BACKWARDS into a clock that flashes one level FORWARD — LEVEL 6 ->
         * LEVEL 7 on the projector in front of the room — for the same window,
         * between the advance and the next `refreshState()`. Same shape, other
         * direction, which is why it read as a fix. See MasterBus's
         * BLIND_LEVEL_CHANGE for the contract, now written down.
         */
        currentLevel: Math.max(1, Number(payload.level) || 1),
        smallBlind: payload.smallBlind,
        bigBlind: payload.bigBlind,
        ante: payload.ante,
        isBreak: false, // Clear break status on new level
        breakTimeRemaining: 0,
        breakEndsAtMs: null,
        breakPhase: null,
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
      if (payload?.tournamentId !== tournamentId) return;
      /**
       * ABSOLUTE FIRST, DURATION ONLY AS A LAST RESORT.
       *
       * The engine sends `breakEndsAt` (pauseForBreak, beginBreakCountdown)
       * and `resumeAt`; a duration is what is left when neither travelled. A
       * duration is also what this handler used to take unconditionally, which
       * is why the countdown could not agree with the second broadcast — the
       * one carrying the REAL end — that follows the first.
       */
      const endsAtMs =
        epochMs(payload?.breakEndsAt) ??
        epochMs(payload?.resumeAt) ??
        epochMs(payload?.break_ends_at) ??
        (Number(payload?.durationMinutes) > 0
          ? Date.now() + Number(payload.durationMinutes) * 60_000
          : null);
      setClock((prev) => {
        const nextEnd = endsAtMs ?? prev.breakEndsAtMs ?? null;
        return {
          ...prev,
          isBreak: true,
          /* The :55 announcement carries no end, the countdown-start event does.
             Never let the announcement erase an end already known. */
          breakEndsAtMs: nextEnd,
          breakTimeRemaining: secondsUntil(nextEnd),
          /* The engine's own `phase`, relayed by tournamentEventBridge. A known
             end always means counting down, whatever the label says. */
          breakPhase:
            nextEnd !== null
              ? 'counting_down'
              : payload?.phase === 'counting_down'
                ? 'counting_down'
                : 'last_hand',
        };
      });
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
          breakEndsAtMs: null,
          breakPhase: null,
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
            title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
          >
            {isFullscreen ? '⊟' : '⊞'}
          </button>
        )}
      </div>

      {/* ── Break Mode ── */}
      {clock.isBreak && (
        <div className="tc-break-overlay">
          <span className="tc-break-icon">◇</span>
          <span className="tc-break-text">BREAK</span>
          {clock.breakTimeRemaining > 0 ? (
            <span className="tc-break-timer">{formatTime(clock.breakTimeRemaining)}</span>
          ) : clock.breakPhase === 'last_hand' ? (
            /* The :55 window. There is no end time yet and inventing one is the
               bug this whole path exists to avoid, so say which half of the
               break this is - the same words TournamentBreakScreen.tsx:352 uses
               at the table. */
            <span className="tc-break-timer">Last Hand</span>
          ) : null}
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
            <span className="tc-stat-icon">◉</span>
            <span className="tc-stat-value">
              {clock.playersRemaining}
              {clock.entrants > 0 && <span className="tc-stat-of"> / {clock.entrants}</span>}
            </span>
            <span className="tc-stat-label">Remaining</span>
          </div>
          <div className="tc-stat">
            <span className="tc-stat-icon">▦</span>
            <span className="tc-stat-value">{formatChips(clock.averageStack)}</span>
            <span className="tc-stat-label">Avg Stack</span>
          </div>
          <div className="tc-stat">
            <span className="tc-stat-icon">▦</span>
            <span className="tc-stat-value">{formatChips(clock.totalChips)}</span>
            <span className="tc-stat-label">Total Chips</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default TournamentClock;
