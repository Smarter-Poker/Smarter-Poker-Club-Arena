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

import React, { useMemo, useEffect, useRef, useState, memo } from 'react';
import { CardImage, CardBack, type Card } from './CardImage';
import { haptic, soundService } from '../../services/SoundService';
import { getAnimationSpeed } from '../../utils/animationSpeed';
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
   */
  slowReveal?: boolean;
}

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
  /** All-in runout: turn/river land face down and flip (see the prop note). */
  slowReveal?: boolean;
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
  slowReveal = false,
}: CardFaceProps) {
  // Only apply animation classes to NEWLY DEALT cards — existing cards stay still
  const isTurnCard = isNewlyDealt && stage === 'turn' && index === 3;
  const isRiverCard = isNewlyDealt && (stage === 'river' || stage === 'showdown') && index === 4;
  const isFlopDeal = isNewlyDealt && stage === 'flop' && index < 3;
  // POKERBROS PARITY 2026-08-26: the slowed all-in reveal replaces the normal
  // turn/river spin with the two-surface land-then-flip the flop already has.
  // Both use the .community-cards__flip markup; the slow-reveal class retimes
  // it (land face down, hold, flip) - see the stylesheet.
  const isSlowFlip = slowReveal && (isTurnCard || isRiverCard);

  return (
    <div
      className={[
        'community-cards__card',
        isHighlighted ? 'community-cards__card--highlighted' : '',
        isDimmed ? 'community-cards__card--dimmed' : '',
        isFlopDeal ? 'community-cards__card--flop-deal' : '',
        isTurnCard && !isSlowFlip ? 'community-cards__card--turn' : '',
        isRiverCard && !isSlowFlip ? 'community-cards__card--river' : '',
        isSlowFlip ? 'community-cards__card--slow-reveal' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ animationDelay: `${index * 100}ms`, '--card-index': index } as React.CSSProperties}
    >
      {isFlopDeal || isSlowFlip ? (
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
              /* The board is the most-read thing on the felt and is never
                 off-screen. See CardImage's `loading` note - lazy cost a beat
                 of empty boxes when a MultiTablePage tab was brought forward. */
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
}: CommunityCardsProps) {
  const visibleCount = useMemo(() => getVisibleCardCount(stage), [stage]);
  /**
   * RABBIT HUNT 2026-08-26: how many reveal cards fit in the undealt slots.
   * Before the explicit prop, the reveal was appended into `cards` — and since
   * the visible count derives from the STAGE, a preflop fold (count 0) hid the
   * entire paid reveal: the player paid and saw nothing.
   */
  const rabbitCount = Math.max(0, Math.min(rabbitCards.length, 5 - visibleCount));
  const prevStageRef = useRef(stage);
  const prevCardCountRef = useRef(cards.length);
  const prevVisibleCountRef = useRef(visibleCount);
  const [showdownMode, setShowdownMode] = useState(false);
  const [newlyDealtIndices, setNewlyDealtIndices] = useState<Set<number>>(new Set());
  /** When the current newly-dealt window opened (see re-arm branch below). */
  const dealtAtRef = useRef(0);
  const [stageLabel, setStageLabel] = useState<string | null>(null);

  // FIX 184: Removed duplicate haptic here — stage transition useEffect below already
  // fires haptic on flop/turn/river. Having both caused double-haptic on every deal.
  // Track card count for reference only (no haptic).
  useEffect(() => {
    prevCardCountRef.current = cards.length;
  }, [cards.length]);

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
    const windowMs = Math.round((slowReveal ? 1800 : 1400) * getAnimationSpeed());
    if (visibleCount > prevCount) {
      // New cards appeared — mark them as newly dealt
      const newIndices = new Set<number>();
      for (let i = prevCount; i < visibleCount; i++) {
        newIndices.add(i);
      }
      dealtAtRef.current = Date.now();
      setNewlyDealtIndices(newIndices);
      const timer = setTimeout(() => setNewlyDealtIndices(new Set()), windowMs);
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
      const remaining = Math.max(50, dealtAtRef.current + windowMs - Date.now());
      const timer = setTimeout(() => setNewlyDealtIndices(new Set()), remaining);
      return () => clearTimeout(timer);
    }
    if (visibleCount < prevCount) {
      // New hand started — all visible cards are new
      prevVisibleCountRef.current = visibleCount;
      if (visibleCount > 0) {
        const newIndices = new Set<number>();
        for (let i = 0; i < visibleCount; i++) {
          newIndices.add(i);
        }
        dealtAtRef.current = Date.now();
        setNewlyDealtIndices(newIndices);
        const timer = setTimeout(() => setNewlyDealtIndices(new Set()), windowMs);
        return () => clearTimeout(timer);
      }
    }
    prevVisibleCountRef.current = visibleCount;
    // newlyDealtIndices is in the deps ONLY so the re-arm branch above runs
    // after a mid-window dep change; the set-then-clear cycle terminates
    // because the clear writes an empty set (size 0 skips the branch).
  }, [visibleCount, slowReveal, newlyDealtIndices]);

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
      } else if (stage === 'turn') {
        if (playSounds) haptic.light();
        if (playSounds && soundService.isEnabled()) soundService.playCommunityCard();
      } else if (stage === 'river') {
        if (playSounds) haptic.medium();
        if (playSounds && soundService.isEnabled()) soundService.playCommunityCard();
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
      aria-label={`Community Cards: ${cards.length > 0 ? cards.map((c) => `${c.rank} of ${c.suit}`).join(', ') : 'none dealt'}${rabbitCount > 0 ? `; rabbit hunt: ${rabbitCards.map((c) => `${c.rank} of ${c.suit}`).join(', ')}` : ''}${winningHandName ? ` - ${winningHandName}` : ''}`}
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
              slowReveal={slowReveal}
            />
          ) : /* Dan 2026-08-26: "remove the ghost placeholders for the turn
                 and river that appear after the flop."

                 An undealt slot now renders NOTHING at any stage. The dashed
                 outlines were meant to keep the board visually centred before
                 the turn and river land, but the row is centred by its own
                 flex layout, so they bought nothing and read as two empty
                 card-shaped holes sitting on the felt — on a phone, where the
                 board is already small, they were the loudest thing on it.

                 The preflop suppression this replaces (Phase 2 T1-07) was the
                 same instinct applied to one street; this is it applied to
                 all of them. `PlaceholderCard` and its `.community-cards__
                 placeholder` styles were deleted with it rather than left
                 behind — a component nothing renders is how a stylesheet ends
                 up full of rules for markup that no longer exists. */
          null
        )}
      </div>

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
  // POKERBROS PARITY 2026-08-26: the all-in slow-reveal mode changes which
  // animation the next street gets - it must invalidate the memo.
  if (prev.slowReveal !== next.slowReveal) return false;
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
