/**
 * ===============================================================================
 *  SNOWMAN - a head vanishes, a powder plume, a nose that falls to the chin
 *  (phase 2, 2026-09-06) - the shortest item in phase 2, a pure gag
 * ===============================================================================
 *
 * Measured off PB THROWABLE 1.MOV, THROW 10 (launch f2187, 30 fps, target
 * avatar ~30 px wide, so 1 px = 3.333 units), see
 * docs/throwables/pokerbros-reference-video-1.md and the build sheet in
 * docs/throwables/THROWABLES-PREMIUM-ANIMATION-PLAN.md ("snowman", line
 * ~639).
 *
 * A NUMBER CHOSEN, NOT READ (flight.ms): the raw capture's own flight ROW
 * spans 233-600 ms from its frame L (2187, first pixel at the thrower), but
 * that 600 is where flight ends measured from L, not the flight's own
 * DURATION - the row itself says "12 frames", i.e. 400 ms, and 400 is also
 * exactly `THROWABLE_GRAMMAR.flightMs.max`. Using the raw 600 here (as the
 * phase-1 rigs do for their post-landing beats) would overshoot the grammar
 * bound the moment this rig is wired into the registry. So `flight.ms` is
 * the measured DURATION (400), and every beat and cue below is the raw
 * capture's own "ms from L" number MINUS 200 - the same 200 ms that moved
 * out of `flight.ms` - so every `animation-delay` in the CSS (beat.at -
 * flight.ms) is untouched: this is a pure relabelling, not a re-timing.
 * `spawnMs` is the raw Spawn row's own span (0-200) and is unaffected.
 *
 * ms from LAUNCH, after that shift:
 *
 *   0-200    spawn: the figure fades/scales in ON the thrower's face
 *            (centred, not corner - the reference says "on the hero's
 *            face", unlike the other objects' upper-left spawn)
 *   0-400    straight flight UP the centre line, 24 px/frame, no spin
 *   400      LANDING: the full figure sits over the avatar centre (raw 600)
 *   433      SPLAT, one frame: the figure VANISHES, leaving only the red
 *            nose where its face was (raw 633)
 *   467-567  a white powder PLUME grows ABOVE the head (0.7 x 1.2 u) (raw
 *            667-767)
 *   567-800  specks spray sideways/upward from the plume; the red nose
 *            FALLS to the chin at ~1 px/frame (raw 767-1000)
 *   800-1733 the cloud lingers, its lobes slowly shifting (raw 1000-1933)
 *   1767+    the cloud fades (raw 1967+)
 *
 * Everything in the Payload is `animation-delay` from LANDING (400), so the
 * catalogue's shifted "at" minus 400: splat 33, plume 67, spray 167,
 * linger 400, fade 1367. The comments keep both the shifted and the raw
 * capture number.
 *
 * A SECOND NUMBER CHOSEN, NOT READ (payload.ms): the reference's own life is
 * only ~1.6 s of payload (raw 600 -> ~2200), but `THROWABLE_GRAMMAR.
 * payloadMs.min` is 1800 ms and the grammar test holds every rigged spec to
 * it. The gag itself has nothing left to show after the cloud fades (the
 * reference's own last row is "Clean - no residue, no tint") so there is no
 * honest extra BEAT to add; the fade is stretched from the reference's own
 * ~233 ms tail (raw 1967-2200) to 433 ms (shifted 1767-2200) instead,
 * holding the last wisps of cloud a little longer rather than inventing a
 * beat nothing in the capture shows.
 *
 * Sound (plan "snowman" line, contract table): `poof_soft` at 600 (raw 800 -
 * the reference's own capture: a soft poof 5 frames after the splat frame,
 * matching exactly once shifted).
 */

import type React from 'react';
import type { ThrowableSpec } from '../spec';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import { preloadThrowableCues } from '../cues';
import './snowman.css';

export const snowmanSpec: ThrowableSpec = {
  id: 'snowman',
  name: 'Snowman',
  tier: 'free',
  category: 'objects',
  spawn: 'avatar-face',
  // THE REFERENCE'S L IS THE SPAWN FRAME HERE, NOT THE LAUNCH. Video 1's other
  // throws set L at launch, so their catalogue ms drop straight into `beats`;
  // THROW 10 sets L = f2187, the frame the figure first appears on the THROWER,
  // and the flight does not start until f2194 = 233. So every number below is
  // the catalogue's ms MINUS 233, and the flight is its measured duration
  // (f2194 to f2205 is eleven intervals at 30 fps = 367 ms), not the 600 that
  // is the catalogue's ms-from-spawn of the landing.
  spawnMs: 233,
  flight: { ms: 367, mode: 'straight', upright: true },
  arrival: 'none',
  // 2000 (clean) - 367 (landing) = 1633 on target. That is BELOW the old
  // payloadMs floor of 1800, and the floor moved rather than the gag: see
  // THROWABLE_GRAMMAR in spec.ts.
  payload: { sizeU: 1.2, anchor: 'face', coversAvatar: false, ms: 1633 },
  beats: [
    { at: 367, marker: 'land' },
    { at: 400, marker: 'splat' },
    { at: 434, marker: 'puff' },
    { at: 534, marker: 'spray' },
    { at: 767, marker: 'linger' },
    { at: 1734, marker: 'fade' },
    { at: 2000, marker: 'cut' },
  ],
  audio: [{ at: 567, sample: 'poof_soft' }],
  reference: { video: 1, launchFrame: 2187, throw: 'THROW 10' },
};

preloadThrowableCues(snowmanSpec.audio.map((c) => c.sample));

const HAT_BLACK = '#1c1c22';
const NOSE_RED = '#e8432a';
const NOSE_EDGE = '#a82a17';

/** Eight specks: [dx, dy, r], the FINAL offset from the plume's base in
 *  units (up to 40 units / 0.4 u past it, per the measured "~12 px outside
 *  the plume"). Fixed, never random. */
const SPECKS: ReadonlyArray<readonly [number, number, number]> = [
  [-32, -18, 2.6],
  [-38, 6, 2.2],
  [-20, 28, 2.4],
  [10, 34, 2.0],
  [34, 14, 2.6],
  [36, -14, 2.2],
  [14, -34, 2.0],
  [-10, -38, 2.4],
];

/**
 * The snowman head and hat, drawn around (0,0), ~56 units wide and 78 tall.
 * A round white head with coal-dot eyes, a red ball nose and a black top hat
 * - our existing catalogue design, kept per the build sheet's instruction.
 * `k` keeps the projectile's and the landed copy's gradients apart.
 */
function Figure({ uid, k }: { uid: string; k: string }) {
  const g = (n: string) => `thr-snowman-${n}-${uid}-${k}`;
  return (
    <g>
      <defs>
        <radialGradient id={g('head')} cx="0.36" cy="0.3" r="0.8">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="52%" stopColor="#eef3f6" />
          <stop offset="82%" stopColor="#afc8d9" />
          <stop offset="100%" stopColor="#7296ad" />
        </radialGradient>
        <linearGradient id={g('hat')} x1="0" y1="0" x2="1" y2="0.15">
          <stop offset="0%" stopColor="#070b12" />
          <stop offset="28%" stopColor="#4c586b" />
          <stop offset="43%" stopColor="#2a3344" />
          <stop offset="85%" stopColor={HAT_BLACK} />
          <stop offset="100%" stopColor="#080d17" />
        </linearGradient>
      </defs>
      {/* the top hat, brim first */}
      <ellipse
        cx="0"
        cy="-28"
        rx="25"
        ry="5"
        fill={`url(#${g('hat')})`}
        stroke="#080d17"
        strokeWidth="1"
      />
      <path
        d="M -16 -52 Q 0 -57 16 -52 L 15 -30 Q 0 -25 -15 -30 Z"
        fill={`url(#${g('hat')})`}
        stroke="#111824"
        strokeWidth="0.8"
      />
      <ellipse cx="0" cy="-52" rx="16" ry="3.2" fill="#303d50" stroke="#738298" strokeWidth="0.6" />
      <path
        d="M -15.3 -36 Q 0 -31 15.3 -36 L 15 -31 Q 0 -26 -15 -31 Z"
        fill="#962e3c"
        stroke="#461721"
        strokeWidth="0.7"
      />
      <path d="M -14 -35 Q -7 -32 -3 -33" fill="none" stroke="#de7271" strokeWidth="0.8" />
      {/* the head */}
      <circle cx="0" cy="0" r="26" fill={`url(#${g('head')})`} stroke="#c2ccd2" strokeWidth="1" />
      <path
        d="M -20 -12 Q -16 -22 -5 -23 M -23 1 Q -23 9 -19 14"
        fill="none"
        stroke="#fff"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M -13 -20 Q 0 -23 13 -20"
        fill="none"
        stroke="#879cab"
        strokeWidth="1.5"
        opacity="0.5"
      />
      <path
        d="M -18 -5 l 1 -1 M -15 4 l 1 1 M 16 3 l 1 -1 M 12 15 l 1 1 M -8 20 l 1 -1 M 3 -17 l 1 1"
        fill="none"
        stroke="#9ebace"
        strokeWidth="0.7"
        strokeLinecap="round"
      />
      {/* coal eyes */}
      <circle cx="-9" cy="-6" r="3.1" fill="#1a1a1a" />
      <circle cx="9" cy="-6" r="3.1" fill="#1a1a1a" />
      <path
        d="M -10 -7.5 l 1 -0.5 M 8 -7.5 l 1 -0.5"
        stroke="#b7c8dc"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      {/* the red ball nose - this is the piece that survives the splat */}
      <Nose uid={`${uid}-${k}`} />
      {/* a small coal smile */}
      <circle cx="-6.5" cy="10.5" r="1.4" fill="#1a1a1a" />
      <circle cx="0" cy="12" r="1.4" fill="#1a1a1a" />
      <circle cx="6.5" cy="10.5" r="1.4" fill="#1a1a1a" />
    </g>
  );
}

/** Just the nose, for the standalone element that survives the splat and
 *  falls to the chin - the same circle, same position, as inside Figure. */
function Nose({ uid }: { uid: string }) {
  const nose = `thr-snowman-nose-${uid}`;
  return (
    <g>
      <defs>
        <radialGradient id={nose} cx="0.3" cy="0.25" r="0.8">
          <stop offset="0%" stopColor="#ffc6a5" />
          <stop offset="35%" stopColor={NOSE_RED} />
          <stop offset="100%" stopColor="#892422" />
        </radialGradient>
      </defs>
      <ellipse cx="0.8" cy="3.5" rx="5.2" ry="4.5" fill="#53768b" opacity="0.35" />
      <circle cx="0" cy="2" r="5" fill={`url(#${nose})`} stroke={NOSE_EDGE} strokeWidth="0.8" />
      <path
        d="M -2 -0.5 Q -1 -1.5 0 -1"
        fill="none"
        stroke="#ffe2cc"
        strokeWidth="0.9"
        strokeLinecap="round"
      />
    </g>
  );
}

/**
 * The powder plume: an overlapping cluster of white circles reading as a
 * tall cartoon puff, ~70 units wide and 120 tall (the measured 0.7 x 1.2 u),
 * drawn around (0,0) so the payload can offset it above the head.
 */
function Plume({ uid }: { uid: string }) {
  const g = (n: string) => `thr-snowman-${n}-${uid}`;
  return (
    <g>
      <defs>
        <radialGradient id={g('plume')} cx="0.4" cy="0.32" r="0.75">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="70%" stopColor="#f3f7fa" />
          <stop offset="100%" stopColor="#d7e2e8" />
        </radialGradient>
      </defs>
      <g fill={`url(#${g('plume')})`} stroke="#dae8ef" strokeWidth="0.6">
        <path d="M -25 25 C -39 27 -41 8 -30 1 C -39 -8 -33 -32 -16 -31 C -24 -45 -10 -54 1 -48 C 14 -54 28 -39 23 -29 C 39 -27 41 -9 31 0 C 43 10 33 34 17 32 C 5 44 -17 39 -25 25 Z" />
        <path d="M -8 -38 C -20 -43 -13 -57 -5 -55 C -5 -67 11 -65 10 -55 C 23 -49 14 -34 4 -36 Z" />
      </g>
      <path
        d="M -29 -10 C -29 -24 -16 -28 -9 -20 M 6 -32 C 15 -38 26 -28 25 -20 M -27 16 C -30 4 -17 -2 -10 4 M 8 20 C 17 11 30 14 28 24"
        fill="none"
        stroke="#c3d9e5"
        strokeWidth="1.3"
        strokeLinecap="round"
        opacity="0.65"
      />
      <path
        d="M -14 -37 Q -10 -44 -4 -42 M -30 6 Q -26 1 -22 2 M 12 -20 Q 20 -25 24 -18"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </g>
  );
}

function Projectile({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Figure uid={uid} k="p" />
    </svg>
  );
}

function Payload({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      {/* 400 (+0, raw capture 600): the whole figure, landed. Gone in one
          frame at 433 (+33, raw 633). */}
      <g className="thr-snowman__figure">
        <Figure uid={uid} k="a" />
      </g>

      {/* 433 (+33, raw 633): the nose is all that is left. It holds at the
          head's own nose position, then falls to the chin between 567 and
          800 (+167..+400, raw 767-1000), and stays there through the fade
          and the cut. */}
      <g className="thr-snowman__nose">
        <Nose uid={`${uid}-residue`} />
      </g>

      {/* 467 (+67, raw 667): the powder plume grows in ABOVE where the head
          was, lingers with a slow lobe shift 800-1733 (+400..+1333, raw
          1000-1933), then fades 1767-2200 (+1367..+1800, stretched past the
          reference's own ~2200 raw tail - see the file header). */}
      <g transform="translate(0 -46)">
        <g className="thr-snowman__plume">
          <Plume uid={uid} />
        </g>
      </g>

      {/* 567 (+167, raw 767): specks spray sideways and upward from the
          plume's base, fading by ~800 (+400). Plain <g>, no class: it only
          positions the specks and needs no CSS rule of its own (contract
          rule 11). */}
      <g transform="translate(0 -20)">
        {SPECKS.map(([dx, dy, r], i) => (
          <circle
            key={i}
            className="thr-snowman__speck"
            cx="0"
            cy="0"
            r={r}
            fill="#ffffff"
            style={
              {
                '--dx': `${dx}px`,
                '--dy': `${dy}px`,
              } as React.CSSProperties
            }
          />
        ))}
      </g>
    </svg>
  );
}

export const snowmanRig: ThrowableRig = { Projectile, Payload };
