/**
 * ===============================================================================
 *  BOMB - a fuse that flickers, a bomb that just sits there, a jagged burst,
 *  a puff of smoke, nothing left behind (phase 2, 2026-09-07)
 * ===============================================================================
 *
 * Measured off PB THROWABLE 2.MOV, Throw 12 (launch f2349, 30 fps, target
 * avatar 40 px wide, so 1 px = 2.5 units), see
 * docs/throwables/pokerbros-reference-video-2.md lines 642-688 and the build
 * sheet at docs/throwables/THROWABLES-PREMIUM-ANIMATION-PLAN.md line 726.
 *
 * VIDEO 2's `L` IS THE LAUNCH FRAME - no offset needed. ms from LAUNCH:
 *
 *   -167       the bomb pops in on the thrower's head, small
 *   -133..-33  scale-in and HOLD: black sphere ~14 px (35% of avatar) with a
 *              short fuse up-right and a tiny yellow spark at the tip
 *   0-233      straight flight, 23 px/frame, no spin, no scale, spark
 *              visible throughout
 *   267        LANDS on the upper half of the avatar and STAYS - it does
 *              NOT burst on contact
 *   267-1433   FUSE phase (1.2 s): the bomb sits static (~16 px, covering the
 *              forehead); the yellow 4-point spark at the fuse tip FLICKERS,
 *              changing size/shape every frame (3-7 px); the fuse itself
 *              shortens slightly
 *   1433       pre-flash: yellow cracks/glow appear INSIDE the black sphere
 *   1467       EXPLOSION: a jagged yellow-orange burst ~40 px centred on the
 *              avatar
 *   1500-1533  burst at full size ~45 px (1.1x avatar): a spiky yellow flower
 *              with an orange core, avatar hidden
 *   1567       the burst turns translucent yellow-khaki
 *   1600-1667  SMOKE puff: a khaki/beige translucent cloud ~45 px, avatar
 *              visible through it
 *   1700-1800  the smoke thins, drifts up-left ~6 px, fades
 *   1833       seat CLEAN - no residue
 *
 * Everything in the Payload is `animation-delay` from LANDING (267), so the
 * catalogue's "at" minus 267: pre-flash 1166, explosion 1200, full 1233,
 * smoke 1333, clean 1566. The comments keep both numbers.
 *
 * THE ONE CHOSEN NUMBER. The reference's own arithmetic gives payload.ms =
 * 1833 - 267 = 1566, and that is what this rig was HANDED. But
 * THROWABLE_GRAMMAR.payloadMs floors every item at 1600 ms
 * (src/throwables/spec.ts), and 1566 is under it - the one item in this pass
 * that would have shipped failing its own spec test. Raised to the floor,
 * 1600, which costs the smoke one extra frame (34 ms) of held, fully-faded
 * emptiness before the payload unmounts; nothing is drawn in that frame, so
 * nothing is added to what the reference shows. Every keyframe below still
 * ends by 1566 (see the `.thr-bomb__smoke` comment), so this spends none of
 * the borrowed frame - it is pure headroom under the floor, not a stretch of
 * the reference. Flagged here rather than quietly "fixed" so it can be
 * checked against the reference's own 1833 - 267 arithmetic.
 *
 * Sound (build sheet + the doc's own audio note): `fuse_ignite` at 433 (13
 * frames after landing, the start of the ignition fizz); `fuse_sizzle` 700 to
 * the pre-flash frame (1433), looping; `boom` at 1500, 1 frame after the
 * visual burst (1467) - the same one-frame reading convention poop's splat
 * keeps.
 */

import type { ThrowableSpec } from '../spec';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import { preloadThrowableCues } from '../cues';
import './bomb.css';
import { AtlasSprite } from '../AtlasSprite';

export const bombSpec: ThrowableSpec = {
  id: 'bomb',
  name: 'Bomb',
  tier: 'free',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 167,
  flight: { ms: 267, mode: 'straight', upright: true },
  arrival: 'none',
  // 1566, the MEASURED payload: clean at 1833 minus the 267 ms landing. It was
  // written as 1600 first, clamped up to the grammar's floor - but the floor was
  // the thing that was wrong (it had been read off a life table that measures
  // spawn-to-clean, and the bomb spends 434 ms of its 2.0 s life before the
  // payload exists). The floor is 1566 now and is derived from this very number;
  // see THROWABLE_GRAMMAR in spec.ts.
  payload: { sizeU: 1.1, anchor: 'face', coversAvatar: true, ms: 1566 },
  beats: [
    { at: 267, marker: 'land' },
    { at: 1433, marker: 'pre-flash' },
    { at: 1467, marker: 'explosion' },
    { at: 1500, marker: 'full' },
    { at: 1600, marker: 'smoke' },
    { at: 1833, marker: 'clean' },
  ],
  audio: [
    { at: 433, sample: 'fuse_ignite' },
    { at: 700, sample: 'fuse_sizzle', loopUntil: 1433, gain: 0.8 },
    { at: 1500, sample: 'boom' },
  ],
  reference: { video: 2, launchFrame: 2349, throw: 'Throw 12' },
};

preloadThrowableCues(bombSpec.audio.map((c) => c.sample));

/** Body and independent burning fuse retain the measured explosion timeline. */
function BombSphere() {
  return (
    <AtlasSprite src="bomb" rect={[72, 315, 325, 350]} x={-21} y={-25} width={42} height={45} />
  );
}
function Fuse() {
  return (
    <AtlasSprite
      src="bomb"
      rect={[167, 135, 163, 216]}
      clipPath="polygon(0 0,100% 0,100% 100%,55% 100%,55% 40%,0 25%)"
      x={-9}
      y={-49}
      width={22}
      height={29}
    />
  );
}
function Spark() {
  return (
    <AtlasSprite src="bomb" rect={[975, 846, 266, 271]} x={-7} y={-7} width={14} height={14} />
  );
}
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <BombSphere />
      <Fuse />
      <g transform="translate(-9 -46)">
        <Spark />
      </g>
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-bomb__body">
        <BombSphere />
        <g className="thr-bomb__crackglow">
          <AtlasSprite
            src="bomb"
            rect={[975, 846, 266, 271]}
            x={-16}
            y={-18}
            width={32}
            height={32}
          />
        </g>
      </g>
      <g className="thr-bomb__fuse">
        <Fuse />
      </g>
      <g transform="translate(-9 -46)">
        <g className="thr-bomb__spark">
          <Spark />
        </g>
      </g>
      <g className="thr-bomb__burst">
        <AtlasSprite
          src="rocket"
          rect={[390, 685, 462, 490]}
          x={-55}
          y={-55}
          width={110}
          height={110}
        />
      </g>
      <g className="thr-bomb__smoke">
        <AtlasSprite
          src="bomb"
          rect={[537, 753, 422, 404]}
          x={-51}
          y={-51}
          width={102}
          height={102}
        />
      </g>
    </svg>
  );
}
export const bombRig: ThrowableRig = { Projectile, Payload };
