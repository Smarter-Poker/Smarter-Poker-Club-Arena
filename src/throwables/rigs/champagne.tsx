/**
 * ===============================================================================
 *  CHAMPAGNE - a cork, a foam jet, and a bottle that dissolves into two flutes
 *  (phase 2, 2026-09-06)
 * ===============================================================================
 *
 * Measured off PB THROWABLE 1.MOV, THROW 9 (L = f2020, 30 fps, target avatar
 * 30 px wide, so 1 px = 3.333 units), see
 * docs/throwables/pokerbros-reference-video-1.md lines 502-550, and the build
 * sheet in docs/throwables/THROWABLES-PREMIUM-ANIMATION-PLAN.md (champagne).
 *
 * The catalogue's L is the SPAWN frame and the spec's launch is the END of the
 * spawn, exactly as beer (phase 1) mapped THROW 2. So spawnMs is the spawn
 * window's own length and every later beat keeps the catalogue's ms from L:
 *
 *   -233..0    bottle scales in at the thrower's upper-left, UPRIGHT
 *   0-200      straight upright flight, no spin, no scale change (6 frames)
 *   200        LANDS standing, centred on the avatar
 *   200-767    stands still (the catalogue's 433-767 hold, longer at the front
 *              by the 233 ms the spawn no longer occupies after launch)
 *   800        CORK POP: a white puff at the neck tip; the cork leaves
 *   933-1533   FOAM JET: a white stream from the neck, arcing right, with
 *              droplets spraying sideways at its top
 *   1567-1900  the jet detaches into a wiggly thread that rises and fades
 *   1933-2267  the bottle rests, no spray
 *   2300-2467  MORPH: the bottle turns translucent and CROSS-FADES into ONE
 *              flute at the same spot, which grows to full size. A dissolve,
 *              not a cut - the two overlap for the whole 167 ms
 *   2467-2667  one full flute, centred
 *   2700-2967  a SECOND flute fades in on the LEFT
 *   2833-3133  both tilt inward into a V, rims touching at the top-centre
 *   3167-3267  CLINK: small yellow droplets jump up from the touching rims
 *   3267-3500  ease apart to flank the face (left -0.47 u, right +0.47 u)
 *   3533-4700  fade out; the seat is clean afterwards
 *
 * Everything in the Payload is `animation-delay` from LANDING (200), so the
 * catalogue's "at" minus 200. The comments keep both numbers.
 *
 * TWO NUMBERS CHOSEN RATHER THAN READ, both because the rig box is 3 u and
 * nothing may leave it (rig.ts):
 *   - the bottle's base sits at +0.40 u. The reference stands it with its base
 *     ON the avatar centre and its neck 1.33 u above, which would put the jet
 *     0.9 u outside the box.
 *   - the foam jet reaches 83 units (25 px) above the neck, which is the
 *     reference's FIRST jet height (20-25 px at f2047-2048) rather than the
 *     40 px it sustains later.
 * The cork itself is invented: at 30 px the reference resolves only a white
 * puff, and a bottle that jets foam with its cork still in is wrong anyway.
 *
 * Sound (build sheet): `cork_pop` 800 - the loudest cue in the library; in the
 * capture it trails the picture by 3 frames, which is recording lag, so it is
 * scheduled ON the visual pop. `fizz_loop` 1000-3200, `flute_clink` 3167 (the
 * capture puts it 10 frames late, the same lag as the beer clink), and two
 * `flute_clink_soft` at 3900 / 4100.
 */

import React from 'react';
import type { ThrowableSpec } from '../spec';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import { preloadThrowableCues } from '../cues';
import './champagne.css';

export const champagneSpec: ThrowableSpec = {
  id: 'champagne',
  name: 'Champagne',
  tier: 'free',
  category: 'cheers',
  spawn: 'avatar-corner',
  spawnMs: 233,
  flight: { ms: 200, mode: 'straight', upright: true },
  arrival: 'land',
  payload: { sizeU: 1.4, anchor: 'face', coversAvatar: false, ms: 4500 },
  beats: [
    { at: 200, marker: 'land' },
    { at: 800, marker: 'cork-pop' },
    { at: 933, marker: 'foam-jet' },
    { at: 1567, marker: 'jet-thread' },
    { at: 1933, marker: 'rest' },
    { at: 2300, marker: 'morph' },
    { at: 2700, marker: 'flute-2' },
    { at: 3167, marker: 'clink' },
    { at: 3267, marker: 'ease-apart' },
    { at: 3533, marker: 'fade' },
    { at: 4700, marker: 'gone' },
  ],
  audio: [
    { at: 800, sample: 'cork_pop' },
    { at: 1000, sample: 'fizz_loop', loopUntil: 3200, gain: 0.6 },
    { at: 3167, sample: 'flute_clink' },
    { at: 3900, sample: 'flute_clink_soft', gain: 0.7 },
    { at: 4100, sample: 'flute_clink_soft', gain: 0.6 },
  ],
  reference: { video: 1, launchFrame: 2020, throw: 'THROW 9' },
};

preloadThrowableCues(champagneSpec.audio.map((c) => c.sample));

const GLASS_GREEN = '#14401f';
const FOIL_GOLD = '#d9ab3c';
const WINE = '#f2ce67';

/**
 * The bottle, drawn around (0,0): 33 units wide at the body and 105 tall
 * (0.33 x 1.05 u, the measured 10 x 32 px on a 30 px avatar), base at +52 and
 * the neck tip at -53. Always upright; nothing here ever rotates. Dark green
 * glass with a left highlight, a gold foil collar, a cream-and-gold label.
 */
function Bottle({ uid, k }: { uid: string; k: string }) {
  const g = (n: string) => `thr-champagne-${n}-${uid}-${k}`;
  return (
    <g>
      <defs>
        <linearGradient id={g('glass')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#0a2411" />
          <stop offset="22%" stopColor="#2a6c37" />
          <stop offset="45%" stopColor={GLASS_GREEN} />
          <stop offset="80%" stopColor="#0c2d15" />
          <stop offset="100%" stopColor="#061b0c" />
        </linearGradient>
        <linearGradient id={g('foil')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#9d6f16" />
          <stop offset="30%" stopColor="#f6dd8c" />
          <stop offset="60%" stopColor={FOIL_GOLD} />
          <stop offset="100%" stopColor="#8a5f12" />
        </linearGradient>
        <linearGradient id={g('label')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#cbb47c" />
          <stop offset="35%" stopColor="#f7ecd0" />
          <stop offset="100%" stopColor="#c3a86e" />
        </linearGradient>
      </defs>
      {/* the body: shoulders sweeping out of the neck into a straight barrel */}
      <path
        d="M -6 -53 L 6 -53 L 6 -18 C 6 -10, 16.5 -4, 16.5 8 L 16.5 47 Q 16.5 52 11 52 L -11 52 Q -16.5 52 -16.5 47 L -16.5 8 C -16.5 -4, -6 -10, -6 -18 Z"
        fill={`url(#${g('glass')})`}
        stroke="#05170a"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      {/* the gold foil over the neck, and the wire-cage band under it */}
      <path d="M -6.6 -53 L 6.6 -53 L 6.6 -26 L -6.6 -26 Z" fill={`url(#${g('foil')})`} />
      <rect x="-7.2" y="-30.6" width="14.4" height="3.4" fill="#8a5f12" opacity="0.85" />
      <rect x="-7" y="-45" width="14" height="2.2" fill="#f6dd8c" opacity="0.7" />
      {/* the label */}
      <rect x="-14" y="12" width="28" height="26" rx="1.5" fill={`url(#${g('label')})`} />
      <rect x="-14" y="16.5" width="28" height="2" fill={FOIL_GOLD} opacity="0.9" />
      <rect x="-14" y="33" width="28" height="1.6" fill={FOIL_GOLD} opacity="0.9" />
      <ellipse cx="0" cy="25" rx="5.4" ry="4.4" fill={FOIL_GOLD} opacity="0.85" />
      {/* the highlight down the left of the glass */}
      <path
        d="M -11 -14 C -12 -4, -12.5 14, -12 44"
        fill="none"
        stroke="#a9e6bb"
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity="0.42"
      />
      <path
        d="M -3.5 -50 L -3.5 -32"
        fill="none"
        stroke="#ffffff"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.4"
      />
      {/* the punt shadow at the base */}
      <path
        d="M -16.5 45 Q 0 41 16.5 45 L 16.5 47 Q 16.5 52 11 52 L -11 52 Q -16.5 52 -16.5 47 Z"
        fill="#031207"
        opacity="0.55"
      />
    </g>
  );
}

/** The cork, drawn around its own centre. Invented; see the header. */
function Cork({ uid, k }: { uid: string; k: string }) {
  const g = (n: string) => `thr-champagne-${n}-${uid}-${k}`;
  return (
    <g>
      <defs>
        <linearGradient id={g('cork')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#c99a5c" />
          <stop offset="45%" stopColor="#e8c48c" />
          <stop offset="100%" stopColor="#a97838" />
        </linearGradient>
      </defs>
      <path
        d="M -5.5 5 L -5.5 -3 Q -5.5 -8 0 -8 Q 5.5 -8 5.5 -3 L 5.5 5 Z"
        fill={`url(#${g('cork')})`}
        stroke="#8a6029"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
      <rect x="-5.5" y="3.6" width="11" height="2.6" rx="1.3" fill="#8a6029" opacity="0.75" />
    </g>
  );
}

/**
 * One flute, drawn around (0,0): 26 units across the rim and 67 tall
 * (0.26 x 0.67 u, the measured 8 x 20 px). A tapered bowl of pale glass with
 * champagne in its lower two thirds, three rising bubbles, a stem and a foot.
 */
function Flute({ uid, k }: { uid: string; k: string }) {
  const g = (n: string) => `thr-champagne-${n}-${uid}-${k}`;
  return (
    <g>
      <defs>
        <linearGradient id={g('wine')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffeba8" />
          <stop offset="60%" stopColor={WINE} />
          <stop offset="100%" stopColor="#d9a52f" />
        </linearGradient>
        <linearGradient id={g('bowl')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.5" />
          <stop offset="30%" stopColor="#ffffff" stopOpacity="0.1" />
          <stop offset="78%" stopColor="#ffffff" stopOpacity="0.08" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0.42" />
        </linearGradient>
      </defs>
      {/* the champagne, inside the bowl */}
      <path
        d="M -11.2 -25 L 11.2 -25 L 7 -11 Q 3.6 -4.5 0 -4.5 Q -3.6 -4.5 -7 -11 Z"
        fill={`url(#${g('wine')})`}
      />
      <circle cx="-3.5" cy="-15" r="1.3" fill="#fff6d4" opacity="0.9" />
      <circle cx="2.5" cy="-19" r="1" fill="#fff6d4" opacity="0.85" />
      <circle cx="0.5" cy="-9" r="0.9" fill="#fff6d4" opacity="0.8" />
      {/* the bowl over it */}
      <path
        d="M -13 -33 L 13 -33 L 8 -11 Q 4 -4 0 -4 Q -4 -4 -8 -11 Z"
        fill={`url(#${g('bowl')})`}
        stroke="#e9f2f6"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      {/* stem and foot */}
      <rect x="-1.6" y="-5" width="3.2" height="27" fill="#e9f2f6" opacity="0.85" />
      <ellipse cx="0" cy="23.5" rx="9" ry="2.8" fill="#e9f2f6" opacity="0.9" />
      <ellipse cx="0" cy="22.6" rx="6.5" ry="1.6" fill="#ffffff" opacity="0.5" />
    </g>
  );
}

function Projectile({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Bottle uid={uid} k="p" />
      <g transform="translate(0 -58)">
        <Cork uid={uid} k="p" />
      </g>
    </svg>
  );
}

/**
 * Nine side droplets thrown out of the jet's crown, 967-1533: [dx, dy, r,
 * delayStep]. Offsets are from the jet's top (0, -140) in units. Fixed, never
 * random, so the darkroom photographs the same frame twice.
 */
const SPRAY: ReadonlyArray<readonly [number, number, number, number]> = [
  [-26, -14, 2.6, 0],
  [-18, 6, 2.0, 2],
  [-32, 8, 2.2, 4],
  [22, -18, 2.8, 1],
  [30, 2, 2.4, 3],
  [16, 12, 1.8, 5],
  [-8, -26, 2.2, 2],
  [8, -28, 2.0, 4],
  [36, -8, 1.8, 0],
];

/** Eight clink droplets from the touching rims: [dx, dy, r, delayStep]. */
const CLINK_DROPS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-20, -30, 2.6, 0],
  [-10, -40, 2.0, 2],
  [0, -44, 2.8, 1],
  [10, -39, 2.2, 3],
  [20, -31, 2.4, 0],
  [-26, -18, 1.8, 4],
  [26, -19, 1.8, 2],
  [4, -26, 1.6, 5],
];

function Payload({ uid }: RigProps) {
  const g = (n: string) => `thr-champagne-${n}-${uid}`;
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={g('jet')} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="55%" stopColor="#fbfdff" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#eaf6ff" stopOpacity="0.35" />
        </linearGradient>
      </defs>

      {/* THE BOTTLE: stands from the landing, base at +0.40 u, neck tip at
          -0.65 u. Cross-fades out over the morph (2300-2467). */}
      <g className="thr-champagne__bottle">
        <g transform="translate(0 -12)">
          <Bottle uid={uid} k="a" />
        </g>
      </g>

      {/* THE CORK: leaves the neck at 800 and is gone by 1100. */}
      <g className="thr-champagne__cork">
        <g transform="translate(0 -70)">
          <Cork uid={uid} k="a" />
        </g>
      </g>

      {/* THE PUFF at the neck tip, 800-933: the reference's first white ball
          before the stream takes over. */}
      <g className="thr-champagne__puff">
        <circle cx="0" cy="-72" r="9" fill="#ffffff" />
        <circle cx="-7" cy="-66" r="5.5" fill="#f6fbff" />
        <circle cx="7" cy="-67" r="5" fill="#f6fbff" />
      </g>

      {/* THE JET, 933-1600: a ribbon from the neck arcing right, grown by
          scaleY off its base so the root never leaves the neck. */}
      <g className="thr-champagne__jet">
        <path
          d="M -6.5 -62 C -10 -88, -6 -110, 2 -132 C 5 -140, 9 -145, 12.5 -147 C 14 -142, 12.5 -134, 10.5 -126 C 6.5 -106, 5.5 -84, 5 -62 Z"
          fill={`url(#${g('jet')})`}
        />
        <path
          d="M -2 -66 C -4 -88, -1 -108, 5 -128"
          fill="none"
          stroke="#ffffff"
          strokeWidth="2.2"
          strokeLinecap="round"
          opacity="0.7"
        />
        <ellipse cx="9" cy="-142" rx="8" ry="6" fill="#ffffff" opacity="0.85" />
        <ellipse cx="0" cy="-134" rx="5.5" ry="4.5" fill="#ffffff" opacity="0.7" />
      </g>

      {/* THE SIDE SPRAY: droplets thrown off the jet's crown while it runs. */}
      <g className="thr-champagne__jet-spray">
        {SPRAY.map(([dx, dy, r, step], i) => (
          <circle
            key={i}
            className="thr-champagne__speck"
            cx="4"
            cy="-140"
            r={r}
            fill="#ffffff"
            style={
              {
                '--dx': `${dx}px`,
                '--dy': `${dy}px`,
                animationDelay: `calc((0.767s + ${(step * 0.03).toFixed(2)}s) * var(--animation-speed, 1))`,
              } as React.CSSProperties
            }
          />
        ))}
      </g>

      {/* THE THREAD, 1567-1900: the stream lifts off the neck as a wiggly
          filament, rises and fades. */}
      <g className="thr-champagne__thread">
        <path
          d="M 0 -78 C -5 -92, 4 -102, -1 -116 C -5 -126, 3 -134, 1 -144"
          fill="none"
          stroke="#ffffff"
          strokeWidth="4"
          strokeLinecap="round"
          opacity="0.9"
        />
        <circle cx="1" cy="-146" r="4" fill="#ffffff" opacity="0.85" />
      </g>

      {/* FLUTE 1: cross-fades in where the bottle was (2300-2467), swings into
          the V (2833-3133), eases out to the right flank (3267-3500). */}
      <g className="thr-champagne__f1">
        <g className="thr-champagne__f1-tilt">
          <g transform="translate(0 8)">
            <Flute uid={uid} k="a" />
          </g>
        </g>
      </g>

      {/* FLUTE 2: fades in on the LEFT (2700-2967) and mirrors flute 1. */}
      <g className="thr-champagne__f2">
        <g className="thr-champagne__f2-tilt">
          <g transform="translate(0 8)">
            <Flute uid={uid} k="b" />
          </g>
        </g>
      </g>

      {/* THE CLINK: yellow droplets jumping up from the touching rims at 3167,
          drawn last so they read over both glasses. */}
      <g className="thr-champagne__clink">
        {CLINK_DROPS.map(([dx, dy, r, step], i) => (
          <circle
            key={i}
            className="thr-champagne__drop"
            cx="0"
            cy="-32"
            r={r}
            fill={WINE}
            style={
              {
                '--dx': `${dx}px`,
                '--dy': `${dy}px`,
                animationDelay: `calc((2.967s + ${(step * 0.02).toFixed(2)}s) * var(--animation-speed, 1))`,
              } as React.CSSProperties
            }
          />
        ))}
      </g>

      {/* THE TWO LATE GLINTS, 3900 and 4100. The capture records two soft
          clinks there with the table hidden by a dialog, so the picture is
          INVENTED: one small rim glint per flute rather than choreography
          nobody measured. */}
      <g
        className="thr-champagne__glint"
        style={{ animationDelay: `calc(3.7s * var(--animation-speed, 1))` } as React.CSSProperties}
      >
        <path d="M -47 -28 l 3 -8 l 3 8 l 8 3 l -8 3 l -3 8 l -3 -8 l -8 -3 Z" fill="#fff6d4" />
      </g>
      <g
        className="thr-champagne__glint"
        style={{ animationDelay: `calc(3.9s * var(--animation-speed, 1))` } as React.CSSProperties}
      >
        <path d="M 47 -28 l 3 -8 l 3 8 l 8 3 l -8 3 l -3 8 l -3 -8 l -8 -3 Z" fill="#fff6d4" />
      </g>
    </svg>
  );
}

export const champagneRig: ThrowableRig = { Projectile, Payload };
