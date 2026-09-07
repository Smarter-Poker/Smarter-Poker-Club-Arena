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

/** The measured reds and greens of the reference sprite. */
const STEM_GREEN = '#3c7a2e';
const STEM_EDGE = '#2a5f22';
const ROSE_CORE = '#8d0a26';
/** The kiss reads as a deeper lipstick red than the bloom, as in the capture. */
const KISS_RED = '#c9143c';
const KISS_EDGE = '#8e0b28';
const WING_PINK = '#f79ec0';
const WING_DEEP = '#ea5f92';
const WING_EDGE = '#c33f74';

/**
 * The rose, drawn around (0,0): a bloom 26 units across with the stem hanging
 * down-left and one leaf on it, 40 units from the top of the bloom to the tip
 * of the stem (the measured 16 px on a 40 px avatar). Upright; the payload
 * tilts the ear copy with a static transform, nothing rotates at runtime.
 * `k` keeps the projectile's, the landed copy's and the ear copy's gradients
 * apart - three of these mount at once.
 */
function Rose({ uid, k }: { uid: string; k: string }) {
  const g = (n: string) => `thr-rose-${n}-${uid}-${k}`;
  return (
    <g>
      <defs>
        <radialGradient id={g('bloom')} cx="0.38" cy="0.3" r="0.78">
          <stop offset="0%" stopColor="#ff728d" />
          <stop offset="34%" stopColor="#e0234a" />
          <stop offset="72%" stopColor="#c00f34" />
          <stop offset="100%" stopColor="#7d0620" />
        </radialGradient>
        <linearGradient id={g('leaf')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6cb84a" />
          <stop offset="100%" stopColor="#2f6f28" />
        </linearGradient>
      </defs>
      {/* the stem, curving down-left, drawn first so the bloom sits over it */}
      <path
        d="M 0 5 C -1 13, -5 19, -10 24"
        fill="none"
        stroke={STEM_GREEN}
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      {/* one leaf on the stem, pointing down-left */}
      <path
        d="M -3.5 14 C -11 11.5, -18.5 14.5, -21 20.5 C -14 23.5, -5.5 20.5, -3.5 14 Z"
        fill={`url(#${g('leaf')})`}
        stroke={STEM_EDGE}
        strokeWidth="0.7"
        strokeLinejoin="round"
      />
      <path
        d="M -4.5 15 C -10.5 16.5, -16 18.5, -20 20.5"
        fill="none"
        stroke={STEM_EDGE}
        strokeWidth="0.6"
        opacity="0.7"
      />
      {/* the sepals under the bloom */}
      <path d="M -8 5 C -5.5 11, 5.5 11, 8 5 C 4 8, -4 8, -8 5 Z" fill={STEM_GREEN} />
      {/* the bloom */}
      <ellipse cx="0" cy="-2" rx="13" ry="12" fill={`url(#${g('bloom')})`} />
      {/* the outer petal edge, a lighter rim over the top of the bloom */}
      <path
        d="M -13 -3 C -13 -11, -6 -15, 0 -13 C 6 -15, 13 -11, 13 -3 C 9 -8.5, 4 -10.5, 0 -9.5 C -4 -10.5, -9 -8.5, -13 -3 Z"
        fill="#ef5a7c"
        opacity="0.5"
      />
      {/* the spiral: two nested petal creases in the core red */}
      <path
        d="M 2.5 2.5 C -3.5 2.5, -6 -2.5, -2 -6 C 2.5 -9.5, 9 -5.5, 8 0.5"
        fill="none"
        stroke={ROSE_CORE}
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.75"
      />
      <path
        d="M -9.5 3.5 C -11.5 -4.5, -5 -12, 3 -11 C 10 -10, 13 -3.5, 11 2.5"
        fill="none"
        stroke={ROSE_CORE}
        strokeWidth="1.3"
        strokeLinecap="round"
        opacity="0.5"
      />
      {/* the top-left highlight */}
      <ellipse
        cx="-5"
        cy="-7"
        rx="4.6"
        ry="2.6"
        transform="rotate(-30 -5 -7)"
        fill="#ffffff"
        opacity="0.36"
      />
    </g>
  );
}

/**
 * The BUD: the two-frame closed teardrop the reference shows behind the ear
 * before the bloom opens. 13 units wide, 16 tall, its base at y +7 so it grows
 * from the stem.
 */
function Bud({ uid }: { uid: string }) {
  const g = (n: string) => `thr-rose-${n}-${uid}-bud`;
  return (
    <g>
      <defs>
        <radialGradient id={g('bud')} cx="0.36" cy="0.28" r="0.8">
          <stop offset="0%" stopColor="#ff6f8b" />
          <stop offset="45%" stopColor="#d61a41" />
          <stop offset="100%" stopColor="#84081f" />
        </radialGradient>
      </defs>
      <path
        d="M 0 4 L -3 12"
        fill="none"
        stroke={STEM_GREEN}
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <path d="M -5 2 C -7 8, -2 10, 0 5 C 2 10, 7 8, 5 2 Z" fill={STEM_GREEN} />
      <path
        d="M 0 -9 C 5 -9, 7 -4, 6 1 C 5 5, 2 7, 0 7 C -2 7, -5 5, -6 1 C -7 -4, -5 -9, 0 -9 Z"
        fill={`url(#${g('bud')})`}
      />
      <path
        d="M 0 -8 C 2 -4, 2 2, 0 6"
        fill="none"
        stroke={ROSE_CORE}
        strokeWidth="1"
        opacity="0.6"
      />
    </g>
  );
}

/**
 * The BUTTERFLY, drawn around (0,0), 15 units across. The reference's is 5 px
 * (12.5 units); this is drawn a hair wider so the antennae and the wing edge
 * survive at the smallest seat rung. The two wing pairs live in ONE group so
 * they flap together - the reference alternates the whole pair open/closed.
 */
function Butterfly() {
  return (
    <g>
      <g className="thr-rose__wings">
        {/* upper wings */}
        <path
          d="M -1 -1.2 C -4.6 -6.6, -8.6 -5.8, -7.5 -1.4 C -6.7 1.8, -3.6 2.6, -1 1.4 Z"
          fill={WING_PINK}
          stroke={WING_EDGE}
          strokeWidth="0.45"
          strokeLinejoin="round"
        />
        <path
          d="M 1 -1.2 C 4.6 -6.6, 8.6 -5.8, 7.5 -1.4 C 6.7 1.8, 3.6 2.6, 1 1.4 Z"
          fill={WING_PINK}
          stroke={WING_EDGE}
          strokeWidth="0.45"
          strokeLinejoin="round"
        />
        {/* lower wings */}
        <path
          d="M -1 1.3 C -3.9 2.4, -6.2 4.8, -4.8 6.4 C -3.3 7.8, -1.4 5.2, -1 2.8 Z"
          fill={WING_DEEP}
          stroke={WING_EDGE}
          strokeWidth="0.4"
          strokeLinejoin="round"
        />
        <path
          d="M 1 1.3 C 3.9 2.4, 6.2 4.8, 4.8 6.4 C 3.3 7.8, 1.4 5.2, 1 2.8 Z"
          fill={WING_DEEP}
          stroke={WING_EDGE}
          strokeWidth="0.4"
          strokeLinejoin="round"
        />
      </g>
      {/* body and antennae, over the wings */}
      <ellipse cx="0" cy="0.4" rx="1" ry="4.2" fill="#6e3149" />
      <path
        d="M -0.5 -3.6 C -1.6 -5.8, -3 -6.8, -4.2 -7.2"
        fill="none"
        stroke="#6e3149"
        strokeWidth="0.55"
        strokeLinecap="round"
      />
      <path
        d="M 0.5 -3.6 C 1.6 -5.8, 3 -6.8, 4.2 -7.2"
        fill="none"
        stroke="#6e3149"
        strokeWidth="0.55"
        strokeLinecap="round"
      />
    </g>
  );
}

/**
 * The LIPSTICK KISS: a two-lobed lip print 20 units wide (the measured 8 px)
 * around (0,0), with the cupid's bow on the upper lip and a gap between the
 * lips. The payload grows it to 1.375x (the measured 11 px) and then walks it
 * down the face.
 */
function Kiss() {
  return (
    <g>
      <path
        d="M -10 -1 C -8.2 -6.2, -3.2 -6.4, 0 -3.1 C 3.2 -6.4, 8.2 -6.2, 10 -1 C 6.2 0.9, -6.2 0.9, -10 -1 Z"
        fill={KISS_RED}
        stroke={KISS_EDGE}
        strokeWidth="0.7"
        strokeLinejoin="round"
      />
      <path
        d="M -9 1.6 C -7 7.4, 7 7.4, 9 1.6 C 4 3.5, -4 3.5, -9 1.6 Z"
        fill={KISS_RED}
        stroke={KISS_EDGE}
        strokeWidth="0.7"
        strokeLinejoin="round"
      />
      {/* the two lip creases that make it read as a print rather than a blob */}
      <path
        d="M -5.5 -4.4 L -4.6 -1.2 M -1 -4.6 L -0.8 -1.4 M 3.4 -4.6 L 2.8 -1.4"
        fill="none"
        stroke={KISS_EDGE}
        strokeWidth="0.55"
        strokeLinecap="round"
        opacity="0.65"
      />
      <path
        d="M -4.8 2.9 L -4.2 5.4 M 0 3.3 L 0 6 M 4.8 2.9 L 4.2 5.4"
        fill="none"
        stroke={KISS_EDGE}
        strokeWidth="0.55"
        strokeLinecap="round"
        opacity="0.65"
      />
    </g>
  );
}

function Projectile({ uid }: RigProps) {
  return (
    <svg
      viewBox={RIG_VIEWBOX}
      aria-hidden="true"
      focusable="false"
      className="thr-rose thr-rose--proj"
    >
      <Rose uid={uid} k="p" />
    </svg>
  );
}

function Payload({ uid }: RigProps) {
  return (
    <svg
      viewBox={RIG_VIEWBOX}
      aria-hidden="true"
      focusable="false"
      className="thr-rose thr-rose--payload"
    >
      {/* 333 (+0): the rose that flew, whole, where the flight left it. It is
          shown for ONE frame and then hidden in one frame at +34, which is the
          reference's four blank frames before the bud. */}
      <g className="thr-rose__landed">
        <Rose uid={uid} k="a" />
      </g>

      {/* 500 (+167): the BUD, behind the right ear at x +0.275 u, y -0.5 u.
          Gone in one frame at +234, when the bloom takes its place. */}
      <g transform="translate(27.5 -50)">
        <g className="thr-rose__bud">
          <Bud uid={uid} />
        </g>
      </g>

      {/* 567-667 (+234..+334): the bloom grows in the bud's place, tilted
          30 deg to the right. The tilt is a STATIC transform on the outer
          group; only the scale animates. */}
      <g transform="translate(27.5 -50) rotate(30)">
        <g className="thr-rose__ear">
          <Rose uid={uid} k="b" />
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
