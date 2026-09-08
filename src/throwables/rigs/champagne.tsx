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
import { AtlasSprite } from '../AtlasSprite';

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

/**
 * The bottle, drawn around (0,0): 33 units wide at the body and 105 tall
 * (0.33 x 1.05 u, the measured 10 x 32 px on a 30 px avatar), base at +52 and
 * the neck tip at -53. Always upright; nothing here ever rotates. Dark green
 * glass with a left highlight, a gold foil collar, a cream-and-gold label.
 */
function Bottle(_: { uid: string; k: string }) {
  return (
    <g transform="rotate(-17)">
      <AtlasSprite
        src="champagne"
        rect={[65, 10, 340, 600]}
        x={-33}
        y={-60}
        width={66}
        height={116}
      />
    </g>
  );
}

/** The cork, drawn around its own centre. Invented; see the header. */
function Cork(_: { uid: string; k: string }) {
  return (
    <AtlasSprite src="champagne" rect={[530, 157, 240, 292]} x={-7} y={-9} width={14} height={18} />
  );
}

/**
 * One flute, drawn around (0,0): 26 units across the rim and 67 tall
 * (0.26 x 0.67 u, the measured 8 x 20 px). A tapered bowl of pale glass with
 * champagne in its lower two thirds, three rising bubbles, a stem and a foot.
 */
function Flute({ k }: { uid: string; k: string }) {
  return (
    <g transform="rotate(-15)">
      <AtlasSprite
        src="champagne"
        rect={k === 'b' ? [49, 634, 285, 604] : [855, 20, 287, 597]}
        x={-24}
        y={-56}
        width={48}
        height={102}
      />
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
        <AtlasSprite
          src="champagne"
          rect={[990, 816, 180, 214]}
          x={-12}
          y={-84}
          width={24}
          height={24}
        />
      </g>

      {/* THE JET, 933-1600: a ribbon from the neck arcing right, grown by
          scaleY off its base so the root never leaves the neck. */}
      <g className="thr-champagne__jet">
        <AtlasSprite
          src="champagne"
          rect={[480, 620, 315, 634]}
          x={-17}
          y={-148}
          width={42}
          height={86}
        />
      </g>

      {/* THE SIDE SPRAY: droplets thrown off the jet's crown while it runs. */}
      <g className="thr-champagne__jet-spray">
        {SPRAY.map(([dx, dy, r, step], i) => (
          <g
            key={i}
            className="thr-champagne__speck"
            style={
              {
                '--dx': `${dx}px`,
                '--dy': `${dy}px`,
                animationDelay: `calc((0.767s + ${(step * 0.03).toFixed(2)}s) * var(--animation-speed, 1))`,
              } as React.CSSProperties
            }
          >
            <AtlasSprite
              src="champagne"
              rect={[1146, 724, 42, 44]}
              x={-3}
              y={-143}
              width={6}
              height={6}
            />
          </g>
        ))}
      </g>

      {/* THE THREAD, 1567-1900: the stream lifts off the neck as a wiggly
          filament, rises and fades. */}
      <g className="thr-champagne__thread">
        <AtlasSprite
          src="champagne"
          rect={[955, 717, 250, 480]}
          x={-9}
          y={-148}
          width={20}
          height={72}
        />
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
          <g
            key={i}
            className="thr-champagne__drop"
            style={
              {
                '--dx': `${dx}px`,
                '--dy': `${dy}px`,
                animationDelay: `calc((2.967s + ${(step * 0.02).toFixed(2)}s) * var(--animation-speed, 1))`,
              } as React.CSSProperties
            }
          >
            <AtlasSprite
              src="champagne"
              rect={[1146, 724, 42, 44]}
              x={-3}
              y={-35}
              width={6}
              height={6}
            />
          </g>
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
        <AtlasSprite
          src="champagne"
          rect={[1146, 724, 42, 44]}
          x={-50}
          y={-34}
          width={14}
          height={14}
        />
      </g>
      <g
        className="thr-champagne__glint"
        style={{ animationDelay: `calc(3.9s * var(--animation-speed, 1))` } as React.CSSProperties}
      >
        <AtlasSprite
          src="champagne"
          rect={[1146, 724, 42, 44]}
          x={44}
          y={-34}
          width={14}
          height={14}
        />
      </g>
    </svg>
  );
}

export const champagneRig: ThrowableRig = { Projectile, Payload };
