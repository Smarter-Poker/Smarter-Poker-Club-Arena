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
import { useAuthUser } from '../../hooks/useAuthUser';
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
  /**
   * Dan 2026-08-30: "IF YOU CLICK THE LEVEL TAB BUTTON IT WILL OPEN TO THE
   * TOURNAMENT LOBBY INSTANTLY." When provided, the whole bar is a button
   * that opens the in-game tournament lobby popup. The stats icon that used
   * to sit beside the bar is gone - the bar itself is the entry point.
   */
  onOpen?: () => void;
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
  onOpen,
}: TournamentHUDProps) {
  const { user } = useAuthUser();
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [tick, setTick] = useState(0); // forces a 1s re-render for the countdown
  const [derivedRemaining, setDerivedRemaining] = useState<number | null>(null);
  const [derivedAvgStack, setDerivedAvgStack] = useState<number | null>(null);
  /** Dan 2026-08-30: "IT SHOULD ALSO SAY YOUR CURRENT RANK AFTER THE COUNTDOWN
      CLOCK AND BEFORE HOW MANY ARE LEFT." Derived from the same live player
      rows the Left/Avg segments already read. Null while the hero holds no
      live stack in this event (observer, eliminated). */
  const [derivedRank, setDerivedRank] = useState<number | null>(null);
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
    const POLL_MS = 45_000;
    /** Where the poll retreats to after a sustained fault. See the catch. */
    const BACKOFF_MS = 300_000;
    let failures = 0;
    let backedOff = false;
    const refresh = async () => {
      try {
        const t = await tournamentService.getTournament(tournamentId);
        if (!mounted) return;
        // Recovered: come back to the normal cadence rather than staying on
        // the five-minute backoff for the rest of the tournament.
        if (backedOff && resyncRef.current) {
          clearInterval(resyncRef.current);
          resyncRef.current = setInterval(() => void refresh(), POLL_MS);
          backedOff = false;
        }
        failures = 0;
        setTournament(t);
        /* Nothing left to track once the event is OVER: stop the poll rather
           than asking the same settled question every 45 seconds.
           
           2026-08-25, second audit: this was an ALLOW-LIST of live statuses
           (RUNNING / REGISTERING / LATE_REG) and it stopped the poll on
           anything else — including ANNOUNCED, which is a perfectly live state
           a tournament sits in before registration opens. A HUD whose first
           read returned ANNOUNCED stopped polling FOREVER (the effect only
           re-runs on tournamentId, and nothing restarts the interval), so when
           the event went RUNNING it was back to realtime-only: the exact single
           point of failure this poll was added to remove. An empty or missing
           status tripped it too.
           
           It is a DENY-LIST of terminal states now. Anything unrecognised keeps
           polling, which is the safe direction: a needless read every 45s costs
           nothing, a stopped clock costs the player the blind level. */
        const status = String((t as { status?: string } | null)?.status ?? '').toUpperCase();
        const TERMINAL = ['COMPLETED', 'CANCELLED', 'FINISHED', 'ABORTED'];
        if (t && TERMINAL.includes(status)) {
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
        /* 2026-08-25, second audit: this used to STOP the poll after five
           failures, permanently. Five consecutive failures is about three
           minutes — i.e. a tab that was offline over a train tunnel — and
           because PersistentTableLayer hides rather than unmounts, "permanently"
           meant the rest of the session. The cure was worse than the noise it
           was treating.
           
           It BACKS OFF instead: the interval widens to five minutes so a hard
           fault is quiet, and the moment a read succeeds the normal cadence is
           restored (see the success branch). A clock that is late is recoverable;
           a clock that has given up is not. */
        /* `>= 5 && !backedOff`, not `=== 5` (2026-08-26 audit). With strict
           equality, a failure that arrived when `resyncRef.current` happened to
           be null — the terminal-status stop racing a failure — skipped the
           install, and because the ref stays null the poll was then dead for
           good: the exact "gave up permanently" bug this block replaced. */
        if (failures >= 5 && !backedOff) {
          if (resyncRef.current) clearInterval(resyncRef.current);
          resyncRef.current = setInterval(() => void refresh(), BACKOFF_MS);
          backedOff = true;
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
    resyncRef.current = setInterval(() => void refresh(), POLL_MS);

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
          .select('user_id, chips, status')
          .eq('tournament_id', tournamentId)
          .in('status', ['playing', 'registered']);
        if (!error && mounted && Array.isArray(data)) {
          const active = data as Array<{
            user_id?: string;
            chips?: number | null;
            status?: string;
          }>;
          setDerivedRemaining(active.length);
          const totalChips = active.reduce((s, r) => s + (r.chips || 0), 0);
          setDerivedAvgStack(active.length ? Math.trunc(totalChips / active.length) : 0);
          /* Rank = 1 + players with strictly more chips. Ties share the better
             rank, which is how every tournament lobby already counts it. */
          const heroRow = user?.id ? active.find((r) => r.user_id === user.id) : undefined;
          if (heroRow) {
            const heroChips = heroRow.chips || 0;
            setDerivedRank(1 + active.filter((r) => (r.chips || 0) > heroChips).length);
          } else {
            setDerivedRank(null);
          }
        }
      } catch {
        /* optional enrichment — HUD renders fine without it */
      }
    })();
    return () => {
      mounted = false;
    };
    // Recompute occasionally as the level ticks over (cheap, and keeps it fresh).
  }, [tournamentId, playersRemaining, averageStack, tournament?.current_level, user?.id]);

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

  /* ── REBUY / ADD-ON WINDOW BANNER (Dan 2026-08-30) ─────────────────────────
     "WHEN ITS THE LAST LEVEL FOR REBUYS, OR THE ADD ON PERIOD IT SHOULD BE
     SHOWN AND DISPLAYED IN THE LEVEL BAR."
     Same arithmetic the engine runs (TournamentManagerBase): rebuys close
     when the level index reaches late_reg_levels ?? rebuy_levels, so the LAST
     level with rebuys is display level == that cap; the add-on window is the
     addon_levels levels after it. Only shown on events that actually sell the
     thing (a freezeout never wears either). */
  const tRow = tournament as unknown as Record<string, unknown>;
  const displayLevel = levelState.levelIndex + 1;
  const rebuyCap = Number(tRow.late_reg_levels ?? tRow.rebuy_levels ?? 0);
  const sellsRebuys =
    Number(tRow.rebuy_cost ?? 0) > 0 ||
    Number(tRow.rebuy_chips ?? 0) > 0 ||
    tRow.is_reentry === true;
  const sellsAddon = Number(tRow.addon_cost ?? 0) > 0 || Number(tRow.addon_chips ?? 0) > 0;
  const addonWindow = Number(tRow.addon_levels ?? 1);
  const windowBanner =
    tournament.status === 'RUNNING' && rebuyCap > 0
      ? sellsRebuys && displayLevel === rebuyCap
        ? 'Last Rebuy Level'
        : sellsAddon && displayLevel > rebuyCap && displayLevel <= rebuyCap + addonWindow
          ? 'Add-On Period'
          : null
      : null;

  return (
    <div
      /* Named so the HUD layer can scale THIS BAR on small screens without
         scaling its neighbour. The column used to carry the transform, which
         also shrank the 44px stats icon beside it to ~33px — a transformed hit
         area follows the transform — putting the one control Dan asked to be
         reachable on the table screen under the minimum touch target. */
      className="tournament-hud-bar"
      style={{
        display: 'inline-flex',
        flexWrap: 'wrap',
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
        cursor: onOpen ? 'pointer' : 'default',
      }}
      /* NOT `role="status"`. That is an aria-live=polite region, and this
         element re-renders every second for the countdown — so a screen reader
         re-announced level, blinds, ante, countdown, players and average stack
         once a second for the entire tournament (2026-08-26 audit). `group`
         with a label keeps it navigable and reachable without narrating it
         continuously; the countdown itself is hidden from the accessibility
         tree below, since a value that changes every second is noise there. */
      role={onOpen ? 'button' : 'group'}
      tabIndex={onOpen ? 0 : undefined}
      aria-label={onOpen ? 'Tournament Clock - Open Tournament Lobby' : 'Tournament Clock'}
      onClick={onOpen}
      onKeyDown={
        onOpen
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen();
              }
            }
          : undefined
      }
    >
      {/* Rebuy / add-on window strip - full width, above the segments */}
      {windowBanner && (
        <div
          style={{
            flexBasis: '100%',
            textAlign: 'center',
            padding: '3px 8px',
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: 0.8,
            textTransform: 'uppercase',
            color: '#ffd54f',
            background: 'rgba(255,183,77,0.14)',
            borderBottom: '1px solid rgba(255,183,77,0.25)',
          }}
        >
          {windowBanner}
        </div>
      )}

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
          /* Changes every second; announcing it is noise. The level and blinds
             beside it carry the information that actually matters. */
          aria-hidden="true"
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

      {/* Hero's live rank (Dan 2026-08-30: after the countdown, before Left) */}
      {derivedRank !== null && (
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
            Rank
          </span>
          <span style={{ fontSize: 15, fontWeight: 700 }}>{derivedRank}</span>
        </div>
      )}

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
