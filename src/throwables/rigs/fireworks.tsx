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
import { AtlasSprite } from '../AtlasSprite';

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
const BLUE = ['#eafcff', '#4fd8ff', '#1a7fd4'] as const;
const MAGENTA = ['#ffe9fb', '#ff5fd0', '#b3229b'] as const;
const YELLOW = ['#fffdf0', '#ffd83d', '#ff9a12'] as const;
const WHITE_HOT = ['#ffffff', '#fff4b0', '#ffc23a'] as const;
const EMBER = ['#ffb765', '#c1590f', '#5a2405'] as const;

/** Isolated luminous bursts retain each wave's independent timing and scale. */
function Burst({ r, colors }: { r: number; colors: readonly string[] }) {
  const rect =
    colors === BLUE
      ? ([808, 153, 441, 455] as const)
      : colors === MAGENTA
        ? ([0, 675, 431, 465] as const)
        : colors === EMBER
          ? ([848, 710, 391, 416] as const)
          : ([428, 675, 426, 466] as const);
  return <AtlasSprite src="fireworks" rect={rect} x={-r} y={-r} width={r * 2} height={r * 2} />;
}
function Trail() {
  return (
    <AtlasSprite src="fireworks" rect={[515, 23, 234, 629]} x={-7} y={-14} width={14} height={39} />
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

function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      {/* ── WAVE 1 ─────────────────────────────────────────────────────────
          Three rockets one after another: trail, then a round burst. */}
      <g transform="translate(53 0)">
        <g className="thr-fireworks__t1">
          <Trail />
        </g>
      </g>
      <g transform="translate(60 -10)">
        <g className="thr-fireworks__b1">
          <Burst r={42} colors={BLUE} />
        </g>
      </g>

      <g transform="translate(-83 0)">
        <g className="thr-fireworks__t2">
          <Trail />
        </g>
      </g>
      <g transform="translate(-77 -63)">
        <g className="thr-fireworks__b2">
          <Burst r={58} colors={MAGENTA} />
        </g>
      </g>

      <g transform="translate(60 -20)">
        <g className="thr-fireworks__t3">
          <Trail />
        </g>
      </g>
      {/* burst 3 shifts colour as it dies: the hot yellow cloud fades out
          under an ember cloud that fades in, which is the catalogue's
          "yellow -> orange -> brown-orange embers" without animating a fill. */}
      <g transform="translate(23 -123)">
        <g className="thr-fireworks__b3">
          <Burst r={50} colors={YELLOW} />
        </g>
        <g className="thr-fireworks__b3e">
          <Burst r={54} colors={EMBER} />
        </g>
      </g>

      {/* ── WAVE 2: three rise together and burst together ─────────────────
          One class on all three trails and one on all three bursts, so they
          are in step by construction, as the reference has them. */}
      <g transform="translate(-50 -10)">
        <g className="thr-fireworks__t4">
          <Trail />
        </g>
      </g>
      <g transform="translate(7 -10)">
        <g className="thr-fireworks__t4">
          <Trail />
        </g>
      </g>
      <g transform="translate(60 -10)">
        <g className="thr-fireworks__t4">
          <Trail />
        </g>
      </g>

      <g transform="translate(-77 -40)">
        <g className="thr-fireworks__w2">
          <Burst r={53} colors={BLUE} />
        </g>
        <g className="thr-fireworks__w2e">
          <Burst r={57} colors={EMBER} />
        </g>
      </g>
      <g transform="translate(-7 -100)">
        <g className="thr-fireworks__w2">
          <Burst r={53} colors={WHITE_HOT} />
        </g>
        <g className="thr-fireworks__w2e">
          <Burst r={57} colors={EMBER} />
        </g>
      </g>
      <g transform="translate(70 -40)">
        <g className="thr-fireworks__w2">
          <Burst r={53} colors={MAGENTA} />
        </g>
        <g className="thr-fireworks__w2e">
          <Burst r={57} colors={EMBER} />
        </g>
      </g>
    </svg>
  );
}

export const fireworksRig: ThrowableRig = { Projectile, Payload };

/** Kept so the module's React import is used by the JSX runtime check in
 *  older toolchains and so a future inline style has the type to hand. */
export type FireworksStyle = React.CSSProperties;
