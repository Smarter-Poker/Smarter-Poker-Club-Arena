/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  BOMB POT WHEEL — how many hands until the bomb, drawn rather than told
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-07, item 7D:
 *
 *   "BOMB POT CLOCK SHOULD BE ON THE BOTTOM OF ALL OF THIS. WHEN IT CHANGES TO
 *    A CERTAIN AMOUNT OF HANDS FROM THE COUNTDOWN CLOCK FROM 1-5 HANDS, WE
 *    SHOULD HAVE A 'WHEEL SPINNER' ANIMATION (LIKE THE SPINS ANIMATION) THAT
 *    POPS UP AFTER THE HAND IS OVER WITH THE 3 MINUTES LEFT, SHOWING THE BOMB
 *    POT WILL BE IN THE NEXT 1-5 HANDS) AND THEN IT DISPLAYS THAT ON THE
 *    BOTTOM."
 *
 * WHAT THIS IS FOR. The masthead already prints "BOMB POT IN 4 HANDS", and it
 * is easy to never notice a small grey row change from a clock to a number.
 * The moment the countdown resolves into a hand count is the only moment the
 * bomb becomes plannable — it is when a player decides whether to sit out, top
 * up, or stay — and it deserves to be an event.
 *
 * WHY A SEPARATE COMPONENT FROM SpinWheel. The Spins reveal is built around
 * prize tiers: its wedges are multipliers, it colours them by how much money
 * they represent, it counts a prize up, and it carries a shared engine clock
 * so every seat sees one draw. None of that applies to a hand count, and
 * bending it to fit would mean a `SpinWheelData` full of fake multipliers.
 *
 * What IS shared is the drawing and the timing, and those are already exported
 * as pure functions: `wedgePath`, `segmentPoint`, `SW_VIEWBOX`, `chaseSchedule`
 * and `chaseCatchUp`. This reuses all five, so the disc, the decelerating
 * chase and the catch-up behaviour are literally the Spins ones — which is
 * what "LIKE THE SPINS ANIMATION" asks for — without inheriting its economics.
 *
 * NOT A DRAW. The wheel does not decide anything. The engine has already
 * scheduled the bomb and `handsAway` is its answer; this only reveals it. The
 * chase is aimed at the segment that is already true, exactly as SpinWheel
 * aims at a multiplier the server picked.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  SW_VIEWBOX,
  chaseCatchUp,
  chaseSchedule,
  segmentPoint,
  wedgePath,
} from '../tournament/SpinWheel';
import './BombPotWheel.css';

/**
 * The window Dan named: 1 to 5 hands. It is also the engine's own announce
 * window (bomb_pot_announce_seconds resolves the clock into a hand count
 * inside the last three minutes), so a count outside this range means the
 * scheduler is not in its announce phase and there is nothing to reveal.
 */
export const BOMB_WHEEL_MIN_HANDS = 1;
export const BOMB_WHEEL_MAX_HANDS = 5;
const SEGMENTS = BOMB_WHEEL_MAX_HANDS - BOMB_WHEEL_MIN_HANDS + 1;

/** Chase length, and the beat the result holds before it fades. */
export const BOMB_WHEEL_CHASE_MS = 2400;
export const BOMB_WHEEL_HOLD_MS = 1600;

export interface BombPotWheelProps {
  /**
   * Hands until the bomb pot, 1-5, or null for "nothing to show". Null is the
   * resting state: the parent nulls this to dismiss.
   */
  handsAway: number | null;
  /** Fired once the reveal has been read and the disc has faded. */
  onDone: () => void;
  /**
   * Keep the reveal inside its own table when several share the screen — the
   * same prop, for the same reason, as SpinWheel's. Fixed positioning in a
   * multi-table grid would black out all four felts for one table's bomb.
   */
  contained?: boolean;
}

const LABEL_RADIUS = 78;
const PEG_RADIUS = 104;

export function BombPotWheel({
  handsAway,
  onDone,
  contained = false,
}: BombPotWheelProps): React.ReactElement | null {
  const [litIndex, setLitIndex] = useState(-1);
  const [phase, setPhase] = useState<'idle' | 'chasing' | 'result'>('idle');
  const timers = useRef<number[]>([]);
  const startedForRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  }, []);

  useEffect(() => {
    /* Out of range is not an error and must not be a blank overlay: a table
       whose bomb is still on a clock, or has none, simply has nothing to
       reveal. Fail closed to "no wheel". */
    const valid =
      handsAway != null && handsAway >= BOMB_WHEEL_MIN_HANDS && handsAway <= BOMB_WHEEL_MAX_HANDS;
    if (!valid) {
      clearTimers();
      startedForRef.current = null;
      setPhase('idle');
      setLitIndex(-1);
      return;
    }
    // Re-running for a count already being revealed would restart the chase
    // mid-spin every time the parent re-renders.
    if (startedForRef.current === handsAway) return;
    startedForRef.current = handsAway;

    clearTimers();
    setPhase('chasing');

    const targetIndex = handsAway - BOMB_WHEEL_MIN_HANDS;
    const schedule = chaseSchedule(SEGMENTS, targetIndex, BOMB_WHEEL_CHASE_MS);
    /* elapsed 0: unlike a Spins draw there is no shared engine clock to join
       late against — this fires off a local hand-boundary. chaseCatchUp is
       still the right call rather than a raw loop, because it is the function
       that owns "which step is lit at time t" and a second implementation of
       that is how the light ends up somewhere other than the answer. */
    const { litNow, remaining } = chaseCatchUp(schedule, 0);
    if (litNow >= 0) setLitIndex(litNow % SEGMENTS);

    remaining.forEach(({ stepIdx, at }) => {
      timers.current.push(
        window.setTimeout(() => setLitIndex(stepIdx % SEGMENTS), Math.max(0, at))
      );
    });

    timers.current.push(
      window.setTimeout(() => {
        // The last chase step IS the target by construction (chaseSchedule),
        // but assert it rather than trust it: the one thing this component
        // must never do is stop on a number that is not the answer.
        setLitIndex(targetIndex);
        setPhase('result');
      }, BOMB_WHEEL_CHASE_MS)
    );
    timers.current.push(
      window.setTimeout(() => onDone(), BOMB_WHEEL_CHASE_MS + BOMB_WHEEL_HOLD_MS)
    );

    return clearTimers;
  }, [handsAway, onDone, clearTimers]);

  if (phase === 'idle' || handsAway == null) return null;

  const targetIndex = handsAway - BOMB_WHEEL_MIN_HANDS;

  return (
    <div
      className={`bpw bpw--${phase}${contained ? ' bpw--contained' : ''}`}
      role="status"
      aria-live="polite"
      data-testid="bomb-pot-wheel"
    >
      <div className="bpw__dim" aria-hidden="true" />
      <div className="bpw__stage">
        <div className="bpw__title">Bomb Pot Incoming</div>
        <svg
          className="bpw__disc"
          viewBox={`0 0 ${SW_VIEWBOX} ${SW_VIEWBOX}`}
          aria-hidden="true"
          focusable="false"
        >
          {Array.from({ length: SEGMENTS }, (_, i) => {
            const isLit = i === litIndex;
            const isWinner = phase === 'result' && i === targetIndex;
            return (
              <path
                key={`w${i}`}
                d={wedgePath(i, SEGMENTS)}
                className={`bpw__wedge${isLit ? ' is-lit' : ''}${isWinner ? ' is-winner' : ''}${
                  phase === 'result' && !isWinner ? ' is-dimmed' : ''
                }`}
              />
            );
          })}
          {Array.from({ length: SEGMENTS }, (_, i) => {
            const p = segmentPoint(i, SEGMENTS, LABEL_RADIUS);
            const peg = segmentPoint(i, SEGMENTS, PEG_RADIUS);
            return (
              <g key={`l${i}`}>
                <circle cx={peg.x} cy={peg.y} r={3.2} className="bpw__peg" />
                <text x={p.x} y={p.y} className="bpw__label" textAnchor="middle" dy="0.36em">
                  {i + BOMB_WHEEL_MIN_HANDS}
                </text>
              </g>
            );
          })}
        </svg>
        <div className="bpw__caption">
          {/* Never "double board" — see the prefix note in TablePage's
              bombPotBadge. Singular vs plural because "IN 1 HANDS" on the one
              reveal that matters most is the sort of thing players screenshot. */}
          {phase === 'result'
            ? handsAway === 1
              ? 'Bomb Pot Next Hand'
              : `Bomb Pot In ${handsAway} Hands`
            : 'Counting Down'}
        </div>
      </div>
    </div>
  );
}

export default BombPotWheel;
