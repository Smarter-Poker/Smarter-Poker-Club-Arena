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
import { AtlasSprite } from '../AtlasSprite';

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
function Figure() {
  return (
    <AtlasSprite src="snowman" rect={[20, 70, 408, 570]} x={-35} y={-50} width={70} height={100} />
  );
}
function Nose() {
  return (
    <g transform="rotate(-145)">
      <AtlasSprite src="snowman" rect={[875, 243, 360, 276]} x={-7} y={-5} width={14} height={11} />
    </g>
  );
}
function Plume() {
  return (
    <AtlasSprite
      src="snowman"
      rect={[428, 761, 465, 356]}
      x={-40}
      y={-55}
      width={80}
      height={100}
    />
  );
}
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Figure />
    </svg>
  );
}

function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      {/* 400 (+0, raw capture 600): the whole figure, landed. Gone in one
          frame at 433 (+33, raw 633). */}
      <g className="thr-snowman__figure">
        <Figure />
      </g>

      {/* 433 (+33, raw 633): the nose is all that is left. It holds at the
          head's own nose position, then falls to the chin between 567 and
          800 (+167..+400, raw 767-1000), and stays there through the fade
          and the cut. */}
      <g className="thr-snowman__nose">
        <Nose />
      </g>

      {/* 467 (+67, raw 667): the powder plume grows in ABOVE where the head
          was, lingers with a slow lobe shift 800-1733 (+400..+1333, raw
          1000-1933), then fades 1767-2200 (+1367..+1800, stretched past the
          reference's own ~2200 raw tail - see the file header). */}
      <g transform="translate(0 -46)">
        <g className="thr-snowman__plume">
          <Plume />
        </g>
      </g>

      {/* 567 (+167, raw 767): specks spray sideways and upward from the
          plume's base, fading by ~800 (+400). Plain <g>, no class: it only
          positions the specks and needs no CSS rule of its own (contract
          rule 11). */}
      <g transform="translate(0 -20)">
        {SPECKS.map(([dx, dy, r], i) => (
          <g
            key={i}
            className="thr-snowman__speck"
            style={{ '--dx': `${dx}px`, '--dy': `${dy}px` } as React.CSSProperties}
          >
            <AtlasSprite
              src="snowman"
              rect={[926, 790, 300, 302]}
              x={-r}
              y={-r}
              width={r * 2}
              height={r * 2}
            />
          </g>
        ))}
      </g>
    </svg>
  );
}

export const snowmanRig: ThrowableRig = { Projectile, Payload };
