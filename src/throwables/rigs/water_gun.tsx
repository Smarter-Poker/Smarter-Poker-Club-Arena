import { AtlasSprite } from '../AtlasSprite';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WATER GUN - a pistol, a pull-back, a squirt that becomes a face (phase 1,
 *  2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Measured off PB THROWABLE 1.MOV, THROW 1 (launch f174, 30 fps, target avatar
 * 30 px wide so 1 px = 3.33 units), see
 * docs/throwables/pokerbros-reference-video-1.md. ms from LAUNCH:
 *
 *   -100..0    the gun pops in at the thrower's upper-left, 0.45 -> 1.0;
 *              0.73 x 0.67 u, barrel up-right ~35 deg
 *   0-300      straight flight, NO rotation, no scale change (the player moves
 *              the box; the Projectile is the gun at rest)
 *   400-567    blink-pop: dot, blink, 1.1x overshoot; settles at x -0.2 u,
 *              y -0.07 u over the lower-left quadrant of the face, ~1.0 x
 *              0.87 u, barrel aimed at the face
 *   600-733    hold still
 *   767-900    PULL BACK: the gun slides down-left to x -0.77 u, y +1.2 u so
 *              the barrel sits below-left of the face, aimed up-right at it
 *   933        SQUIRT, one frame: a cyan stream from the barrel tip to the
 *              face AND a cyan splat blob 1.87 x 2.0 u centred at y -0.17 u,
 *              two white eyes with black pupils, fully covering the avatar
 *   933-3433   SQUIRT LOOP: the blob pulses (period ~270 ms), droplets fly
 *              radially up to 0.4 u past the blob, the stream is continuous,
 *              the gun recoils +-0.13 u in step; the avatar does not move
 *   3467       CUT: splat and stream vanish in one frame; the gun is at
 *              x -0.57 u, y +1.8 u
 *   3467-3567  the gun scales down in place and is gone
 *
 * Everything in the Payload is `animation-delay` from LANDING (400), so the
 * catalogue's "at" minus 400. The comments keep both numbers.
 *
 * Sound (plan 4A): `squirt_start` at 933, `squirt_loop` 933-3433 (pump +
 * water hiss), `drip` at 3467 on the cut. The two squirt cues are placeholders
 * that fall back to the legacy `squirt` recipe until phase 6 supplies takes.
 */

import React from 'react';
import type { ThrowableSpec } from '../spec';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import { preloadThrowableCues } from '../cues';
import './water_gun.css';

export const waterGunSpec: ThrowableSpec = {
  id: 'water_gun',
  name: 'Water Gun',
  tier: 'free',
  category: 'objects',
  spawn: 'avatar-corner',
  // RE-BASED 2026-09-07. The reference's "Launch frame L = f174" is the SPAWN
  // frame - its own first table row is "Spawn at thrower 174-177" - and the
  // flight does not begin until f178 = 133. Ten of video 1's twelve tables are
  // labelled that way; the doc now says so at the top of each. Every number
  // below is the catalogue's ms MINUS 133, so `at` is ms from LAUNCH as spec.ts
  // requires, and `land` equals `flight.ms`, which is what the player actually
  // mounts the payload at. The four timeline delays in water_gun.css moved by
  // the same 33 ms, so the real-time behaviour is IDENTICAL - this corrects the
  // record, not the animation.
  spawnMs: 133,
  flight: { ms: 300, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 2.0, anchor: 'face', coversAvatar: true, ms: 3134 },
  beats: [
    { at: 300, marker: 'land' },
    { at: 634, marker: 'pull-back' },
    { at: 800, marker: 'squirt' },
    { at: 3300, marker: 'loop-end' },
    { at: 3334, marker: 'cut' },
    { at: 3434, marker: 'gun-out' },
  ],
  audio: [
    { at: 800, sample: 'squirt_start' },
    { at: 800, sample: 'squirt_loop', loopUntil: 3300, gain: 0.8 },
    { at: 3334, sample: 'drip', gain: 0.7 },
  ],
  reference: { video: 1, launchFrame: 174, throw: 'THROW 1' },
};

preloadThrowableCues(waterGunSpec.audio.map((c) => c.sample));

/**
 * The gun, drawn with the barrel pointing +x and the grip hanging down, 61
 * units long and 44 tall around (0,0). Rotated -35 deg it is the measured
 * 73 x 67 (22 x 20 px on a 30 px avatar). Pink tank on top, blue body, yellow
 * trigger and pump grip, a cyan reservoir window with a water line. Top-lit
 * plastic: vertical gradients, a highlight along the barrel and the tank.
 * The barrel tip is at (31, -1.5); the stream starts there.
 */
function Gun(_: { uid: string; k: string }) {
  return (
    <AtlasSprite src="water_gun" rect={[7, 150, 412, 438]} x={-42} y={-41} width={84} height={84} />
  );
}

/** The stream in gun-local units: a tapered cyan run from the barrel tip
 *  (31, -1.5) out to x 172, which the -60 deg aim and the 1.35 payload scale
 *  put well inside the blob from every gun position in the loop, so its far
 *  end is always hidden under the splat. A dashed lighter core line slides
 *  along it inside a clip for the flow. */

function Stream(_: { uid: string }) {
  return (
    <g className="thr-water_gun__flow">
      <AtlasSprite
        src="water_gun"
        rect={[889, 347, 355, 160]}
        x={38}
        y={-16}
        width={140}
        height={30}
      />
    </g>
  );
}

/**
 * The splat: an irregular cyan blob 188 x 200 units (1.87 x 2.0 u) drawn
 * around (0,0) and placed at y -17 by its parent, so it covers the avatar.
 * Overlapping lobes on one userSpaceOnUse gradient so the light is
 * continuous across them, seven spikes at the rim, a highlight, and two
 * white eyes with black pupils that make it a face.
 */
function Blob(_: { uid: string }) {
  return (
    <AtlasSprite
      src="water_gun"
      rect={[502, 702, 425, 412]}
      x={-94}
      y={-117}
      width={188}
      height={200}
    />
  );
}

function Projectile({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g transform="rotate(-35)">
        <Gun uid={uid} k="p" />
      </g>
    </svg>
  );
}

/** Twelve droplets: [dx, dy, r, delayStep]. Each starts under the blob at its
 *  centre and flies to (dx, dy) relative to it: the blob's rim (93 x 100)
 *  plus 36-40 units (up to 0.4 u) outward, so it surfaces at the rim and dies
 *  past it. Fixed, never random. */
const DROPLETS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, -140, 5, 0],
  [84.2, -105.7, 4, 2],
  [121.3, -46.5, 4.5, 1],
  [128.5, 36.3, 3.5, 3],
  [84.2, 105.7, 4, 0],
  [-23.1, 137.9, 3.5, 4],
  [-111.7, 68, 4.5, 2],
  [-133, 0, 4, 5],
  [-111.7, -68, 3.5, 3],
  [-65.5, -119.5, 5, 1],
  [45.5, -131.6, 3, 4],
  [-65.5, 119.5, 3, 5],
];

function Payload({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      {/* THE STREAM, under everything. It rides the same track and the same
          recoil as the gun so its root stays on the barrel tip; the aim is
          the static -60 deg the gun has reached by the time it exists. */}
      <g className="thr-water_gun__live">
        <g className="thr-water_gun__track">
          <g transform="rotate(-60)">
            <g className="thr-water_gun__jitter">
              <g transform="scale(1.35)">
                <Stream uid={uid} />
              </g>
            </g>
          </g>
        </g>
      </g>
      {/* THE DROPLETS, under the splat so they surface at its rim. */}
      <g className="thr-water_gun__live">
        {DROPLETS.map(([dx, dy, r, step], i) => (
          <g
            key={i}
            className="thr-water_gun__drop"
            style={
              {
                '--dx': `${dx}px`,
                '--dy': `${dy}px`,
                animationDelay: `calc((0.6s + ${(step * 0.03).toFixed(2)}s) * var(--animation-speed, 1))`,
              } as React.CSSProperties
            }
          >
            <AtlasSprite
              src="water_gun"
              rect={[1000, 775, 220, 300]}
              x={-r}
              y={-17 - r}
              width={r * 2}
              height={r * 2.7}
            />
          </g>
        ))}
      </g>
      {/* THE SPLAT: on in one frame at 933 with a 1.1x pop, pulsing 1.0 ->
          1.08 -> 1.0 every 278 ms, cut in one frame at 3467. */}
      <g className="thr-water_gun__splat">
        <g className="thr-water_gun__pulse">
          <Blob uid={uid} />
        </g>
      </g>
      {/* THE GUN, over the blob: holds at the settle, pulls back down-left
          while re-aiming from -35 to -60 deg, recoils through the loop, then
          scales out in place. */}
      <g className="thr-water_gun__track">
        <g className="thr-water_gun__aim">
          <g className="thr-water_gun__jitter">
            <g transform="scale(1.35)">
              <Gun uid={uid} k="a" />
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}

export const waterGunRig: ThrowableRig = { Projectile, Payload };
