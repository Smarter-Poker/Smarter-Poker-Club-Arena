/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND DETAIL MODAL — PokerBros-grammar hand breakdown (Dan 2026-08-21)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Opened by tapping the Previous Hand card. Two tabs, exactly like the
 * competitor reference:
 *
 *   HAND SUMMARY — main pot, then one row per revealed player: position
 *                  badge, hole cards, made hand, net result (+green / -red).
 *   HAND DETAIL  — street-by-street action log: position badge, player,
 *                  action chip, amount, with the board cards shown at the
 *                  street that revealed them and the running pot on the right.
 *
 * Header carries date/time · stakes · hand number, plus REPLAY (opens the
 * existing HandReplayPlayer) and SHARE (opens the existing ShareHand modal,
 * which already generates permalinks + social links). Bottom bar pages
 * through the session's recent hands (newest = rightmost, like PokerBros'
 * "3/3").
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-08-27 — THE DETAIL TAB IS NOW THE SHARED RUNDOWN
 *
 * Dan: "make sure that smarter.poker looks and feels like this with all the
 * same data points and architecture."
 *
 * The Hand Detail tab renders `HandDetailView` off `buildReplay()` — the same
 * component and the same reconstruction the Bad Beat Jackpot rundown uses, fed
 * by `useHandReplayModel` reading the raw `hand_history` row. That replaces the
 * hand-rolled street walk that used to live here, which was wrong in two ways
 * this file could not see from where it sat:
 *
 *   - it summed `actions[].amount` for the running pot, and the engine writes
 *     that field as the raise-TO level for bet/raise/all_in, so every raised
 *     pot was over-counted (hand 3048511 summed to 392.20 against a real pot
 *     of 324.20);
 *   - its position badges came from `HandHistoryService`, which derives the
 *     button from `players[].isButton` — a field nothing has ever written — so
 *     it resolved to seat 1 on every hand.
 *
 * Both are fixed by reading the row rather than the adapter. The old markup
 * stays as the fallback for a record whose raw row cannot be read (a cached
 * hand, an RLS refusal), so the tab never goes blank.
 *
 * HAND SUMMARY is unchanged: it reads the stored per-player `result`, which is
 * deliberate — see the note on `netOf` below.
 */

import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import type { HandRecord, RunBoards } from './HandHistoryPanel';
import { runBoardsFor } from './HandHistoryPanel';
import HandDetailView from '../handdetail/HandDetailView';
import { useHandReplayModel } from '../../hooks/useHandReplayModel';
import './HandDetailModal.css';
import { gameTypeLabel } from '../../utils/handFormat';
import { StatsFactsService, type HandRakeShare } from '../../services/StatsFactsService';

export interface HandDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Newest-first list of recorded hands (same array HandHistoryPanel gets). */
  hands: HandRecord[];
  heroId: string;
  /**
   * The viewer's display name, the fallback when `heroId` is empty.
   *
   * `heroId` is `userId || ''` at the call site, so for an observer — or any
   * session where auth has not resolved — the shared view had neither an id
   * nor a name and lit nobody's row. The BBJ rundown has always taken both.
   */
  currentUserName?: string | null;
  /**
   * Open the full animated replay of THE HAND PASSED IN — not "the last hand".
   *
   * The argument is the whole point of this prop. TablePage's handler was
   * declared with no parameter at all and resolved its own subject with
   * `getPlayerHands(userId, 1)`, so paging back to hand 3 of 7 and pressing
   * REPLAY played hand 7. TypeScript cannot catch that: a zero-argument
   * function is assignable to a one-argument type. A handler that ignores
   * `hand` and looks the subject up again is the bug, not a shortcut.
   */
  onReplay?: (hand: HandRecord) => void;
  /** Open the share modal for THE HAND PASSED IN. Same trap as onReplay. */
  onShare?: (hand: HandRecord) => void;
}

/**
 * POLISH 1 (Dan 2026-08-30): "your rake share" for this hand.
 *
 * Weighted contributed rake means a player's rake is proportional to what
 * they actually put in the pot, so the honest thing is to show them their own
 * number rather than the table's. Read from the authoritative per-player
 * ledger (rake_attributions) via an RPC that derives identity from
 * auth.uid(); it never exposes anyone else's contribution. Purely additive:
 * it renders in HandDetailView's existing footer slot and touches no
 * animation-bearing surface.
 */
function HandRakeShareBlock({ share }: { share: HandRakeShare }) {
  if (!share?.found || (share.your_contribution ?? 0) <= 0) return null;
  const n = (v: number | undefined, dp = 2) => Number(v ?? 0).toFixed(dp);
  return (
    <div className="hdm-rake-share">
      <div className="hdm-rake-share__title">Your Rake On This Hand</div>
      <div className="hdm-rake-share__rows">
        <div className="hdm-rake-share__row">
          <span>Your Contribution</span>
          <strong>{n(share.your_contribution)}</strong>
        </div>
        {(share.your_returned_uncalled ?? 0) > 0 && (
          <div className="hdm-rake-share__row">
            <span>Returned To You (Uncalled)</span>
            <strong>{n(share.your_returned_uncalled)}</strong>
          </div>
        )}
        <div className="hdm-rake-share__row">
          <span>Your Share Of The Pot</span>
          <strong>{n(share.your_share_pct, 1)}%</strong>
        </div>
        <div className="hdm-rake-share__row is-primary">
          <span>Your Rake</span>
          <strong>
            {n(share.your_rake)} Of {n(share.hand_rake)}
          </strong>
        </div>
        {(share.hand_bbj ?? 0) > 0 && (
          <div className="hdm-rake-share__row">
            <span>Your Jackpot Drop</span>
            <strong>
              {n(share.your_bbj)} Of {n(share.hand_bbj)}
            </strong>
          </div>
        )}
      </div>
    </div>
  );
}

const SUIT_GLYPH: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RED_SUITS = new Set(['h', 'd']);

function MiniCard({ card, shared = false }: { card: string; shared?: boolean }) {
  if (!card || card.length < 2) return <span className="hdm-card hdm-card--back" />;
  const rank = card.slice(0, -1).toUpperCase().replace('T', '10');
  const suit = card.slice(-1).toLowerCase();
  return (
    <span
      className={`hdm-card${RED_SUITS.has(suit) ? ' hdm-card--red' : ''}${
        shared ? ' hdm-card--shared' : ''
      }`}
    >
      <span className="hdm-card__rank">{rank}</span>
      <span className="hdm-card__suit">{SUIT_GLYPH[suit] || '?'}</span>
    </span>
  );
}

/**
 * Every board the hand ran, one row per run, board 1 first.
 *
 * Dan 2026-08-27: "it even glitched in the previous hands, hand summary."
 * Production hand #3046089 ran THREE boards; the server wrote all three and
 * this modal had no reference to `rit_boards` anywhere, so a player opening it
 * saw board 1 alone with nothing to say the hand had run more than once.
 *
 * The runs share every card dealt before the all-in, so those are dimmed and
 * only the divergence carries full contrast — three near-identical rows of
 * five cards are otherwise something the player has to diff by eye.
 *
 * WHAT IS DELIBERATELY NOT HERE: which run each player won. The stored winner
 * rows carry one aggregate amount and one hand name for the whole hand, with
 * no run index on them, so per-board attribution is not recoverable from the
 * record. The boards are shown and the collected totals are labelled as
 * covering every run. Splitting them across the boards would be a guess
 * presented as a result.
 */
function RunBoardsBlock({ runs }: { runs: RunBoards }) {
  return (
    <div className="hdm-street hdm-runs">
      <div className="hdm-street__head">
        <span className="hdm-street__name">Run It Twice</span>
        <span className="hdm-runs__count">{runs.boards.length} Boards</span>
      </div>
      {runs.boards.map((board, bi) => (
        <div className="hdm-run" key={bi}>
          <span className="hdm-run__badge">RUN {bi + 1}</span>
          <span className="hdm-cards">
            {board.map((c, ci) => (
              <MiniCard key={ci} card={c} shared={ci < runs.sharedCount} />
            ))}
          </span>
        </div>
      ))}
      <div className="hdm-runs__note">
        Boards Share The Cards Dealt Before The All In. Collected Totals Cover Every Run.
      </div>
    </div>
  );
}

/**
 * Card backs plus an explicit reason.
 *
 * Dan 2026-08-23: before the mapper fix every villain drew two grey rectangles
 * here, and the complaint was not "the cards are hidden", it was "this looks
 * broken". Backs on their own are ambiguous — they read equally as "not
 * revealed" and as "still loading" or "failed to load". The store now only
 * withholds cards it genuinely never had (a mucked hand is never persisted, by
 * design), so say that in words rather than leaving the player to guess.
 */
function HiddenCards({ count = 2 }: { count?: number }) {
  return (
    <span className="hdm-hidden">
      <span className="hdm-cards">
        {Array.from({ length: count }).map((_, i) => (
          <span key={i} className="hdm-card hdm-card--back" />
        ))}
      </span>
      <span className="hdm-notshown">Not Shown</span>
    </span>
  );
}

/**
 * This tab shows sub-chip amounts, so it keeps its own two-decimals-under-one
 * rule rather than the shared `money`. What it does NOT keep is its own idea
 * of a non-number: `Math.abs(NaN) >= 1` is false, so it used to fall through
 * to `NaN.toFixed(2)` and print the string "NaN" into a chip figure while the
 * tab beside it printed 0.00 for the same value.
 */
function fmt(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  const abs = Math.abs(v);
  if (abs >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return v.toFixed(2);
}

/* `pineapple_discard` was missing here, so the street header printed the raw
   database enum "pineapple_discard" on every pineapple hand while the panel
   next door printed "Discard" for the same street (HandHistoryPanel's
   getStreetLabel). Any street name added to HandHistoryStreet must gain a label
   in both places or one surface starts leaking column names at the player. */

const STREET_LABEL: Record<string, string> = {
  preflop: 'PreFlop',
  pineapple_discard: 'Discard',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
};

export function HandDetailModal({
  isOpen,
  onClose,
  hands,
  heroId,
  currentUserName,
  onReplay,
  onShare,
}: HandDetailModalProps) {
  // Index into `hands` (0 = newest). The navigator displays oldest→newest
  // like PokerBros, so slider position = (N - index).
  const [index, setIndex] = useState(0);
  const [tab, setTab] = useState<'summary' | 'detail'>('detail');

  /* Drag-to-dismiss for the mobile sheet, matching common/BottomSheet: past
     100px of downward travel the sheet closes, anything less springs back.
     The transform is applied only while a drag is in flight, so the CSS
     open animation is untouched on every other frame. */
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStartY = useRef(0);

  const onGrabDown = useCallback((e: React.PointerEvent) => {
    dragStartY.current = e.clientY;
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);

  const onGrabMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      const dy = e.clientY - dragStartY.current;
      if (dy > 0) setDragY(dy);
    },
    [dragging]
  );

  const onGrabUp = useCallback(() => {
    setDragging(false);
    if (dragY > 100) onClose();
    setDragY(0);
  }, [dragY, onClose]);

  // Snap back to the newest hand each time the modal opens.
  useEffect(() => {
    if (isOpen) {
      setIndex(0);
      setDragY(0);
      setDragging(false);
    }
  }, [isOpen]);

  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const restoreFocusTo = React.useRef<HTMLElement | null>(null);

  /**
   * DIALOG SEMANTICS. This carried `role="dialog"` and nothing that makes one:
   * no Escape, no focus move, no focus restore, and `aria-modal` absent so a
   * screen reader still announced the table behind it. BBJInfoModal, in the
   * same feature, does all of it correctly — the two dialogs had opposite
   * postures for no reason.
   */
  useEffect(() => {
    if (!isOpen) return;
    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      // Give focus back to whatever opened this, not to the top of the page.
      restoreFocusTo.current?.focus?.();
    };
  }, [isOpen, onClose]);

  /** Left/Right/Home/End across the two tabs, the way a tablist behaves. */
  const onTabsKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'Home') {
      e.preventDefault();
      setTab('summary');
    } else if (e.key === 'ArrowRight' || e.key === 'End') {
      e.preventDefault();
      setTab('detail');
    }
  };

  const hand = hands[Math.min(index, Math.max(0, hands.length - 1))];

  // The raw row behind the hand on screen, rebuilt by the shared reconstruction.
  const { model: replay, state: replayState } = useHandReplayModel(isOpen && hand ? hand.id : null);

  // POLISH 1: the viewer's own rake for THIS hand. Fetched per open hand and
  // cleared between hands, so paging never shows the previous hand's figure.
  // A failure is silent by design — the block simply does not render.
  const [rakeShare, setRakeShare] = useState<HandRakeShare | null>(null);
  useEffect(() => {
    if (!isOpen || !hand?.id || !heroId) {
      setRakeShare(null);
      return;
    }
    let cancelled = false;
    setRakeShare(null);
    const load = StatsFactsService?.getHandRakeShare;
    if (typeof load !== 'function') return;
    void load
      .call(StatsFactsService, hand.id)
      .then((r) => {
        if (!cancelled) setRakeShare(r);
      })
      .catch(() => {
        if (!cancelled) setRakeShare(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, hand?.id, heroId]);

  const positionOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of hand?.players || []) m.set(p.id, p.position || '');
    return m;
  }, [hand]);

  /* Per-player NET, read from the stored result instead of being rebuilt here.
   *
   * This used to subtract every action amount and then ADD `winners[].amount`,
   * treating that as the gross chips taken from the pot. It was the NET, so a
   * winner's own investment came off twice: hero posts 2, calls 10 and takes a
   * 24 pot, Hand History showed +12 (the stored result) and this modal showed
   * 0 for the same hand. Losers agreed by accident, because with no winner term
   * the two definitions coincide.
   *
   * Correcting the adapter alone would make the old arithmetic land on the
   * right answer again, because `gross - invested` is how the service defines
   * result in the first place. It is still read from the row rather than
   * recomputed here, because recomputing assumes the action log carries every
   * chip a player put in. The moment a blind, an ante or a returned uncalled
   * bet is written anywhere but `actions`, that assumption pays out a wrong
   * number silently, and this modal drifts away from Hand History exactly the
   * way it just did. One stored net, read in both places.
   *
   * The action-log fallback below is a type floor, not a live path: the only
   * producer of these records is handHistoryAdapter, which always sets
   * `result`, and the localStorage cache that could hold an older shape has
   * never been written to by anything.
   */
  const netOf = useMemo(() => {
    const m = new Map<string, number>();
    if (!hand) return m;
    for (const s of hand.streets) {
      for (const a of s.actions) {
        if (a.amount && a.amount > 0) m.set(a.playerId, (m.get(a.playerId) || 0) - a.amount);
      }
    }
    for (const p of hand.players) {
      if (typeof p.result === 'number') m.set(p.id, p.result);
    }
    return m;
  }, [hand]);

  // Players who showed cards (or won) — the showdown/summary roster.
  const summaryRows = useMemo(() => {
    if (!hand) return [];
    const winnerIds = new Set(hand.winners.map((w) => w.playerId));
    return hand.players
      .filter((p) => (p.holeCards && p.holeCards.length > 0) || winnerIds.has(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        position: p.position,
        cards: p.holeCards,
        handName: hand.winners.find((w) => w.playerId === p.id)?.hand,
        net: netOf.get(p.id) ?? 0,
        /* Shown beside the net and labelled, so this modal and Hand History
           display the identical pair of figures. Showing one surface the gross
           and the other the net, both unlabelled, is what made the same hand
           look like two different hands. */
        collected: hand.winners.find((w) => w.playerId === p.id)?.amount,
        isWinner: winnerIds.has(p.id),
      }));
  }, [hand, netOf]);

  /* Null on an ordinary single-run hand, so nothing changes for one. */
  const runs = useMemo(() => (hand ? runBoardsFor(hand) : null), [hand]);

  /* Only while a drag is in flight. An unconditional inline transform would
     override the CSS slide-in and the sheet would appear without animating. */
  const sheetStyle: React.CSSProperties | undefined = dragY
    ? {
        transform: `translateY(${dragY}px)`,
        transition: dragging ? 'none' : 'transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      }
    : undefined;

  const grabHandle = (
    <div
      className="hdm-grab"
      aria-hidden="true"
      onPointerDown={onGrabDown}
      onPointerMove={onGrabMove}
      onPointerUp={onGrabUp}
      onPointerCancel={onGrabUp}
    >
      <span />
    </div>
  );

  if (!isOpen) return null;

  /**
   * Dan 2026-08-21 (item 4): this used to `return null` when there was no hand
   * to show, so a player who tapped the card before their history had loaded
   * got absolute silence — indistinguishable from a dead button, which is
   * exactly how the whole feature was reported. Open the panel and say why
   * it's empty.
   */
  if (!hand) {
    return (
      <div className="hdm-overlay" onClick={onClose}>
        {/* The dialog is the PANEL, not the overlay. They were the same element,
            so the thing carrying role="dialog" was also the click-out target. */}
        <div
          className="hdm-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Hand Detail"
          tabIndex={-1}
          style={sheetStyle}
          onClick={(e) => e.stopPropagation()}
        >
          {grabHandle}
          <div className="hdm-header">
            <span className="hdm-title">HAND DETAIL</span>
            <div className="hdm-header__actions">
              <button type="button" className="hdm-icon-btn" aria-label="Close" onClick={onClose}>
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                  <path
                    d="M5 5l10 10M15 5L5 15"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          </div>
          <div className="hdm-empty">
            No Completed Hands Yet At This Table. Play A Hand To The End And It Will Appear Here.
          </div>
        </div>
      </div>
    );
  }

  const total = hands.length;
  const displayPos = total - index; // 1..N, N = newest

  return (
    /* The overlay closes on tap and the panel stops the bubble, which was
       already true — but at <=640px the panel was `width:100vw; height:100%`,
       so there was no overlay left to tap. The sheet is three quarters of the
       height now and the exposed quarter above it is a real target. */
    <div className="hdm-overlay" onClick={onClose}>
      {/* The dialog is the PANEL, not the overlay. They were the same element,
          so the thing carrying role="dialog" was also the click-out target. */}
      <div
        className="hdm-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Hand Detail"
        tabIndex={-1}
        ref={panelRef}
        style={sheetStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {grabHandle}
        {/* ── Header ── */}
        <div className="hdm-header">
          <span className="hdm-title">HAND DETAIL</span>
          <div className="hdm-header__actions">
            {onReplay && (
              <button
                className="hdm-icon-btn"
                title="Video Replay"
                aria-label="Video Replay"
                onClick={() => onReplay(hand)}
              >
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                  <circle cx="10" cy="10" r="8.5" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M8 6.5v7l5.5-3.5z" fill="currentColor" />
                </svg>
              </button>
            )}
            {onShare && (
              <button
                className="hdm-icon-btn"
                title="Share Hand"
                aria-label="Share Hand"
                onClick={() => onShare(hand)}
              >
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                  <path
                    d="M13 5l-6 3.2M7 11.8L13 15M15 3.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM5 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm10 5.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                </svg>
              </button>
            )}
            <button className="hdm-icon-btn" aria-label="Close" onClick={onClose}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                <path
                  d="M5 5l10 10M15 5L5 15"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        </div>

        <div className="hdm-subheader">
          <span>
            {new Date(hand.timestamp).toLocaleString([], {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
          <span>{hand.blinds}</span>
          <span className="hdm-sn">#{hand.handNumber}</span>
        </div>

        {/* ── Body ── */}
        <div
          className="hdm-body"
          id="hdm-panel-body"
          role="tabpanel"
          aria-labelledby={tab === 'summary' ? 'hdm-tab-summary' : 'hdm-tab-detail'}
          tabIndex={0}
        >
          {/* THE RUNDOWN.
              `replay` is null while the row is being fetched, and this used to
              fall straight through to the legacy street walk below — the one
              this file's own header documents as over-counting every raised
              pot and defaulting every position badge to seat 1. So on EVERY
              open the player saw the known-wrong numbers first and watched
              them silently change. The hook has always returned a state; it
              was being discarded. A skeleton is the honest thing to show
              while we do not yet know. */}
          {tab === 'detail' && replay ? (
            <HandDetailView
              model={replay}
              currentUserId={heroId}
              currentUserName={currentUserName}
              badge={gameTypeLabel(hand.gameType)}
              footer={rakeShare ? <HandRakeShareBlock share={rakeShare} /> : null}
            />
          ) : tab === 'detail' && (replayState === 'loading' || replayState === 'idle') ? (
            <>
              {/* THE BOARDS ARE NOT PART OF WHAT WE ARE WAITING FOR. The
                  skeleton exists because the action log and every figure in it
                  are reconstructed from the raw row, and showing the legacy
                  walk's known-wrong numbers before that lands was the bug it
                  was added to fix. The runs are different in kind: they come
                  off `hand` — the record already on screen — and they are
                  cards, not computed money, so nothing about them can be
                  revised by the fetch. Hiding them here is what made hand
                  #3046089 show one board out of three again, which is the
                  report this block was written for. `HandDetailView` draws
                  them per street once `replay` resolves, so this renders only
                  while it has not. */}
              {runs && <RunBoardsBlock runs={runs} />}
              <div className="hdm-skeletons">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="hdm-skeleton" />
                ))}
              </div>
            </>
          ) : tab === 'detail' ? (
            <>
              {/* FALLBACK ONLY. Reached when the raw row cannot be read (an RLS
                  refusal, or a hand cached from an older build). Its figures
                  are the ones described above, so it says so rather than
                  presenting them as equivalent. */}
              <div className="hdm-degraded">
                Showing A Reduced Rundown - The Full Hand Could Not Be Read.
              </div>
              {/* The running pot is computed up front rather than mutated
                  inside JSX. `let runningPot` lived in the render body and was
                  incremented from inside .map(), so a re-entrant render under
                  StrictMode double-counted every street. */}
              {(() => {
                let acc = 0;
                const streetPots = hand.streets.map((street) => {
                  const start = acc;
                  for (const a of street.actions) if (a.amount && a.amount > 0) acc += a.amount;
                  return { start, end: acc };
                });
                return hand.streets.map((street, si) => {
                  const streetStartPot = streetPots[si].start;
                  let rowPot = streetStartPot;
                  return (
                    <div key={street.name} className="hdm-street">
                      <div className="hdm-street__head">
                        <span className="hdm-street__name">
                          {STREET_LABEL[street.name] || street.name}
                        </span>
                        {street.cards && street.cards.length > 0 && (
                          <span className="hdm-cards">
                            {street.cards.map((c, i) => (
                              <MiniCard key={i} card={c} />
                            ))}
                          </span>
                        )}
                        <span className="hdm-street__pot">{fmt(streetStartPot)}</span>
                      </div>
                      {street.actions.map((a, i) => {
                        if (a.amount && a.amount > 0) rowPot += a.amount;
                        return (
                          <div
                            key={i}
                            className={`hdm-row${a.playerId === heroId ? ' hdm-row--hero' : ''}`}
                          >
                            <span className="hdm-pos">{positionOf.get(a.playerId) || ''}</span>
                            <span className="hdm-name">{a.playerName}</span>
                            <span className={`hdm-action hdm-action--${a.action}`}>
                              {a.action === 'allin' ? 'All In' : a.action}
                            </span>
                            <span className="hdm-amount">
                              {/* PHASE 4 COMPLETION 2026-09-01: the card you
                                  threw, in the amount slot because a discard
                                  never has one. Present only on the viewer's
                                  own discard - the service fills it from
                                  `hand_discards`, which RLS scopes to the
                                  caller, so an opponent's stays undefined. */}
                              {a.discardedCard
                                ? a.discardedCard
                                : a.amount && a.amount > 0
                                  ? fmt(a.amount)
                                  : ''}
                            </span>
                            <span className="hdm-pot">{fmt(rowPot)}</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                });
              })()}
              {/* Every board the hand ran. Production hand #3046089 ran three
                  and this modal showed one. Kept here, after the street list
                  and inside the same fallback, exactly where it sat before the
                  street walk was replaced. */}
              {runs && <RunBoardsBlock runs={runs} />}
              <div className="hdm-potline">
                <span>Pot</span>
                <span>Main({fmt(hand.potTotal)})</span>
              </div>
              {summaryRows.length > 0 && (
                <div className="hdm-street">
                  <div className="hdm-street__head">
                    <span className="hdm-street__name">Showdown</span>
                  </div>
                  {summaryRows.map((r) => (
                    <SummaryRow key={r.id} r={r} heroId={heroId} />
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="hdm-potline hdm-potline--top">
                <span>Main Pot : {fmt(hand.potTotal)}</span>
              </div>
              {/* Hand Summary is the tab Dan had open when he reported the
                  run-it-twice glitch, so the boards lead it. */}
              {runs && <RunBoardsBlock runs={runs} />}
              {summaryRows.length === 0 && (
                <div className="hdm-empty">No Showdown - The Pot Was Taken Without A Reveal.</div>
              )}
              {summaryRows.map((r) => (
                <SummaryRow key={r.id} r={r} heroId={heroId} big />
              ))}
            </>
          )}
        </div>

        {/* ── Hand navigator (oldest → newest, newest at right) ── */}
        <div className="hdm-nav">
          <button
            className="hdm-nav__arrow"
            disabled={index >= total - 1}
            aria-label="Older Hand"
            onClick={() => setIndex((i) => Math.min(total - 1, i + 1))}
          >
            &#9664;
          </button>
          <div className="hdm-nav__track">
            <span className="hdm-nav__label">
              {displayPos}/{total}
            </span>
            <input
              type="range"
              min={1}
              max={Math.max(1, total)}
              value={displayPos}
              onChange={(e) => setIndex(total - Number(e.target.value))}
              aria-label="Hand Position"
            />
          </div>
          <button
            className="hdm-nav__arrow"
            disabled={index <= 0}
            aria-label="Newer Hand"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
          >
            &#9654;
          </button>
        </div>

        {/* ── Tabs ── */}
        {/* Two plain buttons before this: no role, no aria-selected, no arrow
            keys, and a body with no tabpanel. A screen reader could not tell
            these were tabs, and neither could a keyboard. */}
        <div
          className="hdm-tabs"
          role="tablist"
          aria-label="Hand Detail View"
          onKeyDown={onTabsKeyDown}
        >
          <button
            type="button"
            role="tab"
            id="hdm-tab-summary"
            aria-selected={tab === 'summary'}
            aria-controls="hdm-panel-body"
            tabIndex={tab === 'summary' ? 0 : -1}
            className={`hdm-tab${tab === 'summary' ? ' hdm-tab--active' : ''}`}
            onClick={() => setTab('summary')}
          >
            Hand Summary
          </button>
          <button
            type="button"
            role="tab"
            id="hdm-tab-detail"
            aria-selected={tab === 'detail'}
            aria-controls="hdm-panel-body"
            tabIndex={tab === 'detail' ? 0 : -1}
            className={`hdm-tab${tab === 'detail' ? ' hdm-tab--active' : ''}`}
            onClick={() => setTab('detail')}
          >
            Hand Detail
          </button>
        </div>
      </div>
    </div>
  );
}

function SummaryRow({
  r,
  heroId,
  big = false,
}: {
  r: {
    id: string;
    name: string;
    position: string;
    cards?: string[];
    handName?: string;
    net: number;
    collected?: number;
    isWinner: boolean;
  };
  heroId: string;
  big?: boolean;
}) {
  return (
    <div className={`hdm-showdown${big ? ' hdm-showdown--big' : ''}`}>
      <div className="hdm-showdown__who">
        <span className={`hdm-name${r.id === heroId ? ' hdm-name--hero' : ''}`}>{r.name}</span>
        <span className="hdm-pos">{r.position}</span>
      </div>
      <div className="hdm-showdown__hand">
        {r.cards && r.cards.length > 0 ? (
          <span className="hdm-cards">
            {r.cards.map((c, i) => (
              <MiniCard key={i} card={c} />
            ))}
          </span>
        ) : (
          <HiddenCards />
        )}
        {/* Only the winner of a pot carries an evaluated hand name in the row
            (`winners[].hand.name`). A losing showdown player has none stored,
            so this stays empty rather than being re-evaluated client side from
            cards the client cannot verify. */}
        {r.handName && <span className="hdm-handname">{r.handName}</span>}
      </div>
      {r.collected != null && <span className="hdm-collected">Collected {fmt(r.collected)}</span>}
      <span className={`hdm-net${r.net > 0 ? ' hdm-net--win' : r.net < 0 ? ' hdm-net--loss' : ''}`}>
        Net {r.net > 0 ? '+' : ''}
        {fmt(r.net)}
      </span>
    </div>
  );
}

export default HandDetailModal;
