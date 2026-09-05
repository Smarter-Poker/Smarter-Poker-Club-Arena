/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  COMMUNITY CARDS — Flop/Turn/River Display (PNG Custom Deck)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Displays the community cards on the poker table using the custom PNG deck:
 * - Animated card deal effects
 * - Stage-based progressive reveal
 * - Card highlighting for winning hands
 * - Uses CardImage component for custom deck rendering
 */

import React, { useMemo, useEffect, useRef, useState, useId, memo } from 'react';
import { CardImage, CardBack, cardBackImageUrl, getCardImagePath, type Card } from './CardImage';
import { haptic, soundService } from '../../services/SoundService';
import { getAnimationSpeed, prefersReducedMotion } from '../../utils/animationSpeed';
import {
  cardPresentationEngine,
  detectPlatform,
  FLOP_FAN,
  MOUNT_WINDOW_MARGIN_MS,
  preloadImage,
  SqueezeCard,
  squeezeHostProps,
  boardMaySqueeze,
  type CardAnimationProfile,
  type CardPresentationMode,
  type CommunityStreet,
  type SqueezeHoldState,
} from '../../presentation/cardPresentation';
import {
  CardPresentationDebug,
  isCardPresentationDebugRequested,
} from '../../presentation/cardPresentation/CardPresentationDebug';
import { formatPopupText } from '../../utils/popupStyle';
import './CommunityCards.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type { Card };

export type BoardStage = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

export interface CommunityCardsProps {
  cards: Card[];
  stage: BoardStage;
  /**
   * RABBIT HUNT 2026-08-26: the paid post-hand reveal, rendered into the
   * undealt slots AFTER the stage-derived board. An EXPLICIT prop on purpose:
   * TablePage used to append these into `cards`, and since the visible count
   * derives from the STAGE, a preflop fold (count 0) hid the entire paid
   * reveal. Inferring "trailing cards are rabbit cards" instead would break
   * the double-board bomb pot's hold-flop gate, which deliberately passes
   * dealt cards with stage forced to 'preflop' to keep them hidden. Only this
   * prop ever animates the reference's rabbit flip.
   */
  rabbitCards?: Card[];
  highlightedIndices?: number[];
  winningHandName?: string; // e.g. "Straight" — shown as overlay at showdown
  /**
   * SHOWDOWN SYSTEM 2026-08-25 (spec section 14): descriptive secondary line
   * rendered under the hand name — "Kings Full Of Nines" under "Full House".
   * Engine-generated (describeHand), never composed here.
   */
  winningHandDescription?: string;
  /**
   * SHOWDOWN POLISH 2026-08-25 (spec 33): the low half's own line on a hi-lo
   * split ("Low: 8-6-4-3-2"), rendered under the high hand's label as
   * "LOW WINNER" context. Empty/absent when no low was awarded.
   */
  lowWinnerLabel?: string;
  deckStyle?: '4color' | '2color';
  /**
   * The player's chosen card-back design.
   *
   * AUDIT 2026-08-19: the board had never been told about it. The not-yet-dealt
   * turn/river slots hardcoded 'classic_red', and the face-down flop card added
   * with the two-phase flip fell through to CardBack's own default of
   * 'classic_blue' — so a flop could show three BLUE backs sitting next to two
   * RED ones, and neither matched the back the player actually picked. Every
   * back on the board comes from here now.
   */
  cardBack?: string;
  /**
   * REVIEW FIX 2026-08-19: multi-table gate (#175). This component owns the
   * flop/turn/river sounds + haptics; background tables must stay silent.
   * TablePage passes its ambientSoundsAllowed. Defaults true so the extra
   * RIT run-boards (which never re-fire stage transitions) are unaffected.
   */
  playSounds?: boolean;
  /**
   * POKERBROS PARITY 2026-08-26: true during an all-in runout. Turn and river
   * cards then land FACE DOWN, hold a beat, and flip over - the reference
   * flow's slowed reveal - instead of the normal one-sided spin-in. Normal
   * (non-all-in) streets keep their existing animation.
   *
   * RIVER SQUEEZE 2026-09-04: both all-in streets now run the squeeze with
   * the `all-in` profile (face down, hold to the server's reveal gate, snap
   * over) - see src/presentation/cardPresentation.
   */
  slowReveal?: boolean;
  /**
   * VIP ALL-IN SQUEEZE 2026-09-05 (Dan): THIS viewer may squeeze the run-out
   * open themselves - they are all-in in this hand, hold a VIP card, have
   * the perk on. Computed by the page (viewerMaySqueeze); combined here with
   * `runs` so a Run It Twice board never squeezes whatever the page says.
   * With it false or absent, an all-in runout gets the ordinary street
   * reveal - identical to what every non-squeezing seat sees.
   */
  squeezeEligible?: boolean;
  /** How many times this hand is being run. 1 (default) is the only value that squeezes. */
  runs?: number;
  /**
   * True while THIS viewer's squeezed card is face down under their hand,
   * false the instant the face appears (the engine's reveal beat) or the
   * presentation is interrupted. The page uses it to hold the DISPLAYED
   * equity at the previous street's numbers for this viewer only, so a slow
   * squeeze can outlive the server's equity gate without the percentages
   * spoiling the card (Dan 2026-08-28: the numbers move only after the card
   * is displayed). Nothing on the wire changes.
   */
  onSqueezeHold?: (holding: boolean) => void;
  /**
   * RIVER SQUEEZE 2026-09-04 - presentation identity (spec 14, 31). The
   * engine keys every animation by table + hand + board + street so a
   * duplicate snapshot never animates twice and a stale hand's river never
   * plays on the next hand's board. When TablePage cannot supply these (the
   * sim page, tests) the board falls back to a per-instance lane and a local
   * hand counter, so dedupe still works within the mount.
   */
  tableId?: string;
  handId?: string | number;
  /** 0 = board 1; 1 and 2 for double/triple-board bomb pots; the RIT run index. */
  boardIndex?: number;
  /** Chooses the timing profile. Never inspects tournament economics (spec 28). */
  gameMode?: CardPresentationMode;
  /**
   * Multi-table focus (spec 47): the focused table gets the full profile, a
   * visible background table the compact one. Focus is owned by the
   * multi-table manager; this is only asked, never decided here.
   */
  isFocused?: boolean;
  /** False when the table is mounted but not on screen: the card renders instantly. */
  isVisible?: boolean;
}

/** The engine's answer for one slot: mount the squeeze markup with this profile. */
export interface SqueezePresentation {
  key: string;
  profile: CardAnimationProfile;
  /** Board slot the squeeze belongs to (4 for the river, 3 for the turn). */
  index: number;
}

/* The profile reaches the stylesheet through `squeezeHostProps` in
   src/presentation/cardPresentation/SqueezeCard.tsx - the ONE bridge, shared
   with every other consumer of the squeeze (the hand replay). It used to be a
   local helper here, which meant the replay could not have used it without
   importing the felt's board component. */

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The default for `highlightedIndices`, hoisted to module scope on purpose.
 *
 * AUDIT 2026-08-25: this was an inline `= []` in the parameter list, which
 * builds a NEW array on every render. Two things read its identity - the
 * highlight-pop effect's dependency list, and the `slots` useMemo - so both ran
 * on every single render of the board, at every table, for the entire session.
 * The effect then compared JSON and (correctly) did nothing, and the memo
 * rebuilt five slot objects it did not need to; neither was a visible bug, and
 * that is exactly why it survived. One frozen constant makes the identity
 * stable, so "no highlight" costs nothing.
 */
const NO_HIGHLIGHTS: readonly number[] = Object.freeze([]);

/** Stable no-rabbit default — same identity rule as NO_HIGHLIGHTS above. */
const NO_RABBIT_CARDS: Card[] = Object.freeze([]) as unknown as Card[];

function getVisibleCardCount(stage: BoardStage): number {
  switch (stage) {
    case 'preflop':
      return 0;
    case 'flop':
      return 3;
    case 'turn':
      return 4;
    case 'river':
    case 'showdown':
      return 5;
    default:
      return 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

interface CardFaceProps {
  card: Card;
  index: number;
  isHighlighted: boolean;
  /**
   * POKERBROS PARITY 2026-08-26 (frame-by-frame of the reference recording):
   * the moment the winning five are named, every board card NOT in them drops
   * to ~50% brightness in a single beat, while the winning cards keep full
   * brightness behind their gold border. True exactly when a highlight set
   * exists and this card is not in it.
   */
  isDimmed: boolean;
  isNewlyDealt: boolean;
  stage: BoardStage;
  deckStyle?: '4color' | '2color';
  cardBack?: string;
  /**
   * RIVER SQUEEZE 2026-09-04: the engine's decision for this board. Set when
   * the river (or the all-in turn) was accepted for presentation; null when
   * the engine ruled it a duplicate, stale, or instant - in which case the
   * slot renders its final face with no animation at all (spec 15, 16).
   */
  squeeze: SqueezePresentation | null;
  boardIndex: number;
  /**
   * MOBILE PASS 2026-09-05: still inside the profile's own duration. The
   * mount window outlives the animation by design (so the markup is never
   * torn out mid-flip), and for that remainder the card must stop being a
   * promoted compositor layer. See cardSqueeze.css.
   */
  animating: boolean;
  /** VIP ALL-IN SQUEEZE 2026-09-05: the player's hold on the squeeze, if it is theirs. */
  hold: SqueezeHoldState | null;
  /** The player let go past the threshold: open it. */
  onRelease: () => void;
}

/**
 * How far a drag must travel, as a fraction of the card's own width, to be
 * edge-on (--rs-drag = 1). Under a card width the whole squeeze fits under a
 * thumb without leaving the card, which is what a squeeze feels like.
 */
export const SQUEEZE_DRAG_TRAVEL = 0.9;
/** --rs-drag at which letting go opens the card instead of springing it flat. */
export const SQUEEZE_RELEASE_THRESHOLD = 0.6;

/** Pointer travel -> --rs-drag, clamped. Exported so the arithmetic is pinned. */
export function squeezeDragProgress(dx: number, dy: number, cardWidth: number): number {
  const travel = Math.max(1, cardWidth * SQUEEZE_DRAG_TRAVEL);
  const p = Math.hypot(dx, dy) / travel;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

function CardFace({
  card,
  index,
  isHighlighted,
  isDimmed,
  isNewlyDealt,
  stage,
  deckStyle,
  cardBack,
  squeeze,
  boardIndex,
  animating,
  hold,
  onRelease,
}: CardFaceProps) {
  /* VIP ALL-IN SQUEEZE 2026-09-05: the drag is written straight onto the
     host as --rs-drag (and data-rs-dragging), never through React state - a
     squeeze is a pointermove stream and a re-render per move is a jank
     generator on the phones 95% of players are holding. The engine hears
     exactly one thing from all this: releaseHold(), via onRelease. */
  const hostRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ id: number; x: number; y: number; width: number } | null>(null);
  const progressRef = useRef(0);
  const writeDrag = (value: number) => {
    progressRef.current = value;
    const el = hostRef.current;
    if (el) el.style.setProperty('--rs-drag', value.toFixed(3));
  };
  const setDragging = (on: boolean) => {
    const el = hostRef.current;
    if (el) el.setAttribute('data-rs-dragging', on ? 'on' : 'off');
  };
  const interactiveHold = hold === 'drag';
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!interactiveHold || dragRef.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = e.currentTarget;
    dragRef.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      width: el.getBoundingClientRect().width,
    };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety; the move handler still works on the element */
    }
    setDragging(true);
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    writeDrag(squeezeDragProgress(e.clientX - d.x, e.clientY - d.y, d.width));
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (!cancelled && interactiveHold && progressRef.current >= SQUEEZE_RELEASE_THRESHOLD) {
      onRelease();
      return;
    }
    // Below the threshold (or a cancelled pointer): the card springs flat.
    writeDrag(0);
  };
  // A card whose hold ended (released, or the presentation is over) forgets
  // any drag in flight, so the next hand's card starts flat.
  useEffect(() => {
    if (hold !== 'drag') {
      dragRef.current = null;
      setDragging(false);
    }
  }, [hold]);
  // Only apply animation classes to NEWLY DEALT cards — existing cards stay still
  const isTurnCard = isNewlyDealt && stage === 'turn' && index === 3;
  const isRiverCard = isNewlyDealt && (stage === 'river' || stage === 'showdown') && index === 4;
  const isFlopDeal = isNewlyDealt && stage === 'flop' && index < 3;
  // RIVER SQUEEZE 2026-09-04 / ROUND 2 2026-09-05: the river AND the turn
  // squeeze. The card materialises FACE DOWN in its slot, holds, and snaps
  // over through its edge (the reference recording, frame by frame).
  //
  // The turn used to run ccTurnReveal - a ONE-SIDED face flying in from an
  // offset with a brightness flash, the same shape the river had before the
  // video was measured. Two streets of one hand animating in two different
  // visual languages is exactly what spec 123 forbids, and it also meant the
  // turn had no profile: it ignored the player's table focus and platform.
  // Both streets are the same mechanism now, sized by the same table.
  const isSqueeze = isNewlyDealt && squeeze !== null && squeeze.index === index;
  const host = isSqueeze
    ? squeezeHostProps(squeeze.profile, boardIndex, animating, hold ?? undefined)
    : null;
  const style = (
    host
      ? { ...host.style, '--card-index': index }
      : {
          /* AUDIT FIX 2026-09-05: SCALED. This delay staggers the three flop
             cards as they land, and it was the one number in the fan that
             `--animation-speed` did not touch - its duration was scaled, the
             whole fan-open was scaled, this was not. Card i landed at
             100i + 300s ms while its turn began at (520 + 140i)s ms, so below
             a speed of 0.4 the second and third cards began turning over
             while still in the air - the exact thing the stylesheet's own
             comment says must never happen, at the fastest setting a player
             is allowed to choose (ANIMATION_SPEED_MIN is 0.25). */
          animationDelay: `calc(${index * FLOP_FAN.DEAL_STAGGER_MS}ms * var(--animation-speed, 1))`,
          '--card-index': index,
        }
  ) as React.CSSProperties;

  return (
    <div
      className={[
        'community-cards__card',
        isHighlighted ? 'community-cards__card--highlighted' : '',
        isDimmed ? 'community-cards__card--dimmed' : '',
        isFlopDeal ? 'community-cards__card--flop-deal' : '',
        // --turn and --river are MARKERS the felt's own rules and the e2e
        // beats look for; `card-squeeze-host` is what animates, and it is
        // present only when the engine accepted this card for presentation.
        isTurnCard ? 'community-cards__card--turn' : '',
        isRiverCard ? 'community-cards__card--river' : '',
        host ? host.className : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={style}
      ref={hostRef}
      data-rs-profile={host ? host['data-rs-profile'] : undefined}
      data-rs-sweep={host ? host['data-rs-sweep'] : undefined}
      data-rs-3d={host ? host['data-rs-3d'] : undefined}
      data-rs-animating={host ? host['data-rs-animating'] : undefined}
      data-rs-hold={host ? host['data-rs-hold'] : undefined}
      onPointerDown={host && interactiveHold ? onPointerDown : undefined}
      onPointerMove={host && interactiveHold ? onPointerMove : undefined}
      onPointerUp={host && interactiveHold ? (e) => endDrag(e, false) : undefined}
      onPointerCancel={host && interactiveHold ? (e) => endDrag(e, true) : undefined}
      role={host && interactiveHold ? 'button' : undefined}
      aria-label={host && interactiveHold ? 'Squeeze To Reveal' : undefined}
    >
      {isSqueeze ? (
        /* ROUND 2 2026-09-05: the turn and river share ONE piece of markup
           with every other consumer of the squeeze (the hand replay), so a
           change to the reveal cannot land on the felt and miss the replay.
           Two surfaces on a preserve-3d box, plus the edge spine and the
           shadow layer - see SqueezeCard. */
        <SqueezeCard
          back={<CardBack size="lg" style={cardBack} />}
          face={
            <CardImage
              card={card}
              deckStyle={deckStyle}
              size="lg"
              isHighlighted={isHighlighted}
              /* The board is the most-read thing on the felt and is never
                 off-screen. See CardImage's `loading` note - lazy cost a beat
                 of empty boxes when a MultiTablePage tab was brought forward. */
              loading="eager"
            />
          }
        />
      ) : isFlopDeal ? (
        /*
         * Dan 2026-08-19, bug list item 5: "flops must deal 3 cards face down
         * then fan open (animation), not just appear."
         *
         * The old flop animation spun the card in from rotateY(180deg), but
         * there was only ever ONE element - the FACE. So the first half of that
         * spin showed the face mirrored, not a card back, and the card was
         * legible before it landed. It read as "the cards just appear".
         *
         * A real flip needs two surfaces. This renders the back and the front
         * as separate faces of one preserve-3d box with backface-visibility
         * hidden, so exactly one is ever visible. CSS then runs it in two
         * phases: all three land face DOWN, and only once they are down do they
         * fan open left to right. See .community-cards__flip in the stylesheet.
         *
         * The flop keeps its OWN markup on purpose: it is a three-card fan
         * with a per-card stagger, not a single-card squeeze, and merging the
         * two would put a stagger nothing else uses into the shared piece.
         */
        <div className="community-cards__flip">
          <div className="community-cards__flip-face community-cards__flip-face--back">
            <CardBack size="lg" style={cardBack} />
          </div>
          <div className="community-cards__flip-face community-cards__flip-face--front">
            <CardImage
              card={card}
              deckStyle={deckStyle}
              size="lg"
              isHighlighted={isHighlighted}
              loading="eager"
            />
          </div>
        </div>
      ) : (
        <CardImage card={card} deckStyle={deckStyle} size="lg" isHighlighted={isHighlighted} />
      )}
      {/* Highlight Glow */}
      {isHighlighted && <div className="community-cards__highlight-glow" />}
    </div>
  );
}

interface RabbitCardProps {
  card: Card;
  index: number;
  deckStyle?: '4color' | '2color';
  cardBack?: string;
}

/**
 * RABBIT HUNT REVEAL — POKERBROS PARITY 2026-08-26, from a frame-by-frame pass
 * over the reference recording (RABBIT HUNT.MOV, 26-Aug PLO5 preflop fold):
 *
 *   frame 0        every undealt slot shows a card BACK, full size, in a hard
 *                  cut — no slide, no scale-in, no stagger. All backs land in
 *                  the same video frame the tap registers.
 *   ~120ms hold    the backs sit face down (about 4 frames at 30fps).
 *   ~170ms flip    ALL cards turn over TOGETHER — a horizontal edge-on flip
 *                  (rotateY), never one-by-one. There is no dealing animation
 *                  and no winner highlight; the hand ended on a fold.
 *   ~70ms settle   the faces overshoot slightly larger and settle.
 *
 * The revealed board then simply stays until the next hand clears it.
 *
 * Two real surfaces (back + face) on a preserve-3d box, exactly like the flop
 * flip above — a one-sided element would show a mirrored face mid-turn. The
 * resting transform is FACE UP so reduced-motion players just see the cards.
 */
function RabbitCard({ card, index, deckStyle, cardBack }: RabbitCardProps) {
  return (
    <div
      className="community-cards__card community-cards__card--rabbit"
      style={{ '--card-index': index } as React.CSSProperties}
    >
      <div className="community-cards__rabbit-flip">
        <div className="community-cards__flip-face community-cards__flip-face--back">
          <CardBack size="lg" style={cardBack} />
        </div>
        <div className="community-cards__flip-face community-cards__flip-face--front">
          <CardImage card={card} deckStyle={deckStyle} size="lg" loading="eager" />
        </div>
      </div>
    </div>
  );
}

/* `PlaceholderCard` was deleted 2026-08-26 with the ghost turn/river slots it
   drew (Dan: "remove the ghost place holders for the turn and river that
   appear after the flop"). Nothing rendered it afterwards. */

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

function CommunityCardsComponent({
  cards,
  stage,
  rabbitCards = NO_RABBIT_CARDS,
  highlightedIndices = NO_HIGHLIGHTS as number[],
  winningHandName,
  winningHandDescription,
  lowWinnerLabel,
  deckStyle,
  cardBack,
  playSounds = true,
  slowReveal = false,
  squeezeEligible = false,
  runs = 1,
  onSqueezeHold,
  tableId,
  handId,
  boardIndex = 0,
  gameMode = 'cash',
  isFocused = true,
  isVisible = true,
}: CommunityCardsProps) {
  const visibleCount = useMemo(() => getVisibleCardCount(stage), [stage]);
  // RIVER SQUEEZE 2026-09-04: a board without a real table id (sim page,
  // tests) still needs a lane of its own so two boards never share keys.
  const instanceId = useId();
  const laneTableId = tableId ?? `local${instanceId}`;
  /** Counts hands locally when TablePage supplies no hand number. */
  const localHandRef = useRef(0);
  /**
   * The key of the presentation in flight on this board, for interrupts.
   *
   * AUDIT FIX 2026-09-05: this used to be set only for a turn or a river.
   * A flop created an engine entry with two live timers and a held lane and
   * then stored its key NOWHERE, so unmounting a table mid-flop left both
   * timers running against a destroyed component and reported a completed
   * animation for a board that no longer existed. Every street registers now.
   */
  const activeSqueezeRef = useRef<string | null>(null);
  /**
   * ROUND 2 2026-09-05 - THE SNAP LANDS WHEN THE CARD DOES.
   *
   * The cue used to fire on the STAGE TRANSITION, which is the moment the
   * server says the street exists. On a normal street that is close enough to
   * the card appearing that nobody could tell. On an all-in runout it is a
   * full second early: the card is still lying face down while the sound says
   * it landed. In the reference recording the snap belongs to the frame the
   * face appears - the edge-on instant, where the two surfaces swap.
   *
   * So the cue is OWED at the stage transition and PAID at the engine's
   * `reveal` beat. `snapOwedRef` is what makes that safe: it is set when the
   * street arrives and cleared only when the sound actually plays, so a
   * cancelled or interrupted squeeze still pays it (the card is on screen by
   * then, and the law is that every cue plays every time it is owed).
   */
  const snapOwedRef = useRef<{
    key: string | null;
    strength: 'light' | 'medium';
    /* AUDIT FIX 2026-09-05: the resolved profile's own say on audio. It was
       declared on every profile and read by nothing, so
       `background.audioEnabled: false` claimed an unfocused tile was silent
       when only the `playSounds` prop made it so. Both gates apply now, and
       the field is no longer a claim nothing has to honour. */
    audioEnabled: boolean;
  } | null>(null);
  /** The squeeze whose reveal beat the owed snap is waiting on, if any. */
  const pendingRevealKeyRef = useRef<string | null>(null);
  const playSoundsRef = useRef(playSounds);
  playSoundsRef.current = playSounds;
  const payStreetSnap = () => {
    const owed = snapOwedRef.current;
    if (!owed) return;
    snapOwedRef.current = null;
    if (!playSoundsRef.current || !owed.audioEnabled) return;
    if (owed.strength === 'medium') haptic.medium();
    else haptic.light();
    if (soundService.isEnabled()) soundService.playCommunityCard();
  };
  const [squeeze, setSqueeze] = useState<SqueezePresentation | null>(null);
  /**
   * VIP ALL-IN SQUEEZE 2026-09-05: the player's hold on the squeeze in
   * flight. `drag` from the moment an interactive presentation starts,
   * `released` when they open it or the ceiling does, null otherwise.
   */
  const [squeezeHold, setSqueezeHold] = useState<SqueezeHoldState | null>(null);
  const onSqueezeHoldRef = useRef(onSqueezeHold);
  onSqueezeHoldRef.current = onSqueezeHold;
  const holdingRef = useRef(false);
  /** Tell the page once per edge, never twice for the same state. */
  const announceHold = (holding: boolean) => {
    if (holdingRef.current === holding) return;
    holdingRef.current = holding;
    onSqueezeHoldRef.current?.(holding);
  };
  const releaseSqueeze = () => {
    const key = activeSqueezeRef.current;
    if (!key) return;
    // The engine re-bases its clock; the `squeeze` beat it announces flips
    // the host to 'released' in the listener below, on the same path the
    // ceiling takes, so there is exactly one way the snap starts.
    cardPresentationEngine.releaseHold(key);
  };
  /** The profile the stage effect must read - state has not committed yet. */
  const squeezeProfileRef = useRef<CardAnimationProfile | null>(null);
  /**
   * MOBILE PASS 2026-09-05: true only while the flip is actually running.
   * The mount window deliberately OUTLIVES the animation so the markup is
   * never torn out mid-flip - but for that remainder the card should not go
   * on being a promoted compositor layer. This flips false on the engine's
   * `complete` beat, which is the earliest moment anything can know the
   * animation is finished, and the CSS drops `will-change` with it.
   */
  const [animating, setAnimating] = useState(false);
  const cancelActiveSqueeze = (reason: string) => {
    if (activeSqueezeRef.current) {
      cardPresentationEngine.cancel(activeSqueezeRef.current, reason);
      activeSqueezeRef.current = null;
    }
  };
  /**
   * RABBIT HUNT 2026-08-26: how many reveal cards fit in the undealt slots.
   * Before the explicit prop, the reveal was appended into `cards` — and since
   * the visible count derives from the STAGE, a preflop fold (count 0) hid the
   * entire paid reveal: the player paid and saw nothing.
   */
  const rabbitCount = Math.max(0, Math.min(rabbitCards.length, 5 - visibleCount));
  const prevStageRef = useRef(stage);
  const prevVisibleCountRef = useRef(visibleCount);
  const [showdownMode, setShowdownMode] = useState(false);
  const [newlyDealtIndices, setNewlyDealtIndices] = useState<Set<number>>(new Set());
  /** When the current newly-dealt window opened (see re-arm branch below). */
  const dealtAtRef = useRef(0);
  const [stageLabel, setStageLabel] = useState<string | null>(null);

  /* FIX 184 removed a duplicate haptic here; what it left behind was an
     effect whose whole body wrote `prevCardCountRef`, which nothing ever
     read. AUDIT 2026-09-05: both are gone. */

  // Track newly dealt cards — only new cards get deal animation, existing cards stay still
  useEffect(() => {
    const prevCount = prevVisibleCountRef.current;
    // 700ms used to be enough, but the two-phase flop (land face down, then
    // fan open) runs to ~1.22s. Clearing at 700ms tore the flip markup out
    // mid-flip and the board snapped to face-up. Turn/river animations are
    // `forwards` and already finished by then, so the longer window costs
    // them nothing.
    // IMPROVEMENT PASS 2026-08-19: the window scales with --animation-speed,
    // the same multiplier the keyframes use — a slowed table no longer has
    // its flip markup torn out mid-animation.
    // POKERBROS PARITY 2026-08-26: the slowed all-in turn/river flip (land
    // face down 0.75s hold, then a 0.5s turn) outlives the normal 1.4s
    // window; tearing its markup out mid-flip snaps the card face-up, the
    // exact defect the longer flop window fixed.
    // RIVER SQUEEZE 2026-09-04: the 1.8s slow-reveal window is gone with the
    // slow-reveal class. The squeeze asks the engine for its own window below
    // and takes the larger of the two, so the flip markup always outlives the
    // CSS (the profile total plus MOUNT_WINDOW_MARGIN_MS, times the speed).
    const speed = getAnimationSpeed();
    let windowMs = Math.round(1400 * speed);
    const closeWindow = () => {
      setNewlyDealtIndices(new Set());
      setSqueeze(null);
      setSqueezeHold(null);
      setAnimating(false);
      activeSqueezeRef.current = null;
      announceHold(false);
    };
    if (visibleCount > prevCount) {
      // New cards appeared — mark them as newly dealt
      const newIndices = new Set<number>();
      for (let i = prevCount; i < visibleCount; i++) {
        newIndices.add(i);
      }
      // The engine decides whether THIS card animates at all (duplicate /
      // stale / hidden table -> the slot renders its final face) and which
      // profile it gets. It never decides anything about the hand.
      const street: CommunityStreet =
        visibleCount >= 5 ? 'river' : visibleCount === 4 ? 'turn' : 'flop';
      // ROUND 2 2026-09-05: the TURN squeezes too, on every hand and not only
      // an all-in runout. The flop keeps its own three-card fan.
      //
      // PHASE 2 2026-09-05: but EVERY street is presented through the engine
      // now, the flop included. The flop's fan is unchanged - it is still its
      // own two-phase land-and-open, and it still sounds its three staggered
      // snaps on the street rather than on a reveal beat that does not match
      // its shape. What it gains is everything the engine owns and the flop
      // never had: an identity (so a resync cannot re-fan a flop that is
      // already on the felt), the hidden-table rule (spec 47 - a board nobody
      // can see does not animate), the out-of-order guard, and telemetry.
      // Spec 58 asked for exactly this: the pipeline is street-generic, and
      // the river was only the first animation to use it.
      const squeezes = street === 'river' || street === 'turn';
      {
        const slot = visibleCount - 1;
        const result = cardPresentationEngine.presentCard(
          {
            tableId: laneTableId,
            handId: handId ?? localHandRef.current,
            boardIndex,
            street,
            slotIndex: slot,
            sequence: visibleCount,
          },
          {
            mode: gameMode,
            platform: detectPlatform(),
            focus: !isVisible ? 'hidden' : isFocused ? 'focused' : 'visible',
            reducedMotion: prefersReducedMotion(),
            allIn: slowReveal,
            // VIP ALL-IN SQUEEZE 2026-09-05: the viewer's right, AND the
            // board's - a re-run board never squeezes (Dan: "SHOULD NEVER
            // APPEAR ON RUN IT 2X OR 3X"), whatever the page computed.
            squeeze: boardMaySqueeze(squeezeEligible, runs),
          }
        );
        if (result.status === 'started') {
          /* PHASE 2 2026-09-05 (spec 41, 42): decode the faces this reveal is
             about to show, NOW, off to the side. A card face is behind
             `backface-visibility: hidden` for the first half of a turn, so a
             warm cache never notices - but a cold one (a deck the player has
             never been dealt, the first hand after a deploy rehashed every
             asset) can deliver the bitmap AFTER the surfaces swap, and the
             card turns over to an empty box. Fire and forget: nothing waits
             on it, least of all the hand. */
          for (let i = prevCount; i < visibleCount; i++) {
            if (cards[i]) preloadImage(getCardImagePath(cards[i], deckStyle));
          }
          preloadImage(cardBackImageUrl(cardBack));
          windowMs = Math.max(windowMs, Math.round(result.durationMs * speed));
          // EVERY street registers, so an interrupt can reach a flop too.
          activeSqueezeRef.current = result.key;
          if (squeezes) {
            // The stage effect below runs after this one on the same commit
            // and reads this key: a squeeze in flight owes its snap to the
            // reveal beat rather than to the street transition.
            pendingRevealKeyRef.current = result.key;
            squeezeProfileRef.current = result.profile;
            setAnimating(true);
            setSqueeze({ key: result.key, profile: result.profile, index: slot });
            if (result.profile.interactive) {
              setSqueezeHold('drag');
              announceHold(true);
            } else {
              setSqueezeHold(null);
            }
          } else {
            // A flop pays its three snaps on the street, not on a reveal beat
            // that does not describe its shape - nothing is owed to a key.
            pendingRevealKeyRef.current = null;
            squeezeProfileRef.current = result.profile;
          }
        } else if (squeezes) {
          // Duplicate / stale / hidden: the card is simply on screen, so the
          // cue has nothing to wait for.
          pendingRevealKeyRef.current = null;
          squeezeProfileRef.current = null;
          newIndices.delete(slot);
          setSqueeze(null);
        } else {
          // The FLOP was refused. Every one of its three cards renders
          // statically - a fan that plays for a board nobody can see, or
          // twice for one deal, is the thing the engine exists to stop.
          newIndices.clear();
        }
      }
      dealtAtRef.current = Date.now();
      setNewlyDealtIndices(newIndices);
      const timer = setTimeout(closeWindow, windowMs);
      prevVisibleCountRef.current = visibleCount;
      return () => clearTimeout(timer);
    }
    // ANIMATION AUDIT 2026-08-27: `slowReveal` flips true when the FIRST
    // all-in equity broadcast lands — often inside the newly-dealt window.
    // The dep change re-ran this effect, the cleanup cancelled the pending
    // clear, and neither count branch rescheduled it (count unchanged), so
    // the deal-in class stayed welded to those board cards until the next
    // street. Re-arm the clear for the REMAINDER of the window.
    if (visibleCount === prevCount && newlyDealtIndices.size > 0) {
      // A squeeze in flight keeps its own, possibly longer, window.
      if (squeeze) {
        windowMs = Math.max(
          windowMs,
          Math.round((squeeze.profile.durationMs + MOUNT_WINDOW_MARGIN_MS) * speed)
        );
      }
      const remaining = Math.max(50, dealtAtRef.current + windowMs - Date.now());
      const timer = setTimeout(closeWindow, remaining);
      return () => clearTimeout(timer);
    }
    if (visibleCount < prevCount) {
      // New hand started — all visible cards are new
      // RIVER SQUEEZE 2026-09-04 (spec 66): a squeeze still in flight from
      // the last hand is interrupted; the new board is the authoritative one.
      cancelActiveSqueeze('new-hand');
      setSqueeze(null);
      setSqueezeHold(null);
      announceHold(false);
      localHandRef.current += 1;
      prevVisibleCountRef.current = visibleCount;
      if (visibleCount > 0) {
        const newIndices = new Set<number>();
        for (let i = 0; i < visibleCount; i++) {
          newIndices.add(i);
        }
        dealtAtRef.current = Date.now();
        setNewlyDealtIndices(newIndices);
        const timer = setTimeout(closeWindow, windowMs);
        return () => clearTimeout(timer);
      }
    }
    prevVisibleCountRef.current = visibleCount;
    // newlyDealtIndices is in the deps ONLY so the re-arm branch above runs
    // after a mid-window dep change; the set-then-clear cycle terminates
    // because the clear writes an empty set (size 0 skips the branch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleCount, slowReveal, newlyDealtIndices]);

  // RIVER SQUEEZE 2026-09-04 (spec 66): a table that leaves the screen mid
  // squeeze renders its final card; nothing half-flipped is ever left behind.
  useEffect(() => {
    if (!isVisible && activeSqueezeRef.current) {
      cancelActiveSqueeze('hidden');
      setSqueeze(null);
    }
  }, [isVisible]);

  // Unmount: release the engine's timer and reference (spec 99, 100).
  useEffect(() => {
    return () => {
      cancelActiveSqueeze('unmount');
    };
  }, []);

  /**
   * ROUND 2 2026-09-05: pay the owed snap on the engine's `reveal` beat - the
   * edge-on instant where the face appears. `cancelled` pays it too: an
   * interrupted squeeze renders the authoritative card immediately, and a
   * card that appears in silence is the cue being dropped (CLAUDE.md 10.6).
   */
  useEffect(() => {
    return cardPresentationEngine.subscribe(({ key, phase }) => {
      if (key !== activeSqueezeRef.current && key !== pendingRevealKeyRef.current) return;
      if (phase === 'cancelled') {
        // AUDIT FIX 2026-09-05 - A CANCEL MUST REACH THE PIXELS.
        //
        // This listener used to do one thing: play the sound. So when the
        // engine cancelled a presentation - a window resize, an orientation
        // change, the tab backgrounded, all of which exist precisely to STOP
        // an animation running against geometry that has moved - the engine
        // dropped its entry and the browser carried on running the flip to
        // completion on the old geometry. The interrupts were, visibly,
        // inert. Worse, the cue was paid at that moment on the stated
        // reasoning that "an interrupted squeeze renders the authoritative
        // card immediately", which was not true: on an all-in river the snap
        // landed up to 750ms before the face appeared - the exact defect the
        // owed/paid mechanism was written to fix.
        //
        // Cancelling unmounts the temporary markup now, which drops the card
        // to its authoritative face-up state on the next paint, and only then
        // pays the cue. Clearing the newly-dealt set covers the FLOP too.
        activeSqueezeRef.current = null;
        setSqueeze(null);
        setSqueezeHold(null);
        setAnimating(false);
        setNewlyDealtIndices((prev) => (prev.size === 0 ? prev : new Set()));
      }
      // VIP ALL-IN SQUEEZE 2026-09-05: the hold ended - by the player's hand
      // (releaseHold) or by the ceiling (the engine's hold timer). Either way
      // the host swaps the drag transform for the snap keyframes here, and
      // the page's equity hold lifts on the reveal beat that follows, when
      // the face is actually on screen.
      if (phase === 'squeeze' && key === activeSqueezeRef.current) {
        setSqueezeHold((h) => (h === 'drag' ? 'released' : h));
      }
      if (phase === 'reveal' || phase === 'complete' || phase === 'cancelled') announceHold(false);
      // The flip is over: stop paying for a compositor layer (see above).
      if (phase === 'complete' || phase === 'cancelled') setAnimating(false);
      if (key !== pendingRevealKeyRef.current) return;
      if (phase !== 'reveal' && phase !== 'cancelled' && phase !== 'complete') return;
      pendingRevealKeyRef.current = null;
      payStreetSnap();
    });
  }, []);

  // Bible V8 §5.1: Stage label + haptic feedback on stage transitions
  useEffect(() => {
    if (stage !== prevStageRef.current) {
      // UI-AUDIT #5: showdownMode was only ever set true and never reset, so the
      // board kept the showdown styling for the rest of the session (all later
      // hands). Clear it on any transition to a pre-showdown street (a new hand
      // returns the board to preflop/flop).
      if (stage !== 'showdown') setShowdownMode(false);
      // Show stage label briefly when new community cards are dealt
      let labelTimer: ReturnType<typeof setTimeout> | undefined;
      if (stage === 'flop' || stage === 'turn' || stage === 'river') {
        setStageLabel(stage.toUpperCase());
        labelTimer = setTimeout(() => setStageLabel(null), 1500);
      } else {
        setStageLabel(null);
      }

      if (stage === 'flop') {
        if (playSounds) haptic.medium();
        // Bible V8 §5.3: Per-card deal sound — stagger 3 snaps for flop
        if (playSounds && soundService.isEnabled()) {
          soundService.playCommunityCard();
          setTimeout(() => soundService.playCommunityCard(), 120);
          setTimeout(() => soundService.playCommunityCard(), 240);
        }
      } else if (stage === 'turn' || stage === 'river') {
        // ROUND 2 2026-09-05: OWED here, PAID at the reveal beat (see
        // snapOwedRef). With no squeeze in flight - a duplicate, a hidden
        // table, reduced motion collapsing the flip - it is paid on the spot,
        // so the cue is never dropped and never doubled.
        snapOwedRef.current = {
          key: pendingRevealKeyRef.current,
          strength: stage === 'river' ? 'medium' : 'light',
          audioEnabled: squeezeProfileRef.current?.audioEnabled ?? true,
        };
        if (!pendingRevealKeyRef.current) payStreetSnap();
      } else if (stage === 'showdown') {
        // POKERBROS PARITY 2026-08-26 (frame-by-frame of the reference
        // recording): showdown is a HARD CUT. The reference has no screen
        // shake, no spark burst and no scale pop at any point in the winner
        // sequence — the old triggerScreenShake + ParticleSystem beats here
        // were motion the reference does not have. The haptic stays: it is
        // physical feedback, not something on screen.
        if (playSounds) haptic.strong();
        setShowdownMode(true);
      }
      prevStageRef.current = stage;
      return () => {
        if (labelTimer) clearTimeout(labelTimer);
      };
    }
  }, [stage]);

  // POKERBROS PARITY 2026-08-26: the highlight-pop state machine is gone.
  // A measured frame-by-frame pass of the reference recording shows the
  // winner state is a single-frame hard cut — no pop, no ramp — so there is
  // nothing left for a timer to drive.

  // RABBIT HUNT 2026-08-26: one snap + a light haptic when the reveal lands.
  // ONE beat, not per-card — the reference turns all cards over in the same
  // frame, so five staggered snaps would invent a deal that never happened.
  const prevRabbitCountRef = useRef(0);
  useEffect(() => {
    if (rabbitCount > 0 && prevRabbitCountRef.current === 0) {
      if (playSounds) {
        haptic.light();
        if (soundService.isEnabled()) soundService.playCommunityCard();
      }
    }
    prevRabbitCountRef.current = rabbitCount;
  }, [rabbitCount, playSounds]);

  // Create array of 5 slots
  const slots = useMemo(() => {
    return Array.from({ length: 5 }).map((_, i) => {
      if (i < visibleCount && cards[i]) {
        return {
          type: 'card' as const,
          card: cards[i],
          isHighlighted: highlightedIndices.includes(i),
          // POKERBROS PARITY 2026-08-26: a highlight set dims every card
          // outside it — the two states arrive together, in the same frame.
          isDimmed: highlightedIndices.length > 0 && !highlightedIndices.includes(i),
          isNewlyDealt: newlyDealtIndices.has(i),
        };
      }
      // RABBIT HUNT 2026-08-26: the paid reveal fills the undealt slots.
      if (i < visibleCount + rabbitCount && rabbitCards[i - visibleCount]) {
        return {
          type: 'rabbit' as const,
          card: rabbitCards[i - visibleCount],
          isNewlyDealt: false,
        };
      }
      return { type: 'placeholder' as const, isNewlyDealt: false };
    });
  }, [cards, visibleCount, rabbitCards, rabbitCount, highlightedIndices, newlyDealtIndices]);

  return (
    <div
      className={`community-cards ${showdownMode ? 'community-cards--showdown' : ''}`}
      role="region"
      aria-label={`Community Cards: ${cards.length > 0 ? cards.map((c) => `${c.rank} of ${c.suit}`).join(', ') : 'None Dealt'}${rabbitCount > 0 ? `; Rabbit Hunt: ${rabbitCards.map((c) => `${c.rank} of ${c.suit}`).join(', ')}` : ''}${winningHandName ? ` - ${winningHandName}` : ''}`}
    >
      {/* Bible V8 §5.1: Stage label (FLOP/TURN/RIVER) — fades in briefly when cards are dealt */}
      {stageLabel && (
        <div className="community-cards__stage-label" aria-live="polite">
          {stageLabel}
        </div>
      )}
      {/* AUDIT 2026-08-20 (dead animation): this used to put
          `community-cards__container--highlight-pop` on the CONTAINER. The
          stylesheet only ever defined `.community-cards__card--highlight-pop`
          (note: card, not container) — its own comment says "applied via JS" —
          so the winning-hand card pop had NEVER fired in production. The class
          is applied to the highlighted CARDS now, which is what the keyframe
          was written for. */}
      <div className="community-cards__container">
        {slots.map((slot, i) =>
          slot.type === 'rabbit' ? (
            // RABBIT HUNT 2026-08-26: renders even at stage 'preflop' — the
            // reveal exists precisely because the hand ended before these
            // cards were dealt, so the preflop placeholder suppression below
            // must not apply to it.
            <RabbitCard
              key={`rabbit-${i}`}
              card={slot.card}
              index={i}
              deckStyle={deckStyle}
              cardBack={cardBack}
            />
          ) : slot.type === 'card' ? (
            <CardFace
              key={`card-${i}`}
              card={slot.card}
              index={i}
              isHighlighted={slot.isHighlighted}
              isDimmed={slot.isDimmed}
              isNewlyDealt={slot.isNewlyDealt}
              stage={stage}
              deckStyle={deckStyle}
              cardBack={cardBack}
              squeeze={squeeze}
              boardIndex={boardIndex}
              animating={animating}
              hold={squeezeHold}
              onRelease={releaseSqueeze}
            />
          ) : (
            /* Dan 2026-08-26: "remove the ghost placeholders for the turn
               and river that appear after the flop." They stay removed: an
               undealt slot DRAWS nothing - no dashed outline, no card shape.

               RIVER SQUEEZE 2026-09-04 (spec 11): it does keep its GEOMETRY.
               With nothing at all in the slot the centred row slid left by
               half a card when the turn landed and again on the river, the
               stage separators (60% / 80% of the row) only lined up once all
               five were out, and the community area's own height changed
               street to street. The reserve is visibility:hidden, so the
               river materialises in a slot that was always there and nothing
               else on the felt moves to make room. */
            <div
              key={`reserve-${i}`}
              className="community-cards__slot-reserve"
              aria-hidden="true"
            />
          )
        )}
      </div>

      {/* RIVER SQUEEZE 2026-09-04 (spec 111): dev-only overlay, ?rsDebug. */}
      {import.meta.env.DEV && isCardPresentationDebugRequested() && (
        <CardPresentationDebug boardIndex={boardIndex} />
      )}

      {/* Separator Lines */}
      {visibleCount >= 3 && (
        <>
          <div className="community-cards__separator community-cards__separator--flop" />
          {visibleCount >= 4 && (
            <div className="community-cards__separator community-cards__separator--turn" />
          )}
        </>
      )}

      {/* Winning Hand Name — premium-style "Straight" label below community cards */}
      {winningHandName && (
        <div className="community-cards__hand-name">
          {/* POKERBROS PARITY 2026-08-26: the name is its own span so the
              band background (parent) and the gold gradient fill
              (background-clip: text on this span) can coexist.
              HOUSE RULE (Dan 2026-08-26): every forward-facing display
              capitalizes the first letter of every word — the evaluator says
              "Three of a Kind", the screen says "Three Of A Kind". Applied
              at render through the same central transform the Toast layer
              uses, so data-level hand names stay untouched. */}
          <span className="community-cards__hand-name-text">
            {formatPopupText(winningHandName)}
          </span>
          {/* SHOWDOWN SYSTEM 2026-08-25 (spec section 14): the secondary
              descriptive line — smaller, under the classification. */}
          {winningHandDescription && (
            <div className="community-cards__hand-description">
              {formatPopupText(winningHandDescription)}
            </div>
          )}
          {/* SHOWDOWN POLISH 2026-08-25 (spec 33): the hi-lo split's low
              half gets its own line so HIGH WINNER and LOW WINNER are
              visually distinguished. The engine's low name is already
              self-describing ("Low: 8-6-4-3-2"). */}
          {lowWinnerLabel && (
            <div className="community-cards__low-winner">{formatPopupText(lowWinnerLabel)}</div>
          )}
        </div>
      )}
    </div>
  );
}

export const CommunityCards = memo(CommunityCardsComponent, (prev, next) => {
  // Return true if props are equal (skip re-render)
  if (prev.stage !== next.stage) return false;
  if (prev.winningHandName !== next.winningHandName) return false;
  // SHOWDOWN SYSTEM 2026-08-25: the secondary description line must re-render.
  if (prev.winningHandDescription !== next.winningHandDescription) return false;
  // SHOWDOWN POLISH 2026-08-25: the hi-lo low line must re-render too.
  if (prev.lowWinnerLabel !== next.lowWinnerLabel) return false;
  if (prev.deckStyle !== next.deckStyle) return false;
  if (prev.playSounds !== next.playSounds) return false;
  // POKERBROS PARITY 2026-08-26: the all-in mode changes which
  // animation the next street gets - it must invalidate the memo.
  if (prev.slowReveal !== next.slowReveal) return false;
  // VIP ALL-IN SQUEEZE 2026-09-05: the viewer's right and the run count feed
  // the engine's decision for the NEXT street; the hold callback is read
  // through a ref and needs no invalidation.
  if (prev.squeezeEligible !== next.squeezeEligible) return false;
  if (prev.runs !== next.runs) return false;
  // RIVER SQUEEZE 2026-09-04: identity and focus feed the engine's decision.
  if (prev.tableId !== next.tableId) return false;
  if (prev.handId !== next.handId) return false;
  if (prev.boardIndex !== next.boardIndex) return false;
  if (prev.gameMode !== next.gameMode) return false;
  if (prev.isFocused !== next.isFocused) return false;
  if (prev.isVisible !== next.isVisible) return false;
  // AUDIT-2 FIX 2026-08-20: cardBack was missing — it was added as a prop
  // specifically to stop mismatched backs, but changing the deck in settings
  // left the board's placeholders and the face-down flop on the OLD back
  // until some unrelated prop happened to change.
  if (prev.cardBack !== next.cardBack) return false;
  if (JSON.stringify(prev.cards) !== JSON.stringify(next.cards)) return false;
  // RABBIT HUNT 2026-08-26: the reveal arrives as its own prop; without this
  // compare the memo swallowed the reveal and the paid cards never painted.
  if (JSON.stringify(prev.rabbitCards ?? []) !== JSON.stringify(next.rabbitCards ?? []))
    return false;
  if (JSON.stringify(prev.highlightedIndices) !== JSON.stringify(next.highlightedIndices))
    return false;
  return true;
});

export default CommunityCards;
