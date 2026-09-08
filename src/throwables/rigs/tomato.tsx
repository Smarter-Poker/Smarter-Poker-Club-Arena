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
import { AtlasSprite } from '../AtlasSprite';

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

function Tomato() {
  return (
    <AtlasSprite src="tomato" rect={[5, 140, 420, 430]} x={-25} y={-25} width={50} height={50} />
  );
}
function Projectile(_: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Tomato />
    </svg>
  );
}
function Payload(_: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-tomato__squash">
        <Tomato />
      </g>
      <g className="thr-tomato__splat">
        <g className="thr-tomato__burst-pose">
          <AtlasSprite
            src="tomato"
            rect={[830, 155, 424, 435]}
            x={-43}
            y={-63}
            width={86}
            height={86}
          />
        </g>
        <g className="thr-tomato__settled-pose">
          <AtlasSprite
            src="tomato"
            rect={[4, 680, 440, 425]}
            x={-43}
            y={-63}
            width={86}
            height={86}
          />
        </g>
      </g>
      {([-20, 1, 18] as const).map((x, i) => (
        <g
          key={x}
          className="thr-tomato__drip"
          style={
            {
              animationDelay: `calc(${0.234 + i * 0.033}s * var(--animation-speed, 1))`,
              animationDuration: `calc(${0.266 - i * 0.033}s * var(--animation-speed, 1))`,
            } as React.CSSProperties
          }
        >
          <AtlasSprite
            src="tomato"
            rect={[518, 871, 76, 195]}
            fit="none"
            x={x}
            y={9}
            width={10}
            height={40 - i * 3}
          />
        </g>
      ))}
      {CHUNKS.map(([dx, dy, r], i) => (
        <g
          key={i}
          className="thr-tomato__chunk"
          style={
            {
              '--dx': `${dx}px`,
              '--dy': `${dy}px`,
              animationDelay: `calc(${0.067 + (i % 3) * 0.01}s * var(--animation-speed, 1))`,
            } as React.CSSProperties
          }
        >
          <AtlasSprite
            src="tomato"
            rect={[912, 764, 334, 312]}
            x={-r}
            y={-20 - r}
            width={r * 2}
            height={r * 2}
          />
        </g>
      ))}
    </svg>
  );
}
export const tomatoRig: ThrowableRig = { Projectile, Payload };
