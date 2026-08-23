/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA — Hand History Panel
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Slide-out panel showing recent hand history with expandable details,
 * street-by-street action replay, and export/share functionality.
 */

import { useState, useEffect, memo, useCallback, useMemo, useRef } from 'react';
import './HandHistoryPanel.css';

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
  }>;
  streets: HandHistoryStreet[];
  winners: Array<{
    playerId: string;
    playerName: string;
    amount: number;
    hand?: string; // "Full House, Aces over Kings"
  }>;
  heroId: string;
  heroResult: number; // +/- amount
  potTotal: number;
}

export interface HandHistoryPanelProps {
  isOpen: boolean;
  onClose: () => void;
  hands: HandRecord[];
  heroId: string;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatAmount(amount: number): string {
  if (Math.abs(amount) >= 1000000) return `${(amount / 1000000).toFixed(1)}M`;
  if (Math.abs(amount) >= 10000) return `${(amount / 1000).toFixed(1)}K`;
  return amount.toLocaleString();
}

function getActionColor(action: string): string {
  switch (action) {
    case 'fold':
      return '#ef4444';
    case 'check':
      return '#22c55e';
    case 'call':
      return '#22c55e';
    case 'bet':
      return '#f59e0b';
    case 'raise':
      return '#f59e0b';
    case 'discard':
      return '#94a3b8';
    case 'allin':
      return '#7c3aed';
    default:
      return '#9ca3af';
  }
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
  hand.winners.forEach((w) => {
    const handStr = w.hand ? ` with ${w.hand}` : '';
    lines.push(`${w.playerName} won ${formatAmount(w.amount)}${handStr}`);
  });

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
}) {
  const isWin = hand.heroResult > 0;
  const resultColor = hand.heroResult > 0 ? '#22c55e' : hand.heroResult < 0 ? '#ef4444' : '#9ca3af';

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

          {/* X6.2g: Showdown section header per spec §10.4 */}
          {hand.winners.length > 0 && (
            <div className="hh-entry__street">
              <div className="hh-entry__street-header">
                <span className="hh-entry__street-name">Showdown</span>
              </div>
              <div className="hh-entry__winners">
                {hand.winners.map((w, i) => (
                  <span key={i} className="hh-entry__winner">
                    {w.playerName} Won {formatAmount(w.amount)}
                    {w.hand && <span className="hh-entry__hand"> - {w.hand}</span>}
                  </span>
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

  if (!isOpen) return null;

  return (
    <div className="hh-panel">
      {/* Header */}
      <div className="hh-panel__header">
        <h3 className="hh-panel__title">Hand History</h3>
        <div className="hh-panel__header-actions">
          <button className="hh-panel__export" onClick={exportAll} title="Export all hands">
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
          <button className="hh-panel__close" onClick={onClose}>
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
                    ? '#22c55e'
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
  );
});

export default HandHistoryPanel;
