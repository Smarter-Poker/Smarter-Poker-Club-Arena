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
 *      realtime. The changed row flashes, and it flashes in the DIRECTION the
 *      stack moved with the size of the move beside it.
 *   2. it is a spare tyre. If the page's channel drops, chips keep moving here.
 *
 * The overlay it maintains is deliberately self-erasing: as soon as props catch
 * up to a value the overlay is holding, that overlay entry is dropped. Without
 * that, a stale overlay would out-vote a newer prop forever — a bug that only
 * shows up minutes later and looks like "the board froze for one player".
 *
 * Patches are also COALESCED (`FLUSH_MS`). Each event used to re-sort the whole
 * field on its own, so twenty tables finishing a hand inside a second cost
 * twenty sorts and twenty reconciles of a thousand-row list. They now land in
 * one flush, one sort, one paint — see the note on `FLUSH_MS`.
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
import {
  chips,
  chipsCompact,
  initials,
  isPlayerOut,
  ordinal,
  paidPlaceCount,
  type TournamentTabProps,
} from './types';
import type { TournamentEntry } from './types';
import SatelliteSeatBadge from './SatelliteSeatBadge';
import '../../../styles/tournament-lobby-3d.css';
import './RankingTab.css';

/** Above this many entries the list asks the browser to skip offscreen work. */
const DENSE_FIELD = 300;

/** How long a changed row stays lit. Matches the `rkPulse` keyframe. */
const PULSE_MS = 900;

/**
 * How long realtime events are gathered before the board re-sorts.
 *
 * 2026-08-26 audit. Every `postgres_changes` event used to call `setOverlay`
 * on its own, and each one re-ran a full sort of the field plus a reconcile of
 * every row. A hand finishing at each of twenty tables is twenty sorts of a
 * thousand-row list inside a second, and React does not batch across ticks, so
 * a busy MTT thrashed the main thread on the tab a player is most likely to sit
 * on. A quarter-second window collapses a burst into ONE sort and one paint,
 * which is still faster than a human reads a number - and it makes the pulse
 * better, not worse, because the flash now carries the NET move over the window
 * rather than flickering once per row write.
 */
const FLUSH_MS = 250;

/** Which way a stack just moved, for the row that is flashing. */
type PulseDir = 0 | 1 | -1;

interface Pulse {
  dir: PulseDir;
  amount: number;
}

/** Patch a realtime event can carry onto a row we already hold. */
interface EntryPatch {
  chips?: number;
  status?: TournamentEntry['status'];
  position?: number;
  table_id?: string | null;
}

/* `isOut` lives in types.ts now, as `isPlayerOut`, because Detail, Tables and
   Rewards each had their own version and two of them disagreed with this one
   about whether a winner is still in. */
const isOut = isPlayerOut;

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
  /** 0 when the row is not flashing; 1 or -1 for the way the stack just moved. */
  pulseDir: PulseDir;
  /** Signed chip movement behind that flash. Zero when it is not a chip change. */
  pulseAmount: number;
  /**
   * False for anything the page will not let a spectator open. Dan 2026-08-25
   * scoped the click-through to a live event; the page hands the watch handler
   * over for RUNNING and LATE_REG, and withholds it once the event is finished,
   * because a finished event's `table_id`s point at closed felts - a row that
   * opens one is worse than a row that does nothing.
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
  pulseDir,
  pulseAmount,
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
    /* `tl-pulse` alone animates `background-color`, which on a `.tl-row` sits
       UNDER an almost-opaque gradient and was barely visible (2026-08-26
       audit). `rk-row--moved` lights the rim instead, which nothing covers. */
    pulseDir !== 0 ? 'rk-row--moved' : '',
    pulseDir > 0 ? 'rk-row--up' : '',
    pulseDir < 0 ? 'rk-row--down' : '',
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
          {entry.is_satellite_qualifier && <SatelliteSeatBadge />}
          {isHero && <span className="tl-badge tl-badge--action">You</span>}
          {isDownline && !isHero && <span className="tl-badge">Yours</span>}
        </span>
        <span className="tl-sub rk-sub">{subText}</span>
        {!out && (
          <span className="tl-meter rk-meter" aria-hidden="true">
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
        {/* The delta replaces the BB line for the second it is on screen, so a
            move reads as a move rather than as a number that silently differs
            from the one you were looking at. It is never announced: this is a
            board that changes constantly and an aria-live region here would
            talk over everything else on the page. */}
        {pulseDir !== 0 && pulseAmount !== 0 ? (
          <span
            className={`tl-sub rk-delta${pulseDir > 0 ? ' rk-delta--up' : ' rk-delta--down'}`}
            aria-hidden="true"
          >
            {pulseDir > 0 ? '+' : '-'}
            {chipsCompact(Math.abs(pulseAmount))}
          </span>
        ) : (
          <span className="tl-sub rk-bb">{bb === null ? '-' : `${chips(bb)} BB`}</span>
        )}
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
        aria-label={`Watch ${entry.username}, ${chips(stack)} Chips`}
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
  const [pulses, setPulses] = useState<Map<string, Pulse>>(() => new Map());
  const [picked, setPicked] = useState<TournamentEntry | null>(null);
  /** Agent view: show only the players beneath me. Off unless there are any. */
  const [downlineOnly, setDownlineOnly] = useState(false);

  const pulseTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  /** Patches gathered since the last flush, and the timer that will apply them. */
  const pendingPatches = useRef<Map<string, EntryPatch>>(new Map());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * The chip count each player was last SEEN holding, so a patch can say which
   * way the stack moved. Written from the merged board after every render, so
   * at the moment a patch is applied this still holds the previous value.
   */
  const lastChips = useRef<Map<string, number>>(new Map());

  const tournamentId = tournament?.id;

  /**
   * The page hands `onWatchPlayer` over only while the event is RUNNING, which
   * is the same gate the footer's WATCH button uses. Reading its presence
   * rather than re-deriving the status keeps one rule in one place.
   */
  const eventRunning = Boolean(onWatchPlayer);

  const { downlineIds, carriesDownline } = useDownlineIds(currentUserId, tournament?.club_id);

  // ── the pulse ───────────────────────────────────────────────────────────────
  /** Schedule the moment this row's flash goes out. Restarts a running one. */
  const armPulse = useCallback(
    (userId: string) => {
      const existing = pulseTimers.current.get(userId);
      if (existing) clearTimeout(existing);
      pulseTimers.current.set(
        userId,
        setTimeout(() => {
          pulseTimers.current.delete(userId);
          if (!isMounted.current) return;
          setPulses((prev) => {
            if (!prev.has(userId)) return prev;
            const next = new Map(prev);
            next.delete(userId);
            return next;
          });
        }, PULSE_MS)
      );
    },
    [isMounted]
  );

  /**
   * Take one patch and apply it with the rest of this window's, at most once
   * every FLUSH_MS. One sort, one paint, however many rows moved.
   */
  const queuePatch = useCallback(
    (userId: string, patch: EntryPatch) => {
      if (!userId) return;
      const held = pendingPatches.current.get(userId);
      pendingPatches.current.set(userId, held ? { ...held, ...patch } : patch);
      if (flushTimer.current) return;

      flushTimer.current = setTimeout(() => {
        flushTimer.current = null;
        const batch = pendingPatches.current;
        pendingPatches.current = new Map();
        if (!isMounted.current || batch.size === 0) return;

        /* Sized FIRST, and outside both updaters. A React state updater must be
           pure - StrictMode calls it twice - so the timers are armed here and
           the updater only reads the result. */
        const flashes = new Map<string, Pulse>();
        for (const [id, p] of batch) {
          const before = lastChips.current.get(id);
          let dir: PulseDir = 0;
          let amount = 0;
          if (typeof p.chips === 'number' && typeof before === 'number') {
            amount = p.chips - before;
            dir = amount > 0 ? 1 : amount < 0 ? -1 : 0;
          }
          /* A change we cannot size - an elimination, a table move, or the
             first time we have seen this player - still flashes. It just
             flashes neutral rather than claiming a direction. */
          flashes.set(id, { dir: dir === 0 ? 1 : dir, amount: dir === 0 ? 0 : amount });
          armPulse(id);
        }

        setOverlay((prev) => {
          const next = new Map(prev);
          for (const [id, p] of batch) next.set(id, { ...(next.get(id) || {}), ...p });
          return next;
        });

        setPulses((prev) => {
          const next = new Map(prev);
          for (const [id, pulse] of flashes) next.set(id, pulse);
          return next;
        });
      }, FLUSH_MS);
    },
    [isMounted, armPulse]
  );

  useEffect(() => {
    const timers = pulseTimers.current;
    const pending = pendingPatches.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = null;
      pending.clear();
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

            /* Only fields the payload actually carried. An absent key is never
               written, so a partial row can NEVER blank a column that the
               props already hold - the exact way this lobby has broken before. */
            const patch: EntryPatch = {};
            if (typeof row.chips === 'number') patch.chips = row.chips;
            if (typeof row.status === 'string')
              patch.status = row.status as TournamentEntry['status'];
            if (typeof row.position === 'number') patch.position = row.position;
            if (row.table_id !== undefined) patch.table_id = row.table_id;
            if (Object.keys(patch).length === 0) return;

            queuePatch(row.user_id, patch);
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
  }, [tournamentId, queuePatch]);

  // The engine announces eliminations on the bus faster than Postgres
  // replication delivers them, and this is the one change a ranking board must
  // never be late for.
  const onElimination = useCallback(
    (payload: { tournamentId: string; userId: string; position: number }) => {
      if (!tournamentId || payload?.tournamentId !== tournamentId || !payload.userId) return;
      const patch: EntryPatch = { status: 'eliminated' };
      // A bus payload with no position must not overwrite a real one with NaN.
      if (Number.isFinite(Number(payload.position))) patch.position = Number(payload.position);
      queuePatch(payload.userId, patch);
    },
    [tournamentId, queuePatch]
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

  /**
   * Rank is assigned ONCE, over the whole field, before anything is filtered.
   * A downline-only view still shows a player's true position in the event -
   * an agent reading "3rd" needs it to mean third of the field, never third of
   * the four rows their filter happens to leave on screen.
   */
  const ranked = useMemo(
    () =>
      ordered.map((entry, index) => {
        const out = isOut(entry);
        return { entry, out, rank: out ? entry.position || index + 1 : index + 1 };
      }),
    [ordered]
  );

  /* The previous stack for every player on the board, refreshed AFTER each
     render so an incoming patch can still read the value it is replacing. */
  useEffect(() => {
    const seen = lastChips.current;
    for (const e of merged) seen.set(e.user_id, Number(e.chips) || 0);
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
    /**
     * `current_level` IS A 0-BASED INDEX (fixed 2026-08-26).
     *
     * This matched it against the structure's own 1-based `level` field, so it
     * returned the PREVIOUS level's big blind for every level after the first.
     * Every BB figure on this tab divides a stack by this number, and a
     * too-small divisor OVERSTATES the count: the hero card's "Big Blinds",
     * each row's "{n} BB" sub-line, the "Average Stack → n BB" tile and the
     * watch-confirmation dialog all read high — typically by 40-60% on a
     * doubling structure. On a bubble that is "I have 12 BB" when the truth is
     * 8, which is the difference between folding and shoving.
     *
     * Index first. The `level`-field search survives only as the fallback for
     * old sparse structures, where the index may not line up.
     */
    const idx = Math.max(0, Number(tournament?.current_level) || 0);
    const atIndex = blindLevels[idx];
    if (atIndex && !atIndex.isBreak && atIndex.bigBlind > 0) return atIndex.bigBlind;

    // Sparse or misnumbered structure: fall back to the nearest playable level
    // at or below this one, then to the first.
    const level = Number(atIndex?.level) || idx + 1;
    const exact = playable.find((l) => l.level === level);
    if (exact) return exact.bigBlind;
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

  /**
   * An agent's own players, and how they are doing.
   *
   * Dan asked for the downline HIGHLIGHTED so an agent can see "which of his
   * players are in, and how they are doing". A cyan rail answers the first
   * half. This answers the second in one line - how many are still alive, and
   * where the best of them sits - so an agent does not have to scroll a
   * thousand rows to find four.
   */
  const downline = useMemo(() => {
    if (!carriesDownline || downlineIds.size === 0) {
      return { total: 0, alive: 0, bestRank: 0, totalChips: 0 };
    }
    let total = 0;
    let alive = 0;
    let bestRank = 0;
    let totalChips = 0;
    for (const row of ranked) {
      if (!downlineIds.has(row.entry.user_id)) continue;
      total += 1;
      if (row.out) continue;
      alive += 1;
      totalChips += Number(row.entry.chips) || 0;
      if (bestRank === 0 || row.rank < bestRank) bestRank = row.rank;
    }
    return { total, alive, bestRank, totalChips };
  }, [ranked, downlineIds, carriesDownline]);

  /* The filter can only ever be on while there is something to filter to. */
  const canFilterDownline = downline.total > 0;
  const filterActive = downlineOnly && canFilterDownline;

  const visible = useMemo(() => {
    if (!filterActive) return ranked;
    // The hero stays visible under the filter: an agent who is also playing
    // still wants their own row, and a list that hides you is disorienting.
    return ranked.filter(
      (row) =>
        downlineIds.has(row.entry.user_id) ||
        (!!currentUserId && row.entry.user_id === currentUserId)
    );
  }, [ranked, filterActive, downlineIds, currentUserId]);

  /**
   * DISTANCE TO THE MONEY.
   *
   * The number a player in a running tournament wants above everything else on
   * this tab, and the board could not answer it. It is read off the same
   * `payout_structure` parser Rewards and Detail use, so all three agree about
   * where the bubble is - and it renders nothing at all when no structure has
   * been published, rather than claiming the bubble is 0th.
   */
  const paidPlaces = useMemo(
    () => paidPlaceCount(tournament?.payout_structure),
    [tournament?.payout_structure]
  );

  const money = useMemo(() => {
    if (paidPlaces <= 0 || living.length === 0) return null;
    const toBust = living.length - paidPlaces;
    if (toBust <= 0) return { state: 'in' as const, toBust: 0 };
    if (toBust === 1) return { state: 'bubble' as const, toBust: 1 };
    return { state: 'away' as const, toBust };
  }, [paidPlaces, living.length]);

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
  /* How far off the chip lead. Zero when the hero IS the leader, which is a
     different sentence and gets one. */
  const heroLeaderGap = Math.max(0, leaderChips - heroStack);

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

      {/* ── Distance to the money. Absent when no structure is published, so
             this can never claim a bubble that does not exist. ────────────── */}
      {money && (
        <div
          className={`rk-money rk-money--${money.state}`}
          /* Announced ONLY for the two states worth interrupting for: the
             bubble, and the moment the field is all paid. The counting-down
             state changes every time anybody in a thousand-player field busts,
             and a live region on that talks over the whole page - the same
             reason the level clock is `aria-live="off"` on Detail. */
          aria-live={money.state === 'away' ? 'off' : 'polite'}
        >
          <span className="rk-money__label">
            {money.state === 'in'
              ? 'The Field Is In The Money'
              : money.state === 'bubble'
                ? 'On The Bubble'
                : 'To The Money'}
          </span>
          <span className="rk-money__value">
            {money.state === 'in'
              ? `Top ${chips(paidPlaces)} Paid`
              : money.state === 'bubble'
                ? 'One Player To Go'
                : `${chips(money.toBust)} To Bust`}
          </span>
        </div>
      )}

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
              {/* The chip-leader gap, which the board could answer and never
                  did. "Below average" tells a player they are behind; this
                  tells them by how much, which is the number they act on. */}
              <span className="tl-stat__label">
                {heroOut ? 'Versus Average' : heroLeaderGap === 0 ? 'Chip Lead' : 'Off The Lead'}
              </span>
              {heroOut ? (
                <span className="tl-badge tl-badge--mute">Out</span>
              ) : heroLeaderGap === 0 ? (
                <span className="tl-badge tl-badge--good">You Lead</span>
              ) : (
                <span className={`tl-num${heroAboveAvg ? '' : ' rk-hero__behind'}`}>
                  {chipsCompact(heroLeaderGap)}
                </span>
              )}
            </span>
          </div>
        </div>
      )}

      {/* ── Downline: only ever drawn for someone who has one ────────────────
             The count was the whole legend. An agent also wants to know how
             many are still alive and where their best one sits, and to be able
             to see only their own players without scrolling a thousand rows. */}
      {downline.total > 0 && (
        <div className="rk-legend">
          <span className="rk-legend__swatch" aria-hidden="true" />
          <span className="rk-legend__text">
            <span className="rk-legend__line">
              {chips(downline.alive)} Of {chips(downline.total)}{' '}
              {downline.total === 1 ? 'Of Your Players Is' : 'Of Your Players Are'} Still In
            </span>
            {downline.bestRank > 0 && (
              <span className="rk-legend__sub">
                Best {ordinal(downline.bestRank)} - {chipsCompact(downline.totalChips)} Chips
                Between Them
              </span>
            )}
          </span>
          <button
            type="button"
            className={`rk-filter${filterActive ? ' rk-filter--on' : ''}`}
            onClick={() => setDownlineOnly((on) => !on)}
            aria-pressed={filterActive}
          >
            {filterActive ? 'Show All' : 'Mine Only'}
          </button>
        </div>
      )}

      <div className="tl-section-head rk-head">
        <h3>Ranking</h3>
        <span className="tl-section-note">
          {filterActive ? 'Your Players, In Field Order' : 'Marker Shows The Average Stack'}
        </span>
      </div>

      {/* The list scrolls inside itself, so the page keeps one scrollbar and
          the locked footer below it never moves. */}
      <ul
        className={`tl-list tl-scroll rk-list${visible.length > DENSE_FIELD ? ' rk-list--dense' : ''}`}
      >
        {visible.map(({ entry, rank, out }) => {
          const pulse = pulses.get(entry.user_id);
          return (
            <RankRow
              key={entry.id || entry.user_id}
              entry={entry}
              rank={rank}
              isHero={!!currentUserId && entry.user_id === currentUserId}
              isDownline={downlineIds.has(entry.user_id)}
              out={out}
              leaderChips={leaderChips}
              avgStack={avgStack}
              bigBlind={bigBlind}
              tableName={entry.table_id ? tableNameById.get(entry.table_id) : undefined}
              pulseDir={pulse?.dir ?? 0}
              pulseAmount={pulse?.amount ?? 0}
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
