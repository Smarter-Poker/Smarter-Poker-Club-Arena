/**
 * ===============================================================================
 *  TRASH_CAN - the 2-7 gag: a can, a swear bubble, a can that eats its own joke
 *  (phase 2, 2026-09-06)
 * ===============================================================================
 *
 * Measured off PB THROWABLE 1.MOV, THROW 6 (launch f1215, 30 fps, target
 * avatar ~30 px wide, so 1 px = 3.333 units), see
 * docs/throwables/pokerbros-reference-video-1.md lines 340-402, and the build
 * sheet at docs/throwables/THROWABLES-PREMIUM-ANIMATION-PLAN.md line 608.
 * ms from LAUNCH (this throw's "L" is the first frame the can exists, i.e. the
 * spawn start - the same convention beer.tsx and water_gun.tsx were measured
 * against for video 1; every beat below is the reference table's own "ms from
 * L" column, unshifted, exactly as spec.ts's docstring calls for):
 *
 *   0-167      can fades/scales in at the thrower's upper-left, upright
 *   200-467    straight flight up the centre line, no spin, no scale
 *   500        LAND: the can, full size, centred on the avatar, ONE frame
 *   533-800    VANISH: the can disappears completely; avatar bare
 *   833-967    the "2" (2 of hearts) pops tiny+rotated at the upper-left,
 *              grows and rights itself sliding down, lands lower-left
 *   1000-1100  the "7" (7 of spades) pops at the upper-right, lands lower-
 *              right beside the 2 - the worst hand in hold'em, on purpose
 *   1267-2467  a white speech bubble with grawlix scribbles (NOT letters)
 *              pops at the upper-right and holds
 *   1833-2000  the 2 and 7 shrink slightly and slide right, making room
 *   1967-2100  the can rises from below the avatar's left side, growing to
 *              1.2 u, lid on
 *   2200-2500  the lid tilts up and flies to the can's upper-left, rotating
 *              about -60 deg, and hovers
 *   2533-2967  the 2 rises and rotates in, hangs over the mouth; the 7
 *              follows a beat later; both fall into the can
 *   3000-3133  the lid drops back onto the can and seats
 *   3500-4467  flies buzz at the left of the closed lid
 *   4500       CUT, one frame - can and flies gone, seat clean
 *
 * Everything in the Payload is `animation-delay` from LANDING, and LANDING IS
 * `flight.ms` (333 = the raw table's land-ms-from-L, 500, minus the 167 ms the
 * can spends spawning at the thrower - contract rule 1). So delay = catalogue
 * "at" minus 333: vanish 200, card-2 500, card-7 667, bubble 934, cards-shift
 * 1500, can-rise 1634, lid-open 1867, cards-in 2200, lid-close 2667, flies
 * 3167, cut 4167. The comments on each keyframe keep both numbers.
 *
 * Sound (plan 4A / build sheet 608): `card_slap` x2 at 900 and 1050 (the two
 * pops), `bubble_tick` at 1267, `can_rattle_rise` 1967-2100 (a burst, not a
 * loop - it is the can's own rising rattle, over almost as soon as it starts),
 * `lid_clank` at 3000, `flies_buzz` 3500-4467.
 */

import React from 'react';
import type { ThrowableSpec } from '../spec';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import { preloadThrowableCues } from '../cues';
import './trash_can.css';

export const trashCanSpec: ThrowableSpec = {
  id: 'trash_can',
  name: 'Trash Can',
  tier: 'vip',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'land',
  payload: { sizeU: 1.2, anchor: 'face', coversAvatar: true, ms: 4167 },
  beats: [
    { at: 333, marker: 'land' },
    { at: 533, marker: 'vanish' },
    { at: 833, marker: 'card2' },
    { at: 1000, marker: 'card7' },
    { at: 1267, marker: 'bubble' },
    { at: 1833, marker: 'cards-shift' },
    { at: 1967, marker: 'can-rise' },
    { at: 2200, marker: 'lid-open' },
    { at: 2533, marker: 'cards-in' },
    { at: 3000, marker: 'lid-close' },
    { at: 3500, marker: 'flies' },
    { at: 4500, marker: 'cut' },
  ],
  audio: [
    { at: 900, sample: 'card_slap' },
    { at: 1050, sample: 'card_slap' },
    { at: 1267, sample: 'bubble_tick' },
    { at: 1967, sample: 'can_rattle_rise', loopUntil: 2100 },
    { at: 3000, sample: 'lid_clank' },
    { at: 3500, sample: 'flies_buzz', loopUntil: 4467 },
  ],
  reference: { video: 1, launchFrame: 1215, throw: 'THROW 6' },
};

preloadThrowableCues(trashCanSpec.audio.map((c) => c.sample));

const CAN_LIGHT = '#c3c9cf';
const CAN_MID = '#9198a1';
const CAN_DARK = '#5f6570';
const LID_MID = '#a6adb5';
const RECYCLE_GREEN_DARK = '#2f6f38';
const CARD_WHITE = '#fbfbf8';
const CARD_EDGE = '#cfcfc9';
const HEART_RED = '#c11d1d';
const SPADE_BLACK = '#232326';
const BUBBLE_WHITE = '#fdfdfb';
const BUBBLE_EDGE = '#c6c6c2';
const GRAWLIX_BLACK = '#2b2b2b';
const FLY_DARK = '#39352c';

/**
 * The recycling triangle: three curved arrows, drawn small and flat so it
 * reads as a badge rather than three separate glyphs.
 */
function RecycleMark({ fill }: { fill: string }) {
  return (
    <g fill="none" stroke={fill} strokeWidth="1.6" strokeLinecap="round">
      <path d="M -6 6 L 0 -6 L 6 6" />
      <path d="M -3 0 L -6 6 L -1 6" />
      <path d="M 3 0 L 6 6 L 1 6" />
    </g>
  );
}

/**
 * The can BODY, drawn around (0,0): a tapered cylinder 84 units wide at the
 * rim and 96 tall (the measured 22x26 px on a 30 px avatar), no lid. The rim
 * is a dark ellipse so an open top reads as open even before the lid moves.
 */
function CanBody({ uid, k }: { uid: string; k: string }) {
  const g = (n: string) => `thr-trash_can-${n}-${uid}-${k}`;
  return (
    <g>
      <defs>
        <linearGradient id={g('body')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={CAN_LIGHT} />
          <stop offset="45%" stopColor={CAN_MID} />
          <stop offset="100%" stopColor={CAN_DARK} />
        </linearGradient>
      </defs>
      <path
        d="M -36 -40 L 36 -40 L 30 44 Q 0 52 -30 44 Z"
        fill={`url(#${g('body')})`}
        stroke={CAN_DARK}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* three vertical ribs */}
      <path d="M -16 -36 L -14 40" stroke={CAN_DARK} strokeWidth="1.4" opacity="0.35" />
      <path d="M 0 -37 L 0 43" stroke={CAN_DARK} strokeWidth="1.4" opacity="0.35" />
      <path d="M 16 -36 L 14 40" stroke={CAN_DARK} strokeWidth="1.4" opacity="0.35" />
      <g transform="translate(0 4)">
        <RecycleMark fill={RECYCLE_GREEN_DARK} />
      </g>
      {/* the open rim, dark, so a missing lid reads immediately */}
      <ellipse cx="0" cy="-40" rx="36" ry="7" fill="#2c2f34" />
    </g>
  );
}

/** The can, whole, lid on: used for the projectile and for the one landed
 *  frame that vanishes whole (it never opens). */
function CanClosed({ uid, k }: { uid: string; k: string }) {
  const g = (n: string) => `thr-trash_can-${n}-${uid}-${k}`;
  return (
    <g>
      <CanBody uid={uid} k={k} />
      <defs>
        <linearGradient id={g('lid')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={LID_MID} />
          <stop offset="100%" stopColor={CAN_MID} />
        </linearGradient>
      </defs>
      <ellipse
        cx="0"
        cy="-40"
        rx="38"
        ry="8"
        fill={`url(#${g('lid')})`}
        stroke={CAN_DARK}
        strokeWidth="1.6"
      />
      <ellipse cx="0" cy="-49" rx="8" ry="3" fill={CAN_DARK} />
    </g>
  );
}

/** The lid alone, drawn to sit at the SAME place CanClosed's lid sits (rim
 *  (0,-40)), so the payload can swap a static can for a body+lid pair without
 *  a visible jump. */
function Lid({ uid, k }: { uid: string; k: string }) {
  const g = (n: string) => `thr-trash_can-${n}-${uid}-${k}`;
  return (
    <g>
      <defs>
        <linearGradient id={g('lid2')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={LID_MID} />
          <stop offset="100%" stopColor={CAN_MID} />
        </linearGradient>
      </defs>
      <ellipse
        cx="0"
        cy="-40"
        rx="38"
        ry="8"
        fill={`url(#${g('lid2')})`}
        stroke={CAN_DARK}
        strokeWidth="1.6"
      />
      <ellipse cx="0" cy="-49" rx="8" ry="3" fill={CAN_DARK} />
    </g>
  );
}

/** A stencil "2", built as one open stroke path so it never risks being read
 *  as a DOM text node: top bar, upper-right vertical, middle bar, lower-left
 *  vertical, bottom bar. */
function Digit2({ color }: { color: string }) {
  return (
    <path
      d="M -6 -12 L 6 -12 L 6 0 L -6 0 L -6 12 L 6 12"
      fill="none"
      stroke={color}
      strokeWidth="3.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

/** A stencil "7": top bar, full right vertical. */
function Digit7({ color }: { color: string }) {
  return (
    <path
      d="M -6 -12 L 6 -12 L 6 12"
      fill="none"
      stroke={color}
      strokeWidth="3.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

const HEART_PATH =
  'M 0 3.4 C -5 -1.6 -9 -4.6 -5 -7.8 C -2 -10 0 -8 0 -6 C 0 -8 2 -10 5 -7.8 C 9 -4.6 5 -1.6 0 3.4 Z';
const SPADE_PATH =
  'M 0 -8 C 4.2 -3 9 -1 6 4 C 4 7 1 5.6 0.6 3 C 0.9 6 2 8 3.4 9 L -3.4 9 C -2 8 -0.9 6 -0.6 3 C -1 5.6 -4 7 -6 4 C -9 -1 -4.2 -3 0 -8 Z';

/**
 * A playing card, 46 wide x 64 tall (the measured 14x20 px), drawn around
 * (0,0). Rank is shown by a big stencil digit plus a big pip below it AND a
 * small corner index (digit + pip) top-left and its mirror bottom-right - a
 * card reads by pip shape/colour, never by a DOM text glyph.
 */
function PlayingCard({
  digit,
  pip,
  color,
}: {
  digit: 'two' | 'seven';
  pip: string;
  color: string;
}) {
  const Digit = digit === 'two' ? Digit2 : Digit7;
  return (
    <g>
      <rect
        x={-23}
        y={-32}
        width={46}
        height={64}
        rx={4}
        fill={CARD_WHITE}
        stroke={CARD_EDGE}
        strokeWidth="1.6"
      />
      {/* corner index, top-left */}
      <g transform="translate(-15 -22) scale(0.42)">
        <Digit color={color} />
      </g>
      <g transform="translate(-15 -12) scale(0.55)">
        <path d={pip} fill={color} />
      </g>
      {/* the big centre pip and rank, the joke's own punchline */}
      <g transform="translate(0 8)">
        <path d={pip} fill={color} transform="scale(1.9) translate(0 -4)" opacity="0.9" />
      </g>
      <g transform="translate(0 -10) scale(0.85)">
        <Digit color={color} />
      </g>
      {/* corner index, bottom-right, rotated to match a real card */}
      <g transform="translate(15 22) rotate(180) scale(0.42)">
        <Digit color={color} />
      </g>
      <g transform="translate(15 12) rotate(180) scale(0.55)">
        <path d={pip} fill={color} />
      </g>
    </g>
  );
}

/** A grawlix mark: a star, a coil and a jagged bolt, NEVER letters (Dan's own
 *  "em bars" ruling is about punctuation in copy; this is a step further -
 *  the build sheet is explicit the bubble carries symbols, not words). */
function Grawlix() {
  return (
    <g
      fill="none"
      stroke={GRAWLIX_BLACK}
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* a five-point starburst */}
      <path
        d="M -13 -3 L -11.5 -7 L -9.5 -3.3 L -6 -5.5 L -8 -1.8 L -4.5 -0.5 L -8.5 0.3 L -7 4 L -10.5 1.5 L -12.5 5 L -13 1 L -17 1.5 L -13.8 -1 Z"
        fill={GRAWLIX_BLACK}
        stroke="none"
      />
      {/* a coil */}
      <path d="M -1 4 C -5 4 -5 -2 -1 -2 C 3 -2 3 2.5 0 2.5 C -2 2.5 -2 0.5 0 0.5" />
      {/* a jagged bolt */}
      <path d="M 6 -6 L 3 0 L 6.5 0.5 L 3.5 6" />
    </g>
  );
}

/** The speech bubble: a rounded body 34 units wide (the measured ~10 px) with
 *  a small tail pointing down-left toward the can. */
function Bubble() {
  return (
    <g>
      <path
        d="M -17 -14 Q -17 -22 -9 -22 L 9 -22 Q 17 -22 17 -14 Q 17 -6 9 -6 L -3 -6 L -10 1 L -8 -6 L -9 -6 Q -17 -6 -17 -14 Z"
        fill={BUBBLE_WHITE}
        stroke={BUBBLE_EDGE}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <g transform="translate(0 -14)">
        <Grawlix />
      </g>
    </g>
  );
}

/** Three flies: [dx, dy], fixed positions around the closed lid's left edge.
 *  Fixed, never random. */
const FLIES: ReadonlyArray<readonly [number, number]> = [
  [-46, -46],
  [-52, -30],
  [-40, -56],
];

/** Two animations, comma-matched: the entrance pop at 3500 (+3167) and an
 *  infinite jitter that starts at the same moment but is staggered per fly
 *  by a fixed step, so the three do not buzz in lockstep. */
function Fly({ jitterStep }: { jitterStep: number }) {
  return (
    <g
      className="thr-trash_can__fly"
      style={
        {
          animationDelay: `calc(3.167s * var(--animation-speed, 1)), calc((3.167s + ${(jitterStep * 0.06).toFixed(2)}s) * var(--animation-speed, 1))`,
        } as React.CSSProperties
      }
    >
      <ellipse cx="0" cy="0" rx="2.2" ry="1.4" fill={FLY_DARK} />
      <path d="M -1.5 -0.5 L -4 -2 M 1.5 -0.5 L 4 -2" stroke={FLY_DARK} strokeWidth="0.7" />
    </g>
  );
}

function Projectile({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <CanClosed uid={uid} k="p" />
    </svg>
  );
}

function Payload({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      {/* 333 (+0): the can, whole, where the flight left it. Visible one
          frame, then gone entirely at 533 (+200). */}
      <g className="thr-trash_can__landed">
        <CanClosed uid={uid} k="landed" />
      </g>

      {/* 833 (+500): the "2" pops upper-left, grows and slides to the lower-
          left, later shifts right, later rises and falls into the can. ONE
          continuous life, like the rose's kiss. */}
      <g className="thr-trash_can__card2">
        <PlayingCard digit="two" pip={HEART_PATH} color={HEART_RED} />
      </g>

      {/* 1000 (+667): the "7" pops upper-right, mirrors the 2 a beat later. */}
      <g className="thr-trash_can__card7">
        <PlayingCard digit="seven" pip={SPADE_PATH} color={SPADE_BLACK} />
      </g>

      {/* 1267 (+934): the swear bubble, upper-right of the avatar. */}
      <g transform="translate(58 -95)">
        <g className="thr-trash_can__bubble">
          <Bubble />
        </g>
      </g>

      {/* 1967 (+1634): the can rises from below-left, growing to 1.2 u,
          centred at the measured offset from the avatar (target (110,92),
          can (103,95) -> (-7,+3) px -> (-23,+10) u). */}
      <g transform="translate(-23 10)">
        <g className="thr-trash_can__can-return">
          <CanBody uid={uid} k="ret" />
        </g>
        {/* 2200 (+1867): the lid opens, flies up-left, hovers, then closes
            at 3000 (+2667) and seats. Same local origin as the body's rim. */}
        <g className="thr-trash_can__lid">
          <Lid uid={uid} k="ret" />
        </g>
      </g>

      {/* 3500 (+3167): flies buzz at the closed lid's left edge. */}
      <g className="thr-trash_can__flies" transform="translate(-23 -30)">
        {FLIES.map(([dx, dy], i) => (
          <g key={i} transform={`translate(${dx} ${dy})`}>
            <Fly jitterStep={i} />
          </g>
        ))}
      </g>
    </svg>
  );
}

export const trashCanRig: ThrowableRig = { Projectile, Payload };
