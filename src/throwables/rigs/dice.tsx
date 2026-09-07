/**
 * ===============================================================================
 *  DICE - a pair that tumbles in, a hand that never stops shaking (phase 2,
 *  2026-09-06)
 * ===============================================================================
 *
 * Measured off PB THROWABLE 1.MOV, THROW 8 (launch f1716, 30 fps, target
 * avatar ~30 px wide, so 1 px = 3.333 units), see
 * docs/throwables/pokerbros-reference-video-1.md lines 465-501, and the build
 * sheet at docs/throwables/THROWABLES-PREMIUM-ANIMATION-PLAN.md line 622.
 * ms from LAUNCH (this throw's "L" is the first frame the dice exist, i.e.
 * the spawn start, same convention as beer/trash_can for video 1):
 *
 *   0-100      a pair of white dice pop in at the hero's face, growing
 *   100-333    they TUMBLE in a straight flight - the only rotating
 *              projectile in the whole set (spec.flight.tumble, not this
 *              rig: the player's own `thr__proj--tumble` class spins the
 *              box, contract instructions, never hand-rolled here)
 *   200        LAND: the dice arrive lower-left and vanish
 *   267        SWAP: a skin-tone HAND, 1.3 u tall, is already drawn at ~60%
 *              scale, cupping the dice at its base, covering the avatar's
 *              LEFT half
 *   ~300-5500  the hand shakes in a repeating ~1.4 s cycle: upright hold,
 *              dip, turn palm-down and jiggle, low hold, shake, loop. THIS
 *              is the reference's own words for the pattern; the avatar's
 *              right half, "BB" badge, name and stack stay visible the
 *              whole time.
 *   5500       CUT
 *
 * EVERY MS ABOVE IS CORRECTED - the catalogue's raw number minus the 133 ms
 * this throw's `L` sits before the flight (THROW 8's `L` is the spawn frame;
 * see the warning above `## Throws` in pokerbros-reference-video-1.md). The
 * raw table reads 333 / 367 / 5600; this block used to quote those, which put
 * every line 133 ms later than the frame it names.
 *
 * Everything in the Payload is `animation-delay` from LANDING, and LANDING IS
 * `flight.ms` = 200, the flight's own measured duration. It is NOT 233: that
 * was this header's earlier arithmetic (raw land 333 minus a 100 ms spawn),
 * and it counted twelve frames where the capture shows eleven intervals. The
 * player's own arrival CSS (`thr__payload--land`) supplies the hand's own
 * pop-in; this rig only owns the loop.
 *
 * Sound (plan 4A / build sheet 622, and the reference's own measured click
 * timestamps, video 1 THROW 8 audio section): `dice_rattle` bursts ONLY
 * while the hand visibly shakes - never a loop, per the task brief, because
 * the reference is silent through the spawn, flight, land and every "hold":
 *   burst 1 (six clicks, ~130 ms apart): 1300, 1433, 1567, 1700, 1833, 2033
 *   burst 2 (two clicks, all the reference captured): 2767, 2900
 *   burst 3 (measured 4967-5700; the fifth click at 5700 lands after the
 *     build sheet's stated cut at 5600, so it is dropped - see the report)
 *     4967, 5133, 5367, 5500
 */

import type { ThrowableSpec } from '../spec';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import { preloadThrowableCues } from '../cues';
import './dice.css';

export const diceSpec: ThrowableSpec = {
  id: 'dice',
  name: 'Dice',
  tier: 'free',
  category: 'objects',
  spawn: 'avatar-face',
  spawnMs: 100,
  flight: { ms: 200, mode: 'straight', tumble: true },
  arrival: 'land',
  payload: { sizeU: 1.3, anchor: 'left', coversAvatar: true, ms: 5300 },
  beats: [
    { at: 200, marker: 'land' },
    { at: 267, marker: 'hand-in' },
    { at: 1200, marker: 'shake-1' },
    { at: 2700, marker: 'shake-2' },
    { at: 4900, marker: 'shake-3' },
    { at: 5500, marker: 'cut' },
  ],
  audio: [
    { at: 1200, sample: 'dice_rattle' },
    { at: 1333, sample: 'dice_rattle' },
    { at: 1467, sample: 'dice_rattle' },
    { at: 1600, sample: 'dice_rattle' },
    { at: 1733, sample: 'dice_rattle' },
    { at: 1933, sample: 'dice_rattle' },
    { at: 2667, sample: 'dice_rattle' },
    { at: 2800, sample: 'dice_rattle' },
    { at: 4867, sample: 'dice_rattle' },
    { at: 5033, sample: 'dice_rattle' },
    { at: 5267, sample: 'dice_rattle' },
    { at: 5400, sample: 'dice_rattle' },
  ],
  reference: { video: 1, launchFrame: 1716, throw: 'THROW 8' },
};

preloadThrowableCues(diceSpec.audio.map((c) => c.sample));

const DICE_WHITE = '#fdfdfb';
const DICE_SHADE = '#e2e2dd';
const DICE_EDGE = '#c7c7c1';
const PIP_BLACK = '#242327';
const SKIN = '#e6b088';
const SKIN_SHADE = '#c98f60';
const SKIN_HILITE = '#f7d6ae';
const SKIN_LINE = '#b97a4c';

/** A single die, 20 units square, drawn around (0,0) with a light 3-D bevel
 *  and the given pip layout (fixed dot coordinates, never random). */
function Die({ pips }: { pips: ReadonlyArray<readonly [number, number]> }) {
  return (
    <g>
      <rect
        x={-10}
        y={-10}
        width={20}
        height={20}
        rx={3}
        fill={DICE_WHITE}
        stroke={DICE_EDGE}
        strokeWidth="1.2"
      />
      <path
        d="M -10 -7 Q -10 -10 -7 -10 L 7 -10"
        fill="none"
        stroke="#ffffff"
        strokeWidth="1.4"
        opacity="0.8"
      />
      <path
        d="M -6 9 L 6 9 Q 9 9 9 6 L 9 -6"
        fill="none"
        stroke={DICE_SHADE}
        strokeWidth="1.1"
        opacity="0.7"
      />
      {pips.map(([px, py], i) => (
        <circle key={i} cx={px} cy={py} r={1.9} fill={PIP_BLACK} />
      ))}
    </g>
  );
}

const PIPS_5: ReadonlyArray<readonly [number, number]> = [
  [-5, -5],
  [5, -5],
  [0, 0],
  [-5, 5],
  [5, 5],
];
const PIPS_3: ReadonlyArray<readonly [number, number]> = [
  [-5, -5],
  [0, 0],
  [5, 5],
];

/** The pair, stuck together, drawn once for the projectile and once (static,
 *  half-hidden) at the base of the hand. The player's own tumble class spins
 *  the WHOLE box in flight - this component never rotates itself. */
function DicePair() {
  return (
    <g>
      <g transform="translate(-9 4) rotate(-6)">
        <Die pips={PIPS_5} />
      </g>
      <g transform="translate(9 -3) rotate(8)">
        <Die pips={PIPS_3} />
      </g>
    </g>
  );
}

/**
 * A capsule finger/thumb: a rounded rect from the base up, with a small
 * crease near the tip. `h` is its length, `w` its width, both in units.
 */
function Digit({ w, h }: { w: number; h: number }) {
  return (
    <g>
      <rect
        x={-w / 2}
        y={-h}
        width={w}
        height={h}
        rx={w / 2}
        fill={SKIN}
        stroke={SKIN_LINE}
        strokeWidth="0.8"
      />
      <path
        d={`M ${-w / 2 + 1.5} ${-h * 0.32} L ${w / 2 - 1.5} ${-h * 0.32}`}
        stroke={SKIN_LINE}
        strokeWidth="0.7"
        opacity="0.55"
      />
      <ellipse
        cx={-w * 0.18}
        cy={-h * 0.78}
        rx={w * 0.22}
        ry={h * 0.12}
        fill={SKIN_HILITE}
        opacity="0.6"
      />
    </g>
  );
}

/**
 * The open hand, palm-forward, fingers up, cupping the dice at its base -
 * the measured 1.3 u tall payload. Drawn around (0,0) with the wrist toward
 * the bottom so the whole group's transform-origin can sit at the wrist for
 * a believable shake pivot.
 */
function Hand({ uid }: { uid: string }) {
  const g = (n: string) => `thr-dice-${n}-${uid}`;
  return (
    <g>
      <defs>
        <radialGradient id={g('palm')} cx="0.4" cy="0.3" r="0.85">
          <stop offset="0%" stopColor={SKIN_HILITE} />
          <stop offset="55%" stopColor={SKIN} />
          <stop offset="100%" stopColor={SKIN_SHADE} />
        </radialGradient>
      </defs>
      {/* the palm, base at the bottom */}
      <path
        d="M -32 40 C -40 40 -42 20 -38 4 C -35 -10 -26 -18 -14 -20 L 14 -20 C 26 -18 35 -8 37 6 C 41 22 38 40 30 40 Z"
        fill={`url(#${g('palm')})`}
        stroke={SKIN_LINE}
        strokeWidth="1.2"
      />
      {/* four fingers, fanned, tallest in the middle */}
      <g transform="translate(-24 -18) rotate(-14)">
        <Digit w={11} h={46} />
      </g>
      <g transform="translate(-9 -20)">
        <Digit w={12} h={58} />
      </g>
      <g transform="translate(7 -20) rotate(3)">
        <Digit w={12} h={56} />
      </g>
      <g transform="translate(22 -17) rotate(15)">
        <Digit w={10} h={42} />
      </g>
      {/* the thumb, low and to the side */}
      <g transform="translate(-36 18) rotate(-55)">
        <Digit w={12} h={34} />
      </g>
      {/* the dice, cupped at the base, mostly under the palm's lower edge */}
      <g transform="translate(-2 30) scale(0.85)">
        <DicePair />
      </g>
      {/* a few knuckle creases for read at a glance */}
      <path
        d="M -20 -14 Q -18 -10 -20 -6 M -6 -16 Q -4 -11 -6 -6 M 9 -16 Q 11 -11 9 -6 M 23 -13 Q 25 -9 23 -5"
        fill="none"
        stroke={SKIN_LINE}
        strokeWidth="0.7"
        opacity="0.5"
      />
    </g>
  );
}

function Projectile() {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <DicePair />
    </svg>
  );
}

function Payload({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      {/* 367 (+134): the hand, already cupping the dice. The player's own
          `thr__payload--land` class supplies the pop-in; this group owns
          only the repeating shake. */}
      <g transform="translate(0 12)">
        <g className="thr-dice__hand">
          <Hand uid={uid} />
        </g>
      </g>
    </svg>
  );
}

export const diceRig: ThrowableRig = { Projectile, Payload };
