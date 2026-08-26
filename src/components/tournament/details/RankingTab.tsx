/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RANKING — the tab that used to be "Chips", rebuilt
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25, verbatim:
 *
 *   "CHIPS SHOULD BE CALLED 'RANKING' AND DISPLAY ALL THE DATA THAT IT DOES BUT
 *    UPDATE IT IN REAL TIME. ALL OF THE PLAYERS RANKS SHOULD BE HERE (ITS
 *    CURRENTLY SQUISHED). WHEN THE HERO LOOKS HERE, IT SHOULD SAY THEIR
 *    'CURRENT POSITION' AT THE TOP, WITH ALL PLAYERS RANKED IN ORDER UNDER
 *    THEM. IF YOU CLICK ON ANY PLAYER, IT SHOULD CREATE A POP UP, 'WATCH THIS
 *    PLAYER LIVE?' AND TAKE YOU DIRECTLY TO THE TABLE TO OBSERVE... IF AN
 *    AGENT, SUPER AGENT, OR SUB AGENT HAS 'DOWNLINES' IN A TOURNAMENT THEY
 *    SHOULD BE HIGHLIGHTED IN THE RANKINGS."
 *
 * It replaces LiveChipCounts (capped at 20 rows, five columns crushed into one
 * 52px line, polled every 10s) and absorbs the old separate TournamentStandings
 * tab (a second unbounded query for the same rows, rendered as cards).
 *
 * ── WHERE THE NUMBERS COME FROM, AND WHY THIS TAB DOES NOT REFETCH ───────────
 *
 * The page already holds `entries` and keeps them fresh over its own realtime
 * channel (TournamentDetails.tsx, the `tournament_players` handler). A tab that
 * re-selects the same thousand rows makes the lobby slower AND lets two tabs
 * print two different chip counts for the same player, which is worse than
 * slow. So props are the base, always.
 *
 * What this tab adds is a SECOND, tiny subscription of its own — postgres
 * changes on `tournament_players` for this tournament — for two reasons that
 * refetching could not serve:
 *
 *   1. it is the only way to know a row CHANGED, as opposed to knowing what it
 *      now says, and a chip movement nobody can see happen may as well not be
 *      realtime. The changed row flashes (`.tl-pulse`).
 *   2. it is a spare tyre. If the page's channel drops, chips keep moving here.
 *
 * The overlay it maintains is deliberately self-erasing: as soon as props catch
 * up to a value the overlay is holding, that overlay entry is dropped. Without
 * that, a stale overlay would out-vote a newer prop forever — a bug that only
 * shows up minutes later and looks like "the board froze for one player".
 *
 * If the subscription never connects, nothing here breaks: the list is still
 * correct, it simply stops flashing. This tab has no error page, by design.
 *
 * ── WHY THERE IS NO WINDOWING LAYER ──────────────────────────────────────────
 *
 * The brief allows virtualisation above ~300 players. Rows here RE-SORT on
 * every chip movement, which is precisely the input that breaks naive fixed-
 * height windowing: the row under the viewport anchor is a different player a
 * second later, so the list jumps under the reader's thumb. Instead every row
 * is `React.memo`'d — so one player's chips re-render one row, not the field —
 * and above the threshold the list gets `content-visibility: auto` with an
 * intrinsic size, which hands the same skip-work-offscreen saving to the
 * browser's own layout engine, where the scroll anchor is its problem and it
 * gets it right. Degrades to plain rendering where unsupported.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { masterBus } from '../../../core/MasterBus';
import { useToast } from '../../common/Toast';
import { useIsMounted } from '../../../hooks/useIsMounted';
import { useMasterBusSubscription } from '../../../hooks/useMasterBusSubscription';
import { openTableAsObserver } from '../../../utils/observeTable';
import { reportError } from '../../../utils/errorReporter';
import { useDownlineIds } from './useDownlineIds';
import { chips, chipsCompact, initials, ordinal, type TournamentTabProps } from './types';
import type { TournamentEntry } from './types';
import '../../../styles/tournament-lobby-3d.css';
import './RankingTab.css';

/** Above this many entries the list asks the browser to skip offscreen work. */
const DENSE_FIELD = 300;

/** How long a changed row stays lit. Matches the `tlPulse` keyframe. */
const PULSE_MS = 900;

/** Patch a realtime event can carry onto a row we already hold. */
interface EntryPatch {
  chips?: number;
  status?: TournamentEntry['status'];
  position?: number;
  table_id?: string | null;
}

/** A player is out when they can no longer be watched playing. */
function isOut(entry: TournamentEntry): boolean {
  return entry.status === 'eliminated' || entry.status === 'finished';
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ONE ROW
// ═══════════════════════════════════════════════════════════════════════════════

interface RankRowProps {
  entry: TournamentEntry;
  /** Live rank among the field, or the finishing position once out. */
  rank: number;
  isHero: boolean;
  isDownline: boolean;
  out: boolean;
  leaderChips: number;
  avgStack: number;
  bigBlind: number;
  tableName?: string;
  pulsing: boolean;
  /**
   * False for anything that is not RUNNING. Dan 2026-08-25 scoped the
   * click-through to a live event, and a finished event's `table_id`s point at
   * closed felts - a row that opens one is worse than a row that does nothing.
   */
  eventRunning: boolean;
  onPick: (entry: TournamentEntry) => void;
}

const RankRow = React.memo(function RankRow({
  entry,
  rank,
  isHero,
  isDownline,
  out,
  leaderChips,
  avgStack,
  bigBlind,
  tableName,
  pulsing,
  eventRunning,
  onPick,
}: RankRowProps) {
  const stack = Number(entry.chips) || 0;
  const bb = bigBlind > 0 ? Math.floor(stack / bigBlind) : null;
  const fillPct = leaderChips > 0 ? Math.min(100, (stack / leaderChips) * 100) : 0;
  const markPct = leaderChips > 0 ? Math.min(100, (avgStack / leaderChips) * 100) : 0;
  const underAverage = avgStack > 0 && stack < avgStack;

  // A player with no seat cannot be watched. Say why on the row rather than
  // opening a dialog whose only outcome is a refusal.
  const watchable = eventRunning && !out && !!entry.table_id;

  const className = [
    'tl-row',
    'rk-row',
    watchable ? 'tl-row--interactive' : 'rk-row--static',
    isHero ? 'tl-row--hero' : '',
    isDownline ? 'tl-row--downline' : '',
    out ? 'tl-row--eliminated' : '',
    pulsing ? 'tl-pulse' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const subText = out
    ? entry.position
      ? `Finished ${ordinal(entry.position)}`
      : 'Eliminated'
    : entry.table_id
      ? tableName || 'At A Table'
      : 'Not Seated Yet';

  const body = (
    <>
      <span className={`tl-rank rk-rank${!out && rank <= 3 ? ' tl-rank--podium' : ''}`}>
        {rank}
      </span>

      {entry.avatar_url ? (
        <img
          className="tl-avatar rk-avatar"
          src={entry.avatar_url}
          alt=""
          loading="lazy"
          decoding="async"
        />
      ) : (
        <span className="tl-avatar rk-avatar" aria-hidden="true">
          {initials(entry.username)}
        </span>
      )}

      <span className="rk-main">
        <span className="rk-nameline">
          <span className="tl-name">{entry.username}</span>
          {isHero && <span className="tl-badge tl-badge--action">You</span>}
          {isDownline && !isHero && <span className="tl-badge">Yours</span>}
        </span>
        <span className="tl-sub rk-sub">{subText}</span>
        {!out && (
          <span className="tl-meter rk-meter">
            <span
              className={`tl-meter__fill${underAverage ? ' tl-meter__fill--under' : ''}`}
              style={{ width: `${fillPct}%` }}
            />
            {avgStack > 0 && (
              <span
                className="tl-meter__mark"
                style={{ left: `${markPct}%` }}
                title="Average Stack"
              />
            )}
          </span>
        )}
      </span>

      <span className="rk-nums">
        <span className={`tl-num${isHero ? ' tl-num--accent' : ''}`}>{chips(stack)}</span>
        <span className="tl-sub rk-bb">{bb === null ? '-' : `${chips(bb)} BB`}</span>
      </span>
    </>
  );

  if (!watchable) {
    return (
      <li className="rk-item">
        <div className={className}>{body}</div>
      </li>
    );
  }

  return (
    <li className="rk-item">
      <button
        type="button"
        className={className}
        onClick={() => onPick(entry)}
        aria-label={`Watch ${entry.username}, ${chips(stack)} chips`}
      >
        {body}
      </button>
    </li>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
//  THE CONFIRMATION
// ═══════════════════════════════════════════════════════════════════════════════

interface WatchModalProps {
  entry: TournamentEntry;
  tableName?: string;
  bigBlind: number;
  onCancel: () => void;
  onConfirm: () => void;
}

function WatchModal({ entry, tableName, bigBlind, onCancel, onConfirm }: WatchModalProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocusRef.current = (document.activeElement as HTMLElement) || null;
    confirmRef.current?.focus();

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        onCancel();
        return;
      }
      if (ev.key !== 'Tab') return;

      // Focus trap. Two buttons, but written generically so adding a third
      // control later cannot silently let focus escape behind the overlay.
      const focusable = boxRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (ev.shiftKey && (active === first || !boxRef.current?.contains(active))) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && active === last) {
        ev.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      returnFocusRef.current?.focus?.();
    };
  }, [onCancel]);

  const stack = Number(entry.chips) || 0;
  const bb = bigBlind > 0 ? Math.floor(stack / bigBlind) : null;

  // Rendered into <body>: the list lives inside an `overflow: auto` panel, and
  // a dialog clipped by its own scroll container is not a dialog.
  return createPortal(
    <div className="rk-overlay" role="presentation" onMouseDown={onCancel}>
      <div
        ref={boxRef}
        className="rk-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rk-modal-title"
        onMouseDown={(ev) => ev.stopPropagation()}
      >
        <h3 className="rk-modal__title" id="rk-modal-title">
          Watch This Player Live?
        </h3>

        <div className="rk-modal__player">
          {entry.avatar_url ? (
            <img className="tl-avatar" src={entry.avatar_url} alt="" decoding="async" />
          ) : (
            <span className="tl-avatar" aria-hidden="true">
              {initials(entry.username)}
            </span>
          )}
          <span className="rk-modal__who">
            <span className="tl-name">{entry.username}</span>
            <span className="tl-sub">{tableName || 'In Play'}</span>
          </span>
          <span className="rk-modal__stack">
            <span className="tl-num tl-num--accent">{chips(stack)}</span>
            <span className="tl-sub">{bb === null ? 'Chips' : `${chips(bb)} BB`}</span>
          </span>
        </div>

        <p className="rk-modal__note">
          This Opens A New Screen. Every Table You Already Have Open Keeps Playing.
        </p>

        <div className="rk-modal__actions">
          <button type="button" className="rk-btn rk-btn--ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="rk-btn rk-btn--go" ref={confirmRef} onClick={onConfirm}>
            Watch
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  THE TAB
// ═══════════════════════════════════════════════════════════════════════════════

export default function RankingTab({
  tournament,
  entries,
  tables,
  blindLevels,
  currentUserId,
  onWatchPlayer,
}: TournamentTabProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const isMounted = useIsMounted();

  const [overlay, setOverlay] = useState<Map<string, EntryPatch>>(() => new Map());
  const [pulsing, setPulsing] = useState<Set<string>>(() => new Set());
  const [picked, setPicked] = useState<TournamentEntry | null>(null);

  const pulseTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const tournamentId = tournament?.id;

  /**
   * The page hands `onWatchPlayer` over only while the event is RUNNING, which
   * is the same gate the footer's WATCH button uses. Reading its presence
   * rather than re-deriving the status keeps one rule in one place.
   */
  const eventRunning = Boolean(onWatchPlayer);

  const { downlineIds, carriesDownline } = useDownlineIds(currentUserId, tournament?.club_id);

  // ── the pulse ───────────────────────────────────────────────────────────────
  const flash = useCallback(
    (userId: string) => {
      if (!userId) return;
      setPulsing((prev) => {
        if (prev.has(userId)) return prev;
        const next = new Set(prev);
        next.add(userId);
        return next;
      });
      const existing = pulseTimers.current.get(userId);
      if (existing) clearTimeout(existing);
      pulseTimers.current.set(
        userId,
        setTimeout(() => {
          pulseTimers.current.delete(userId);
          if (!isMounted.current) return;
          setPulsing((prev) => {
            if (!prev.has(userId)) return prev;
            const next = new Set(prev);
            next.delete(userId);
            return next;
          });
        }, PULSE_MS)
      );
    },
    [isMounted]
  );

  useEffect(() => {
    const timers = pulseTimers.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  // ── realtime: chip movement and eliminations ────────────────────────────────
  useEffect(() => {
    if (!tournamentId) return;

    const channelKey = `ranking-${tournamentId}`;
    let channel: ReturnType<typeof masterBus.getOrCreateChannel> | null = null;

    try {
      channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'tournament_players',
            filter: `tournament_id=eq.${tournamentId}`,
          },
          (payload: { eventType: string; new?: Record<string, unknown> }) => {
            const row = payload?.new as
              | {
                  user_id?: string;
                  chips?: number;
                  status?: string;
                  position?: number | null;
                  table_id?: string | null;
                }
              | undefined;
            if (!row?.user_id) return;
            if (payload.eventType === 'DELETE') return;

            const patch: EntryPatch = {};
            if (typeof row.chips === 'number') patch.chips = row.chips;
            if (typeof row.status === 'string')
              patch.status = row.status as TournamentEntry['status'];
            if (typeof row.position === 'number') patch.position = row.position;
            if (row.table_id !== undefined) patch.table_id = row.table_id;

            setOverlay((prev) => {
              const next = new Map(prev);
              next.set(row.user_id as string, {
                ...(next.get(row.user_id as string) || {}),
                ...patch,
              });
              return next;
            });
            flash(row.user_id);
          }
        )
        .subscribe((status: string, err?: Error) => {
          // A channel that will not connect costs this tab its flashes and
          // nothing else. Report it; do not put it on the player's screen.
          if (status === 'CHANNEL_ERROR' && err) {
            reportError(err?.message || err, 'RankingTab.Realtime_channel_error');
          }
        });
    } catch (err) {
      reportError(err, 'RankingTab.Realtime_subscribe_failed');
    }

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [tournamentId, flash]);

  // The engine announces eliminations on the bus faster than Postgres
  // replication delivers them, and this is the one change a ranking board must
  // never be late for.
  const onElimination = useCallback(
    (payload: { tournamentId: string; userId: string; position: number }) => {
      if (!tournamentId || payload?.tournamentId !== tournamentId || !payload.userId) return;
      setOverlay((prev) => {
        const next = new Map(prev);
        next.set(payload.userId, {
          ...(next.get(payload.userId) || {}),
          status: 'eliminated',
          position: payload.position,
        });
        return next;
      });
      flash(payload.userId);
    },
    [tournamentId, flash]
  );
  useMasterBusSubscription('PLAYER_ELIMINATED', onElimination);

  // ── the overlay erases itself once props agree ──────────────────────────────
  useEffect(() => {
    setOverlay((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map(prev);
      for (const entry of entries) {
        const held = next.get(entry.user_id);
        if (!held) continue;
        const chipsAgree = held.chips === undefined || held.chips === entry.chips;
        const statusAgree = held.status === undefined || held.status === entry.status;
        const posAgree = held.position === undefined || held.position === entry.position;
        if (chipsAgree && statusAgree && posAgree) {
          next.delete(entry.user_id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [entries]);

  // ── derived board ───────────────────────────────────────────────────────────
  const merged = useMemo<TournamentEntry[]>(() => {
    if (overlay.size === 0) return entries;
    return entries.map((e) => {
      const patch = overlay.get(e.user_id);
      return patch ? { ...e, ...patch } : e;
    });
  }, [entries, overlay]);

  const ordered = useMemo(() => {
    const copy = [...merged];
    copy.sort((a, b) => {
      const aOut = isOut(a);
      const bOut = isOut(b);
      if (aOut !== bOut) return aOut ? 1 : -1;
      if (aOut && bOut) {
        // Eliminated players read best in finishing order: the deepest run
        // first, so "who went out last" is the top of the finished block.
        return (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER);
      }
      const diff = (Number(b.chips) || 0) - (Number(a.chips) || 0);
      if (diff !== 0) return diff;
      return (a.username || '').localeCompare(b.username || '');
    });
    return copy;
  }, [merged]);

  const living = useMemo(() => ordered.filter((e) => !isOut(e)), [ordered]);

  const totalChips = useMemo(
    () => living.reduce((sum, e) => sum + (Number(e.chips) || 0), 0),
    [living]
  );
  const avgStack = living.length > 0 ? totalChips / living.length : 0;
  const leaderChips = living.length > 0 ? Number(living[0].chips) || 0 : 0;

  const bigBlind = useMemo(() => {
    const playable = blindLevels.filter((l) => !l.isBreak && l.bigBlind > 0);
    if (playable.length === 0) {
      const seated = tables.find((t) => (t.big_blind || 0) > 0);
      return seated?.big_blind || 0;
    }
    const level = Math.max(1, Number(tournament?.current_level) || 1);
    const exact = playable.find((l) => l.level === level);
    if (exact) return exact.bigBlind;
    // Levels can be sparse or misnumbered on old structures; fall back to the
    // nearest one at or below the current level, then to the first.
    const below = playable.filter((l) => l.level <= level);
    return below.length > 0 ? below[below.length - 1].bigBlind : playable[0].bigBlind;
  }, [blindLevels, tables, tournament?.current_level]);

  const tableNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tables) if (t.id) map.set(t.id, t.name);
    return map;
  }, [tables]);

  const heroIndex = useMemo(
    () => (currentUserId ? ordered.findIndex((e) => e.user_id === currentUserId) : -1),
    [ordered, currentUserId]
  );
  const hero = heroIndex >= 0 ? ordered[heroIndex] : null;

  const downlineInEvent = useMemo(() => {
    if (!carriesDownline || downlineIds.size === 0) return 0;
    let count = 0;
    for (const e of ordered) if (downlineIds.has(e.user_id)) count += 1;
    return count;
  }, [ordered, downlineIds, carriesDownline]);

  // ── watch flow ──────────────────────────────────────────────────────────────
  const handlePick = useCallback((entry: TournamentEntry) => {
    setPicked(entry);
  }, []);

  const confirmWatch = useCallback(() => {
    const entry = picked;
    setPicked(null);
    if (!entry?.table_id) return;
    const opened = openTableAsObserver(navigate, {
      tableId: entry.table_id,
      tableName: tableNameById.get(entry.table_id) || entry.username,
    });
    // Only reachable if the seat vanished between the click and the confirm.
    if (!opened) toast.warning('That Player Is No Longer Seated');
  }, [picked, navigate, tableNameById, toast]);

  // ── render ──────────────────────────────────────────────────────────────────
  if (entries.length === 0) {
    return (
      <div className="tl-panel rk-panel">
        <div className="tl-empty">
          <span>No Players Yet</span>
          <span className="tl-empty__hint">Rankings Appear As Soon As The Field Fills</span>
        </div>
      </div>
    );
  }

  const heroStack = hero ? Number(hero.chips) || 0 : 0;
  const heroBB = hero && bigBlind > 0 ? Math.floor(heroStack / bigBlind) : null;
  const heroOut = hero ? isOut(hero) : false;
  const heroAboveAvg = heroStack >= avgStack;

  return (
    <div className="tl-panel rk-panel">
      {/* ── Field summary ──────────────────────────────────────────────── */}
      <div className="tl-stat-grid rk-stats">
        <div className="tl-stat">
          <span className="tl-stat__label">Remaining</span>
          <span className="tl-stat__value tl-stat__value--accent">{chips(living.length)}</span>
          <span className="tl-stat__sub">Of {chips(ordered.length)}</span>
        </div>
        <div className="tl-stat">
          <span className="tl-stat__label">Average Stack</span>
          <span className="tl-stat__value">{chipsCompact(avgStack)}</span>
          <span className="tl-stat__sub">
            {bigBlind > 0 ? `${chips(Math.floor(avgStack / bigBlind))} BB` : 'Chips'}
          </span>
        </div>
        <div className="tl-stat">
          <span className="tl-stat__label">Total Chips</span>
          <span className="tl-stat__value">{chipsCompact(totalChips)}</span>
          <span className="tl-stat__sub">In Play</span>
        </div>
      </div>

      {/* ── Your position: pinned, and absent entirely when it is not yours ── */}
      {hero && (
        <div className={`rk-hero${heroOut ? ' rk-hero--out' : ''}`}>
          <div className="rk-hero__head">
            <span className="rk-hero__label">
              {heroOut ? 'You Finished' : 'Your Current Position'}
            </span>
            <span className="rk-hero__rank">
              {heroOut ? ordinal(hero.position || heroIndex + 1) : ordinal(heroIndex + 1)}
            </span>
          </div>
          <div className="rk-hero__figures">
            <span className="rk-hero__figure">
              <span className="tl-stat__label">Chips</span>
              <span className="tl-num tl-num--accent">{chips(heroStack)}</span>
            </span>
            <span className="rk-hero__figure">
              <span className="tl-stat__label">Big Blinds</span>
              <span className="tl-num">{heroBB === null ? '-' : chips(heroBB)}</span>
            </span>
            <span className="rk-hero__figure">
              <span className="tl-stat__label">Versus Average</span>
              <span
                className={`tl-badge ${heroOut ? 'tl-badge--mute' : heroAboveAvg ? 'tl-badge--good' : 'tl-badge--danger'}`}
              >
                {heroOut ? 'Out' : heroAboveAvg ? 'Above' : 'Below'}
              </span>
            </span>
          </div>
        </div>
      )}

      {/* ── Downline legend: only ever drawn for someone who has one ─────── */}
      {downlineInEvent > 0 && (
        <div className="rk-legend">
          <span className="rk-legend__swatch" aria-hidden="true" />
          <span>
            {chips(downlineInEvent)}{' '}
            {downlineInEvent === 1 ? 'Of Your Players Is' : 'Of Your Players Are'} In This Event
          </span>
        </div>
      )}

      <div className="tl-section-head rk-head">
        <h3>Ranking</h3>
        <span className="tl-section-note">Marker Shows The Average Stack</span>
      </div>

      {/* The list scrolls inside itself, so the page keeps one scrollbar and
          the locked footer below it never moves. */}
      <ul
        className={`tl-list tl-scroll rk-list${ordered.length > DENSE_FIELD ? ' rk-list--dense' : ''}`}
      >
        {ordered.map((entry, index) => {
          const out = isOut(entry);
          return (
            <RankRow
              key={entry.id || entry.user_id}
              entry={entry}
              rank={out ? entry.position || index + 1 : index + 1}
              isHero={!!currentUserId && entry.user_id === currentUserId}
              isDownline={downlineIds.has(entry.user_id)}
              out={out}
              leaderChips={leaderChips}
              avgStack={avgStack}
              bigBlind={bigBlind}
              tableName={entry.table_id ? tableNameById.get(entry.table_id) : undefined}
              pulsing={pulsing.has(entry.user_id)}
              eventRunning={eventRunning}
              onPick={handlePick}
            />
          );
        })}
      </ul>

      {picked && (
        <WatchModal
          entry={picked}
          tableName={picked.table_id ? tableNameById.get(picked.table_id) : undefined}
          bigBlind={bigBlind}
          onCancel={() => setPicked(null)}
          onConfirm={confirmWatch}
        />
      )}
    </div>
  );
}
