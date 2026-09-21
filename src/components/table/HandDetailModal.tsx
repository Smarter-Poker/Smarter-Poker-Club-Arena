/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND DETAIL MODAL — the Previous Hand breakdown  #ClubArenaConsole
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Opened by tapping the Previous Hand card, or from a row of the Hand History
 * panel. Two tabs:
 *
 *   HAND SUMMARY — the boards, the pot breakdown, then one row per showdown
 *                  hand: who, position, the cards, the made hand with the five
 *                  that played lit, the share of each pot (and each half, on a
 *                  hi-lo hand), the net.
 *   HAND DETAIL  — the street-by-street rundown: position, player, action,
 *                  amount, the stack left after each action, the board as it
 *                  came, the running pot, then the showdown and the drop.
 *
 * Header carries date · stakes · hand number, REPLAY for THE HAND ON SCREEN
 * and the two ways to take it away with you. The bottom bar pages through the
 * table's recorded hands (newest at the right).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-09-04 — ONE RECONSTRUCTION, ONE FETCH
 *
 * This file used to hold THREE reconstructions of the same hand: the Summary
 * tab's adapter (which admitted any winner to a block titled "Showdown" and
 * printed "Not Shown" for a player who had mucked), the Detail tab's
 * `buildReplay` (correct), and a "degraded" hand-rolled walk that summed
 * raise-TO levels as if they were chips added and over-counted every raised
 * pot. It also fetched the raw row again for a hand the service had already
 * built the model for.
 *
 * Both tabs now render `hand.replay` - the model `HandHistoryService` builds
 * once from the raw row - so there is nothing left in here that can disagree
 * with the panel, the archive or the jackpot rundown. The subject is pinned by
 * hand id, not by position: a new hand landing while the player reads does not
 * silently move them to its neighbour.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CONSOLE (#ClubArenaConsole). The sheet was a rounded panel with a grey
 * header bar carrying three 32px square icon buttons, a pill tab strip, a
 * rounded card per showdown row, bordered board blocks, a boxed rake panel and
 * a rounded "Show What Would Have Come" button. The spade master is the frame
 * now: the table is the eyebrow, HAND DETAIL is engraved in the header well,
 * the hand number sits in the well's painted pill slot, every board, pot,
 * showdown row and rake figure is a ROW on the black glass, and REPLAY /
 * CLOSE are the plates painted into the foot.
 *
 * WHAT DID NOT MOVE. The sheet's GEOMETRY is unchanged and is pinned by
 * tests/unit/handHistorySheets.test.tsx: three quarters of the height on a
 * phone, anchored to the bottom, so there is a backdrop left to tap, and the
 * safe-area inset paid at the top. So are drag-to-dismiss, the focus trap, the
 * tablist, the subject-by-id pinning, the rake fetch and every copy control.
 */

import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import type { HandRecord, HandHistoryLoadState } from './HandHistoryPanel';
import HandDetailView from '../handdetail/HandDetailView';
import CardImage, { CardBack } from './CardImage';
import { replayRabbitOffer } from './replayRabbitOffer';
import { useRabbitHuntReveal } from './useRabbitHuntReveal';
import type { RabbitHuntRevealResult } from './RabbitHunt';
import { cardKey } from '../../utils/handEvaluator';
import type { ReplayModel, ReplayShowdownRow } from '../../utils/handReplay';
import './HandDetailModal.css';
import { blindLabel, gameTypeLabel, money, stamp } from '../../utils/handFormat';
import { handDeepLink } from '../../lib/handHistoryLive';
import { StatsFactsService, type HandRakeShare } from '../../services/StatsFactsService';
import { SpadeConsole } from '../console/SpadeConsole';

export interface HandDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Newest-first list of recorded hands (same array HandHistoryPanel gets). */
  hands: HandRecord[];
  heroId: string;
  /** The viewer's display name, the fallback when `heroId` is empty. */
  currentUserName?: string | null;
  /** Where the list is in its fetch, so an empty modal can say why. */
  loadState?: HandHistoryLoadState;
  /**
   * Open AT this hand rather than at the newest. Set when the modal is opened
   * from a row of the Hand History panel.
   */
  initialHandId?: string | null;
  /** False for a spectator: the empty state says so instead of claiming the table has no hands. */
  viewerSeated?: boolean;
  /**
   * P5 2026-09-05: buy the rabbit hunt for the hand you are LOOKING AT, not
   * only the one the felt just offered. Charges and answers in one call, the
   * same path the felt tile uses. Absent (the share route, the lobby) the
   * block never renders - there is no table to ask.
   */
  onRabbitHunt?: (handNumber: number) => Promise<RabbitHuntRevealResult>;
  /** The signed-in player; without one there is nobody to bill. */
  rabbitUserId?: string | null;
  /** Open the full animated replay of THE HAND PASSED IN, not "the last hand". */
  onReplay?: (hand: HandRecord) => void;
  /** Open the share modal for THE HAND PASSED IN. */
  onShare?: (hand: HandRecord) => void;
}

/**
 * "Your rake share" for this hand (Dan 2026-08-30). Weighted contributed rake
 * means a player's rake is proportional to what they put in the pot, so the
 * honest figure is their own. Read from the per-player ledger through an RPC
 * that derives identity from auth.uid(); it never exposes anyone else's.
 */
function HandRakeShareBlock({ share }: { share: HandRakeShare }) {
  if (!share?.found || (share.your_contribution ?? 0) <= 0) return null;
  const n = (v: number | undefined, dp = 2) => money(Number(v ?? 0), dp);
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

/** How many face-down cards a muck shows - the variant's own holding size. */
function muckWidth(model: ReplayModel): number {
  const shown = model.players.find((p) => p.hole && p.hole.length > 0)?.hole?.length;
  if (shown) return shown;
  const v = String(model.gameVariant || '').toLowerCase();
  if (v.startsWith('plo6')) return 6;
  if (v.startsWith('plo5')) return 5;
  if (v.startsWith('plo') || v.startsWith('flo')) return 4;
  if (v.includes('pineapple')) return 3;
  return 2;
}

/**
 * Every board the hand ran, board 1 first. The runs share every card dealt
 * before the all-in; those are dimmed so the eye lands on where they diverge.
 */
function BoardsBlock({ model, isBomb }: { model: ReplayModel; isBomb: boolean }) {
  const boards = model.boards.filter((b) => b.length > 0);
  if (boards.length === 0) return null;
  const shortest = Math.min(...boards.map((b) => b.length));
  let shared = 0;
  while (
    boards.length > 1 &&
    shared < shortest &&
    boards.every((b) => cardKey(b[shared]) === cardKey(boards[0][shared]))
  ) {
    shared += 1;
  }
  const title =
    boards.length === 1
      ? 'Board'
      : isBomb
        ? 'Bomb Pot Boards'
        : boards.length >= 3
          ? 'Run It 3 Times'
          : 'Run It Twice';
  return (
    <section className="hdm-boards" aria-label={title}>
      <header className="hdm-section-head">
        <span>{title}</span>
        {boards.length > 1 && <span className="hdm-section-count">{boards.length} Boards</span>}
      </header>
      {boards.map((board, bi) => (
        <div className="hdm-board" key={bi}>
          {boards.length > 1 && (
            <span className="hdm-board__badge">
              {isBomb ? 'Board' : 'Run'} {bi + 1}
            </span>
          )}
          <span className="hdm-board__cards">
            {board.map((c, ci) => (
              <CardImage
                key={ci}
                card={c}
                size="xs"
                className={boards.length > 1 && ci < shared ? 'hdm-card--shared' : undefined}
              />
            ))}
          </span>
        </div>
      ))}
    </section>
  );
}

/**
 * THE HUNT YOU MISSED AT THE FELT (P5, 2026-09-05).
 *
 * The felt shows the Rabbit Hunt for 2250-2650ms; the engine holds the offer
 * for ninety seconds. This is the rest of that window, and it is the one
 * thing the 2026-09-05 competitive research found ClubWPT Gold doing that we
 * did not.
 *
 * The cards it buys go ONLY to the buyer, exactly as at the felt (Dan
 * 2026-08-25: "These should ONLY APPEAR TO THE PLAYER WHO CLICKED") - they
 * are rendered here, in this player's own modal, and are in no broadcast.
 * `useRabbitHuntReveal` is the same single-flight purchase the tile makes, so
 * a double tap cannot bill twice and an already-bought hand re-shows free.
 */
function RabbitHuntReplayBlock({
  hand,
  model,
  onRabbitHunt,
  userId,
}: {
  hand: HandRecord;
  model: ReplayModel;
  onRabbitHunt: (handNumber: number) => Promise<RabbitHuntRevealResult>;
  userId: string | null | undefined;
}) {
  const offer = replayRabbitOffer({
    handNumber: hand.handNumber,
    timestamp: hand.timestamp,
    boards: model.boards,
  });
  const { reveal, isRevealing, hasRevealed, cards } = useRabbitHuntReveal({
    onReveal: (n) => onRabbitHunt(n ?? hand.handNumber),
    userId,
  });

  // Nothing left to sell, a re-run, or past the engine's window - and nothing
  // already bought that we should keep showing.
  if (!offer.show && !hasRevealed) return null;

  return (
    <section className="hdm-rabbit" aria-label="Rabbit Hunt">
      <header className="hdm-section-head">
        <span>Rabbit Hunt</span>
        {hasRevealed ? null : (
          <span className="hdm-section-count">
            {offer.cardsUnseen} Card{offer.cardsUnseen === 1 ? '' : 's'} Unseen
          </span>
        )}
      </header>
      {hasRevealed ? (
        <div className="hdm-board hdm-rabbit__cards">
          <span className="hdm-board__badge">Would Have Come</span>
          <span className="hdm-board__cards">
            {cards.map((c, i) => (
              <CardImage
                key={i}
                /* The reveal's rank is a plain string off the wire; the board
                   renderer wants the deck's own union. The server only ever
                   sends real ranks, and a bad one would render as a missing
                   image rather than throw, so this narrows rather than
                   validates. */
                card={c as unknown as Parameters<typeof CardImage>[0]['card']}
                size="xs"
                className="hdm-card--rabbit"
              />
            ))}
          </span>
        </div>
      ) : (
        <button
          type="button"
          className="hdm-rabbit__btn"
          onClick={() => void reveal(hand.handNumber)}
          disabled={isRevealing}
        >
          {isRevealing ? 'Revealing...' : 'Show What Would Have Come'}
        </button>
      )}
    </section>
  );
}

function SummaryRow({
  row,
  isYou,
  muckCount,
  collected,
}: {
  row: ReplayShowdownRow;
  isYou: boolean;
  muckCount: number;
  /** GROSS chips the pot paid this player for the whole hand, when known. */
  collected?: number;
}) {
  return (
    <div
      className={`hdm-sd${row.isWinner ? ' is-winner' : ''}${row.low ? ' is-low' : ''}${
        isYou ? ' is-you' : ''
      }`}
    >
      <div className="hdm-sd__who">
        <span className="hdm-sd__name">
          {row.name}
          {row.low && <span className="hdm-tag hdm-tag--low">Low</span>}
          {row.holePrivate && <span className="hdm-tag hdm-tag--private">Yours, Not Shown</span>}
        </span>
        <span className="hdm-sd__pos">{row.position}</span>
      </div>
      <div className="hdm-sd__cards">
        {row.hole
          ? row.hole.map((c, i) => (
              <CardImage
                key={i}
                card={c}
                size="sm"
                className={`${row.playing.includes(cardKey(c)) ? 'hdm-plays' : 'hdm-idle'}${
                  row.holePrivate ? ' hdm-private' : ''
                }`}
              />
            ))
          : Array.from({ length: muckCount }).map((_, i) => <CardBack key={i} size="sm" />)}
        <span className="hdm-sd__handname">{row.hole ? row.handName : 'Mucked'}</span>
      </div>
      <div className="hdm-sd__right">
        {/* Both figures, both labelled: the GROSS the pot paid (whole hand) and
            the share or net on this row. Showing one surface the gross and the
            other the net, unlabelled, is what made one hand read as two. */}
        {row.isWinner && row.boardIndex === 0 && !row.low && typeof collected === 'number' && (
          <span className="hdm-sd__collected">Collected {money(collected)}</span>
        )}
        <span
          className={`hdm-sd__net${
            row.net === null ? ' is-blank' : row.net > 0 ? ' is-up' : row.net < 0 ? ' is-down' : ''
          }`}
        >
          {row.net === null
            ? ''
            : `${row.net > 0 ? '+' : row.net < 0 ? '-' : ''}${money(Math.abs(row.net))}`}
        </span>
        {/* Both axes when the record has both (2026-09-13), see HandDetailView. */}
        <span className="hdm-sd__pot">
          {row.boardLabel && row.potSlices?.length
            ? `${row.boardLabel} · ${row.potLabel}`
            : row.boardLabel || row.potLabel}
        </span>
      </div>
    </div>
  );
}

export function HandDetailModal({
  isOpen,
  onClose,
  hands,
  heroId,
  currentUserName,
  loadState = 'ready',
  initialHandId = null,
  viewerSeated = true,
  onReplay,
  onShare,
  onRabbitHunt,
  rabbitUserId,
}: HandDetailModalProps) {
  /* THE SUBJECT IS A HAND, NOT A POSITION. `hands` is newest-first and can be
     replaced while the modal is open (a hand finishing behind it). Holding an
     index meant the hand on screen silently became its newer neighbour. */
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [tab, setTab] = useState<'summary' | 'detail'>('summary');

  /* Drag-to-dismiss for the mobile sheet: past 100px of downward travel the
     sheet closes, anything less springs back. */
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

  // Each open starts on the requested hand (or the newest), on the Summary tab.
  useEffect(() => {
    if (isOpen) {
      setSubjectId(initialHandId ?? null);
      setTab('summary');
      setDragY(0);
      setDragging(false);
    }
  }, [isOpen, initialHandId]);

  /* PIN THE NEWEST TOO (Phase 1). With live refresh a hand can land while the
     modal is open. "Newest" was resolved as index 0 on every render, so the
     reader was moved onto the new hand mid-read. Once the list has a newest
     hand, that hand becomes the subject by id; the navigator's total grows
     and the arrows still reach the new one. */
  useEffect(() => {
    if (isOpen && subjectId === null && hands.length > 0) setSubjectId(hands[0].id);
  }, [isOpen, subjectId, hands]);

  const index = useMemo(() => {
    if (!hands.length) return 0;
    if (subjectId) {
      const i = hands.findIndex((h) => h.id === subjectId);
      if (i >= 0) return i;
    }
    return 0;
  }, [hands, subjectId]);
  const hand: HandRecord | undefined = hands[index];
  const total = hands.length;
  const displayPos = total - index;

  const goTo = (i: number) => {
    const clamped = Math.max(0, Math.min(total - 1, i));
    const target = hands[clamped];
    if (target) setSubjectId(target.id);
  };

  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  /**
   * DIALOG SEMANTICS: Escape, focus in, focus back out. Keyed on `isOpen`
   * only - `onClose` is an inline arrow at the call site, and having it in
   * the deps re-ran this on every parent render, stealing focus back to the
   * opener while the dialog was still open.
   */
  useEffect(() => {
    if (!isOpen) return;
    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const FOCUSABLE =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      /* TAB STAYED INSIDE ONLY BY LUCK. Focus went in on open and came back on
         close, which is two thirds of a dialog; the third is that Tab cannot
         leave. `aria-modal` tells a screen reader the rest of the page is
         inert and the BROWSER does not care - Tab walked out of the modal into
         the page behind it, where the reader is then somewhere it was just
         told does not exist. */
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!panelRef.current.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      restoreFocusTo.current?.focus?.();
    };
  }, [isOpen]);

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

  // The viewer's own rake for THIS hand, fetched only where it is shown.
  const [rakeShare, setRakeShare] = useState<HandRakeShare | null>(null);
  useEffect(() => {
    if (!isOpen || !hand?.id || !heroId || tab !== 'detail') {
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
  }, [isOpen, hand?.id, heroId, tab]);

  /**
   * COPY HAND NUMBER / COPY LINK (Phase 1, 2026-09-05). Every dispute and every
   * chat about a hand starts with its number; the link opens the archive on
   * this hand for anyone who was in it. A transient "Copied" on the button
   * itself, so the modal needs no toast layer of its own.
   */
  const [copied, setCopied] = useState<'number' | 'link' | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyText = useCallback(async (kind: 'number' | 'link', text: string) => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setCopied(kind);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(null), 1600);
    } catch {
      setCopied(null);
    }
  }, []);
  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    []
  );

  const sheetStyle: React.CSSProperties | undefined = dragY
    ? {
        transform: `translateY(${dragY}px)`,
        transition: dragging ? 'none' : 'transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      }
    : undefined;

  /* THE TOP OF THE SHEET. It is the drag affordance and, more to the point,
     the strip that pays the safe-area inset so the crest never lands under
     the phone's clock - pinned by tests/unit/handHistorySheets.test.tsx in
     both places it can vanish. */
  const headerStrip = (
    <div
      className="hdm-header"
      aria-hidden="true"
      onPointerDown={onGrabDown}
      onPointerMove={onGrabMove}
      onPointerUp={onGrabUp}
      onPointerCancel={onGrabUp}
    >
      <span className="hdm-grab" />
    </div>
  );

  if (!isOpen) return null;

  /* Dan 2026-08-21: this used to `return null` with no hand to show, so a tap
     before the history loaded was indistinguishable from a dead button. Open
     the panel and say why it is empty - and say WHICH why. */
  if (!hand) {
    return (
      <div className="hdm-overlay" onClick={onClose}>
        <div
          className="hdm-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Hand Detail"
          aria-busy={loadState === 'loading'}
          tabIndex={-1}
          style={sheetStyle}
          onClick={(e) => e.stopPropagation()}
        >
          {headerStrip}
          <SpadeConsole
            as="div"
            className="hdm-console"
            eyebrow="This Table"
            title="Hand Detail"
            foot="foot"
          >
            <div className="hdm-empty">
              {loadState === 'loading'
                ? 'Loading The Hands For This Table'
                : loadState === 'failed'
                  ? 'Could Not Load The Hands For This Table. Close And Try Again.'
                  : viewerSeated
                    ? 'No Completed Hands For You At This Table Yet. Play A Hand To The End And It Will Appear Here.'
                    : 'You Are Watching. Hands Are Recorded For The Players Dealt Into Them. Take A Seat And Yours Will Appear Here.'}
            </div>
            <button type="button" className="hdm-word-btn" aria-label="Close" onClick={onClose}>
              Close
            </button>
          </SpadeConsole>
        </div>
      </div>
    );
  }

  const model = hand.replay;
  const isYou = (userId: string, name: string) => {
    if (heroId && userId) return userId === heroId;
    return !!currentUserName && name.toLowerCase() === currentUserName.toLowerCase();
  };
  const muckCount = muckWidth(model);
  const variant = gameTypeLabel(model.gameVariant) || hand.gameType;
  const isBomb = !!hand.bombPot || (!!hand.bombBoards?.length && !hand.ritBoards?.length);
  const showdownRows = model.showdown;
  const takenBy = hand.winners.map((w) => w.playerName).join(', ');
  const collectedBy = new Map(hand.winners.map((w) => [w.playerId, w.amount]));

  return (
    <div className="hdm-overlay" onClick={onClose}>
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
        {headerStrip}
        <SpadeConsole
          as="div"
          className="hdm-console"
          eyebrow={hand.tableName || 'This Table'}
          title="Hand Detail"
          /* The hand number in the well's painted pill slot: it is what every
             dispute and every chat about a hand opens with. */
          pill={`#${hand.handNumber}`}
          pillInk="blue"
          plates={{
            /* The steel plate closes; the blue glass carries the one thing a
               player comes back to a finished hand for. With no replay handler
               (the share route, the lobby) the plate says so rather than being
               painted and empty. */
            secondary: { label: 'Close', onClick: onClose, 'aria-label': 'Close' },
            primary: onReplay
              ? {
                  label: 'Replay',
                  ink: 'white' as const,
                  title: 'Video Replay',
                  'aria-label': 'Video Replay',
                  onClick: () => onReplay(hand),
                }
              : { label: 'No Replay', ink: 'muted' as const, disabled: true },
          }}
        >
          <div className="hdm-subheader">
            <span>{stamp(model.playedAt) || new Date(hand.timestamp).toLocaleString()}</span>
            <span>
              {blindLabel(model.smallBlind)} / {blindLabel(model.bigBlind)}
              {variant ? <em className="hdm-variant">{variant}</em> : null}
            </span>
          </div>

          {/* TAKING THE HAND WITH YOU: the number, the link, and the share
              sheet - three lit words on one engraved row, because they are one
              intention. Share used to be a glyph in the header bar. */}
          <div className="hdm-sn">
            <button
              type="button"
              className="hdm-copy"
              title="Copy Hand Number"
              aria-label={`Copy Hand Number ${hand.handNumber}`}
              onClick={() => void copyText('number', `#${hand.handNumber}`)}
            >
              #{hand.handNumber}
              <span className="hdm-copy__hint">{copied === 'number' ? 'Copied' : 'Copy'}</span>
            </button>
            <button
              type="button"
              className="hdm-copy"
              title="Copy Link To This Hand"
              aria-label="Copy Link To This Hand"
              onClick={() => void copyText('link', handDeepLink(hand.id))}
            >
              Link
              <span className="hdm-copy__hint">{copied === 'link' ? 'Copied' : 'Copy'}</span>
            </button>
            {onShare && (
              <button
                type="button"
                className="hdm-copy"
                title="Share Hand"
                aria-label="Share Hand"
                onClick={() => onShare(hand)}
              >
                Share
                <span className="hdm-copy__hint">Send</span>
              </button>
            )}
          </div>

          <div
            className="hdm-body"
            id="hdm-panel-body"
            role="tabpanel"
            aria-labelledby={tab === 'summary' ? 'hdm-tab-summary' : 'hdm-tab-detail'}
            tabIndex={0}
          >
            {tab === 'detail' ? (
              <HandDetailView
                model={model}
                currentUserId={heroId}
                currentUserName={currentUserName}
                badge={variant}
                viewerFacts={hand.heroFacts}
                footer={rakeShare ? <HandRakeShareBlock share={rakeShare} /> : null}
              />
            ) : (
              <>
                <div className="hdm-potline hdm-potline--top">
                  <span className="hdm-potline__label">Pot</span>
                  <span className="hdm-potline__pots">
                    {model.pots.map((p, i) => (
                      <span key={`${i}-${p.label}`}>
                        {p.label} {money(p.amount)}
                      </span>
                    ))}
                  </span>
                  {(model.rake > 0 || model.bbjFee > 0) && (
                    <span className="hdm-potline__drop">
                      {model.rake > 0 ? `Rake ${money(model.rake)}` : ''}
                      {model.rake > 0 && model.bbjFee > 0 ? ' · ' : ''}
                      {model.bbjFee > 0 ? `Jackpot ${money(model.bbjFee)}` : ''}
                    </span>
                  )}
                </div>

                <BoardsBlock model={model} isBomb={isBomb} />

                {onRabbitHunt ? (
                  <RabbitHuntReplayBlock
                    key={hand.id}
                    hand={hand}
                    model={model}
                    onRabbitHunt={onRabbitHunt}
                    userId={rabbitUserId}
                  />
                ) : null}

                {showdownRows.length === 0 ? (
                  <div className="hdm-empty hdm-empty--inline">
                    No Showdown{takenBy ? ` · Pot Taken By ${takenBy}` : ''}
                  </div>
                ) : (
                  <section className="hdm-showdown" aria-label="Showdown">
                    <header className="hdm-section-head">
                      <span>Showdown</span>
                      {model.hiLo && <span className="hdm-section-count">High And Low</span>}
                    </header>
                    {showdownRows.map((row) => (
                      <SummaryRow
                        key={row.key}
                        row={row}
                        isYou={isYou(row.userId, row.name)}
                        muckCount={muckCount}
                        collected={collectedBy.get(row.userId)}
                      />
                    ))}
                  </section>
                )}

                {/* Your own cards on a hand you folded: the table never saw them,
                    so they are not a showdown row. They are still yours to see. */}
                {(() => {
                  const me = model.players.find((p) => p.userId === heroId);
                  if (!me?.privateHole?.length || showdownRows.some((r) => r.userId === heroId))
                    return null;
                  return (
                    <section className="hdm-yours" aria-label="Your Cards">
                      <header className="hdm-section-head">
                        <span>Your Cards</span>
                        <span className="hdm-section-count">Folded, Not Shown</span>
                      </header>
                      <div className="hdm-sd is-you">
                        <div className="hdm-sd__who">
                          <span className="hdm-sd__name">{me.username}</span>
                          <span className="hdm-sd__pos">{me.position}</span>
                        </div>
                        <div className="hdm-sd__cards">
                          {me.privateHole.map((c, i) => (
                            <CardImage key={i} card={c} size="sm" className="hdm-private" />
                          ))}
                        </div>
                        <div className="hdm-sd__right">
                          <span
                            className={`hdm-sd__net${me.net < 0 ? ' is-down' : me.net > 0 ? ' is-up' : ''}`}
                          >
                            {`${me.net > 0 ? '+' : me.net < 0 ? '-' : ''}${money(Math.abs(me.net))}`}
                          </span>
                        </div>
                      </div>
                    </section>
                  );
                })()}
              </>
            )}
          </div>

          <div className="hdm-nav">
            <button
              type="button"
              className="hdm-nav__arrow"
              disabled={index >= total - 1}
              aria-label="Older Hand"
              onClick={() => goTo(index + 1)}
            >
              &#9664;
            </button>
            <div className="hdm-nav__track">
              <span className="hdm-nav__label">
                {displayPos}/{total}
              </span>
              {/* The only thing drawn on this sheet: a position control the
                  master paints nowhere, cut down to an engraved track and a
                  square lit handle. Fifty hands is fifty taps without it. */}
              <input
                type="range"
                min={1}
                max={Math.max(1, total)}
                value={displayPos}
                onChange={(e) => goTo(total - Number(e.target.value))}
                aria-label="Hand Position"
              />
            </div>
            <button
              type="button"
              className="hdm-nav__arrow"
              disabled={index <= 0}
              aria-label="Newer Hand"
              onClick={() => goTo(index - 1)}
            >
              &#9654;
            </button>
          </div>

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
        </SpadeConsole>
      </div>
    </div>
  );
}

export default HandDetailModal;
