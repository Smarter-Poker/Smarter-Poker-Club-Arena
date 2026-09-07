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
  spawnMs: 100,
  flight: { ms: 300, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 2.0, anchor: 'face', coversAvatar: true, ms: 3270 },
  beats: [
    { at: 400, marker: 'land' },
    { at: 767, marker: 'pull-back' },
    { at: 933, marker: 'squirt' },
    { at: 3433, marker: 'loop-end' },
    { at: 3467, marker: 'cut' },
    { at: 3567, marker: 'gun-out' },
  ],
  audio: [
    { at: 933, sample: 'squirt_start' },
    { at: 933, sample: 'squirt_loop', loopUntil: 3433, gain: 0.8 },
    { at: 3467, sample: 'drip', gain: 0.7 },
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
function Gun({ uid, k }: { uid: string; k: string }) {
  const g = (n: string) => `thr-water_gun-${n}-${uid}-${k}`;
  return (
    <g>
      <defs>
        <linearGradient id={g('body')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#7cc4ff" />
          <stop offset="50%" stopColor="#3a8ae6" />
          <stop offset="100%" stopColor="#1f5fb4" />
        </linearGradient>
        <linearGradient id={g('barrel')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8fd0ff" />
          <stop offset="55%" stopColor="#2f7fdc" />
          <stop offset="100%" stopColor="#1a4f9c" />
        </linearGradient>
        <linearGradient id={g('grip')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2f6fc4" />
          <stop offset="100%" stopColor="#163f85" />
        </linearGradient>
        <linearGradient id={g('tank')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffc2e0" />
          <stop offset="55%" stopColor="#ff6cb8" />
          <stop offset="100%" stopColor="#d8418f" />
        </linearGradient>
        <linearGradient id={g('trig')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffe680" />
          <stop offset="100%" stopColor="#f5b71c" />
        </linearGradient>
        <radialGradient id={g('water')} cx="0.35" cy="0.3" r="0.8">
          <stop offset="0%" stopColor="#e4fffc" />
          <stop offset="60%" stopColor="#8cf7ee" />
          <stop offset="100%" stopColor="#4ad3c9" />
        </radialGradient>
      </defs>
      {/* grip, behind the body, slanted back */}
      <path
        d="M -14 7 L 0 7 L -9 22 L -23 22 Z"
        fill={`url(#${g('grip')})`}
        stroke="#163d7c"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M -17 12 L -8 12 M -19 16 L -10 16"
        stroke="#123f80"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.6"
      />
      {/* trigger guard and the yellow trigger inside it */}
      <path
        d="M 1 9 Q -1 19 9 19 Q 15 19 13 12"
        fill="none"
        stroke="#2a63b8"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path d="M 3 9 L 9 9 Q 10.5 13 7 17 L 3 15 Z" fill={`url(#${g('trig')})`} />
      {/* the tank on top, pink, with its rear cap and fill port */}
      <rect x="-30" y="-22" width="37" height="14" rx="7" fill={`url(#${g('tank')})`} />
      <circle cx="-29" cy="-15" r="5" fill="#c9377f" />
      <circle cx="0" cy="-22" r="2.5" fill="#b52d70" />
      <rect x="-25" y="-20" width="22" height="3.5" rx="1.75" fill="#ffffff" opacity="0.55" />
      {/* the receiver */}
      <rect
        x="-25"
        y="-9"
        width="43"
        height="18"
        rx="4.5"
        fill={`url(#${g('body')})`}
        stroke="#163d7c"
        strokeWidth="1.2"
      />
      <rect x="-22" y="-8" width="36" height="2.2" rx="1.1" fill="#ffffff" opacity="0.35" />
      {/* the reservoir window: cyan, a water line and one bubble */}
      <rect x="-19" y="-6" width="15" height="11" rx="2.5" fill={`url(#${g('water')})`} />
      <path
        d="M -18 -1 Q -12 -3.5 -5 -1"
        fill="none"
        stroke="#ffffff"
        strokeWidth="1.2"
        opacity="0.6"
      />
      <circle cx="-9" cy="2" r="1.3" fill="#ffffff" opacity="0.7" />
      <rect
        x="-19"
        y="-6"
        width="15"
        height="11"
        rx="2.5"
        fill="none"
        stroke="#163d7c"
        strokeWidth="1.2"
      />
      {/* the barrel, its muzzle band and the highlight along it */}
      <rect x="16" y="-6" width="15" height="9" rx="3" fill={`url(#${g('barrel')})`} />
      <rect x="27" y="-7" width="4" height="11" rx="1.5" fill="#1a4f9c" />
      <rect x="17" y="-5" width="11" height="1.8" rx="0.9" fill="#ffffff" opacity="0.6" />
      {/* the yellow pump grip under the barrel */}
      <rect x="17" y="4" width="9" height="5.5" rx="1.8" fill={`url(#${g('trig')})`} />
    </g>
  );
}

/** The stream in gun-local units: a tapered cyan run from the barrel tip
 *  (31, -1.5) out to x 172, which the -60 deg aim and the 1.35 payload scale
 *  put well inside the blob from every gun position in the loop, so its far
 *  end is always hidden under the splat. A dashed lighter core line slides
 *  along it inside a clip for the flow. */
const STREAM_D = 'M 31 -4.5 Q 100 -9 172 -8.5 L 172 6.5 Q 100 7 31 1.5 Z';

function Stream({ uid }: { uid: string }) {
  const id = (n: string) => `thr-water_gun-${n}-${uid}`;
  return (
    <g>
      <defs>
        <linearGradient id={id('stream')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#c6fff9" />
          <stop offset="40%" stopColor="#78fff0" />
          <stop offset="100%" stopColor="#5ef0e4" />
        </linearGradient>
        <clipPath id={id('clip')}>
          <path d={STREAM_D} />
        </clipPath>
      </defs>
      <path d={STREAM_D} fill={`url(#${id('stream')})`} opacity="0.95" />
      <g clipPath={`url(#${id('clip')})`}>
        <line
          className="thr-water_gun__flow"
          x1="10"
          y1="-1.2"
          x2="200"
          y2="-1"
          stroke="#e9fffc"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeDasharray="9 9"
          opacity="0.8"
        />
      </g>
      {/* spray beads along the edges, static; they recoil with the gun */}
      <circle cx="58" cy="-9.5" r="1.5" fill="#e9fffc" opacity="0.75" />
      <circle cx="84" cy="9.5" r="1.2" fill="#e9fffc" opacity="0.7" />
      <circle cx="116" cy="-12" r="1.6" fill="#e9fffc" opacity="0.75" />
      <circle cx="140" cy="11" r="1.3" fill="#e9fffc" opacity="0.7" />
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
function Blob({ uid }: { uid: string }) {
  const id = (n: string) => `thr-water_gun-${n}-${uid}`;
  return (
    <g transform="translate(0 -17)">
      <defs>
        <radialGradient id={id('blob')} gradientUnits="userSpaceOnUse" cx="-25" cy="-45" r="120">
          <stop offset="0%" stopColor="#d6fffb" />
          <stop offset="45%" stopColor="#8dfff3" />
          <stop offset="85%" stopColor="#62ebe0" />
          <stop offset="100%" stopColor="#46d5cb" />
        </radialGradient>
      </defs>
      <g fill={`url(#${id('blob')})`}>
        <ellipse cx="0" cy="0" rx="78" ry="84" />
        <circle cx="-52" cy="-48" r="30" />
        <circle cx="48" cy="-52" r="28" />
        <circle cx="66" cy="18" r="26" />
        <circle cx="-68" cy="22" r="25" />
        <circle cx="0" cy="68" r="28" />
        <circle cx="-38" cy="62" r="24" />
        <circle cx="42" cy="58" r="22" />
        <circle cx="0" cy="-76" r="22" />
        {/* spikes at the rim */}
        <path d="M -60 -72 L -72 -92 L -48 -78 Z" />
        <path d="M 40 -76 L 56 -94 L 60 -68 Z" />
        <path d="M 84 -20 L 94 -32 L 90 -6 Z" />
        <path d="M -86 30 L -94 44 L -80 46 Z" />
        <path d="M 60 62 L 74 78 L 50 76 Z" />
        <path d="M -56 70 L -64 88 L -44 80 Z" />
        <path d="M -8 -94 L 2 -102 L 8 -92 Z" />
      </g>
      {/* a soft top-left highlight on the wet surface */}
      <ellipse
        cx="-30"
        cy="-50"
        rx="26"
        ry="14"
        fill="#ffffff"
        opacity="0.32"
        transform="rotate(-25 -30 -50)"
      />
      {/* the eyes: white discs, black pupils looking down-left at the gun */}
      <g>
        <circle cx="-24" cy="-30" r="8" fill="#ffffff" stroke="#3fc9c0" strokeWidth="1" />
        <circle cx="24" cy="-30" r="8" fill="#ffffff" stroke="#3fc9c0" strokeWidth="1" />
        <circle cx="-25.5" cy="-28.5" r="3.5" fill="#101820" />
        <circle cx="22.5" cy="-28.5" r="3.5" fill="#101820" />
        <circle cx="-27" cy="-30" r="1.2" fill="#ffffff" />
        <circle cx="21" cy="-30" r="1.2" fill="#ffffff" />
      </g>
    </g>
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
          <circle
            key={i}
            className="thr-water_gun__drop"
            cx="0"
            cy="-17"
            r={r}
            fill="#a9fff6"
            style={
              {
                '--dx': `${dx}px`,
                '--dy': `${dy}px`,
                animationDelay: `calc((0.633s + ${(step * 0.03).toFixed(2)}s) * var(--animation-speed, 1))`,
              } as React.CSSProperties
            }
          />
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
