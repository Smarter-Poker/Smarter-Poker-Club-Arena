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
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  SW_VIEWBOX,
  chaseCatchUp,
  chaseSchedule,
  segmentPoint,
  wedgePath,
} from '../tournament/SpinWheel';
import { getAnimationSpeed, prefersReducedMotion } from '../../utils/animationSpeed';
import { soundService } from '../../services/SoundService';
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
  /** Uses the active table sound gate; hidden or muted tables stay silent. */
  playSounds?: boolean;
}

const LABEL_RADIUS = 78;
const PEG_RADIUS = 104;

export function BombPotWheel({
  handsAway,
  onDone,
  contained = false,
  playSounds = true,
}: BombPotWheelProps): React.ReactElement | null {
  const [litIndex, setLitIndex] = useState(-1);
  const [phase, setPhase] = useState<'idle' | 'chasing' | 'result'>('idle');
  const timers = useRef<number[]>([]);
  const [chaseMs, setChaseMs] = useState(BOMB_WHEEL_CHASE_MS);
  const artId = useId().replace(/:/g, '');
  const playSoundsRef = useRef(playSounds);
  useEffect(() => {
    playSoundsRef.current = playSounds;
  }, [playSounds]);

  /**
   * ═══ onDone IS READ THROUGH A REF, AND THAT IS LOAD-BEARING ═══════════════
   *
   * The reveal froze on the first parent re-render, and this is why. TablePage
   * mounts this with an inline `onDone={() => setBombWheelHands(null)}`, so the
   * prop is a NEW FUNCTION on every one of its renders - and it re-renders on
   * every engine snapshot. With `onDone` in the effect's dependency list, each
   * of those re-runs the effect: cleanup fires `clearTimers()` and wipes every
   * pending timer, then the body hits the `startedForRef` guard and returns
   * WITHOUT rescheduling any of them. The chase stops mid-spin, `phase` stays
   * 'chasing', `onDone` is never called, and `.bpw__dim` - a full-screen dim at
   * z-index 99996 - sits over the felt for the rest of the session.
   *
   * Measured with the exact TablePage mount shape: no re-render, onDone fires
   * once; ONE re-render 100ms into the chase, onDone never fires at all.
   *
   * SpinWheel, whose geometry and chase timing this component reuses, already
   * solved this the same way (see its own onDoneRef): the callback is kept in a
   * ref that a separate effect keeps current, and the scheduling effect depends
   * only on the DATA. Reusing its maths without its lifetime discipline is what
   * produced the bug.
   */
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  const clearTimers = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  }, []);

  useEffect(() => {
    /* Out of range is not an error and must not be a blank overlay: a table
       whose bomb is still on a clock, or has none, simply has nothing to
       reveal. Fail closed to "no wheel". */
    const valid =
      handsAway != null &&
      Number.isInteger(handsAway) &&
      handsAway >= BOMB_WHEEL_MIN_HANDS &&
      handsAway <= BOMB_WHEEL_MAX_HANDS;
    if (!valid) {
      clearTimers();
      setPhase('idle');
      setLitIndex(-1);
      return;
    }
    // Only the count owns this effect. Parent callbacks and sound-gate changes
    // do not restart it; cleanup also permits React's strict effect replay.

    clearTimers();
    setPhase('chasing');

    const targetIndex = handsAway - BOMB_WHEEL_MIN_HANDS;
    const speed = getAnimationSpeed();
    const duration = BOMB_WHEEL_CHASE_MS * speed;
    setChaseMs(duration);
    const reduced = prefersReducedMotion();
    const schedule = reduced ? [] : chaseSchedule(SEGMENTS, targetIndex, duration);
    /* elapsed 0: unlike a Spins draw there is no shared engine clock to join
       late against — this fires off a local hand-boundary. chaseCatchUp is
       still the right call rather than a raw loop, because it is the function
       that owns "which step is lit at time t" and a second implementation of
       that is how the light ends up somewhere other than the answer. */
    const { litNow, remaining } = chaseCatchUp(schedule, 0);
    setLitIndex(reduced ? targetIndex : litNow >= 0 ? litNow % SEGMENTS : -1);

    remaining.forEach(({ stepIdx, at }, i) => {
      timers.current.push(
        window.setTimeout(
          () => {
            setLitIndex(stepIdx % SEGMENTS);
            if (playSoundsRef.current)
              soundService.playSpinPeg(0.5 + 0.5 * (i / Math.max(1, remaining.length - 1)));
          },
          Math.max(0, at)
        )
      );
    });

    timers.current.push(
      window.setTimeout(() => {
        // The last chase step IS the target by construction (chaseSchedule),
        // but assert it rather than trust it: the one thing this component
        // must never do is stop on a number that is not the answer.
        setLitIndex(targetIndex);
        setPhase('result');
      }, duration)
    );
    timers.current.push(
      window.setTimeout(() => onDoneRef.current(), duration + BOMB_WHEEL_HOLD_MS * speed)
    );

    return clearTimers;
    // `onDone` is deliberately NOT a dependency - it is read through
    // `onDoneRef` above. See the block on that ref: an inline arrow from the
    // parent made this effect re-run on every snapshot and cancel its own
    // timers without rescheduling them.
  }, [handsAway, clearTimers]);

  if (
    phase === 'idle' ||
    handsAway == null ||
    !Number.isInteger(handsAway) ||
    handsAway < BOMB_WHEEL_MIN_HANDS ||
    handsAway > BOMB_WHEEL_MAX_HANDS
  )
    return null;

  const targetIndex = handsAway - BOMB_WHEEL_MIN_HANDS;
  const landingAngle = 5 * 360 + targetIndex * (360 / SEGMENTS);

  return (
    <div
      className={`bpw bpw--${phase}${contained ? ' bpw--contained' : ''}`}
      style={
        {
          '--bpw-speed': chaseMs / BOMB_WHEEL_CHASE_MS,
          '--bpw-hold-ms': `${(BOMB_WHEEL_HOLD_MS * chaseMs) / BOMB_WHEEL_CHASE_MS}ms`,
        } as React.CSSProperties
      }
      role="status"
      aria-live="polite"
      data-testid="bomb-pot-wheel"
    >
      <link
        rel="preload"
        as="image"
        href={`${import.meta.env.BASE_URL}assets/diamond-spins/wheel-chrome-housing-v1.png`}
      />
      <div className="bpw__dim" aria-hidden="true" />
      <div className="bpw__stage">
        <div className="bpw__title">Bomb Pot Incoming</div>
        <div className="bpw__disc-wrap">
          <svg
            className="bpw__disc"
            viewBox={`0 0 ${SW_VIEWBOX} ${SW_VIEWBOX}`}
            aria-hidden="true"
            focusable="false"
          >
            <defs>
              <linearGradient id={`bpwMetal-${artId}`} x1="0" y1="0" x2="1" y2="1">
                <stop stopColor="#e4e7ec" />
                <stop offset=".35" stopColor="#9aa5b3" />
                <stop offset="1" stopColor="#050607" />
              </linearGradient>
              <radialGradient id={`bpwGlass-${artId}`} cx=".25" cy=".1" r=".9">
                <stop stopColor="#9aa5b3" stopOpacity=".5" />
                <stop offset=".35" stopColor="#050607" />
                <stop offset="1" stopColor="#000" />
              </radialGradient>
            </defs>
            {Array.from({ length: SEGMENTS }, (_, i) => {
              const isLit = i === litIndex;
              const isWinner = phase === 'result' && i === targetIndex;
              const p = segmentPoint(i, SEGMENTS, LABEL_RADIUS);
              const peg = segmentPoint(i, SEGMENTS, PEG_RADIUS);
              return (
                <g key={`w${i}`}>
                  <path
                    d={wedgePath(i, SEGMENTS)}
                    fill={`url(#bpwMetal-${artId})`}
                    className="bpw__metal"
                  />
                  <path
                    d={wedgePath(i, SEGMENTS, 112)}
                    fill={`url(#bpwGlass-${artId})`}
                    className={`bpw__wedge${isLit ? ' is-lit' : ''}${isWinner ? ' is-winner' : ''}${phase === 'result' && !isWinner ? ' is-dimmed' : ''}`}
                  />
                  <circle cx={peg.x} cy={peg.y} r={3.2} className="bpw__peg" />
                  <g>
                    <text x={p.x} y={p.y} className="bpw__label" textAnchor="middle" dy="0.15em">
                      {i + BOMB_WHEEL_MIN_HANDS}
                    </text>
                    <text x={p.x} y={p.y + 13} className="bpw__unit" textAnchor="middle">
                      {i === 0 ? 'HAND' : 'HANDS'}
                    </text>
                  </g>
                </g>
              );
            })}
          </svg>
          <img
            className="bpw__housing"
            src={`${import.meta.env.BASE_URL}assets/diamond-spins/wheel-chrome-housing-v1.png`}
            alt=""
            draggable={false}
          />
          {/* The numbered disc stays fixed. Only the pointer orbits its center. */}
          <div
            key={handsAway}
            className="bpw__selector-orbit"
            aria-hidden="true"
            data-motion="keep"
            style={
              {
                '--bpw-turn': `${landingAngle}deg`,
                '--bpw-spin-ms': `${chaseMs}ms`,
              } as React.CSSProperties
            }
          >
            <img
              className="bpw__selector"
              src={`${import.meta.env.BASE_URL}assets/diamond-spins/wheel-selector-pointer-v2.webp`}
              alt=""
              draggable={false}
            />
          </div>
          <div className="bpw__hub" aria-hidden="true">
            {phase === 'result' ? (
              <>
                <strong>{handsAway}</strong>
                <span>{handsAway === 1 ? 'HAND' : 'HANDS'}</span>
              </>
            ) : (
              <span>
                HANDS
                <br />
                UNTIL BOMB
              </span>
            )}
          </div>
        </div>
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
