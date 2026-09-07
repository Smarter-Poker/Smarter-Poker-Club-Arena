/**
 * ===============================================================================
 *  BANANA PEEL - a flash, and a peel that lands like a hat (phase 2, 2026-09-07)
 * ===============================================================================
 *
 * Measured off PB THROWABLE 2.MOV, THROW 4 (launch f675, 30 fps, target avatar
 * 40 px wide, so 1 px = 2.5 units), see
 * docs/throwables/pokerbros-reference-video-2.md lines 267-301, and the build
 * sheet in docs/throwables/THROWABLES-PREMIUM-ANIMATION-PLAN.md ("banana_peel",
 * line ~690). THIS TABLE'S "L" IS THE LAUNCH FRAME (f675 = 0 ms) - the doc says
 * so explicitly ("Beat table (launch frame f675 = 0 ms)") - so every "ms" below
 * drops straight into `beats`/`audio` with nothing subtracted, unlike snowman's
 * table, which was measured from spawn.
 *
 * ms from LAUNCH:
 *
 *   -167..-33  banana pops in on the hero's head and holds, small then full
 *              size (~22 px, peeled banana, yellow (219,193,43), tilted
 *              up-right, top-right of the avatar)
 *   0-100      straight flight at ~25 px/frame, no spin, no scale; CONTACT at
 *              100 (the raw capture's own last flight frame - the eagle's
 *              avatar edge)
 *   133        IMPACT FLASH: yellow star-burst, white core, ~20 px, at the
 *              top of the target's head; the banana is still visible inside it
 *   167        the flash grows to ~28 px with 5-6 rays and a couple of
 *              sparkle dots
 *   200        the flash is gone. RESIDUE: the banana peel lies draped over
 *              the top of the avatar like a hat, ~24 px wide, 40% of the
 *              avatar covered, the face still visible underneath
 *   233-2800+  residue STATIC, no fade, no motion
 *   ~3500      CUT (the reference's own residue life ran 2.6-5.7 s, until the
 *              next dialog covered the seat; the build sheet's ~3500 is used,
 *              matching every other item this length)
 *
 * A NUMBER CHOSEN, NOT READ (flight.ms): the raw capture's flight is only
 * THREE frames, LAUNCH (f675) to CONTACT (f678) = 100 ms, below
 * `THROWABLE_GRAMMAR.flightMs.min` (133). Rounding up to the reference's very
 * next frame - f679, 133 ms, the flash's own FIRST visible frame - costs one
 * frame (33 ms) against the raw contact, and buys a landing that lines up with
 * a real measured frame instead of an arbitrary pad: the payload mounts
 * exactly when the flash opens, which is what the capture shows happening at
 * the target regardless of where the floor sits. `flight.ms = 133`.
 *
 * Everything in the Payload is `animation-delay` from LANDING (133), so the
 * catalogue's "at" minus 133: flash-grow 34, residue 67, cut 3367. The
 * comments keep both numbers.
 *
 * Sound (contract cue table + build sheet): ONE `boing_splat`, starting 70 ms
 * BEFORE the flash (the contract's explicit instruction) - the flash opens at
 * 133, so the cue fires at 63. The raw capture's own transient block actually
 * starts nearer f676 (33, ~100 ms before the flash), but the contract's
 * stated 70 ms figure is what this file schedules.
 */

import type { ThrowableSpec } from '../spec';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import { preloadThrowableCues } from '../cues';
import './banana_peel.css';

export const bananaPeelSpec: ThrowableSpec = {
  id: 'banana_peel',
  name: 'Banana Peel',
  tier: 'free',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 167,
  flight: { ms: 133, mode: 'straight', upright: true },
  arrival: 'none',
  payload: { sizeU: 0.75, anchor: 'face', coversAvatar: false, ms: 3367 },
  beats: [
    { at: 133, marker: 'flash' },
    { at: 167, marker: 'flash-grow' },
    { at: 200, marker: 'residue' },
    { at: 3500, marker: 'cut' },
  ],
  audio: [{ at: 63, sample: 'boing_splat' }],
  reference: { video: 2, launchFrame: 675, throw: 'THROW 4' },
};

preloadThrowableCues(bananaPeelSpec.audio.map((c) => c.sample));

/** The measured yellow, and the peel's slightly duller residue tones. */
const BANANA_LIGHT = '#f5e27a';
const BANANA_MID = '#dbc12b';
const BANANA_DARK = '#a8871a';
const BANANA_TIP = '#6b4a1e';
const PEEL_OUTER = '#d9b93a';
const PEEL_INNER = '#f7efd2';
const PEEL_EDGE = '#93741c';
const FLASH_CORE = '#ffffff';
const FLASH_RAY = '#ffd23d';
const FLASH_RAY_TIP = '#ffab00';

/**
 * The peeled banana, drawn around (0,0): a 54-unit crescent (the measured
 * 22 px on a 40 px avatar), tilted up-right by a STATIC transform so the
 * flight and the landed copy share one shape. `k` keeps the projectile's and
 * the payload's gradients apart - two of these mount at once.
 */
function Banana({ uid, k }: { uid: string; k: string }) {
  const g = (n: string) => `thr-banana_peel-${n}-${uid}-${k}`;
  return (
    <g transform="rotate(-24)">
      <defs>
        <linearGradient id={g('body')} x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0%" stopColor={BANANA_LIGHT} />
          <stop offset="55%" stopColor={BANANA_MID} />
          <stop offset="100%" stopColor={BANANA_DARK} />
        </linearGradient>
      </defs>
      <path
        d="M -27 9 C -17 -15, 12 -24, 27 -11 C 20 -3, 7 4, -6 9 C -15 12, -22 12, -27 9 Z"
        fill={`url(#${g('body')})`}
        stroke={BANANA_DARK}
        strokeWidth="1"
        strokeLinejoin="round"
      />
      {/* the two cut tips, left over from peeling */}
      <ellipse cx="-26" cy="8" rx="3.4" ry="2.6" transform="rotate(20 -26 8)" fill={BANANA_TIP} />
      <ellipse cx="26" cy="-11" rx="3" ry="2.2" transform="rotate(20 26 -11)" fill={BANANA_TIP} />
      {/* a couple of ripening speckles */}
      <ellipse cx="6" cy="-6" rx="1.4" ry="1" fill={BANANA_DARK} opacity="0.5" />
      <ellipse cx="-6" cy="3" rx="1.2" ry="0.9" fill={BANANA_DARK} opacity="0.4" />
      {/* the highlight along the outer curve */}
      <path
        d="M -20 3 C -12 -10, 6 -17, 20 -9"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity="0.45"
      />
    </g>
  );
}

/**
 * The star-burst flash: a hand-drawn 6-point star (white core, yellow rays)
 * with two small sparkle dots, drawn at its PEAK size (28 px = 70 units
 * across). The keyframe scales it down for the open frame and back up for
 * the peak; the points below are fixed, never computed at runtime.
 */
function Flash({ uid }: { uid: string }) {
  const g = (n: string) => `thr-banana_peel-${n}-${uid}`;
  return (
    <g>
      <defs>
        <radialGradient id={g('flash')} cx="0.5" cy="0.5" r="0.6">
          <stop offset="0%" stopColor={FLASH_CORE} />
          <stop offset="45%" stopColor={FLASH_RAY} />
          <stop offset="100%" stopColor={FLASH_RAY_TIP} />
        </radialGradient>
      </defs>
      <polygon
        points="0,-35 6.5,-11.3 30.3,-17.5 13,0 30.3,17.5 6.5,11.3 0,35 -6.5,11.3 -30.3,17.5 -13,0 -30.3,-17.5 -6.5,-11.3"
        fill={`url(#${g('flash')})`}
      />
      <circle cx="0" cy="0" r="7" fill={FLASH_CORE} opacity="0.85" />
      <circle cx="18" cy="-16" r="2.2" fill={FLASH_CORE} opacity="0.8" />
      <circle cx="-16" cy="14" r="1.6" fill={FLASH_CORE} opacity="0.7" />
    </g>
  );
}

/**
 * The residue: an open peel draped like a hat, three splayed strips fanning
 * down from a bunched crown, covering roughly 40% of the face. Yellow
 * outside, the pale inner skin showing where each strip has folded back.
 */
function Peel({ uid }: { uid: string }) {
  const g = (n: string) => `thr-banana_peel-${n}-${uid}`;
  return (
    <g>
      <defs>
        <linearGradient id={g('peel')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={PEEL_OUTER} />
          <stop offset="100%" stopColor={PEEL_EDGE} />
        </linearGradient>
      </defs>
      {/* the bunched crown where the three strips meet */}
      <ellipse cx="0" cy="-6" rx="9" ry="6" fill={PEEL_EDGE} />
      {/* left strip */}
      <g transform="rotate(-38)">
        <path
          d="M -4 -4 C -14 -2, -20 10, -14 24 C -10 30, -3 31, -1 26 C 2 16, 2 4, -4 -4 Z"
          fill={`url(#${g('peel')})`}
          stroke={PEEL_EDGE}
          strokeWidth="0.8"
          strokeLinejoin="round"
        />
        <path
          d="M -9 4 C -12 12, -11 20, -7 25"
          fill="none"
          stroke={PEEL_INNER}
          strokeWidth="2.4"
          strokeLinecap="round"
          opacity="0.7"
        />
      </g>
      {/* centre strip */}
      <g>
        <path
          d="M -4 -5 C -8 3, -8 16, -1 27 C 3 32, 8 31, 7 25 C 5 14, 3 3, 4 -5 Z"
          fill={`url(#${g('peel')})`}
          stroke={PEEL_EDGE}
          strokeWidth="0.8"
          strokeLinejoin="round"
        />
        <path
          d="M 0 5 C 0 13, 1 21, 3 27"
          fill="none"
          stroke={PEEL_INNER}
          strokeWidth="2.4"
          strokeLinecap="round"
          opacity="0.7"
        />
      </g>
      {/* right strip */}
      <g transform="rotate(40)">
        <path
          d="M -4 -4 C 2 4, 2 16, -1 26 C -3 31, -10 30, -14 24 C -20 10, -14 -2, -4 -4 Z"
          fill={`url(#${g('peel')})`}
          stroke={PEEL_EDGE}
          strokeWidth="0.8"
          strokeLinejoin="round"
        />
        <path
          d="M -7 4 C -11 12, -12 20, -9 25"
          fill="none"
          stroke={PEEL_INNER}
          strokeWidth="2.4"
          strokeLinecap="round"
          opacity="0.7"
        />
      </g>
    </g>
  );
}

function Projectile({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Banana uid={uid} k="p" />
    </svg>
  );
}

function Payload({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      {/* 133 (+0): the banana, whole, still visible inside the flash. Gone at
          200 (+67), replaced by the peel. */}
      <g transform="translate(6 -38)">
        <g className="thr-banana_peel__banana">
          <Banana uid={uid} k="a" />
        </g>
      </g>
      {/* 133-200 (+0..+67): the impact flash, small to peak to gone. */}
      <g transform="translate(0 -38)">
        <g className="thr-banana_peel__flash">
          <Flash uid={uid} />
        </g>
      </g>
      {/* 200 (+67): the peel, draped like a hat. Static to the cut. */}
      <g transform="translate(0 -28)">
        <g className="thr-banana_peel__peel">
          <Peel uid={uid} />
        </g>
      </g>
    </svg>
  );
}

export const bananaPeelRig: ThrowableRig = { Projectile, Payload };
