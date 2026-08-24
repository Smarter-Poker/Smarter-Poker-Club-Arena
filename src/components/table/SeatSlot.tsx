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
import { getAnimationSpeed, prefersReducedMotion } from '../../utils/animationSpeed';
import RiveAvatar from './RiveAvatar';
import { startMotionBudget } from '../../utils/motionBudget';
import { bustArtGain, BUST_ART_GAIN } from './bustArtGain';
import { sortCardsByRank } from '../../lib/tableCardDisplay';
import './avatarChoreography.css';

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

/**
 * AVATAR CHOREOGRAPHY 2026-08-21 (Dan: "if they could move to put chips in the
 * pot, or actually make a fold motion when folding, or celebrating when
 * winning a pot").
 *
 * Tier 0 of the avatar-animation plan: the character is animated as a rigid
 * body, so EVERY avatar in the library gets motion with no new art and no new
 * runtime dependency. The gesture class lands on `.seat__avatar-wrap` —
 * deliberately NOT on `.seat__avatar-img`, which already carries the bust-art
 * `translateY(--sp-bust-clip) scale(--sp-bust-scale)` that anchors the
 * character's feet to the name box, and NOT on `.seat__avatar`, which
 * `.seat--winner` already drives with `seatWinnerAvatarGlow` plus a static
 * `scale(1.08)`. The wrap is the one box in the avatar subtree that nothing
 * else transforms or animates. Full rationale in avatarChoreography.css.
 */
export type AvatarGesture = 'push' | 'check' | 'fold' | 'celebrate' | 'lose' | 'alert' | null;

/** How long the showdown-loss slump plays. Matches spAvatarLose. */
const LOSE_MS = 780;

/**
 * Below this much time remaining, an acting player stops looking calm.
 * 33% mirrors `.seat--timer-urgent`, so the character's tell and the ring's
 * colour change arrive together instead of at two unrelated moments.
 */
const TENSE_AT_PERCENT = 33;

/**
 * AMBIENT IDLE 2026-08-21 — per-seat breathing desync.
 *
 * Nine avatars breathing on the same 4s clock is worse than nine static ones:
 * synchronised biological motion reads as machinery. Both the period and the
 * phase are therefore derived from the seat number.
 *
 * The delay is NEGATIVE, which starts each seat part-way through its own cycle.
 * A positive delay would hold every avatar still until its turn came round, so
 * the table would visibly "start breathing" a few seconds after it loads, one
 * seat at a time. Negative delays mean the table is already alive on frame one.
 *
 * Derived rather than random so a seat's rhythm survives re-renders — a random
 * phase would resample on every mount and make avatars visibly jump.
 */
/** Holo sweep period. Must match the duration in `.seat__avatar--holo::after`. */
const HOLO_CYCLE_S = 7;

function breathingStyle(seatNumber: number): React.CSSProperties {
  // 3.4s - 5.0s. Prime-ish spread so seats drift apart instead of re-syncing.
  const duration = 3.4 + ((seatNumber * 7) % 9) * 0.2;
  const delay = -((seatNumber * 13) % 40) * 0.1;

  /**
   * The holo sweep needs its OWN phase, not the breathing's.
   *
   * Reusing --sp-breath-delay looked fine and was measurably wrong: that value
   * spans only 1.1s-3.9s, which is a good spread across a ~4s breath but a poor
   * one across a 7s sweep. All nine VIPs would flash inside a single narrow
   * window and then sit dark together — the synchronised-machinery look the
   * per-seat phase exists to prevent, just on a longer clock.
   *
   * `(seat * 4) % 9` is a permutation of 0..8, so the nine phases land EVENLY
   * across the full cycle and, because it is a permutation rather than a ramp,
   * physically adjacent seats get distant phases. A plain `seat / 9` ramp would
   * also be even but would sweep round the table like a lighthouse.
   */
  const holoDelay = -(((seatNumber * 4) % 9) / 9) * HOLO_CYCLE_S;

  return {
    ['--sp-breath-dur' as string]: `${duration.toFixed(2)}s`,
    ['--sp-breath-delay' as string]: `${delay.toFixed(2)}s`,
    ['--sp-holo-delay' as string]: `${holoDelay.toFixed(2)}s`,
  };
}

/** How long the "it's on you" posture change plays. Matches spAvatarAlert. */
const ALERT_MS = 480;

/**
 * Action -> gesture, with the window (ms at 1x speed) the class stays on.
 * Each window is the keyframe duration plus a small tail so the class is never
 * stripped mid-flight — the mistake that made `cardFoldOut` snap when its
 * window was 350ms against a 435ms animation (see the fold effect below).
 */
const GESTURE_FOR_ACTION: Partial<
  Record<NonNullable<LastAction>, { gesture: AvatarGesture; ms: number }>
> = {
  bet: { gesture: 'push', ms: 560 },
  raise: { gesture: 'push', ms: 560 },
  call: { gesture: 'push', ms: 560 },
  all_in: { gesture: 'push', ms: 560 },
  check: { gesture: 'check', ms: 440 },
  fold: { gesture: 'fold', ms: 660 },
};

/** Celebration window — must outlast spAvatarCelebrate (900ms) by a hair. */
const CELEBRATE_MS = 940;

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
  /**
   * BOMB POT 2026-08-20: true while a bomb pot's forced ante round is live.
   * Shows the magenta "BOMB" pill over the seat (competitor-parity — every
   * seated player is marked while the antes post and the flop plays out).
   */
  bombPotAnte?: boolean;
  isWinner?: boolean;
  winningHandName?: string; // e.g. "Straight", "Full House"
  /**
   * Dan 2026-08-21 (item 15): hero's CURRENT made hand, recomputed on every
   * street ("Ace High" -> "Pair" -> "Two Pair"). Hero seats only; the parent
   * evaluates it so the work happens once per board, not once per seat.
   */
  handStrength?: string | null;
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
  /**
   * How many hole cards this VARIANT deals, used only to draw the right number
   * of face-down backs for an opponent whose hand we cannot see.
   *
   * Dan 2026-08-23: "it only shows 2 cards even if its a 4 card, 5 card or 6
   * card game, that needs to also change." The fallback branch below hard-coded
   * two <HoleCard hidden> elements, so every PLO4/PLO5/PLO6 seat showed a
   * Hold'em hand. The seat cannot infer this - an opponent's `holeCards` is
   * empty precisely because it is hidden, so there is nothing local to count.
   * Only the table knows the variant, so the table passes it.
   *
   * Defaults to 2 so any caller that does not pass it keeps today's behaviour
   * rather than rendering nothing.
   */
  holeCardCount?: number;
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

/**
 * CSS pixel size of the avatar slot, mirrored from `--seat-avatar-size` in
 * design-tokens.css (villain) and the `.seat--hero` override in SeatSlot.css.
 *
 * Dan 2026-08-20 (audit): these were hardcoded as `56` at the call site, which
 * was correct until 2026-08-15 — the day the token went 56px -> 84px and hero
 * got its own 112px. The number was never updated, so Storage kept returning
 * 112px images (the helper doubles for retina) for a box drawn at 84 CSS px,
 * i.e. 168 device px on a retina phone: every uploaded photo was being
 * upscaled 1.5x, and the hero's 2x. That is why photo avatars read soft.
 *
 * If `--seat-avatar-size` changes again, change these with it. They are only
 * a request hint — nothing lays out from them — so being a little generous is
 * cheap and being too small is visible.
 */
/**
 * How much bigger a particular character has to be drawn to LOOK the same size
 * as the others. See `./bustArtGain` - it is a GENERATED table covering every
 * character in the library, measured from the art itself.
 *
 * Re-exported here because this module was its original home and the `table`
 * barrel (index.ts) re-exports from it.
 *
 * It used to be two entries typed by hand - `viking: 2, chef: 2` - written from
 * a four-character sample after Dan asked for "the viking and chef 2x current
 * size". The chef is genuinely small (71% of its canvas). The viking is the 6th
 * LARGEST asset of 100 at 95%, so 2x gave it a 2.9x render that swallowed its
 * seat and spilled onto the felt. Two characters named in one sentence, given
 * one number, sitting at opposite ends of the distribution.
 *
 * A sample cannot correct a per-file difference across 100 files. Measurement
 * can, so the numbers are now computed for all of them and cannot drift from
 * the art:  python3 scripts/measure-bust-art.py
 *
 * Imported at the top of this file (the render path calls it directly) and
 * re-exported here so the `table` barrel keeps the same public surface.
 */
export { bustArtGain, BUST_ART_GAIN };

const SEAT_AVATAR_PX = 84;
const SEAT_AVATAR_PX_HERO = 112;

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
      // isTournament is deliberately NOT destructured any more. Nothing inside
      // this component may branch a VISUAL on tournament-ness: doing so is what
      // gave a Spin an inert empty seat and a stack that would not warn at 8bb.
      // The prop stays on the interface because the memo comparator below still
      // needs to see it change (it feeds SeatSlot's parents), and because
      // removing it from every call site is a bigger change than it is worth.
      bountyValue,
      bombPotAnte,
      isWinner = false,
      netWinAmount,
      bbjCreditAmount,
      winningHandName,
      handStrength,
      hudStats,
      showHUD = false,
      playerStyle,
      secondsLeft,
      deckStyle,
      cardBack = 'classic_blue',
      holeCardCount = 2,
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

    /**
     * Dan 2026-08-23: "when a player folds, their blue countdown light should
     * stop at once."
     *
     * A folded seat is not acting, whatever the last snapshot still says. The
     * two sources disagree for a moment by design, and the class list further
     * down already documents it: `lastAction` flips the instant the fold is
     * dispatched, `player.status` only turns 'folded' when the next server
     * snapshot lands. But `isActive` is derived from the SNAPSHOT's
     * currentPlayerSeat, so for that whole round trip - the fold leaves, the
     * engine advances the turn, the delta comes back - the seat that just
     * folded is still formally "the player to act", and its ring keeps
     * draining on a player who is already out of the hand.
     *
     * Dimming was taught to honour whichever source lands first. The clock was
     * not, so the seat went dark with a live countdown still running on it.
     * Declared here, above every consumer, so the ring, the urgency colours,
     * the tense idle animation, the turn gesture and the screen-reader label
     * all read ONE value instead of four sites each re-deciding what "acting"
     * means - which is how they drifted apart in the first place.
     *
     * Deliberately CLIENT-side and optimistic. The engine remains the authority
     * on whose turn it is; this only refuses to draw a clock for a player we
     * already know cannot act.
     */
    const hasFolded = !!player && (lastAction === 'fold' || player.status === 'folded');
    const isActingNow = isActive && !hasFolded;

    /**
     * Dan 2026-08-23: "when the cards get shown down they need to be straight
     * and IN ORDER."
     *
     * The engine hands cards over in deal order, which is arbitrary to look at -
     * a PLO4 hand arrives as something like 6h As 9c Ad and the player has to
     * pair it up themselves at the exact moment they are trying to read a
     * showdown. Sorted high to low, the same way the hero's own hand is already
     * sorted by the cards_pre_sort setting.
     *
     * ONLY when every card is present. `null` in this array is not a missing
     * card, it is the per-card show picker saying "this one stays face down"
     * (2026-08-18) - so a slot's POSITION carries meaning there, and sorting
     * would move a face-down card away from the card it belongs beside.
     */
    const displayHoleCards = useMemo(() => {
      const cards = player?.holeCards;
      if (!cards || cards.length === 0) return cards ?? [];
      if (cards.some((c) => c == null)) return cards;
      return sortCardsByRank(cards as Card[]);
    }, [player?.holeCards]);

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

    /**
     * Which avatar URL (if any) failed to load, so the monogram can take over.
     *
     * Dan 2026-08-20 (audit): this used to be done by MUTATING THE DOM from
     * `onError` — `e.target.style.display = 'none'` plus a `querySelector` on
     * the parent to un-hide a sibling that was rendered with an inline
     * `display: none`. Two things wrong with that inside a memo'd component:
     * React owns those nodes and will happily re-use an element still carrying
     * a hand-written `display: none`, so a seat that errored once could stay
     * blank even after a good URL was available; and the workaround for that
     * was a `key` on both nodes, which forced a full remount (and a re-fetch,
     * and a flash) every time the URL changed for any reason.
     *
     * Storing the failed URL instead of a boolean means recovery is automatic:
     * a different URL simply is not the failed one, so no reset effect, no
     * keys, no imperative DOM.
     */
    const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);

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

    /**
     * AVATAR CHOREOGRAPHY 2026-08-21 — the character reacts to its own action.
     *
     * Deliberately a SEPARATE effect from the all-in/fold one above rather than
     * another branch inside it. That effect early-returns per branch to scope
     * its cleanup to a single timer, so an added branch would either be
     * unreachable (all_in and fold both return before it) or would silently
     * change which timeout gets cleaned up. One ref, one timer, one concern.
     *
     * No new prop is needed, so the memo comparator below is untouched:
     * `lastAction` and `isWinner` are both already compared there, which is
     * what makes the seat re-render on every action and every win.
     */
    /**
     * True only once a .riv has loaded AND exposed the expected state machine.
     * Until then — and forever, for an unrigged avatar — the static <img> is
     * what renders. Deliberately driven by the child rather than inferred here,
     * because "a rig exists in the manifest" and "a rig is actually on screen"
     * are different things and only the second should hide the artwork.
     */
    /**
     * Started from here rather than from TablePage on purpose: it is a one-shot
     * singleton, so every seat calling it is free after the first, and keeping
     * it self-contained means the avatar system carries its own performance
     * budget instead of depending on a change in a file three workstreams are
     * editing at once.
     */
    useEffect(() => {
      startMotionBudget();
    }, []);

    const [rigActive, setRigActive] = useState(false);
    const [avatarGesture, setAvatarGesture] = useState<AvatarGesture>(null);
    const gestureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const prevGestureActionRef = useRef<LastAction>(null);
    const prevGestureWinnerRef = useRef(false);
    useEffect(() => {
      return () => {
        if (gestureTimerRef.current) clearTimeout(gestureTimerRef.current);
      };
    }, []);
    useEffect(() => {
      // Keep the ref in step even when we bail, or the seat fires a stale
      // gesture the next time this effect actually runs.
      const changed = lastAction !== prevGestureActionRef.current;
      prevGestureActionRef.current = lastAction;
      if (!changed || !lastAction) return;
      // The stylesheet also guards via @media, but the class still has to not
      // be applied at all so `will-change: transform` stays off the compositor
      // on nine simultaneous seats.
      if (prefersReducedMotion()) return;
      const g = GESTURE_FOR_ACTION[lastAction];
      if (!g) return;
      setAvatarGesture(g.gesture);
      if (gestureTimerRef.current) clearTimeout(gestureTimerRef.current);
      gestureTimerRef.current = setTimeout(
        () => setAvatarGesture(null),
        g.ms * getAnimationSpeed()
      );
    }, [lastAction]);
    useEffect(() => {
      // Rising edge only — replays once per win, like the winner-pop above.
      const rising = isWinner && !prevGestureWinnerRef.current;
      prevGestureWinnerRef.current = isWinner;
      if (!rising || prefersReducedMotion()) return;
      // Celebrate outranks whatever the player's last action was: isWinner
      // flips at HAND_COMPLETE, after PLAYER_ACTION, so this effect runs last
      // and its setState is the one that lands.
      setAvatarGesture('celebrate');
      if (gestureTimerRef.current) clearTimeout(gestureTimerRef.current);
      gestureTimerRef.current = setTimeout(
        () => setAvatarGesture(null),
        CELEBRATE_MS * getAnimationSpeed()
      );
    }, [isWinner]);
    /**
     * AMBIENT IDLE 2026-08-21 — "it's on you". The character sits up and leans
     * toward the table when the turn arrives.
     *
     * Before this, a turn was announced entirely by chrome: the conic countdown
     * ring and the gold rim. The player themselves did not react to being put
     * on the clock, which is the single most-watched moment at the table.
     *
     * Rising edge, so it plays once when the turn ARRIVES rather than
     * re-triggering on every timer tick that re-renders the seat. Runs after
     * the action effect above and does not clash with it: a seat cannot be
     * acting and have just acted in the same frame.
     */
    /**
     * Seeded with the CURRENT value rather than false, so mounting into a seat
     * that is already acting is not treated as a transition.
     *
     * With `useRef(false)` the first effect run always saw a rising edge, so a
     * player opening a table mid-hand watched the acting seat sit up as though
     * the turn had just arrived — and on MultiTablePage, which mounts and
     * unmounts tables as you switch tabs, that replayed on every visit. An
     * alert is a reaction to the turn ARRIVING; arriving late to someone else's
     * turn is not that.
     */
    const prevGestureActiveRef = useRef(isActingNow);
    useEffect(() => {
      const rising = isActingNow && !prevGestureActiveRef.current;
      prevGestureActiveRef.current = isActingNow;
      if (!rising || prefersReducedMotion()) return;
      setAvatarGesture('alert');
      if (gestureTimerRef.current) clearTimeout(gestureTimerRef.current);
      gestureTimerRef.current = setTimeout(
        () => setAvatarGesture(null),
        ALERT_MS * getAnimationSpeed()
      );
    }, [isActingNow]);
    /**
     * THE OTHER HALF OF THE OUTCOME 2026-08-21.
     *
     * Winners celebrate; losers did nothing at all. A table that only expresses
     * one of the two outcomes reads as oddly indifferent — the pot is pushed,
     * one seat cheers, and the player who just lost a showdown holds exactly
     * the same calm idle they had before the cards turned over.
     *
     * `isMucking` is the parent's existing "this seat LOST a showdown and its
     * cards should fly to the muck" flag. It is already in the memo comparator
     * (added when the muck animation landed), so this needs no new prop and no
     * change in TablePage.
     */
    const prevGestureMuckRef = useRef(false);
    useEffect(() => {
      const rising = isMucking && !prevGestureMuckRef.current;
      prevGestureMuckRef.current = isMucking;
      if (!rising || prefersReducedMotion()) return;
      // A loss cannot coincide with a win, so nothing to out-rank here — but it
      // does share the timer, so a late-arriving celebrate would still replace
      // it, which is the correct precedence.
      setAvatarGesture('lose');
      if (gestureTimerRef.current) clearTimeout(gestureTimerRef.current);
      gestureTimerRef.current = setTimeout(
        () => setAvatarGesture(null),
        LOSE_MS * getAnimationSpeed()
      );
    }, [isMucking]);

    /**
     * TIME PRESSURE 2026-08-21 — the tell.
     *
     * Under a third of the clock the character stops looking comfortable. Until
     * now the countdown was expressed purely as chrome: the ring shrinks and
     * changes colour, and the player it belongs to sits there breathing calmly
     * through it. Real players get tense on the clock, and it is the single
     * most watched moment at the table.
     *
     * Deliberately NOT applied while a gesture is playing. The tense class and
     * the gesture classes are all single-class selectors on the same element,
     * so whichever is declared later would win outright; gating here keeps the
     * precedence explicit and readable instead of hiding it in source order.
     * Same approach as `--rigged`.
     */
    const showTense =
      isActingNow &&
      !avatarGesture &&
      !rigActive &&
      timerProgress !== undefined &&
      timerProgress <= TENSE_AT_PERCENT;

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
        // isActingNow, not isActive: a seat that has just folded must lose the
        // acting chrome (and its countdown ring) immediately, without waiting
        // for the snapshot that moves currentPlayerSeat along. See hasFolded.
        if (isActingNow) cls.push('seat--active');
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
        if (isActingNow && timerProgress !== undefined) {
          if (timerProgress <= 20) cls.push('seat--timer-critical');
          else if (timerProgress <= 33) cls.push('seat--timer-urgent');
        }
      }
      return cls.join(' ');
    }, [
      player,
      isActingNow,
      lastAction,
      isWinner,
      timerProgress,
      winnerPop,
      allinShake,
      stackGlow,
    ]);

    // ─── EMPTY SEAT ────────────────────────────────────────────────────────
    if (!player) {
      // This used to short-circuit on `isTournament` and return a bare div: no
      // label, no affordance, no click handler. That was survivable at an MTT,
      // where seats are assigned and an empty one is genuinely not for sale.
      //
      // It was not survivable at a Spin. A seat-first Spin sells its three
      // seats by the click, TablePage wires onSit -> handleSeatClick -> the
      // fn_take_seat_and_buy_in branch, and the footer reads "Spectating, Tap
      // An Open Seat To Join" - onto seats that could not be tapped, carried no
      // label, and did not breathe. The instruction on screen could not be
      // followed.
      //
      // The distinction that matters is not tournament-ness, it is whether the
      // seat can actually be taken, and `canSit` already carries that: TablePage
      // now includes seat-first in it. A seat that cannot be taken still falls
      // to the passive EMPTY marker below, which suppresses the pulse in CSS.
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
    // The helper doubles this for retina and asks Storage to resize, so it must
    // be the CSS box the photo is actually drawn in. Before the sizing existed,
    // every seat pulled the user's full-resolution upload — 263 KB each on the
    // owner account, nine of them on a full table.
    const avatarUrl = getAvatarWithFallback(
      player.avatar || null,
      player.id,
      player.name,
      player.isHero ? SEAT_AVATAR_PX_HERO : SEAT_AVATAR_PX
    );
    const bustGain = bustArtGain(avatarUrl);
    // 2026-08-04 PokerBros-style: library bust art (/avatars/table|free|vip/*)
    // is a transparent-background character PNG — render it free-floating
    // (no circle crop, no ring, larger) like the reference client. Uploaded
    // photos and generated SVGs keep the circular frame.
    const isBustArt = /\/avatars\/(table|free|vip)\//.test(avatarUrl);
    /**
     * PREMIUM HOLO 2026-08-21 — Dan: "God Tier avatars that actually move,
     * breathe, or have scanning holographic lines pulsing across their faces."
     *
     * Tier is already encoded in the filename by the Hub's asset pipeline:
     * AvatarService normalises everything to `/avatars/table/{tier}_{slug}.webp`
     * where tier is literally `vip` or `free`. So the premium gate costs one
     * regex and needs no new prop, no lookup and no round-trip — the URL the
     * seat is already rendering carries the entitlement.
     *
     * Bust art only. The effect is a scan line masked to the CHARACTER, and an
     * uploaded photo is an opaque rectangle: masking to it would put a bright
     * band across a square, which is the "ring behind the player" complaint in
     * a different costume.
     */
    const isVipBust = isBustArt && /\/avatars\/table\/vip_/.test(avatarUrl);
    // Only true while THIS url is the one that failed, so a new url recovers
    // on its own. getAvatarWithFallback never returns empty — with no uploaded
    // avatar it returns a generated `data:` SVG, which cannot 404 — so this is
    // reachable only for real network URLs (Storage uploads, /avatars/table/*).
    const avatarBroken = failedAvatarUrl === avatarUrl;
    /**
     * A broken avatar falls back to the monogram, and the holo mask would be
     * pointing at the URL that just 404'd. Verified in chromium that a dead
     * mask paints NOTHING rather than dropping the mask and leaving a bare
     * rectangle across the felt — so this is tidiness, not a live bug: it
     * stops the seat mounting a pseudo-element that can only ever be invisible.
     * Stated explicitly because "the mask failed, therefore nothing shows" is a
     * browser behaviour worth not depending on silently.
     *
     * Also off when a rig is live: the scan line is alpha-masked with the STATIC
     * artwork, so over a rig — which draws its own, moving pixels — the mask and
     * the character would no longer agree. A rigged avatar carries its own look.
     */
    const showHolo = isVipBust && !avatarBroken && !rigActive;
    // The hero can now be clicked to open the profile modal.
    const avatarClickable = !!onAvatarClick;

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
    if (isActingNow && turnDeadlineMs && turnDeadlineMs > 0) {
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
      // Dan 2026-08-20 (round 2): "it needs to take 15 seconds to disappear,
      // it currently disappears too fast." The old plausibility floor was 5s,
      // so a torn read landing anywhere in the 5-15s band was still rendered
      // as a fast ring. The shot clock is 15s on every table (engine default
      // and all live rows), so anything SHORTER than 15s is by definition a
      // torn/stale pair — floor the ring at the canonical 15s. Longer stays
      // honored: that is a genuine time-bank-extended turn.
      const MIN_PLAUSIBLE_TURN_MS = 15_000;
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
      /**
       * Dan 2026-08-21 (bug list item 8): "it must take 15 seconds to fully
       * disappear, it needs to slow down at the end and FLASH when there are 5
       * seconds left."
       *
       * The 15s floor above already guarantees the length. These two variables
       * add the other half of the request:
       *
       *   --sp-timer-flash-delay  when the blink starts, measured from the
       *                           animation's own origin. Negative when the
       *                           seat first paints INSIDE the last five
       *                           seconds (reconnect, tab wake), which drops
       *                           the player straight into a blink already in
       *                           progress instead of restarting it.
       *   --sp-timer-flash-count  how many 0.5s blinks are left, so the ring
       *                           stops flashing at zero instead of strobing
       *                           on into the next turn.
       *
       * The slow-down itself is a CSS `linear()` easing on the shrink — see
       * SeatSlot.css. It is expressed there rather than here because it is a
       * fixed shape (75% of the arc in the first two-thirds of the clock), not
       * something that varies per turn.
       */
      const FLASH_WINDOW_MS = 5_000;
      const FLASH_CYCLE_MS = 500;
      const remainingMs = Math.max(0, durationMs - elapsedMs);
      const flashDelayMs = durationMs - FLASH_WINDOW_MS - elapsedMs;
      const flashCount = Math.max(
        0,
        Math.ceil(Math.min(FLASH_WINDOW_MS, remainingMs) / FLASH_CYCLE_MS)
      );
      timerStyle = {
        '--sp-timer-duration': `${(durationMs / 1000).toFixed(3)}s`,
        '--sp-timer-yellow-duration': `${(yellowMs / 1000).toFixed(3)}s`,
        '--sp-timer-delay': `-${(elapsedMs / 1000).toFixed(3)}s`,
        '--sp-timer-flash-delay': `${(flashDelayMs / 1000).toFixed(3)}s`,
        '--sp-timer-flash-count': `${flashCount}`,
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
    } else if (isActingNow && timerProgress !== undefined) {
      // Legacy JS-hook fallback (visible tabs only).
      timerStyle = {
        '--timer-progress': `${timerProgress}%`,
      } as React.CSSProperties;
    }

    return (
      <div
        className={containerClasses}
        onClick={onAction}
        data-seat-num={seatNumber}
        role="region"
        /* isActingNow: a screen reader must not keep announcing a folded seat
           as "acting now" for the round trip it takes the snapshot to move the
           turn along - the same stale-turn window the countdown ring had. */
        aria-label={`Seat ${seatNumber}: ${player.name}${isActingNow ? ' (acting now)' : ''}${player.status === 'folded' ? ' (folded)' : ''}${player.status === 'all_in' ? ' (all in)' : ''}, stack ${player.stack}`}
        aria-live={isActingNow ? 'polite' : 'off'}
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
              {player.holeCards && player.holeCards.length > 0
                ? displayHoleCards.map((card, i) => (
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
                : /* Dan 2026-08-23: this used to be exactly two hard-coded backs,
                   so a PLO4 seat showed a Hold'em hand and a 6-card seat showed
                   a third of one. The count comes from the table because the
                   seat has nothing to count - an opponent's holeCards array is
                   empty BECAUSE the hand is hidden. Guarded to a sane band so a
                   malformed variant string cannot render 0 cards (a live player
                   who looks like they folded) or a hundred. */
                  Array.from({ length: Math.max(1, Math.min(6, holeCardCount)) }, (_, i) => (
                    <HoleCard
                      key={i}
                      hidden={true}
                      index={i}
                      deckStyle={deckStyle}
                      cardBack={cardBack}
                    />
                  ))}
            </div>
          )}

        {/* Avatar Circle — large, sits on top of info box */}
        {/* Bible V8 §11.1: show_avatars toggle */}
        <div
          /* `--rigged` hands ALL motion to the rig. Without it a rigged avatar
             plays its own Push animation while this wrap ALSO leans through
             spAvatarPush, and keeps breathing on top of the rig's own idle —
             two independent animation systems driving the same character at
             once. The CSS choreography is the fallback for an unrigged avatar,
             not a layer on top of a rigged one. */
          className={`seat__avatar-wrap${isBustArt ? ' seat__avatar-wrap--bust' : ''}${
            avatarGesture && !rigActive ? ` seat__avatar-wrap--${avatarGesture}` : ''
          }${showTense ? ' seat__avatar-wrap--tense' : ''}${
            rigActive ? ' seat__avatar-wrap--rigged' : ''
          }`}
          /* Two things share this style object.
             `visibility` kept deliberately: not rendering the <img> stops the
             download, but the wrap also holds the circle chrome, the status dot
             and the position badge, all of which this toggle has always hidden —
             and the wrap must keep its box either way or every seat's geometry
             shifts. Hiding stays visual; only the network cost goes away.
             `breathingStyle` supplies this seat's own idle period and phase, so
             the nine avatars never breathe in lockstep. */
          style={
            showAvatar
              ? breathingStyle(seatNumber)
              : { ...breathingStyle(seatNumber), visibility: 'hidden' }
          }
        >
          {/* Timer is shown via smooth conic-gradient border on the info box below */}
          <div
            className={`seat__avatar${isBustArt ? ' seat__avatar--bust' : ''}${
              showHolo ? ' seat__avatar--holo' : ''
            }`}
            /* The scan line is painted by a ::after that is alpha-masked with
               the SAME artwork the <img> is showing, so the band follows the
               character's silhouette instead of sweeping a rectangle across the
               felt. CSS cannot read the img's src, so hand it over as a custom
               property. Only set for VIP busts — everyone else gets no extra
               property and no pseudo-element at all.

               --sp-bust-gain rides here rather than on the <img> BECAUSE of that
               ::after. This element owns all three things that draw the
               character — the <img>, the Rive canvas that can stand in for it,
               and the masked pseudo-element — so a property declared here
               inherits to every one of them. Declared on the <img> (where it
               started) only the <img> could see it, which is precisely how the
               rig and the holo mask ended up scaling differently from the art
               they are meant to sit exactly on top of. */
            style={
              showHolo || bustGain !== 1
                ? ({
                    ...(showHolo ? { '--sp-avatar-src': `url("${avatarUrl}")` } : null),
                    ...(bustGain !== 1 ? { '--sp-bust-gain': bustGain } : null),
                  } as React.CSSProperties)
                : undefined
            }
            onClick={
              avatarClickable
                ? (e) => {
                    e.stopPropagation();
                    onAvatarClick?.();
                  }
                : undefined
            }
            /* Dan 2026-08-20 (audit): clicking an opponent's avatar opens the
               throwable selector and targets them for Player Notes — but it was
               a bare onClick on a <div>, so it was mouse-only. No role, no
               tabIndex, no key handler: unreachable by keyboard and invisible
               to assistive tech, while the CSS right above it advertises a
               hover ring for "clickable opponent avatars". */
            role={avatarClickable ? 'button' : undefined}
            tabIndex={avatarClickable ? 0 : undefined}
            aria-label={avatarClickable ? `Player actions for ${player.name}` : undefined}
            onKeyDown={
              avatarClickable
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      onAvatarClick?.();
                    }
                  }
                : undefined
            }
          >
            {/* Bible V8 §11.1 show_avatars: when the toggle is OFF the image is
                not rendered at all. It used to render and be hidden with
                `visibility: hidden` on the wrap, so a player who turned avatars
                off to save data still downloaded nine of them every table. The
                wrap itself always renders — the seat's geometry depends on it.

                `alt=""`: the seat is a labelled region that already announces
                the player's name, so a duplicate here is pure screen-reader
                noise. The avatar carries no information the name does not. */}
            {/* RIVE 2026-08-21 — a rigged character, when one exists.
                Renders nothing and costs nothing while no avatar is rigged,
                which is every avatar today: the registry's manifest 404s once
                per session and every seat falls through to the <img> below.
                When a rig IS present it hides the img and drives the same
                gesture value the CSS choreography uses, so rigged and unrigged
                seats stay in lockstep. Contract: docs/RIVE-AVATAR-CONTRACT.md */}
            {showAvatar && !avatarBroken && isBustArt ? (
              <RiveAvatar
                avatarUrl={avatarUrl}
                gesture={avatarGesture}
                isActive={isActive}
                isFolded={lastAction === 'fold' || player.status === 'folded'}
                size={player.isHero ? SEAT_AVATAR_PX_HERO : SEAT_AVATAR_PX}
                onRigActive={setRigActive}
              />
            ) : null}
            {showAvatar && !avatarBroken && !rigActive ? (
              <img
                src={avatarUrl}
                srcSet={`${avatarUrl} 1x, ${avatarUrl.replace(/\.webp$/, '@2x.webp')} 2x`}
                alt=""
                className="seat__avatar-img"
                /* Per-avatar size correction (--sp-bust-gain) is NOT set here.
                   It is declared on `.seat__avatar` above so the Rive rig and
                   the holo mask inherit the same value; see the note there. */
                /* Hero eager + high priority: it is the largest avatar on the
                   table (1.33x), always in view, and the one the player looks
                   at first — `lazy` bought nothing there but a deferred request
                   and a pop-in. Villains stay lazy ON PURPOSE: MultiTablePage
                   keeps up to four tables mounted with the inactive ones
                   display:none, and lazy is what stops 27 off-screen avatars
                   from being fetched before the player has opened those tabs. */
                loading={player.isHero ? 'eager' : 'lazy'}
                decoding="async"
                fetchPriority={player.isHero ? 'high' : 'auto'}
                onError={() => setFailedAvatarUrl(avatarUrl)}
              />
            ) : null}
            {showAvatar && avatarBroken ? (
              <span className="seat__avatar-fallback seat__avatar-initial">
                {player.name.charAt(0).toUpperCase() || '?'}
              </span>
            ) : null}

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
            className={`seat__stack${stackDelta > 0 ? ' seat__stack--up' : stackDelta < 0 ? ' seat__stack--down' : ''} ${getStackDepthClass(player.stack, bigBlind)}`}
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

        {/**
         * Dan 2026-08-21 (bug list item 15): "display the current strength of
         * the hero's hand under their box total — preflop, on the flop, on the
         * turn and river; it should change dynamically."
         *
         * Hero only, and never at the same time as the winner label above (that
         * one is the settled result; this one is the live read, and showing both
         * at once would stack two hand names under one seat). The parent
         * evaluates it — see TablePage's `heroHandStrength` — so the arithmetic
         * runs once per board change rather than once per seat render.
         */}
        {player.isHero && handStrength && !(isWinner && winningHandName) && (
          <div className="seat__strength" aria-live="polite">
            {handStrength}
          </div>
        )}

        {/* Phase 2 T1-01 — PokerBros net-profit floating text.
         *  Keyed on the amount so each new win re-triggers the float.
         *
         *  Dan 2026-08-23: shows for any NON-ZERO net, not just a positive one,
         *  and carries its own sign. Taking down a pot and making money on it
         *  are different things - chop one after the rake comes off and a
         *  winner can be genuinely down on the hand. That used to render as
         *  nothing at all (the mapper clamped the net to 0, and 0 failed this
         *  `> 0` gate), so the hand a player most wants explained was the one
         *  the table went quiet on. A true zero still renders nothing, because
         *  "you broke even" needs no animation. */}
        {isWinner && typeof netWinAmount === 'number' && netWinAmount !== 0 && (
          <div
            className={`seat__net-win${netWinAmount < 0 ? ' seat__net-win--loss' : ''}`}
            key={netWinAmount}
          >
            {netWinAmount > 0 ? '+' : '-'}
            {formatStack(Math.abs(netWinAmount))}
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

        {/* Bomb Pot ante badge — every live seat is tagged while the bomb
            pot's forced antes are in play (BOMB POT 2026-08-20). All-in
            takes the slot if both apply; folded seats drop the pill. */}
        {bombPotAnte && player.status !== 'all_in' && player.status !== 'folded' && !isWinner && (
          <div className="seat__bombpot-badge">BOMB</div>
        )}

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
    if (prev.bombPotAnte !== next.bombPotAnte) return false;
    if (prev.isWinner !== next.isWinner) return false;
    if (prev.winningHandName !== next.winningHandName) return false;
    if (prev.handStrength !== next.handStrength) return false;
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
