import { AtlasSprite } from '../AtlasSprite';
/**
 * ===============================================================================
 *  TROPHY - vanish, a wisp, a spotlight beam, a golden reform (phase 2, 2026-09-07)
 * ===============================================================================
 *
 * Measured off PB THROWABLE 1.MOV, THROW 12 (30 fps, target avatar 30 px wide,
 * so 1 px = 3.333 units), see docs/throwables/pokerbros-reference-video-1.md
 * lines 633-672 and the build sheet at
 * docs/throwables/THROWABLES-PREMIUM-ANIMATION-PLAN.md line 656.
 *
 * L WAS THE SPAWN FRAME, NOT THE LAUNCH FRAME. The doc writes "Launch frame
 * L = f2595", but its own beat table then lists "Spawn at thrower 2595-2601,
 * 0-200" as the FIRST row - i.e. frame 2595 is where the statuette first
 * appears on the thrower's face, not where it leaves. The actual departure
 * ("Lift ... Moves up ~10 px above the hero's head") is the NEXT row, at frame
 * 2602 = raw ms 233. That is 233 ms after L, and it is exactly `spawnMs`
 * below. Every other ms in the doc's table (and in the build sheet, which
 * copies the same raw numbers) is relative to L=2595 and has 233 subtracted
 * here to become ms from the TRUE launch (frame 2602), which is what
 * `spec.beats[].at` and `spec.audio[].at` are in this file. `reference.
 * launchFrame` below is recorded as 2602, the corrected frame, not 2595.
 *
 * ms from LAUNCH (frame 2602):
 *
 *   -233..-33  the statuette pops in on the thrower's face and holds, upright
 *   0-133      straight flight up-left, upright, no spin - only 4 frames,
 *              ~30 px/frame, THE FASTEST FLIGHT IN THE SET
 *   133        arrival: the statuette is whole, at the target, for one frame
 *   167        VANISH: gone in one frame; a faint grey wisp starts rising
 *              above the avatar's left shoulder
 *   167-367    the wisp climbs and fades
 *   400-733    a golden-white SPOTLIGHT BEAM grows above the avatar's left
 *              side: thin and dim at first, then a dark statuette silhouette
 *              forms at its base as it brightens
 *   733        the beam reaches full brightness; the silhouette is REPLACED
 *              by the solid gold statuette, standing on the shoulder
 *   1067-1367  the beam narrows and dims to nothing; the statuette stays
 *   1367-4267  the statuette holds, with two measured sparkle glints near its
 *              head at 2433 and 2767 (the reference video ends at f2704, so
 *              nothing past that is measured; no further glints are invented)
 *   4267       CUT
 *
 * Everything in the Payload is `animation-delay` from LANDING (133), so the
 * catalogue's "at" minus 133: vanish 34, beam 267, reform 600, fade 934,
 * set 1234, sparkle 2300 / 2634. The comments keep both numbers.
 *
 * THE BEAM is drawn as two overlapping gradient-filled polygons, never a
 * `filter: blur()` (Phase 2 contract rule 6): a wide, low-opacity "halo"
 * polygon whose LEFT-RIGHT gradient fades to transparent at its edges, and a
 * narrower "core" polygon whose TOP-BOTTOM gradient fades to transparent at
 * the tip. Together they read as one soft shaft of light with no blurred
 * layer anywhere.
 *
 * Sound (plan build sheet, converted the same way): `swell_low` under the
 * wisp/early beam (167, stopping at 567), `chime_shimmer` one-shot exactly
 * when the beam reaches full brightness and the gold statuette appears (733 -
 * the reference's own audio note: "Onset f2624 ... on the frame the beam
 * reaches full brightness"), `fanfare_short` one-shot as the beam finishes
 * fading and the statuette is left standing (1367), `sparkle_bed` a soft
 * background shimmer from 1767 to the cut (4267).
 */

import React from 'react';
import type { ThrowableSpec } from '../spec';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import { preloadThrowableCues } from '../cues';
import './trophy.css';

export const trophySpec: ThrowableSpec = {
  id: 'trophy',
  name: 'Trophy',
  tier: 'free',
  category: 'cheers',
  spawn: 'avatar-corner',
  spawnMs: 233,
  flight: { ms: 133, mode: 'straight', upright: true },
  arrival: 'none',
  payload: { sizeU: 1.4, anchor: 'face', coversAvatar: false, ms: 4134 },
  beats: [
    { at: 133, marker: 'land' },
    { at: 167, marker: 'vanish' },
    { at: 400, marker: 'beam' },
    { at: 733, marker: 'reform' },
    { at: 1067, marker: 'fade' },
    { at: 1367, marker: 'set' },
    { at: 2433, marker: 'sparkle' },
    { at: 2767, marker: 'sparkle-2' },
    { at: 4267, marker: 'cut' },
  ],
  audio: [
    { at: 167, sample: 'swell_low', loopUntil: 567 },
    { at: 733, sample: 'chime_shimmer' },
    { at: 1367, sample: 'fanfare_short' },
    { at: 1767, sample: 'sparkle_bed', loopUntil: 4267 },
  ],
  reference: { video: 1, launchFrame: 2602, throw: 'THROW 12' },
};

preloadThrowableCues(trophySpec.audio.map((c) => c.sample));

/** The measured golds, the bronze base and the wisp/beam neutrals. */

/**
 * The trophy statuette: a small chalice on a plinth, ~28 units wide and
 * 90 tall (the measured 1/3 avatar wide, 0.9 avatar tall), drawn around
 * (0,0) with its base at y +45. `tone` picks gold (the flight, the landed
 * copy and the final reform) or a flat dark silhouette (forming inside the
 * beam before the gold takes over). `k` keeps the three copies' gradient
 * ids apart - all three can be in the DOM at once during the crossfade.
 */
function Trophy({ tone }: { uid: string; k: string; tone: 'gold' | 'dark' }) {
  return (
    <g opacity={tone === 'dark' ? 0.35 : 1}>
      <AtlasSprite src="trophy" rect={[20, 50, 590, 570]} x={-44} y={-45} width={88} height={90} />
    </g>
  );
}

/** The grey wisp: a single wavering stroke rising from where the statuette
 *  vanished. Its own group animates the rise and fade; the path is static. */
function Wisp() {
  return (
    <AtlasSprite src="trophy" rect={[640, 5, 590, 630]} x={-38} y={-45} width={76} height={90} />
  );
}

/**
 * The beam: a wide low-opacity halo (soft LEFT-RIGHT edges via a horizontal
 * gradient) behind a narrower bright core (soft TOP fade via a vertical
 * gradient), base at y +42 near the plinth, tip at y -96. No filter anywhere.
 */
function Beam(_: { uid: string }) {
  return (
    <AtlasSprite src="trophy" rect={[20, 635, 575, 619]} x={-55} y={-96} width={110} height={138} />
  );
}

/** A small four-point sparkle glint, drawn around (0,0). */
function SparkleGlint() {
  return (
    <AtlasSprite src="trophy" rect={[700, 660, 485, 545]} x={-8} y={-8} width={16} height={16} />
  );
}

function Projectile({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Trophy uid={uid} k="p" tone="gold" />
    </svg>
  );
}

function Payload({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      {/* 133 (+0): the statuette, arrived, whole - one frame, gone at 167. */}
      <g transform="translate(-30 20)">
        <g className="thr-trophy__landed">
          <Trophy uid={uid} k="a" tone="gold" />
        </g>
      </g>

      {/* 167-367 (+34..+234): the grey wisp climbs and fades where the
          statuette was. */}
      <g transform="translate(-30 20)">
        <g className="thr-trophy__wisp">
          <Wisp />
        </g>
      </g>

      {/* 400-1367 (+267..+1234): the beam, the silhouette that forms inside
          it, and the gold statuette that replaces the silhouette at full
          brightness. Sharing one local origin so the crossfade lines up. */}
      <g transform="translate(-30 20)">
        <g className="thr-trophy__beam">
          <Beam uid={uid} />
        </g>
        <g className="thr-trophy__silhouette">
          <Trophy uid={uid} k="s" tone="dark" />
        </g>
        <g className="thr-trophy__gold">
          <Trophy uid={uid} k="g" tone="gold" />
        </g>
        {/* 2433 / 2767 (+2300 / +2634): the two measured sparkle glints. */}
        <g transform="translate(6 -34)">
          <g
            className="thr-trophy__sparkle"
            style={
              {
                animationDelay: 'calc(2.3s * var(--animation-speed, 1))',
              } as React.CSSProperties
            }
          >
            <SparkleGlint />
          </g>
        </g>
        <g transform="translate(-9 -30)">
          <g
            className="thr-trophy__sparkle"
            style={
              {
                animationDelay: 'calc(2.634s * var(--animation-speed, 1))',
              } as React.CSSProperties
            }
          >
            <SparkleGlint />
          </g>
        </g>
      </g>
    </svg>
  );
}

export const trophyRig: ThrowableRig = { Projectile, Payload };
