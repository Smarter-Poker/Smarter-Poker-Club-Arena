/**
 * ===============================================================================
 *  TOMATO - a squash, a burst, a splat that stays (phase 1, 2026-09-06)
 * ===============================================================================
 *
 * Measured off PB THROWABLE 2.MOV, THROW 8 (launch f1498, 30 fps, target
 * avatar 40 px wide, so 1 px = 2.5 units), see
 * docs/throwables/pokerbros-reference-video-2.md. ms from LAUNCH:
 *
 *   -133..0   the tomato pops in at the thrower's upper-left: a bright red
 *             ball 0.4 u across with a small green stem and two leaves
 *   33-233    straight flight at 24 px/frame; no spin, no scale change
 *   233       LANDS on the target's face
 *   267       SQUASH: one frame, the tomato drawn flat (1.5 x 0.5) and
 *             semi-transparent at x -0.08 u, y -0.27 u
 *   300       BURST: a red splat 0.75 u over the upper half of the face
 *             (centre y -0.2 u); 8 chunks thrown outward from it
 *   333-433   the splat expands to 0.85 u; the chunks travel 0.15-0.25 u
 *             outward and STOP where they land (no fade)
 *   467-733   SETTLE: the splat's jagged rim, the stem and leaves at its
 *             centre-top, three drips running down to the chin (y +0.5 u)
 *   767-3500  RESIDUE, static: ~70% of the avatar covered (eyes and cap
 *             hidden, mouth and chin visible). No fade, no motion
 *   3500      CUT, one frame
 *
 * Everything in the Payload is `animation-delay` from LANDING (233), so the
 * catalogue's "at" minus 233: squash 34, burst 67, expand 100-200, settle
 * 234-500, residue 534-3267. The comments keep both numbers.
 *
 * Sound (plan 4A): ONE wet splat 33 ms after the burst, `splat_wet` at 333.
 * It is a placeholder cue that falls back to the legacy recipe until phase 6
 * supplies a licensed take.
 */

import React from 'react';
import type { ThrowableSpec } from '../spec';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import { preloadThrowableCues } from '../cues';
import './tomato.css';

export const tomatoSpec: ThrowableSpec = {
  id: 'tomato',
  name: 'Tomato',
  tier: 'free',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 133,
  flight: { ms: 233, mode: 'straight', upright: true },
  arrival: 'none',
  payload: { sizeU: 1.0, anchor: 'face', coversAvatar: true, ms: 3267 },
  beats: [
    { at: 233, marker: 'land' },
    { at: 267, marker: 'squash' },
    { at: 300, marker: 'burst' },
    { at: 333, marker: 'expand' },
    { at: 467, marker: 'settle' },
    { at: 767, marker: 'residue' },
    { at: 3500, marker: 'cut' },
  ],
  audio: [{ at: 333, sample: 'splat_wet' }],
  reference: { video: 2, launchFrame: 1498, throw: 'THROW 8' },
};

preloadThrowableCues(tomatoSpec.audio.map((c) => c.sample));

/** The measured reds: the intact fruit and the settled splat. */
const TOMATO_RED = '#c61110';
const SPLAT_RED = '#c22124';
const LEAF_GREEN = '#5aa53b';
const LEAF_EDGE = '#3c7a24';
const STEM_GREEN = '#4a8a2c';

/**
 * The calyx: a short stem stub pointing up-left and two sepal leaves, drawn
 * with its base at (0,0). The projectile wears it at the top of the fruit;
 * the payload lays it flat on the splat's centre-top.
 */
function Calyx() {
  return (
    <g className="thr-tomato__calyx">
      {/* left leaf, pointing left and a little down */}
      <path
        d="M -1 0 C -6 -5, -15 -4, -19 2 C -13 4, -5 3, -1 0 Z"
        fill={LEAF_GREEN}
        stroke={LEAF_EDGE}
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
      {/* right leaf, pointing up-right */}
      <path
        d="M 1 0 C 6 -6, 14 -7, 18 -3 C 13 1, 6 2, 1 0 Z"
        fill={LEAF_GREEN}
        stroke={LEAF_EDGE}
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
      {/* the stem stub, up-left */}
      <path
        d="M -1.8 1.2 L -6.6 -8.4 Q -6 -10.2 -4 -9.8 L 1.6 0.2 Z"
        fill={STEM_GREEN}
        stroke={LEAF_EDGE}
        strokeWidth="0.7"
        strokeLinejoin="round"
      />
      <circle cx="0" cy="0.4" r="1.6" fill={LEAF_EDGE} />
    </g>
  );
}

/**
 * The intact tomato, drawn around (0,0), 40 units across (0.4 u, the
 * measured 16 px on a 40 px avatar). A slightly wide ball with a radial
 * gradient: a soft top-left highlight, the measured red across the body, a
 * darker shade to the lower-right; two faint lobe creases; the calyx at the
 * top, stem up-left.
 */
function Tomato({ uid, k }: { uid: string; k: string }) {
  const g = (n: string) => `thr-tomato-${n}-${uid}-${k}`;
  return (
    <g className="thr-tomato__fruit">
      <defs>
        <radialGradient id={g('body')} cx="0.36" cy="0.32" r="0.8" fx="0.3" fy="0.27">
          <stop offset="0%" stopColor="#ff8a7a" />
          <stop offset="22%" stopColor="#ea3b31" />
          <stop offset="55%" stopColor={TOMATO_RED} />
          <stop offset="100%" stopColor="#7d0b0c" />
        </radialGradient>
      </defs>
      <ellipse cx="0" cy="0.5" rx="20" ry="18.5" fill={`url(#${g('body')})`} />
      {/* two shallow lobe creases */}
      <path
        d="M -6 -16 q -3 9 -1 17"
        fill="none"
        stroke="#000000"
        strokeWidth="1.2"
        opacity="0.1"
        strokeLinecap="round"
      />
      <path
        d="M 7 -15 q 3 8 2 15"
        fill="none"
        stroke="#000000"
        strokeWidth="1"
        opacity="0.08"
        strokeLinecap="round"
      />
      {/* the top-left highlight */}
      <ellipse
        cx="-7"
        cy="-8"
        rx="6"
        ry="3.4"
        transform="rotate(-35 -7 -8)"
        fill="#ffffff"
        opacity="0.42"
      />
      <circle cx="-10.5" cy="-11" r="1.4" fill="#ffffff" opacity="0.7" />
      <g transform="translate(-2.5 -17.5)">
        <Calyx />
      </g>
    </g>
  );
}

function Projectile({ uid }: RigProps) {
  return (
    <svg
      viewBox={RIG_VIEWBOX}
      aria-hidden="true"
      focusable="false"
      className="thr-tomato thr-tomato--proj"
    >
      <Tomato uid={uid} k="p" />
    </svg>
  );
}

/**
 * The splat, centred on (0,-20): twelve lobes alternating rounded and spiked,
 * 83 units across and 85 tall (0.85 u, the measured 34 px at 333-433).
 * Hand-authored; the numbers are fixed so every throw is the same splat.
 */
const SPLAT_PATH =
  'M -7 -48.1 ' +
  'C -9.9 -71 6.3 -71.5 6.8 -47.2 ' +
  'L 18.5 -52 Q 19.3 -41.4 21.9 -41.9 ' +
  'C 42.2 -54.2 50.7 -39.5 25.3 -25.8 ' +
  'L 39.9 -17.2 Q 30 -11.4 28.5 -10.7 ' +
  'C 39.1 -3.4 32.1 7.9 20.5 0.5 ' +
  'L 23.8 18.2 Q 12 13 7 6.1 ' +
  'C 5.9 28 -9.2 27.5 -9.9 10.4 ' +
  'L -26.3 19 Q -26.4 5.5 -20.8 -1.3 ' +
  'C -34.9 6.3 -41.3 -5.8 -29.3 -13.8 ' +
  'L -42.9 -23 Q -32.2 -29.2 -24.7 -28 ' +
  'C -42.4 -38 -34.7 -50.2 -20.7 -43 ' +
  'L -20.2 -61.3 Q -8.7 -54.8 -7 -48.1 Z';

/** Eight chunks: [dx, dy, r], the FINAL offset from the splat's centre in
 *  units (radius 46-58, so 0.15-0.25 u past the rim). Each starts at 62% of
 *  its offset, on the rim, and flies the rest between 300 and 433. Fixed,
 *  never random. */
const CHUNKS: ReadonlyArray<readonly [number, number, number]> = [
  [-10, -57, 4.0],
  [31, -44, 3.0],
  [54, -14, 4.5],
  [49, 18, 3.0],
  [25, 43, 3.5],
  [-22, 41, 2.6],
  [-53, 14, 4.0],
  [-43, -30, 3.0],
];

/** Three drips: paths whose TOP sits inside the splat's lower edge and whose
 *  bulb reaches the chin. Each grows by scaleY from its top between 467 and
 *  733: [d, delay s, duration s] from landing. */
const DRIPS: ReadonlyArray<readonly [string, string, string]> = [
  ['M -20 10 L -12 10 L -13.4 46 A 3.4 3.4 0 1 1 -18.6 46 Z', '0.234', '0.266'],
  ['M 1.5 12 L 8.5 12 L 7.2 38 A 3 3 0 1 1 2.8 38 Z', '0.267', '0.233'],
  ['M 18 10 L 24 10 L 23 42 A 2.6 2.6 0 1 1 19 42 Z', '0.3', '0.2'],
];

function Payload({ uid }: RigProps) {
  const g = (n: string) => `thr-tomato-${n}-${uid}`;
  return (
    <svg
      viewBox={RIG_VIEWBOX}
      aria-hidden="true"
      focusable="false"
      className="thr-tomato thr-tomato--payload"
    >
      <defs>
        <radialGradient id={g('splat')} cx="0.5" cy="0.5" r="0.55">
          <stop offset="0%" stopColor="#e8524b" />
          <stop offset="45%" stopColor="#d13530" />
          <stop offset="100%" stopColor={SPLAT_RED} />
        </radialGradient>
      </defs>
      {/* THE SQUASH: the intact fruit at contact (233), drawn flat and
          semi-transparent for one frame (267), gone at the burst (300). */}
      <g className="thr-tomato__squash">
        <Tomato uid={uid} k="s" />
      </g>
      {/* THE SPLAT: pops at 300 (0.6 -> 1.13 -> 1.0), static from 433. */}
      <g className="thr-tomato__splat">
        <path
          d={SPLAT_PATH}
          fill={`url(#${g('splat')})`}
          stroke="#a5161a"
          strokeWidth="1.2"
          strokeLinejoin="round"
          opacity="0.98"
        />
        {/* pulp: darker pools and a few pale seeds, static */}
        <circle cx="-9" cy="-31" r="5.5" fill="#8c1014" opacity="0.2" />
        <circle cx="13" cy="-9" r="4.5" fill="#8c1014" opacity="0.18" />
        <circle cx="4" cy="-38" r="3" fill="#8c1014" opacity="0.14" />
        <ellipse
          cx="-14"
          cy="-14"
          rx="2.2"
          ry="1.3"
          transform="rotate(-30 -14 -14)"
          fill="#f2d98a"
          opacity="0.8"
        />
        <ellipse
          cx="9"
          cy="-24"
          rx="2.1"
          ry="1.2"
          transform="rotate(25 9 -24)"
          fill="#f2d98a"
          opacity="0.8"
        />
        <ellipse
          cx="18"
          cy="-31"
          rx="1.8"
          ry="1.1"
          transform="rotate(-60 18 -31)"
          fill="#f2d98a"
          opacity="0.75"
        />
        <ellipse
          cx="-4"
          cy="3"
          rx="2"
          ry="1.2"
          transform="rotate(10 -4 3)"
          fill="#f2d98a"
          opacity="0.75"
        />
        <ellipse
          cx="-24"
          cy="-32"
          rx="1.6"
          ry="1"
          transform="rotate(40 -24 -32)"
          fill="#f2d98a"
          opacity="0.7"
        />
        {/* a wet glint at the core */}
        <ellipse
          cx="-8"
          cy="-30"
          rx="7"
          ry="3.5"
          transform="rotate(-25 -8 -30)"
          fill="#ffffff"
          opacity="0.14"
        />
      </g>
      {/* THE DRIPS: grow down from the splat's lower edge to the chin, 467-733. */}
      {DRIPS.map(([d, delay, dur], i) => (
        <path
          key={i}
          className="thr-tomato__drip"
          d={d}
          fill={SPLAT_RED}
          stroke="#a5161a"
          strokeWidth="0.8"
          strokeLinejoin="round"
          style={
            {
              animationDelay: `calc(${delay}s * var(--animation-speed, 1))`,
              animationDuration: `calc(${dur}s * var(--animation-speed, 1))`,
            } as React.CSSProperties
          }
        />
      ))}
      {/* THE STEM AND LEAVES: lie flat on the splat's centre-top from the burst. */}
      <g className="thr-tomato__stem">
        <g transform="translate(1 -47) rotate(-8) scale(1.35)">
          <Calyx />
        </g>
      </g>
      {/* THE CHUNKS: fly out from the rim 300-433 and freeze where they land. */}
      {CHUNKS.map(([dx, dy, r], i) => (
        <circle
          key={i}
          className="thr-tomato__chunk"
          cx="0"
          cy="-20"
          r={r}
          fill={SPLAT_RED}
          stroke="#a5161a"
          strokeWidth="0.6"
          style={
            {
              '--dx': `${dx}px`,
              '--dy': `${dy}px`,
              animationDelay: `calc((0.067s + ${((i % 3) * 0.01).toFixed(2)}s) * var(--animation-speed, 1))`,
            } as React.CSSProperties
          }
        />
      ))}
    </svg>
  );
}

export const tomatoRig: ThrowableRig = { Projectile, Payload };
