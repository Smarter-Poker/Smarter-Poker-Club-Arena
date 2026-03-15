/**
 * ♠ CLUB ARENA — Seat Slot Component
 * ═══════════════════════════════════════════════════════════════════════════════
 * EXACT PokerBros seat layout:
 *
 *   [Fold badge above]
 *        ┌──────┐
 *        │Avatar│  ← 56px circle with custom image
 *        └──────┘
 *      ┌──────────┐
 *      │  ~Name~  │  ← Dark rounded box, neon yellow border when active
 *      │  7,744   │  ← Green chip count
 *      └──────────┘
 *         (D)       ← Position chip near avatar
 *
 * Active player: neon yellow glowing border around the info box
 * that DISAPPEARS as the clock counts down (CSS conic-gradient mask).
 */

import React, { useMemo, useState, useEffect, memo } from 'react';
import './SeatSlot.css';
import { CardImage, CardBack } from './CardImage';
import MiniHUD, { type MiniHUDStats } from './MiniHUD';
import type { PlayerStyleResult } from '../../services/PlayerStyleClassifier';
import { ChipPhysics } from './ChipPhysics';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Card {
  rank: '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
  suit: 'h' | 'd' | 'c' | 's';
}

export type PlayerStatus = 'active' | 'away' | 'sitting_out' | 'folded' | 'all_in';
export type PositionBadge = 'D' | 'SB' | 'BB' | null;
export type LastAction = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in' | null;

export interface SeatPlayer {
  id: string;
  name: string;
  avatar?: string;
  stack: number;
  status: PlayerStatus;
  holeCards?: Card[];
  showCards: boolean;
  isHero: boolean;
}

export interface SeatSlotProps {
  seatNumber: number;
  player: SeatPlayer | null;
  position: PositionBadge;
  isActive: boolean;
  lastAction: LastAction;
  lastBetAmount?: number;
  timerProgress?: number; // 0-100 (100 = full time, 0 = out of time)
  bigBlind?: number;
  isTournament?: boolean;
  bountyValue?: number;
  isWinner?: boolean;
  winningHandName?: string; // e.g. "Straight", "Full House"
  hudStats?: MiniHUDStats | null; // Opponent VPIP/PFR stats
  showHUD?: boolean; // Whether to show the HUD overlay
  playerStyle?: PlayerStyleResult | null; // Auto-classified player archetype
  deckStyle?: '4color' | '2color';
  cardBack?: string; // Card back design ID (e.g. 'classic_red', 'black', 'clubs_gold')
  showStackInBB?: boolean;
  onSit?: () => void;
  onAction?: () => void;
  onAvatarClick?: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function formatStack(amount: number): string {
  if (amount >= 1000000) return `${(amount / 1000000).toFixed(1)}M`;
  if (amount >= 100000) return `${(amount / 1000).toFixed(0)}K`;
  if (amount >= 10000) return `${(amount / 1000).toFixed(1)}K`;
  if (amount === Math.floor(amount)) return amount.toLocaleString();
  return amount.toFixed(2);
}

function formatStackAsBB(stack: number, bigBlind: number): string {
  if (bigBlind <= 0) return '0 BB';
  const bb = stack / bigBlind;
  if (bb >= 1000) return `${(bb / 1000).toFixed(1)}K BB`;
  if (bb >= 100) return `${Math.round(bb)} BB`;
  return `${bb.toFixed(1)} BB`;
}

/** Returns CSS class for stack depth color coding */
function getStackDepthClass(stack: number, bigBlind: number): string {
  if (bigBlind <= 0) return '';
  const bb = stack / bigBlind;
  if (bb < 10) return 'seat__stack--critical';
  if (bb < 20) return 'seat__stack--danger';
  if (bb < 50) return 'seat__stack--warning';
  if (bb < 100) return 'seat__stack--normal';
  return ''; // healthy — default white
}

function getActionLabel(action: LastAction, amount?: number): string {
  switch (action) {
    case 'fold':
      return 'Fold';
    case 'check':
      return 'Check';
    case 'call':
      return amount ? `Call ${formatStack(amount)}` : 'Call';
    case 'bet':
      return amount ? `Bet ${formatStack(amount)}` : 'Bet';
    case 'raise':
      return amount ? `Raise ${formatStack(amount)}` : 'Raise';
    case 'all_in':
      return 'ALL IN';
    default:
      return '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HOLE CARDS
// ═══════════════════════════════════════════════════════════════════════════════

function HoleCard({
  card,
  hidden = false,
  index,
  isHero = false,
  isWinner = false,
  deckStyle = '4color',
  cardBack = 'classic_blue',
}: {
  card?: Card;
  hidden?: boolean;
  index: number;
  isHero?: boolean;
  isWinner?: boolean;
  deckStyle?: '4color' | '2color';
  cardBack?: string;
}) {
  // PokerBros-style: hero cards have wider fan tilt, opponents tighter
  const rotation = isHero ? (index === 0 ? -12 : 12) : index === 0 ? -8 : 8;
  const size = isHero ? 'md' : 'sm';

  if (hidden || !card) {
    return (
      <div className="seat__card seat__card--back" style={{ transform: `rotate(${rotation}deg)` }}>
        <CardBack size={size} style={cardBack} />
      </div>
    );
  }
  return (
    <div
      className={`seat__card seat__card--face${isWinner ? ' seat__card--winner' : ''}`}
      style={{ transform: `rotate(${rotation}deg)` }}
    >
      <CardImage card={card} deckStyle={deckStyle} size={size} isHighlighted={isWinner} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// POSITION CHIP — D / SB / BB badge
// ═══════════════════════════════════════════════════════════════════════════════

function PositionChip({ position }: { position: PositionBadge }) {
  if (!position) return null;

  const config: Record<string, { bg: string; color: string }> = {
    D: { bg: '#FFFFFF', color: '#111' },
    SB: { bg: '#3B82F6', color: '#FFF' },
    BB: { bg: '#EAB308', color: '#111' },
  };

  const { bg, color } = config[position] || config.D;

  return (
    <div className="seat__position-chip" style={{ backgroundColor: bg, color }}>
      {position}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEON TIMER BORDER — PokerBros-style disappearing border
// ═══════════════════════════════════════════════════════════════════════════════
//
// The info box border glows neon yellow and the border progressively disappears
// as the clock counts down. We achieve this with a conic-gradient mask on a
// pseudo-element, driven by a CSS custom property --timer-progress.

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

// Memoize — only re-render when seat-relevant props change
export const SeatSlot = memo(
  function SeatSlot(props: SeatSlotProps) {
    const {
      seatNumber,
      player,
      position,
      isActive,
      lastAction,
      lastBetAmount,
      timerProgress,
      bigBlind = 2,
      isTournament = false,
      bountyValue,
      isWinner = false,
      winningHandName,
      hudStats,
      showHUD = false,
      playerStyle,
      deckStyle = '4color',
      cardBack = 'black',
      showStackInBB = false,
      onSit,
      onAction,
      onAvatarClick,
    } = props;

    // Animated stack change — flash green/red when stack changes
    const [stackDelta, setStackDelta] = useState<number>(0);
    const prevStackRef = React.useRef<number>(player?.stack ?? 0);
    const wasSeatedRef = React.useRef<boolean>(!!player); // Track if player was already present
    useEffect(() => {
      if (!player) {
        wasSeatedRef.current = false; // Player left — reset for next occupant
        return;
      }
      const diff = player.stack - prevStackRef.current;
      // Only animate if player was already seated (not initial sit-down)
      if (diff !== 0 && wasSeatedRef.current) {
        setStackDelta(diff);
        const t = setTimeout(() => setStackDelta(0), 2000);
        prevStackRef.current = player.stack;
        wasSeatedRef.current = true;
        return () => clearTimeout(t);
      }
      prevStackRef.current = player.stack;
      wasSeatedRef.current = true; // Mark as seated after first render
    }, [player?.stack]);

    // Winner pop animation — brief scale bounce when isWinner transitions to true
    const [winnerPop, setWinnerPop] = useState(false);
    useEffect(() => {
      if (isWinner && !winnerPop) {
        setWinnerPop(true);
        const timer = setTimeout(() => setWinnerPop(false), 600);
        return () => clearTimeout(timer);
      }
    }, [isWinner, winnerPop]);

    // All-in shake animation — brief shake when lastAction changes to 'all_in'
    const [allinShake, setAllinShake] = useState(false);
    const prevActionRef = React.useRef<LastAction>(null);
    useEffect(() => {
      if (lastAction === 'all_in' && prevActionRef.current !== 'all_in') {
        setAllinShake(true);
        const timer = setTimeout(() => setAllinShake(false), 400);
        prevActionRef.current = lastAction;
        return () => clearTimeout(timer);
      }
      prevActionRef.current = lastAction;
    }, [lastAction]);

    // Stack glow pulse — when stack changes by >20%
    const [stackGlow, setStackGlow] = useState(false);
    const prevStackForGlowRef = React.useRef<number>(player?.stack ?? 0);
    useEffect(() => {
      if (!player) return;
      const prev = prevStackForGlowRef.current;
      if (prev > 0) {
        const percentChange = Math.abs(player.stack - prev) / prev;
        if (percentChange > 0.2) {
          setStackGlow(true);
          const timer = setTimeout(() => setStackGlow(false), 600);
          prevStackForGlowRef.current = player.stack;
          return () => clearTimeout(timer);
        }
      }
      prevStackForGlowRef.current = player.stack;
    }, [player?.stack]);

    const containerClasses = useMemo(() => {
      const cls = ['seat'];
      if (!player) {
        cls.push('seat--empty');
      } else {
        cls.push(`seat--${player.status}`);
        if (player.isHero) cls.push('seat--hero');
        if (isActive) cls.push('seat--active');
        if (isWinner) {
          cls.push('seat--winner');
          cls.push('seat--winner-glow');
          if (winnerPop) cls.push('seat--winner-pop');
        }
        if (lastAction === 'fold') cls.push('seat--folded');
        if (allinShake) cls.push('seat--allin-shake');
        if (stackGlow) cls.push('seat--stack-glow');
        // Timer urgency classes for color transitions
        if (isActive && timerProgress !== undefined) {
          if (timerProgress <= 20) cls.push('seat--timer-critical');
          else if (timerProgress <= 33) cls.push('seat--timer-urgent');
        }
      }
      return cls.join(' ');
    }, [player, isActive, lastAction, isWinner, timerProgress, winnerPop, allinShake, stackGlow]);

    // ─── EMPTY SEAT ────────────────────────────────────────────────────────
    if (!player) {
      if (isTournament) {
        return <div className={containerClasses} />;
      }
      return (
        <div className={containerClasses} onClick={onSit}>
          <span className="seat__empty-label">+ SIT</span>
        </div>
      );
    }

    // ─── OCCUPIED SEAT ─────────────────────────────────────────────────────
    // Use custom avatar library default — NOT generic DiceBear icons
    const avatarUrl = player.avatar || '/avatars/default-player.png';

    // Timer progress as CSS custom prop for conic-gradient border
    const timerStyle =
      isActive && timerProgress !== undefined
        ? ({ '--timer-progress': `${timerProgress}%` } as React.CSSProperties)
        : undefined;

    return (
      <div className={containerClasses} onClick={onAction}>
        {/* Last Action Badge — floats ABOVE the seat like PokerBros */}
        {lastAction && (
          <div className={`seat__action seat__action--${lastAction}`}>
            {getActionLabel(lastAction, lastBetAmount)}
          </div>
        )}

        {/* Player Bet Chips on Felt */}
        {lastBetAmount && lastBetAmount > 0 ? (
          <div className="seat__bet-chips">
            <ChipPhysics
              amount={lastBetAmount}
              animate={
                lastAction === 'bet' || lastAction === 'raise' || lastAction === 'all_in'
                  ? 'slide-in'
                  : 'none'
              }
              compact={true}
            />
          </div>
        ) : null}

        {/* Hole Cards — opponents: beside avatar at showdown */}
        {player.holeCards && player.holeCards.length > 0 && !player.isHero && (
          <div
            className={`seat__cards seat__cards--opponent${player.showCards ? ' seat__cards--revealed' : ''}`}
          >
            {player.holeCards.map((card, i) => (
              <HoleCard
                key={i}
                card={card}
                hidden={!player.showCards}
                index={i}
                isWinner={isWinner}
                deckStyle={deckStyle}
                cardBack={cardBack}
              />
            ))}
          </div>
        )}

        {/* Avatar Circle — large, sits on top of info box */}
        <div className="seat__avatar-wrap">
          <div
            className="seat__avatar"
            onClick={(e) => {
              if (onAvatarClick && !player.isHero) {
                e.stopPropagation();
                onAvatarClick();
              }
            }}
            style={{ cursor: onAvatarClick && !player.isHero ? 'pointer' : undefined }}
          >
            {player.avatar || !player.isHero ? (
              <img
                src={avatarUrl}
                alt={player.name}
                className="seat__avatar-img"
                loading="lazy"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                  const fb = (e.target as HTMLImageElement).parentElement?.querySelector(
                    '.seat__avatar-fallback'
                  );
                  if (fb) (fb as HTMLElement).style.display = 'flex';
                }}
              />
            ) : null}
            {player.isHero && !player.avatar ? (
              <span className="seat__avatar-initial">{player.name.charAt(0).toUpperCase()}</span>
            ) : null}
            <span
              className="seat__avatar-fallback seat__avatar-initial"
              style={{ display: 'none' }}
            >
              {player.name.charAt(0).toUpperCase()}
            </span>

            {/* Folded overlay */}
            {lastAction === 'fold' && <div className="seat__avatar-fold-overlay" />}
          </div>

          {/* Status dot (away/sitting out) */}
          {player.status !== 'active' &&
            player.status !== 'folded' &&
            player.status !== 'all_in' && (
              <span className={`seat__status-dot seat__status-dot--${player.status}`} />
            )}

          {/* Position Chip — bottom-right of avatar */}
          <PositionChip position={position} />
        </div>

        {/* Info Box — name + stack, with neon timer border when active */}
        <div className="seat__info" style={timerStyle}>
          {/* Neon border overlay (rendered via CSS ::before when --active) */}
          <span className="seat__name">{player.name}</span>
          <span
            className={`seat__stack${stackDelta > 0 ? ' seat__stack--up' : stackDelta < 0 ? ' seat__stack--down' : ''} ${showStackInBB || !isTournament ? getStackDepthClass(player.stack, bigBlind) : ''}`}
          >
            {showStackInBB ? formatStackAsBB(player.stack, bigBlind) : formatStack(player.stack)}
          </span>

          {/* Stack Change Delta */}
          {stackDelta !== 0 && (
            <span
              className={`seat__stack-delta ${stackDelta > 0 ? 'seat__stack-delta--win' : 'seat__stack-delta--loss'}`}
            >
              {stackDelta > 0 ? '+' : ''}
              {showStackInBB ? formatStackAsBB(stackDelta, bigBlind) : formatStack(stackDelta)}
            </span>
          )}
        </div>

        {/* Mini-HUD — opponent stats (VPIP/PFR) below info box */}
        {!player.isHero && showHUD && (
          <MiniHUD stats={hudStats || null} isVisible={showHUD} compact={true} />
        )}

        {/* Player Style Badge — auto-classified archetype */}
        {!player.isHero && playerStyle && playerStyle.style !== 'unknown' && (
          <div
            className="seat__style-badge"
            style={{
              color: playerStyle.color,
              backgroundColor: playerStyle.bgColor,
            }}
            title={playerStyle.tooltip}
          >
            {playerStyle.icon} {playerStyle.label}
          </div>
        )}

        {/* Hero Hole Cards — large, PokerBros style beside avatar */}
        {player.holeCards && player.holeCards.length > 0 && player.isHero && (
          <div className="seat__cards seat__cards--hero">
            {player.holeCards.map((card, i) => (
              <HoleCard
                key={i}
                card={card}
                hidden={false}
                index={i}
                isHero={true}
                isWinner={isWinner}
                deckStyle={deckStyle}
                cardBack={cardBack}
              />
            ))}
          </div>
        )}

        {/* Winning Hand Name — floats below cards like PokerBros "Straight" label */}
        {isWinner && winningHandName && <div className="seat__hand-name">{winningHandName}</div>}

        {/* All-In Badge */}
        {player.status === 'all_in' && !isWinner && <div className="seat__allin-badge">ALL IN</div>}

        {/* Bounty Badge */}
        {bountyValue != null && bountyValue > 0 && (
          <div className="seat__bounty">
            <span className="seat__bounty-target">🎯</span>
            <span className="seat__bounty-val">
              {(Math.trunc(bountyValue * 100) / 100).toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
          </div>
        )}
      </div>
    );
  },
  (prev, next) => {
    // Return true if props are equal (skip re-render)
    if (prev.seatNumber !== next.seatNumber) return false;
    if (prev.timerProgress !== next.timerProgress) return false;
    if (prev.isActive !== next.isActive) return false;
    if (prev.position !== next.position) return false;
    if (prev.isTournament !== next.isTournament) return false;
    if (prev.bigBlind !== next.bigBlind) return false;
    if (prev.bountyValue !== next.bountyValue) return false;
    if (prev.isWinner !== next.isWinner) return false;
    if (prev.winningHandName !== next.winningHandName) return false;
    if (prev.lastAction !== next.lastAction) return false;
    if (prev.lastBetAmount !== next.lastBetAmount) return false;
    if (prev.showHUD !== next.showHUD) return false;

    // HUD stats — only compare if visible
    if (prev.showHUD && next.showHUD) {
      const ps = prev.hudStats;
      const ns = next.hudStats;
      if (!ps && !ns) {
        /* equal */
      } else if (!ps || !ns) return false;
      else if (
        ps.handsPlayed !== ns.handsPlayed ||
        ps.vpipCount !== ns.vpipCount ||
        ps.pfrCount !== ns.pfrCount
      )
        return false;
    }

    // Player style badge — compare style name (cheapest check)
    const prevStyle = prev.playerStyle?.style || 'unknown';
    const nextStyle = next.playerStyle?.style || 'unknown';
    if (prevStyle !== nextStyle) return false;
    if (prev.deckStyle !== next.deckStyle) return false;

    const pp = prev.player;
    const np = next.player;

    // Both null
    if (!pp && !np) return true;
    // Only one is null
    if (!pp || !np) return false;

    // Compare player properties
    if (pp.id !== np.id) return false;
    if (pp.name !== np.name) return false;
    if (pp.stack !== np.stack) return false;
    if (pp.status !== np.status) return false;
    if (pp.isHero !== np.isHero) return false;
    if (pp.showCards !== np.showCards) return false;
    if (pp.avatar !== np.avatar) return false;
    if (prev.showStackInBB !== next.showStackInBB) return false;
    if (JSON.stringify(pp.holeCards) !== JSON.stringify(np.holeCards)) return false;

    return true;
  }
);

export default SeatSlot;
