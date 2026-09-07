/**
 * ===============================================================================
 *  HORSESHOE - a landing tick, a bob, a glowing bloom, "GOOD LUCK", four
 *  clovers (phase 2, 2026-09-06)
 * ===============================================================================
 *
 * Measured off PB THROWABLE 1.MOV, THROW 5 (launch f975, 30 fps, target avatar
 * ~30 px wide, so 1 px = 3.333 units), see
 * docs/throwables/pokerbros-reference-video-1.md and the build sheet in
 * docs/throwables/THROWABLES-PREMIUM-ANIMATION-PLAN.md ("horseshoe", line
 * ~598). ms from LAUNCH:
 *
 *   0-200      spawn: horseshoe fades/scales in at the thrower's upper-left
 *   200        LANDING: the shaded gold horseshoe sits on the seat, over the
 *              top of the "All In" badge and the exposed cards. No spin, no
 *              scale change in flight.
 *   400-1000   FLOAT/BOB: one soft bob, rises 12 px then sinks back to rest -
 *              a translateY excursion, not a scale overshoot, so this rig
 *              uses arrival 'none' and does the whole arrival itself.
 *   1167-1433  GLOW BLOOM: shading is lost - the horseshoe turns a flat
 *              saturated yellow silhouette and blooms to ~1.4x, with a soft
 *              aura behind it.
 *   1467-1667  "GOOD LUCK" grows out of the glow (tiny -> near-full -> full)
 *              with a big radial ray burst behind it; the horseshoe itself is
 *              gone by ~1533. Rays fade by 1667; the label pops on settle.
 *   1867-2100  four green four-leaf clovers grow from the label's corners -
 *              upper-left and upper-right first, all four by ~2100.
 *   3767+      still holding (reference cuts off here; life continues to the
 *              build sheet's ~4500 by analogy with the other ~4.5 s throws).
 *   4500       CUT, one frame.
 *
 * Everything in the Payload is `animation-delay` from LANDING (200), so the
 * catalogue's "at" minus 200: bob 200, glow 967, label 1267, clovers 1667,
 * cut 4300. The comments keep both numbers.
 *
 * Sound (plan "horseshoe" line, contract table): `tick_land` at 350 (a short
 * bright tick on landing, mid-flight in the raw capture but scheduled here on
 * the visual beat per the contract's "schedule every cue on the visual beat"
 * rule), `horseshoe_clank` at 800 (a metallic ring, exactly at the bottom of
 * the bob). THE CONTRACT IS BINDING: no `voice_good_luck` cue exists and none
 * is named here - `voice_good_luck` was never licensed and the placeholder
 * ratchet is at zero, so the CAPTION carries "Good Luck" until Dan supplies a
 * recording (contract, "Sound timing note" section; plan 3.3.1, phase 6).
 *
 * CAPTION: the one sanctioned on-felt word in the whole set (ruling 7). Drawn
 * as an SVG <text> inside the Payload, Title Case ("Good" / "Luck" on two
 * lines, matching the reference's two-line layout), never a DOM text node.
 */

import type React from 'react';
import type { ThrowableSpec } from '../spec';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import { preloadThrowableCues } from '../cues';
import './horseshoe.css';

export const horseshoeSpec: ThrowableSpec = {
  id: 'horseshoe',
  name: 'Horseshoe',
  tier: 'free',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 200,
  flight: { ms: 200, mode: 'straight', upright: true },
  arrival: 'none',
  payload: { sizeU: 1.4, anchor: 'face', coversAvatar: false, ms: 4300 },
  beats: [
    { at: 200, marker: 'land' },
    { at: 400, marker: 'bob' },
    { at: 1167, marker: 'glow' },
    { at: 1467, marker: 'label' },
    { at: 1867, marker: 'clovers' },
    { at: 4500, marker: 'cut' },
  ],
  audio: [
    { at: 350, sample: 'tick_land' },
    { at: 800, sample: 'horseshoe_clank' },
  ],
  caption: { text: 'Good Luck', at: 1467 },
  reference: { video: 1, launchFrame: 975, throw: 'THROW 5' },
};

preloadThrowableCues(horseshoeSpec.audio.map((c) => c.sample));

/** The measured golds, greens and label colours. */
const GOLD_LIGHT = '#f6d97a';
const GOLD_MID = '#d89b2e';
const GOLD_DARK = '#8a5c12';
const NAIL_DARK = '#4a2f0c';
const GLOW_YELLOW = '#ffd93d';
const CLOVER_GREEN = '#3ea63b';
const CLOVER_EDGE = '#276323';
const LABEL_FILL = '#ff5722';
const LABEL_STROKE = '#ffcf3d';

/** The horseshoe silhouette, drawn around (0,0), opening at the top - a "U"
 *  with flat nail-holed heels: outer edge 66 units wide, 55 tall (the
 *  measured 20x19 px on a 30 px avatar, 0.65 u). Shared by the shaded and the
 *  flat glow renders so both are exactly the same shape. */
const HORSESHOE_PATH =
  'M -33 -33 C -33 -8, -20 14, 0 22 C 20 14, 33 -8, 33 -33 ' +
  'L 19 -33 C 19 -12, 10 4, 0 9 C -10 4, -19 -12, -19 -33 Z';

/** Six nail holes along the heels, fixed positions. */
const NAIL_HOLES: ReadonlyArray<readonly [number, number]> = [
  [-30, -28],
  [-27, -12],
  [-21, 3],
  [30, -28],
  [27, -12],
  [21, 3],
];

/** Eight ray-burst spikes, fixed angles (deg), alternating long/short. */
const RAYS: ReadonlyArray<readonly [number, number]> = [
  [0, 46],
  [45, 30],
  [90, 46],
  [135, 30],
  [180, 46],
  [225, 30],
  [270, 46],
  [315, 30],
];

/** Four clovers: [dx, dy, delayStepMs] around the label's corners. Fixed,
 *  never random - upper two arrive first, matching the reference. */
const CLOVERS: ReadonlyArray<readonly [number, number, number]> = [
  [-62, -50, 0],
  [62, -50, 0],
  [-58, 36, 100],
  [58, 36, 100],
];

/** The shaded, 3D gold horseshoe: gradient body, nail holes, a highlight.
 *  `k` keeps the projectile's and the payload's gradients apart. */
function Horseshoe({ uid, k }: { uid: string; k: string }) {
  const g = (n: string) => `thr-horseshoe-${n}-${uid}-${k}`;
  return (
    <g>
      <defs>
        <linearGradient id={g('gold')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={GOLD_LIGHT} />
          <stop offset="55%" stopColor={GOLD_MID} />
          <stop offset="100%" stopColor={GOLD_DARK} />
        </linearGradient>
      </defs>
      <path
        d={HORSESHOE_PATH}
        fill={`url(#${g('gold')})`}
        stroke={GOLD_DARK}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      {NAIL_HOLES.map(([x, y], i) => (
        <ellipse key={i} cx={x} cy={y} rx="2.2" ry="3" fill={NAIL_DARK} opacity="0.75" />
      ))}
      <path
        d="M -27 -30 C -25 -22, -24 -14, -25 -4"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity="0.4"
      />
    </g>
  );
}

/** The flat, glowing bloom version: shading is lost, so this is a single flat
 *  fill on the same path, with a soft radial aura behind it. */
function GlowHorseshoe({ uid }: { uid: string }) {
  const g = (n: string) => `thr-horseshoe-${n}-${uid}-glow`;
  return (
    <g>
      <defs>
        <radialGradient id={g('aura')} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#fff6cf" stopOpacity="0.9" />
          <stop offset="55%" stopColor={GLOW_YELLOW} stopOpacity="0.45" />
          <stop offset="100%" stopColor={GLOW_YELLOW} stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="0" cy="-5" r="46" fill={`url(#${g('aura')})`} />
      <path d={HORSESHOE_PATH} fill={GLOW_YELLOW} />
    </g>
  );
}

/** A four-leaf clover, drawn around (0,0): four rounded lobes and a stem. */
function Clover() {
  return (
    <g>
      <path d="M 0 -1 C 0 -9, -8 -9, -8 -1 C -8 3, -4 4, 0 -1 Z" fill={CLOVER_GREEN} />
      <path d="M 0 -1 C 0 -9, 8 -9, 8 -1 C 8 3, 4 4, 0 -1 Z" fill={CLOVER_GREEN} />
      <path d="M 0 1 C -8 1, -8 9, 0 9 C 4 9, 4 5, 0 1 Z" fill={CLOVER_GREEN} />
      <path d="M 0 1 C 8 1, 8 9, 0 9 C -4 9, -4 5, 0 1 Z" fill={CLOVER_GREEN} />
      <path
        d="M 0 0 C -0.3 3, -0.3 8, 0.4 12"
        fill="none"
        stroke={CLOVER_EDGE}
        strokeWidth="1"
        strokeLinecap="round"
      />
      <circle cx="0" cy="0.5" r="1.6" fill={CLOVER_EDGE} />
    </g>
  );
}

function Projectile({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Horseshoe uid={uid} k="p" />
    </svg>
  );
}

function Payload({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      {/* 200 (+0): the shaded horseshoe lands, and 400-1000 (+200..+800) it
          bobs once - 12 px up and back - before settling. */}
      <g className="thr-horseshoe__bob" transform="translate(0 -10)">
        <g className="thr-horseshoe__shaded">
          <Horseshoe uid={uid} k="a" />
        </g>
        {/* 1167 (+967): the glow bloom crossfades in over the settled shaded
            horseshoe and blooms to 1.4x, then fades as the label takes over. */}
        <g className="thr-horseshoe__glow">
          <GlowHorseshoe uid={uid} />
        </g>
      </g>

      {/* 1467 (+1267): the ray burst, behind the label, fading by 1667 (+1467). */}
      <g className="thr-horseshoe__rays" transform="translate(0 -8)">
        {RAYS.map(([angle, len], i) => (
          <path
            key={i}
            d={`M -2.5 -6 L 2.5 -6 L 0 ${-6 - len} Z`}
            fill={GLOW_YELLOW}
            opacity="0.85"
            transform={`rotate(${angle})`}
          />
        ))}
      </g>

      {/* 1467 (+1267): "GOOD LUCK" grows out of the glow, pops on settle at
          ~1767 (+1567), and holds to the cut. Title Case, drawn - never a DOM
          text node over the felt (contract, caption). */}
      <g className="thr-horseshoe__label" transform="translate(0 -8)">
        <text
          textAnchor="middle"
          fontFamily="Arial, Helvetica, sans-serif"
          fontWeight="700"
          fontStyle="italic"
          fontSize="30"
          fill={LABEL_FILL}
          stroke={LABEL_STROKE}
          strokeWidth="1.6"
          strokeLinejoin="round"
        >
          <tspan x="0" y="-6">
            Good
          </tspan>
          <tspan x="0" y="24">
            Luck
          </tspan>
        </text>
      </g>

      {/* 1867 (+1667): four clovers grow from the label's corners - the two
          upper ones first, then the two lower ones ~100 ms later. */}
      {CLOVERS.map(([dx, dy, step], i) => (
        <g
          key={i}
          className="thr-horseshoe__clover"
          transform={`translate(${dx} ${dy})`}
          style={
            {
              animationDelay: `calc((1.667s + ${(step / 1000).toFixed(2)}s) * var(--animation-speed, 1))`,
            } as React.CSSProperties
          }
        >
          <Clover />
        </g>
      ))}
    </svg>
  );
}

export const horseshoeRig: ThrowableRig = { Projectile, Payload };
