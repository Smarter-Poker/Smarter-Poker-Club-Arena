/**
 * ===============================================================================
 *  CASH STACK - a bundle overshoots, bursts, and fountains as winged bills
 *  (phase 2, 2026-09-07)
 * ===============================================================================
 *
 * Measured off PB THROWABLE 2.MOV, THROW 5 ("make it rain", launch f865, 30
 * fps, target avatar 40 px wide, so 1 px = 2.5 units), see
 * docs/throwables/pokerbros-reference-video-2.md lines 334-379, and the build
 * sheet in docs/throwables/THROWABLES-PREMIUM-ANIMATION-PLAN.md ("cash_stack",
 * line ~696). THIS TABLE'S "L" IS THE LAUNCH FRAME (f865 = 0 ms) - the doc says
 * so explicitly ("Beat table (launch frame f865 = 0 ms)") - so every "ms"
 * below drops straight into `beats`/`audio` with nothing subtracted.
 *
 * ms from LAUNCH:
 *
 *   -100..-33  bundle of bills pops in on the hero's head and holds (~18x10 px,
 *              3-4 bills fanned, greenish grey (172,172,156))
 *   0-300      straight flight UP at ~21 px/frame, no spin, no scale
 *   333        bundle at the TOP of the target's head - LANDING
 *   367        the bundle OVERSHOOTS above the head, partly off the avatar
 *   400-667    it FALLS BACK with ease-out and settles centred on the face,
 *              slightly larger (~22 px)
 *   700-867    BURST: single bills peel off the bundle and rise
 *   900-3000   MONEY CLOUD: 10-15 individual winged bills fountain in a
 *              ~1.75 u cloud from the chin to well above the head, fluttering,
 *              drifting, the avatar and the "Fold" tag partly visible between
 *              them
 *   3033-3233  the cloud THINS: fewer bills, the remaining ones rise off the top
 *   3267-3500  the last 2-3 bills exit upward and fade
 *   3533       seat CLEAN, no residue
 *
 * Everything in the Payload is `animation-delay` from LANDING (333), so the
 * catalogue's "at" minus 333: overshoot 34, settle 334, burst 367, cloud 567,
 * thin 2700, exit 2934, cut 3200. The comments keep both numbers.
 *
 * Sound (contract cue table + build sheet): `thump_soft` at 333 (the bundle
 * reaching the top of the head, matching the raw capture's own peak rms at
 * f877); three `tick_settle` cues during the settle (raw capture: "three
 * faint high ticks... during f881-885" = 533-667 - individual tick frames are
 * NOT separately given, so 533/600/667 are CHOSEN, evenly spread across that
 * window, not read one by one); `cash_register_cascade` at 700 (the burst
 * frame, matching the raw capture exactly), looping to 3500 - one beat before
 * the cut. The raw capture's own cascade actually runs to ~4000 (100 frames,
 * ending after the next dialog has already opened), but this item's own life
 * ends at 3533, so the loop is capped at the last visual beat (`exit`, 3267)
 * rounded up to the cut-adjacent 3500 rather than the raw tail: A NUMBER
 * CHOSEN, NOT READ, so the cascade never keeps playing after the seat is
 * already clean.
 */

import type React from 'react';
import type { ThrowableSpec } from '../spec';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import { preloadThrowableCues } from '../cues';
import './cash_stack.css';
import { AtlasSprite } from '../AtlasSprite';

export const cashStackSpec: ThrowableSpec = {
  id: 'cash_stack',
  name: 'Cash Stack',
  tier: 'vip',
  category: 'cheers',
  spawn: 'avatar-corner',
  spawnMs: 100,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'none',
  payload: { sizeU: 1.75, anchor: 'face', coversAvatar: false, ms: 3200 },
  beats: [
    { at: 333, marker: 'land' },
    { at: 367, marker: 'overshoot' },
    { at: 667, marker: 'settle' },
    { at: 700, marker: 'burst' },
    { at: 900, marker: 'cloud' },
    { at: 3033, marker: 'thin' },
    { at: 3267, marker: 'exit' },
    { at: 3533, marker: 'cut' },
  ],
  audio: [
    { at: 333, sample: 'thump_soft' },
    { at: 533, sample: 'tick_settle' },
    { at: 600, sample: 'tick_settle' },
    { at: 667, sample: 'tick_settle' },
    { at: 700, sample: 'cash_register_cascade', loopUntil: 3500 },
  ],
  reference: { video: 2, launchFrame: 865, throw: 'THROW 5' },
};

preloadThrowableCues(cashStackSpec.audio.map((c) => c.sample));

/** The measured greenish-grey bundle, and the money-cloud bills' green. */

/**
 * The bundle: 3 overlapping bill-shaped rectangles fanned, 45x25 units in
 * flight (the measured 18x10 px on a 40 px avatar), greenish grey. `k` keeps
 * the projectile's and the payload's gradients apart.
 */
function Bundle(_: { uid: string; k: string }) {
  return (
    <AtlasSprite
      src="cash_stack"
      rect={[23, 98, 627, 513]}
      x={-40}
      y={-32}
      width={80}
      height={64}
    />
  );
}

/**
 * One flying bill: a small currency rectangle with a seal, and two white
 * wings (the "money with wings" shape) grouped so they flap as one. Drawn
 * around (0,0), 35x20 units (the measured 14x8 px).
 */
function Bill(_: { uid: string }) {
  return (
    <g>
      <g className="thr-cash_stack__wing">
        <AtlasSprite
          src="cash_stack"
          rect={[650, 748, 245, 285]}
          x={-36}
          y={-24}
          width={22}
          height={30}
        />
        <AtlasSprite
          src="cash_stack"
          rect={[1065, 685, 179, 295]}
          x={14}
          y={-24}
          width={18}
          height={30}
        />
      </g>
      <AtlasSprite
        src="cash_stack"
        rect={[665, 185, 563, 303]}
        x={-18}
        y={-10}
        width={36}
        height={20}
      />
    </g>
  );
}

/** Twelve bills: [x, y, rotationDeg, scale, appearDelayMs (from landing),
 *  driftPhaseMs]. Fixed, never random, so the darkroom photographs the same
 *  cloud twice. Positions spread across the measured 1.75 u cloud (chin to
 *  well above the head); delays spread across the burst-into-cloud window
 *  (367-2233 ms from landing, or 700-2566 from launch), all well clear
 *  of the +2700 ms thinning beat. */
const BILLS: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [-8, 10, -15, 0.85, 367, 0],
  [14, -6, 20, 0.95, 433, 60],
  [-26, -22, -28, 1.05, 533, 120],
  [28, 8, 12, 0.9, 633, 180],
  [-44, -38, -8, 1.1, 733, 240],
  [38, -52, 24, 0.8, 883, 300],
  [-58, -12, -18, 1.0, 1033, 360],
  [50, -74, 14, 0.95, 1233, 20],
  [-30, -96, -26, 1.05, 1483, 80],
  [62, 2, 6, 0.85, 1733, 140],
  [-68, -56, -16, 1.1, 1983, 200],
  [10, -114, 10, 0.9, 2233, 260],
];

function Projectile({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Bundle uid={uid} k="p" />
    </svg>
  );
}

function Payload({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      {/* 333 (+0): the bundle at the top of the head, overshoots at 367
          (+34), falls back and settles centred by 667 (+334). Fades out as
          it bursts, 700-867 (+367..+534). */}
      <g className="thr-cash_stack__bundle">
        <g className="thr-cash_stack__bundle-fade">
          <Bundle uid={uid} k="a" />
        </g>
      </g>

      {/* 900-3000 (+567..+2667): the money cloud - twelve winged bills, each
          on its own appear delay, each with a continuous flutter/drift.
          900-3233 wraps the whole set in the thin-and-exit fade (+2700..
          +3200), so the cloud dies together rather than each bill vanishing
          on its own unmeasured cue. */}
      <g className="thr-cash_stack__cloud-fade">
        {BILLS.map(([x, y, rot, scale, delayMs, phaseMs], i) => (
          <g key={i} transform={`translate(${x} ${y}) rotate(${rot}) scale(${scale})`}>
            <g
              className="thr-cash_stack__bill"
              style={
                {
                  animationDelay: `calc(${(delayMs / 1000).toFixed(3)}s * var(--animation-speed, 1))`,
                } as React.CSSProperties
              }
            >
              <g
                className="thr-cash_stack__drift"
                style={
                  {
                    animationDelay: `calc(${(phaseMs / 1000).toFixed(3)}s * var(--animation-speed, 1))`,
                  } as React.CSSProperties
                }
              >
                <Bill uid={uid} />
              </g>
            </g>
          </g>
        ))}
      </g>
    </svg>
  );
}

export const cashStackRig: ThrowableRig = { Projectile, Payload };
