/**
 * ===============================================================================
 *  POOP - a swirl that lands, a wet splat with radial spikes, droplets that
 *  fly and freeze (phase 2, 2026-09-07)
 * ===============================================================================
 *
 * Measured off PB THROWABLE 2.MOV, Throw 7 (launch f1322, 30 fps, target avatar
 * 40 px wide, so 1 px = 2.5 units), see
 * docs/throwables/pokerbros-reference-video-2.md lines 439-476 and the build
 * sheet at docs/throwables/THROWABLES-PREMIUM-ANIMATION-PLAN.md line 703.
 *
 * VIDEO 2's `L` IS THE LAUNCH FRAME - no offset needed, exactly like cake and
 * tomato. ms from LAUNCH:
 *
 *   -200..-133 the swirl pops in on the thrower's head, scale-in
 *   -100..-33  HOLD: brown swirl ~16x18 px (40% of avatar), dark brown
 *              (118,70,50)
 *   0-300      straight flight, ~20 px/frame, no spin, no scale
 *   333        LANDING: at the bottom of the avatar, still intact
 *   367        CONTACT: centred on the face, still intact
 *   400        SPLAT: the swirl is replaced by a brown-orange (129,91,54)
 *              splat ~34 px across (85% of avatar) with radial splash spikes,
 *              PLUS one droplet (~5 px) shooting straight up ~30 px above the
 *              head
 *   433-567    the splash grows: 3-4 more droplets fly out up/up-right, the
 *              spikes lengthen
 *   600-867    droplets decelerate and hang; the spikes settle; a few small
 *              dark drops sit at the upper right
 *   900-2933   RESIDUE STATIC: the swirl (~22 px) on the face inside the
 *              brown splash ring, avatar ~70% covered, small drops frozen
 *   3500       CUT (the build sheet's number; the capture itself is hidden by
 *              a dialog at 2967, so the reference cannot show the true end)
 *
 * Everything in the Payload is `animation-delay` from LANDING (333), so the
 * catalogue's "at" minus 333: contact 34, splat 67, splash 100, settle 267,
 * residue 567, cut 3167. The comments keep both numbers.
 *
 * THE RESIDUE IS NOT A FIFTH SPRITE. The reference's "poop swirl sitting on
 * the face with the brown splash ring around it" (f1348-1409) describes the
 * SAME splat that pops in at 400: a small swirl glyph sits at the splash
 * ring's centre from the moment the splat appears, exactly as cake's residue
 * is the plate it already drew rather than a new element born at its own
 * beat. 900 (`residue`) marks the moment the scene is fully static, the same
 * way tomato's 767 does - no new geometry there.
 *
 * Sound (build sheet + the doc's own audio note): ONE wet splat, `splat_wet`,
 * at 433 - measured 1 frame after the visual splat (400). The contract's
 * "schedule on the visual beat" guidance targets the reference's 170-370 ms
 * outliers, not a single frame of read latency; tomato's own splat_wet keeps
 * the same +33 ms reading rather than snapping to its burst frame, so poop
 * does too.
 */

import React from 'react';
import type { ThrowableSpec } from '../spec';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import { preloadThrowableCues } from '../cues';
import './poop.css';

export const poopSpec: ThrowableSpec = {
  id: 'poop',
  name: 'Poop',
  tier: 'vip',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 200,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'none',
  payload: { sizeU: 0.85, anchor: 'face', coversAvatar: true, ms: 3167 },
  beats: [
    { at: 333, marker: 'land' },
    { at: 367, marker: 'contact' },
    { at: 400, marker: 'splat' },
    { at: 433, marker: 'splash' },
    { at: 600, marker: 'settle' },
    { at: 900, marker: 'residue' },
    { at: 3500, marker: 'cut' },
  ],
  audio: [{ at: 433, sample: 'splat_wet' }],
  reference: { video: 2, launchFrame: 1322, throw: 'Throw 7' },
};

preloadThrowableCues(poopSpec.audio.map((c) => c.sample));

/** The measured browns: the intact swirl and the settled splash. */
const SWIRL_BROWN = '#764632';
const SWIRL_BROWN_LIGHT = '#9c6a4e';
const SWIRL_BROWN_DARK = '#4a2a1c';
const SPLASH_BROWN = '#815b36';
const SPLASH_BROWN_LIGHT = '#a67a4a';
const SPLASH_BROWN_DARK = '#5c3d20';
const DROPLET_BROWN = '#6b4426';

/**
 * The classic three-tier swirl: a wide base lobe, a mid lobe, a narrower top
 * lobe and a small curled tip, each overlapping the one below with a slight
 * alternating offset - the soft-serve coil the reference calls "brown
 * swirl". Drawn around (0,0), about 38 units wide and 52 tall (the measured
 * 16x18 px scaled by 2.5, with a little extra height for the curled tip).
 * Used for the flying/landed projectile AND, scaled up slightly, as the
 * residue glyph inside the splash ring - `k` keeps the two copies' gradients
 * apart since a multi-table view can mount several throws at once.
 */
function Swirl({ uid, k }: { uid: string; k: string }) {
  const g = (n: string) => `thr-poop-${n}-${uid}-${k}`;
  return (
    <g>
      <defs>
        <linearGradient id={g('body')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={SWIRL_BROWN_LIGHT} />
          <stop offset="55%" stopColor={SWIRL_BROWN} />
          <stop offset="100%" stopColor={SWIRL_BROWN_DARK} />
        </linearGradient>
      </defs>
      <ellipse cx="1" cy="22" rx="18" ry="4.5" fill="#27190f" opacity="0.38" />
      {/* bottom lobe, widest - sits on the face */}
      <path
        d="M -16 9 C -20 12 -19 21 -11 24 C -2 28 14 25 18 19 C 22 11 13 7 5 7 C -3 5 -11 5 -16 9 Z"
        fill={`url(#${g('body')})`}
      />
      {/* mid lobe, offset right */}
      <path
        d="M -10 -5 C -15 -1 -12 7 -5 9 C 4 12 16 6 15 -1 C 15 -7 8 -10 2 -9 C -4 -10 -8 -8 -10 -5 Z"
        fill={`url(#${g('body')})`}
      />
      {/* top lobe, offset left, tapering */}
      <path
        d="M -7 -18 C -12 -12 -8 -6 -2 -6 C 5 -5 10 -10 7 -16 C 5 -21 -3 -22 -7 -18 Z"
        fill={`url(#${g('body')})`}
      />
      <path
        d="M -14 11 C -7 6 6 13 13 7 M -8 -1 Q -2 3 8 -1 M -5 -15 Q 0 -12 4 -15"
        fill="none"
        stroke="#c0936e"
        strokeWidth="1.1"
        strokeLinecap="round"
        opacity="0.75"
      />
      {/* the curled tip */}
      <path
        d="M -1 -20 C 2 -24.5, 7.5 -23, 6 -18.7 C 5 -16, 1 -16.8, -1 -20 Z"
        fill={`url(#${g('body')})`}
      />
      {/* creases marking the coil between the lobes */}
      <path
        d="M -14 6 Q 0 10 14 6"
        fill="none"
        stroke={SWIRL_BROWN_DARK}
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity="0.28"
      />
      <path
        d="M -10 -7 Q 0 -4 9 -7"
        fill="none"
        stroke={SWIRL_BROWN_DARK}
        strokeWidth="1.2"
        strokeLinecap="round"
        opacity="0.24"
      />
      {/* soft highlights */}
      <ellipse
        cx="-6"
        cy="-3"
        rx="4.6"
        ry="6.8"
        transform="rotate(-20 -6 -3)"
        fill="#ffffff"
        opacity="0.32"
      />
      <ellipse cx="-7" cy="11" rx="5.5" ry="3" fill="#ffffff" opacity="0.22" />
    </g>
  );
}

function Projectile({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Swirl uid={uid} k="p" />
    </svg>
  );
}

/**
 * The splash ring: an eight-point spiky burst centred on (0,0), 84 units
 * across (0.84 u, close to the measured 34 px = 0.85 u). Hand-authored,
 * fixed, never random.
 */
const SPLASH_PATH =
  'M 0 -42 L 9.2 -22.2 Q 20 -26 29.7 -29.7 ' +
  'L 22.2 -9.2 Q 36 -4 42 0 ' +
  'L 22.2 9.2 Q 36 4 29.7 29.7 ' +
  'L 9.2 22.2 Q 20 26 0 42 ' +
  'L -9.2 22.2 Q -20 26 -29.7 29.7 ' +
  'L -22.2 9.2 Q -36 4 -42 0 ' +
  'L -22.2 -9.2 Q -36 -4 -29.7 -29.7 ' +
  'L -9.2 -22.2 Q -20 -26 0 -42 Z';

/** Four droplets: [dx, dy, r, delaySeconds, durationSeconds] - the FINAL
 *  offset from the splash's centre, in units, plus each one's own timing so
 *  every droplet freezes at the same 867 ms (534 ms from landing) the
 *  reference settles on, whichever moment it started at. The first is the
 *  "one droplet shooting straight up" born WITH the splat (400); the other
 *  three are the "3-4 droplets" that follow at 433. Fixed, never random. */
const DROPLETS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [4, -75, 5.5, 0.067, 0.467],
  [30, -60, 6, 0.1, 0.434],
  [48, -30, 5, 0.11, 0.424],
  [18, -68, 4.5, 0.12, 0.414],
];

function Payload({ uid }: RigProps) {
  const g = (n: string) => `thr-poop-${n}-${uid}`;
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={g('splash')} cx="0.4" cy="0.35" r="0.7">
          <stop offset="0%" stopColor={SPLASH_BROWN_LIGHT} />
          <stop offset="55%" stopColor={SPLASH_BROWN} />
          <stop offset="100%" stopColor={SPLASH_BROWN_DARK} />
        </radialGradient>
      </defs>

      {/* 333-400 (+0..+67): the swirl, intact, arrives at the bottom of the
          avatar and settles centred on the face before the splat replaces
          it. */}
      <g className="thr-poop__swirl">
        <Swirl uid={uid} k="a" />
      </g>

      {/* 400 (+67): the splash ring, with the residue swirl already sitting
          at its centre - the two appear and pop together, one splat event. */}
      <g className="thr-poop__splat">
        <path
          d={SPLASH_PATH}
          fill={`url(#${g('splash')})`}
          stroke={SPLASH_BROWN_DARK}
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        {/* pooled shading and a couple of pale flecks, static */}
        <path
          d="M -25 -7 Q -21 -17 -12 -18 M 12 -20 Q 22 -16 25 -10 M -28 12 Q -22 17 -18 15 M 17 22 Q 25 19 27 15"
          fill="none"
          stroke="#cba06a"
          strokeWidth="1.2"
          strokeLinecap="round"
          opacity="0.65"
        />
        <circle cx="-8" cy="-8" r="6" fill={SPLASH_BROWN_DARK} opacity="0.18" />
        <circle cx="12" cy="10" r="5" fill={SPLASH_BROWN_DARK} opacity="0.16" />
        <ellipse
          cx="-16"
          cy="6"
          rx="2.2"
          ry="1.3"
          transform="rotate(-20 -16 6)"
          fill="#f2d9ae"
          opacity="0.55"
        />
        <ellipse
          cx="14"
          cy="-14"
          rx="2"
          ry="1.2"
          transform="rotate(25 14 -14)"
          fill="#f2d9ae"
          opacity="0.5"
        />
        {/* the residue glyph: the same swirl, a hair larger, sitting on the
            face at the ring's centre. */}
        <g transform="translate(0 -3) scale(1.05)">
          <Swirl uid={uid} k="res" />
        </g>
      </g>

      {/* 400 / 433 (+67 / +100): the droplets, each frozen by 867 (+534). */}
      {DROPLETS.map(([dx, dy, r, delayS, durS], i) => (
        <circle
          key={i}
          className="thr-poop__droplet"
          cx="0"
          cy="-16"
          r={r}
          fill={DROPLET_BROWN}
          stroke={SPLASH_BROWN_DARK}
          strokeWidth="0.6"
          style={
            {
              '--dx': `${dx}px`,
              '--dy': `${dy}px`,
              animationDelay: `calc(${delayS}s * var(--animation-speed, 1))`,
              animationDuration: `calc(${durS}s * var(--animation-speed, 1))`,
            } as React.CSSProperties
          }
        />
      ))}
    </svg>
  );
}

export const poopRig: ThrowableRig = { Projectile, Payload };
