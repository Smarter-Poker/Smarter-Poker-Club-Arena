/**
 * ♠ CLUB ARENA — Seat Slot Component
 * ═══════════════════════════════════════════════════════════════════════════════
 * Premium seat layout:
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
import { getAvatarWithFallback } from '../../utils/avatarGenerator';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Card {
  rank: '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
  suit: 'h' | 'd' | 'c' | 's';
}

/** FIX 186: Bible V8 §2.3 — Added 'disconnected' status (was missing) */
export type PlayerStatus = 'active' | 'away' | 'sitting_out' | 'folded' | 'all_in' | 'disconnected';
/** Bible V8 Appendix B: Position labels for all table sizes */
export type PositionBadge =
  | 'D'
  | 'BTN'
  | 'SB'
  | 'BB'
  | 'UTG'
  | 'UTG+1'
  | 'UTG+2'
  | 'MP'
  | 'MP+1'
  | 'HJ'
  | 'CO'
  | null;
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
  /**
   * Phase 2 T1-01 — net profit for this winner (winnings minus hero's
   * own contribution to the pot). When > 0 and isWinner true, renders
   * the signature PokerBros "+N" yellow floating text above the seat.
   * Animation auto-fades after 2.5s.
   */
  netWinAmount?: number;
  hudStats?: MiniHUDStats | null; // Opponent VPIP/PFR stats
  showHUD?: boolean; // Whether to show the HUD overlay
  playerStyle?: PlayerStyleResult | null; // Auto-classified player archetype
  secondsLeft?: number; // Actual seconds remaining (for countdown overlay)
  deckStyle?: '4color' | '2color';
  cardBack?: string; // Card back design ID (e.g. 'classic_red', 'black', 'clubs_gold')
  showStackInBB?: boolean;
  onSit?: () => void;
  onAction?: () => void;
  onAvatarClick?: () => void;
  /** Bible V8 §11.1: Show/hide player avatar images */
  showAvatar?: boolean;
  /** Bible V8 §11.1: Show/hide VIP/achievement badges */
  showBadges?: boolean;
  /** Bible V8 §11.1: Enable/disable gesture controls (tap peek, swipe) */
  gesturesEnabled?: boolean;
  /**
   * Bible V8 §1.16 Real-Time Law — when true, the seat's bet chips play the
   * "collect-to-pot" animation (cpCollect keyframe). Controlled by the table
   * parent on COMMUNITY_CARDS_DEALT / HAND_COMPLETE events.
   */
  isCollectingChips?: boolean;
  /**
   * 2026-04-15 Bible V8 §6.1 — server-authoritative absolute wall-clock
   * deadline for the CURRENT active seat (ms since epoch). Combined with
   * `turnStartTimeMs` this drives a pure-CSS `@property` animation on the
   * `.seat__info` element so the gold ring shrinks for BOTH hero and
   * opponents, reliably, even when the tab is hidden (rAF suspended).
   */
  turnDeadlineMs?: number;
  /** Wall-clock time the current turn started (server-authoritative). */
  turnStartTimeMs?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function formatStack(amount: number): string {
  if (amount >= 1000000) return `${(amount / 1000000).toFixed(1)}M`;
  if (amount >= 100000) return `${(amount / 1000).toFixed(0)}K`;
  if (amount >= 10000) return `${(amount / 1000).toFixed(1)}K`;
  // For any amount >= 1, always show as a rounded whole number.
  // Fractional cents on big stacks are rake/split artifacts that look ugly.
  if (amount >= 1) return Math.round(amount).toLocaleString();
  // Sub-dollar amounts (micro-stakes like 0.25/0.50) — show 2 decimals
  if (amount > 0) return amount.toFixed(2);
  return '0';
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
  // premium-style: hero cards have wider fan tilt, opponents tighter
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
// NEON TIMER BORDER — premium-style disappearing border
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
      netWinAmount,
      winningHandName,
      hudStats,
      showHUD = false,
      playerStyle,
      secondsLeft,
      deckStyle = '4color',
      cardBack = 'black',
      showStackInBB = false,
      onSit,
      onAction,
      onAvatarClick,
      showAvatar = true,
      showBadges = false,
      gesturesEnabled = true,
      isCollectingChips = false,
      turnDeadlineMs,
      turnStartTimeMs,
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
    // Bible V8 §5.3: card peek gesture — tap hero cards for brief lift
    const [isPeeking, setIsPeeking] = useState(false);
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
        // 2026-04-15 ROOT-CAUSE FIX (Dan: opponent rings glued at 100%):
        // player.status can be 'active' meaning "seated and in the hand",
        // which would push `seat--active` — colliding with the CSS class
        // used for "it is currently this seat's turn to act" (line below).
        // Result: every seated player visually glowed as if it were their
        // turn. Guard: only emit seat--${status} for non-'active' statuses
        // (folded / all_in / sitting_out / away / disconnected). The
        // canonical "in a hand" indicator is `seat--in-hand` added below.
        if (player.status !== 'active') {
          cls.push(`seat--${player.status}`);
        }
        if (player.isHero) cls.push('seat--hero');
        if (isActive) cls.push('seat--active');
        if (isWinner) {
          cls.push('seat--winner');
          cls.push('seat--winner-glow');
          if (winnerPop) cls.push('seat--winner-pop');
        }
        // Bible V8 §5.1: Yellow glow on all players still in the hand (not folded)
        if (player.status === 'active' || player.status === 'all_in') {
          cls.push('seat--in-hand');
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
    // Use deterministic SVG avatar (colorful, unique per player) when no real image exists
    const avatarUrl = getAvatarWithFallback(player.avatar || null, player.id, player.name);

    // 2026-04-15 Bible V8 §6.1 — pure-CSS ring countdown. Set animation
    // duration + a negative animation-delay so the ring animates from the
    // CURRENT elapsed position to 0% over the remaining seconds. Works on
    // hidden tabs; applies identically to hero and opponent active seats.
    // Falls back to the legacy --timer-progress var when server timing is
    // unavailable so the prior JS-driven visual still shows.
    let timerStyle: React.CSSProperties | undefined;
    let timerKey: number | string = 'no-turn';
    if (isActive && turnDeadlineMs && turnDeadlineMs > 0) {
      const durationMs = turnStartTimeMs
        ? Math.max(1000, turnDeadlineMs - turnStartTimeMs)
        : 15_000;
      const elapsedMs = turnStartTimeMs
        ? Math.max(0, Date.now() - turnStartTimeMs)
        : 0;
      timerStyle = {
        '--sp-timer-duration': `${(durationMs / 1000).toFixed(3)}s`,
        '--sp-timer-delay': `-${(elapsedMs / 1000).toFixed(3)}s`,
      } as React.CSSProperties;
      // React key so the .seat__info remounts (animation restarts) each
      // new turn — identified by the authoritative wall-clock deadline.
      timerKey = turnDeadlineMs;
    } else if (isActive && timerProgress !== undefined) {
      // Legacy JS-hook fallback (visible tabs only).
      timerStyle = {
        '--timer-progress': `${timerProgress}%`,
      } as React.CSSProperties;
    }

    return (
      <div className={containerClasses} onClick={onAction}>
        {/* Last Action Badge — floats ABOVE the seat (premium style) */}
        {lastAction && (
          <div className={`seat__action seat__action--${lastAction}`}>
            {getActionLabel(lastAction, lastBetAmount)}
          </div>
        )}

        {/* Player Bet Chips on Felt — Bible V8 §1.16 Real-Time Law:
            when the parent flips `isCollectingChips` (on COMMUNITY_CARDS_DEALT
            or HAND_COMPLETE), these chips animate into the pot before being
            cleared. Otherwise the chip stack slides in on fresh bets/raises. */}
        {lastBetAmount && lastBetAmount > 0 ? (
          <div className="seat__bet-chips">
            <ChipPhysics
              amount={lastBetAmount}
              animate={
                isCollectingChips
                  ? 'collect'
                  : lastAction === 'bet' || lastAction === 'raise' || lastAction === 'all_in'
                  ? 'slide-in'
                  : 'none'
              }
              compact={true}
            />
          </div>
        ) : null}

        {/* Hole Cards — opponents: show card backs for active/all-in players, reveal at showdown */}
        {!player.isHero && (player.status === 'active' || player.status === 'all_in') && (
          <div
            className={`seat__cards seat__cards--opponent${player.showCards && player.holeCards?.length ? ' seat__cards--revealed' : ''}`}
          >
            {player.holeCards && player.holeCards.length > 0 ? (
              player.holeCards.map((card, i) => (
                <HoleCard
                  key={i}
                  card={card}
                  hidden={!player.showCards}
                  index={i}
                  isWinner={isWinner}
                  deckStyle={deckStyle}
                  cardBack={cardBack}
                />
              ))
            ) : (
              <>
                <HoleCard key={0} hidden={true} index={0} deckStyle={deckStyle} cardBack={cardBack} />
                <HoleCard key={1} hidden={true} index={1} deckStyle={deckStyle} cardBack={cardBack} />
              </>
            )}
          </div>
        )}

        {/* Avatar Circle — large, sits on top of info box */}
        {/* Bible V8 §11.1: show_avatars toggle */}
        <div className="seat__avatar-wrap" style={showAvatar ? undefined : { visibility: 'hidden' }}>
          {/* Timer is shown via smooth conic-gradient border on the info box below */}
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

          {/* Status dot (away/sitting out/disconnected) — Bible V8 §2.3 */}
          {player.status !== 'active' &&
            player.status !== 'folded' &&
            player.status !== 'all_in' && (
              <span className={`seat__status-dot seat__status-dot--${player.status}`} />
            )}
          {/* FIX 186: Disconnected overlay — shows DISCONNECTED label + countdown */}
          {player.status === 'disconnected' && (
            <div className="seat__disconnect-overlay" title="Player disconnected">
              <span className="seat__disconnect-label">DISCONNECTED</span>
              {secondsLeft != null && secondsLeft > 0 && (
                <span className="seat__disconnect-timer">{Math.ceil(secondsLeft)}s</span>
              )}
            </div>
          )}

          {/* Position Chip — REMOVED: Bible V8 dealer button is rendered separately via DealerButton component.
             SB/BB/UTG/CO/etc. badges are NOT shown on the table per design decision. */}
        </div>

        {/* Info Box — name + stack, with neon timer border when active.
            The React `key` forces a fresh mount per turn so the CSS
            @property animation restarts from 100%. */}
        <div className="seat__info" style={timerStyle} key={`info-${timerKey}`}>
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
        {/* Bible V8 §11.1: show_badges toggle controls badge visibility */}
        {showBadges && !player.isHero && playerStyle && playerStyle.style !== 'unknown' && (
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

        {/* Hero Hole Cards — large, premium style beside avatar.
         *  After the hero folds, keep the cards visible but dim them so the
         *  player can still see what they mucked (matches how the avatar
         *  dims on fold). Dan's UX rule, 2026-04-14. */}
        {player.holeCards && player.holeCards.length > 0 && player.isHero && (
          <div
            className={
              'seat__cards seat__cards--hero' +
              (lastAction === 'fold' || player.status === 'folded'
                ? ' seat__cards--folded'
                : '') +
              (isPeeking ? ' seat__cards--peeking' : '')
            }
            /* Bible V8 §5.3: tap hero cards to peek (brief lift animation) */
            onTouchStart={() => { if (gesturesEnabled) setIsPeeking(true); }}
            onTouchEnd={() => { if (gesturesEnabled) setTimeout(() => setIsPeeking(false), 300); }}
            onMouseDown={() => { if (gesturesEnabled) setIsPeeking(true); }}
            onMouseUp={() => { if (gesturesEnabled) setTimeout(() => setIsPeeking(false), 300); }}
          >
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

        {/* Winning Hand Name — floats below cards (premium style) "Straight" label */}
        {isWinner && winningHandName && <div className="seat__hand-name">{winningHandName}</div>}

        {/* Phase 2 T1-01 — PokerBros net-profit "+N" yellow floating text.
         *  Shows only when isWinner=true AND netWinAmount>0. Keyed on the
         *  amount so each new win re-triggers the float animation. */}
        {isWinner && typeof netWinAmount === 'number' && netWinAmount > 0 && (
          <div className="seat__net-win" key={netWinAmount}>
            +{formatStack(netWinAmount)}
          </div>
        )}

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
    if (prev.netWinAmount !== next.netWinAmount) return false;
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
    if (prev.cardBack !== next.cardBack) return false;
    if (prev.secondsLeft !== next.secondsLeft) return false;
    if (prev.showAvatar !== next.showAvatar) return false;
    if (prev.showBadges !== next.showBadges) return false;
    // 2026-04-15 §6.1: re-render on new turn so CSS ring restarts.
    if (prev.turnDeadlineMs !== next.turnDeadlineMs) return false;
    if (prev.turnStartTimeMs !== next.turnStartTimeMs) return false;

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
    // Compare holeCards without JSON.stringify (performance optimization)
    const ph = pp.holeCards;
    const nh = np.holeCards;
    if (ph === nh) {
      /* same ref, skip */
    } else if (!ph || !nh || ph.length !== nh.length) return false;
    else {
      for (let i = 0; i < ph.length; i++) {
        if (ph[i].rank !== nh[i].rank || ph[i].suit !== nh[i].suit) return false;
      }
    }

    return true;
  }
);

export default SeatSlot;
