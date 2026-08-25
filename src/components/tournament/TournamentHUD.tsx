/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT HUD — Compact in-game heads-up display (felt overlay)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * A small, self-contained tournament status bar meant to sit on the poker table
 * (TablePage) so a seated player always sees the current level, blinds, ante, the
 * live countdown to the next level, players remaining and average stack WITHOUT
 * leaving the felt. The full-screen projector clock (TournamentClock) is for
 * lobby/detail pages; this is the terse in-hand version.
 *
 * DESIGN GOALS
 *   • Drop-in: self-fetches by tournamentId and subscribes to live level changes.
 *     No parent wiring required beyond passing the id.
 *   • Server-authoritative: the level and countdown come from the engine-persisted
 *     tournaments.current_level / level_started_at via
 *     tournamentService.getCurrentLevelState() — the same source the sweep-4/5
 *     work made authoritative — so the HUD never drifts ahead of the real timer,
 *     survives breaks / hand-for-hand pauses / restarts, and re-syncs on every
 *     realtime UPDATE.
 *   • Standalone styling: all styles are inline, so there is NO extra CSS file to
 *     import and nothing to wire into a build. Ready to render the moment a table
 *     page imports it.
 *
 * INTENDED USAGE (once TablePage is unlocked — do NOT modify TablePage here):
 *   <TournamentHUD
 *     tournamentId={table.tournament_id}
 *     playersRemaining={playersRemaining}   // optional live overrides
 *     averageStack={avgStack}
 *   />
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useRef, useState } from 'react';
import { tournamentService } from '../../services/TournamentService';
import type { Tournament } from '../../types/database.types';
import { masterBus } from '../../core/MasterBus';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';

interface TournamentHUDProps {
  tournamentId: string;
  /** Optional override; if omitted the HUD derives it from live player rows. */
  playersRemaining?: number;
  /** Optional override for average stack display. */
  averageStack?: number;
  /** Hide the HUD entirely (e.g. between hands) without unmounting. */
  hidden?: boolean;
}

function fmtClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function fmtChips(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '-';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  return Math.trunc(n).toLocaleString();
}

export function TournamentHUD({
  tournamentId,
  playersRemaining,
  averageStack,
  hidden = false,
}: TournamentHUDProps) {
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [tick, setTick] = useState(0); // forces a 1s re-render for the countdown
  const [derivedRemaining, setDerivedRemaining] = useState<number | null>(null);
  const [derivedAvgStack, setDerivedAvgStack] = useState<number | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resyncRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load + subscribe to live tournament level changes ──
  useEffect(() => {
    if (!tournamentId) return;
    let mounted = true;

    /**
     * 2026-08-25 audit: two defects lived in the first version of this.
     *
     *  - It reported EVERY failure, forever. No backoff, no counter, no
     *    de-dupe. A persistent failure — an RLS denial, a deleted row, an
     *    offline tab — filed an error report every 45 seconds, per open table,
     *    for as long as the component stayed mounted (which, because
     *    PersistentTableLayer hides rather than unmounts, is "the session").
     *    Only the first few are information; the rest are noise that buries
     *    real reports.
     *  - Nothing stopped it. A COMPLETED or CANCELLED tournament has no next
     *    level and no clock, and was polled every 45s regardless.
     */
    let failures = 0;
    const refresh = async () => {
      try {
        const t = await tournamentService.getTournament(tournamentId);
        if (!mounted) return;
        failures = 0;
        setTournament(t);
        // Nothing left to track once the event is over: stop the poll rather
        // than asking the same settled question every 45 seconds.
        const status = String((t as { status?: string } | null)?.status ?? '').toUpperCase();
        if (t && status !== 'RUNNING' && status !== 'REGISTERING' && status !== 'LATE_REG') {
          if (resyncRef.current) {
            clearInterval(resyncRef.current);
            resyncRef.current = null;
          }
        }
      } catch (e) {
        if (!mounted) return;
        failures += 1;
        // First two only. After that the fault is established and repeating it
        // tells nobody anything new.
        if (failures <= 2) reportError(e, 'TournamentHUD.load', { tournamentId, failures });
        // A wall we cannot get through is not worth hitting every 45s forever.
        if (failures >= 5 && resyncRef.current) {
          clearInterval(resyncRef.current);
          resyncRef.current = null;
        }
      }
    };

    void refresh();

    /**
     * Dan 2026-08-25 (binding): "blind levels on the screen are never
     * increasing."
     *
     * This HUD had EXACTLY ONE way to learn that the level changed: a
     * postgres_changes subscription on the tournaments row. That is a single
     * point of failure with no fallback — a dropped socket, a tab that slept
     * through the UPDATE, a subscribe() that returned CHANNEL_ERROR (nothing
     * here even looked at the status), and the HUD sits on its mount-time
     * snapshot for the rest of the tournament, cheerfully printing LEVEL 1
     * while the felt plays level 9. It never re-fetched, not once.
     *
     * A clock that can be wrong for an hour is worse than no clock. It now
     * re-reads the authoritative row every 45 seconds while RUNNING, so the
     * realtime feed is an OPTIMISATION (instant update) rather than the only
     * source of truth, and the worst case is a level that is late by under a
     * minute instead of stale forever.
     */
    resyncRef.current = setInterval(() => void refresh(), 45_000);

    const channel = masterBus.getOrCreateChannel(`tournament-hud-${tournamentId}`);
    channel
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tournaments', filter: `id=eq.${tournamentId}` },
        (payload: { eventType: string; new?: Record<string, unknown> }) => {
          if (payload.eventType === 'UPDATE' && payload.new) {
            setTournament((prev) => (prev ? ({ ...prev, ...payload.new } as Tournament) : prev));
          }
        }
      )
      .subscribe();

    return () => {
      mounted = false;
      if (resyncRef.current) clearInterval(resyncRef.current);
      resyncRef.current = null;
      try {
        masterBus.removeRegisteredChannel(`tournament-hud-${tournamentId}`);
      } catch {
        /* channel cleanup is best-effort */
      }
    };
  }, [tournamentId]);

  // ── 1-second countdown tick (only while RUNNING) ──
  useEffect(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    // `hidden` returns null below, so a hidden HUD ticking once a second was
    // re-rendering nothing, on every open table (2026-08-25 audit).
    if (hidden || !tournament || tournament.status !== 'RUNNING') return;
    tickRef.current = setInterval(() => setTick((n) => (n + 1) % 3600), 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [hidden, tournament?.status, tournament?.id]);

  // ── Derive players-remaining / avg-stack from live rows when not supplied ──
  useEffect(() => {
    if (!tournamentId) return;
    if (playersRemaining !== undefined && averageStack !== undefined) return;
    let mounted = true;
    (async () => {
      try {
        const { data, error } = await supabase
          .from('tournament_players')
          .select('chips, status')
          .eq('tournament_id', tournamentId)
          .in('status', ['playing', 'registered']);
        if (!error && mounted && Array.isArray(data)) {
          const active = data as Array<{ chips?: number | null; status?: string }>;
          setDerivedRemaining(active.length);
          const totalChips = active.reduce((s, r) => s + (r.chips || 0), 0);
          setDerivedAvgStack(active.length ? Math.trunc(totalChips / active.length) : 0);
        }
      } catch {
        /* optional enrichment — HUD renders fine without it */
      }
    })();
    return () => {
      mounted = false;
    };
    // Recompute occasionally as the level ticks over (cheap, and keeps it fresh).
  }, [tournamentId, playersRemaining, averageStack, tournament?.current_level]);

  if (hidden || !tournament) return null;

  // Reference `tick` so the memo re-evaluates every second (countdown display).
  void tick;

  const levelState = tournamentService.getCurrentLevelState(tournament);
  const cur = levelState.currentLevel;
  const next = levelState.nextLevel;
  const isBreak = !!cur?.isBreak;
  const remaining = levelState.timeRemainingSeconds;

  const shownPlayers =
    playersRemaining !== undefined ? playersRemaining : (derivedRemaining ?? undefined);
  const shownAvg = averageStack !== undefined ? averageStack : (derivedAvgStack ?? undefined);

  // Urgency color for the countdown (last 60s of a level).
  const timerColor = remaining <= 60 ? '#ff5252' : remaining <= 120 ? '#ffb74d' : '#4fc3f7';

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'stretch',
        gap: 0,
        borderRadius: 10,
        overflow: 'hidden',
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        background: 'linear-gradient(180deg,#1b2a33 0%,#12212a 100%)',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
        color: '#e8f0f4',
        userSelect: 'none',
        lineHeight: 1.1,
      }}
      role="status"
      aria-label="Tournament clock"
    >
      {/* Level / break badge */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '6px 12px',
          background: isBreak ? 'rgba(255,183,77,0.16)' : 'rgba(79,195,247,0.12)',
          minWidth: 56,
        }}
      >
        <span style={{ fontSize: 9, letterSpacing: 0.6, opacity: 0.7, textTransform: 'uppercase' }}>
          {isBreak ? 'Break' : 'Level'}
        </span>
        <span style={{ fontSize: 18, fontWeight: 700 }}>
          {isBreak ? '◇' : levelState.levelIndex + 1}
        </span>
      </div>

      {/* Blinds + ante */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '6px 14px',
          borderLeft: '1px solid rgba(255,255,255,0.07)',
        }}
      >
        <span style={{ fontSize: 9, letterSpacing: 0.6, opacity: 0.7, textTransform: 'uppercase' }}>
          Blinds
        </span>
        <span style={{ fontSize: 15, fontWeight: 700 }}>
          {isBreak ? '-' : `${fmtChips(cur?.smallBlind ?? 0)} / ${fmtChips(cur?.bigBlind ?? 0)}`}
        </span>
        {!isBreak && (cur?.ante ?? 0) > 0 && (
          <span style={{ fontSize: 10, opacity: 0.7 }}>Ante {fmtChips(cur!.ante)}</span>
        )}
      </div>

      {/* Countdown to next level */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '6px 14px',
          borderLeft: '1px solid rgba(255,255,255,0.07)',
          minWidth: 66,
        }}
      >
        <span style={{ fontSize: 9, letterSpacing: 0.6, opacity: 0.7, textTransform: 'uppercase' }}>
          Next
        </span>
        <span
          style={{
            fontSize: 18,
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
            color: tournament.status === 'RUNNING' ? timerColor : '#9aa7ae',
          }}
        >
          {tournament.status === 'RUNNING' ? fmtClock(remaining) : '--:--'}
        </span>
        {next && !next.isBreak && (
          <span style={{ fontSize: 9, opacity: 0.6 }}>
            {fmtChips(next.smallBlind)}/{fmtChips(next.bigBlind)}
          </span>
        )}
        {next?.isBreak && <span style={{ fontSize: 9, opacity: 0.6 }}>Break Next</span>}
      </div>

      {/* Players remaining */}
      {shownPlayers !== undefined && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            padding: '6px 12px',
            borderLeft: '1px solid rgba(255,255,255,0.07)',
          }}
        >
          <span
            style={{ fontSize: 9, letterSpacing: 0.6, opacity: 0.7, textTransform: 'uppercase' }}
          >
            Left
          </span>
          <span style={{ fontSize: 15, fontWeight: 700 }}>{shownPlayers}</span>
        </div>
      )}

      {/* Average stack */}
      {shownAvg !== undefined && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            padding: '6px 12px',
            borderLeft: '1px solid rgba(255,255,255,0.07)',
          }}
        >
          <span
            style={{ fontSize: 9, letterSpacing: 0.6, opacity: 0.7, textTransform: 'uppercase' }}
          >
            Avg
          </span>
          <span style={{ fontSize: 15, fontWeight: 700 }}>{fmtChips(shownAvg)}</span>
        </div>
      )}
    </div>
  );
}

export default TournamentHUD;
