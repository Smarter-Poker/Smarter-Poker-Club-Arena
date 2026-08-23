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
 * Data: the same HandRecord list HandHistoryPanel renders (adapted from the
 * hand_history table). Per-street stacks aren't stored, so the right-hand
 * column shows the RUNNING POT — computable and honest — rather than faking
 * a stack figure.
 */

import React, { useMemo, useState, useEffect } from 'react';
import type { HandRecord } from './HandHistoryPanel';
import './HandDetailModal.css';

export interface HandDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Newest-first list of recorded hands (same array HandHistoryPanel gets). */
  hands: HandRecord[];
  heroId: string;
  /** Open the full animated replay of the hand currently shown. */
  onReplay?: (hand: HandRecord) => void;
  /** Open the share modal for the hand currently shown. */
  onShare?: (hand: HandRecord) => void;
}

const SUIT_GLYPH: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RED_SUITS = new Set(['h', 'd']);

function MiniCard({ card }: { card: string }) {
  if (!card || card.length < 2) return <span className="hdm-card hdm-card--back" />;
  const rank = card.slice(0, -1).toUpperCase().replace('T', '10');
  const suit = card.slice(-1).toLowerCase();
  return (
    <span className={`hdm-card${RED_SUITS.has(suit) ? ' hdm-card--red' : ''}`}>
      <span className="hdm-card__rank">{rank}</span>
      <span className="hdm-card__suit">{SUIT_GLYPH[suit] || '?'}</span>
    </span>
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

function fmt(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return n.toFixed(2);
}

const STREET_LABEL: Record<string, string> = {
  preflop: 'PreFlop',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
};

export function HandDetailModal({
  isOpen,
  onClose,
  hands,
  heroId,
  onReplay,
  onShare,
}: HandDetailModalProps) {
  // Index into `hands` (0 = newest). The navigator displays oldest→newest
  // like PokerBros, so slider position = (N - index).
  const [index, setIndex] = useState(0);
  const [tab, setTab] = useState<'summary' | 'detail'>('detail');

  // Snap back to the newest hand each time the modal opens.
  useEffect(() => {
    if (isOpen) setIndex(0);
  }, [isOpen]);

  const hand = hands[Math.min(index, Math.max(0, hands.length - 1))];

  const positionOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of hand?.players || []) m.set(p.id, p.position || '');
    return m;
  }, [hand]);

  // Per-player net: winners carry their amount; everyone else shows what the
  // action log says they put in, as a negative.
  const netOf = useMemo(() => {
    const m = new Map<string, number>();
    if (!hand) return m;
    for (const s of hand.streets) {
      for (const a of s.actions) {
        if (a.amount && a.amount > 0) m.set(a.playerId, (m.get(a.playerId) || 0) - a.amount);
      }
    }
    for (const w of hand.winners) m.set(w.playerId, (m.get(w.playerId) || 0) + w.amount);
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
        isWinner: winnerIds.has(p.id),
      }));
  }, [hand, netOf]);

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
      <div className="hdm-overlay" role="dialog" aria-label="Hand detail" onClick={onClose}>
        <div className="hdm-panel" onClick={(e) => e.stopPropagation()}>
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

  let runningPot = 0;

  return (
    <div className="hdm-overlay" role="dialog" aria-label="Hand detail" onClick={onClose}>
      <div className="hdm-panel" onClick={(e) => e.stopPropagation()}>
        {/* ── Header ── */}
        <div className="hdm-header">
          <span className="hdm-title">HAND DETAIL</span>
          <div className="hdm-header__actions">
            {onReplay && (
              <button
                className="hdm-icon-btn"
                title="Video replay"
                aria-label="Video replay"
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
                title="Share hand"
                aria-label="Share hand"
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
        <div className="hdm-body">
          {tab === 'detail' ? (
            <>
              {hand.streets.map((street) => {
                const streetStartPot = runningPot;
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
                      if (a.amount && a.amount > 0) runningPot += a.amount;
                      return (
                        <div
                          key={i}
                          className={`hdm-row${a.playerId === heroId ? ' hdm-row--hero' : ''}`}
                        >
                          <span className="hdm-pos">{positionOf.get(a.playerId) || ''}</span>
                          <span className="hdm-name">{a.playerName}</span>
                          <span className={`hdm-action hdm-action--${a.action}`}>
                            {a.action === 'allin' ? 'all in' : a.action}
                          </span>
                          <span className="hdm-amount">
                            {a.amount && a.amount > 0 ? fmt(a.amount) : ''}
                          </span>
                          <span className="hdm-pot">{fmt(runningPot)}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
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
            aria-label="Older hand"
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
              aria-label="Hand position"
            />
          </div>
          <button
            className="hdm-nav__arrow"
            disabled={index <= 0}
            aria-label="Newer hand"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
          >
            &#9654;
          </button>
        </div>

        {/* ── Tabs ── */}
        <div className="hdm-tabs">
          <button
            className={`hdm-tab${tab === 'summary' ? ' hdm-tab--active' : ''}`}
            onClick={() => setTab('summary')}
          >
            Hand Summary
          </button>
          <button
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
      <span className={`hdm-net${r.net > 0 ? ' hdm-net--win' : r.net < 0 ? ' hdm-net--loss' : ''}`}>
        {r.net > 0 ? '+' : ''}
        {fmt(r.net)}
      </span>
    </div>
  );
}

export default HandDetailModal;
