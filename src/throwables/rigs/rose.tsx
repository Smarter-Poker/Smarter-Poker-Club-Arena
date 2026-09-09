/**
 * ===============================================================================
 *  ROSE - a rose behind the ear, a butterfly, a kiss (phase 2, 2026-09-06)
 * ===============================================================================
 *
 * Measured off PB THROWABLE 2.MOV, THROW 13 (launch f2511, 30 fps, target
 * avatar 40 px wide, so 1 px = 2.5 units), see
 * docs/throwables/pokerbros-reference-video-2.md and the build sheet in
 * docs/throwables/THROWABLES-PREMIUM-ANIMATION-PLAN.md section 4A. ms from
 * LAUNCH:
 *
 *   -233..-33   the rose pops in at the thrower's upper-left and holds: a red
 *               bloom 0.25 u across on a green stem, 0.4 u tall overall
 *   33-300      straight upright flight at ~23 px/frame; no spin, no scale
 *   333         CONTACT: the rose is still whole, on the target's face
 *   367-467     the rose is INVISIBLE - four frames of nothing
 *   500-533     a small red BUD appears behind the target's RIGHT EAR, at
 *               x +0.275 u, y -0.5 u
 *   567-667     the bud GROWS into a full rose, tilted 30 deg to the right,
 *               tucked behind the ear like a hair ornament
 *   700-833     the rose is static
 *   867-3033    a pink BUTTERFLY flutters 0.41 u right and 0.99 u above the
 *               avatar centre, drifting an 8 px (0.2 u) radius loop, its
 *               wings alternating open/closed EVERY 2 FRAMES (a 67 ms step)
 *   1467        a red LIPSTICK KISS appears on the right cheek, 8 px wide
 *   1500-2500   the kiss grows 8 -> 11 px
 *   2633-3033   the kiss DRIFTS DOWN the face ~15 px, cheek to chin, at
 *               ~1 px/frame, while the rose and the butterfly stay put
 *   3500        CUT (the reference's seat was covered by the next dialog at
 *               3167 and clean behind it, so the build sheet's ~3500 is used)
 *
 * THREE INDEPENDENT THREADS that overlap: the ear rose, the butterfly and the
 * kiss each run their own clock from the moment they appear. Nothing waits for
 * anything else, which is why the payload reads as a scene rather than a list.
 *
 * Everything in the Payload is `animation-delay` from LANDING (333), so the
 * catalogue's "at" minus 333: bud 167, rose 234, butterfly 534, kiss 1134,
 * drift 2300. The comments keep both numbers.
 *
 * Sound (plan 4A): ONE soft `harp_sparkle` at 767, three frames before the
 * butterfly. The reference's cue runs 767-2333 and decays smoothly; it is a
 * one-shot, not a loop. The kiss and the drift are SILENT by design.
 */

import type { ThrowableSpec } from '../spec';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import { preloadThrowableCues } from '../cues';
import './rose.css';
import { AtlasSprite } from '../AtlasSprite';

export const roseSpec: ThrowableSpec = {
  id: 'rose',
  name: 'Rose',
  tier: 'free',
  category: 'cheers',
  spawn: 'avatar-corner',
  spawnMs: 233,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'none',
  payload: { sizeU: 1.0, anchor: 'face', coversAvatar: false, ms: 3167 },
  beats: [
    { at: 333, marker: 'land' },
    { at: 367, marker: 'vanish' },
    { at: 500, marker: 'bud' },
    { at: 567, marker: 'bloom' },
    { at: 700, marker: 'rose-set' },
    { at: 867, marker: 'butterfly' },
    { at: 1467, marker: 'kiss' },
    { at: 2633, marker: 'kiss-drift' },
    { at: 3500, marker: 'cut' },
  ],
  audio: [{ at: 767, sample: 'harp_sparkle' }],
  reference: { video: 2, launchFrame: 2511, throw: 'THROW 13' },
};

preloadThrowableCues(roseSpec.audio.map((c) => c.sample));

/** Complete approved rose replaces the clipped atlas bloom. */
function Rose() {
  return (
    <AtlasSprite
      src="rose-bloom"
      rect={[0, 0, 1254, 1254]}
      x={-19}
      y={-25}
      width={38}
      height={46}
    />
  );
}
function Bud() {
  return (
    <AtlasSprite src="rose" rect={[20, 135, 340, 535]} x={-12} y={-25} width={24} height={46} />
  );
}
function Butterfly() {
  return (
    <g className="thr-rose__wings">
      <AtlasSprite src="rose" rect={[15, 750, 505, 407]} x={-13} y={-10} width={26} height={21} />
    </g>
  );
}
function Kiss() {
  return (
    <AtlasSprite src="rose" rect={[833, 810, 403, 307]} x={-11} y={-8} width={22} height={16} />
  );
}

function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Rose />
    </svg>
  );
}

function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      {/* 333 (+0): the rose that flew, whole, where the flight left it. It is
          shown for ONE frame and then hidden in one frame at +34, which is the
          reference's four blank frames before the bud. */}
      <g className="thr-rose__landed">
        <Rose />
      </g>

      {/* 500 (+167): the BUD, behind the right ear at x +0.275 u, y -0.5 u.
          Gone in one frame at +234, when the bloom takes its place. */}
      <g transform="translate(27.5 -50)">
        <g className="thr-rose__bud">
          <Bud />
        </g>
      </g>

      {/* 567-667 (+234..+334): the bloom grows in the bud's place, tilted
          30 deg to the right. The tilt is a STATIC transform on the outer
          group; only the scale animates. */}
      <g transform="translate(27.5 -50) rotate(30)">
        <g className="thr-rose__ear">
          <Rose />
        </g>
      </g>

      {/* 1467 (+1134): the KISS on the right cheek; grows to 1.375x by 2500,
          then walks 0.375 u down to the chin between 2633 and 3033. */}
      <g transform="translate(20 7.5)">
        <g className="thr-rose__kiss">
          <Kiss />
        </g>
      </g>

      {/* 867-3033 (+534..+2700): the BUTTERFLY, at the centre of its own 8 px
          loop, 0.41 u right and 0.99 u above the avatar centre. Drawn last so
          it flies over the rose. */}
      <g transform="translate(41 -99)">
        <g className="thr-rose__butterfly">
          <g className="thr-rose__flutter">
            <Butterfly />
          </g>
        </g>
      </g>
    </svg>
  );
}

export const roseRig: ThrowableRig = { Projectile, Payload };
