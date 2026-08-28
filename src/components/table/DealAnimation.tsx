/**
 * =================================================================================
 *  DEAL ANIMATION -- Card dealing visual + sound when a new hand starts
 * =================================================================================
 *
 * Shows card backs flying from the DECK IN THE MIDDLE OF THE TABLE to each
 * player in the hand. Two cards per player, staggered, dealt round the table
 * starting to the dealer's left. (Dan 2026-08-21, item 14 -- they used to launch
 * from the dealer's own seat, i.e. out of a player's face.)
 *
 * Sounds:
 *  - playDeal() fires for each card dealt (air whoosh), staggered with the visuals.
 *    The shuffle riffle + new-hand chime belong to TablePage's HAND_STARTED
 *    handler; this component owns ONLY the per-card sounds.
 *
 * ---------------------------------------------------------------------------------
 * Dan 2026-08-23: "THE CARD DEALING ANIMATION NEEDS TO FIRE AND WORK 100 PERCENT
 * OF THE TIME." It did not, and the reason was structural rather than cosmetic.
 *
 * The deal used to be scheduled inside a `useEffect` whose dependency list was
 * `[active, activeSeats.length]`. React runs an effect's CLEANUP before every
 * re-run, and that cleanup cancelled the per-card sound timers and the
 * completion timer. `activeSeats` is rebuilt by TablePage from
 * `tableState.players` on every render, so its LENGTH changes whenever a seat is
 * added, leaves, sits out, goes away or is rewritten by the presence effect --
 * all of which happen routinely inside the ~1.4 seconds the deal is running,
 * because the fresh roster snapshot arrives AFTER the discrete HAND_STARTED
 * event that starts the deal. Measured against the old component (probe: six
 * seats, one seat removed 120ms in):
 *
 *     deal sounds: 2 of 12          onComplete: never fired
 *     card layer:  12 nodes left mounted forever, `will-change` and all
 *
 * `onComplete` never firing is not cosmetic either: TablePage releases the
 * action-panel hold from it, so the hero sat locked out of their own turn until
 * the 2600ms fallback ceiling expired.
 *
 * The second failure was the latch. The effect set `prevActiveRef = true` as
 * soon as it produced a card list, even when that list was EMPTY -- which is
 * exactly what happens when the hand starts before `seatPositions` is populated
 * (probe: zero cards at mount, and still zero after the positions arrived,
 * because the latch had already been spent). That hand was dealt with no
 * animation at all and nothing retried.
 *
 * THE FIX, in three parts:
 *
 *   1. The scheduler depends only on `[active, dealKey]` -- values that change
 *      once per hand and never mid-deal. Everything else is read through a ref,
 *      so no amount of prop churn can reach the running deal's timers.
 *   2. A deal that cannot be built yet (no roster, no geometry) does NOT latch.
 *      It retries on the next render AND on its own 60ms timer, so it recovers
 *      whether or not React happens to re-render, up to SEAT_WAIT_MS.
 *   3. `onComplete` fires exactly once per run on every path, including the
 *      give-up path, so the action-panel hold is always released.
 *
 * Every card element carries the run id in its React key, so a second deal on
 * the same mounted instance builds NEW DOM nodes. Reusing the old nodes would
 * mean reusing their already-finished CSS animation, which does not re-run
 * without a fresh element -- that is the "cards just appear" symptom.
 */

import React, { useCallback, useEffect, useRef, useState, memo } from 'react';
import { soundService } from '../../services/SoundService';
import { reportError } from '../../utils/errorReporter';
import { getAnimationSpeed } from '../../utils/animationSpeed';
import './DealAnimation.css';

// =================================================================================
// TYPES
// =================================================================================

export interface DealAnimationProps {
  /** Active when a new hand just started */
  active: boolean;
  /** Seat indices (0-based) of players being dealt to */
  activeSeats: number[];
  /**
   * Dealer seat index (0-based).
   *
   * Dan 2026-08-21 (item 14): cards no longer fly FROM here -- they come off
   * the deck in the middle of the table (see `originPct`). Kept because the
   * dealer still determines deal ORDER, and because removing a prop every
   * caller passes buys nothing.
   */
  dealerSeatIndex: number;
  /**
   * Optional per-hand token. When it changes the deal runs again, WITHOUT the
   * caller having to remount the component with a new React key.
   *
   * TablePage currently remounts, which works but couples "deal this hand" to
   * a key it also resets to 0 from `onComplete`. Passing the hand number here
   * makes the trigger the hand itself, so a dropped or coalesced HAND_STARTED
   * event cannot cost a player their deal.
   */
  dealKey?: string | number;
  /**
   * Where the cards come from, as {x, y} percentages of the table scaler.
   * Defaults to the centre of the felt -- the deck.
   */
  originPct?: { x: number; y: number };
  /** Seat positions as {x, y} percentages */
  seatPositions: { x: number; y: number }[];
  /** Called when animation completes */
  onComplete?: () => void;
  /**
   * IMPROVEMENT PASS 2026-08-19: multi-table gate. Background tables must
   * not play deal sounds (#175); TablePage passes its ambientSoundsAllowed.
   */
  playSounds?: boolean;
}

interface FlyingCard {
  id: string;
  targetX: number;
  targetY: number;
  originX: number;
  originY: number;
  delay: number;
}

/** Bookkeeping for one deal. Lives in a ref so no re-render can disturb it. */
interface DealRun {
  id: number;
  launched: boolean;
  completed: boolean;
  cancelled: boolean;
  /** Date.now() past which we stop waiting for a roster / seat geometry. */
  waitUntil: number;
}

/** What is actually on screen for the current run. */
interface DealFrame {
  id: number;
  cards: FlyingCard[];
  flightMs: number;
}

// =================================================================================
// CONSTANTS
// =================================================================================

/** Delay between each card deal in ms -- PokerBros-style rapid fire */
const CARD_STAGGER_MS = 80;
/**
 * Floor for the stagger, and it is an AUDIO constraint rather than a visual one.
 * SoundService.shouldPlay keeps a 50ms priority window and rejects a sound whose
 * rank is <= the rank already claimed in that window, so two `deal` sounds less
 * than 50ms apart mean the second one is silently dropped. A player who sets
 * --animation-speed to 0.5 would otherwise get a 40ms stagger and hear half the
 * deal.
 */
const MIN_CARD_STAGGER_MS = 60;
/** Extra settle time after last card arrives before cleanup */
const SETTLE_BUFFER_MS = 100;
/**
 * Ceiling on the whole deal. The engine's inter-hand gap on a fold-win is 2000ms
 * (see TablePage's HAND_STARTED handler), and a nine-handed deal at 80ms stagger
 * ran 1360ms of stagger before flight and settle were even counted -- 1780ms
 * total, so the next hand could start while the previous deal was still in the
 * air. Eighteen cards are compressed to fit inside this instead.
 */
const MAX_DEAL_MS = 1500;
/**
 * How long a hand start will wait for the roster and the seat geometry before
 * giving up. HAND_STARTED regularly beats the snapshot that carries them.
 * Bounded because TablePage holds the action panel until `onComplete`, and a
 * player frozen out of their own turn is worse than a missing animation.
 */
// ANIMATION AUDIT 2026-08-27: was 800ms — SHORTER than the roster race it
// exists to absorb. When the snapshot carrying seat geometry arrived after
// 800ms the run gave up, onComplete fired, and that hand silently got NO deal
// animation with no retry. TablePage's action-panel hold has its own hard
// 2600ms ceiling, so waiting longer cannot freeze a player out of their turn;
// 1600ms covers the observed race with margin while staying inside the hold.
const SEAT_WAIT_MS = 1600;
/** Retry cadence while waiting for the roster / geometry. */
const WAIT_POLL_MS = 60;

/**
 * IMPROVEMENT PASS 2026-08-19: flight duration used to be a JS constant (320)
 * while the CSS breakpoints quietly dropped --da-flight-duration to 0.28s /
 * 0.25s on small screens -- the JS cleanup timer and the visuals disagreed on
 * every phone, and neither side honored --animation-speed. The JS now picks
 * the same base the CSS breakpoints used, scales it by the user's speed
 * multiplier, and WRITES the result back as an inline --da-flight-duration so
 * both sides are always the same number by construction.
 */
function flightDurationMs(): number {
  let base = 320;
  if (typeof window !== 'undefined' && window.matchMedia) {
    if (window.matchMedia('(max-width: 480px)').matches) base = 250;
    else if (window.matchMedia('(max-width: 768px)').matches) base = 280;
  }
  return Math.round(base * getAnimationSpeed());
}

/**
 * Build the flying-card list for one deal, or an empty list when the table is
 * not describable yet (no seats, or no geometry for any of them).
 *
 * An empty result means "not ready", never "nothing to deal" -- the caller
 * retries rather than latching, because latching on an empty list is what used
 * to consume a hand's only chance at a deal animation.
 */
function buildDealCards(
  runId: number,
  activeSeats: number[],
  dealerSeatIndex: number,
  seatPositions: { x: number; y: number }[],
  originPct: { x: number; y: number } | undefined,
  flightMs: number,
  speed: number
): FlyingCard[] {
  /**
   * Dan 2026-08-21 (bug list item 14): "cards need to appear from the MIDDLE of
   * the table". They used to launch from the DEALER'S SEAT, which on a
   * nine-handed table means most hands began with cards flying out of a
   * player's face -- and when the button was on the hero, out from underneath
   * the hero's own plate, where the flight was invisible.
   */
  const origin = originPct || { x: 50, y: 46 };

  /**
   * Deal ORDER starts to the dealer's left and goes round, which is how a hand
   * is actually dealt. The code used to deal in seat-index order, so on any
   * hand where the button was not seat 1 the cards went round the table
   * starting from the wrong player.
   */
  const startAfter = activeSeats.findIndex((s) => s > dealerSeatIndex);
  const order =
    startAfter <= 0
      ? activeSeats
      : [...activeSeats.slice(startAfter), ...activeSeats.slice(0, startAfter)];

  // A seat with no position cannot be dealt to. Dropping it here (rather than
  // inside the loop) keeps the stagger contiguous -- otherwise the gaps left by
  // skipped seats showed up as dead pauses in the middle of the deal.
  const seats = order.filter((seatIdx) => seatPositions[seatIdx]);
  if (seats.length === 0) return [];

  const cardCount = seats.length * 2;
  const settle = Math.round(SETTLE_BUFFER_MS * speed);
  const room = Math.max(0, Math.round(MAX_DEAL_MS * speed) - flightMs - settle);
  const fit = cardCount > 1 ? Math.floor(room / (cardCount - 1)) : CARD_STAGGER_MS;
  const stagger = Math.max(MIN_CARD_STAGGER_MS, Math.min(Math.round(CARD_STAGGER_MS * speed), fit));

  const cards: FlyingCard[] = [];
  // Two rounds of dealing (two cards per player)
  for (let round = 0; round < 2; round++) {
    seats.forEach((seatIdx, orderIdx) => {
      const pos = seatPositions[seatIdx];
      cards.push({
        // The run id is part of the key so a second deal on the same mounted
        // instance gets NEW elements. A reused element keeps its finished
        // animation and never replays it.
        id: `deal-${runId}-${round}-${seatIdx}`,
        targetX: pos.x,
        targetY: pos.y,
        originX: origin.x,
        originY: origin.y,
        delay: (round * seats.length + orderIdx) * stagger,
      });
    });
  }
  return cards;
}

// =================================================================================
// COMPONENT
// =================================================================================

function DealAnimationComponent({
  active,
  activeSeats,
  dealerSeatIndex,
  dealKey,
  originPct,
  seatPositions,
  onComplete,
  playSounds = true,
}: DealAnimationProps) {
  const [frame, setFrame] = useState<DealFrame | null>(null);

  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  /**
   * The wait-for-roster poll is tracked separately from the deal's own timers
   * because `attemptDeal` is called from an effect that runs after EVERY
   * render. Pushing a fresh poll timer each time would stack one per parent
   * re-render, and TablePage re-renders constantly.
   */
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runRef = useRef<DealRun | null>(null);
  const runSeqRef = useRef(0);

  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  /**
   * Every prop the scheduler reads is mirrored here rather than taken as an
   * effect dependency. See the file header: `activeSeats.length` as a dependency
   * is what cancelled the deal's own timers mid-flight.
   */
  const propsRef = useRef({
    activeSeats,
    dealerSeatIndex,
    originPct,
    seatPositions,
    playSounds,
  });
  propsRef.current = { activeSeats, dealerSeatIndex, originPct, seatPositions, playSounds };

  const clearTimers = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    if (pollRef.current !== null) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  /** Ends a run exactly once, on every path, so the caller's hold is released. */
  const finishRun = useCallback(
    (run: DealRun) => {
      if (run.completed || run.cancelled) return;
      run.completed = true;
      clearTimers();
      setFrame((cur) => (cur && cur.id === run.id ? null : cur));
      onCompleteRef.current?.();
    },
    [clearTimers]
  );

  /**
   * Try to start the pending run. No-op once it has started, finished or been
   * superseded, so it is safe to call from a render-driven effect AND from a
   * timer -- whichever happens first wins and the other is free.
   */
  const attemptDeal = useCallback(() => {
    const run = runRef.current;
    if (!run || run.launched || run.completed || run.cancelled) return;

    const p = propsRef.current;
    const speed = getAnimationSpeed();
    const flight = flightDurationMs();
    const cards = buildDealCards(
      run.id,
      p.activeSeats,
      p.dealerSeatIndex,
      p.seatPositions,
      p.originPct,
      flight,
      speed
    );

    if (cards.length === 0) {
      // Not ready. Do NOT latch -- retry until the roster and geometry land.
      if (Date.now() >= run.waitUntil) {
        // ANIMATION LAW TELEMETRY 2026-08-28: this is the ONE path where a
        // hand can open with no deal animation (the roster/geometry never
        // arrived inside SEAT_WAIT_MS). It used to happen in total silence —
        // report it so a regression here is SEEN in Sentry, not discovered by
        // a player. The give-up itself stays: a player frozen out of their
        // turn is worse than a missing animation.
        try {
          reportError(
            new Error(`DealAnimation gave up waiting for seat geometry (${SEAT_WAIT_MS}ms)`),
            'AnimationLaw.deal_gave_up'
          );
        } catch {
          /* telemetry must never break the table */
        }
        finishRun(run);
        return;
      }
      if (pollRef.current === null) {
        pollRef.current = setTimeout(() => {
          pollRef.current = null;
          attemptDeal();
        }, WAIT_POLL_MS);
      }
      return;
    }

    run.launched = true;
    clearTimers(); // drop the wait-poll timers; the deal owns the queue now
    setFrame({ id: run.id, cards, flightMs: flight });

    if (p.playSounds) {
      // SOUND AUDIT 2026-08-27: was one setTimeout per card calling
      // playDeal() — under main-thread load two timers bunched inside the
      // 50ms sound-priority window and cards went silent. The whole
      // sequence is now scheduled once on the AudioContext clock, which
      // cannot bunch. (+30ms so each slide lands just after its visual
      // launch.)
      try {
        soundService.playDealSequence(cards.map((card) => card.delay + 30));
      } catch {
        // A dead AudioContext must never stop the cards flying.
      }
    }

    const lastDelay = cards[cards.length - 1].delay;
    const total = lastDelay + flight + Math.round(SETTLE_BUFFER_MS * speed);
    timersRef.current.push(setTimeout(() => finishRun(run), total));
  }, [clearTimers, finishRun]);

  // -- Scheduler: one run per hand -------------------------------------------
  // Dependencies are ONLY values that change once per hand. Nothing here may
  // depend on the roster or the geometry, or a mid-deal snapshot re-runs the
  // cleanup and kills the deal that is already in the air.
  useEffect(() => {
    if (runRef.current) runRef.current.cancelled = true;
    clearTimers();
    if (!active) return;
    runRef.current = {
      id: ++runSeqRef.current,
      launched: false,
      completed: false,
      cancelled: false,
      waitUntil: Date.now() + Math.round(SEAT_WAIT_MS * getAnimationSpeed()),
    };
    setFrame(null);
    attemptDeal();
  }, [active, dealKey, attemptDeal, clearTimers]);

  // -- Render-driven retry ----------------------------------------------------
  // Deliberately has NO dependency array and NO cleanup: it exists so that the
  // render carrying the late roster starts the deal in that same commit, and a
  // hook that cannot cancel anything cannot reintroduce the bug above.
  useEffect(() => {
    attemptDeal();
  });

  // -- Unmount ----------------------------------------------------------------
  useEffect(
    () => () => {
      if (runRef.current) runRef.current.cancelled = true;
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      if (pollRef.current !== null) {
        clearTimeout(pollRef.current);
        pollRef.current = null;
      }
    },
    []
  );

  if (!frame || frame.cards.length === 0) return null;

  return (
    <div
      key={frame.id}
      className="deal-animation"
      aria-hidden="true"
      /* JS is the single source of truth for flight duration -- see
         flightDurationMs(). Inline var out-specifies the CSS breakpoints. */
      style={{ '--da-flight-duration': `${frame.flightMs}ms` } as React.CSSProperties}
    >
      {frame.cards.map((card) => (
        <div
          key={card.id}
          className="deal-animation__card"
          style={
            {
              '--origin-x': `${card.originX}%`,
              '--origin-y': `${card.originY}%`,
              '--target-x': `${card.targetX}%`,
              '--target-y': `${card.targetY}%`,
              '--delay': `${card.delay}ms`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

export const DealAnimation = memo(DealAnimationComponent);
export default DealAnimation;
