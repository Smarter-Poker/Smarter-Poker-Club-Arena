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

const BOMB_BLACK = '#1c1c20';
const BOMB_BLACK_LIGHT = '#55555e';
const BOMB_BLACK_DEEP = '#000000';
const FUSE_BROWN = '#3a2a1a';
const SPARK_YELLOW = '#ffe066';
const SPARK_YELLOW_CORE = '#fff6c8';
const CRACK_GLOW = '#ffd94a';
const BURST_ORANGE = '#ff9a2e';
const BURST_YELLOW = '#ffd23f';
const BURST_CORE = '#fff4c2';
const SMOKE_KHAKI = '#c9bb8e';
const SMOKE_KHAKI_LIGHT = '#e2d6ae';

/** The four-point spark, drawn at a base size (12 units tip-to-tip) around
 *  (0,0) so the flicker keyframe can scale it between the measured 3 and
 *  7 px (7.5-17.5 units) without redrawing it. */
const SPARK_PATH =
  'M 0 -6 L 1.27 -1.27 L 6 0 L 1.27 1.27 L 0 6 L -1.27 1.27 L -6 0 L -1.27 -1.27 Z';

/**
 * The bomb SPHERE alone: 40 units across (0.4 u, the measured 16 px), drawn
 * around (0,0). Used for the flying/held projectile AND the landed payload -
 * `k` keeps the two copies' gradients apart since a multi-table view can
 * mount several throws at once. The fuse and the spark are drawn separately
 * by each caller: the projectile draws them at rest (nothing to animate
 * mid-flight), the payload gives each its own class (the fuse shortens, the
 * spark flickers) - baking either into this shared component would mount the
 * payload's flicker/shorten animation under the flying projectile too, on a
 * clock that means nothing there.
 */
function BombSphere({ uid, k }: { uid: string; k: string }) {
  const g = (n: string) => `thr-bomb-${n}-${uid}-${k}`;
  return (
    <g>
      <defs>
        <radialGradient id={g('sphere')} cx="0.32" cy="0.28" r="0.85">
          <stop offset="0%" stopColor={BOMB_BLACK_LIGHT} />
          <stop offset="23%" stopColor="#767982" />
          <stop offset="37%" stopColor="#303239" />
          <stop offset="58%" stopColor={BOMB_BLACK} />
          <stop offset="84%" stopColor="#07080c" />
          <stop offset="100%" stopColor={BOMB_BLACK_DEEP} />
        </radialGradient>
      </defs>
      <ellipse cx="2" cy="19" rx="17" ry="3" fill="#06090c" opacity="0.28" />
      <circle
        cx="0"
        cy="0"
        r="20"
        fill={`url(#${g('sphere')})`}
        stroke="#141720"
        strokeWidth="0.7"
      />
      <path
        d="M -18 4 C -21 -8 -13 -19 -3 -19 M 9 17 Q 18 12 19 2"
        fill="none"
        stroke="#9ba9bb"
        strokeWidth="0.75"
        opacity="0.58"
      />
      <path d="M -17 7 C -8 13 6 14 17 7" fill="none" stroke="#05060a" strokeWidth="1.2" />
      <path
        d="M -17 6 C -7 11 6 12 17 6"
        fill="none"
        stroke="#646972"
        strokeWidth="0.5"
        opacity="0.65"
      />
      <path
        d="M 0 -19 L 3 -24 L 10 -21 L 9 -16 Z"
        fill="#72717a"
        stroke="#16181e"
        strokeWidth="0.8"
      />
      <path d="M 3 -23 L 9 -20 M 2 -21 L 8 -18" stroke="#b5adb0" strokeWidth="0.65" />
      {/* a crisp highlight, top-left */}
      <ellipse
        cx="-7"
        cy="-8"
        rx="6.5"
        ry="4.5"
        transform="rotate(-30 -7 -8)"
        fill="#ffffff"
        opacity="0.28"
      />
      <ellipse cx="-9" cy="-11" rx="2.2" ry="1.6" fill="#ffffff" opacity="0.4" />
      {/* a soft rim shadow, lower-right */}
      <path
        d="M 6 16 A 20 20 0 0 0 18 4"
        fill="none"
        stroke={BOMB_BLACK_DEEP}
        strokeWidth="3"
        strokeLinecap="round"
        opacity="0.35"
      />
    </g>
  );
}

/** The fuse, drawn from the sphere's rim (5,-19) up-right to its tip
 *  (21,-34). One shape, reused at rest by the projectile and, scaled down
 *  toward its own base, by the payload's shortening animation. */
const FUSE_PATH = 'M 5 -19 Q 13 -29 21 -34';

function Projectile({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <BombSphere uid={uid} k="p" />
      <path d={FUSE_PATH} fill="none" stroke={FUSE_BROWN} strokeWidth="3" strokeLinecap="round" />
      <g transform="translate(21 -34)">
        <path d={SPARK_PATH} fill={SPARK_YELLOW} stroke={SPARK_YELLOW_CORE} strokeWidth="0.6" />
      </g>
    </svg>
  );
}

/**
 * The burst: an eight-point spiky flower, 110 units across (1.1 u, exactly
 * the payload's own size), centred on (0,0). Hand-authored, fixed.
 */
const BURST_PATH =
  'M 0 -55 L 9.95 -24.06 Q 26 -30 38.9 -38.9 ' +
  'L 24.06 -9.95 Q 44 -4 55 0 ' +
  'L 24.06 9.95 Q 44 4 38.9 38.9 ' +
  'L 9.95 24.06 Q 26 30 0 55 ' +
  'L -9.95 24.06 Q -26 30 -38.9 38.9 ' +
  'L -24.06 9.95 Q -44 4 -55 0 ' +
  'L -24.06 -9.95 Q -44 -4 -38.9 -38.9 ' +
  'L -9.95 -24.06 Q -26 -30 0 -55 Z';

function Payload({ uid }: RigProps) {
  const g = (n: string) => `thr-bomb-${n}-${uid}`;
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={g('burst')} cx="0.5" cy="0.5" r="0.55">
          <stop offset="0%" stopColor={BURST_CORE} />
          <stop offset="45%" stopColor={BURST_YELLOW} />
          <stop offset="100%" stopColor={BURST_ORANGE} />
        </radialGradient>
        <radialGradient id={g('smoke')} cx="0.5" cy="0.5" r="0.6">
          <stop offset="0%" stopColor={SMOKE_KHAKI_LIGHT} />
          <stop offset="52%" stopColor={SMOKE_KHAKI} />
          <stop offset="100%" stopColor="#84765d" />
        </radialGradient>
      </defs>

      {/* 267-1467 (+0..+1200): the bomb, static on the forehead. The fuse and
          the spark are drawn as their own siblings below so each can carry
          its own animation (shortening, flickering) independently of the
          sphere's brief landing settle. */}
      <g className="thr-bomb__body">
        <BombSphere uid={uid} k="a" />
        {/* 1433 (+1166): yellow cracks/glow inside the sphere - nested so it
            inherits the sphere's own position and disappears with it. */}
        <g className="thr-bomb__crackglow">
          <ellipse cx="0" cy="-2" rx="14" ry="12" fill={CRACK_GLOW} opacity="0.35" />
          <path
            d="M -9 -8 L -3 2 L -7 4 L 2 12"
            fill="none"
            stroke={CRACK_GLOW}
            strokeWidth="1.6"
            strokeLinecap="round"
            opacity="0.85"
          />
          <path
            d="M 8 -10 L 3 -1 L 9 3 L 1 10"
            fill="none"
            stroke={CRACK_GLOW}
            strokeWidth="1.4"
            strokeLinecap="round"
            opacity="0.75"
          />
        </g>
      </g>

      {/* 267-1467 (+0..+1200): the fuse, shortening toward the sphere's rim
          (its own transform-origin) across the whole fuse phase. */}
      <g className="thr-bomb__fuse">
        <path d={FUSE_PATH} fill="none" stroke={FUSE_BROWN} strokeWidth="3" strokeLinecap="round" />
      </g>

      {/* 267-1467 (+0..+1200): the spark, fixed at the fuse's rest tip,
          flickering size and shape every stop until the explosion. */}
      <g transform="translate(21 -34)">
        <g className="thr-bomb__spark">
          <path d={SPARK_PATH} fill={SPARK_YELLOW} stroke={SPARK_YELLOW_CORE} strokeWidth="0.6" />
        </g>
      </g>

      {/* 1467 (+1200): the jagged burst, popping to full size by 1500
          (+1233), fading out as the smoke takes over. */}
      <g className="thr-bomb__burst">
        <path d={BURST_PATH} fill={`url(#${g('burst')})`} stroke={BURST_ORANGE} strokeWidth="1.2" />
        <path
          d="M -31 9 C -43 -2 -32 -18 -20 -16 C -25 -34 -5 -41 5 -25 C 15 -38 34 -29 28 -14 C 48 -12 41 10 28 13 C 34 32 9 38 2 24 C -13 36 -33 26 -27 14 Z"
          fill={`url(#${g('burst')})`}
          stroke="#ffb138"
          strokeWidth="1.8"
        />
        <path
          d="M -20 -5 C -23 -17 -8 -26 0 -16 C 12 -27 26 -12 19 -3 C 31 6 18 22 8 15 C -5 28 -20 15 -15 6 C -26 8 -29 -2 -20 -5 Z"
          fill="#fff0a5"
          opacity="0.9"
        />
        <path
          d="M -12 -10 C -6 -17 2 -11 1 -5 C 12 -12 17 0 9 6 C 5 15 -9 12 -8 5 C -19 5 -20 -4 -12 -10 Z"
          fill="#fff9db"
        />
      </g>

      {/* 1600 (+1333): the smoke puff, drifting up-left and fading to clean
          by 1833 (+1566). */}
      <g className="thr-bomb__smoke">
        <ellipse cx="0" cy="0" rx="48" ry="46" fill={`url(#${g('smoke')})`} />
        <circle cx="-28" cy="-20" r="20" fill={`url(#${g('smoke')})`} />
        <circle cx="26" cy="-22" r="18" fill={`url(#${g('smoke')})`} />
        <circle cx="30" cy="18" r="19" fill={`url(#${g('smoke')})`} />
        <circle cx="-26" cy="20" r="18" fill={`url(#${g('smoke')})`} />
        <circle cx="0" cy="32" r="16" fill={`url(#${g('smoke')})`} />
        <circle cx="0" cy="-34" r="16" fill={`url(#${g('smoke')})`} />
        <path
          d="M -42 -14 C -44 -30 -25 -39 -15 -24 M 10 -37 C 23 -45 40 -31 36 -18 M 31 9 C 49 12 43 34 27 34 M -28 29 C -13 40 1 28 -3 17"
          fill="none"
          stroke="#f0dfb8"
          strokeWidth="2.3"
          opacity="0.48"
          strokeLinecap="round"
        />
        <path
          d="M -21 -14 C -4 -29 17 -17 11 -5 C 31 -5 34 18 18 25 C 8 31 -3 25 -5 15"
          fill="none"
          stroke="#7c6e57"
          strokeWidth="3"
          opacity="0.28"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}

export const bombRig: ThrowableRig = { Projectile, Payload };
