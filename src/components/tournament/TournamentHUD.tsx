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
 *   • Drop-in: self-fetches by tournamentId. TablePage passes the id and
 *     `hidden` when its table is not the one on screen.
 *   • Server-authoritative: the level and countdown come from the engine-persisted
 *     tournaments.current_level / level_started_at via
 *     tournamentService.getCurrentLevelState(), measured on the ENGINE's clock
 *     (serverNow) rather than this device's. A real break (on_break /
 *     break_ends_at, or the add-on break at the end of the persisted add-on
 *     window) shows its own countdown, because the engine suspends the level
 *     clock for it.
 *   • Standalone styling: all styles are inline, so there is NO extra CSS file to
 *     import and nothing to wire into a build.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 *  IT LISTENS, AND CATCHES UP WHEN IT MAY HAVE MISSED SOMETHING (2026-09-22)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This bar used to re-read the whole tournament row (~95 columns plus the club
 * embed) every 45 seconds, per open table, hidden or not, and again on every
 * elimination anywhere in the field - plus the whole field of player rows on
 * every level. Its failure handling never engaged: getTournament was called
 * without `throwOnError`, so a failed read came back as null, the bar vanished
 * and the failure count reset. And it held its own binding on `t-break-<id>`,
 * which cannot be removed while TablePage still holds the channel, so every
 * remount left one more live listener firing reads.
 *
 * Now:
 *   • EVENTS. TablePage already joins `t-break-<id>` and relays every broadcast
 *     onto MasterBus (tournamentEventBridge). This bar only subscribes to the
 *     bus, and unsubscribes on unmount, on an account or tournament switch and
 *     once the event is over. A level change also arrives from the engine's
 *     table socket (TOURNAMENT_LEVEL_UP); either carrier triggers one read.
 *   • ONE READER. One read in flight plus one trailing, owned by this
 *     (tournament, account, mount). A response for any other owner is
 *     dropped, so a late answer can never paint another account or event.
 *   • A FAILED READ KEEPS THE LAST CONFIRMED ROW. Real failures (a thrown
 *     PostgREST error, or no row) count, report the first two, and retry at
 *     5s, 10s, 20s ... up to five minutes. A success resets the ladder.
 *   • BOUNDED CATCH-UP where the broadcast could have been missed: on mount;
 *     when the shared channel (re)joins; when the tab or the table comes back
 *     on screen; when the engine link reconnects; when a level, break or
 *     start time passes with no event (a few reads, then it stops); and on a
 *     level_up that skips a level.
 *   • A FIVE-MINUTE SAFETY READ, only while the bar is on screen. The
 *     broadcasts carry no sequence number and are never replayed, and a
 *     failed engine broadcast is not retried, so late registration, the
 *     add-on window and the prize pool have no deadline to notice a lost
 *     event by. Five minutes bounds how long one can go unseen.
 *   • LEFT / RANK / AVG are re-read at most once per ten seconds, trailing the
 *     busts that moved them, and bubble_burst's own count shows at once.
 */

import { useEffect, useRef, useState } from 'react';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useTournamentHandForHand } from '../../hooks/useTournamentHandForHand';
import { tournamentService } from '../../services/TournamentService';
import { engineChannelClient } from '../../services/EngineStateClient';
import type { Tournament } from '../../types/database.types';
import { masterBus } from '../../core/MasterBus';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import { serverNow } from '../../utils/serverClock';
import {
  tournamentEntryWindow,
  tournamentEntryWindowOpen,
} from '../../utils/tournamentEntryWindow';

interface TournamentHUDProps {
  tournamentId: string;
  /** Optional override; if omitted the HUD derives it from live player rows. */
  playersRemaining?: number;
  /** Optional override for average stack display. */
  averageStack?: number;
  /** Spin prize pool replaces the low-value average stack readout. */
  spinPrizePool?: number;
  /**
   * The table is not on screen (a background slot in single view, or the
   * whole table layer while the player is elsewhere in the app). The bar
   * renders nothing, stops its clock and asks nothing until it is shown again.
   */
  hidden?: boolean;
  /**
   * Dan 2026-08-30: "IF YOU CLICK THE LEVEL TAB BUTTON IT WILL OPEN TO THE
   * TOURNAMENT LOBBY INSTANTLY." When provided, the whole bar is a button
   * that opens the in-game tournament lobby popup. The stats icon that used
   * to sit beside the bar is gone - the bar itself is the entry point.
   */
  onOpen?: () => void;
}

/**
 * Nothing left to ask once the event is over. A DENY-list of terminal states:
 * an allow-list of live ones once stopped the bar on ANNOUNCED, a perfectly
 * live status, and it never started again. Anything unrecognised stays live.
 */
const TERMINAL = ['COMPLETED', 'CANCELLED', 'FINISHED', 'ABORTED'];
/** The long safety read, only while the bar is on screen. See the header. */
const SAFETY_READ_MS = 300_000;
/** The first retry after a failed read; each further failure doubles it. */
const RETRY_BASE_MS = 5_000;
/** Where the retry ladder stops widening: a sustained fault reads every 5 min. */
const BACKOFF_MS = 300_000;
/** The first failures of a run are information; the rest are noise. */
const REPORT_LIMIT = 2;
/** Left / Rank / Avg trail the busts that moved them by this much. */
const FIELD_READ_DELAY_MS = 10_000;
/**
 * A level, break or start time has passed and no event said so. Read at these
 * offsets after it passed, then stop: four reads, not a poll.
 */
const DEADLINE_CATCH_UP_MS = [5_000, 15_000, 45_000, 120_000];
const TICK_MS = 1_000;

const isTerminal = (status: unknown) => TERMINAL.includes(String(status ?? '').toUpperCase());

const documentHidden = () => typeof document !== 'undefined' && document.hidden === true;

const scopeKeyOf = (tournamentId: string, userId: string | undefined) =>
  `${tournamentId}|${userId ?? ''}`;

/** Epoch ms, or null for absent/unparseable. Never NaN, never a silent zero. */
function epochMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const t = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

/** A non-negative integer, or null. `Number(null)` is 0, and 0 is a real level. */
function wholeNumberOf(value: unknown): number | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
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

/**
 * Is play stopped for a break, and until when?
 *
 * `on_break` / `break_ends_at` are the synchronized break's own columns
 * (TournamentManagerBase.pauseForBreak, beginBreakCountdown, and the release
 * that clears both with the credited level anchor in one row version).
 * `break_ends_at` is NULL while the last hand is still being played, so
 * there is no clock to show yet. As TournamentClock does, a stamped end still
 * in the future counts on its own.
 *
 * The add-on break is not a column: it is the final `addon_break_minutes`
 * (1 to 10, default 1) of the persisted add-on window, exactly the arithmetic
 * TournamentManagerBase.addOnBreakStartMs uses to schedule it.
 */
type HudPause =
  | { kind: 'none' }
  | { kind: 'break'; endsAtMs: number | null }
  | { kind: 'addon'; endsAtMs: number };

function addOnBreakMs(row: Tournament): number {
  const configured = Number(row.addon_break_minutes ?? 1);
  const minutes = Math.min(
    10,
    Math.max(1, Number.isFinite(configured) ? Math.floor(configured) : 1)
  );
  return minutes * 60_000;
}

function hudPause(row: Tournament, nowMs: number): HudPause {
  if (String(row.status ?? '').toUpperCase() !== 'RUNNING') return { kind: 'none' };
  const breakEndsAt = epochMs(row.break_ends_at);
  if (row.on_break === true || (breakEndsAt !== null && breakEndsAt > nowMs)) {
    return { kind: 'break', endsAtMs: breakEndsAt };
  }
  const addOnStarts = epochMs(row.addon_period_started_at);
  const addOnEnds = epochMs(row.addon_period_ends_at);
  if (
    addOnStarts !== null &&
    addOnEnds !== null &&
    nowMs < addOnEnds &&
    nowMs >= Math.max(addOnStarts, addOnEnds - addOnBreakMs(row))
  ) {
    return { kind: 'addon', endsAtMs: addOnEnds };
  }
  return { kind: 'none' };
}

/**
 * The instant this row stops describing the event, and the event that should
 * have arrived by then: the start time (pre-start), the break's end, or the
 * level's end. Null when nothing is due.
 */
function rowDeadline(row: Tournament, nowMs: number): { key: string; atMs: number } | null {
  const status = String(row.status ?? '').toUpperCase();
  if (isTerminal(status)) return null;
  // Multi-day, between days: live (not terminal) but nothing on the row is
  // due; the resume arrives as a status change, not at a predictable instant.
  if (status === 'BAGGED') return null;
  if (status !== 'RUNNING') {
    const startsAt = epochMs(row.start_time);
    return startsAt === null ? null : { key: `start:${startsAt}`, atMs: startsAt };
  }
  const pause = hudPause(row, nowMs);
  if (pause.kind === 'break') {
    return pause.endsAtMs === null
      ? null
      : { key: `break:${pause.endsAtMs}`, atMs: pause.endsAtMs };
  }
  if (pause.kind === 'addon') return { key: `addon:${pause.endsAtMs}`, atMs: pause.endsAtMs };
  // No anchor means the countdown is the whole level; nothing can expire.
  if (!row.level_started_at) return null;
  const state = tournamentService.getCurrentLevelState(row, nowMs);
  return {
    key: `level:${String(row.current_level)}:${String(row.level_started_at)}`,
    atMs: nowMs + state.timeRemainingSeconds * 1000,
  };
}

/** Same arithmetic the lobby uses: only events that actually sell a rebuy say so. */
function sellsRebuys(row: Tournament): boolean {
  return (
    Number(row.rebuy_cost ?? 0) > 0 || Number(row.rebuy_chips ?? 0) > 0 || row.is_reentry === true
  );
}

/**
 * Late registration, from the same projection of fn_tournament_late_registration_open
 * every lobby uses (utils/tournamentEntryWindow): a finalized prize pool, a
 * malformed column or a closed minutes window all read Closed, and Closed
 * shows nothing.
 *
 * Dan 2026-08-30: "WHEN ITS THE LAST LEVEL FOR REBUYS, OR THE ADD ON PERIOD IT
 * SHOULD BE SHOWN AND DISPLAYED IN THE LEVEL BAR." Rebuys close with the entry
 * window, so the last level of that window is the last rebuy level.
 */
function lateRegBanner(row: Tournament, nowMs: number): string | null {
  if (!tournamentEntryWindowOpen(row, nowMs)) return null;
  const entry = tournamentEntryWindow(row);
  if (entry.mode === 'levels') {
    if (entry.current < entry.cap - 1) return `Late Reg Through Level ${entry.cap}`;
    return sellsRebuys(row) ? 'Last Rebuy Level' : 'Last Late Reg Level';
  }
  if (entry.mode === 'minutes') {
    const closesAt = Date.parse(String(row.started_at ?? '')) + entry.minutes * 60_000;
    return `Late Reg Closes In ${fmtClock((closesAt - nowMs) / 1000)}`;
  }
  return null;
}

/** The persisted add-on window, the one the purchase path itself checks. */
function addOnWindowOpen(row: Tournament, nowMs: number): boolean {
  const startsAt = epochMs(row.addon_period_started_at);
  const endsAt = epochMs(row.addon_period_ends_at);
  return startsAt !== null && endsAt !== null && nowMs >= startsAt && nowMs < endsAt;
}

/**
 * Has the shared `t-break-<id>` channel (re)joined since we last looked?
 *
 * TablePage owns that subscription, and a Realtime channel reports SUBSCRIBED
 * only to the component whose subscribe() opened it - a second subscribe() on
 * a joined channel is a no-op that never registers its callback. So this
 * looks rather than listens: the channel's own join reference changes on every
 * successful (re)join, and reading it binds nothing that could outlive us.
 */
function tBreakJoinMarker(tournamentId: string): string | null {
  const topic = `realtime:t-break-${tournamentId}`;
  const channel = supabase.getChannels().find((c) => c.topic === topic);
  if (!channel || String(channel.state) !== 'joined') return null;
  return channel.joinPush?.ref || 'joined';
}

interface HudField {
  remaining: number | null;
  avgStack: number | null;
  rank: number | null;
}

interface HudPaint {
  row(key: string, row: Tournament): void;
  field(key: string, field: HudField): void;
  left(key: string, remaining: number): void;
}

/**
 * Everything one (tournament, account, mount) knows and is waiting for. A new
 * owner is made for every switch; the old one is retired and anything it still
 * has in flight lands nowhere.
 */
class HudFeed {
  readonly key: string;
  readonly tournamentId: string;
  private readonly userId: string | undefined;
  private readonly readsField: boolean;
  private readonly paint: HudPaint;
  /** False once another owner has the screen, or the HUD unmounted. */
  private active = true;
  /** False once the row reads terminal: nothing left to ask. */
  private live = true;
  private started = false;
  private hidden = false;
  /** The first time it is on screen is its mount read, however late that is. */
  private shownOnce = false;
  private row: Tournament | null = null;
  private lastGoodAt = 0;
  // The row reader: one read in flight, plus one trailing.
  private inFlight = false;
  private pending = false;
  private failures = 0;
  private readTimer: ReturnType<typeof setTimeout> | null = null;
  /** Break facts that arrived while a read was in flight, re-applied to its answer. */
  private patches: Array<(row: Tournament) => Tournament> | null = null;
  /** Something may have moved while this bar could not look. Read when it can. */
  private dirty = false;
  /** Highest level index already asked about, so two carriers cost one read. */
  private levelAsked = -1;
  // The field reader (Left / Rank / Avg).
  private fieldTimer: ReturnType<typeof setTimeout> | null = null;
  private fieldInFlight = false;
  private fieldPending = false;
  private fieldDirty = false;
  private leftSeq = 0;
  private leftPatch: { value: number; seq: number } | null = null;
  // Catch-up bookkeeping.
  private deadline: { key: string; expiredAt: number | null; attempts: number } | null = null;
  private joinMarker: string | null;

  constructor(
    tournamentId: string,
    userId: string | undefined,
    readsField: boolean,
    paint: HudPaint
  ) {
    this.tournamentId = tournamentId;
    this.userId = userId;
    this.readsField = readsField;
    this.paint = paint;
    this.key = scopeKeyOf(tournamentId, userId);
    this.joinMarker = tBreakJoinMarker(tournamentId);
  }

  /** The first call starts the feed; later calls follow the table on and off screen. */
  setHidden(hidden: boolean): void {
    if (!this.active || (this.started && hidden === this.hidden)) return;
    this.started = true;
    this.hidden = hidden;
    if (hidden) {
      // Off screen: stop spending. Whatever arrives meanwhile marks it dirty.
      this.clearReadTimer();
      this.parkFieldTimer();
      return;
    }
    if (!this.shownOnce) {
      this.shownOnce = true;
      this.readRow('mount');
      this.readField();
      return;
    }
    const stale = !this.row || this.failures > 0 || Date.now() - this.lastGoodAt >= SAFETY_READ_MS;
    if (this.dirty || stale) this.readRow('shown');
    else this.scheduleNextRead();
    if (this.fieldDirty) this.requestFieldRead();
  }

  /** The tab came back (or went away). Coming back is the likeliest moment to be stale. */
  onDocumentVisibility(): void {
    if (!this.active || !this.live || !this.started) return;
    if (documentHidden()) {
      this.clearReadTimer();
      this.parkFieldTimer();
      return;
    }
    if (this.hidden) {
      this.dirty = true;
      return;
    }
    this.catchUp('visible');
  }

  catchUp(reason: string): void {
    this.readRow(reason);
    this.requestFieldRead();
  }

  /** Once a second while on screen: the channel's join, and anything overdue. */
  tick(): void {
    if (!this.active || !this.live || !this.started || this.hidden || documentHidden()) return;
    const marker = tBreakJoinMarker(this.tournamentId);
    const rejoined = marker !== null && marker !== this.joinMarker;
    this.joinMarker = marker;
    if (rejoined) this.catchUp('channel-joined');
    this.checkDeadline();
  }

  /** A level change from either carrier. `index` is zero-based, or null if unreadable. */
  onLevel(index: number | null): void {
    if (!this.active || !this.live) return;
    const known = wholeNumberOf(this.row?.current_level);
    if (index !== null) {
      if ((known !== null && index <= known) || index <= this.levelAsked) return;
      this.levelAsked = index;
    }
    this.readRow(index !== null && known !== null && index > known + 1 ? 'level-gap' : 'level');
  }

  /**
   * `tournament_break` (last hand, no end yet) or `tournament_break_started`
   * (the real end). The payload is what the engine just persisted, so it is
   * applied as it stands - and to any read already in flight, whose answer
   * may predate it.
   */
  onBreakStarted(breakEndsAt: string | null): void {
    if (!this.active || !this.live) return;
    const patch = (row: Tournament): Tournament => {
      const heldEnd = epochMs(row.break_ends_at);
      const held = row.on_break === true && heldEnd !== null && heldEnd > serverNow();
      return {
        ...row,
        on_break: true,
        break_ends_at: breakEndsAt ?? (held ? row.break_ends_at : null),
      };
    };
    this.patches?.push(patch);
    if (!this.row) return;
    this.row = patch(this.row);
    this.paint.row(this.key, this.row);
  }

  /** The release re-anchors level_started_at, which the broadcast does not carry. */
  onBreakEnded(): void {
    this.readRow('break-ended');
  }

  onUpdated(status: string, playersRemaining: number | null): void {
    if (!this.active || !this.live) return;
    // The relay publishes BLIND_LEVEL_CHANGE beside this; that carries the level.
    if (status.startsWith('blind_level_')) return;
    if (status === 'bubble_burst') {
      if (this.readsField && playersRemaining !== null) {
        this.leftSeq += 1;
        this.leftPatch = { value: playersRemaining, seq: this.leftSeq };
        this.paint.left(this.key, playersRemaining);
      }
      this.requestFieldRead();
      return;
    }
    if (status === 'final_table') {
      this.requestFieldRead();
      return;
    }
    // late_reg_closed, addon_period_start, or a client-side change to the row.
    this.readRow(status ? `updated:${status}` : 'updated');
  }

  /** A bust moves Left / Rank / Avg, not the tournament row. */
  onElimination(): void {
    this.requestFieldRead();
  }

  retire(): void {
    this.active = false;
    this.patches = null;
    this.stopTimers();
  }

  // ── the row ──────────────────────────────────────────────────────────────

  private readRow(reason: string): void {
    if (!this.active || !this.live || !this.started) return;
    if (this.hidden || documentHidden()) {
      this.dirty = true;
      return;
    }
    if (this.inFlight) {
      this.pending = true;
      return;
    }
    this.clearReadTimer();
    this.inFlight = true;
    void this.runReads(reason);
  }

  private async runReads(reason: string): Promise<void> {
    let why = reason;
    try {
      do {
        this.pending = false;
        this.dirty = false;
        // Any join before this read is covered by it.
        this.joinMarker = tBreakJoinMarker(this.tournamentId);
        await this.readRowOnce(why);
        why = 'trailing';
      } while (this.pending && this.active && this.live && !this.hidden && !documentHidden());
    } finally {
      this.inFlight = false;
      if (this.pending) {
        this.pending = false;
        this.dirty = true;
      }
      this.scheduleNextRead();
    }
  }

  private async readRowOnce(reason: string): Promise<void> {
    this.patches = [];
    let row: Tournament | null = null;
    let failure: unknown = null;
    try {
      row = await tournamentService.getTournament(this.tournamentId, { throwOnError: true });
    } catch (error) {
      failure = error;
    }
    const patches = this.patches ?? [];
    this.patches = null;
    // Retired while in flight: another owner has the screen now.
    if (!this.active) return;
    if (!row) {
      // Unknown is not "gone": the last confirmed row stays on screen.
      this.failures += 1;
      if (this.failures <= REPORT_LIMIT) {
        reportError(failure ?? new Error('Tournament Row Not Returned'), 'TournamentHUD.load', {
          tournamentId: this.tournamentId,
          failures: this.failures,
          reason,
        });
      }
      return;
    }
    const next = patches.reduce((current, patch) => patch(current), row);
    const levelMoved = this.row !== null && this.row.current_level !== next.current_level;
    this.failures = 0;
    this.lastGoodAt = Date.now();
    this.row = next;
    if (isTerminal(next.status)) {
      this.live = false;
      this.stopTimers();
    }
    this.paint.row(this.key, next);
    if (this.live && levelMoved) this.requestFieldRead();
  }

  private scheduleNextRead(): void {
    this.clearReadTimer();
    if (!this.active || !this.live || !this.started || this.inFlight) return;
    if (this.hidden || documentHidden()) return;
    const delay =
      this.failures > 0
        ? Math.min(RETRY_BASE_MS * 2 ** (this.failures - 1), BACKOFF_MS)
        : Math.max(0, this.lastGoodAt + SAFETY_READ_MS - Date.now());
    this.readTimer = setTimeout(() => {
      this.readTimer = null;
      this.readRow(this.failures > 0 ? 'retry' : 'safety');
    }, delay);
  }

  private checkDeadline(): void {
    if (!this.row) return;
    const nowMs = serverNow();
    const due = rowDeadline(this.row, nowMs);
    if (!due) {
      this.deadline = null;
      return;
    }
    let watch = this.deadline;
    if (!watch || watch.key !== due.key) {
      watch = { key: due.key, expiredAt: null, attempts: 0 };
      this.deadline = watch;
    }
    if (nowMs < due.atMs) return;
    if (watch.expiredAt === null) watch.expiredAt = nowMs;
    if (watch.attempts >= DEADLINE_CATCH_UP_MS.length) return;
    if (nowMs - watch.expiredAt < DEADLINE_CATCH_UP_MS[watch.attempts]) return;
    watch.attempts += 1;
    this.readRow(`deadline:${due.key.split(':')[0]}`);
  }

  // ── the field (Left / Rank / Avg) ───────────────────────────────────────

  requestFieldRead(): void {
    if (!this.readsField || !this.active || !this.live || !this.started) return;
    if (this.hidden || documentHidden()) {
      this.fieldDirty = true;
      return;
    }
    // One trailing read is already on its way; this bust rides it.
    if (this.fieldTimer) return;
    this.fieldTimer = setTimeout(() => {
      this.fieldTimer = null;
      this.readField();
    }, FIELD_READ_DELAY_MS);
  }

  private readField(): void {
    if (!this.readsField || !this.active || !this.live) return;
    if (this.hidden || documentHidden()) {
      this.fieldDirty = true;
      return;
    }
    if (this.fieldInFlight) {
      this.fieldPending = true;
      return;
    }
    this.fieldInFlight = true;
    void this.runFieldReads();
  }

  private async runFieldReads(): Promise<void> {
    try {
      do {
        this.fieldPending = false;
        this.fieldDirty = false;
        await this.readFieldOnce();
      } while (this.fieldPending && this.active && this.live && !this.hidden && !documentHidden());
    } finally {
      this.fieldInFlight = false;
      if (this.fieldPending) {
        this.fieldPending = false;
        this.fieldDirty = true;
      }
    }
  }

  private async readFieldOnce(): Promise<void> {
    const seqAtStart = this.leftSeq;
    let rows: unknown = null;
    try {
      const { data, error } = await supabase
        .from('tournament_players')
        .select('user_id, chips, status')
        .eq('tournament_id', this.tournamentId)
        .in('status', ['playing', 'registered']);
      if (!error) rows = data;
    } catch {
      /* optional enrichment: the last figures stay on screen */
    }
    if (!this.active || !Array.isArray(rows)) return;
    const field = rows as Array<{ user_id?: string; chips?: number | null }>;
    const totalChips = field.reduce((sum, r) => sum + (r.chips || 0), 0);
    /* Rank = 1 + players with strictly more chips. Ties share the better
       rank, which is how every tournament lobby already counts it. */
    const hero = this.userId ? field.find((r) => r.user_id === this.userId) : undefined;
    const heroChips = hero ? hero.chips || 0 : 0;
    // A bubble count that arrived after this read began is the newer fact.
    const bubble = this.leftPatch && this.leftPatch.seq > seqAtStart ? this.leftPatch : null;
    if (!bubble) this.leftPatch = null;
    this.paint.field(this.key, {
      remaining: bubble ? bubble.value : field.length,
      avgStack: field.length ? Math.trunc(totalChips / field.length) : 0,
      rank: hero ? 1 + field.filter((r) => (r.chips || 0) > heroChips).length : null,
    });
  }

  // ── timers ───────────────────────────────────────────────────────────────

  private clearReadTimer(): void {
    if (this.readTimer) clearTimeout(this.readTimer);
    this.readTimer = null;
  }

  /** A trailing field read that cannot run now is owed, not dropped. */
  private parkFieldTimer(): void {
    if (!this.fieldTimer) return;
    clearTimeout(this.fieldTimer);
    this.fieldTimer = null;
    this.fieldDirty = true;
  }

  private stopTimers(): void {
    this.clearReadTimer();
    if (this.fieldTimer) clearTimeout(this.fieldTimer);
    this.fieldTimer = null;
  }
}

export function TournamentHUD({
  tournamentId,
  playersRemaining,
  averageStack,
  spinPrizePool,
  hidden = false,
  onOpen,
}: TournamentHUDProps) {
  const { user } = useAuthUser();
  const userId = user?.id;
  const readsField = playersRemaining === undefined || averageStack === undefined;
  const scopeKey = scopeKeyOf(tournamentId, userId);
  const [shown, setShown] = useState<{ key: string; row: Tournament } | null>(null);
  const [field, setField] = useState<(HudField & { key: string }) | null>(null);
  const [, setTick] = useState(0); // forces a 1s re-render for the countdown
  const feedRef = useRef<HudFeed | null>(null);

  // Only this owner's answers are ever drawn: a row read for another event or
  // another account is not this bar's row, however recently it arrived.
  const row = shown && shown.key === scopeKey ? shown.row : null;
  const status = String(row?.status ?? '').toUpperCase();
  const live = !isTerminal(status);
  const running = status === 'RUNNING';
  const handForHand = useTournamentHandForHand(tournamentId, userId, running && !hidden);

  // ── One feed per tournament, per account, per mount ──
  useEffect(() => {
    if (!tournamentId) return;
    const feed = new HudFeed(tournamentId, userId, readsField, {
      row: (key, next) => setShown({ key, row: next }),
      field: (key, next) => setField({ key, ...next }),
      left: (key, remaining) =>
        setField((prev) =>
          prev && prev.key === key
            ? { ...prev, remaining }
            : { key, remaining, avgStack: null, rank: null }
        ),
    });
    feedRef.current = feed;
    return () => {
      feed.retire();
      if (feedRef.current === feed) feedRef.current = null;
    };
  }, [tournamentId, userId, readsField]);

  // ── On screen or not: starts the feed, parks it, and catches it up ──
  useEffect(() => {
    feedRef.current?.setHidden(hidden);
  }, [scopeKey, readsField, hidden]);

  // ── Listeners, only while the event can still change ──
  useEffect(() => {
    const feed = feedRef.current;
    if (!feed || !live) return;
    const mine = (payload: { tournamentId?: unknown } | null | undefined) =>
      payload?.tournamentId === feed.tournamentId;
    const stops: Array<() => void> = [
      // The relay converts the engine's index to the DISPLAY level; undo it once.
      masterBus.subscribe('BLIND_LEVEL_CHANGE', ({ payload }) => {
        if (!mine(payload)) return;
        const display = wholeNumberOf(payload.level);
        feed.onLevel(display !== null && display >= 1 ? display - 1 : null);
      }),
      // The engine's own table socket carries the same level, index and all.
      masterBus.subscribe('TOURNAMENT_LEVEL_UP', ({ payload }) => {
        const data = (payload ?? {}) as Record<string, unknown>;
        if ((data.tournament_id ?? data.tournamentId) !== feed.tournamentId) return;
        feed.onLevel(wholeNumberOf(data.new_level ?? data.newLevel));
      }),
      masterBus.subscribe('TOURNAMENT_BREAK', ({ payload }) => {
        if (!mine(payload)) return;
        const endsAt = (payload as { breakEndsAt?: unknown }).breakEndsAt;
        feed.onBreakStarted(typeof endsAt === 'string' && epochMs(endsAt) !== null ? endsAt : null);
      }),
      masterBus.subscribe('TOURNAMENT_BREAK_END', ({ payload }) => {
        if (mine(payload)) feed.onBreakEnded();
      }),
      masterBus.subscribe('PLAYER_ELIMINATED', ({ payload }) => {
        if (mine(payload)) feed.onElimination();
      }),
      masterBus.subscribe('TOURNAMENT_UPDATED', ({ payload }) => {
        if (!mine(payload)) return;
        const left = wholeNumberOf((payload as { playersRemaining?: unknown }).playersRemaining);
        feed.onUpdated(String(payload.status ?? ''), left);
      }),
    ];
    // The engine link coming BACK, not its first connect: the mount read has that.
    let connected = engineChannelClient.getStatus() === 'connected';
    let dropped = false;
    stops.push(
      engineChannelClient.onStatusChange((next) => {
        if (next === 'connected') {
          if (dropped) feed.catchUp('engine-reconnected');
          connected = true;
          dropped = false;
        } else if (connected) {
          connected = false;
          dropped = true;
        }
      })
    );
    const onVisibility = () => feed.onDocumentVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      for (const stop of stops) stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [scopeKey, readsField, live]);

  // ── The one-second clock: only while on screen, and only a live event ──
  useEffect(() => {
    const feed = feedRef.current;
    // `hidden` returns null below, so a hidden HUD ticking once a second would
    // re-render nothing, on every open table (2026-08-25 audit).
    if (hidden || !live || !feed) return;
    const clock = setInterval(() => {
      if (documentHidden()) return;
      feed.tick();
      if (running) setTick((n) => (n + 1) % 3600);
    }, TICK_MS);
    return () => clearInterval(clock);
  }, [scopeKey, readsField, hidden, live, running]);

  if (hidden || !row) return null;

  const nowMs = serverNow();
  const levelState = tournamentService.getCurrentLevelState(row, nowMs);
  const cur = levelState.currentLevel;
  const next = levelState.nextLevel;
  const pause = running ? hudPause(row, nowMs) : ({ kind: 'none' } as HudPause);
  const paused = pause.kind !== 'none';
  /** A break row written into the blind ladder itself. */
  const ladderBreak = !!cur?.isBreak;
  const isBreak = paused || ladderBreak;
  const remaining = levelState.timeRemainingSeconds;
  const pauseSeconds =
    pause.kind !== 'none' && pause.endsAtMs !== null
      ? Math.max(0, (pause.endsAtMs - nowMs) / 1000)
      : null;

  const fieldNow = field && field.key === scopeKey ? field : null;
  const shownPlayers =
    playersRemaining !== undefined ? playersRemaining : (fieldNow?.remaining ?? undefined);
  const shownAvg = averageStack !== undefined ? averageStack : (fieldNow?.avgStack ?? undefined);
  /** Dan 2026-08-30: "IT SHOULD ALSO SAY YOUR CURRENT RANK AFTER THE COUNTDOWN
      CLOCK AND BEFORE HOW MANY ARE LEFT." Null while the hero holds no live
      stack in this event (observer, eliminated). */
  const shownRank = fieldNow?.rank ?? null;

  // Urgency color for the countdown (last 60s of a level).
  const timerColor = remaining <= 60 ? '#ff5252' : remaining <= 120 ? '#ffb74d' : '#4fc3f7';
  const clockText = !running
    ? '--:--'
    : paused
      ? pauseSeconds === null
        ? 'Last Hand'
        : fmtClock(pauseSeconds)
      : fmtClock(remaining);
  const clockColor = !running ? '#9aa7ae' : paused ? '#ffb74d' : timerColor;

  const windowBanner = [
    handForHand === true ? 'Hand For Hand' : null,
    lateRegBanner(row, nowMs),
    addOnWindowOpen(row, nowMs) ? 'Add-On Period' : null,
  ]
    .filter(Boolean)
    .join(' · ');

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
      {/* Hand-for-hand / late registration / add-on strip - full width, above the segments */}
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

      {/* Blinds + ante. A real break resumes on these, so they stay; a break
          row in the ladder has none. */}
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
          {ladderBreak || !cur ? '-' : `${fmtChips(cur.smallBlind)} / ${fmtChips(cur.bigBlind)}`}
        </span>
        {!ladderBreak && (cur?.ante ?? 0) > 0 && (
          <span style={{ fontSize: 10, opacity: 0.7 }}>Ante {fmtChips(cur!.ante)}</span>
        )}
      </div>

      {/* Countdown to the next level, or to the end of the break */}
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
          {paused ? 'Resumes' : 'Next'}
        </span>
        <span
          style={{
            fontSize: paused && pauseSeconds === null ? 13 : 18,
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
            color: clockColor,
          }}
          /* Changes every second; announcing it is noise. The level and blinds
             beside it carry the information that actually matters. */
          aria-hidden="true"
        >
          {clockText}
        </span>
        {!paused && next && !next.isBreak && (
          <span style={{ fontSize: 9, opacity: 0.6 }}>
            {fmtChips(next.smallBlind)}/{fmtChips(next.bigBlind)}
          </span>
        )}
        {!paused && next?.isBreak && <span style={{ fontSize: 9, opacity: 0.6 }}>Break Next</span>}
      </div>

      {/* Hero's live rank (Dan 2026-08-30: after the countdown, before Left) */}
      {shownRank !== null && (
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
          <span style={{ fontSize: 15, fontWeight: 700 }}>{shownRank}</span>
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

      {/* Spin prize pool, or average stack for longer tournament formats. */}
      {(spinPrizePool !== undefined || shownAvg !== undefined) && (
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
            {spinPrizePool !== undefined ? 'Prize' : 'Avg'}
          </span>
          <span style={{ fontSize: 15, fontWeight: 700 }}>
            {fmtChips(spinPrizePool ?? shownAvg ?? 0)}
          </span>
        </div>
      )}
    </div>
  );
}

export default TournamentHUD;
