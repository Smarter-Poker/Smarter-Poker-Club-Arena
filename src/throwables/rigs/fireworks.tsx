/**
 * ===============================================================================
 *  FIREWORKS - nothing leaves the thrower; two waves burst AT the seat
 *  (phase 2, 2026-09-06)
 * ===============================================================================
 *
 * Measured off PB THROWABLE 1.MOV, THROW 3 (launch f564 = the first spark,
 * 30 fps, target avatar 30 px wide so 1 px = 3.333 units), see
 * docs/throwables/pokerbros-reference-video-1.md. Target avatar centre in that
 * frame is (110, 92); every offset below is (px - centre) * 3.333.
 *
 * THIS IS THE FIRST ITEM WITH `spawn: 'none'` AND `flight.mode: 'none'`.
 * Nothing is drawn at the thrower for the whole throw (the reference proves it
 * with a 3x zoom on the hero seat, `z_t3_hero.jpg`). `throwableLandingMs`
 * returns 0 for a 'none' flight, so LANDING IS 0 and every animation-delay in
 * fireworks.css is the catalogue's ms from launch with nothing subtracted.
 *
 * ms from LAUNCH (= the first spark):
 *
 *   0-200      ROCKET 1 trail: a thin cyan spark rises at the avatar's
 *              lower-right (x +0.53 u) through 1.03 u
 *   233-733    BURST 1 (blue), centre (+0.60, -0.10) u, 0.85 u across; peak
 *              433-533, faded by 733
 *   333-533    ROCKET 2 trail rises on the LEFT (x -0.83 u) through 1.33 u
 *   567-1100   BURST 2 (magenta), centre (-0.77, -0.63) u, 1.2 u across;
 *              peak 767-833, faded by 1100
 *   833-1000   ROCKET 3 trail rises on the RIGHT (x +0.60 u) through 1.17 u
 *   1033-1767  BURST 3, centre (+0.23, -1.23) u, 1.0 u across. Yellow at
 *              1200, orange by 1333, brown-orange embers 1467-1733, gone 1767
 *   1767-2033  GAP: nothing on screen (9 frames)
 *   2067-2300  WAVE 2 trails: THREE sparks rise together at x -0.50 / +0.07 /
 *              +0.60 u through 0.84 u
 *   2333-2600  WAVE 2 bursts open together: blue (-0.77, -0.40),
 *              white-yellow (-0.07, -1.00) with a white-hot core, magenta
 *              (+0.70, -0.40); group 2.4 u, covering the avatar. Peak 2567
 *   2600-2967  darken, desaturate and fade; last embers 2967
 *   3000       CLEAN
 *
 * Each burst is a dense round particle cloud - 40 fixed dots on a soft radial
 * gradient, plus one soft core glow. No ring outline, no streaks or tails, no
 * gravity droop, edges soft, exactly as the catalogue describes. The dots are
 * a literal table (rule 9) so the darkroom photographs the same frame twice.
 *
 * Sound (plan 4A): `fw_whistle` on the first spark (it swells for 830 ms and
 * peaks as burst 1 reaches full size), `fw_crackle` on bursts 2 and 3 (the
 * reference's bang cluster brackets exactly those two), `fw_rumble` over the
 * gap, `fw_barrage` on the wave-2 bursts opening. The capture's bangs run
 * 170-370 ms behind their picture; that is recording lag, so every cue here
 * sits ON the visual beat.
 */

import React from 'react';
import type { ThrowableSpec } from '../spec';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import { preloadThrowableCues } from '../cues';
import './fireworks.css';

export const fireworksSpec: ThrowableSpec = {
  id: 'fireworks',
  name: 'Fireworks',
  tier: 'free',
  category: 'cheers',
  spawn: 'none',
  spawnMs: 0,
  flight: { ms: 0, mode: 'none' },
  arrival: 'none',
  payload: { sizeU: 2.4, anchor: 'face', coversAvatar: false, ms: 3000 },
  beats: [
    { at: 0, marker: 'rocket-1' },
    { at: 233, marker: 'burst-1' },
    { at: 333, marker: 'rocket-2' },
    { at: 567, marker: 'burst-2' },
    { at: 833, marker: 'rocket-3' },
    { at: 1033, marker: 'burst-3' },
    { at: 1767, marker: 'gap' },
    { at: 2067, marker: 'wave-2-trails' },
    { at: 2333, marker: 'wave-2-bursts' },
    { at: 2600, marker: 'wave-2-fade' },
    { at: 3000, marker: 'cut' },
  ],
  audio: [
    { at: 0, sample: 'fw_whistle' },
    { at: 567, sample: 'fw_crackle' },
    { at: 1033, sample: 'fw_crackle', gain: 0.9 },
    { at: 1767, sample: 'fw_rumble', gain: 0.6 },
    { at: 2333, sample: 'fw_barrage' },
  ],
  reference: { video: 1, launchFrame: 564, throw: 'THROW 3' },
};

preloadThrowableCues(fireworksSpec.audio.map((c) => c.sample));

/**
 * ONE particle table, shared by every burst: 40 points on a golden-angle
 * spiral inside the unit disc, denser at the centre, each with its own dot
 * radius multiplier (biggest at the core). [nx, ny, sizeMultiplier]. A burst
 * multiplies nx/ny by its own radius, so one fixed table draws six different
 * clouds and every throw draws the identical frame.
 */
const PARTICLES: ReadonlyArray<readonly [number, number, number]> = [
  [0.066, 0.0, 1.04],
  [-0.096, 0.088, 1.03],
  [0.016, -0.179, 1.02],
  [0.134, 0.175, 1.01],
  [-0.254, -0.045, 0.99],
  [0.247, -0.157, 0.98],
  [-0.084, 0.313, 0.97],
  [-0.163, -0.314, 0.96],
  [0.36, 0.131, 0.94],
  [-0.379, 0.156, 0.93],
  [0.185, -0.395, 0.92],
  [0.138, 0.441, 0.91],
  [-0.421, -0.244, 0.89],
  [0.498, -0.109, 0.88],
  [-0.307, 0.436, 0.87],
  [-0.071, -0.551, 0.86],
  [0.442, 0.372, 0.84],
  [-0.598, 0.025, 0.83],
  [0.439, -0.437, 0.82],
  [-0.03, 0.64, 0.81],
  [-0.423, -0.507, 0.79],
  [0.674, 0.091, 0.78],
  [-0.575, 0.4, 0.77],
  [0.158, -0.702, 0.76],
  [0.367, 0.64, 0.74],
  [-0.721, -0.23, 0.73],
  [0.703, -0.325, 0.72],
  [-0.306, 0.731, 0.71],
  [-0.274, -0.763, 0.69],
  [0.733, 0.385, 0.68],
  [-0.817, 0.215, 0.67],
  [0.466, -0.725, 0.66],
  [0.149, 0.867, 0.64],
  [-0.708, -0.549, 0.63],
  [0.909, -0.075, 0.62],
  [-0.631, 0.682, 0.61],
  [0.005, -0.945, 0.59],
  [0.645, 0.712, 0.58],
  [-0.972, -0.09, 0.57],
  [0.79, -0.6, 0.56],
];

/** The measured colours of the six bursts, plus the ember stage they all die
 *  into ("blue -> teal, magenta -> purple, yellow -> orange-brown"). */
const BLUE = ['#eafcff', '#4fd8ff', '#1a7fd4'] as const;
const MAGENTA = ['#ffe9fb', '#ff5fd0', '#b3229b'] as const;
const YELLOW = ['#fffdf0', '#ffd83d', '#ff9a12'] as const;
const WHITE_HOT = ['#ffffff', '#fff4b0', '#ffc23a'] as const;
const EMBER = ['#ffb765', '#c1590f', '#5a2405'] as const;

/**
 * One burst: a soft core glow and a dense round cloud of dots on a radial
 * gradient that fades to nothing at the dot's edge, which is what gives the
 * soft edge without a filter (rule 6 forbids an animated blur).
 *
 * `r` is the cloud radius in units, `dot` the base dot radius, `n` how many of
 * the 40 particles to draw (the ember stages draw fewer, because the reference
 * ember is dimmer and more diffuse than the flash it follows).
 */
function Burst({
  uid,
  k,
  r,
  dot,
  colors,
  n = PARTICLES.length,
}: {
  uid: string;
  k: string;
  r: number;
  dot: number;
  colors: readonly [string, string, string] | readonly string[];
  n?: number;
}) {
  const g = (name: string) => `thr-fireworks-${name}-${uid}-${k}`;
  const [c0, c1, c2] = colors;
  return (
    <g>
      <defs>
        <radialGradient id={g('dot')}>
          <stop offset="0%" stopColor={c0} />
          <stop offset="42%" stopColor={c1} />
          <stop offset="100%" stopColor={c2} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={g('glow')}>
          <stop offset="0%" stopColor={c0} stopOpacity="0.8" />
          <stop offset="50%" stopColor={c1} stopOpacity="0.3" />
          <stop offset="100%" stopColor={c2} stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="0" cy="0" r={Math.round(r * 0.85)} fill={`url(#${g('glow')})`} />
      {PARTICLES.slice(0, n).map(([nx, ny, rr], i) => (
        <circle
          key={i}
          cx={Number((nx * r).toFixed(1))}
          cy={Number((ny * r).toFixed(1))}
          r={Number((dot * rr).toFixed(1))}
          fill={`url(#${g('dot')})`}
        />
      ))}
    </g>
  );
}

/**
 * A rocket trail: a 20-unit tapered streak with a bright head, drawn at the
 * END of its climb. The CSS lifts it from `--rise` units below to 0, so the
 * spark arrives exactly where its burst opens.
 */
function Trail({ uid, k, colors }: { uid: string; k: string; colors: readonly string[] }) {
  const id = `thr-fireworks-trail-${uid}-${k}`;
  const [c0, c1] = colors;
  return (
    <g>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={c0} />
          <stop offset="55%" stopColor={c1} stopOpacity="0.7" />
          <stop offset="100%" stopColor={c1} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M -2.6 -10 L 2.6 -10 L 1.4 22 L -1.4 22 Z" fill={`url(#${id})`} />
      <circle cx="0" cy="-11" r="3.4" fill={c0} />
    </g>
  );
}

/** Nothing is drawn at the thrower. The player never mounts this (it starts in
 *  the payload phase for a 'none' flight); it exists because a rig is a pair. */
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      {/* deliberately empty: `spawn: 'none'`, verified against z_t3_hero.jpg */}
    </svg>
  );
}

function Payload({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      {/* ── WAVE 1 ─────────────────────────────────────────────────────────
          Three rockets one after another: trail, then a round burst. */}
      <g transform="translate(53 0)">
        <g className="thr-fireworks__t1">
          <Trail uid={uid} k="t1" colors={BLUE} />
        </g>
      </g>
      <g transform="translate(60 -10)">
        <g className="thr-fireworks__b1">
          <Burst uid={uid} k="b1" r={42} dot={5.5} colors={BLUE} />
        </g>
      </g>

      <g transform="translate(-83 0)">
        <g className="thr-fireworks__t2">
          <Trail uid={uid} k="t2" colors={MAGENTA} />
        </g>
      </g>
      <g transform="translate(-77 -63)">
        <g className="thr-fireworks__b2">
          <Burst uid={uid} k="b2" r={58} dot={6.5} colors={MAGENTA} />
        </g>
      </g>

      <g transform="translate(60 -20)">
        <g className="thr-fireworks__t3">
          <Trail uid={uid} k="t3" colors={YELLOW} />
        </g>
      </g>
      {/* burst 3 shifts colour as it dies: the hot yellow cloud fades out
          under an ember cloud that fades in, which is the catalogue's
          "yellow -> orange -> brown-orange embers" without animating a fill. */}
      <g transform="translate(23 -123)">
        <g className="thr-fireworks__b3">
          <Burst uid={uid} k="b3" r={50} dot={6} colors={YELLOW} />
        </g>
        <g className="thr-fireworks__b3e">
          <Burst uid={uid} k="b3e" r={54} dot={7} colors={EMBER} n={18} />
        </g>
      </g>

      {/* ── WAVE 2: three rise together and burst together ─────────────────
          One class on all three trails and one on all three bursts, so they
          are in step by construction, as the reference has them. */}
      <g transform="translate(-50 -10)">
        <g className="thr-fireworks__t4">
          <Trail uid={uid} k="t4" colors={BLUE} />
        </g>
      </g>
      <g transform="translate(7 -10)">
        <g className="thr-fireworks__t4">
          <Trail uid={uid} k="t5" colors={WHITE_HOT} />
        </g>
      </g>
      <g transform="translate(60 -10)">
        <g className="thr-fireworks__t4">
          <Trail uid={uid} k="t6" colors={MAGENTA} />
        </g>
      </g>

      <g transform="translate(-77 -40)">
        <g className="thr-fireworks__w2">
          <Burst uid={uid} k="w2a" r={53} dot={6} colors={BLUE} />
        </g>
        <g className="thr-fireworks__w2e">
          <Burst uid={uid} k="w2ae" r={57} dot={7} colors={EMBER} n={16} />
        </g>
      </g>
      <g transform="translate(-7 -100)">
        <g className="thr-fireworks__w2">
          <Burst uid={uid} k="w2b" r={53} dot={6} colors={WHITE_HOT} />
        </g>
        <g className="thr-fireworks__w2e">
          <Burst uid={uid} k="w2be" r={57} dot={7} colors={EMBER} n={16} />
        </g>
      </g>
      <g transform="translate(70 -40)">
        <g className="thr-fireworks__w2">
          <Burst uid={uid} k="w2c" r={53} dot={6} colors={MAGENTA} />
        </g>
        <g className="thr-fireworks__w2e">
          <Burst uid={uid} k="w2ce" r={57} dot={7} colors={EMBER} n={16} />
        </g>
      </g>
    </svg>
  );
}

export const fireworksRig: ThrowableRig = { Projectile, Payload };

/** Kept so the module's React import is used by the JSX runtime check in
 *  older toolchains and so a future inline style has the type to hand. */
export type FireworksStyle = React.CSSProperties;
