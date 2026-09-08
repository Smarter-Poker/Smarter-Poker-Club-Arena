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
import { AtlasSprite } from '../AtlasSprite';

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

/** Body and lid are independent parts; the lid remains inside the returning can. */
function CanBody() {
  return (
    <AtlasSprite
      src="trash_can"
      rect={[0, 90, 470, 550]}
      clipPath="polygon(0 0,100% 0,100% 40%,88% 40%,88% 100%,0 100%)"
      x={-42}
      y={-49}
      width={84}
      height={98}
    />
  );
}
function Lid() {
  return (
    <AtlasSprite
      src="trash_can"
      rect={[415, 290, 470, 290]}
      clipPath="polygon(12% 0,100% 0,100% 100%,0 100%,0 20%,12% 20%)"
      x={-40}
      y={-65}
      width={80}
      height={49}
    />
  );
}
function CanClosed() {
  return (
    <g>
      <CanBody />
      <Lid />
    </g>
  );
}
function PlayingCard({ digit }: { digit: 'two' | 'seven' }) {
  const rect = digit === 'two' ? ([880, 105, 345, 530] as const) : ([40, 655, 350, 515] as const);
  // Upright source cards let the animation own their orientation.
  return (
    <g>
      <AtlasSprite src="trash_can" rect={rect} x={-26} y={-36} width={52} height={72} />
    </g>
  );
}
function Bubble() {
  return (
    <AtlasSprite
      src="trash_can"
      rect={[825, 765, 425, 365]}
      x={-22}
      y={-30}
      width={44}
      height={38}
    />
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
      <AtlasSprite
        src="trash_can"
        rect={[392, 703, 411, 449]}
        x={-6}
        y={-6}
        width={12}
        height={12}
      />
    </g>
  );
}

function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <CanClosed />
    </svg>
  );
}

function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      {/* 333 (+0): the can, whole, where the flight left it. Visible one
          frame, then gone entirely at 533 (+200). */}
      <g className="thr-trash_can__landed">
        <CanClosed />
      </g>

      {/* 833 (+500): the "2" pops upper-left, grows and slides to the lower-
          left, later shifts right, later rises and falls into the can. ONE
          continuous life, like the rose's kiss. */}
      <g className="thr-trash_can__card2">
        <PlayingCard digit="two" />
      </g>

      {/* 1000 (+667): the "7" pops upper-right, mirrors the 2 a beat later. */}
      <g className="thr-trash_can__card7">
        <PlayingCard digit="seven" />
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
          <CanBody />
          {/* The lid rides the same rise/scale as the body before opening. */}
          <g className="thr-trash_can__lid">
            <Lid />
          </g>
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
