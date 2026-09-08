import { AtlasSprite } from '../AtlasSprite';
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

/**
 * The peeled banana, drawn around (0,0): a 54-unit crescent (the measured
 * 22 px on a 40 px avatar), tilted up-right by a STATIC transform so the
 * flight and the landed copy share one shape. `k` keeps the projectile's and
 * the payload's gradients apart - two of these mount at once.
 */
function Banana(_: { uid: string; k: string }) {
  return (
    <AtlasSprite
      src="banana_peel"
      rect={[10, 65, 640, 585]}
      x={-40}
      y={-38}
      width={80}
      height={76}
    />
  );
}

/**
 * The star-burst flash: a hand-drawn 6-point star (white core, yellow rays)
 * with two small sparkle dots, drawn at its PEAK size (28 px = 70 units
 * across). The keyframe scales it down for the open frame and back up for
 * the peak; the points below are fixed, never computed at runtime.
 */
function Flash(_: { uid: string }) {
  return (
    <AtlasSprite
      src="banana_peel"
      rect={[735, 660, 495, 510]}
      x={-44}
      y={-44}
      width={88}
      height={88}
    />
  );
}

/**
 * The residue: an open peel draped like a hat, three splayed strips fanning
 * down from a bunched crown, covering roughly 40% of the face. Yellow
 * outside, the pale inner skin showing where each strip has folded back.
 */
function Peel(_: { uid: string }) {
  return (
    <AtlasSprite
      src="banana_peel"
      rect={[654, 75, 590, 515]}
      x={-50}
      y={-40}
      width={100}
      height={87}
    />
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
