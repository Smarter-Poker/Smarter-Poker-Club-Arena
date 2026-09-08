/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BEER — two mugs, a clink, a rest (phase 1, 2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Measured off PB THROWABLE 1.MOV, THROW 2 (launch f349, 30 fps), see
 * docs/throwables/pokerbros-reference-video-1.md. ms from LAUNCH:
 *
 *   -167..0   mug scales in at the thrower's upper-left, upright
 *   0-333     straight upright flight, no spin
 *   333       lands right of the target's centre with a 1.1x overshoot
 *   533-1200  MUG 1 slides right along the avatar's edge (x +0.23 u -> +1.1 u)
 *   900-967   MUG 2 pops in on the LEFT (-0.57 u), both tilted ~10 deg inward
 *   1000-1367 hold apart, a small bob
 *   1400-1567 both swing INWARD and UP to meet over the forehead in a V
 *   1567      CLINK: a white foam plume 0.8 u above the rims, 8-12 droplets;
 *             peak 1633-1733, gone by 2033
 *   2100-2367 V hold, rims touching
 *   2367-3033 ease apart and settle lower
 *   3033-4500 rest pose flanking the face; the avatar is visible between them
 *   4533      CUT, one frame
 *
 * Everything in the Payload is `animation-delay` from LANDING (333), so the
 * catalogue's "at" minus 333. The comments keep both numbers.
 *
 * Sound (plan 4A): `pop_soft` at 900 (mug 2), `glass_clink_rattle` at 1567
 * (the reference's chime with six rattles and a 1.3 s ring-down; in the
 * capture it trails the picture by ~370 ms, which is recording lag, so it is
 * scheduled ON the visual clink).
 */

import React from 'react';
import type { ThrowableSpec } from '../spec';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import { preloadThrowableCues } from '../cues';
import './beer.css';
import { AtlasSprite } from '../AtlasSprite';

export const beerSpec: ThrowableSpec = {
  id: 'beer',
  name: 'Beer',
  tier: 'free',
  category: 'cheers',
  spawn: 'avatar-corner',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'land',
  payload: { sizeU: 1.2, anchor: 'face', coversAvatar: false, ms: 4200 },
  beats: [
    { at: 333, marker: 'land' },
    { at: 533, marker: 'mug1-slide' },
    { at: 900, marker: 'mug2-pop' },
    { at: 1400, marker: 'swing' },
    { at: 1567, marker: 'clink' },
    { at: 2367, marker: 'ease-apart' },
    { at: 3033, marker: 'rest' },
    { at: 4533, marker: 'cut' },
  ],
  audio: [
    { at: 900, sample: 'pop_soft', gain: 0.7 },
    { at: 1567, sample: 'glass_clink_rattle' },
  ],
  reference: { video: 1, launchFrame: 349, throw: 'THROW 2' },
};

preloadThrowableCues(beerSpec.audio.map((c) => c.sample));

/** Independently posed mugs from the approved premium animation atlas. */
function Mug({ k }: { uid: string; k: string }) {
  return (
    <AtlasSprite
      src="beer"
      rect={k === 'b' ? [430, 155, 415, 490] : [5, 155, 422, 490]}
      x={-35}
      y={-50}
      width={74}
      height={96}
    />
  );
}

function Projectile({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Mug uid={uid} k="p" />
    </svg>
  );
}

/** Ten foam droplets: [dx, dy, r, delayStep]. Final offsets in units; the
 *  arc's apex is derived in CSS. Fixed, never random. */
const DROPLETS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-34, -66, 3.2, 0],
  [-22, -82, 2.4, 2],
  [-10, -90, 3.6, 1],
  [4, -94, 2.6, 3],
  [16, -86, 3.0, 0],
  [28, -74, 2.2, 2],
  [38, -58, 2.8, 4],
  [-40, -48, 2.0, 3],
  [-4, -72, 2.0, 5],
  [22, -64, 1.8, 4],
];

function Payload({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      {/* MUG 1: the one that flew. Lands right of centre, slides right, swings
          in for the clink, eases back to the right. */}
      <g className="thr-beer__m1">
        <g className="thr-beer__m1-tilt">
          <Mug uid={uid} k="a" />
        </g>
      </g>
      {/* MUG 2: pops in on the left at +900. */}
      <g className="thr-beer__m2">
        <g className="thr-beer__m2-tilt">
          <Mug uid={uid} k="b" />
        </g>
      </g>
      {/* THE CLINK: a plume of foam up from where the rims meet, 0.8 u above
          them, drawn AFTER the mugs so it blows out over them. */}
      <g className="thr-beer__plume">
        <AtlasSprite
          src="beer"
          rect={[850, 220, 404, 435]}
          x={-20}
          y={-88}
          width={52}
          height={48}
        />
        {DROPLETS.map(([dx, dy, r, step], i) => (
          <g
            key={i}
            className="thr-beer__drop"
            style={
              {
                '--dx': `${dx}px`,
                '--dy': `${dy}px`,
                animationDelay: `calc((1.234s + ${(step * 0.02).toFixed(2)}s) * var(--animation-speed, 1))`,
              } as React.CSSProperties
            }
          >
            <AtlasSprite
              src="beer"
              rect={[505, 787, 220, 310]}
              x={4 - r}
              y={-52 - r}
              width={r * 2}
              height={r * 2.7}
            />
          </g>
        ))}
      </g>
    </svg>
  );
}

export const beerRig: ThrowableRig = { Projectile, Payload };
