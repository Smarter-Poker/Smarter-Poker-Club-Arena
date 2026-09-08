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
import { AtlasSprite } from '../AtlasSprite';

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

const LABEL_FILL = '#ff5722';
const LABEL_STROKE = '#ffcf3d';

/** Four clovers: [dx, dy, delayStepMs] around the label's corners. Fixed,
 *  never random - upper two arrive first, matching the reference. */
const CLOVERS: ReadonlyArray<readonly [number, number, number]> = [
  [-62, -50, 0],
  [62, -50, 0],
  [-58, 36, 100],
  [58, 36, 100],
];

/** Individually bounded premium parts keep CSS transform pivots local. */
function Horseshoe() {
  return (
    <AtlasSprite src="horseshoe" rect={[70, 55, 555, 560]} x={-35} y={-36} width={70} height={70} />
  );
}
function GlowHorseshoe() {
  return (
    <g>
      <AtlasSprite
        src="horseshoe"
        rect={[665, 40, 540, 570]}
        x={-47}
        y={-49}
        width={94}
        height={94}
      />
      <Horseshoe />
    </g>
  );
}
function Clover() {
  return (
    <AtlasSprite
      src="horseshoe"
      rect={[95, 655, 520, 525]}
      x={-15}
      y={-15}
      width={30}
      height={30}
    />
  );
}

function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Horseshoe />
    </svg>
  );
}

function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      {/* 200 (+0): the shaded horseshoe lands, and 400-1000 (+200..+800) it
          bobs once - 12 px up and back - before settling. */}
      <g transform="translate(0 -10)">
        <g className="thr-horseshoe__bob">
          <g className="thr-horseshoe__shaded">
            <Horseshoe />
          </g>
          {/* 1167 (+967): the glow bloom crossfades in over the settled shaded
              horseshoe and blooms to 1.4x, then fades as the label takes over. */}
          <g className="thr-horseshoe__glow">
            <GlowHorseshoe />
          </g>
        </g>
      </g>

      {/* 1467 (+1267): the ray burst, behind the label, fading by 1667 (+1467). */}
      <g transform="translate(0 -8)">
        <g className="thr-horseshoe__rays">
          <AtlasSprite
            src="horseshoe"
            rect={[665, 40, 540, 570]}
            x={-60}
            y={-60}
            width={120}
            height={120}
          />
        </g>
      </g>

      {/* 1467 (+1267): "GOOD LUCK" grows out of the glow, pops on settle at
          ~1767 (+1567), and holds to the cut. Title Case, drawn - never a DOM
          text node over the felt (contract, caption). */}
      <g transform="translate(0 -8)">
        <g className="thr-horseshoe__label">
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
      </g>

      {/* 1867 (+1667): four clovers grow from the label's corners - the two
          upper ones first, then the two lower ones ~100 ms later. */}
      {CLOVERS.map(([dx, dy, step], i) => (
        // The corner offset lives on a PLAIN WRAPPER. `thr-horseshoe__clover`
        // animates `transform: scale()`, and a CSS transform REPLACES an SVG
        // transform attribute on the same element - so with both here, all
        // four clovers collapsed onto the origin and stacked.
        <g key={i} transform={`translate(${dx} ${dy})`}>
          <g
            className="thr-horseshoe__clover"
            style={
              {
                animationDelay: `calc((1.667s + ${(step / 1000).toFixed(2)}s) * var(--animation-speed, 1))`,
              } as React.CSSProperties
            }
          >
            <Clover />
          </g>
        </g>
      ))}
    </svg>
  );
}

export const horseshoeRig: ThrowableRig = { Projectile, Payload };
