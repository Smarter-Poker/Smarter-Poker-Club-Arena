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

/**
 * One mug, drawn around (0,0), 60 units wide and 84 tall (0.6 x 0.84 u, the
 * measured 17x24 px on a 30 px avatar). Glass body with a slight taper, amber
 * beer with a darker base and a bright vertical highlight, a foam head that
 * overhangs the rim, a C-handle on the right.
 */
function Mug({ uid, k }: { uid: string; k: string }) {
  const g = (n: string) => `thr-beer-${n}-${uid}-${k}`;
  return (
    <g>
      <defs>
        <linearGradient id={g('beer')} x1="0" y1="0" x2="0.85" y2="1">
          <stop offset="0%" stopColor="#fff0a2" />
          <stop offset="22%" stopColor="#ffc84b" />
          <stop offset="48%" stopColor="#e8931a" />
          <stop offset="76%" stopColor="#c16a0d" />
          <stop offset="100%" stopColor="#703608" />
        </linearGradient>
        <linearGradient id={g('glass')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="18%" stopColor="#ffffff" stopOpacity="0.08" />
          <stop offset="70%" stopColor="#ffffff" stopOpacity="0.05" />
          <stop offset="86%" stopColor="#ffffff" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0.1" />
        </linearGradient>
        <radialGradient id={g('foam')} cx="0.4" cy="0.35" r="0.7">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="70%" stopColor="#f6f1e4" />
          <stop offset="100%" stopColor="#d9cfb5" />
        </radialGradient>
        <linearGradient id={g('handle')} x1="0" y1="0" x2="1" y2="0.75">
          <stop offset="0%" stopColor="#50616a" />
          <stop offset="26%" stopColor="#edf8fa" />
          <stop offset="45%" stopColor="#98b7c0" />
          <stop offset="60%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#526973" />
        </linearGradient>
        <radialGradient id={g('contact')}>
          <stop offset="0%" stopColor="#101015" stopOpacity="0.48" />
          <stop offset="100%" stopColor="#101015" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="2" cy="45" rx="25" ry="6" fill={`url(#${g('contact')})`} />
      {/* handle, behind the body */}
      <path
        d="M22 -14 C 50 -16, 50 26, 22 24"
        fill="none"
        stroke={`url(#${g('handle')})`}
        strokeWidth="9"
        strokeLinecap="round"
        opacity="0.9"
      />
      <path
        d="M22 -14 C 50 -16, 50 26, 22 24"
        fill="none"
        stroke="#ffffff"
        strokeWidth="3"
        strokeLinecap="round"
        opacity="0.5"
      />
      {/* beer inside the glass */}
      <path d="M-22 -26 L 22 -26 L 19 40 Q 0 46 -19 40 Z" fill={`url(#${g('beer')})`} />
      {/* rising bubbles, static: three small discs */}
      <circle cx="-9" cy="18" r="1.8" fill="#ffd47a" opacity="0.8" />
      <circle cx="4" cy="6" r="1.4" fill="#ffd47a" opacity="0.8" />
      <circle cx="10" cy="26" r="1.2" fill="#ffd47a" opacity="0.7" />
      {/* Amber caustics and vertical glass flutes retain weight at phone scale. */}
      <path
        d="M -15 -20 L -13 32 M -3 -20 L -2 35 M 10 -20 L 9 33"
        fill="none"
        stroke="#71330c"
        strokeWidth="3.2"
        opacity="0.3"
      />
      <path
        d="M -17 -20 L -15 31 M -5 -20 L -4 34 M 8 -20 L 7 32"
        fill="none"
        stroke="#ffe7aa"
        strokeWidth="1.6"
        opacity="0.62"
      />
      {/* the glass over it: a tapered body with a thick base */}
      <path
        d="M-24 -30 L 24 -30 L 21 42 Q 0 49 -21 42 Z"
        fill={`url(#${g('glass')})`}
        stroke="#e6edf3"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <path d="M-21 34 Q 0 41 21 34 L 20 42 Q 0 49 -20 42 Z" fill="#ffffff" opacity="0.22" />
      <path
        d="M -21 -19 L -19 24 M 20 -18 L 18 27 M -16 41 Q 0 46 16 41"
        fill="none"
        stroke="#ffffff"
        strokeWidth="1.7"
        strokeLinecap="round"
        opacity="0.76"
      />
      <path
        d="M -23 -27 Q 0 -19 23 -27"
        fill="none"
        stroke="#744011"
        strokeWidth="2.3"
        opacity="0.5"
      />
      {/* foam head: overhangs the rim on both sides */}
      <g fill={`url(#${g('foam')})`}>
        <ellipse cx="0" cy="-32" rx="27" ry="9" />
        <circle cx="-16" cy="-38" r="9" />
        <circle cx="-2" cy="-42" r="11" />
        <circle cx="13" cy="-38" r="9" />
        <circle cx="24" cy="-31" r="6" />
        <circle cx="-25" cy="-30" r="6" />
      </g>
      {/* Foam lobes overlap as a continuous head, with warm undersides. */}
      <path
        d="M -23 -29 Q -12 -24 -7 -29 Q 3 -23 11 -29 Q 18 -25 25 -30"
        fill="none"
        stroke="#b9a889"
        strokeWidth="1.5"
        opacity="0.55"
      />
      <path
        d="M -21 -39 Q -17 -44 -12 -42 M -8 -46 Q -3 -51 3 -47 M 10 -41 Q 14 -44 18 -41"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <circle cx="-11" cy="-32" r="1.8" fill="#cbbd9f" opacity="0.55" />
      <circle cx="4" cy="-36" r="1.3" fill="#cbbd9f" opacity="0.45" />
      <circle cx="14" cy="-31" r="1.6" fill="#ffffff" />
      {/* a drip of foam down the left */}
      <path d="M-24 -28 q -2 8 1 14 q 3 -5 1 -14 z" fill="#f6f1e4" />
    </g>
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
        <ellipse cx="4" cy="-58" rx="16" ry="12" fill="#ffffff" />
        <ellipse cx="-6" cy="-50" rx="10" ry="8" fill="#fbf8f0" />
        <ellipse cx="14" cy="-48" rx="9" ry="7" fill="#fbf8f0" />
        {DROPLETS.map(([dx, dy, r, step], i) => (
          <circle
            key={i}
            className="thr-beer__drop"
            cx="4"
            cy="-52"
            r={r}
            fill="#ffffff"
            style={
              {
                '--dx': `${dx}px`,
                '--dy': `${dy}px`,
                animationDelay: `calc((1.234s + ${(step * 0.02).toFixed(2)}s) * var(--animation-speed, 1))`,
              } as React.CSSProperties
            }
          />
        ))}
      </g>
    </svg>
  );
}

export const beerRig: ThrowableRig = { Projectile, Payload };
