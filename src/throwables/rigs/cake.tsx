/**
 * ===============================================================================
 *  CAKE - a press, a squash, a plate that turns and slides, a smear that stays
 *  (phase 2, 2026-09-07)
 * ===============================================================================
 *
 * Measured off PB THROWABLE 2.MOV, Throw 2 (launch f293, 30 fps, target avatar
 * 40 px wide, so 1 px = 2.5 units), see
 * docs/throwables/pokerbros-reference-video-2.md lines 139-198 and the build
 * sheet at docs/throwables/THROWABLES-PREMIUM-ANIMATION-PLAN.md line 670.
 *
 * L IS THE LAUNCH FRAME HERE. The doc's own header says "Beat table (launch
 * frame f293 = 0 ms)" and its spawn rows are already NEGATIVE (f286 = -233),
 * exactly the shape spec.ts expects (spawn before launch). No offset needed -
 * unlike trophy (video 1, THROW 12), where L was the spawn frame. ms from
 * LAUNCH:
 *
 *   -233..-33  the cake pops in on the thrower's head: a two-tier pink/white
 *              cake on a plate, berries on top, 0.4 u across
 *   0-133      straight flight at ~21 px/frame; no spin, no scale change
 *   133        CONTACT: the cake reaches the target's face, intact
 *   167-233    the cake PRESSES up 3 px/frame for three frames (a "press"
 *              before it breaks)
 *   267        SQUASH: the cake tips forward, cream spreads
 *   300        the PLATE turns face-on: a solid white disc 0.55 u across,
 *              centred on the face, pink/white splatter bursting around its
 *              top edge; a strawberry sits at the crown from this frame on
 *   300-500    the plate holds
 *   500-967    the plate SLIDES DOWN the face at ~1 px/frame
 *   1000       the plate fades (~50% alpha)
 *   1033       the plate is gone: residue = a cream smear over the upper 60%
 *              of the face, the strawberry still at the crown
 *   1033-3500  RESIDUE, static
 *   3500       CUT
 *
 * Everything in the Payload is `animation-delay` from LANDING (133), so the
 * catalogue's "at" minus 133: press 34, squash 134, plate 167, slide 367,
 * fade 867, residue 900. The comments keep both numbers.
 *
 * THE PLATE'S SLIDE DISTANCE: the table's tracked centre moves y267->280 (13
 * px = 32.5 units); the prose gives "1 px/frame for 470 ms" (~14 px = 35
 * units). The two do not quite agree - a CHOSEN number, 33 units, splits the
 * difference rather than picking one measurement over the other.
 *
 * Sound (build sheet): `whoosh_low` on the approach (the press, 167),
 * `splat_heavy` exactly on the squash frame (267 - the reference's own audio
 * note: "Lands EXACTLY on the visual squash frame f301, offset 0"),
 * `splat_wet_small` as the plate starts sliding (500 - the reference records
 * it 3 frames later, but the contract schedules every cue on the VISUAL beat,
 * not the recording's latency).
 */

import type { ThrowableSpec } from '../spec';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import { preloadThrowableCues } from '../cues';
import './cake.css';

export const cakeSpec: ThrowableSpec = {
  id: 'cake',
  name: 'Cake',
  tier: 'vip',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 233,
  flight: { ms: 133, mode: 'straight', upright: true },
  arrival: 'none',
  payload: { sizeU: 0.65, anchor: 'face', coversAvatar: true, ms: 3367 },
  beats: [
    { at: 133, marker: 'land' },
    { at: 167, marker: 'press' },
    { at: 267, marker: 'squash' },
    { at: 300, marker: 'plate' },
    { at: 500, marker: 'slide' },
    { at: 1000, marker: 'fade' },
    { at: 1033, marker: 'residue' },
    { at: 3500, marker: 'cut' },
  ],
  audio: [
    { at: 167, sample: 'whoosh_low' },
    { at: 267, sample: 'splat_heavy' },
    { at: 500, sample: 'splat_wet_small' },
  ],
  reference: { video: 2, launchFrame: 293, throw: 'Throw 2' },
};

preloadThrowableCues(cakeSpec.audio.map((c) => c.sample));

/** The measured pinks, the plate white and the strawberry red. */
const CAKE_PINK = '#f6a4c0';
const CAKE_PINK_DEEP = '#e06f95';
const CAKE_WHITE = '#fff7ef';
const CAKE_CREAM = '#fff0e0';
const PLATE_WHITE = '#ffffff';
const PLATE_EDGE = '#e6e0d6';
const BERRY_RED = '#c81e3a';
const BERRY_LEAF = '#3c7a2e';
const SPLATTER_PINK = '#f2a0bb';

/**
 * The intact cake: a two-tier pink/white cake on a plate, 44 units across
 * and 62 tall, drawn with the plate's centre at (0, 20). Used for the flying
 * projectile and the payload's press-and-squash group.
 */
function Cake({ uid, k }: { uid: string; k: string }) {
  const g = (n: string) => `thr-cake-${n}-${uid}-${k}`;
  return (
    <g>
      <defs>
        <linearGradient id={g('bottom')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={CAKE_PINK} />
          <stop offset="100%" stopColor={CAKE_PINK_DEEP} />
        </linearGradient>
        <linearGradient id={g('cream')} x1="0" y1="0" x2="1" y2="0.25">
          <stop offset="0%" stopColor="#d4ad9c" />
          <stop offset="28%" stopColor={CAKE_WHITE} />
          <stop offset="58%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#dcb8b1" />
        </linearGradient>
        <radialGradient id={g('berry')} cx="0.3" cy="0.2" r="0.85">
          <stop offset="0%" stopColor="#ff9b99" />
          <stop offset="35%" stopColor="#ed3a54" />
          <stop offset="100%" stopColor="#7e102c" />
        </radialGradient>
      </defs>
      {/* the plate under the cake */}
      <ellipse
        cx="0"
        cy="20"
        rx="24"
        ry="6"
        fill={PLATE_WHITE}
        stroke={PLATE_EDGE}
        strokeWidth="1"
      />
      <ellipse cx="0" cy="20" rx="20.5" ry="4" fill="#b88c9b" opacity="0.5" />
      <path d="M -22 22 Q 0 29 22 22" fill="none" stroke="#fff" strokeWidth="1.2" />
      {/* bottom tier */}
      <path
        d="M -20 17 L -20 3 Q 0 -5 20 3 L 20 17 Q 0 25 -20 17 Z"
        fill={`url(#${g('bottom')})`}
      />
      <path
        d="M -19 11 Q 0 18 19 11 M -19 15 Q 0 22 19 15"
        fill="none"
        stroke="#b64a75"
        strokeWidth="0.7"
        opacity="0.6"
      />
      <path
        d="M -20 3 Q 0 -5 20 3 L 20 7 Q 17 12 15 7 Q 12 5 11 10 Q 8 15 6 9 Q 3 6 1 10 Q -3 14 -5 8 Q -8 5 -11 9 Q -15 12 -16 7 L -20 6 Z"
        fill={`url(#${g('cream')})`}
      />
      {/* top tier */}
      <path
        d="M -13 0 L -13 -14 Q 0 -21 13 -14 L 13 0 Q 0 6 -13 0 Z"
        fill={`url(#${g('cream')})`}
      />
      <ellipse cx="0" cy="-14" rx="13" ry="4.5" fill={CAKE_WHITE} stroke="#fff" strokeWidth="0.8" />
      <path
        d="M -11 -11 Q 0 -7 11 -11 M -11 -5 Q 0 -1 11 -5"
        fill="none"
        stroke="#d59caa"
        strokeWidth="0.7"
        opacity="0.7"
      />
      {/* a frosting drip line between the tiers */}
      <path
        d="M -16 0 Q -8 3, 0 0 Q 8 -3, 16 0"
        fill="none"
        stroke={CAKE_CREAM}
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.8"
      />
      {/* three berries on top */}
      {[-6, 1, 7].map((x, i) => (
        <g key={x} transform={`translate(${x} ${i === 1 ? -20 : -18})`}>
          <path
            d="M -3 -2 Q 0 -5 3 -2 C 5 1 1 5 0 5 C -2 4 -5 0 -3 -2 Z"
            fill={`url(#${g('berry')})`}
          />
          <path d="M -2 -2 L -4 -4 L -1 -3 L 0 -6 L 1 -3 L 4 -4 L 2 -2 Z" fill={BERRY_LEAF} />
          <path
            d="M -1 0 l 0.3 0.7 M 1 2 l 0.3 0.7"
            stroke="#ffd7a1"
            strokeWidth="0.6"
            strokeLinecap="round"
          />
        </g>
      ))}
    </g>
  );
}

/** The strawberry that stays at the crown once the plate reveals, apart from
 *  the cake sprite so it can persist after the cake and the plate are gone. */
function Strawberry({ uid }: { uid: string }) {
  const berry = `thr-cake-crown-berry-${uid}`;
  return (
    <g>
      <defs>
        <radialGradient id={berry} cx="0.3" cy="0.2" r="0.8">
          <stop offset="0%" stopColor="#ffb09b" />
          <stop offset="35%" stopColor={BERRY_RED} />
          <stop offset="100%" stopColor="#730e29" />
        </radialGradient>
      </defs>
      <path
        d="M 0 -6 C 6 -6, 8 -1, 5 4 C 3 7, -3 7, -5 4 C -8 -1, -6 -6, 0 -6 Z"
        fill={`url(#${berry})`}
      />
      <circle cx="-2" cy="-2" r="0.7" fill="#7d0f20" opacity="0.6" />
      <circle cx="2" cy="0.5" r="0.7" fill="#7d0f20" opacity="0.6" />
      <circle cx="0" cy="3" r="0.7" fill="#7d0f20" opacity="0.6" />
      <path d="M -3 -6 L -1 -9.5 L 1 -6.5 L 3 -9.5 L 1.5 -6 Z" fill={BERRY_LEAF} />
      <path
        d="M -4 -3 Q -5 0 -3 2"
        fill="none"
        stroke="#ffcdbe"
        strokeWidth="0.8"
        strokeLinecap="round"
      />
    </g>
  );
}

function Projectile({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Cake uid={uid} k="p" />
    </svg>
  );
}

function Payload({ uid }: RigProps) {
  const g = (n: string) => `thr-cake-${n}-${uid}`;
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      {/* 133-300 (+0..+167): the cake, intact, presses up, then tips and
          fades as the plate takes over. */}
      <g className="thr-cake__cake">
        <Cake uid={uid} k="a" />
      </g>

      {/* 300 (+167): the plate turns face-on, holds, slides down the face
          and fades by 1033. */}
      <g className="thr-cake__plate">
        <defs>
          <radialGradient id={g('plate')} cx="0.4" cy="0.35" r="0.75">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="70%" stopColor={PLATE_WHITE} />
            <stop offset="100%" stopColor={PLATE_EDGE} />
          </radialGradient>
        </defs>
        <circle
          cx="0"
          cy="-5"
          r="27.5"
          fill={`url(#${g('plate')})`}
          stroke={PLATE_EDGE}
          strokeWidth="1"
        />
        <circle cx="0" cy="-5" r="23.5" fill="none" stroke="#c9bfc1" strokeWidth="0.9" />
        <path
          d="M -19 -17 A 23 23 0 0 1 17 -20"
          fill="none"
          stroke="#fff"
          strokeWidth="2"
          strokeLinecap="round"
        />
        {/* pink/white splatter bursting around the plate's top edge */}
        <ellipse
          cx="-16"
          cy="-27"
          rx="6"
          ry="3.5"
          transform="rotate(-25 -16 -27)"
          fill={SPLATTER_PINK}
          opacity="0.85"
        />
        <ellipse
          cx="-2"
          cy="-31"
          rx="5"
          ry="3"
          transform="rotate(5 -2 -31)"
          fill={CAKE_CREAM}
          opacity="0.9"
        />
        <ellipse
          cx="14"
          cy="-26"
          rx="5.5"
          ry="3.2"
          transform="rotate(30 14 -26)"
          fill={SPLATTER_PINK}
          opacity="0.8"
        />
        <ellipse
          cx="22"
          cy="-14"
          rx="3.6"
          ry="2.4"
          transform="rotate(55 22 -14)"
          fill={CAKE_CREAM}
          opacity="0.75"
        />
        <ellipse
          cx="-22"
          cy="-12"
          rx="3.6"
          ry="2.4"
          transform="rotate(-55 -22 -12)"
          fill={SPLATTER_PINK}
          opacity="0.75"
        />
      </g>

      {/* 1033 (+900): the residue - a cream smear over the upper face. */}
      <g className="thr-cake__residue">
        <path
          d="M -30 -38 C -34 -14, -24 6, -8 10 C 8 14, 26 4, 28 -18 C 30 -34, 14 -42, -2 -40 C -14 -39, -26 -46, -30 -38 Z"
          fill={CAKE_CREAM}
          opacity="0.92"
        />
        <path
          d="M -20 -30 Q -6 -20, 6 -30"
          fill="none"
          stroke={SPLATTER_PINK}
          strokeWidth="2.4"
          strokeLinecap="round"
          opacity="0.6"
        />
        <path
          d="M -14 -14 Q 0 -6, 16 -12"
          fill="none"
          stroke={SPLATTER_PINK}
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.5"
        />
      </g>

      {/* 300 (+167): the strawberry at the crown - stays through the slide
          and into the residue, so it is drawn AFTER the smear rather than
          under it. The measured position lives on a PLAIN WRAPPER: a CSS
          keyframe that writes `transform` REPLACES an SVG transform attribute
          on the same element, so a class that animates scale here would drop
          the translate and put the berry in the middle of the face. */}
      <g transform="translate(2 -46)">
        <g className="thr-cake__berry">
          <Strawberry uid={uid} />
        </g>
      </g>
    </svg>
  );
}

export const cakeRig: ThrowableRig = { Projectile, Payload };
