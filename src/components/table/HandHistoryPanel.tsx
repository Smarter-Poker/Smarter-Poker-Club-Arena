/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA — Hand History Panel
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Slide-out panel showing recent hand history with expandable details,
 * street-by-street action replay, and export/share functionality.
 */

import { useState, useEffect, memo, useCallback, useMemo, useRef } from 'react';
import { toCardCodes } from '../../utils/cardCode';
import './HandHistoryPanel.css';
import { formatTableChips } from '../../utils/format';

export interface HandHistoryAction {
  playerName: string;
  playerId: string;
  action: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin' | 'discard';
  amount?: number;
}

export interface HandHistoryStreet {
  /* `pineapple_discard` is a real street the engine writes. Measured on
     2026-08-23 over 31 consecutive pineapple hands: it falls after preflop
     and before the flop in 31 of 31, with no counterexample. */
  name: 'preflop' | 'pineapple_discard' | 'flop' | 'turn' | 'river';
  cards?: string[]; // Board cards dealt this street
  actions: HandHistoryAction[];
  pot: number;
}

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
    position: string; // 'D', 'SB', 'BB', 'UTG', etc.
    holeCards?: string[]; // Only for hero or showdown
    /** This player's NET for the hand: collected minus invested, as stored.
        Optional only because a record cached in localStorage by a build older
        than 2026-08-23 predates the field; every record the adapter produces
        carries it. */
    result?: number;
  }>;
  streets: HandHistoryStreet[];
  winners: Array<{
    playerId: string;
    playerName: string;
    /** GROSS chips pushed from the pot to this winner, NOT their net result.
        This field held the net until 2026-08-23, which is what let Hand Detail
        subtract the same investment twice and print a different figure from
        Hand History for one hand. Net lives in `players[].result`. */
    amount: number;
    hand?: string; // "Full House, Aces over Kings"
  }>;
  heroId: string;
  heroResult: number; // +/- amount, the hero's `players[].result`
  potTotal: number;
  /**
   * RUN IT TWICE — boards 2..N, in run order. Board 1 is the ordinary board and
   * stays in `streets[].cards`.
   *
   * Filled by `adaptServiceHandToPanel` from the `hand_history.rit_boards`
   * column. Absent on an ordinary single-run hand, which is the overwhelming
   * majority of rows.
   */
  ritBoards?: string[][];
}

/* ═══════════════════════════════════════════════════════════════════════════
   RUN-IT-TWICE BOARDS — how they reach these two screens
   ═══════════════════════════════════════════════════════════════════════════

   Verified on production hand #3046089 (2026-08-27): it ran THREE boards, the
   server stored all three, and both hand-history screens showed one. The board
   the player was shown was not the board that decided most of the pot.

   Where it was lost: `hand_history.rit_boards` is read correctly by
   HandHistoryService (mapHandHistoryRow) and lands on the SERVICE record as
   `rit_boards` — and then `adaptServiceHandToPanel` built the view model this
   file describes and did not carry the field across. The service knew; the
   screen never heard.

   The adapter carries it now (`ritBoards` above), which is the whole path: one
   producer, one field, one reader below. A registry keyed by hand id briefly
   bridged the gap while the adapter was owned by another agent; it was deleted
   in the same commit that fixed the adapter, exactly as its own note said it
   should be. Do not reintroduce a second source for this — two of them can
   disagree about which boards a hand ran. */

export interface RunBoards {
  /** Board 1 first, then every extra run, in run order. */
  boards: string[][];
  /**
   * How many leading cards every run shares — the cards that were already on
   * the felt when the players agreed to run it again. Everything from this
   * index on is where the runs diverge, and that is the only part of a
   * run-it-twice board a player is actually reading.
   */
  sharedCount: number;
}

/**
 * Board 1 plus every extra run, normalised to canonical card codes.
 *
 * Returns null for an ordinary single-run hand, so a caller can render nothing
 * without a length check of its own.
 */
export function runBoardsFor(hand: HandRecord): RunBoards | null {
  const extra = hand.ritBoards;
  if (!extra || extra.length === 0) return null;

  /* Board 1 is stored per street by the adapter, so it is read back the same
     way rather than re-sliced from a flat list. */
  const boardOne = hand.streets
    .filter((s) => s.name === 'flop' || s.name === 'turn' || s.name === 'river')
    .flatMap((s) => s.cards || []);

  const boards = [boardOne, ...extra].map((b) => toCardCodes(b)).filter((b) => b.length > 0);
  if (boards.length < 2) return null;

  const shortest = Math.min(...boards.map((b) => b.length));
  let sharedCount = 0;
  while (sharedCount < shortest && boards.every((b) => b[sharedCount] === boards[0][sharedCount])) {
    sharedCount += 1;
  }
  return { boards, sharedCount };
}

export interface HandHistoryPanelProps {
  isOpen: boolean;
  onClose: () => void;
  hands: HandRecord[];
  heroId: string;
  onReplay?: (hand: HandRecord) => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatAmount(amount: number): string {
  // Dan 2026-08-28: hand history is a record — it shows the real number.
  return formatTableChips(amount);
}

/**
 * Dan 2026-08-23, verbatim: "REMOVE THE YELLOW AND PURPLE."
 *
 * bet/raise were amber #f59e0b and all-in was violet #7c3aed — two colours that
 * appear nowhere else on smarter.poker, so the one panel a player opens to
 * check what just happened looked like a different product from the table
 * behind it. The replacements are the same chip palette HandDetailModal.css
 * already uses for the identical actions (house blue for aggression, red for
 * all-in, grey for the passive ones), so the two hand-history surfaces finally
 * agree with each other and with the rest of the app.
 *
 * Kept as inline colours rather than CSS vars because these are handed to a
 * `style` prop; `--club-*` tokens are used in the stylesheet beside this.
 */
const HOUSE_BLUE = '#1877f2';

function getActionColor(action: string): string {
  switch (action) {
    case 'fold':
      return '#9ca3af';
    case 'check':
      return '#3fb950';
    case 'call':
      return '#3fb950';
    case 'bet':
      return HOUSE_BLUE;
    case 'raise':
      return HOUSE_BLUE;
    case 'discard':
      return '#94a3b8';
    case 'allin':
      return '#ef4444';
    default:
      return '#9ca3af';
  }
}

const SUIT_GLYPH: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };

/**
 * Render a canonical 2-char card code ("Jd") as rank + suit glyph.
 *
 * The Showdown block used to name the winner and the amount and stop there, so
 * the panel that exists to answer "what did he have?" was the one place that
 * would not say — even though handToText below has always written the holdings
 * into the clipboard export. Same data, now on screen.
 */
function CardChip({ code, shared = false }: { code: string; shared?: boolean }) {
  const suit = code.slice(-1).toLowerCase();
  const rank = code.slice(0, -1).toUpperCase().replace('T', '10');
  const red = suit === 'h' || suit === 'd';
  return (
    <span className={`hh-card${red ? ' hh-card--red' : ''}${shared ? ' hh-card--shared' : ''}`}>
      {rank}
      {SUIT_GLYPH[suit] || '?'}
    </span>
  );
}

function HoleCards({ cards }: { cards: string[] }) {
  return (
    <span className="hh-entry__holecards">
      {cards.map((c, i) => (
        <CardChip key={i} code={c} />
      ))}
    </span>
  );
}

/**
 * Every board a hand ran, one row per run.
 *
 * The runs share a prefix by construction — the cards already dealt when the
 * players agreed to run it again — so those are dimmed and only the diverging
 * cards carry full contrast. A player reading three near-identical rows of
 * five cards otherwise has to diff them by eye.
 */
function RunBoards({ runs }: { runs: RunBoards }) {
  return (
    <div className="hh-entry__street hh-runs">
      <div className="hh-entry__street-header">
        <span className="hh-entry__street-name">Run It Twice</span>
        <span className="hh-runs__count">{runs.boards.length} Boards</span>
      </div>
      {runs.boards.map((board, bi) => (
        <div className="hh-run" key={bi}>
          <span className="hh-run__badge">RUN {bi + 1}</span>
          <span className="hh-run__cards">
            {board.map((c, ci) => (
              <CardChip key={ci} code={c} shared={ci < runs.sharedCount} />
            ))}
          </span>
        </div>
      ))}
      {/* The stored winner rows carry one aggregate amount and one hand name
          per player for the WHOLE hand — no run index — so which run each
          player took is not recoverable from the row. The totals below are
          therefore labelled as covering every run rather than being split
          across the boards, which would be an invention. */}
      <div className="hh-runs__note">
        Boards Share The Cards Dealt Before The All In. Collected Totals Below Cover Every Run.
      </div>
    </div>
  );
}

function getStreetLabel(name: string): string {
  switch (name) {
    case 'preflop':
      return 'Pre-Flop';
    case 'pineapple_discard':
      return 'Discard';
    case 'flop':
      return 'Flop';
    case 'turn':
      return 'Turn';
    case 'river':
      return 'River';
    default:
      return name;
  }
}

/** Convert hand record to PokerStars-compatible text format */
function handToText(hand: HandRecord): string {
  const lines: string[] = [];
  lines.push(`Club Arena Hand #${hand.handNumber} - ${hand.gameType} (${hand.blinds})`);
  lines.push(`Time: ${new Date(hand.timestamp).toLocaleString()}`);
  lines.push('');

  // Players
  hand.players.forEach((p) => {
    const cards = p.holeCards?.length ? ` [${p.holeCards.join(' ')}]` : '';
    lines.push(`Seat ${p.seat}: ${p.name} (${formatAmount(p.stack)})${cards} ${p.position}`);
  });
  lines.push('');

  // Streets
  hand.streets.forEach((street) => {
    const boardCards = street.cards?.length ? ` [${street.cards.join(' ')}]` : '';
    lines.push(`*** ${getStreetLabel(street.name).toUpperCase()} ***${boardCards}`);
    street.actions.forEach((a) => {
      const amt = a.amount ? ` ${formatAmount(a.amount)}` : '';
      lines.push(`${a.playerName}: ${a.action}${amt}`);
    });
    lines.push('');
  });

  // Winners
  lines.push('*** SUMMARY ***');
  lines.push(`Total pot: ${formatAmount(hand.potTotal)}`);
  /* "collected N from pot" is the PokerStars wording for the GROSS the pot paid
     out, which is what `winners[].amount` holds. This line used to read "won"
     over a figure that was the player's NET, so a tracker importing the file
     booked the winner's own bets as chips that had never been in the pot. The
     net is printed on its own line rather than folded into this one, so the
     two numbers on screen each have a line here that matches them. */
  hand.winners.forEach((w) => {
    const handStr = w.hand ? ` with ${w.hand}` : '';
    lines.push(`${w.playerName} collected ${formatAmount(w.amount)} from pot${handStr}`);
  });
  const heroName = hand.players.find((p) => p.id === hand.heroId)?.name;
  if (heroName) {
    lines.push(
      `${heroName} net result: ${hand.heroResult > 0 ? '+' : ''}${formatAmount(hand.heroResult)}`
    );
  }

  return lines.join('\n');
}

function HandEntry({
  hand,
  heroId,
  isExpanded,
  onToggle,
}: {
  hand: HandRecord;
  heroId: string;
  isExpanded: boolean;
  onToggle: () => void;
  onReplay?: (hand: HandRecord) => void;
}) {
  const resultColor = hand.heroResult > 0 ? '#3fb950' : hand.heroResult < 0 ? '#ef4444' : '#9ca3af';

  /* Everyone whose cards the table saw, plus anyone who took a pot. A player
     is in `holeCards` only because the server persisted a SHOWDOWN-revealed
     holding (mucked hands are never written), so this list is exactly the set
     of hands that were public — no client-side guessing about who showed. */
  const showdownRows = useMemo(() => {
    const winnerById = new Map(hand.winners.map((w) => [w.playerId, w]));
    return hand.players
      .filter((p) => (p.holeCards && p.holeCards.length > 0) || winnerById.has(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        cards: p.holeCards || [],
        /* `collected` is the gross the pot paid this seat; `net` is what they
           are up or down on the hand. Both are shown, and labelled, because
           showing only one of them beside the other surface's choice of the
           other is precisely how Hand History and Hand Detail came to print
           two different numbers for the same hand. */
        collected: winnerById.get(p.id)?.amount,
        net: p.result,
        handName: winnerById.get(p.id)?.hand,
      }));
  }, [hand]);

  /* Null on an ordinary hand, so nothing about a single-run hand changes. */
  const runs = useMemo(() => runBoardsFor(hand), [hand]);

  return (
    <div className={`hh-entry ${isExpanded ? 'hh-entry--expanded' : ''}`}>
      {/* Summary row */}
      <button className="hh-entry__summary" onClick={onToggle}>
        <span className="hh-entry__num">#{hand.handNumber}</span>
        <span className="hh-entry__time">{formatTime(hand.timestamp)}</span>
        <span className="hh-entry__pot">Pot: {formatAmount(hand.potTotal)}</span>
        <span className="hh-entry__result" style={{ color: resultColor }}>
          {hand.heroResult > 0 ? '+' : ''}
          {formatAmount(hand.heroResult)}
        </span>
        <span className={`hh-entry__chevron ${isExpanded ? 'hh-entry__chevron--open' : ''}`}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M3 4.5l3 3 3-3"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </span>
      </button>

      {/* Expanded detail */}
      {isExpanded && (
        <div className="hh-entry__detail">
          {/* Street actions — grouped by street per spec §10.4 */}
          {hand.streets.map((street, si) => (
            <div key={si} className="hh-entry__street">
              <div className="hh-entry__street-header">
                <span className="hh-entry__street-name">{getStreetLabel(street.name)}</span>
                {street.cards && street.cards.length > 0 && (
                  <span className="hh-entry__street-cards">{street.cards.join(' ')}</span>
                )}
              </div>
              <div className="hh-entry__actions">
                {street.actions.map((a, ai) => (
                  <div key={ai} className="hh-entry__action">
                    <span className="hh-entry__player-name">{a.playerName}</span>
                    <span
                      className="hh-entry__action-type"
                      style={{ color: getActionColor(a.action) }}
                    >
                      {a.action}
                    </span>
                    {a.amount != null && (
                      <span className="hh-entry__action-amount">{formatAmount(a.amount)}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Run It Twice: every board the hand actually ran, board 1 first. */}
          {runs && <RunBoards runs={runs} />}

          {/* X6.2g: Showdown section header per spec §10.4 */}
          {showdownRows.length > 0 && (
            <div className="hh-entry__street">
              <div className="hh-entry__street-header">
                <span className="hh-entry__street-name">Showdown</span>
              </div>
              <div className="hh-entry__showdown">
                {showdownRows.map((r) => (
                  <div
                    key={r.id}
                    className={`hh-entry__shown${
                      r.collected != null ? ' hh-entry__shown--won' : ''
                    }`}
                  >
                    <span className="hh-entry__player-name">{r.name}</span>
                    {r.cards.length > 0 ? (
                      <HoleCards cards={r.cards} />
                    ) : (
                      /* The row holds nothing for this seat and never will:
                         only showdown-revealed holdings are persisted. Say so,
                         because an empty gap here reads as a load failure. */
                      <span className="hh-entry__notshown">Not Shown</span>
                    )}
                    {r.handName && <span className="hh-entry__hand">{r.handName}</span>}
                    <span className="hh-entry__tail">
                      {r.collected != null && (
                        <span className="hh-entry__won">Collected {formatAmount(r.collected)}</span>
                      )}
                      {r.net != null && (
                        <span
                          className="hh-entry__net"
                          style={{
                            color: r.net > 0 ? '#3fb950' : r.net < 0 ? '#ef4444' : '#9ca3af',
                          }}
                        >
                          Net {r.net > 0 ? '+' : ''}
                          {formatAmount(r.net)}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
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
}: HandHistoryPanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [visibleHands, setVisibleHands] = useState<boolean[]>([]);
  // CA-6 BUG FIX: stagger timers for hand entry animation had no cleanup return.
  // When the panel closes (isOpen=false) mid-animation, all pending setVisibleHands
  // calls would fire on the now-unmounted component.
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

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
    a.click();
    URL.revokeObjectURL(url);
  }, [hands]);

  const sessionStats = useMemo(() => {
    if (!hands.length) return null;
    const totalResult = hands.reduce((sum, h) => sum + h.heroResult, 0);
    const wins = hands.filter((h) => h.heroResult > 0).length;
    const biggestWin = Math.max(0, ...hands.map((h) => h.heroResult));
    const biggestLoss = Math.min(0, ...hands.map((h) => h.heroResult));
    return { totalResult, wins, handsPlayed: hands.length, biggestWin, biggestLoss };
  }, [hands]);

  useEffect(() => {
    if (isOpen) {
      // Cancel any in-flight stagger timers from a previous open
      staggerTimersRef.current.forEach(clearTimeout);
      staggerTimersRef.current = [];
      setVisibleHands([]);
      hands.forEach((_, i) => {
        staggerTimersRef.current.push(
          setTimeout(() => {
            setVisibleHands((prev) => [...prev, true]);
          }, i * 50)
        );
      });
      return () => {
        staggerTimersRef.current.forEach(clearTimeout);
        staggerTimersRef.current = [];
      };
    }
  }, [isOpen, hands]);

  /* Escape closes the panel from the panel itself.
   *
   * It had no key handler of its own and no backdrop, so on a phone the only
   * way out was the 32px X in the corner — and in the installed app that X can
   * sit under the status bar. TableChat's pair (outside-click + Escape) is the
   * established shape in this repo; here the backdrop below IS the outside
   * click, so this is the other half. */
  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <>
      {/* A real, tappable backdrop. There was none: the panel was a lone fixed
          div, so "tap anywhere else to close" — the gesture every other sheet
          in Club Arena answers — did nothing at all here. */}
      <div className="hh-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="hh-panel" role="dialog" aria-label="Hand History">
        {/* Bottom-sheet grab handle. CSS shows it only where the panel IS a
            bottom sheet (<=640px); on the desktop drawer it stays hidden. */}
        <div className="hh-panel__grab" aria-hidden="true">
          <span />
        </div>
        {/* Header */}
        <div className="hh-panel__header">
          <h3 className="hh-panel__title">Hand History</h3>
          <div className="hh-panel__header-actions">
            <button className="hh-panel__export" onClick={exportAll} title="Export All Hands">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M8 2v8M4 7l4 4 4-4M2 12h12"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button className="hh-panel__close" onClick={onClose} aria-label="Close">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
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

        {/* Session stats */}
        {sessionStats && (
          <div className="hh-panel__stats">
            <div className="hh-panel__stat">
              <span className="hh-panel__stat-label">Hands</span>
              <span className="hh-panel__stat-value">{sessionStats.handsPlayed}</span>
            </div>
            <div className="hh-panel__stat">
              <span className="hh-panel__stat-label">Result</span>
              <span
                className="hh-panel__stat-value"
                style={{
                  color:
                    sessionStats.totalResult > 0
                      ? '#3fb950'
                      : sessionStats.totalResult < 0
                        ? '#ef4444'
                        : '#9ca3af',
                }}
              >
                {sessionStats.totalResult > 0 ? '+' : ''}
                {formatAmount(sessionStats.totalResult)}
              </span>
            </div>
            <div className="hh-panel__stat">
              <span className="hh-panel__stat-label">Wins</span>
              <span className="hh-panel__stat-value">
                {sessionStats.wins}/{sessionStats.handsPlayed}
              </span>
            </div>
          </div>
        )}

        {/* Hand list */}
        <div className="hh-panel__list">
          {hands.length === 0 ? (
            <div className="hh-panel__empty">No Hands Played Yet</div>
          ) : (
            hands.map((hand, idx) => (
              <div
                key={hand.id}
                style={{
                  opacity: visibleHands[idx] ? 1 : 0,
                  transform: visibleHands[idx] ? 'translateY(0)' : 'translateY(8px)',
                  transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                }}
              >
                <HandEntry
                  hand={hand}
                  heroId={heroId}
                  isExpanded={expandedId === hand.id}
                  onToggle={() => toggleExpand(hand.id)}
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
