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
const BUNDLE_LIGHT = '#d6d7c7';
const BUNDLE_MID = '#acac9c';
const BUNDLE_DARK = '#7d7f6f';
const BILL_LIGHT = '#8fd39e';
const BILL_GREEN = '#4f9a5c';
const BILL_DARK = '#2e6b3a';
const BILL_SEAL = '#eef7ec';
const WING_WHITE = '#ffffff';
const WING_EDGE = '#d8e6da';

/**
 * The bundle: 3 overlapping bill-shaped rectangles fanned, 45x25 units in
 * flight (the measured 18x10 px on a 40 px avatar), greenish grey. `k` keeps
 * the projectile's and the payload's gradients apart.
 */
function Bundle({ uid, k }: { uid: string; k: string }) {
  const g = (n: string) => `thr-cash_stack-${n}-${uid}-${k}`;
  return (
    <g>
      <defs>
        <linearGradient id={g('bundle')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={BUNDLE_LIGHT} />
          <stop offset="100%" stopColor={BUNDLE_DARK} />
        </linearGradient>
      </defs>
      <g transform="rotate(-8)">
        <rect
          x="-20"
          y="-11"
          width="40"
          height="22"
          rx="2"
          fill={BUNDLE_MID}
          stroke={BUNDLE_DARK}
          strokeWidth="1"
        />
      </g>
      <g transform="rotate(2)">
        <rect
          x="-21"
          y="-12"
          width="42"
          height="23"
          rx="2"
          fill={`url(#${g('bundle')})`}
          stroke={BUNDLE_DARK}
          strokeWidth="1"
        />
        <path
          d="M -21 -4 L 21 -4 M -21 4 L 21 4"
          stroke={BUNDLE_DARK}
          strokeWidth="0.7"
          opacity="0.4"
        />
      </g>
      <g transform="rotate(10)">
        <path d="M -19 -10 L 19 -10 L 20 8 L 18 12 L -19 12 Z" fill={BUNDLE_DARK} />
        <path d="M -18 9 L 18 9 M -18 10.5 L 18 10.5" stroke={BUNDLE_LIGHT} strokeWidth="0.6" />
        <rect
          x="-19"
          y="-10"
          width="38"
          height="20"
          rx="1.5"
          fill={BUNDLE_LIGHT}
          stroke="#f3f1de"
          strokeWidth="0.7"
        />
        <rect
          x="-16.5"
          y="-7.5"
          width="33"
          height="15"
          rx="1"
          fill="none"
          stroke={BUNDLE_DARK}
          strokeWidth="0.65"
        />
        <ellipse
          cx="0"
          cy="0"
          rx="6"
          ry="7"
          fill={BUNDLE_MID}
          stroke={BUNDLE_DARK}
          strokeWidth="0.7"
        />
        <path d="M -3 4 Q -4 1 -1 0 Q -4 -4 0 -5 Q 4 -4 2 0 Q 5 1 4 4 Z" fill={BUNDLE_DARK} />
        <path
          d="M -14 -4 h 5 M -14 -2 h 4 M -14 3 h 5 M 9 -4 h 5 M 10 -2 h 4 M 9 3 h 5"
          fill="none"
          stroke={BUNDLE_DARK}
          strokeWidth="0.6"
        />
        <path
          d="M 5 -10 L 10 -10 L 10 10 L 5 10 Z"
          fill="#ead7ad"
          stroke="#a88756"
          strokeWidth="0.6"
        />
        <path d="M 6 -9 L 6 9" stroke="#fff1cf" strokeWidth="0.8" />
      </g>
    </g>
  );
}

/**
 * One flying bill: a small currency rectangle with a seal, and two white
 * wings (the "money with wings" shape) grouped so they flap as one. Drawn
 * around (0,0), 35x20 units (the measured 14x8 px).
 */
function Bill({ uid }: { uid: string }) {
  const billBody = `thr-cash_stack-bill-${uid}-body`;
  return (
    <g>
      {/* the wings, grouped so `.thr-cash_stack__wing` flaps both together */}
      <g className="thr-cash_stack__wing">
        <path
          d="M -16 3 C -21 3 -24 -1 -29 -6 Q -31 -9 -28 -8 L -21 -3 L -25 -9 Q -26 -12 -23 -10 L -18 -5 L -20 -11 Q -20 -14 -18 -11 Q -14 -4 -16 3 Z"
          fill={WING_WHITE}
          stroke={WING_EDGE}
          strokeWidth="0.5"
        />
        <path
          d="M 16 3 C 21 3 24 -1 29 -6 Q 31 -9 28 -8 L 21 -3 L 25 -9 Q 26 -12 23 -10 L 18 -5 L 20 -11 Q 20 -14 18 -11 Q 14 -4 16 3 Z"
          fill={WING_WHITE}
          stroke={WING_EDGE}
          strokeWidth="0.5"
        />
        <path
          d="M -17 1 Q -21 -1 -25 -5 M -17 -1 L -22 -7 M 17 1 Q 21 -1 25 -5 M 17 -1 L 22 -7"
          fill="none"
          stroke="#a7c4b6"
          strokeWidth="0.6"
        />
      </g>
      <path d="M -17 6 L 18 6 L 17 12 L -16 11 Z" fill="#24573a" />
      <rect
        x="-17.5"
        y="-10"
        width="35"
        height="20"
        rx="2"
        fill={`url(#${billBody})`}
        stroke={BILL_DARK}
        strokeWidth="0.8"
      />
      <rect
        x="-15"
        y="-7.5"
        width="30"
        height="15"
        rx="1"
        fill="none"
        stroke="#d1efd1"
        strokeWidth="0.65"
      />
      <ellipse
        cx="0"
        cy="0"
        rx="5"
        ry="6.4"
        fill={BILL_SEAL}
        stroke={BILL_DARK}
        strokeWidth="0.4"
      />
      <path
        d="M -2.8 4 Q -3.5 1 -0.8 0 Q -3 -3.5 0 -4.5 Q 3.5 -3.5 1.8 0 Q 4 1.5 3 4 Z"
        fill={BILL_DARK}
        opacity="0.8"
      />
      <path
        d="M -13 -2 h 5 M -13 0 h 4 M -13 2 h 5 M 8 -2 h 5 M 9 0 h 4 M 8 2 h 5"
        stroke={BILL_DARK}
        strokeWidth="0.5"
        opacity="0.8"
      />
      <path d="M -16 -9 L 15 -9" stroke="#d9ffe1" strokeWidth="0.8" />
      <path
        d="M -14 -6 L -10 -6 M -14 6 L -10 6 M 14 -6 L 10 -6 M 14 6 L 10 6"
        stroke={BILL_LIGHT}
        strokeWidth="1"
        opacity="0.7"
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
  const billBody = `thr-cash_stack-bill-${uid}-body`;
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={billBody} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={BILL_LIGHT} />
          <stop offset="100%" stopColor={BILL_GREEN} />
        </linearGradient>
      </defs>

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
