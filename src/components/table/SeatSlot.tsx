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

import React, { useMemo, useState, useEffect, useLayoutEffect, useRef, memo } from 'react';
import { serverNow } from '../../utils/serverClock';
import '../../styles/table-design-tokens.css';
import './SeatSlot.css';
import { CardImage, CardBack, SUIT_COLOR } from './CardImage';
import MiniHUD, { type MiniHUDStats } from './MiniHUD';
import { SitOutBadge } from './SitOutBadge';
import type { PlayerStyleResult } from '../../services/PlayerStyleClassifier';
import { ChipPhysics } from './ChipPhysics';
import { getAvatarWithFallback } from '../../utils/avatarGenerator';
import { soundService, haptic } from '../../services/SoundService';
import {
  useActionClockProgress,
  useActionClockSeconds,
  type ActionClockStore,
} from '../../hooks/actionClockStore';
import { getAnimationSpeed, prefersReducedMotion } from '../../utils/animationSpeed';
import RiveAvatar from './RiveAvatar';
import AvatarCosmetics from '../avatars/AvatarCosmetics';
import { startMotionBudget } from '../../utils/motionBudget';
import { bustArtGain, BUST_ART_GAIN } from './bustArtGain';
import { displayOrderWithDealtIndex } from '../../lib/tableCardDisplay';
/**
 * Suit glyphs for the peel index (text symbols, U+2660-2667, with the text
 * variation selector so no platform swaps in an emoji). Same characters
 * CardImage's broken-image fallback uses.
 */
/**
 * The peel index's colour comes from the DECK, never from a literal here: a
 * second set of hex values in a stylesheet is a second source of truth, and
 * `tests/gameplay-wears-the-house-colours.test.ts` caught exactly that when
 * the first version invented #16a34a for clubs (the deck's club green is
 * #22c55e). Two-colour decks paint hearts and diamonds red and the rest black,
 * which is what a two-colour deck IS; four-colour uses the suit's own colour.
 */
function peelIndexColor(suit: string, deckStyle?: '4color' | '2color'): string {
  if (deckStyle === '4color') return SUIT_COLOR[suit] ?? SUIT_COLOR.s;
  return suit === 'h' || suit === 'd' ? SUIT_COLOR.h : SUIT_COLOR.s;
}

const PEEL_SUIT_GLYPH: Record<string, string> = {
  s: '\u2660\uFE0E',
  h: '\u2665\uFE0E',
  d: '\u2666\uFE0E',
  c: '\u2663\uFE0E',
};

import { cardSlideTelemetry } from '../../services/CardSlideTelemetry';
import { computePeel, flatPeel, liftAtProgress, type PeelFrame } from './cardPeel';
import { seatCardSide, type CardSide } from '../../lib/tableSeatGeometry';
import './avatarChoreography.css';
import {
  formatPrizeAtUnit,
  formatStackChips,
  formatTableChips,
  moneyWordAtUnit,
} from '../../utils/format';
import {
  DIAMOND_UNIT_CENTS,
  UNIT_CENTS_ASSET_NOT_READ,
} from '../../../server/src/tournament/tournamentUnit';

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
/* CRAZY PINEAPPLE PHASE 3 2026-08-31: 'discard' was missing from this union
   even though the engine has emitted PLAYER_ACTION action:'discard' since the
   variant shipped and TablePage writes it into lastActions like any other
   action. The seat therefore had a live action it could not name, could not
   label and could not animate. */
export type LastAction = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in' | 'discard' | null;

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
function breathingStyle(seatNumber: number): React.CSSProperties {
  // 3.4s - 5.0s. Prime-ish spread so seats drift apart instead of re-syncing.
  const duration = 3.4 + ((seatNumber * 7) % 9) * 0.2;
  const delay = -((seatNumber * 13) % 40) * 0.1;

  return {
    ['--sp-breath-dur' as string]: `${duration.toFixed(2)}s`,
    ['--sp-breath-delay' as string]: `${delay.toFixed(2)}s`,
    /* --sp-holo-delay is no longer an idle phase. Since Dan 2026-09-02 the
       shine is an on-the-clock cue set on the acting seat's avatar element
       (see holoOnClockDelayMs in the render), not ambient life spread round
       the table. */
  };
}

/** The shine waits this long on the clock before its first sweep (Dan 2026-09-02). */
const HOLO_ON_CLOCK_MS = 3_000;

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
  /* 'discard' is DELIBERATELY absent, and this note is here so nobody adds it
     by pattern-matching. The library is push / check / fold / celebrate / lose
     / alert, and none of them means "throws one card away and keeps playing".
     `fold` is the tempting one and it is the worst: it is the slump that tells
     the whole table a hand has DIED, played over a player who is still in the
     pot - which is precisely the confusion Dan reported ("auto folded my hand,
     even though it didn't"). The discard already has its own card animation
     and its own cue; a wrong gesture would subtract from it, not add. If a
     real throw-away gesture is ever rigged, wire it here.
     Pinned in tests/animations-always-play.law.test.ts. */
};

/** Celebration window — must outlast spAvatarCelebrate (900ms) by a hair. */
const CELEBRATE_MS = 940;

export interface SeatPlayer {
  id: string;
  name: string;
  avatar?: string;
  /**
   * Equipped avatar frame token (`frame-gold`, ...), from
   * `profiles.equipped_frame`. Arrives with the avatar in the engine snapshot
   * and is refreshed live by the table's profiles subscription. Undefined or an
   * unknown token draws nothing.
   */
  frame?: string;
  /** Equipped avatar aura token (`aura-fire`, ...), from `profiles.equipped_aura`. */
  aura?: string;
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
  /**
   * SHOWDOWN AUDIT 2026-08-25: the engine's muck ruling as carried by the
   * snapshot (is_mucked). The parent unions it with the showdown event's
   * mask so a client that reconnects mid-showdown — and therefore missed the
   * event — still renders the MUCKED label.
   */
  isMucked?: boolean;
}

export interface SeatSlotProps {
  /**
   * `table_seats.sit_out_at` in epoch ms, and ONLY when a deadline applies.
   *
   * A SEPARATE PROP, not a field on `player` — that was the first attempt and it
   * did not work. `mapEngineSnapshot` builds a BRAND NEW player object on every
   * engine broadcast, from a fixed list of nine fields, so anything else written
   * onto a player is erased at the next frame. The stamp would appear on the
   * 10-second poll and vanish on the next hand, forever.
   *
   * The parent withholds it on tournament tables, where a player may sit out as
   * long as they like — which keeps this component's standing rule intact:
   * nothing in here may branch a visual on tournament-ness. A stamp means a
   * clock; no stamp means the plain tag.
   */
  sitOutAt?: number | null;
  seatNumber: number;
  player: SeatPlayer | null;
  position: PositionBadge;
  /**
   * KILL POTS (rule manifest kill-v1): the marker on the killer's seat for the
   * whole kill hand ("Kill Blind"), drawn opposite the position badge so a
   * killer who is also a blind keeps both. Null on every other seat and hand.
   */
  killMarker?: string | null;
  isActive: boolean;
  lastAction: LastAction;
  lastBetAmount?: number;
  /**
   * 0-100 (100 = full time, 0 = out of time).
   *
   * PERF 2026-08-25: TablePage no longer passes this. Handing the acting seat's
   * countdown DOWN as a prop is what forced the page to hold the countdown in
   * its own state and re-render — page, nine seats, board, pot, HUD — once a
   * second for the whole of anybody's turn. The seat subscribes to `actionClock`
   * itself now, and only while it is the seat actually on the clock.
   *
   * Still honoured when supplied, so a harness that has a number and no store
   * (SimPage) keeps working unchanged. An explicit prop wins over the store.
   */
  timerProgress?: number;
  /**
   * The table's action clock. Supplied by TablePage; absent everywhere else, in
   * which case the seat subscribes to an idle store that never publishes and the
   * two props above are the only source, exactly as before.
   */
  actionClock?: ActionClockStore;
  bigBlind?: number;
  isTournament?: boolean;
  bountyValue?: number;
  /**
   * THE GRID THE BOUNTY IS PAID ON (2026-09-20).
   *
   * The badge below printed `toLocaleString` with two places whenever the head
   * carried cents, which is the CHIP contract and is right for a chip table.
   * A Diamond bounty has no cents to print: the bank it is paid from holds
   * whole Diamonds, so a decimal point here advertises a payment that cannot
   * be made. TablePage passes `arenaAssetUnitCents(tableState.arenaAsset)`.
   *
   * Absent means the table's arena has not been read yet, which is the same
   * answer as a chip table and is stated as `UNIT_CENTS_ASSET_NOT_READ` at the
   * call rather than defaulted here.
   */
  bountyUnitCents?: number;
  /*
   * `bombPotAnte` — REMOVED 2026-09-04. It hung a magenta "BOMB" pill under
   * every live seat for the length of a bomb-pot hand. Dan: "THERE SHOULDN'T
   * BE 'BOMB POT PILL BUTTONS' UNDER THE PLAYERS. THERE SHOULD JUST BE
   * SOMETHING ON THE TABLE THAT SAYS 'BOMB POT'." The one marker is now the
   * on-felt pill (`.bomb-pot-live`, TablePage.tsx), which reads
   * "BOMB POT" for the hand itself. Do not add a per-seat bomb marker back.
   */
  isWinner?: boolean;
  winningHandName?: string; // e.g. "Straight", "Full House"
  /**
   * SHOWDOWN SYSTEM 2026-08-25 (spec section 15): indices of THIS winner's
   * own hole cards that participate in the winning five-card hand, from the
   * engine's pot_win payload. When present, only those cards highlight;
   * when absent, the whole hand highlights (previous behaviour, and the
   * right fallback for older engine payloads).
   */
  winningHoleCardIndexes?: readonly number[];
  /**
   * POKERBROS PARITY 2026-08-26 (frame-by-frame of the reference recording):
   * true while ANY seat's winning hand is being displayed table-wide. While
   * true, every face-up hole card at this seat that is not part of the
   * winning five dims to ~50% brightness — a losing shown hand dims
   * entirely, and the winner's own unused cards dim around the lit ones.
   * Card backs never dim. TablePage derives it from winnerInfo.
   */
  winnerDisplayActive?: boolean;
  /**
   * SHOWDOWN SYSTEM 2026-08-25 (spec section 4): the ENGINE ruled this hand
   * muckable at showdown — its cards were never revealed, and the seat
   * renders a MUCKED label instead. Distinct from isMucking, which is the
   * fly-to-muck animation for cards that WERE revealed and lost.
   */
  isMuckedShowdown?: boolean;
  /**
   * SHOWDOWN SYSTEM 2026-08-25 (spec section 3): how long to hold this
   * seat's showdown reveal so the flips play in reveal order — the
   * final-street aggressor first, then clockwise. 0 = flip immediately.
   */
  showdownRevealDelayMs?: number;
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
  /**
   * Actual seconds remaining, for the disconnected-player countdown overlay.
   * Same story as `timerProgress`: TablePage stopped passing it on 2026-08-25
   * and the seat reads the store instead. An explicit prop still wins.
   */
  secondsLeft?: number;
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
  /**
   * CRAZY PINEAPPLE PHASE 3 2026-08-31 - the card this seat just discarded,
   * for the ghost that flies to the muck.
   *
   * HERO ONLY, and it never crosses the wire. In Crazy Pineapple the discarded
   * card is never revealed to opponents - not on the discard, not at showdown -
   * and hole cards on this platform do not travel on the public broadcast at
   * all: they go through the RLS-protected `table_hole_cards` table, which
   * exists because of a god-mode vulnerability (migration
   * 20260312_secure_hole_cards_fix.sql). The public `player_action` event
   * carries a seat and the word 'discard' and NOTHING card-shaped, so a
   * villain's ghost is drawn face DOWN from that event alone. The hero's own
   * card is already in their own client, and they are the one who chose it.
   *
   * Null or undefined = draw a back, which is the correct treatment for every
   * seat that is not the hero.
   */
  discardFlightCard?: Card | null;
  /**
   * Is there a HAND at this table right now?
   *
   * Dan 2026-08-28, on a Spin still selling its third seat: the two players
   * who had bought seats were each drawn holding a fan of face-down cards,
   * before a single card had been dealt — a table that looks mid-hand while
   * it is plainly waiting for a player. The villain fan below renders for any
   * seat whose status is 'active', which every seated player is from the
   * moment they sit, so the cards were furniture rather than a hand.
   *
   * Defaults TRUE so a caller that does not pass it keeps today's behaviour
   * exactly. The gate is deliberately permissive — holeCards present, a deal
   * animating, a fold or muck flying out all still draw regardless — so no
   * animation the law protects can be suppressed by it. It removes exactly
   * one thing: backs drawn for a hand that does not exist.
   */
  handInPlay?: boolean;
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
   * Hero has PRESSED time bank but the engine has not spent it yet.
   *
   * Dan 2026-08-24: "when you use a time bank, it gives you this generic pop
   * up, instead of resetting the countdown clock on the hero's box." Pressing
   * with ordinary clock left ARMS the bank rather than spending it (deliberate
   * — Dan 2026-08-23, "it should not take a time bank or add more time until
   * you have truly used your entire 15 seconds"), so there is genuinely no new
   * time to draw yet and the ring must NOT restart. The feedback belonged on
   * the seat all the same; a toast was the whole of it.
   *
   * This paints the pending state on the hero's own box. When the engine
   * redeems the bank at expiry it re-stamps `turnStartTimeMs`, which remounts
   * this node and restarts the ring for real.
   */
  timeBankArmed?: boolean;
  isTimeBankActive?: boolean;
  /**
   * Dan 2026-08-18: "a user should be able to click on any card in their hand,
   * and when clicked that card or cards always get shown after the hand is
   * over." Indexes of the hero's own hole cards currently marked to be shown.
   */
  showPickedCardIndexes?: readonly number[];
  /** Toggle one of the hero's cards in/out of the show-after-hand selection. */
  onToggleShowCard?: (cardIndex: number) => void;
  /**
   * WHY A NEW CASH ENTRANT IS NOT PLAYING YET (Dan 2026-09-23). The engine
   * flags every player it is holding for the big blind as sitting out, and the
   * seat printed SITTING OUT over all of them. "IT SHOULDN'T SAY 'SITTING OUT'
   * IF YOU AGREED TO 'POST THE BIG BLIND'. IT ALSO SHOULDN'T SAY 'SITTING OUT'
   * IF THEY ARE WAITING FOR BB, IT SHOULD SAY 'WAITING FOR BB'."
   *
   *   'waiting_for_bb'  held by the engine until the big blind reaches them,
   *                     and they have not asked to post: the badge says so.
   *   'posting_bb'      held, and they agreed to post: nothing is wrong with
   *                     this seat and no badge is drawn.
   *   null / undefined  not an entry hold - a sat-out seat is sat out.
   *
   * Decided by the parent from the engine's waiting_for_bb_user_ids and
   * post_bb_deferred_user_ids, the same two lists the hero's footer reads.
   */
  entryWait?: 'waiting_for_bb' | 'posting_bb' | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

// Dan 2026-08-28: a stack on the felt is never abbreviated. This used to
// render 117000 as "117K", which is a range 500 chips wide standing in for a
// number the player is about to act on. One formatter, shared with every
// other chip surface on the table.
function formatStack(amount: number): string {
  // Whole chips from 100 up (engine sub-chip noise is rake and split
  // artifacts, not chips anyone can bet); to the penny below it, always two
  // places (Dan 2026-09-04). The rule lives in utils/format so every stack on
  // the table agrees; the stack-delta float and the net-win line are wagers
  // and read through formatWager instead (item 9, 2026-09-23).
  return formatStackChips(amount);
}

// Dan 2026-08-28: the same rule as chips. A 1,500 BB stack read "1.5K BB",
// which is the abbreviation complaint wearing a different unit. Deep counts
// stay whole and separated; shallow ones keep the one decimal that decides
// whether you are shoving.
function formatStackAsBB(stack: number, bigBlind: number): string {
  if (bigBlind <= 0) return '0 BB';
  const bb = stack / bigBlind;
  if (bb >= 100) return `${Math.round(bb).toLocaleString('en-US')} BB`;
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

/**
 * A BET IS NOT A STACK (Dan 2026-09-23: '"RAISE 4.00" SHOULD BE "RAISE 4". NO
 * DECIMAL POINTS FOR WHOLE NUMBERS'). The badge read through formatStack,
 * whose under-100 penny rule is Dan's STACK rule (2026-09-04: a 5.37 stack
 * reads 5.37, a 5 stack reads 5.00 so the seats line up). A wager has never
 * had that rule: it is formatTableChips - integers clean, a real fraction
 * kept - which is what the pot pill, the chip label in flight and the
 * action bar's own buttons already print. One contract for one number.
 */
function formatWager(amount: number): string {
  return formatTableChips(amount);
}

function getActionLabel(action: LastAction, amount?: number): string {
  switch (action) {
    case 'fold':
      return 'Fold';
    case 'check':
      return 'Check';
    case 'call':
      return amount ? `Call ${formatWager(amount)}` : 'Call';
    case 'bet':
      return amount ? `Bet ${formatWager(amount)}` : 'Bet';
    case 'raise':
      return amount ? `Raise ${formatWager(amount)}` : 'Raise';
    case 'all_in':
      return 'ALL IN';
    case 'discard':
      /* CLAUDE.md 5.7: Title Case Every Word. */
      return 'Discard';
    default:
      return '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HOLE CARDS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * THE VILLAIN CLUSTER TUNING — Dan 2026-08-26, corrected same day against the
 * PokerBros close-ups: "THE FANNING WAS ONLY EVER SUPPOSED TO BE DONE FOR THE
 * HERO'S SEAT." A villain's face-down hand is a SMALL rotational cluster —
 * card size fixed at ~0.52 x avatar in CSS — and these two numbers are the
 * ONLY thing that changes with card count:
 *
 *   step  horizontal slide per card, as a fraction of card width. A pair
 *         sits side-by-side (0.42); bigger hands nest their bottoms tighter
 *         because the ROTATION is what separates them.
 *   rot   degrees of splay per card, pivoting about a point below the card's
 *         bottom edge, symmetric around the cluster centre. 7deg keeps a
 *         hold'em pair nearly parallel like the reference; 12deg gives 4-6
 *         cards the full rosette.
 *
 * Applied as CSS custom properties on the cluster container (never as inline
 * pixel values), so the geometry stays inspectable in devtools and the
 * responsive system retunes it through --seat-avatar-size alone.
 *
 * 3 is not a live variant; it falls between 2 and 4 so a malformed count
 * clamped into the sane band still renders sensibly.
 */
const VILLAIN_FAN: Record<number, { step: number; rot: number }> = {
  /* Dan 2026-08-26 round 3: "more tightly compacted together, not so spread
     out" — the slide per card came down across the board; the rotation is
     what separates the backs, exactly like the reference crops. */
  1: { step: 0.3, rot: 0 },
  2: { step: 0.3, rot: 7 },
  3: { step: 0.18, rot: 10 },
  4: { step: 0.14, rot: 12 },
  5: { step: 0.13, rot: 12 },
  6: { step: 0.12, rot: 12 },
};

/**
 * One card in a seat's row.
 *
 * `index` was accepted here and never read - the body branches only on
 * hidden/card/isHero/isWinner - while every call site dutifully passed
 * `index={i}`. A parameter that is accepted and ignored is a lie in the
 * signature: the next reader assumes the card knows its own position in the
 * row (for a stagger, for a z-order, for the per-card show picker) and writes
 * code that depends on something the component never had. Removed 2026-08-25.
 * The React `key` still carries the position, which is where it belongs.
 *
 * `eager` exists because the two rows that are ALWAYS in view - the hero's own
 * hand, and a villain's cards at showdown - should not have their faces
 * deferred by the browser's lazy heuristic at the exact moment the player is
 * trying to read them. See CardImage's `loading` prop.
 */
/**
 * Dan 2026-08-30 (binding): seat names never ellipsize. If the full name does
 * not fit the plate, it is CUT AT A CHARACTER BUDGET with no "..." appended -
 * "Clara Hell..." reads worse than "Clara Hell". 11 characters is the widest
 * string that always fits the .seat__name 76px cap at --font-xs; the CSS
 * keeps overflow:hidden as a belt, but with text-overflow: clip so the
 * ellipsis can never come back through styling alone.
 */
function limitSeatName(name: string | undefined | null): string {
  const n = (name ?? '').trim();
  return n.length > 11 ? n.slice(0, 11).trimEnd() : n;
}

function HoleCard({
  card,
  hidden = false,
  isHero = false,
  isWinner = false,
  isDimmed = false,
  deckStyle,
  cardBack = 'classic_blue',
  eager = false,
  fanIndex,
  discardFlight = false,
}: {
  card?: Card | null;
  hidden?: boolean;
  isHero?: boolean;
  isWinner?: boolean;
  /**
   * POKERBROS PARITY 2026-08-26 (frame-by-frame of the reference recording):
   * while the winning five are lit, every face-up card that is NOT one of
   * them — the winner's own unused cards included — drops to ~50% brightness
   * in the same beat the gold borders appear. Never applied to card backs.
   */
  isDimmed?: boolean;
  deckStyle?: '4color' | '2color';
  cardBack?: string;
  eager?: boolean;
  /**
   * VILLAIN FAN 2026-08-26: this card's position in the fan, innermost
   * (nearest the avatar) = 0. Handed to CSS as `--vh-i`, from which the
   * stylesheet derives the card's offset, its rotation and its z-order —
   * an index, not a pixel value, so the geometry itself stays in CSS.
   * Undefined for hero cards, whose row derives its index via nth-child.
   */
  fanIndex?: number;
  /**
   * CRAZY PINEAPPLE PHASE 3 2026-08-31: this card is the one being thrown, and
   * is drawn only for as long as it takes to reach the muck. It is a GHOST -
   * the hand it came from has already lost it (hero's row shrank the instant
   * the engine accepted; a villain's back count dropped on the public event) -
   * so it must never be counted, clicked or read as part of the holding.
   * `seat__card--discarding` in SeatSlot.css carries the flight.
   */
  discardFlight?: boolean;
}) {
  const size = isHero ? 'md' : 'sm';
  const fanStyle =
    fanIndex !== undefined ? ({ '--vh-i': fanIndex } as React.CSSProperties) : undefined;
  const flightClass = discardFlight ? ' seat__card--discarding' : '';

  if (hidden || !card) {
    return (
      <div
        className={`seat__card seat__card--back${flightClass}`}
        style={fanStyle}
        aria-hidden={discardFlight || undefined}
      >
        <CardBack size={size} style={cardBack} />
      </div>
    );
  }
  return (
    <div
      className={`seat__card seat__card--face${isWinner ? ' seat__card--winner' : ''}${isDimmed ? ' seat__card--dimmed' : ''}${flightClass}`}
      style={fanStyle}
      aria-hidden={discardFlight || undefined}
    >
      <CardImage
        card={card}
        deckStyle={deckStyle}
        size={size}
        isHighlighted={isWinner}
        loading={eager ? 'eager' : 'lazy'}
      />
    </div>
  );
}

/**
 * Where this seat sits on the table, as percentages of the table's own box.
 *
 * A seat is handed its NUMBER and nothing else — the ring, the rotation and the
 * table size all live in the parent — so the only place the seat's own position
 * still exists by the time it renders is on the element the parent wrapped it
 * in: TablePage sets `left: ${pos.x}%` and `top: ${pos.y}%` inline on
 * `.seat-wrapper`. Reading those strings back is exact, costs no layout, and is
 * scale-invariant, which is why it is tried first.
 *
 * The offset fallback covers any host that positions the wrapper some other way
 * (SimPage mounts SeatSlot outside the table page entirely). It is a
 * layout-forcing read, so the caller runs it only when the cheap path found
 * nothing AND the wrapper has actually moved since the last look.
 *
 * NaN, deliberately, when neither works: `seatCardSide` then answers 'right',
 * which is where every seat's cards hung before any of this existed.
 */
function seatWrapperPercent(wrap: HTMLElement): { x: number; y: number } {
  const inlineX = /^\s*([\d.]+)%\s*$/.exec(wrap.style.left || '');
  const inlineY = /^\s*([\d.]+)%\s*$/.exec(wrap.style.top || '');
  if (inlineX && inlineY) return { x: Number(inlineX[1]), y: Number(inlineY[1]) };
  const host = wrap.offsetParent as HTMLElement | null;
  if (!host || !host.offsetWidth || !host.offsetHeight) return { x: NaN, y: NaN };
  return {
    x: (wrap.offsetLeft / host.offsetWidth) * 100,
    y: (wrap.offsetTop / host.offsetHeight) * 100,
  };
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
      killMarker = null,
      isActive,
      lastAction,
      lastBetAmount,
      timerProgress: timerProgressProp,
      actionClock,
      bigBlind = 2,
      // isTournament is deliberately NOT destructured any more. Nothing inside
      // this component may branch a VISUAL on tournament-ness: doing so is what
      // gave a Spin an inert empty seat and a stack that would not warn at 8bb.
      // The prop stays on the interface because the memo comparator below still
      // needs to see it change (it feeds SeatSlot's parents), and because
      // removing it from every call site is a bigger change than it is worth.
      sitOutAt,
      entryWait = null,
      bountyValue,
      bountyUnitCents,
      isWinner = false,
      netWinAmount,
      bbjCreditAmount,
      winningHandName,
      handStrength,
      hudStats,
      showHUD = false,
      playerStyle,
      secondsLeft: secondsLeftProp,
      deckStyle,
      cardBack = 'classic_blue',
      holeCardCount = 2,
      discardFlightCard = null,
      handInPlay = true,
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
      winningHoleCardIndexes,
      winnerDisplayActive = false,
      isMuckedShowdown = false,
      showdownRevealDelayMs = 0,
      cardSqueezeActive = false,
      handNumber = 0,
      playSounds = true,
      turnDeadlineMs,
      turnStartTimeMs,
      timeBankArmed,
      isTimeBankActive,
      showPickedCardIndexes,
      onToggleShowCard,
    } = props;

    /**
     * THE CALLBACKS, ALWAYS THE LATEST ONES (audit 2026-08-25).
     *
     * `onSit`, `onAction` and `onAvatarClick` are the three props this seat
     * accepts that the memo comparator below deliberately does NOT compare, and
     * that is the right call: TablePage builds all three as inline arrows
     * (`onSit={() => handleSeatClick(seatNumber)}`), so comparing them would be
     * comparing a brand-new function every render and the memo would never skip
     * anything - nine seats times up to four mounted tables, re-rendering on
     * every parent tick.
     *
     * The cost of not comparing them is that the seat keeps whichever closure
     * it last rendered with, and those closures capture live table state:
     * `handleSeatClick` reads `pendingSeat` and the roster to decide whether the
     * hero may sit, and the avatar handler captures `player` to target notes and
     * throwables. A seat that has nothing else changing about it - which is
     * exactly an EMPTY seat, the one `onSit` belongs to - can sit on a stale
     * closure indefinitely and act on a table that has moved on.
     *
     * A ref costs nothing and removes the trade entirely: the memo still skips
     * the render, and the handler that eventually fires is the current one.
     * Assigned during render rather than in an effect on purpose - the value has
     * to be correct for a click that lands before React commits, and there is
     * nothing to clean up.
     */
    const callbacksRef = useRef({ onSit, onAction, onAvatarClick });
    callbacksRef.current = { onSit, onAction, onAvatarClick };

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
     * PERF 2026-08-25 — THE COUNTDOWN COMES IN SIDEWAYS, NOT FROM ABOVE.
     *
     * These two values used to arrive as props from TablePage, which meant
     * TablePage had to hold the countdown in state and re-render the entire
     * table once a second for the whole of anybody's turn to deliver them.
     *
     * The seat subscribes to the store directly instead. `isActingNow` gates the
     * subscription, so the eight seats that are NOT on the clock read
     * `undefined` on every publication, React compares it with `Object.is`, and
     * they do not render at all. Only the acting seat wakes — which is the only
     * seat that has ever done anything with either number.
     *
     * An explicitly supplied prop still wins, so SimPage and any other harness
     * that passes a number and no store behaves exactly as it did.
     *
     * NOTE the ring itself is not involved: it has been a pure-CSS animation off
     * the engine's absolute deadline (`--sp-timer-duration` / `--sp-timer-delay`
     * below) since 2026-04-15 and no React render has ever driven it.
     */
    const liveTimerProgress = useActionClockProgress(
      actionClock,
      isActingNow && timerProgressProp === undefined
    );
    /* `secondsLeft` has exactly one reader — the DISCONNECTED overlay's
       countdown — so the subscription is gated on that state as well. The old
       prop arrived whenever this seat was the current one, and was then ignored
       for every seat that was not disconnected; subscribing on the same terms it
       is read on means an ordinary acting seat is not woken once a second for a
       number it will not render. `isActive` rather than `isActingNow`, to keep
       the condition identical to the prop it replaces. */
    const liveSecondsLeft = useActionClockSeconds(
      actionClock,
      isActive && player?.status === 'disconnected' && secondsLeftProp === undefined
    );
    const timerProgress = timerProgressProp ?? liveTimerProgress;
    const secondsLeft = secondsLeftProp ?? liveSecondsLeft;

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
     *
     * ── EACH CARD CARRIES ITS OWN INDEX, AND THAT IS NOT COSMETIC ───────────
     * Dan 2026-08-27 asked that shown hands be "highlighted at showdown". They
     * were - on the wrong cards, whenever the sort moved anything.
     *
     * This used to return a bare `Card[]` and the row rendered it with
     * `.map((card, i) =>  ... winningHoleCardIndexes.includes(i))`. But `i` is
     * the position in the SORTED row, while `winningHoleCardIndexes` arrives
     * from the engine (`hole_card_indices` on the pot_win event) indexed
     * against the DEALT order - the array this function is about to reorder. A
     * villain dealt `6h As 9c Ad` renders as `As Ad 9c 6h`, so a winning index
     * of 1 lit the ace of diamonds when the engine meant the ace of spades, and
     * `--dimmed` darkened the wrong card in the same beat. The sort landed on
     * 2026-08-23 and the highlight on 2026-08-25; each was right on its own.
     *
     * Pairing the card with the index it had BEFORE the sort makes the two
     * orders explicit, so the row can be drawn in reading order while every
     * per-card flag is still asked about the right card.
     */
    const displayHoleCards = useMemo(
      () => displayOrderWithDealtIndex(player?.holeCards),
      [player?.holeCards]
    );

    /**
     * WHICH SIDE THIS SEAT'S CARDS HANG OFF — see `seatCardSide` in
     * lib/tableSeatGeometry.ts for the rule itself (outboard at the top cap,
     * inboard everywhere else) and for why it is derived from position rather
     * than from a seat index.
     *
     * Measured rather than passed as a prop: adding one would mean editing
     * TablePage, which several other workstreams are in at once, and the seat
     * can recover its own position from the wrapper the parent already
     * positions it with.
     *
     * ── Dan 2026-08-25 round 2: WHY THE TOP SEATS BOTH SHOWED CARDS ON THE
     *    LEFT, and why the wrapper is OBSERVED rather than re-read on render ──
     *
     * The measurement itself was fine. WHEN it ran was not: the dependency list
     * was `[seatNumber, hasPlayer]`, and NEITHER of those changes when the seat
     * MOVES. A seat moves constantly — `rotateSeatsForHero` re-assigns every
     * chair's position the moment the hero's seat is known, and the ring itself
     * is swapped when `maxPlayers` arrives from the table row after the first
     * paint. Both rewrite the inline `left` on the wrapper while seatNumber and
     * hasPlayer sit still, so the side stayed whatever the pre-rotation layout
     * happened to say — which for the two top seats was the same answer for
     * both of them. It was never falling through to the NaN default; it was
     * answering a question about where the seat USED to be.
     *
     * Widening the dependency list would not fix it either, because a pure
     * rotation need not re-render this seat at all: the wrapper's `style` moves
     * while SeatSlot's own props stand still, and the memo comparator below
     * correctly skips the render. So the position is watched at its source —
     * one MutationObserver on the one attribute that carries it. That is true
     * for every host and every reason the seat might move, including ones that
     * do not exist yet, and it costs nothing while the seat is not moving.
     *
     * The string compare in `read` is the cheap guard: `style.left`/`style.top`
     * are property reads on an element already in hand, with no layout flush,
     * and they are exact. Only when the pair has actually changed do we parse —
     * and only then can the offset fallback, which DOES force layout, run.
     *
     * `useLayoutEffect` so the first measurement lands in the same paint as the
     * markup it measured; with a plain effect the seat shows one frame of cards
     * on the default side before correcting itself.
     */
    const seatRef = useRef<HTMLDivElement | null>(null);
    const [cardSide, setCardSide] = useState<CardSide>('right');
    const hasPlayer = !!player;
    useLayoutEffect(() => {
      // The wrapper is only in the DOM on the occupied branch (the empty-seat
      // branches return before the ref is attached), so gaining or losing an
      // occupant is what re-arms this.
      const wrap = seatRef.current?.parentElement;
      if (!wrap) return;
      let lastStamp: string | null = null;
      const read = () => {
        const stamp = `${wrap.style.left}|${wrap.style.top}`;
        if (stamp === lastStamp) return;
        lastStamp = stamp;
        const { x, y } = seatWrapperPercent(wrap);
        setCardSide(seatCardSide(x, y));
      };
      read();
      const moved = new MutationObserver(read);
      moved.observe(wrap, { attributes: true, attributeFilter: ['style'] });
      return () => moved.disconnect();
    }, [hasPlayer]);

    /**
     * Animated stack change — flash green/red when the stack moves.
     *
     * AUDIT 2026-08-25: the effect keyed on `player?.stack` ALONE while its
     * "have we seen this player before" latch only reset when the seat rendered
     * EMPTY. A seat does not always pass through empty: one snapshot can carry
     * player A leaving and player B arriving in the same chair, and the seat
     * then renders straight from A to B. The effect saw a stack change, found
     * the latch still armed, and floated `B.stack - A.stack` over the new
     * arrival - a green +4,000 or a red -900 on a player who had done nothing.
     * Comparing the OCCUPANT as well makes a change of player what it actually
     * is: a fresh sit-down, which never animates.
     */
    const [stackDelta, setStackDelta] = useState<number>(0);
    const prevStackRef = React.useRef<number>(player?.stack ?? 0);
    const seatedIdRef = React.useRef<string | null>(player?.id ?? null);
    const playerId = player?.id ?? null;
    useEffect(() => {
      if (!player) {
        seatedIdRef.current = null; // Player left — reset for next occupant
        return;
      }
      const sameOccupant = seatedIdRef.current === player.id;
      const diff = player.stack - prevStackRef.current;
      prevStackRef.current = player.stack;
      seatedIdRef.current = player.id;
      // Only animate for a player who was already sitting here.
      if (diff !== 0 && sameOccupant) {
        setStackDelta(diff);
        /* 2026-08-28: scaled, because the keyframe is. `stackDeltaFloat` became
           `calc(2s * var(--animation-speed, 1))` in SeatSlot.css and this window
           stayed at a flat 2000ms, so the two disagreed the moment a player
           changed animation speed — and --animation-speed is a DURATION
           multiplier that runs up to 3 (see utils/animationSpeed.ts), so on the
           "slow" setting the float ran six seconds while React unmounted the
           node after two. The +/- indicator simply vanished a third of the way
           through its own animation, on the setting chosen by the players most
           likely to want to read it.

           Same +50ms cushion as the all-in shake below: an exact tie races the
           final frame at speed 1. Overshooting is harmless — the keyframe ends
           at opacity 0 with `forwards`, so the extra moments are invisible. */
        const t = setTimeout(() => setStackDelta(0), 2000 * getAnimationSpeed() + 50);
        return () => clearTimeout(t);
      }
      // A new occupant must not inherit the last one's floating delta.
      if (!sameOccupant) setStackDelta(0);
    }, [player?.stack, playerId]);

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

    /* Dan 2026-08-26 mobile pass, item 10: how much of the turn had already
       elapsed when THIS CLIENT first painted the turn. The engine stamps
       turn_start_time_ms when it arms the timer, which is broadcast-latency
       plus the deal hold BEFORE the seat can render the ring — so the ring
       used to mount already part-drained and visibly emptied in fewer than 15
       seconds. Anchoring the animation at first paint makes the ring start
       FULL and reach empty exactly at the engine's deadline (the fold /
       time-bank moment), which is what "it must take 15 full seconds to
       disappear" means on a screen that cannot see the packet in flight.
       Keyed by the turn's start stamp so re-renders mid-turn reuse the same
       anchor instead of re-anchoring (which would freeze the ring). */
    const turnPaintAnchorRef = useRef<{
      key: number;
      baseElapsedMs: number;
      /** Time left until 3s on the clock, frozen at this client's first paint of the turn. */
      holoDelayMs: number;
    } | null>(null);
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
        // 2026-08-27: +50ms cushion — the keyframe now scales with
        // --animation-speed (SeatSlot.css), and an exact tie races the last
        // frame at speed 1.
        const timer = setTimeout(() => setAllinShake(false), 400 * getAnimationSpeed() + 50);
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
     * CRAZY PINEAPPLE PHASE 3 2026-08-31 - one card leaves the hand.
     *
     * Deliberately its own effect, its own ref and its own timer, for the same
     * reason the avatar choreography below is: the all-in/fold effect above
     * early-returns per branch to scope its cleanup to a single timer, so a
     * third branch added there would be unreachable (all_in and fold both
     * return first) or would silently change which timeout gets cleaned up.
     *
     * Fired off `lastAction` and NOTHING else, which is what makes a horse's
     * discard identical to a human's (CLAUDE.md §10.5): both arrive as the
     * same PLAYER_ACTION event, on the same code path, at the horse's own
     * humanlike delay. There is no `is_horse` anywhere near this.
     *
     * The window outlasts the CSS the way the fold's does - cardDiscardOut is
     * 420ms and this is 500ms, both scaled by --animation-speed, so the ghost
     * is never unmounted mid-flight at any speed setting (ANIMATION AUDIT
     * 2026-08-19 found exactly that bug on the fold).
     *
     * NOT marked data-motion="keep", and that is deliberate: the length of
     * this animation carries no information. What it MEANS - a card left this
     * hand - is carried by its final frame and by the row that is now one card
     * shorter, both of which reduced motion preserves (reducedMotion.css
     * collapses to 1ms rather than `animation: none` precisely so `forwards`
     * animations still land). Motion collapses; the meaning does not.
     */
    const [discardFlight, setDiscardFlight] = useState(false);
    const prevDiscardActionRef = React.useRef<LastAction>(null);
    /* AUDIT 2026-08-31: belt to the engine's braces. The trigger is now durable
       (HandController records the discard on state.actionHistory, so a snapshot
       re-asserts it instead of erasing it), but a seat discards exactly ONCE
       per hand, so a second flight is never correct however lastAction gets
       there. This makes a fall-then-rise from any source - a dropped snapshot,
       a resync, a re-mount - unable to throw the same card twice. */
    const inFlightRef = React.useRef(false);
    useEffect(() => {
      const rising = lastAction === 'discard' && prevDiscardActionRef.current !== 'discard';
      prevDiscardActionRef.current = lastAction;
      if (!rising || inFlightRef.current) return;
      inFlightRef.current = true;
      setDiscardFlight(true);
      const timer = setTimeout(() => {
        inFlightRef.current = false;
        setDiscardFlight(false);
      }, 500 * getAnimationSpeed());
      return () => {
        clearTimeout(timer);
        inFlightRef.current = false;
      };
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
    // SHOWDOWN SYSTEM 2026-08-25 (spec section 3): while true, the seat keeps
    // rendering card BACKS even though the snapshot has already revealed the
    // hand — this is what turns the simultaneous broadcast reveal into a
    // sequence. The hold expires after showdownRevealDelayMs (reveal order x
    // stagger), then the flip plays exactly as before.
    const [revealHeld, setRevealHeld] = useState(false);
    const prevShowCardsRef = React.useRef<boolean>(player?.showCards ?? false);
    // ANIMATION AUDIT 2026-08-27: the old effect kept its timers in effect
    // scope and CANCELLED them in cleanup — but showdownRevealDelayMs is
    // recomputed when SHOWDOWN_CARDS_REVEALED reconciles the reveal order
    // mid-hold, and that dep change re-ran the effect: cleanup killed the
    // hold timer, and because prevShowCardsRef was already latched true the
    // rising-edge guard refused to reschedule — NO flip played and the cards
    // snapped face-up. Timers now live in component-scope refs, survive dep
    // changes, and are torn down only on unmount or when the cards go back
    // face-down (new hand). Once a hold is pending it is never cancelled by
    // a reorder — the first-scheduled stagger plays out.
    const flipPlayedRef = React.useRef(false);
    const flipHoldTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const flipEndTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
      () => () => {
        if (flipHoldTimerRef.current) clearTimeout(flipHoldTimerRef.current);
        if (flipEndTimerRef.current) clearTimeout(flipEndTimerRef.current);
      },
      []
    );
    useEffect(() => {
      if (!player) return;
      const showing = !!player.showCards;
      if (!showing) {
        // Cards hidden again (new hand) — re-arm for the next reveal.
        prevShowCardsRef.current = false;
        flipPlayedRef.current = false;
        if (flipHoldTimerRef.current) {
          clearTimeout(flipHoldTimerRef.current);
          flipHoldTimerRef.current = null;
        }
        if (flipEndTimerRef.current) {
          clearTimeout(flipEndTimerRef.current);
          flipEndTimerRef.current = null;
        }
        setRevealHeld(false);
        return;
      }
      // Already played, or a hold is pending — let it run.
      if (flipPlayedRef.current || flipHoldTimerRef.current) {
        prevShowCardsRef.current = true;
        return;
      }
      prevShowCardsRef.current = true;
      const beginFlip = () => {
        flipHoldTimerRef.current = null;
        flipPlayedRef.current = true;
        setRevealHeld(false);
        setIsShowdownFlip(true);
        // ANIMATION AUDIT 2026-08-19: was 400ms, but card 2 runs 120ms delay
        // + 350ms flip = 470ms — it snapped face-up at 85%. 600ms covers it.
        flipEndTimerRef.current = setTimeout(() => {
          setIsShowdownFlip(false);
          flipEndTimerRef.current = null;
        }, 600 * getAnimationSpeed());
      };
      const holdMs = Math.max(0, showdownRevealDelayMs) * getAnimationSpeed();
      if (holdMs > 0) {
        setRevealHeld(true);
        flipHoldTimerRef.current = setTimeout(beginFlip, holdMs);
      } else {
        beginFlip();
      }
    }, [player?.showCards, showdownRevealDelayMs]);

    // ── CARD SLIDE (corner peel) ─────────────────────────────────────────────
    // COMPETITOR-PARITY 2026-08-19 built this as a hinge: the whole back
    // rotated up from its top edge by a drag-up distance. Dan 2026-09-04:
    // "THE CORNERS OF THE CARDS SHOULD BE 'PEELED BACK' LIKE YOUR LOOKING AT
    // THEM AT A REAL POKER TABLE ... NOT JUST CLICK TO REVEAL, IT NEEDS TO
    // FEEL AND ACT LIKE THE USER IS ACTUALLY TOUCHING THE SCREEN AND LIFTING
    // THE CARDS OFF THE FELT."
    //
    // So it is a PEEL now. The finger pinches whichever corner it lands
    // nearest and drags it anywhere; the back folds along the perpendicular
    // bisector of that drag (cardPeel.ts) with the pinched corner always under
    // the finger, the face shows through where the back was lifted, and the
    // whole hand rises off the felt as the peel deepens. Both hero cards peel
    // together, as a squeezed pair does. Release short of the threshold and
    // the corner springs back down; past it the peel flies open and the hand
    // latches revealed for the rest of the hand.
    //
    // PERFORMANCE: none of this goes through React state. A pointer move
    // computes one PeelFrame and writes CSS custom properties on the cards
    // row inside a single requestAnimationFrame; the stylesheet does the
    // rest (clip-path, a reflection matrix, shading bands). A phone at 120Hz
    // never re-renders the seat while the finger is down.
    //
    // A tap with no movement bounces the corner to teach the gesture. There
    // is no double-tap shortcut any more (Dan: not click to reveal); the
    // keyboard path (Enter / Space) stays, because a peel is not a thing a
    // screen reader can do.
    /*
     * WHY THIS IS "WHICH HAND IS OPEN" AND NOT A BOOLEAN (Dan 2026-09-05:
     * "CARDS ARE FLASHED BEFORE YOU CAN PEEL THEM, THAT KINDA DEFEATS THE
     * PURPOSE OF THE PEEL").
     *
     * It was `useState(false)` reset by two effects keyed on `handNumber` and
     * on the hero's card count. An effect runs AFTER the render it belongs to,
     * so the first render of a NEW hand still carried the PREVIOUS hand's
     * `true`: the fresh hole cards painted FACE UP - with the hand-strength
     * label under them - and only flipped face down one commit later. Caught
     * on video, frames 4.6-5.2s: K-diamond / Q-heart, "King High", then the
     * backs.
     *
     * Storing WHICH hand is open instead makes the reset part of the render
     * rather than a consequence of it. A hand the latch does not name is face
     * down in the first painted frame, and there is no window to flash in.
     */
    const [squeezeOpenForHand, setSqueezeOpenForHand] = useState<number | null>(null);
    /**
     * Double-tap hold, the same shape and for the same reason. Dan: "OR DOUBLE
     * TAP, THAT LIFTS THEM SLIGHTLY (LIKE IN THE REAL VIDEO I SENT YOU)."
     */
    const [holdLiftForHand, setHoldLiftForHand] = useState<number | null>(null);
    const [squeezeHint, setSqueezeHint] = useState(false);
    const squeezeHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
      () => () => {
        if (squeezeHintTimerRef.current) clearTimeout(squeezeHintTimerRef.current);
      },
      []
    );
    const squeezeProgressRef = useRef(0);
    /** The cards row - where the peel's CSS variables are written. */
    const squeezeRowRef = useRef<HTMLDivElement | null>(null);
    /** The live drag, or null when no finger is down. */
    const peelRef = useRef<{
      width: number;
      height: number;
      /** Where the finger went down, in client px. */
      startY: number;
      pointerId: number;
      moved: boolean;
      lifted: boolean;
      /** How far the near edge is currently lifted, px. */
      lift: number;
    } | null>(null);
    const peelTweenRef = useRef<number | null>(null);
    const peelTweenTimerRef = useRef<number | null>(null);
    useEffect(
      () => () => {
        if (peelTweenRef.current != null) cancelAnimationFrame(peelTweenRef.current);
        if (peelTweenTimerRef.current != null) clearTimeout(peelTweenTimerRef.current);
      },
      []
    );
    /** Paint one frame of the peel onto the row. */
    const paintPeel = (frame: PeelFrame) => {
      const row = squeezeRowRef.current;
      if (!row) return;
      const st = row.style;
      st.setProperty('--peel-progress', String(frame.progress));
      st.setProperty('--peel-back-clip', frame.backClip);
      st.setProperty('--peel-face-clip', frame.faceClip);
      st.setProperty('--peel-fold', `${frame.foldPercent}%`);
      st.setProperty('--peel-bend', `${frame.bendDeg}deg`);
      squeezeProgressRef.current = frame.progress;
    };
    const clearPeelVars = () => {
      const row = squeezeRowRef.current;
      if (!row) return;
      for (const v of [
        '--peel-progress',
        '--peel-back-clip',
        '--peel-face-clip',
        '--peel-fold',
        '--peel-bend',
      ]) {
        row.style.removeProperty(v);
      }
      row.removeAttribute('data-peeling');
      squeezeProgressRef.current = 0;
    };
    /**
     * Paint the current finger position. Synchronous on purpose: browsers
     * already coalesce pointermove to one event per frame, and a paint that
     * waits for requestAnimationFrame lags a finger by a frame at best and
     * stalls entirely in a throttled tab.
     */
    const paintPeelNow = (drag: { width: number; height: number; lift: number }): number => {
      const frame = computePeel({ width: drag.width, height: drag.height, lift: drag.lift });
      paintPeel(frame);
      return frame.progress;
    };
    /**
     * Animate the pinched corner from where it is to a progress target along
     * the diagonal, then call `done`. Speed-scaled like every other motion.
     */
    const tweenPeel = (
      drag: { width: number; height: number; lift: number },
      targetProgress: number,
      ms: number,
      /* Optional: a settle back to a HELD lift has nothing to clean up, and
         passing `clearPeelVars` there would wipe the lift it just landed on. */
      done?: () => void
    ) => {
      if (peelTweenRef.current != null) cancelAnimationFrame(peelTweenRef.current);
      if (peelTweenTimerRef.current != null) clearTimeout(peelTweenTimerRef.current);
      const target = liftAtProgress(drag.height, targetProgress);
      const from = drag.lift;
      const duration = Math.max(1, ms * getAnimationSpeed());
      const t0 = performance.now();
      const at = (k: number) =>
        computePeel({ width: drag.width, height: drag.height, lift: from + (target - from) * k });
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (peelTweenRef.current != null) cancelAnimationFrame(peelTweenRef.current);
        if (peelTweenTimerRef.current != null) clearTimeout(peelTweenTimerRef.current);
        peelTweenRef.current = null;
        peelTweenTimerRef.current = null;
        paintPeel(at(1));
        done?.();
      };
      const step = (now: number) => {
        if (finished) return;
        const t = Math.min(1, (now - t0) / duration);
        if (t >= 1) {
          finish();
          return;
        }
        // ease-out cubic: a release decelerates, it does not slam.
        paintPeel(at(1 - Math.pow(1 - t, 3)));
        peelTweenRef.current = requestAnimationFrame(step);
      };
      peelTweenRef.current = requestAnimationFrame(step);
      // BACKSTOP. requestAnimationFrame is throttled to nothing in a hidden or
      // background tab, and the commit tween ends in a STATE change (the hand
      // opens). A hand that opens only if frames arrive is a hand that can
      // stay face down until the player taps again. The timer lands the
      // final frame and completes whatever rAF did not.
      peelTweenTimerRef.current = window.setTimeout(finish, duration + 80);
    };
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
    /* Derived at RENDER time, never in an effect - see the note on
       `squeezeOpenForHand`. Both conditions matter: a new hand number retires
       the latch, and so does the hand being taken away (fold, muck, stand up),
       which is the case the old card-count effect existed for. */
    const squeezeRevealed =
      squeezeOpenForHand !== null && squeezeOpenForHand === handNumber && heroCardCount > 0;
    const holdLiftActive =
      holdLiftForHand !== null && holdLiftForHand === handNumber && heroCardCount > 0;
    /**
     * ═══════════════════════════════════════════════════════════════════════
     *  THE TUTORIAL — the cards teach the gesture themselves, once
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Dan 2026-09-05: "A TUTORIAL WOULD BE COOL IF ITS ENABLED."
     *
     * A player who turns Card Slide on is shown two face-down cards and no
     * instruction. Tapping only bounces them, so the most likely first move
     * teaches nothing. The first time a face-down hand appears, the corner
     * therefore PEELS ITSELF - twice, about a third of the way, then settles -
     * under one line of text. Nothing to dismiss and nothing to read: the
     * demonstration IS the instruction.
     *
     * It runs ONCE per browser, it is cancelled the instant the player
     * touches the cards (they already understand), and it never blocks: the
     * real gesture interrupts it mid-frame and takes over.
     */
    const TUTORIAL_SEEN_KEY = 'ca_card_slide_tutorial_v1';
    /** Bumped when a hidden tab becomes visible, to re-enter the demo effect. */
    const [tutorialRetry, setTutorialRetry] = useState(0);
    const [tutorialRunning, setTutorialRunning] = useState(false);
    const tutorialRafRef = useRef<number | null>(null);
    const tutorialTimerRef = useRef<number | null>(null);
    const markTutorialSeen = () => {
      try {
        localStorage.setItem(TUTORIAL_SEEN_KEY, '1');
      } catch {
        /* private mode: the demo simply plays again next session */
      }
    };
    const stopTutorial = (seen: boolean) => {
      if (tutorialRafRef.current != null) cancelAnimationFrame(tutorialRafRef.current);
      if (tutorialTimerRef.current != null) clearTimeout(tutorialTimerRef.current);
      tutorialRafRef.current = null;
      tutorialTimerRef.current = null;
      const row = squeezeRowRef.current;
      if (row) row.removeAttribute('data-peeling');
      clearPeelVars();
      setTutorialRunning(false);
      if (seen) markTutorialSeen();
    };

    const resetSqueeze = () => {
      setSqueezeOpenForHand(null);
      setHoldLiftForHand(null);
      peelRef.current = null;
      if (peelTweenRef.current != null) cancelAnimationFrame(peelTweenRef.current);
      if (peelTweenTimerRef.current != null) clearTimeout(peelTweenTimerRef.current);
      peelTweenRef.current = null;
      peelTweenTimerRef.current = null;
      clearPeelVars();
    };
    /* The latch itself is derived above and needs no effect. These clear the
       IMPERATIVE half - the tween handles and the inline custom properties -
       which a render cannot do. */
    useEffect(() => {
      if (heroCardCount === 0) resetSqueeze();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [heroCardCount]);
    useEffect(() => {
      resetSqueeze();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [handNumber]);
    const completeSqueeze = () => {
      /* Dan 2026-09-05: "YOU SHOULD ALSO BE ABLE TO PEEL THEM ALL THE WAY
         OPEN. WHEN THAT HAPPENS THEY STAY UP AND LIVE (LIKE A NORMAL RENDER
         HERO CARD VIEW)." That is what this latch is: the hand is named as
         open and renders as ordinary hero cards for the rest of it. */
      setSqueezeOpenForHand(handNumber);
      setHoldLiftForHand(null);
      peelRef.current = null;
      clearPeelVars();
      // No sound on open either - the whole peel is silent now.
    };

    /**
     * DOUBLE TAP: a small lift that STAYS, so you can read the indices without
     * holding a finger on the cards - the way Dan holds a real pair tilted on
     * the felt while he thinks. Tapping again puts them back down.
     *
     * Painted from an effect as well as from the gesture, because the CSS
     * custom properties live on the row's inline style: a remount (a seat
     * re-key, a table switch) gives us a fresh node with none of them, and the
     * lift would silently vanish while the state still said it was held.
     */
    const HOLD_LIFT_PROGRESS = 0.34;
    const toggleHoldLift = () => {
      setHoldLiftForHand((prev) => (prev === handNumber ? null : handNumber));
    };
    useEffect(() => {
      if (peelRef.current) return; // a live drag owns the vars
      const row = squeezeRowRef.current;
      if (!row) return;
      if (holdLiftActive) {
        const card = row.querySelector('.seat__card--squeeze');
        const h = card ? card.getBoundingClientRect().height : 0;
        paintPeel(
          computePeel({
            width: 1,
            height: h || 1,
            lift: liftAtProgress(h || 1, HOLD_LIFT_PROGRESS),
          })
        );
      } else if (!squeezeRevealed) {
        clearPeelVars();
      }
    }, [holdLiftActive, squeezeRevealed, handNumber]);
    /**
     * Progress past which a release OPENS the hand for good instead of
     * dropping it back on the felt.
     *
     * RAISED from 0.45 to 0.9 on 2026-09-05. Dan: "YOU SHOULD ALSO BE ABLE TO
     * PEEL THEM ALL THE WAY OPEN. WHEN THAT HAPPENS THEY STAY UP AND LIVE."
     * At 0.45 a glance committed the hand - you could not look without also
     * turning the cards over, which is the opposite of what a peek is for. The
     * three gestures now divide cleanly:
     *
     *   drag and hold        look, for as long as you hold
     *   release under 0.9    back down on the felt, still face down
     *   peel all the way     open and live for the rest of the hand
     *   double tap           a small lift that stays until you tap again
     */
    const PEEL_COMMIT = 0.9;
    /** Two taps inside this window are a double tap. */
    const DOUBLE_TAP_MS = 300;
    const lastTapAtRef = useRef(0);
    const squeezeHandlers: React.HTMLAttributes<HTMLDivElement> = {
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
        if (peelRef.current) return; // a second finger does not start a second peel
        // The player touched the cards: they do not need to be shown.
        if (tutorialRunning) stopTutorial(true);
        if (peelTweenRef.current != null) {
          cancelAnimationFrame(peelTweenRef.current);
          peelTweenRef.current = null;
        }
        const row = e.currentTarget as HTMLDivElement;
        // The card under the finger sets the frame; a touch in the gap
        // between cards pinches the first one. Both cards then peel together.
        const target = (e.target as Element | null)?.closest?.('.seat__card--squeeze');
        const cardEl = (target ?? row.querySelector('.seat__card--squeeze')) as Element | null;
        if (!cardEl) return;
        const rect = cardEl.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return;
        /* Dan 2026-09-05, from his own video with real cards: the NEAR edge
           lifts and the fold travels UP the card. So the only thing that
           matters is how far the finger has moved upward from where it went
           down - not which corner it landed nearest. */
        /* Continue FROM the double-tap lift if one is being held. Starting at
           zero would drop the cards flat the instant a finger landed on them,
           which reads as the app throwing away the look you already had. */
        const heldLift = holdLiftActive ? liftAtProgress(rect.height, HOLD_LIFT_PROGRESS) : 0;
        peelRef.current = {
          width: rect.width,
          height: rect.height,
          startY: e.clientY + heldLift,
          pointerId: e.pointerId,
          moved: false,
          lifted: heldLift > 0,
          lift: heldLift,
        };
        row.setAttribute('data-peeling', '');
        paintPeel(computePeel({ width: rect.width, height: rect.height, lift: heldLift }));
        // The card is picked up the moment it is touched.
        /* SILENT PEEL (Dan 2026-09-05: "remove the sound effect when you
           actually peel your card, its not needed"). The friction voice and
           the paper tick are gone; the haptic stays, because that is the
           feedback he asked to keep. */
        haptic.light();
        // Capture so the peel keeps tracking a finger that wanders off the
        // cards. Guarded: a pointer the browser no longer knows (or a
        // synthetic one) makes this throw, and a throw here must never
        // strand the peel.
        try {
          row.setPointerCapture?.(e.pointerId);
        } catch {
          /* no capture: the row still receives moves while the finger is on it */
        }
      },
      onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
        const drag = peelRef.current;
        if (!drag || e.pointerId !== drag.pointerId) return;
        /* UP is the gesture. Dragging up lifts the near edge and walks the
           fold toward the top of the card; dragging back down lays it flat
           again, which is what a thumb actually does. */
        const lift = drag.startY - e.clientY;
        if (!drag.moved && Math.abs(lift) > 4) {
          drag.moved = true;
          cardSlideTelemetry.peelStarted();
        }
        if (!drag.moved) return;
        drag.lift = Math.max(0, lift);
        const before = squeezeProgressRef.current;
        // Tactile beats: the grip as the corner first bends, and a firmer
        // one as the peel crosses the point where letting go opens the hand.
        const after = paintPeelNow(drag);
        // The card leaving the felt, and the point where letting go opens the
        // hand. Haptics only - the peel is silent (Dan 2026-09-05).
        if (!drag.lifted && after >= 0.06) {
          drag.lifted = true;
          haptic.light();
        }
        if (after >= PEEL_COMMIT && before < PEEL_COMMIT) haptic.medium();
      },
      onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
        const drag = peelRef.current;
        if (!drag || e.pointerId !== drag.pointerId) return;
        const row = e.currentTarget as HTMLDivElement;
        try {
          row.releasePointerCapture?.(e.pointerId);
        } catch {
          /* already released */
        }
        peelRef.current = null;
        if (!drag.moved) {
          const now = Date.now();
          const isDoubleTap = now - lastTapAtRef.current <= DOUBLE_TAP_MS;
          lastTapAtRef.current = isDoubleTap ? 0 : now;
          if (isDoubleTap) {
            /* Dan 2026-09-05: "OR DOUBLE TAP, THAT LIFTS THEM SLIGHTLY (LIKE
               IN THE REAL VIDEO I SENT YOU)." Held until it is tapped again or
               the hand ends; the effect above paints it. */
            cardSlideTelemetry.peelStarted();
            haptic.light();
            toggleHoldLift();
            return;
          }
          // A single tap: bounce the near edge to show what the gesture is.
          // Never clear the vars while a lift is being held - that would drop
          // the cards on the first tap of the double tap that raised them.
          if (!holdLiftActive) clearPeelVars();
          setSqueezeHint(true);
          if (squeezeHintTimerRef.current) clearTimeout(squeezeHintTimerRef.current);
          squeezeHintTimerRef.current = setTimeout(() => {
            squeezeHintTimerRef.current = null;
            setSqueezeHint(false);
          }, 450);
          return;
        }
        const current = computePeel({
          width: drag.width,
          height: drag.height,
          lift: drag.lift,
        });
        row.removeAttribute('data-peeling');
        if (current.progress >= PEEL_COMMIT) {
          // Past the point of no return: the corner flies the rest of the way
          // and the hand opens.
          cardSlideTelemetry.peelCommitted();
          tweenPeel(drag, 1, 140, completeSqueeze);
        } else {
          // Let go early: the corner settles back onto the felt. The ratio of
          // this to the line above is the only measure of whether the commit
          // threshold is set where a hand actually wants to let go.
          cardSlideTelemetry.peelAbandoned();
          const restingProgress = holdLiftActive ? HOLD_LIFT_PROGRESS : 0;
          tweenPeel(drag, restingProgress, 260, holdLiftActive ? undefined : clearPeelVars);
        }
      },
      onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => {
        const drag = peelRef.current;
        if (!drag) return;
        peelRef.current = null;
        (e.currentTarget as HTMLDivElement).removeAttribute('data-peeling');
        const restingProgress = holdLiftActive ? HOLD_LIFT_PROGRESS : 0;
        tweenPeel(drag, restingProgress, 200, holdLiftActive ? undefined : clearPeelVars);
      },
      onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          cardSlideTelemetry.keyboardOpen();
          completeSqueeze();
        }
      },
    };

    /*
     * The demo's own gate, spelled out here rather than reusing `squeezeDown`.
     * `squeezeDown` is computed after the empty-seat early return, and a hook
     * that depends on it would be a hook AFTER a return - which React forbids
     * and eslint catches (rules-of-hooks, caught on this very file). Same
     * inputs, read one screen earlier.
     */
    const tutorialEligible =
      !!cardSqueezeActive &&
      !squeezeRevealed &&
      !!player &&
      player.status !== 'all_in' &&
      !player.showCards &&
      !isWinner &&
      !isMucking;

    // Fire the demo on the first face-down hand this browser has ever seen.
    /*
     * IDEMPOTENT ON PURPOSE. The first version guarded entry with a
     * `hasStarted` ref, which React 19's StrictMode turns into a demo that
     * never plays: mount runs the effect, the double-invoke cleanup cancels
     * the loop, and the second run sees the ref already set and returns.
     * Measured in the dev server - the coach mark appeared over cards that
     * never moved. So there is no entry ref: the effect cancels whatever is
     * running and starts again, and "once ever" is enforced where it belongs,
     * in localStorage, which the demo writes when it FINISHES.
     */
    useEffect(() => {
      if (!tutorialEligible) return;
      let seen = true;
      try {
        seen = localStorage.getItem(TUTORIAL_SEEN_KEY) === '1';
      } catch {
        seen = false;
      }
      if (seen) return;
      const row = squeezeRowRef.current;
      const cardEl = row?.querySelector('.seat__card--squeeze') as HTMLElement | null;
      const rect = cardEl?.getBoundingClientRect();
      if (!row || !rect || rect.width < 1) return;

      /*
       * NOT IN A BACKGROUND TAB. requestAnimationFrame does not fire on a
       * hidden document, so a demo started there would paint nothing, never
       * reach its own end, and never mark itself seen - leaving the caption
       * and `data-peeling` welded to the row for the whole session, and
       * spending the one showing on a tab nobody was looking at. Measured in
       * the dev server with the pane hidden: the caption appeared over cards
       * that never moved. Wait for the tab to be looked at instead.
       */
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        const onVisible = () => {
          if (document.visibilityState === 'visible') {
            document.removeEventListener('visibilitychange', onVisible);
            // Re-enter through the same path, which re-reads every guard.
            setTutorialRetry((n) => n + 1);
          }
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
      }

      if (tutorialRafRef.current != null) cancelAnimationFrame(tutorialRafRef.current);
      setTutorialRunning(true);

      // Reduced motion: the line is shown, the cards do not move. The caption
      // still says what to do, so meaning survives (CLAUDE.md 10.6).
      if (prefersReducedMotion()) {
        const t = window.setTimeout(() => stopTutorial(true), 4000);
        return () => window.clearTimeout(t);
      }

      const speed = getAnimationSpeed();
      const RISE = 900 * speed;
      const HOLD = 420 * speed;
      const FALL = 700 * speed;
      const GAP = 380 * speed;
      const CYCLE = RISE + HOLD + FALL + GAP;
      const PEAK = 0.34;
      const t0 = performance.now();
      row.setAttribute('data-peeling', '');

      const step = (now: number) => {
        // A real finger outranks the demonstration, always.
        if (peelRef.current) {
          stopTutorial(true);
          return;
        }
        const elapsed = now - t0;
        if (elapsed >= CYCLE * 2) {
          stopTutorial(true);
          return;
        }
        const inCycle = elapsed % CYCLE;
        let p: number;
        if (inCycle < RISE) {
          const k = inCycle / RISE;
          p = PEAK * (1 - Math.pow(1 - k, 3));
        } else if (inCycle < RISE + HOLD) {
          p = PEAK;
        } else if (inCycle < RISE + HOLD + FALL) {
          const k = (inCycle - RISE - HOLD) / FALL;
          p = PEAK * (1 - k * k);
        } else {
          p = 0;
        }
        paintPeel(
          computePeel({
            width: rect.width,
            height: rect.height,
            lift: liftAtProgress(rect.height, p),
          })
        );
        tutorialRafRef.current = requestAnimationFrame(step);
      };
      tutorialRafRef.current = requestAnimationFrame(step);
      /*
       * THE BACKSTOP. Same reasoning as the commit tween: the demo ends in a
       * STATE change (the caption goes away, the row is released, the once-
       * ever flag is written), and a state change that only happens if frames
       * arrive is a state change that can fail to happen - a tab backgrounded
       * mid-demo would otherwise keep the caption forever.
       */
      tutorialTimerRef.current = window.setTimeout(() => stopTutorial(true), CYCLE * 2 + 600);
      return () => {
        if (tutorialRafRef.current != null) cancelAnimationFrame(tutorialRafRef.current);
        if (tutorialTimerRef.current != null) clearTimeout(tutorialTimerRef.current);
        tutorialRafRef.current = null;
        tutorialTimerRef.current = null;
        row.removeAttribute('data-peeling');
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tutorialEligible, tutorialRetry]);

    useEffect(
      () => () => {
        if (tutorialRafRef.current != null) cancelAnimationFrame(tutorialRafRef.current);
        if (tutorialTimerRef.current != null) clearTimeout(tutorialTimerRef.current);
      },
      []
    );

    // Stack glow pulse — when the stack changes by >20%.
    // Same occupant guard as the delta above, and for the same reason: a chair
    // changing hands is not a 20% swing, and it used to pulse like one.
    const [stackGlow, setStackGlow] = useState(false);
    const prevStackForGlowRef = React.useRef<number>(player?.stack ?? 0);
    const glowOccupantRef = React.useRef<string | null>(player?.id ?? null);
    useEffect(() => {
      if (!player) {
        glowOccupantRef.current = null;
        return;
      }
      const prev = prevStackForGlowRef.current;
      const sameOccupant = glowOccupantRef.current === player.id;
      prevStackForGlowRef.current = player.stack;
      glowOccupantRef.current = player.id;
      if (sameOccupant && prev > 0) {
        const percentChange = Math.abs(player.stack - prev) / prev;
        if (percentChange > 0.2) {
          setStackGlow(true);
          const timer = setTimeout(() => setStackGlow(false), 600);
          return () => clearTimeout(timer);
        }
      }
    }, [player?.stack, playerId]);

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
        /* Armed-but-unspent time bank, hero only. Deliberately NOT gated on
           isActingNow alone: the arm is only meaningful during hero's turn,
           and TablePage clears it when the turn ends. */
        if (player.isHero && timeBankArmed) cls.push('seat--tb-armed');
        // isActingNow, not isActive: a seat that has just folded must lose the
        // acting chrome (and its countdown ring) immediately, without waiting
        // for the snapshot that moves currentPlayerSeat along. See hasFolded.
        if (isActingNow) cls.push('seat--active');
        if (isActingNow && isTimeBankActive) cls.push('seat--time-bank-active');
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
      timeBankArmed,
      isTimeBankActive,
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
            data-seat-num={seatNumber}
            /* 2026-08-26: replaced text label with the EMPTY coin image.
               Interaction model unchanged — no onClick, no tabIndex, no role:
               the seat is removed from the interaction model entirely. */
            aria-label={
              isHeroReservedSeat ? `Seat ${seatNumber}: Your Seat` : `Seat ${seatNumber}: Empty`
            }
          >
            <img
              src={`${import.meta.env.BASE_URL}images/icons/empty-button.png`}
              alt={isHeroReservedSeat ? 'Your Reserved Seat' : 'Empty Seat'}
              className="seat__empty-img"
              draggable={false}
            />
          </div>
        );
      }
      return (
        <div
          className={containerClasses}
          data-seat-num={seatNumber}
          onClick={() => callbacksRef.current.onSit?.()}
          onKeyDown={(e) => {
            // Lobby audit P2-5: keyboard users must be able to sit via the
            // role="button" empty seat. Mirror the onClick (onSit) handler.
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              callbacksRef.current.onSit?.();
            }
          }}
          role="button"
          tabIndex={0}
          aria-label={`Seat ${seatNumber}: Open - Click To Sit`}
        >
          {/* 2026-08-26: replaced +/SIT text stack with the SIT coin image. */}
          <img
            src={`${import.meta.env.BASE_URL}images/icons/sit-button.png`}
            alt="Sit Down"
            className="seat__empty-img seat__empty-img--sit"
            draggable={false}
          />
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
    const holoEligible = isVipBust && !avatarBroken && !rigActive;
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

    /**
     * IS THE HERO'S HAND BEING SHOWN TO THE TABLE?
     *
     * Dan 2026-08-27: "cards ... need to be displayed left to right. These are
     * the ONLY WAY they should be displayed at showdown, or when shown by the
     * player. Clearly showing every single card in the hand."
     *
     * The hero's row is the one row on the table with two audiences, and it has
     * only ever been drawn for the first. PRIVATELY it is the hero's own hand:
     * overlapped and arced, because that is what a held hand looks like and
     * because the compact row is what lets a PLO6 hand live in the strip of
     * backdrop right of the seat on a 375px phone. The hero loses nothing to a
     * covered card - they already know what they hold.
     *
     * TABLED it is being read by everybody else, and every one of those reasons
     * evaporates. So the class below opens the row out and flattens it (see the
     * `--revealed` block at the end of SeatSlot.css) - the same treatment a
     * villain's shown hand gets, which is the point: Dan's rule is that a shown
     * hand looks the same wherever it is sitting.
     *
     * DERIVED HERE RATHER THAN PASSED IN. `player.showCards` cannot answer this
     * for the hero: TablePage sets it to `isHero` on every deal, because the
     * hero can always see their own cards. The honest signal is a prop
     * (`isShowdown`) from TablePage, which several other workstreams are inside
     * right now, so this reads the three states the seat can already see:
     *
     *   isWinner            the hand was tabled and won - it is on display now
     *   status === all_in   an all-in runout turns the hand face up to the table
     *   winnerDisplayActive a showdown is being presented at this table
     *
     * and requires the hand to still be LIVE. A hero who folded keeps their
     * cards on screen on purpose (TablePage substitutes the last-delivered
     * array back in so the player can see what they mucked, Dan 2026-04-14),
     * and that muck view is private - it must not fan itself open every time
     * somebody else wins. Same for a hand the engine ruled muckable.
     */
    const heroHandIsTabled =
      !!player.isHero &&
      player.status !== 'folded' &&
      lastAction !== 'fold' &&
      !isMuckedShowdown &&
      (isWinner || player.status === 'all_in' || !!winnerDisplayActive);

    /**
     * How many cards a VILLAIN's fan is about to draw.
     *
     * Dan 2026-08-26 rebuild: this number is the ONLY thing game type changes
     * about a villain's hand. 2, 4, 5 and 6 all render through the same fan
     * geometry (see VILLAIN_FAN above and `.seat__cards--opponent` in
     * SeatSlot.css); the old per-game-type layout branch was the bug.
     *
     * Counted from what will actually be RENDERED rather than from
     * holeCardCount alone, because the two branches below disagree by design:
     * a revealed hand draws `holeCards`, a hidden one draws `holeCardCount`
     * backs. Both are the variant's count for a villain — an opponent's
     * holeCards array is empty precisely because the hand is hidden, never
     * short — so either branch answers the same question, and reading the one
     * that is about to render means the fan's variables can never disagree
     * with the row they describe.
     */
    const opponentCardCount =
      player.holeCards && player.holeCards.length > 0
        ? player.holeCards.length
        : Math.max(1, Math.min(6, holeCardCount));

    /**
     * Dan 2026-08-25 round 2, item 9: "when the hero doesn't have a hand, they
     * should never be covered by anything ever."
     *
     * The hero's card row is the one thing INSIDE this seat that can be drawn
     * over the hero, and it outlives the hand it belongs to. TablePage keeps
     * the hero's last-delivered `holeCards` alive on purpose — when the hero
     * folds, the engine scrubs them out of the public snapshot and TablePage
     * substitutes the previous array back in, so the player can still see what
     * they mucked (Dan's UX rule, 2026-04-14). That substitution has no hand
     * boundary in it: once the hero has been dealt in even once, `holeCards`
     * stays non-empty through the fold, through the showdown, through the gap
     * before the next deal, and on through a sit-out — so this row renders in
     * every state where the hero has no hand at all.
     *
     * Two halves to making that structurally impossible, and this is the first:
     * a player who is OUT of the game — sat out or away — is not holding a hand
     * by any reading, so the stale row is not drawn for them at all. The second
     * half is geometric and lives in SeatSlot.css: the row is anchored 1px
     * clear of the seat's own box, so even while it legitimately renders (live
     * hand, muck view, showdown) it cannot overlap the avatar or the plate at
     * any hand size or breakpoint.
     *
     * Deliberately NOT extended to 'disconnected': a disconnected player is
     * still in the hand until the engine folds them, and erasing their cards
     * would be erasing a live holding.
     */
    /* ── HOLDING CARDS BEATS EVERY OTHER SIGNAL ────────────────────────────
       Dan 2026-08-26: "hero can NEVER EVER EVER lose access to seeing their
       hole cards."

       This suppression exists so a STALE holding cannot be drawn over a hero
       who has no hand — which is a real problem and stays solved, because the
       merge upstream now expires the holding at the hand boundary. But as a
       standalone status test it was also capable of hiding a hand the hero
       genuinely HOLDS: a resync can re-stamp the hero 'sitting_out' from a
       stale ref, and a frame where the engine roster omits the hero's seat
       substitutes a placeholder with that status. Either one blanked a live
       hand for as long as it lasted.

       Cards present is now the stronger signal. If the hero is holding
       something, it is drawn, whatever the status line says; the suppression
       only applies when there is nothing to show anyway. */
    const heroHoldsCards = !!player.holeCards && player.holeCards.length > 0;
    const heroIsOutOfPlay =
      !heroHoldsCards && (player.status === 'sitting_out' || player.status === 'away');

    // 2026-04-15 Bible V8 §6.1 — pure-CSS ring countdown. Set animation
    // duration + a negative animation-delay so the ring animates from the
    // CURRENT elapsed position to 0% over the remaining seconds. Works on
    // hidden tabs; applies identically to hero and opponent active seats.
    // Falls back to the legacy --timer-progress var when server timing is
    // unavailable so the prior JS-driven visual still shows.
    let timerStyle: React.CSSProperties | undefined;
    let timerKey: number | string = 'no-turn';
    /* THE SHINE IS AN "ON THE CLOCK" CUE, NOT AMBIENT LIFE (Dan 2026-09-02):
       "THE SHINE EFFECT THAT GOES OVER EVERY PLAYER EVERY COUPLE OF SECONDS
       ... SHOULD ONLY APPEAR WHEN IT'S A PLAYER'S TURN, AND THEY HAVE BEEN ON
       THE CLOCK FOR AT LEAST 3 SECONDS. IT SHOULD NEVER APPEAR ON IDLE PLAYERS,
       OR PLAYERS IF THE ACTION ISN'T ON THEM."

       The holo scan line used to run on every VIP seat forever (7s cycle,
       phased per seat, so somewhere on the table a player was lit every
       second or two). It is now armed only for the seat that is acting, and
       its animation-delay is the time LEFT until three seconds on the clock -
       measured on the engine's clock through the same elapsed figure the
       countdown ring uses, so a mid-turn rejoin with five seconds already
       gone shines at once rather than restarting the wait. null = not on the
       clock = no class, no pseudo-element, nothing to see. A turn the engine
       has not stamped a deadline on waits the full three seconds. */
    let holoOnClockDelayMs: number | null = isActingNow ? HOLO_ON_CLOCK_MS : null;
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
      const rawElapsedMs = turnStartTimeMs ? Math.max(0, serverNow() - turnStartTimeMs) : 0;
      /* Item 10 (Dan 2026-08-26): anchor at this client's FIRST paint of the
         turn. The base elapsed (latency + deal hold) is subtracted from both
         the duration and the elapsed, so the ring spans mount → deadline:
         starts full, empties exactly when the engine folds or the time bank
         fires, never earlier. Capped so a pathological anchor can never
         reduce the ring below one second. */
      /* Only broadcast latency and the deal hold are compensated — a few
         seconds at most. A LARGER first-paint elapsed means a genuine
         mid-turn rejoin (reconnect, tab wake), where the ring must pick up
         at its true position rather than pretend the clock restarted —
         tests/seatslot-countdown-duration.test.tsx pins that case. */
      const TURN_PAINT_LATENCY_ALLOWANCE_MS = 3_000;
      const anchorKey = turnStartTimeMs || turnDeadlineMs;
      if (turnPaintAnchorRef.current?.key !== anchorKey) {
        const baseAtFirstPaint = rawElapsedMs <= TURN_PAINT_LATENCY_ALLOWANCE_MS ? rawElapsedMs : 0;
        turnPaintAnchorRef.current = {
          key: anchorKey,
          baseElapsedMs: baseAtFirstPaint,
          /* Frozen ONCE per turn. animation-delay is read by the browser
             when the class mounts; feeding it a value that shrinks on every
             countdown tick would re-time a running animation and bring the
             sweep forward of the three seconds Dan asked for. A rejoin with
             more than three seconds already gone (base 0, elapsed large)
             lands at 0 and shines at once. */
          holoDelayMs: Math.max(0, HOLO_ON_CLOCK_MS - (rawElapsedMs - baseAtFirstPaint)),
        };
      }
      const baseElapsedMs = Math.min(
        turnPaintAnchorRef.current.baseElapsedMs,
        Math.max(0, durationMs - 1_000)
      );
      const effDurationMs = durationMs - baseElapsedMs;
      const elapsedMs = Math.max(0, rawElapsedMs - baseElapsedMs);
      holoOnClockDelayMs = turnPaintAnchorRef.current.holoDelayMs;
      // Dan 2026-08-15: the yellow countdown is a full 15 seconds. On a normal
      // 15s turn that is the entire clock (never goes red); when a time bank
      // extends the turn, yellow still owns the first 15s and the borrowed
      // seconds run red. Capped at the turn length so the colour animation can
      // never outlive the ring it colours.
      const YELLOW_MS = 15_000;
      const yellowMs = Math.min(YELLOW_MS, effDurationMs);
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
      const remainingMs = Math.max(0, effDurationMs - elapsedMs);
      const flashDelayMs = effDurationMs - FLASH_WINDOW_MS - elapsedMs;
      const flashCount = Math.max(
        0,
        Math.ceil(Math.min(FLASH_WINDOW_MS, remainingMs) / FLASH_CYCLE_MS)
      );
      timerStyle = {
        '--sp-timer-duration': `${(effDurationMs / 1000).toFixed(3)}s`,
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
    // Eligible art (VIP bust, not broken, not rigged) AND on the clock. Never
    // an idle seat, never a seat the action is not on.
    const showHolo = holoEligible && holoOnClockDelayMs !== null;

    return (
      <div
        ref={seatRef}
        /* `seat--cards-left` / `seat--cards-right` is the side derived above —
           outboard at the top cap, inboard everywhere else, see `seatCardSide`.
           It rides on the seat rather than on the card row so the CSS can key
           both the hero row and the opponent row off one class. */
        className={`${containerClasses} seat--cards-${cardSide}`}
        onClick={() => callbacksRef.current.onAction?.()}
        data-seat-num={seatNumber}
        role="region"
        /* isActingNow: a screen reader must not keep announcing a folded seat
           as "acting now" for the round trip it takes the snapshot to move the
           turn along - the same stale-turn window the countdown ring had. */
        aria-label={`Seat ${seatNumber}: ${player.name}${isActingNow ? ' (Acting Now)' : ''}${player.status === 'folded' ? ' (Folded)' : ''}${player.status === 'all_in' ? ' (All In)' : ''}, Stack ${player.stack}`}
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

        {/* Hole Cards — opponents: ONE small rotational cluster for every hand
            size (Dan 2026-08-26, PokerBros reference). The count comes from
            the variant, the geometry from CSS; there is deliberately NO
            game-type layout branch here — that branch (the old `--twocard`
            hold'em treatment) was the second renderer this rebuild deleted.
            Also renders during isFolding so the fly-out animation can play
            before unmount; the pod itself never reflows when the cluster
            goes, because it is absolutely positioned. */}
        {!player.isHero &&
          (player.status === 'active' || player.status === 'all_in' || isFolding || isMucking) &&
          /* A HAND, NOT FURNITURE (Dan 2026-08-28). See `handInPlay`. Every
             arm after the first is an escape hatch so this can never swallow
             a real hand or a protected animation: cards actually delivered,
             an all-in that is by definition mid-hand, a deal sliding in, a
             fold or muck flying out. What is left — a seated player, no
             hand, nothing animating — is the pre-start Spin that drew two
             players holding cards before the game had a third. */
          (handInPlay ||
            (player.holeCards?.length ?? 0) > 0 ||
            player.status === 'all_in' ||
            isDealing ||
            isFolding ||
            isMucking) && (
            <div
              className={`seat__cards seat__cards--opponent${player.showCards && player.holeCards?.length && !revealHeld ? ' seat__cards--revealed' : ''}${isFolding || isMucking ? ' seat__cards--folding' : ''}${isShowdownFlip ? ' seat__cards--showdown' : ''}${isDealing ? ' seat__cards--dealing' : ''}`}
              style={
                {
                  /* PHASE 3 2026-08-31: the flying card still counts toward
                     the fan's geometry while it is on screen. Without this the
                     cluster re-centres for two cards the same frame the third
                     starts leaving, and the two survivors visibly slide. */
                  '--vh-n': opponentCardCount + (discardFlight ? 1 : 0),
                  '--vh-rot-step': `${(VILLAIN_FAN[opponentCardCount] ?? VILLAIN_FAN[2]).rot}deg`,
                  /* -base, not --vh-step-f itself: the showdown reveal widens
                     the step to 0.55 via a class rule, and an inline value
                     would beat it. */
                  '--vh-step-f-base': (VILLAIN_FAN[opponentCardCount] ?? VILLAIN_FAN[2]).step,
                } as React.CSSProperties
              }
            >
              {player.holeCards && player.holeCards.length > 0
                ? /* TWO ORDERS, NEVER CONFLATED (Dan 2026-08-27, showdown
                     highlighting). `row` is the position in the row as it is
                     DRAWN - left to right, high card first - and drives the
                     React key and `--vh-i`, which is what lays the card out.
                     `dealtIndex` is the position the ENGINE numbers the card
                     by, and is the only thing `winningHoleCardIndexes` may be
                     asked about. They are equal only when the sort was a no-op;
                     see `displayOrderWithDealtIndex` for the hand that proved
                     they are not the same number. */
                  displayHoleCards.map(({ card, dealtIndex }, row) => (
                    <HoleCard
                      key={dealtIndex}
                      card={card}
                      /* Dan 2026-08-18: null = this specific card was not among
                       the ones the player chose to show, so it stays down even
                       though the seat itself is revealed.
                       SHOWDOWN SYSTEM 2026-08-25: revealHeld keeps the back on
                       until this seat's turn in the reveal sequence. */
                      hidden={!player.showCards || card == null || revealHeld}
                      isWinner={
                        isWinner &&
                        (winningHoleCardIndexes
                          ? winningHoleCardIndexes.includes(dealtIndex)
                          : true)
                      }
                      /* POKERBROS PARITY 2026-08-26: while a winner is on
                         display, every face-up card outside the winning five
                         dims — a losing shown hand dims whole, a winner's
                         unused cards dim around the lit ones. */
                      isDimmed={
                        winnerDisplayActive &&
                        !(
                          isWinner &&
                          (winningHoleCardIndexes
                            ? winningHoleCardIndexes.includes(dealtIndex)
                            : true)
                        )
                      }
                      deckStyle={deckStyle}
                      cardBack={cardBack}
                      /* A revealed villain hand is being read RIGHT NOW - the
                         showdown is the one moment a card face has to be on
                         screen the instant it flips. */
                      eager={player.showCards}
                      fanIndex={row}
                    />
                  ))
                : /* Dan 2026-08-23: this used to be exactly two hard-coded backs,
                   so a PLO4 seat showed a Hold'em hand and a 6-card seat showed
                   a third of one. The count comes from the table because the
                   seat has nothing to count - an opponent's holeCards array is
                   empty BECAUSE the hand is hidden. `opponentCardCount` above
                   applies the sane-band clamp so a malformed variant string
                   cannot render 0 cards (a live player who looks like they
                   folded) or a hundred. */
                  Array.from({ length: opponentCardCount }, (_, i) => (
                    <HoleCard
                      key={i}
                      hidden={true}
                      deckStyle={deckStyle}
                      cardBack={cardBack}
                      fanIndex={i}
                    />
                  ))}
              {/* PHASE 3 2026-08-31: the card on its way to the muck. Drawn
                  OUTSIDE the count above, at the fan position the hand just
                  gave up, so the two remaining backs never reflow to make room
                  for a card that is leaving. Face DOWN, always: this is a
                  villain, and their discard is not revealed in this variant. */}
              {discardFlight && (
                <HoleCard
                  key="discard-flight"
                  hidden={true}
                  deckStyle={deckStyle}
                  cardBack={cardBack}
                  fanIndex={opponentCardCount}
                  discardFlight
                />
              )}
            </div>
          )}

        {/* Avatar Circle — large, sits on top of info box */}
        {/* showHolo: eligible art AND on the clock - see holoOnClockDelayMs. */}
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
                    ...(showHolo
                      ? {
                          '--sp-avatar-src': `url("${avatarUrl}")`,
                          // Overrides the per-seat idle phase from breathingStyle:
                          // the first sweep lands exactly three seconds on the
                          // clock (see holoOnClockDelayMs), then every 7s after.
                          '--sp-holo-delay': `${holoOnClockDelayMs ?? HOLO_ON_CLOCK_MS}ms`,
                        }
                      : null),
                    ...(bustGain !== 1 ? { '--sp-bust-gain': bustGain } : null),
                  } as React.CSSProperties)
                : undefined
            }
            onClick={
              avatarClickable
                ? (e) => {
                    e.stopPropagation();
                    callbacksRef.current.onAvatarClick?.();
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
            aria-label={avatarClickable ? `Player Actions For ${player.name}` : undefined}
            onKeyDown={
              avatarClickable
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      callbacksRef.current.onAvatarClick?.();
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
                /* isActingNow, not isActive. `hasFolded` exists precisely so
                   that ONE value answers "is this seat acting" for the ring,
                   the urgency colours, the tense idle, the alert gesture and
                   the screen-reader label - and the rig was the one consumer
                   still reading the raw snapshot flag. A player who has just
                   folded kept telling their rig it was still on the clock for
                   the whole round trip. */
                isActive={isActingNow}
                isFolded={hasFolded}
                size={player.isHero ? SEAT_AVATAR_PX_HERO : SEAT_AVATAR_PX}
                onRigActive={setRigActive}
              />
            ) : null}
            {showAvatar && !avatarBroken && !rigActive ? (
              <img
                src={avatarUrl}
                /* RETINA 2026-08-23 (root cause of "avatars don't show on
                   mobile"): 193 profiles stored their library art as
                   /avatars/table/X@2x.webp. The old unconditional replace
                   built X@2x@2x.webp as the 2x candidate — a 404 — and every
                   phone (DPR>=2) SELECTS the 2x candidate, so the img errored
                   and the seat fell back to an initial. Desktop (DPR 1) used
                   the 1x URL and looked fine, which is why this only ever hurt
                   phones. Only offer a 2x twin when the URL is base table art
                   that is not already @2x. */
                srcSet={
                  /^https?:\/\/[^\s]+\/avatars\/table\/[^@\s]+\.webp$/.test(avatarUrl)
                    ? `${avatarUrl} 1x, ${avatarUrl.replace(/\.webp$/, '@2x.webp')} 2x`
                    : undefined
                }
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

            {/* Equipped frame + aura — Bible V8 §11 cosmetics.
                Inside `.seat__avatar` on purpose: that element owns the circle
                and the `position: relative`, so the overlay inherits both and
                stays a circle without knowing the seat's geometry.

                `still` because a nine-handed felt could otherwise run nine
                infinite keyframe loops behind the cards, and `aura-glitch`
                repeats six times a second. The aura still reads as an aura; it
                just stops repainting. */}
            {showAvatar && <AvatarCosmetics frame={player.frame} aura={player.aura} still />}

            {/* Folded overlay */}
            {lastAction === 'fold' && <div className="seat__avatar-fold-overlay" />}
          </div>

          {/* Status dot (away/sitting out/disconnected) — Bible V8 §2.3 */}
          {player.status !== 'active' &&
            player.status !== 'folded' &&
            player.status !== 'all_in' && (
              <span className={`seat__status-dot seat__status-dot--${player.status}`} />
            )}
          {/* SITTING OUT tag (Dan 2026-08-28): "you also need to add a SITTING
              OUT tag that other users can see at the table when a player is
              sitting out, or is forced to sit out from connection issues."

              A real element rather than the `.seat__info::after` pill that used
              to carry this, because that pill said AWAY for both states and
              there was no way to tell the two apart — nor to assert on it from
              a test. AWAY still exists and still means away; this says what it
              means. The disconnect overlay below is the third state and takes
              precedence over neither: a dropped player reads DISCONNECTED until
              the engine formally sits them out, and SITTING OUT after. */}
          {player.status === 'sitting_out' &&
            entryWait !== 'posting_bb' &&
            (entryWait === 'waiting_for_bb' ? (
              /* An entrant the engine holds for the blind is not sitting out;
                 they are waiting for it (Dan 2026-09-23, see `entryWait`). */
              <div
                className="seat__sitout-badge"
                title="This Player Is Waiting For The Big Blind"
                data-testid="seat-waiting-bb-badge"
              >
                Waiting For BB
              </div>
            ) : (
              /* The clock lives in a memoised child that owns its own interval —
                 passing a per-second number through here would defeat this
                 component's comparator sixty times a minute per sat-out seat.
                 See SitOutBadge for the full reasoning. */
              <SitOutBadge sitOutAt={sitOutAt} />
            ))}
          {/* FIX 186: Disconnected overlay — shows DISCONNECTED label + countdown */}
          {player.status === 'disconnected' && (
            <div className="seat__disconnect-overlay" title="Player Disconnected">
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
          {killMarker && (
            <div
              className="seat__position-badge seat__kill-badge"
              title="This Player Is The Killer"
            >
              {killMarker}
            </div>
          )}
        </div>

        {/* Info Box — name + stack, with neon timer border when active.
            The React `key` forces a fresh mount per turn so the CSS
            @property animation restarts from 100%. */}
        {/* ANIMATION AUDIT 2026-08-27: data-motion="keep" — the countdown ring
            IS duration-carrying CSS animation (spTimerRingShrink runs the whole
            turn; its length is the information). reducedMotion.css collapses
            every unmarked animation to 1ms, which made the ring finish
            instantly on every turn for reduced-motion players — the exact case
            the escape hatch was built for. The ring is informational, not
            vestibular motion (it shrinks in place). */}
        <div className="seat__info" style={timerStyle} key={`info-${timerKey}`} data-motion="keep">
          {/* Neon border overlay (rendered via CSS ::before when --active) */}
          {/* Dan 2026-08-30: "NAMES SHOULD NEVER BE CUT OFF... PUT A
              CHARACTER LIMIT ON THEM IF YOU CAN'T FIT THEM ALL IN WITHOUT
              USING A ... AFTER THEM." A hard budget instead of an ellipsis:
              what renders is what fits, whole characters, no dots. */}
          <span className="seat__name">{limitSeatName(player.name)}</span>
          <span
            className={`seat__stack${stackDelta > 0 ? ' seat__stack--up' : stackDelta < 0 ? ' seat__stack--down' : ''} ${getStackDepthClass(player.stack, bigBlind)}`}
          >
            {showStackInBB ? formatStackAsBB(player.stack, bigBlind) : formatStack(player.stack)}
          </span>

          {/* Armed time bank — the seat-level replacement for the toast that
              used to be the ONLY feedback for a press that spends nothing yet.
              Lives inside .seat__info so it sits with the ring it describes. */}
          {player.isHero && timeBankArmed && (
            <span className="seat__tb-armed" aria-live="polite">
              Time Bank Ready
            </span>
          )}

          {/**
           * AUDIT 2026-08-25 — the time bank being SPENT had a stylesheet and
           * no element.
           *
           * `.seat__tb-active` is a fully written rule in SeatSlot.css, with
           * its own `seat-tb-active-flash` keyframe, and nothing has ever
           * rendered that class. So the ARMED state (a press that spends
           * nothing yet) got a label while the ACTIVE state — the one where the
           * player is burning banked seconds — got only a red box-shadow on the
           * plate, which is indistinguishable at a glance from the ordinary
           * critical-time colour the ring already turns.
           *
           * Not hero-only, deliberately: TablePage sets `isTimeBankActive` for
           * the acting seat alone, and knowing an OPPONENT has gone into the
           * tank on borrowed time is exactly the information a player wants.
           * Gated on isActingNow for the same reason the class list is — a
           * seat that has just folded must not keep a live clock on it.
           */}
          {isActingNow && isTimeBankActive && (
            <span className="seat__tb-active" aria-live="polite">
              Time Bank
            </span>
          )}

          {/* Stack Change Delta */}
          {stackDelta !== 0 && (
            <span
              className={`seat__stack-delta ${stackDelta > 0 ? 'seat__stack-delta--win' : 'seat__stack-delta--loss'}`}
            >
              {stackDelta > 0 ? '+' : ''}
              {/* A change of stack is a wager or a win, not a stack: "-4",
                  never "-4.00" (Dan 2026-09-23, item 9's rule). */}
              {showStackInBB ? formatStackAsBB(stackDelta, bigBlind) : formatWager(stackDelta)}
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
        {player.holeCards && player.holeCards.length > 0 && player.isHero && !heroIsOutOfPlay && (
          /* COMPETITOR-PARITY 2026-08-19 (Card Squeeze): while the setting is
             on and this hand has not been squeezed open, the hero's cards sit
             face DOWN and the container owns a drag-up peel gesture instead
             of the tap-to-peek handlers. Auto-opens if the table can already
             see the hand (all-in runout / showdown / winner / muck). */
          <div
            className={
              'seat__cards seat__cards--hero' +
              /* Dan 2026-08-27: a hand that is being SHOWN opens out flat and
                 left to right, hero and villain alike. `heroHandIsTabled`
                 above says when that is; the geometry is the `--revealed`
                 block at the end of SeatSlot.css. Never while the cards are
                 still face down in the squeeze - there is nothing to show. */
              (heroHandIsTabled && !squeezeDown ? ' seat__cards--revealed' : '') +
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
            ref={squeezeRowRef}
            role={squeezeDown ? 'button' : undefined}
            tabIndex={squeezeDown ? 0 : undefined}
            aria-label={
              squeezeDown
                ? 'Your Cards Are Face Down. Slide A Corner To Peel Them Up, Or Press Enter.'
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
            {tutorialRunning && (
              <div className="seat__peel-coach" aria-hidden="true">
                Slide The Corner To Look
              </div>
            )}
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
                  /* THE BADGE FOLLOWS THE CLICK. `--marked` draws a gold eye on
                     the card's corner, and it used to render with no reference
                     to squeeze state while BOTH handlers below early-return on
                     `squeezeDown`. So a pick that outlived its hand sat there
                     on the back of a face-down card, visibly on and completely
                     inert - which is what "the eye ball stays locked, you can
                     never unlock it" looked like. If you cannot click it, it
                     does not claim to be clickable. */
                  (showPickedCardIndexes?.includes(i) && !squeezeDown
                    ? ' seat__card-pick--marked'
                    : '')
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
                      ? `Card ${i + 1} Will Be Shown After The Hand. Activate To Keep It Hidden.`
                      : `Show Card ${i + 1} After The Hand`
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
                      {/* THE FACE, revealed from the BOTTOM UP as the near
                          edge lifts (Dan's video, 2026-09-05). Clipped to
                          everything BELOW the fold line. The real card art -
                          no synthetic index, because the whole face comes
                          into view, exactly as it does on a real card. */}
                      <div className="seat__squeeze-face seat__squeeze-face--under">
                        {card ? (
                          <CardImage card={card} deckStyle={deckStyle} size="md" />
                        ) : (
                          <CardBack size="md" style={cardBack} />
                        )}
                      </div>
                      {/* THE BACK, clipped to everything ABOVE the fold, so it
                          recedes upward as the face comes up to meet it. */}
                      <div className="seat__squeeze-face seat__squeeze-face--cover">
                        <CardBack size="md" style={cardBack} />
                      </div>
                      {/* The crease: a soft shadow sitting on the fold line,
                          which is what sells the card bending rather than a
                          window sliding open. */}
                      <div className="seat__peel-crease" aria-hidden="true" />
                    </div>
                  </div>
                ) : (
                  <HoleCard
                    card={card}
                    hidden={false}
                    isHero={true}
                    isWinner={
                      isWinner &&
                      (winningHoleCardIndexes ? winningHoleCardIndexes.includes(i) : true)
                    }
                    /* POKERBROS PARITY 2026-08-26: same rule as the villain
                       row — during winner display, only the winning cards
                       stay lit; the hero's other cards dim with the rest. */
                    isDimmed={
                      winnerDisplayActive &&
                      !(
                        isWinner &&
                        (winningHoleCardIndexes ? winningHoleCardIndexes.includes(i) : true)
                      )
                    }
                    deckStyle={deckStyle}
                    cardBack={cardBack}
                    /* The hero's own hand is on screen for the whole hand and is
                       the first thing they look at. Nothing about it should be
                       deferred. */
                    eager
                  />
                )}
              </span>
            ))}
            {/* PHASE 3 2026-08-31: hero's discarded card, on its way out.
                By the time this renders the row above is already two cards -
                the engine accepted, TablePage took the card off the felt, and
                that removal is also what closes the picker. So the card the
                player just chose has nowhere left to live, and without a ghost
                the hero's hand simply pops from three to two.

                Deliberately NOT inside a .seat__card-pick wrapper: this card
                is gone, so it must not be clickable, focusable, or markable as
                "show after the hand". Face UP, because it is the hero's own
                card and they are the one who picked it - see discardFlightCard
                on the interface for why nobody else's is. */}
            {discardFlight && (
              <HoleCard
                key="discard-flight"
                card={discardFlightCard}
                hidden={!discardFlightCard}
                isHero={true}
                deckStyle={deckStyle}
                cardBack={cardBack}
                eager
                discardFlight
              />
            )}
          </div>
        )}

        {/* Winning Hand Name — floats below cards (premium style) "Straight" label */}
        {isWinner && winningHandName && <div className="seat__hand-name">{winningHandName}</div>}

        {/* SHOWDOWN SYSTEM 2026-08-25 (spec section 4): the engine ruled this
            hand muckable — its cards were never revealed. The label is the
            seat's whole showdown story, so it never renders alongside a
            winner label. */}
        {isMuckedShowdown && !isWinner && <div className="seat__mucked-label">Mucked</div>}

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
        {/* CARD SLIDE 2026-09-05: ...and never while the hero's own cards are
            still face down. This label reads "Pair Of Kings" straight from
            the hole cards, so with Card Slide on it announced the hand the
            player had not looked at yet - the peel became decorative and
            nobody ever had to use it. A card you have not turned over does
            not tell you what it is. */}
        {player.isHero && handStrength && !squeezeDown && !(isWinner && winningHandName) && (
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
            {/* A win is a wager's kind of number, not a stack's: +12, not
                +12.00, beside a stack delta that already reads +12
                (2026-09-24, the one float item 9 missed). */}
            {formatWager(Math.abs(netWinAmount))}
          </div>
        )}

        {/* POKERBROS PARITY 2026-08-26 (round 3): the reference scatters
            four-point gold star sparkles over the winner's cards while the
            +N float shows — measured off the 30.5-31.1s frames (one large
            star on the cards, smaller ones twinkling around them). Positive
            wins only: a rake-negative chop gets information, not confetti. */}
        {isWinner && typeof netWinAmount === 'number' && netWinAmount > 0 && (
          <div className="seat__win-sparkles" aria-hidden="true" key={`spark-${netWinAmount}`}>
            <span className="seat__win-sparkle" />
            <span className="seat__win-sparkle" />
            <span className="seat__win-sparkle" />
            <span className="seat__win-sparkle" />
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

        {/* The per-seat "BOMB" pill that used to sit here is gone (Dan
            2026-09-04, see the `bombPotAnte` tombstone on the props). The
            bomb pot is announced ONCE, on the felt. */}

        {/* Bounty Badge.

            2026-08-26, two fixes:

            (a) NO FORCED CENTS. This used `minimumFractionDigits: 2`, so a
                12-chip bounty rendered `◎ 12.00` — four glyphs of which two
                carry nothing, at 0.55rem, on the most size-constrained badge
                on the felt. Every other tournament money surface rounds
                through `utils/buyIn.money()`. Fractional bounties (mystery
                bounty splits) still show their decimals; whole ones do not
                pretend to have any.

            (b) IT HAD NO ACCESSIBLE TEXT. The only content was an unlabelled
                geometric glyph plus a number, announced as "circled ring
                operator twelve" — and the seat's own aria-label names seat,
                player, status and stack but not the bounty, so the figure was
                unavailable anywhere else. */}
        {bountyValue != null && bountyValue > 0 && (
          <div
            className="seat__bounty"
            aria-label={`Bounty ${
              bountyUnitCents === DIAMOND_UNIT_CENTS
                ? formatPrizeAtUnit(bountyValue, DIAMOND_UNIT_CENTS)
                : bountyValue.toLocaleString('en-US', { maximumFractionDigits: 2 })
            } ${moneyWordAtUnit(bountyUnitCents ?? UNIT_CENTS_ASSET_NOT_READ)}`}
          >
            <span className="seat__bounty-target" aria-hidden="true">
              ◎
            </span>
            <span className="seat__bounty-val" aria-hidden="true">
              {/* Two places when there ARE cents (2026-09-09): a 7.50 bounty
                  rendered "7.5" beside a 2-dp BBJ credit on the same seat.
                  A DIAMOND head has none (2026-09-20): the bounty bank holds
                  whole Diamonds, so the chip branch would print a fraction the
                  payment cannot contain. The chip branch is untouched. */}
              {bountyUnitCents === DIAMOND_UNIT_CENTS
                ? formatPrizeAtUnit(bountyValue, DIAMOND_UNIT_CENTS)
                : bountyValue.toLocaleString('en-US', {
                    minimumFractionDigits: Number.isInteger(bountyValue) ? 0 : 2,
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
    /* PERF 2026-08-25: the store instance is stable for the life of a table, so
       in practice this never differs — but a table SWITCH inside MultiTablePage
       reuses seat nodes across two different tables' clocks, and a seat left
       subscribed to the previous table's store would count down the wrong turn.
       Compared for that case, not for the countdown: the countdown does not
       travel through props any more. */
    if (prev.actionClock !== next.actionClock) return false;
    if (prev.isActive !== next.isActive) return false;
    if (prev.canSit !== next.canSit) return false;
    /**
     * AUDIT 2026-08-25 — two props that were passed, read, and then blocked.
     *
     * `holeCardCount` is the variant's hand size and it is the ONLY thing that
     * decides how many face-down backs a hidden villain draws. TablePage feeds
     * it from `tableState.gameType`, which is EMPTY on the first paint and
     * arrives with the table row a moment later. Without this line the memo
     * swallowed that arrival, so a seat that had already rendered kept the
     * default of two backs for the rest of the session - the exact "PLO6 seat
     * shows a Hold'em hand" symptom the prop was added on 2026-08-23 to fix,
     * reintroduced one layer up. It only recovered if some unrelated prop
     * happened to change on that seat first.
     *
     * `isHeroReservedSeat` is worse, because it is an EMPTY-seat prop and the
     * comparator's `if (!pp && !np) return true` short-circuit is the last
     * thing that runs: two empty seats always compared equal, so nothing about
     * an empty seat could ever change. The moment the hero reserves a seat that
     * seat is supposed to read YOUR SEAT instead of EMPTY, and it never did.
     */
    if (prev.holeCardCount !== next.holeCardCount) return false;
    /* PHASE 3 2026-08-31: without this the ghost would render whatever card
       was in the prop at the last render this comparator DID let through -
       i.e. the previous hand's discard, or nothing at all. `lastAction` is
       compared above and is what starts the flight, but the two arrive in
       different renders. */
    if (prev.discardFlightCard !== next.discardFlightCard) return false;
    /* The first hand of a Spin flips this from false to true, and it is what
       puts every villain's cards on the felt. Swallowed here, the table would
       stay card-less through the whole hand. */
    if (prev.handInPlay !== next.handInPlay) return false;
    if (prev.isHeroReservedSeat !== next.isHeroReservedSeat) return false;
    if (prev.position !== next.position) return false;
    if (prev.killMarker !== next.killMarker) return false;
    if (prev.isTournament !== next.isTournament) return false;
    if (prev.bigBlind !== next.bigBlind) return false;
    if (prev.bountyValue !== next.bountyValue) return false;
    /* A table SWITCH inside MultiTablePage reuses seat nodes across two
       tables. Without this a Diamond seat could keep a chip table's grid
       (or the reverse) until something else on the seat changed. */
    if (prev.bountyUnitCents !== next.bountyUnitCents) return false;
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
    // SHOWDOWN SYSTEM 2026-08-25: the MUCKED label, the reveal stagger and
    // the exact-card winner highlight all arrive as new props at showdown —
    // each must break the memo or the feature is invisible.
    if (prev.isMuckedShowdown !== next.isMuckedShowdown) return false;
    if (prev.showdownRevealDelayMs !== next.showdownRevealDelayMs) return false;
    // POKERBROS PARITY 2026-08-26: the table-wide dim flag flips on every
    // seat at once when a winner is named — it must break the memo or losing
    // seats keep full-brightness cards while the winner's are lit.
    if (prev.winnerDisplayActive !== next.winnerDisplayActive) return false;
    {
      const a = prev.winningHoleCardIndexes;
      const b = next.winningHoleCardIndexes;
      if (a !== b) {
        if (!a || !b || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      }
    }
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
    /* Without this the memo swallows the arm and the seat never repaints —
       which is how it would silently regress back to "the toast is the only
       feedback". */
    if (prev.timeBankArmed !== next.timeBankArmed) return false;
    if (prev.isTimeBankActive !== next.isTimeBankActive) return false;
    /* The sit-out countdown. Omitted from this comparator on the first attempt,
       which made the badge's clock non-deterministic: `paint()` writes the
       stamp on the 10s poll WITHOUT changing anything else about the seat, so
       every field below matched, this returned true, and the render was
       skipped. On the deferred-sit-out path — tap Sit Out mid-hand, trigger
       fires at settlement — the stamp only ever arrives that way, so the badge
       showed no clock at all for the whole five minutes. */
    if (prev.sitOutAt !== next.sitOutAt) return false;
    // The entry hold changes what a sat-out seat says (Dan 2026-09-23).
    if (prev.entryWait !== next.entryWait) return false;

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
    /**
     * Compare cosmetics (frame and aura).
     * These are refreshed live by the table's profiles subscription.
     */
    if (pp.frame !== np.frame) return false;
    if (pp.aura !== np.aura) return false;
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
