/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA — Hand History Panel  #SMARTERCASINOREALISM
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The slide-out record of the hands played AT THIS TABLE, newest first. One row
 * per hand; an expanded row is the full rundown.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-09-04 — ONE RECONSTRUCTION (Dan: "the previous hand functionality is
 * completely broken, unorganized, doesn't display the correct data, doesn't
 * display the correct hands. Needs a full audit, enhancement and upgrade.")
 *
 * This panel used to walk the action log itself: its own street list, its own
 * showdown roster, its own "who won" logic, its own export text - a FOURTH
 * reconstruction of the hand beside `buildReplay`, the modal's Summary
 * adapter and the modal's degraded walk, each wrong in a different place. It
 * now renders `hand.replay`, the model `HandHistoryService` builds ONCE from the
 * raw row, through the same `HandDetailView` the Previous Hand modal and the
 * jackpot rundown use. There is nothing here that can disagree with them.
 *
 * What the record carries that the old walk could not show:
 *   - the viewer's own cards on hands they folded or mucked (private, marked);
 *   - the low half of a PLO8 / FLO8 pot, as its own row;
 *   - who won each run of a run-it-twice, with the hand on THAT run;
 *   - the stack after every action, when the rebuild reconciles;
 *   - rake and the jackpot drop, beside the pot they came out of.
 *
 * The stats strip says what it counts: the last N hands loaded for this table,
 * not "the session".
 */

import { useState, useEffect, memo, useCallback, useMemo, useRef } from 'react';
import HandDetailView from '../handdetail/HandDetailView';
import type { ReplayModel } from '../../utils/handReplay';
import type { HeroHandFacts } from '../../services/HandHistoryService';
import { gameTypeLabel, money, stamp } from '../../utils/handFormat';
import { formatTableChips } from '../../utils/format';
import './HandHistoryPanel.css';

export interface HandHistoryAction {
  playerName: string;
  playerId: string;
  /**
   * Every verb the engine writes. `sb`/`bb`/`ante`/`straddle`/`post` are the
   * forced money that opens a hand; `return` is an uncalled bet handed BACK
   * (its amount comes OUT of the pot).
   */
  action:
    | 'fold'
    | 'check'
    | 'call'
    | 'bet'
    | 'raise'
    | 'allin'
    | 'discard'
    | 'sb'
    | 'bb'
    | 'ante'
    | 'straddle'
    | 'post'
    | 'return';
  amount?: number;
  /** The card this player threw, canonical code, only ever the VIEWER'S OWN. */
  discardedCard?: string;
}

export interface HandHistoryStreet {
  name: 'preflop' | 'pineapple_discard' | 'flop' | 'turn' | 'river';
  cards?: string[];
  actions: HandHistoryAction[];
  pot: number;
}

/**
 * The panel's view of a hand. The per-street / per-player fields are the
 * legacy flat shape the share link is built from; `replay` is what is drawn.
 */
export interface HandRecord {
  id: string;
  handNumber: number;
  timestamp: number;
  gameType: string;
  blinds: string;
  players: Array<{
    id: string;
    name: string;
    seat: number;
    stack: number;
    position: string;
    /** Showdown-revealed holdings only: what the table saw. */
    holeCards?: string[];
    /** The viewer's own cards on a hand they did not show. Viewer's row only. */
    privateHoleCards?: string[];
    /** This player's NET for the hand: collected minus invested. */
    result?: number;
  }>;
  streets: HandHistoryStreet[];
  winners: Array<{
    playerId: string;
    playerName: string;
    /** GROSS chips pushed from the pot to this winner, NOT their net result. */
    amount: number;
    hand?: string;
  }>;
  heroId: string;
  heroResult: number;
  potTotal: number;
  /** Run-it-twice boards 2..N. Board 1 stays in `streets[].cards`. */
  ritBoards?: string[][];
  /** Bomb-pot boards 2 and 3. */
  bombBoards?: string[][];
  /** Who won each board, with the hand ON THAT board; `low` on a hi-lo low half. */
  winnersByBoard?: Array<{
    board: number;
    playerId: string;
    playerName: string;
    amount: number;
    hand?: string;
    low?: boolean;
  }>;
  /** Did any card get turned over at the end? False on a fold-around. */
  wentToShowdown: boolean;
  /** Players who reached showdown and mucked. */
  muckedIds: string[];
  rake: number;
  bbjFee: number;
  /** The table's name, for the export header. */
  tableName?: string;
  /** Bomb-pot facts, when the hand was one. */
  bombPot?: {
    trigger_reason?: string;
    ante_amount?: number;
    board_count?: number;
    variant?: string;
  } | null;
  /** Phase 2: the viewer's own all-in equity / EV facts (ca_hand_facts), when recorded. */
  heroFacts?: HeroHandFacts;
  /** THE model. Built once by HandHistoryService; every surface draws this. */
  replay: ReplayModel;
}

export type HandHistoryLoadState = 'idle' | 'loading' | 'ready' | 'failed';

export interface HandHistoryPanelProps {
  isOpen: boolean;
  onClose: () => void;
  hands: HandRecord[];
  heroId: string;
  /** Where the list is in its fetch, so an empty list can say why it is empty. */
  loadState?: HandHistoryLoadState;
  /**
   * False for a spectator (Phase 1, 2026-09-05). A hand is readable by the
   * players dealt into it, so a railbird's list is empty by design - and the
   * old copy told them the TABLE had no hands, which was false.
   */
  viewerSeated?: boolean;
  /** Open the animated replay of THE HAND PASSED IN. */
  onReplay?: (hand: HandRecord) => void;
  /** Open the Hand Detail modal AT the hand passed in. */
  onOpenDetail?: (hand: HandRecord) => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatAmount(amount: number): string {
  // Dan 2026-08-28: hand history is a record. It shows the real number.
  return formatTableChips(amount);
}

function signed(n: number): string {
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}${formatAmount(Math.abs(n))}`;
}

/* Voluntary money preflop: the VPIP definition. A blind is not voluntary; a
   check is not money. */
const VPIP_VERBS = new Set(['call', 'bet', 'raise', 'all_in']);

function heroVpip(model: ReplayModel, heroId: string): boolean {
  const preflop = model.streets.find((s) => s.key === 'preflop');
  if (!preflop) return false;
  return preflop.rows.some((r) => r.userId === heroId && VPIP_VERBS.has(r.verb));
}

/**
 * The hand as text, from the model - so the file a player exports carries the
 * same verbs, the same incremental amounts and the same boards the screen
 * shows. It used to print the raw database token (`sb`, `return`, `allin`),
 * drop every zero, and know nothing about run-it-twice, the low half, rake
 * or the jackpot drop.
 */
export function handToText(hand: HandRecord): string {
  const m = hand.replay;
  const lines: string[] = [];
  lines.push(
    `Club Arena Hand #${hand.handNumber} - ${gameTypeLabel(m.gameVariant) || hand.gameType} (${hand.blinds})` +
      (hand.tableName ? ` - ${hand.tableName}` : '')
  );
  lines.push(`Time: ${stamp(m.playedAt) || new Date(hand.timestamp).toLocaleString()}`);
  lines.push('');

  for (const p of m.players) {
    const cards = p.hole?.length
      ? ` [${p.hole.map((c) => `${c.rank}${String(c.suit).charAt(0)}`).join(' ')}]`
      : p.privateHole?.length
        ? ` [${p.privateHole.map((c) => `${c.rank}${String(c.suit).charAt(0)}`).join(' ')}] (Yours, Not Shown)`
        : '';
    const stack = p.startStack === null ? '' : ` (${money(p.startStack)})`;
    lines.push(`Seat ${p.seat}: ${p.username}${stack}${cards} ${p.position}`.trimEnd());
  }
  lines.push('');

  for (const s of m.streets) {
    const board = s.board.length
      ? ` [${s.board.map((c) => `${c.rank}${String(c.suit).charAt(0)}`).join(' ')}]`
      : '';
    lines.push(`*** ${s.label.toUpperCase()} ***${board}`);
    s.extraBoards.forEach((b, i) => {
      if (b.length)
        lines.push(
          `    Run ${i + 2}: [${b.map((c) => `${c.rank}${String(c.suit).charAt(0)}`).join(' ')}]`
        );
    });
    for (const r of s.rows) {
      const amt = r.amount !== 0 ? ` ${money(r.amount)}` : '';
      const extra = r.discardedCard
        ? ` [${r.discardedCard.rank}${String(r.discardedCard.suit).charAt(0)}]`
        : r.shownCards?.length
          ? ` [${r.shownCards.map((c) => `${c.rank}${String(c.suit).charAt(0)}`).join(' ')}]`
          : '';
      lines.push(`${r.name}: ${r.label}${amt}${extra}`);
    }
    if (s.isFinal)
      lines.push(`Pot: ${m.pots.map((p) => `${p.label}(${money(p.amount)})`).join(' ')}`);
    lines.push('');
  }

  lines.push('*** SUMMARY ***');
  lines.push(`Total pot: ${money(m.potTotal)}`);
  if (m.rake > 0) lines.push(`Rake: ${money(m.rake)}`);
  if (m.bbjFee > 0) lines.push(`Jackpot fee: ${money(m.bbjFee)}`);
  /* "collected N from pot" is the PokerStars wording for the GROSS the pot
     paid out; the net is its own line below. */
  for (const w of hand.winners) {
    const rows = m.showdown.filter((r) => r.userId === w.playerId && r.isWinner);
    const withWhat = rows.length
      ? ` with ${rows
          .map(
            (r) =>
              `${r.handName}${r.low ? ' (low)' : ''}${r.boardLabel ? ` on ${r.boardLabel}` : ''}`
          )
          .join(', ')}`
      : m.showdown.length === 0
        ? ' without a showdown'
        : '';
    lines.push(`${w.playerName} collected ${money(w.amount)} from pot${withWhat}`);
  }
  const winnerIds = new Set(hand.winners.map((w) => w.playerId));
  const said = new Set<string>();
  for (const r of m.showdown) {
    if (winnerIds.has(r.userId) || said.has(r.userId)) continue;
    said.add(r.userId);
    lines.push(
      r.hole
        ? `${r.name} showed ${r.handName}${r.holePrivate ? ' (yours, not shown)' : ''}`
        : `${r.name} mucked`
    );
  }
  const hero = m.players.find((p) => p.userId === hand.heroId);
  if (hero) lines.push(`${hero.username} net result: ${signed(hero.net)}`);
  return lines.join('\n');
}

function BombPotFacts({ facts }: { facts: NonNullable<HandRecord['bombPot']> }) {
  const bits: string[] = [];
  if (facts.trigger_reason) bits.push(String(facts.trigger_reason).replace(/_/g, ' '));
  if (typeof facts.ante_amount === 'number' && facts.ante_amount > 0)
    bits.push(`Ante ${money(facts.ante_amount)}`);
  if (typeof facts.board_count === 'number' && facts.board_count > 1)
    bits.push(`${facts.board_count} Boards`);
  if (facts.variant) bits.push(gameTypeLabel(facts.variant) || String(facts.variant));
  if (bits.length === 0) return null;
  return (
    <div className="hh-entry__facts">
      <span className="hh-entry__facts-label">Bomb Pot</span>
      <span className="hh-entry__facts-body">{bits.join(' · ')}</span>
    </div>
  );
}

function HandEntry({
  hand,
  heroId,
  isExpanded,
  onToggle,
  onReplay,
  onOpenDetail,
}: {
  hand: HandRecord;
  heroId: string;
  isExpanded: boolean;
  onToggle: () => void;
  onReplay?: (hand: HandRecord) => void;
  onOpenDetail?: (hand: HandRecord) => void;
}) {
  const heroNet = hand.replay.players.find((p) => p.userId === heroId)?.net ?? hand.heroResult;
  const tone = heroNet > 0 ? 'up' : heroNet < 0 ? 'down' : 'flat';
  const variant = gameTypeLabel(hand.replay.gameVariant) || hand.gameType;
  const runs = hand.replay.boards.length;
  const isHero = hand.players.some((p) => p.id === heroId);

  return (
    <div
      className={`hh-entry${isExpanded ? ' hh-entry--expanded' : ''}${isHero ? '' : ' hh-entry--observer'}`}
    >
      <button
        type="button"
        className="hh-entry__summary"
        onClick={onToggle}
        aria-expanded={isExpanded}
      >
        <span className="hh-entry__num">#{hand.handNumber}</span>
        <span className="hh-entry__time">{formatTime(hand.timestamp)}</span>
        <span className="hh-entry__pot">
          Pot {formatAmount(hand.replay.potTotal || hand.potTotal)}
          {hand.rake > 0 && (
            <span className="hh-entry__rake"> · Rake {formatAmount(hand.rake)}</span>
          )}
        </span>
        <span className="hh-entry__tags">
          {runs > 1 && (
            <span className="hh-entry__tag">
              {hand.bombPot ? 'Bomb' : runs >= 3 ? 'Run 3x' : 'Run 2x'}
            </span>
          )}
          {hand.replay.hiLo && <span className="hh-entry__tag">Hi-Lo</span>}
          {!hand.wentToShowdown && (
            <span className="hh-entry__tag hh-entry__tag--quiet">No Showdown</span>
          )}
        </span>
        <span className={`hh-entry__result hh-entry__result--${tone}`}>{signed(heroNet)}</span>
        <span className={`hh-entry__chevron${isExpanded ? ' hh-entry__chevron--open' : ''}`}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M3 4.5l3 3 3-3"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </span>
      </button>

      {isExpanded && (
        <div className="hh-entry__detail">
          {hand.bombPot && <BombPotFacts facts={hand.bombPot} />}
          {/* THE rundown: the same component and the same model as the Previous
              Hand modal and the jackpot popup. Nothing here is computed twice. */}
          <HandDetailView
            model={hand.replay}
            currentUserId={heroId}
            badge={variant}
            viewerFacts={hand.heroFacts}
          />
          {(onReplay || onOpenDetail) && (
            <div className="hh-entry__actions-row">
              {onOpenDetail && (
                <button type="button" className="hh-entry__btn" onClick={() => onOpenDetail(hand)}>
                  Open Hand Detail
                </button>
              )}
              {onReplay && (
                <button
                  type="button"
                  className="hh-entry__btn hh-entry__btn--primary"
                  onClick={() => onReplay(hand)}
                >
                  Replay
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const HandHistoryPanel = memo(function HandHistoryPanel({
  isOpen,
  onClose,
  hands,
  heroId,
  loadState = 'ready',
  viewerSeated = true,
  onReplay,
  onOpenDetail,
}: HandHistoryPanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /* Index-keyed, not appended: an out-of-order timer used to mark the wrong
     row visible, and the effect re-ran (and reset every row to hidden) on any
     new array identity. Keyed by the ids the list holds instead. */
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const idSignature = hands.map((h) => h.id).join('|');

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const exportAll = useCallback(() => {
    const text = hands.map((h) => handToText(h)).join('\n\n' + '='.repeat(60) + '\n\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `club-arena-hands-${Date.now()}.txt`;
    /* Attached, clicked, then detached; the URL is revoked on the next tick.
       Revoking synchronously after click() cancels the download on Firefox
       and some WebKit builds. */
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }, [hands]);

  /**
   * WHAT THE STRIP COUNTS, SAID OUT LOUD. These are the hands LOADED for this
   * table (newest 50 at most), not a session. `Won` counts pots the viewer
   * took - a walk is a pot taken, even at net zero - and VPIP is the
   * preflop-voluntary rate over hands the viewer was dealt into.
   */
  const stats = useMemo(() => {
    const mine = hands.filter((h) => h.replay.players.some((p) => p.userId === heroId));
    if (!mine.length) return null;
    let net = 0;
    let won = 0;
    let vpip = 0;
    let best = -Infinity;
    let worst = Infinity;
    for (const h of mine) {
      const me = h.replay.players.find((p) => p.userId === heroId)!;
      net += me.net;
      if (me.won > 0) won += 1;
      if (heroVpip(h.replay, heroId)) vpip += 1;
      if (me.net > best) best = me.net;
      if (me.net < worst) worst = me.net;
    }
    return {
      hands: mine.length,
      net: Math.round(net * 100) / 100,
      won,
      vpipPct: Math.round((vpip / mine.length) * 100),
      best: best === -Infinity ? 0 : best,
      worst: worst === Infinity ? 0 : worst,
    };
  }, [hands, heroId]);

  useEffect(() => {
    if (!isOpen) return;
    staggerTimersRef.current.forEach(clearTimeout);
    staggerTimersRef.current = [];
    const ids = idSignature ? idSignature.split('|') : [];
    setVisible((prev) => {
      // Rows already on screen stay; only new ids animate in.
      const next: Record<string, boolean> = {};
      for (const id of ids) if (prev[id]) next[id] = true;
      return next;
    });
    ids.forEach((id, i) => {
      staggerTimersRef.current.push(
        setTimeout(
          () => setVisible((prev) => (prev[id] ? prev : { ...prev, [id]: true })),
          Math.min(i, 12) * 40
        )
      );
    });
    return () => {
      staggerTimersRef.current.forEach(clearTimeout);
      staggerTimersRef.current = [];
    };
  }, [isOpen, idSignature]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const busy = loadState === 'loading' && hands.length === 0;

  return (
    <>
      <div className="hh-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        className="hh-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Hand History"
        aria-busy={busy}
      >
        <div className="hh-panel__grab" aria-hidden="true">
          <span />
        </div>
        <div className="hh-panel__header">
          <div className="hh-panel__titles">
            <span className="hh-panel__eyebrow">This Table</span>
            <h3 className="hh-panel__title">Hand History</h3>
          </div>
          <div className="hh-panel__header-actions">
            <button
              type="button"
              className="hh-panel__iconbtn"
              onClick={exportAll}
              disabled={hands.length === 0}
              title="Export All Hands"
              aria-label="Export All Hands"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M8 2v8M4 7l4 4 4-4M2 12h12"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              type="button"
              className="hh-panel__iconbtn"
              onClick={onClose}
              aria-label="Close"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        </div>

        {stats && (
          <div className="hh-panel__stats" aria-label={`Last ${stats.hands} Hands At This Table`}>
            <div className="hh-panel__stats-scope">Last {stats.hands} Hands At This Table</div>
            <div className="hh-panel__stats-grid">
              <div className="hh-panel__stat">
                <span className="hh-panel__stat-label">Net</span>
                <span
                  className={`hh-panel__stat-value hh-panel__stat-value--${
                    stats.net > 0 ? 'up' : stats.net < 0 ? 'down' : 'flat'
                  }`}
                >
                  {signed(stats.net)}
                </span>
              </div>
              <div className="hh-panel__stat">
                <span className="hh-panel__stat-label">Pots Won</span>
                <span className="hh-panel__stat-value">
                  {stats.won}/{stats.hands}
                </span>
              </div>
              <div className="hh-panel__stat">
                <span className="hh-panel__stat-label">VPIP</span>
                <span className="hh-panel__stat-value">{stats.vpipPct}%</span>
              </div>
              <div className="hh-panel__stat">
                <span className="hh-panel__stat-label">Best</span>
                <span className="hh-panel__stat-value hh-panel__stat-value--up">
                  {signed(stats.best)}
                </span>
              </div>
              <div className="hh-panel__stat">
                <span className="hh-panel__stat-label">Worst</span>
                <span className="hh-panel__stat-value hh-panel__stat-value--down">
                  {signed(stats.worst)}
                </span>
              </div>
            </div>
          </div>
        )}

        <div className="hh-panel__list">
          {hands.length === 0 ? (
            <div className="hh-panel__empty">
              {loadState === 'loading'
                ? 'Loading Hands'
                : loadState === 'failed'
                  ? 'Could Not Load The Hands For This Table'
                  : viewerSeated
                    ? 'No Completed Hands For You At This Table Yet'
                    : 'You Are Watching. Hands Are Recorded For The Players Dealt Into Them. Take A Seat And Yours Will Appear Here.'}
            </div>
          ) : (
            hands.map((hand) => (
              <div
                key={hand.id}
                className={`hh-panel__item${visible[hand.id] ? ' hh-panel__item--in' : ''}`}
              >
                <HandEntry
                  hand={hand}
                  heroId={heroId}
                  isExpanded={expandedId === hand.id}
                  onToggle={() => toggleExpand(hand.id)}
                  onReplay={onReplay}
                  onOpenDetail={onOpenDetail}
                />
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
});

export default HandHistoryPanel;
