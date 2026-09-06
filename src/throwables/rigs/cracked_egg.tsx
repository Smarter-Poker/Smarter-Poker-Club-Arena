/**
 * ===============================================================================
 *  CRACKED EGG - an egg, one clean crack, a yolk cap and whites down the face
 *  (phase 1, 2026-09-06)
 * ===============================================================================
 *
 * Measured off PB THROWABLE 2.MOV, THROW 1 (launch f130, 30 fps, target avatar
 * 40 px wide, so 1 px = 2.5 units), see
 * docs/throwables/pokerbros-reference-video-2.md. ms from LAUNCH:
 *
 *   -300..-170  egg pops in at the thrower's upper-left (scale 0 -> 1, a
 *               slight fade-in) over 130 ms
 *   -170..0     HOLD at full size, no motion. The egg is 12x15 px =
 *               0.3 x 0.375 u, brown/beige shell, tilted ~30 deg with its
 *               long axis up-right. The tilt never changes.
 *   0-367       straight flight, 11 frames at ~20.5 px/frame. No spin, no
 *               scale change, no trail. The player moves the box; the egg is
 *               drawn at rest.
 *   367         LANDING: the egg is INTACT at the top of the head, centre
 *               x 0, y -0.35 u. It stays intact for exactly one frame.
 *   400         CRACK, in ONE frame: the egg is replaced by a yolk blob on
 *               top of the head (~26 x 14 px = 0.65 x 0.35 u at y -0.42 u),
 *               two or three cracked shell halves in and around it, and
 *               translucent white egg-white drips running DOWN over the face
 *               to about the chin (bottom at y +0.4 u). No burst, no flash,
 *               no particles, no shake, no tint of the avatar.
 *   433-3500    RESIDUE, STATIC: identical every frame, the avatar fully
 *               visible through the whites. No fade.
 *   3500        CUT, one frame (the reference's residue life was 1.9-4.6 s;
 *               3500 total from launch is used).
 *
 * Everything in the Payload is `animation-delay` from LANDING (367), so the
 * catalogue's "at" minus 367: the crack is at +33, the drips have run their
 * length by about +250, the cut is at +3133. The comments keep both numbers.
 *
 * Sound (plan 4A): `egg_crack` at 400 (a placeholder cue that falls back to
 * the legacy recipe until the library supplies a file) and `drip_tick` at 700
 * at gain 0.6 (a real file).
 */

import type { ThrowableSpec } from '../spec';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import { preloadThrowableCues } from '../cues';
import './cracked_egg.css';

export const crackedEggSpec: ThrowableSpec = {
  id: 'cracked_egg',
  name: 'Egg',
  tier: 'free',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 300,
  flight: { ms: 367, mode: 'straight', upright: true },
  arrival: 'none',
  payload: { sizeU: 1.0, anchor: 'face', coversAvatar: false, ms: 3133 },
  beats: [
    { at: 367, marker: 'land' },
    { at: 400, marker: 'crack' },
    { at: 433, marker: 'drips' },
    { at: 3500, marker: 'cut' },
  ],
  audio: [
    { at: 400, sample: 'egg_crack' },
    { at: 700, sample: 'drip_tick', gain: 0.6 },
  ],
  reference: { video: 2, launchFrame: 130, throw: 'THROW 1' },
};

preloadThrowableCues(crackedEggSpec.audio.map((c) => c.sample));

/** Every def id is built from the instance uid (rig.ts: IDS). */
const defId = (uid: string, name: string) => `thr-cracked_egg-${name}-${uid}`;

/**
 * The intact egg, drawn around (0,0): 30 units wide and 37.5 tall (0.3 x
 * 0.375 u, the measured 12x15 px on a 40 px avatar), long axis vertical with
 * the narrow end up, then tilted 30 deg clockwise by a STATIC transform so
 * the long axis points up-right. The tilt is baked in here; nothing rotates
 * at runtime. A warm radial shell with a highlight top-left and a few
 * speckles. `k` keeps the projectile's and the payload's gradients apart.
 */
function Egg({ uid, k }: { uid: string; k: string }) {
  const shell = defId(uid, `shell-${k}`);
  return (
    <g className="thr-cracked_egg__egg-shape" transform="rotate(30)">
      <defs>
        <radialGradient id={shell} cx="0.36" cy="0.3" r="0.78">
          <stop offset="0%" stopColor="#f7e5cc" />
          <stop offset="45%" stopColor="#dcb07e" />
          <stop offset="80%" stopColor="#b57a48" />
          <stop offset="100%" stopColor="#8d5830" />
        </radialGradient>
      </defs>
      {/* the shell: narrow at the top, round at the bottom */}
      <path
        d="M 0 -18.75 C 8.5 -18.75, 15 -9, 15 2 C 15 11.5, 8.5 18.75, 0 18.75 C -8.5 18.75, -15 11.5, -15 2 C -15 -9, -8.5 -18.75, 0 -18.75 Z"
        fill={`url(#${shell})`}
        stroke="#7c4d27"
        strokeWidth="1"
        strokeOpacity="0.4"
      />
      {/* speckles */}
      <ellipse cx="5" cy="4" rx="1.6" ry="1.1" fill="#7a4a24" opacity="0.4" />
      <ellipse cx="-4" cy="10" rx="1.2" ry="0.9" fill="#7a4a24" opacity="0.35" />
      <ellipse cx="8" cy="-4" rx="1" ry="0.8" fill="#7a4a24" opacity="0.3" />
      {/* highlight, top-left */}
      <ellipse
        cx="-5"
        cy="-8"
        rx="4.5"
        ry="6.5"
        transform="rotate(-25 -5 -8)"
        fill="#ffffff"
        opacity="0.5"
      />
      <ellipse cx="-7" cy="-1" rx="1.6" ry="2.4" fill="#ffffff" opacity="0.3" />
    </g>
  );
}

function Projectile({ uid }: RigProps) {
  return (
    <svg
      viewBox={RIG_VIEWBOX}
      aria-hidden="true"
      focusable="false"
      className="thr-cracked_egg thr-cracked_egg--proj"
    >
      <Egg uid={uid} k="p" />
    </svg>
  );
}

/**
 * A cracked shell piece, in its own local units, placed by a static
 * transform. A rounded outer arc with a jagged broken edge, the shell
 * gradient, and a pale inner lining along the arc.
 */
function ShellCap({ fill, transform }: { fill: string; transform: string }) {
  return (
    <g transform={transform}>
      <path
        d="M -12 3 C -13 -7, -7 -14, 0 -14 C 7 -14, 13 -7, 12 3 L 9 0 L 7 5 L 3.5 1 L 0 6 L -3.5 1 L -7 5 L -9 0 Z"
        fill={fill}
        stroke="#7c4d27"
        strokeWidth="0.8"
        strokeOpacity="0.5"
        strokeLinejoin="round"
      />
      <path
        d="M -10 1 C -10.5 -6, -5.5 -11.5, 0 -11.5 C 5.5 -11.5, 10.5 -6, 10 1"
        fill="none"
        stroke="#fff1dd"
        strokeWidth="1.2"
        strokeOpacity="0.6"
        strokeLinecap="round"
      />
    </g>
  );
}

function Payload({ uid }: RigProps) {
  const yolk = defId(uid, 'yolk');
  const shell = defId(uid, 'shell-frag');
  return (
    <svg
      viewBox={RIG_VIEWBOX}
      aria-hidden="true"
      focusable="false"
      className="thr-cracked_egg thr-cracked_egg--payload"
    >
      <defs>
        <radialGradient id={yolk} cx="0.38" cy="0.32" r="0.72">
          <stop offset="0%" stopColor="#ffe066" />
          <stop offset="40%" stopColor="#ffb92b" />
          <stop offset="78%" stopColor="#f0961a" />
          <stop offset="100%" stopColor="#d47a0e" />
        </radialGradient>
        <radialGradient id={shell} cx="0.4" cy="0.3" r="0.8">
          <stop offset="0%" stopColor="#f3dfc4" />
          <stop offset="55%" stopColor="#d3a672" />
          <stop offset="100%" stopColor="#96603a" />
        </radialGradient>
      </defs>

      {/* 367 (+0): the INTACT egg at the top of the head, y -0.35 u. Shown
          for one frame, then hidden in one frame at +33. */}
      <g transform="translate(0 -35)">
        <g className="thr-cracked_egg__egg">
          <Egg uid={uid} k="a" />
        </g>
      </g>

      {/* 400 (+33): the CRACK. Everything below appears in the same frame. */}
      <g className="thr-cracked_egg__splat">
        {/* THE WHITES: a translucent pool round the yolk and three drips that
            grow down the face from +33 to about +250, each to its own length.
            One group opacity so the pool and the drips never double up where
            they overlap; the avatar reads through all of it. */}
        <g className="thr-cracked_egg__whites" opacity="0.65">
          <path
            d="M -40 -34 C -41 -42, -30 -46, -20 -44 C -8 -46, 10 -46, 24 -44 C 34 -43, 42 -38, 40 -30 C 38 -22, 28 -19, 16 -19 C 4 -18, -10 -18, -22 -20 C -32 -21, -39 -26, -40 -34 Z"
            fill="#ffffff"
          />
          {/* drip A: left, to y +30 */}
          <path
            className="thr-cracked_egg__drip thr-cracked_egg__drip--a"
            d="M -23 -24 L -9 -24 C -10 -10, -11 4, -12 18 C -12.5 25, -13 30, -16 30 C -19 30, -19.5 25, -20 18 C -21 4, -22 -10, -23 -24 Z"
            fill="#ffffff"
          />
          {/* drip B: centre-right, the long one, to y +40 (the chin) */}
          <path
            className="thr-cracked_egg__drip thr-cracked_egg__drip--b"
            d="M -2 -24 L 14 -24 C 13 -8, 11 10, 10 26 C 9.5 34, 9 40, 5 40 C 1 40, 0.5 34, 1 26 C 0.5 10, -1 -8, -2 -24 Z"
            fill="#ffffff"
          />
          {/* drip C: right, the short one, to y +10 */}
          <path
            className="thr-cracked_egg__drip thr-cracked_egg__drip--c"
            d="M 19 -24 L 29 -24 C 28.5 -15, 27.5 -5, 27 3 C 26.8 8, 25.5 10, 24 10 C 22.5 10, 21.2 8, 21 3 C 20.5 -5, 19.5 -15, 19 -24 Z"
            fill="#ffffff"
          />
        </g>
        {/* the gloss: a faint bright line down the left of each drip and on
            the pool. Each drip's line starts at the drip's top so it grows on
            the same origin with the same keyframe. */}
        <g fill="none" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" strokeOpacity="0.5">
          <path
            className="thr-cracked_egg__drip thr-cracked_egg__drip--a"
            d="M -21 -24 C -21.5 -8, -20.5 6, -19 16"
          />
          <path
            className="thr-cracked_egg__drip thr-cracked_egg__drip--b"
            d="M 0 -24 C -0.5 -6, 1 10, 2.5 24"
          />
          <path
            className="thr-cracked_egg__drip thr-cracked_egg__drip--c"
            d="M 21 -24 C 20.8 -14, 21.4 -6, 22 0"
          />
        </g>
        <ellipse cx="-30" cy="-36" rx="5" ry="2.2" fill="#ffffff" opacity="0.35" />

        {/* THE YOLK: an irregular cap ~65 x 35 units centred at y -42,
            sitting on top of the head, a darker rim and a specular dot. It
            appears at full size and settles 1.06 -> 1 over 100 ms. */}
        <g className="thr-cracked_egg__yolk">
          <path
            d="M -32 -40 C -33 -50, -22 -58, -10 -59 C -2 -60, 6 -57, 14 -58 C 24 -59, 33 -52, 32 -42 C 31 -32, 22 -26, 10 -25 C 0 -24, -10 -25, -20 -27 C -28 -29, -31 -33, -32 -40 Z"
            fill={`url(#${yolk})`}
            stroke="#c26a08"
            strokeWidth="2"
            strokeOpacity="0.85"
            strokeLinejoin="round"
          />
          {/* a little shade along the lower edge so the cap has a belly */}
          <path
            d="M -26 -31 C -16 -26, 4 -25, 22 -29 C 14 -25, -8 -24, -26 -31 Z"
            fill="#c96e0c"
            opacity="0.35"
          />
          <ellipse
            cx="-11"
            cy="-51"
            rx="6.5"
            ry="3.6"
            transform="rotate(-12 -11 -51)"
            fill="#ffffff"
            opacity="0.75"
          />
          <circle cx="-1" cy="-54" r="1.6" fill="#ffffff" opacity="0.6" />
        </g>

        {/* THE SHELL: one cap tipped over the yolk's right edge, one shard
            beside the yolk on the head, one small shard sitting in the yolk.
            All static from the crack frame. */}
        <ShellCap fill={`url(#${shell})`} transform="translate(21 -54) rotate(32)" />
        <g transform="translate(-37 -30) rotate(-18)">
          <path
            d="M -8 3 L -6 -3 L -2 -6 L 3 -4 L 8 -5 L 7 1 L 3 5 L -1 3 L -5 6 Z"
            fill={`url(#${shell})`}
            stroke="#7c4d27"
            strokeWidth="0.8"
            strokeOpacity="0.5"
            strokeLinejoin="round"
          />
          <path
            d="M -5 -2 L -1 -4 L 4 -3"
            fill="none"
            stroke="#fff1dd"
            strokeWidth="1"
            strokeOpacity="0.55"
            strokeLinecap="round"
          />
        </g>
        <g transform="translate(-9 -57) rotate(14)">
          <path
            d="M -6 2 L -4 -3 L 0 -5 L 4 -3 L 6 1 L 2 4 L -2 3 Z"
            fill={`url(#${shell})`}
            stroke="#7c4d27"
            strokeWidth="0.8"
            strokeOpacity="0.5"
            strokeLinejoin="round"
          />
        </g>
      </g>
    </svg>
  );
}

export const crackedEggRig: ThrowableRig = { Projectile, Payload };
