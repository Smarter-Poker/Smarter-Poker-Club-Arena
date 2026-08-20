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

import React, { useMemo, useState, useEffect, useRef, memo } from 'react';
import { serverNow } from '../../utils/serverClock';
import './SeatSlot.css';
import { CardImage, CardBack } from './CardImage';
import MiniHUD, { type MiniHUDStats } from './MiniHUD';
import type { PlayerStyleResult } from '../../services/PlayerStyleClassifier';
import { ChipPhysics } from './ChipPhysics';
import { getAvatarWithFallback } from '../../utils/avatarGenerator';
import { soundService, haptic } from '../../services/SoundService';
import { getAnimationSpeed } from '../../utils/animationSpeed';

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
  /**
   * Dan 2026-08-18: a slot may be null. When a player reveals only SOME of
   * their cards (per-card show), the engine sends the hand with null in the
   * positions that stay face down, so the seat still renders the right number
   * of cards with backs in the gaps.
   */
  holeCards?: (Card | null)[];
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
  /**
   * BBJ-FLOAT 2026-08-18: Bad Beat Jackpot share credited to this seat's
   * stack. When > 0, renders a gold "BBJ +$X" float above the seat, timed
   * with the celebration overlay so players see exactly where the jackpot
   * chips landed. Cleared by TablePage a few seconds after the payout.
   */
  bbjCreditAmount?: number;
  hudStats?: MiniHUDStats | null; // Opponent VPIP/PFR stats
  showHUD?: boolean; // Whether to show the HUD overlay
  playerStyle?: PlayerStyleResult | null; // Auto-classified player archetype
  secondsLeft?: number; // Actual seconds remaining (for countdown overlay)
  deckStyle?: '4color' | '2color';
  cardBack?: string; // Card back design ID (e.g. 'classic_red', 'black', 'clubs_gold')
  showStackInBB?: boolean;
  onSit?: () => void;
  /**
   * Dan 2026-08-15: "when a player is seated at the table, the open seats that
   * were a + should now say EMPTY. A user should never be able to sit at
   * multiple seats." False -> the empty seat renders an inert "EMPTY" plate
   * with no click target at all (not merely a rejected click).
   */
  canSit?: boolean;
  /**
   * Dan 2026-08-18: true for the hero's OWN reserved seat while they wait to
   * be dealt in. Every other open seat reads EMPTY; this one reads YOUR SEAT
   * so the player can see where they'll appear.
   */
  isHeroReservedSeat?: boolean;
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
   * Bible V8 §10.1 — true during deal animation (HAND_STARTED). When set,
   * applies `seat__cards--dealing` class for card slide-in animation at each seat.
   */
  isDealing?: boolean;
  /**
   * ANIMATION AUDIT 2026-08-19 — true when this seat LOST a showdown and its
   * revealed cards should fly to the muck (cardFoldOut) before the table
   * resets. Set by the parent late in the winner-display window.
   */
  isMucking?: boolean;
  /**
   * COMPETITOR-PARITY 2026-08-19 — Card Squeeze. True when the user's
   * card_squeeze setting is on AND no force-reveal condition applies
   * (showdown / all-in runout). While true and the hand is not yet squeezed
   * open, the hero's cards render face DOWN and a drag-up gesture peels
   * them open. Parent computes the force conditions.
   */
  cardSqueezeActive?: boolean;
  /**
   * AUDIT-2 FIX 2026-08-20: the hand number, used as an independent reset
   * signal for the card-squeeze latch (see the reset effects). Also lets the
   * seat scope any per-hand visual state without depending on a single event.
   */
  handNumber?: number;
  /**
   * AUDIT-2 FIX 2026-08-20: multi-table gate (#175). The squeeze flick and its
   * haptic must stay silent on a background table.
   */
  playSounds?: boolean;
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
  /**
   * Dan 2026-08-18: "a user should be able to click on any card in their hand,
   * and when clicked that card or cards always get shown after the hand is
   * over." Indexes of the hero's own hole cards currently marked to be shown.
   */
  showPickedCardIndexes?: readonly number[];
  /** Toggle one of the hero's cards in/out of the show-after-hand selection. */
  onToggleShowCard?: (cardIndex: number) => void;
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
  deckStyle,
  cardBack = 'classic_blue',
}: {
  card?: Card | null;
  hidden?: boolean;
  index: number;
  isHero?: boolean;
  isWinner?: boolean;
  deckStyle?: '4color' | '2color';
  cardBack?: string;
}) {
  // v10 layout (Dan-approved PokerBros clone): the HERO row is LINED UP — no
  // fan tilt. Opponents keep the tight +/-8deg pair behind the avatar.
  //
  // The hero row must NOT get an inline transform. Inline styles out-specify
  // every stylesheet rule, so an inline rotate() here would override
  // `.seat__cards--hero .seat__card { transform: none }` and put the fan
  // straight back — it is exactly the "fan/overlap mess" v10 removed. It also
  // broke PLO: `index === 0 ? -12 : 12` gave card 1 -12deg and cards 2..6 all
  // the SAME +12deg, so a 5- or 6-card hand stacked into one tilted clump.
  // Leaving style undefined hands full control of the hero row to CSS.
  const rotation = isHero ? 0 : index === 0 ? -8 : 8;
  const cardStyle = isHero ? undefined : { transform: `rotate(${rotation}deg)` };
  const size = isHero ? 'md' : 'sm';

  if (hidden || !card) {
    return (
      <div className="seat__card seat__card--back" style={cardStyle}>
        <CardBack size={size} style={cardBack} />
      </div>
    );
  }
  return (
    <div
      className={`seat__card seat__card--face${isWinner ? ' seat__card--winner' : ''}`}
      style={cardStyle}
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
      bbjCreditAmount,
      winningHandName,
      hudStats,
      showHUD = false,
      playerStyle,
      secondsLeft,
      deckStyle,
      cardBack = 'classic_blue',
      showStackInBB = false,
      onSit,
      canSit = true,
      isHeroReservedSeat = false,
      onAction,
      onAvatarClick,
      showAvatar = true,
      showBadges = false,
      gesturesEnabled = true,
      isCollectingChips = false,
      isDealing = false,
      isMucking = false,
      cardSqueezeActive = false,
      handNumber = 0,
      playSounds = true,
      turnDeadlineMs,
      turnStartTimeMs,
      showPickedCardIndexes,
      onToggleShowCard,
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
    // CA-14 BUG FIX: track the 300ms peek-dismiss timer so it cancels on unmount.
    // Previously fire-and-forget in onTouchEnd/onMouseUp inline handlers.
    const peekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // UI-AUDIT #4: track the winner-pop reset timer in a ref (not effect-scoped)
    // and drive off an isWinner rising edge so the bounce replays every win.
    const winnerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const prevIsWinnerRef = useRef(false);
    useEffect(() => {
      return () => {
        if (peekTimerRef.current) clearTimeout(peekTimerRef.current);
        if (winnerTimerRef.current) clearTimeout(winnerTimerRef.current);
      };
    }, []);
    useEffect(() => {
      // Rising edge false→true: play the pop once per win.
      if (isWinner && !prevIsWinnerRef.current) {
        setWinnerPop(true);
        if (winnerTimerRef.current) clearTimeout(winnerTimerRef.current);
        winnerTimerRef.current = setTimeout(() => setWinnerPop(false), 600);
      } else if (!isWinner) {
        // Win cleared — reset so the next win at this seat replays the bounce.
        setWinnerPop(false);
      }
      prevIsWinnerRef.current = isWinner;
    }, [isWinner]);

    // All-in shake animation — brief shake when lastAction changes to 'all_in'
    const [allinShake, setAllinShake] = useState(false);
    // Fold card fly-out animation — brief "cards to muck" before dimming
    const [isFolding, setIsFolding] = useState(false);
    const prevActionRef = React.useRef<LastAction>(null);
    useEffect(() => {
      // IMPROVEMENT PASS 2026-08-19: every class-removal window scales with
      // --animation-speed, the same multiplier the keyframes use.
      if (lastAction === 'all_in' && prevActionRef.current !== 'all_in') {
        setAllinShake(true);
        const timer = setTimeout(() => setAllinShake(false), 400 * getAnimationSpeed());
        prevActionRef.current = lastAction;
        return () => clearTimeout(timer);
      }
      // Bible V8 §10.1: card fold animation — cards fly to center/muck.
      // ANIMATION AUDIT 2026-08-19: window was 350ms but cardFoldOut runs
      // 380ms + 55ms second-card delay = 435ms — the class was stripped
      // mid-flight and the second card snapped. 500ms covers it.
      if (lastAction === 'fold' && prevActionRef.current !== 'fold') {
        setIsFolding(true);
        const timer = setTimeout(() => setIsFolding(false), 500 * getAnimationSpeed());
        prevActionRef.current = lastAction;
        return () => clearTimeout(timer);
      }
      prevActionRef.current = lastAction;
    }, [lastAction]);

    // Showdown card flip animation — 3D flip when opponent cards are revealed
    const [isShowdownFlip, setIsShowdownFlip] = useState(false);
    const prevShowCardsRef = React.useRef<boolean>(player?.showCards ?? false);
    useEffect(() => {
      if (!player) return;
      // Trigger 3D flip when showCards transitions false → true
      if (player.showCards && !prevShowCardsRef.current) {
        setIsShowdownFlip(true);
        // ANIMATION AUDIT 2026-08-19: was 400ms, but card 2 runs 120ms delay
        // + 350ms flip = 470ms — it snapped face-up at 85%. 600ms covers it.
        const timer = setTimeout(() => setIsShowdownFlip(false), 600 * getAnimationSpeed());
        prevShowCardsRef.current = player.showCards;
        return () => clearTimeout(timer);
      }
      prevShowCardsRef.current = player.showCards ?? false;
    }, [player?.showCards]);

    // ── COMPETITOR-PARITY 2026-08-19: Card Squeeze ─────────────────────────
    // squeezeProgress: 0 = face down, 1 = fully peeled open. Driven by a
    // drag-up gesture on the hero's cards. squeezeRevealed latches once the
    // player peels past the threshold (or double-taps) and holds for the
    // rest of the hand. A quick tap plays a bounce hint teaching the gesture.
    const [squeezeRevealed, setSqueezeRevealed] = useState(false);
    const [squeezeProgress, setSqueezeProgress] = useState(0);
    const [squeezeHint, setSqueezeHint] = useState(false);
    const squeezeStartYRef = useRef<number | null>(null);
    const squeezeMovedRef = useRef(false);
    const squeezeLastTapRef = useRef(0);
    const squeezeHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
      () => () => {
        if (squeezeHintTimerRef.current) clearTimeout(squeezeHintTimerRef.current);
      },
      []
    );
    const squeezeProgressRef = useRef(0);
    // New hand → cards are face down again.
    // AUDIT-2 FIX 2026-08-20: the ONLY reset used to be hero holeCards hitting
    // 0 (which depends on the HAND_STARTED event landing). If that event was
    // ever missed — reconnect, observer→player, mid-hand join — squeezeRevealed
    // stayed latched and the squeeze silently never ran again for the session.
    // handNumber is an independent, always-advancing signal, so either one
    // resets. squeezeProgressRef is reset too: it used to survive a mid-drag
    // unmount (showdown / all-in force-reveal), and the stale >0.55 value made
    // the NEXT hand's first bare tap reveal the cards with no gesture at all.
    const heroCardCount = player?.isHero ? (player.holeCards?.length ?? 0) : 0;
    useEffect(() => {
      if (heroCardCount === 0) {
        setSqueezeRevealed(false);
        squeezeProgressRef.current = 0;
        setSqueezeProgress(0);
        squeezeStartYRef.current = null;
        squeezeLastTapRef.current = 0;
      }
    }, [heroCardCount]);
    useEffect(() => {
      setSqueezeRevealed(false);
      squeezeProgressRef.current = 0;
      setSqueezeProgress(0);
      squeezeStartYRef.current = null;
      squeezeLastTapRef.current = 0;
    }, [handNumber]);
    const completeSqueeze = () => {
      setSqueezeRevealed(true);
      squeezeProgressRef.current = 0;
      setSqueezeProgress(0);
      if (playSounds) soundService.playCardSqueeze();
    };
    const setProgress = (p: number) => {
      squeezeProgressRef.current = p;
      setSqueezeProgress(p);
    };
    const squeezeHandlers: React.HTMLAttributes<HTMLDivElement> = {
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
        squeezeStartYRef.current = e.clientY;
        squeezeMovedRef.current = false;
        (e.currentTarget as HTMLDivElement).setPointerCapture?.(e.pointerId);
      },
      onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
        if (squeezeStartYRef.current == null) return;
        const dy = squeezeStartYRef.current - e.clientY;
        if (Math.abs(dy) > 4) squeezeMovedRef.current = true;
        const p = Math.max(0, Math.min(1, dy / 70));
        // ENHANCEMENT 2026-08-19: one light haptic as the card starts to
        // bend — the tactile "grip" of a live squeeze.
        if (p >= 0.15 && squeezeProgressRef.current < 0.15 && playSounds) haptic.light();
        setProgress(p);
      },
      onPointerUp: () => {
        squeezeStartYRef.current = null;
        if (squeezeProgressRef.current > 0.55) {
          completeSqueeze();
          return;
        }
        setProgress(0);
        if (!squeezeMovedRef.current) {
          // Tap: double-tap opens instantly; single tap bounces a hint.
          const now = Date.now();
          if (now - squeezeLastTapRef.current < 300) {
            completeSqueeze();
          } else {
            setSqueezeHint(true);
            if (squeezeHintTimerRef.current) clearTimeout(squeezeHintTimerRef.current);
            squeezeHintTimerRef.current = setTimeout(() => {
              squeezeHintTimerRef.current = null;
              setSqueezeHint(false);
            }, 450);
          }
          squeezeLastTapRef.current = now;
        }
      },
      onPointerCancel: () => {
        squeezeStartYRef.current = null;
        setProgress(0);
      },
      onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          completeSqueeze();
        }
      },
    };

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
        // Dan ("once a player is out of the hand, they should be dimmed").
        // Two independent sources say "folded" and they arrive at different
        // times: `lastAction` flips the instant the fold is dispatched, while
        // `player.status` only becomes 'folded' once mapEngineSnapshot sees
        // is_folded on the next server snapshot. Honour whichever lands first
        // so there is no bright frame in between — but note status === 'folded'
        // ALSO emits seat--folded via the seat--${status} push above, so guard
        // against pushing the class twice.
        if (lastAction === 'fold' && player.status !== 'folded') cls.push('seat--folded');
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
        return <div className={containerClasses} aria-label={`Seat ${seatNumber}: empty`} />;
      }
      // Hero already occupies a seat at this table -> every other open seat is
      // a passive "EMPTY" marker. No onClick, no role="button", no tabIndex:
      // the seat is removed from the interaction model entirely rather than
      // accepting the click and rejecting it downstream.
      if (!canSit) {
        return (
          <div
            className={`${containerClasses} seat--empty-locked`}
            aria-label={`Seat ${seatNumber}: empty`}
          >
            <span className="seat__empty-label">{isHeroReservedSeat ? 'YOUR SEAT' : 'EMPTY'}</span>
          </div>
        );
      }
      return (
        <div
          className={containerClasses}
          onClick={onSit}
          onKeyDown={(e) => {
            // Lobby audit P2-5: keyboard users must be able to sit via the
            // role="button" empty seat. Mirror the onClick (onSit) handler.
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSit?.();
            }
          }}
          role="button"
          tabIndex={0}
          aria-label={`Seat ${seatNumber}: open - click to sit`}
        >
          {/* Dan 2026-08-18: "+" stacked ABOVE "SIT" and centered, not
              inline where it read as left-offset. */}
          <span className="seat__empty-label">
            <span className="seat__empty-plus">+</span>
            <span className="seat__empty-word">SIT</span>
          </span>
        </div>
      );
    }

    // ─── OCCUPIED SEAT ─────────────────────────────────────────────────────
    // Use deterministic SVG avatar (colorful, unique per player) when no real image exists
    const avatarUrl = getAvatarWithFallback(player.avatar || null, player.id, player.name);
    // 2026-08-04 PokerBros-style: library bust art (/avatars/table|free|vip/*)
    // is a transparent-background character PNG — render it free-floating
    // (no circle crop, no ring, larger) like the reference client. Uploaded
    // photos and generated SVGs keep the circular frame.
    const isBustArt = /\/avatars\/(table|free|vip)\//.test(avatarUrl);

    // COMPETITOR-PARITY 2026-08-19 (Card Squeeze): single source of truth for
    // "the hero's cards are currently face down awaiting a squeeze".
    const squeezeDown =
      cardSqueezeActive &&
      !squeezeRevealed &&
      player.status !== 'all_in' &&
      !player.showCards &&
      !isWinner &&
      !isMucking;

    // 2026-04-15 Bible V8 §6.1 — pure-CSS ring countdown. Set animation
    // duration + a negative animation-delay so the ring animates from the
    // CURRENT elapsed position to 0% over the remaining seconds. Works on
    // hidden tabs; applies identically to hero and opponent active seats.
    // Falls back to the legacy --timer-progress var when server timing is
    // unavailable so the prior JS-driven visual still shows.
    let timerStyle: React.CSSProperties | undefined;
    let timerKey: number | string = 'no-turn';
    if (isActive && turnDeadlineMs && turnDeadlineMs > 0) {
      // ── Dan 2026-08-20: "the yellow countdown timer is not 15 seconds — it
      //    needs to be exactly 15 seconds long to make the yellow disappear."
      //
      // Every table is action_time_seconds = 15 and the engine's deadline
      // follows from it, so a healthy pair yields exactly 15000. But the ONLY
      // floor here used to be Math.max(1000, ...), so ANY skewed pair produced
      // a ring of that length and it was drawn as gospel: a 3s ring looks
      // identical to a correct one, just wrong. That happens whenever the two
      // fields are momentarily out of step — a DELTA patch landing
      // turn_start_time_ms before turn_deadline_ms, or a stale deadline from
      // the previous turn arriving with a fresh start stamp.
      //
      // Clamp to a plausible turn band. Anything outside it is a torn read,
      // not a real turn length, so fall back to the canonical 15s rather than
      // rendering a clock we know is wrong.
      const MIN_PLAUSIBLE_TURN_MS = 5_000;
      const MAX_PLAUSIBLE_TURN_MS = 180_000;
      const rawDurationMs = turnStartTimeMs ? turnDeadlineMs - turnStartTimeMs : 15_000;
      const durationMs =
        rawDurationMs >= MIN_PLAUSIBLE_TURN_MS && rawDurationMs <= MAX_PLAUSIBLE_TURN_MS
          ? rawDurationMs
          : 15_000;
      // Dan 2026-08-18: measure elapsed on the ENGINE's clock, not this
      // device's. turnStartTimeMs is a SERVER timestamp, so subtracting a raw
      // Date.now() from it mixed two clocks: a phone running three seconds
      // fast reported three seconds already gone the instant the turn began,
      // and the 15-second ring visibly emptied in twelve (slow clocks made it
      // overrun). serverNow() applies the measured offset - see
      // utils/serverClock.ts. durationMs above never had this problem: it is
      // deadline minus start, server-minus-server, so the offset cancels.
      const elapsedMs = turnStartTimeMs ? Math.max(0, serverNow() - turnStartTimeMs) : 0;
      // Dan 2026-08-15: the yellow countdown is a full 15 seconds. On a normal
      // 15s turn that is the entire clock (never goes red); when a time bank
      // extends the turn, yellow still owns the first 15s and the borrowed
      // seconds run red. Capped at the turn length so the colour animation can
      // never outlive the ring it colours.
      const YELLOW_MS = 15_000;
      const yellowMs = Math.min(YELLOW_MS, durationMs);
      timerStyle = {
        '--sp-timer-duration': `${(durationMs / 1000).toFixed(3)}s`,
        '--sp-timer-yellow-duration': `${(yellowMs / 1000).toFixed(3)}s`,
        '--sp-timer-delay': `-${(elapsedMs / 1000).toFixed(3)}s`,
      } as React.CSSProperties;
      // React key so the .seat__info remounts (animation restarts) each new
      // turn.
      //
      // Dan 2026-08-20: this was keyed on turnDeadlineMs, so ANY movement of
      // the deadline remounted the node and snapped the ring back to FULL
      // mid-turn — the countdown visibly restarted and never completed a
      // clean 15 seconds. Two things move the deadline without starting a new
      // turn: a time-bank extension, and the engine re-stamping the same turn
      // (reconnect grace / forceArmTurnTimer).
      //
      // The turn's START time is its true identity: it changes exactly once
      // per turn. Keying on it means a genuine new turn restarts the ring,
      // while an extension keeps the node mounted and simply lengthens the
      // running animation — which, with the negative --sp-timer-delay, is
      // precisely the desired behaviour (the ring keeps draining from where
      // it is, just more slowly).
      timerKey = turnStartTimeMs || turnDeadlineMs;
    } else if (isActive && timerProgress !== undefined) {
      // Legacy JS-hook fallback (visible tabs only).
      timerStyle = {
        '--timer-progress': `${timerProgress}%`,
      } as React.CSSProperties;
    }

    return (
      <div
        className={containerClasses}
        onClick={onAction}
        role="region"
        aria-label={`Seat ${seatNumber}: ${player.name}${isActive ? ' (acting now)' : ''}${player.status === 'folded' ? ' (folded)' : ''}${player.status === 'all_in' ? ' (all in)' : ''}, stack ${player.stack}`}
        aria-live={isActive ? 'polite' : 'off'}
      >
        {/* Last Action Badge — floats ABOVE the seat (premium style) */}
        {lastAction && (
          <div
            className={`seat__action seat__action--${lastAction}`}
            role="status"
            aria-label={`${player.name}: ${getActionLabel(lastAction, lastBetAmount)}`}
          >
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

        {/* Hole Cards — opponents: show card backs for active/all-in players, reveal at showdown.
            Also render during isFolding so the fly-out animation can play before unmount. */}
        {!player.isHero &&
          (player.status === 'active' || player.status === 'all_in' || isFolding || isMucking) && (
            <div
              className={`seat__cards seat__cards--opponent${player.showCards && player.holeCards?.length ? ' seat__cards--revealed' : ''}${isFolding || isMucking ? ' seat__cards--folding' : ''}${isShowdownFlip ? ' seat__cards--showdown' : ''}${isDealing ? ' seat__cards--dealing' : ''}`}
            >
              {player.holeCards && player.holeCards.length > 0 ? (
                player.holeCards.map((card, i) => (
                  <HoleCard
                    key={i}
                    card={card}
                    /* Dan 2026-08-18: null = this specific card was not among
                       the ones the player chose to show, so it stays down even
                       though the seat itself is revealed. */
                    hidden={!player.showCards || card == null}
                    index={i}
                    isWinner={isWinner}
                    deckStyle={deckStyle}
                    cardBack={cardBack}
                  />
                ))
              ) : (
                <>
                  <HoleCard
                    key={0}
                    hidden={true}
                    index={0}
                    deckStyle={deckStyle}
                    cardBack={cardBack}
                  />
                  <HoleCard
                    key={1}
                    hidden={true}
                    index={1}
                    deckStyle={deckStyle}
                    cardBack={cardBack}
                  />
                </>
              )}
            </div>
          )}

        {/* Avatar Circle — large, sits on top of info box */}
        {/* Bible V8 §11.1: show_avatars toggle */}
        <div
          className={`seat__avatar-wrap${isBustArt ? ' seat__avatar-wrap--bust' : ''}`}
          style={showAvatar ? undefined : { visibility: 'hidden' }}
        >
          {/* Timer is shown via smooth conic-gradient border on the info box below */}
          <div
            className={`seat__avatar${isBustArt ? ' seat__avatar--bust' : ''}`}
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
                key={`avatar-${avatarUrl}`}
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
            {/* UI-AUDIT #9: key by avatarUrl so a src change remounts the fallback
                back to display:none, undoing the onError DOM mutation above. */}
            <span
              key={`avatar-fallback-${avatarUrl}`}
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

          {/* Position Badge — PokerBros parity: SB/BB/UTG/CO/BTN shown
             on each seat. Dealer "D" button rendered separately via DealerButton
             component, so skip 'D' and 'BTN' here to avoid double-badging. */}
          {position && position !== 'D' && position !== 'BTN' && (
            <div
              className={`seat__position-badge seat__position-badge--${position.toLowerCase().replace('+', 'p')}`}
            >
              {position}
            </div>
          )}
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
          /* COMPETITOR-PARITY 2026-08-19 (Card Squeeze): while the setting is
             on and this hand has not been squeezed open, the hero's cards sit
             face DOWN and the container owns a drag-up peel gesture instead
             of the tap-to-peek handlers. Auto-opens if the table can already
             see the hand (all-in runout / showdown / winner / muck). */
          <div
            className={
              'seat__cards seat__cards--hero' +
              (isDealing ? ' seat__cards--dealing' : '') +
              (isFolding ? ' seat__cards--folding' : '') +
              (lastAction === 'fold' || player.status === 'folded' ? ' seat__cards--folded' : '') +
              (isPeeking ? ' seat__cards--peeking' : '') +
              (squeezeDown
                ? ' seat__cards--squeeze' + (squeezeHint ? ' seat__cards--squeeze-hint' : '')
                : squeezeRevealed && cardSqueezeActive
                  ? ' seat__cards--squeeze-open'
                  : '')
            }
            style={
              cardSqueezeActive
                ? ({ '--squeeze-progress': squeezeProgress } as React.CSSProperties)
                : undefined
            }
            role={squeezeDown ? 'button' : undefined}
            tabIndex={squeezeDown ? 0 : undefined}
            aria-label={
              squeezeDown
                ? 'Your cards are face down. Drag up to squeeze them open, or press Enter.'
                : undefined
            }
            {...(squeezeDown
              ? squeezeHandlers
              : {
                  /* Bible V8 §5.3: tap hero cards to peek (brief lift animation) */
                  onTouchStart: () => {
                    if (gesturesEnabled) setIsPeeking(true);
                  },
                  onTouchEnd: () => {
                    if (gesturesEnabled) {
                      if (peekTimerRef.current) clearTimeout(peekTimerRef.current);
                      peekTimerRef.current = setTimeout(() => {
                        peekTimerRef.current = null;
                        setIsPeeking(false);
                      }, 300);
                    }
                  },
                  onMouseDown: () => {
                    if (gesturesEnabled) setIsPeeking(true);
                  },
                  onMouseUp: () => {
                    if (gesturesEnabled) {
                      if (peekTimerRef.current) clearTimeout(peekTimerRef.current);
                      peekTimerRef.current = setTimeout(() => {
                        peekTimerRef.current = null;
                        setIsPeeking(false);
                      }, 300);
                    }
                  },
                })}
          >
            {player.holeCards.map((card, i) => (
              /* ── Dan 2026-08-18: click a card to show it after the hand ──
                 Wrapping rather than putting the handler on HoleCard keeps the
                 card renderer presentational and shared with opponents. The
                 marker class is what tells the player the click registered -
                 nothing is exposed at the table until the hand ends. */
              <span
                key={i}
                className={
                  'seat__card-pick' +
                  (showPickedCardIndexes?.includes(i) ? ' seat__card-pick--marked' : '')
                }
                /* AUDIT-2 FIX 2026-08-20: while the cards are face down in
                   squeeze mode this span must NOT be a focusable button — its
                   handlers early-return, so it announced "Show card 1 after
                   the hand" and did nothing, and its hover lift fought the
                   container's grab cursor. The squeeze container owns the
                   interaction until the cards are open. */
                role={onToggleShowCard && !squeezeDown ? 'button' : undefined}
                tabIndex={onToggleShowCard && !squeezeDown ? 0 : undefined}
                aria-hidden={squeezeDown ? true : undefined}
                aria-pressed={
                  onToggleShowCard && !squeezeDown
                    ? !!showPickedCardIndexes?.includes(i)
                    : undefined
                }
                aria-label={
                  onToggleShowCard && !squeezeDown
                    ? showPickedCardIndexes?.includes(i)
                      ? `Card ${i + 1} will be shown after the hand. Activate to keep it hidden.`
                      : `Show card ${i + 1} after the hand`
                    : undefined
                }
                onClick={(e) => {
                  // Squeeze mode: while face down, taps belong to the squeeze
                  // gesture — you cannot mark a card you have not looked at.
                  if (!onToggleShowCard || squeezeDown) return;
                  // The container above owns press-to-peek; stop this click
                  // from also being read as a peek gesture.
                  e.stopPropagation();
                  onToggleShowCard(i);
                }}
                onKeyDown={(e) => {
                  if (!onToggleShowCard || squeezeDown) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    onToggleShowCard(i);
                  }
                }}
              >
                {squeezeDown ? (
                  /* Face-down squeeze box: the BACK lifts away from its top
                     edge as the player drags (driven by --squeeze-progress),
                     progressively exposing the FACE beneath.
                     REVIEW FIX 2026-08-19: wrapped in .seat__card so the box
                     gets hero card sizing AND the deal-in / fold keyframes
                     (they target .seat__card); the --squeeze modifier lifts
                     overflow:hidden so the 3D peel is never clipped. */
                  <div className="seat__card seat__card--squeeze">
                    <div className="seat__squeeze-flip">
                      <div className="seat__squeeze-face seat__squeeze-face--under">
                        {card ? (
                          <CardImage card={card} deckStyle={deckStyle} size="md" />
                        ) : (
                          <CardBack size="md" style={cardBack} />
                        )}
                      </div>
                      <div className="seat__squeeze-face seat__squeeze-face--cover">
                        <CardBack size="md" style={cardBack} />
                      </div>
                    </div>
                  </div>
                ) : (
                  <HoleCard
                    card={card}
                    hidden={false}
                    index={i}
                    isHero={true}
                    isWinner={isWinner}
                    deckStyle={deckStyle}
                    cardBack={cardBack}
                  />
                )}
              </span>
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

        {/* BBJ credit float — gold, distinct from the pot-win +N (2026-08-18) */}
        {typeof bbjCreditAmount === 'number' && bbjCreditAmount > 0 && (
          <div className="seat__bbj-credit" key={`bbj-${bbjCreditAmount}`}>
            BBJ +
            {(Math.trunc(bbjCreditAmount * 100) / 100).toLocaleString('en-US', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </div>
        )}

        {/* All-In Badge */}
        {player.status === 'all_in' && !isWinner && <div className="seat__allin-badge">ALL IN</div>}

        {/* Bounty Badge */}
        {bountyValue != null && bountyValue > 0 && (
          <div className="seat__bounty">
            <span className="seat__bounty-target">◎</span>
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
    if (prev.canSit !== next.canSit) return false;
    if (prev.position !== next.position) return false;
    if (prev.isTournament !== next.isTournament) return false;
    if (prev.bigBlind !== next.bigBlind) return false;
    if (prev.bountyValue !== next.bountyValue) return false;
    if (prev.isWinner !== next.isWinner) return false;
    if (prev.winningHandName !== next.winningHandName) return false;
    if (prev.netWinAmount !== next.netWinAmount) return false;
    if (prev.bbjCreditAmount !== next.bbjCreditAmount) return false;
    if (prev.lastAction !== next.lastAction) return false;
    if (prev.lastBetAmount !== next.lastBetAmount) return false;
    if (prev.showHUD !== next.showHUD) return false;
    // UI-AUDIT P1: collect-to-pot animation is driven solely by this flag on
    // COMMUNITY_CARDS_DEALT / HAND_COMPLETE — must force a re-render or the
    // cpCollect keyframe never fires and chips teleport into the pot.
    if (prev.isCollectingChips !== next.isCollectingChips) return false;
    // ANIMATION AUDIT 2026-08-19: showdown-loser muck flag must re-render.
    if (prev.isMucking !== next.isMucking) return false;
    // COMPETITOR-PARITY 2026-08-19: card squeeze mode flips render structure.
    if (prev.cardSqueezeActive !== next.cardSqueezeActive) return false;
    // AUDIT-2 FIX 2026-08-20: these were missing from the comparator.
    // showPickedCardIndexes is the ONLY prop that changes when the hero marks
    // a card to show, so without it the memo blocked the re-render and the
    // gold "will be shown" marker never appeared — the click looked dead.
    if (prev.handNumber !== next.handNumber) return false;
    if (prev.playSounds !== next.playSounds) return false;
    if (prev.onToggleShowCard !== next.onToggleShowCard) return false;
    {
      const a = prev.showPickedCardIndexes;
      const b = next.showPickedCardIndexes;
      if (a !== b) {
        if (!a || !b || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      }
    }
    // UI-AUDIT #13: gesture toggle must take effect on already-mounted seats.
    if (prev.gesturesEnabled !== next.gesturesEnabled) return false;

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
    if (prev.isDealing !== next.isDealing) return false;
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
        // Dan 2026-08-18: a slot can be null now (partial per-card reveal), so
        // compare identity first and only read fields when both are present.
        // Treating null vs card as "equal" here would freeze a seat on its old
        // backs at the moment the reveal lands.
        const a = ph[i];
        const b = nh[i];
        if (a === b) continue;
        if (!a || !b) return false;
        if (a.rank !== b.rank || a.suit !== b.suit) return false;
      }
    }

    return true;
  }
);

export default SeatSlot;
