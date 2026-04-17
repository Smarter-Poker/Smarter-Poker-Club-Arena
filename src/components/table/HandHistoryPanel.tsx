/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA — Hand History Panel
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Slide-out panel showing recent hand history with expandable details,
 * street-by-street action replay, and export/share functionality.
 */

import { useState, useEffect, memo, useCallback, useMemo } from 'react';
import './HandHistoryPanel.css';

export interface HandHistoryAction {
  playerName: string;
  playerId: string;
  action: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';
  amount?: number;
}

export interface HandHistoryStreet {
  name: 'preflop' | 'flop' | 'turn' | 'river';
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
    case 'allin':
      return '#7c3aed';
    default:
      return '#9ca3af';
  }
}

function getActionLabel(action: string): string {
  switch (action) {
    case 'fold':
      return 'Fold';
    case 'check':
      return 'Check';
    case 'call':
      return 'Call';
    case 'bet':
      return 'Bet';
    case 'raise':
      return 'Raise';
    case 'allin':
      return 'All-In';
    default:
      return action;
  }
}

/** Parse card string like "Ah" into rank + suit */
function parseCard(card: string): { rank: string; suit: string; suitChar: string; color: string } {
  const rank = card.slice(0, -1);
  const suitCode = card.slice(-1).toLowerCase();
  const suitMap: Record<string, { char: string; color: string }> = {
    h: { char: '\u2665', color: '#ef4444' },
    d: { char: '\u2666', color: '#3b82f6' },
    c: { char: '\u2663', color: '#1f2937' },
    s: { char: '\u2660', color: '#1f2937' },
  };
  const info = suitMap[suitCode] || { char: '?', color: '#9ca3af' };
  return { rank: rank.toUpperCase(), suit: suitCode, suitChar: info.char, color: info.color };
}

/** Render a mini card chip */
function MiniCard({ card }: { card: string }) {
  const { rank, suit, suitChar, color } = parseCard(card);
  const isRed = suit === 'h' || suit === 'd';
  return (
    <span className={`hh-mini-card ${isRed ? 'hh-mini-card--red' : 'hh-mini-card--black'}`}>
      <span className="hh-mini-card__rank">{rank}</span>
      <span className="hh-mini-card__suit" style={{ color }}>{suitChar}</span>
    </span>
  );
}

function getStreetLabel(name: string): string {
  switch (name) {
    case 'preflop':
      return 'Pre-Flop';
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
  const isLoss = hand.heroResult < 0;
  const resultColor = isWin ? '#22c55e' : isLoss ? '#ef4444' : '#9ca3af';
  const resultClass = isWin ? 'hh-entry--win' : isLoss ? 'hh-entry--loss' : '';
  const hero = hand.players.find((p) => p.id === heroId);
  const heroCards = hero?.holeCards;

  return (
    <div className={`hh-entry ${resultClass} ${isExpanded ? 'hh-entry--expanded' : ''}`}>
      {/* Summary row */}
      <button className="hh-entry__summary" onClick={onToggle}>
        <div className="hh-entry__left">
          <span className="hh-entry__num">#{hand.handNumber}</span>
          <span className="hh-entry__time">{formatTime(hand.timestamp)}</span>
        </div>
        <div className="hh-entry__center">
          {heroCards && heroCards.length > 0 && (
            <div className="hh-entry__hero-cards">
              {heroCards.map((c, i) => (
                <MiniCard key={i} card={c} />
              ))}
            </div>
          )}
        </div>
        <div className="hh-entry__right">
          <div className="hh-entry__result-group">
            <span className="hh-entry__pot-label">Pot {formatAmount(hand.potTotal)}</span>
            <span className="hh-entry__result" style={{ color: resultColor }}>
              {hand.heroResult > 0 ? '+' : ''}
              {formatAmount(hand.heroResult)}
            </span>
          </div>
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
        </div>
      </button>

      {/* Result indicator bar */}
      <div
        className="hh-entry__result-bar"
        style={{
          background: isWin
            ? 'linear-gradient(90deg, rgba(34, 197, 94, 0.4), transparent)'
            : isLoss
              ? 'linear-gradient(90deg, rgba(239, 68, 68, 0.3), transparent)'
              : 'transparent',
        }}
      />

      {/* Expanded detail */}
      {isExpanded && (
        <div className="hh-entry__detail">
          {/* Players table */}
          <div className="hh-entry__players">
            <div className="hh-entry__players-title">Players</div>
            {hand.players.map((p, pi) => (
              <div
                key={pi}
                className={`hh-entry__player-row ${p.id === heroId ? 'hh-entry__player-row--hero' : ''}`}
              >
                <span className="hh-entry__player-pos">{p.position}</span>
                <span className="hh-entry__player-name-full">{p.name}</span>
                <span className="hh-entry__player-stack">{formatAmount(p.stack)}</span>
                {p.holeCards && p.holeCards.length > 0 && (
                  <div className="hh-entry__player-cards">
                    {p.holeCards.map((c, ci) => (
                      <MiniCard key={ci} card={c} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Winners */}
          <div className="hh-entry__winners">
            <div className="hh-entry__winners-icon">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path
                  d="M7 1l1.7 3.5 3.8.5-2.75 2.7.65 3.8L7 9.75 3.6 11.5l.65-3.8L1.5 5l3.8-.5z"
                  fill="#ffd700"
                  stroke="#b8860b"
                  strokeWidth="0.5"
                />
              </svg>
            </div>
            {hand.winners.map((w, i) => (
              <div key={i} className="hh-entry__winner">
                <span className="hh-entry__winner-name">{w.playerName}</span>
                <span className="hh-entry__winner-amount">+{formatAmount(w.amount)}</span>
                {w.hand && <span className="hh-entry__winner-hand">{w.hand}</span>}
              </div>
            ))}
          </div>

          {/* Street actions */}
          {hand.streets.map((street, si) => (
            <div key={si} className="hh-entry__street">
              <div className="hh-entry__street-header">
                <span className="hh-entry__street-name">{getStreetLabel(street.name)}</span>
                {street.cards && street.cards.length > 0 && (
                  <div className="hh-entry__street-cards">
                    {street.cards.map((c, ci) => (
                      <MiniCard key={ci} card={c} />
                    ))}
                  </div>
                )}
                <span className="hh-entry__street-pot">Pot: {formatAmount(street.pot)}</span>
              </div>
              <div className="hh-entry__actions">
                {street.actions.map((a, ai) => (
                  <div key={ai} className="hh-entry__action">
                    <span className="hh-entry__action-player">{a.playerName}</span>
                    <span className="hh-entry__action-badge" style={{
                      background: `${getActionColor(a.action)}20`,
                      color: getActionColor(a.action),
                      borderColor: `${getActionColor(a.action)}40`,
                    }}>
                      {getActionLabel(a.action)}
                    </span>
                    {a.amount != null && (
                      <span className="hh-entry__action-amount">{formatAmount(a.amount)}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
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
      setVisibleHands([]);
      hands.forEach((_, i) => {
        setTimeout(() => {
          setVisibleHands((prev) => [...prev, true]);
        }, i * 50);
      });
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
          <div className="hh-panel__stat hh-panel__stat--primary">
            <span className="hh-panel__stat-label">Net Result</span>
            <span
              className={`hh-panel__stat-value hh-panel__stat-value--result ${
                sessionStats.totalResult > 0
                  ? 'hh-panel__stat-value--win'
                  : sessionStats.totalResult < 0
                    ? 'hh-panel__stat-value--loss'
                    : ''
              }`}
            >
              {sessionStats.totalResult > 0 ? '+' : ''}
              {formatAmount(sessionStats.totalResult)}
            </span>
          </div>
          <div className="hh-panel__stat">
            <span className="hh-panel__stat-label">Win Rate</span>
            <span className="hh-panel__stat-value">
              {sessionStats.handsPlayed > 0
                ? Math.round((sessionStats.wins / sessionStats.handsPlayed) * 100)
                : 0}
              %
            </span>
          </div>
          <div className="hh-panel__stat">
            <span className="hh-panel__stat-label">Best</span>
            <span className="hh-panel__stat-value" style={{ color: '#22c55e' }}>
              +{formatAmount(sessionStats.biggestWin)}
            </span>
          </div>
          <div className="hh-panel__stat">
            <span className="hh-panel__stat-label">Worst</span>
            <span className="hh-panel__stat-value" style={{ color: '#ef4444' }}>
              {formatAmount(sessionStats.biggestLoss)}
            </span>
          </div>
        </div>
      )}

      {/* Hand list */}
      <div className="hh-panel__list">
        {hands.length === 0 ? (
          <div className="hh-panel__empty">No hands played yet</div>
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
