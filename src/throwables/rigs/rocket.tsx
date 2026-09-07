/**
 * ===============================================================================
 *  ROCKET (AIRSTRIKE) - a red reticle that flies, hunts, and locks; a missile
 *  that dives from off-screen; a fireball that swallows the seat; a mushroom
 *  cloud that clears it (phase 2, 2026-09-07)
 * ===============================================================================
 *
 * Measured off PB THROWABLE 2.MOV, Throw 3 (reticle launch f446, 30 fps,
 * target avatar 40 px wide, so 1 px = 2.5 units), see
 * docs/throwables/pokerbros-reference-video-2.md lines 199-266 and the build
 * sheet at docs/throwables/THROWABLES-PREMIUM-ANIMATION-PLAN.md line 678.
 *
 * VIDEO 2's `L` IS THE LAUNCH FRAME - no offset needed. THE PROJECTILE IS THE
 * RETICLE, not the missile: the missile is not thrown, it dives in from off
 * the top of the payload box partway through the performance, so it is drawn
 * entirely inside the Payload. ms from LAUNCH:
 *
 *   -300..-33  the reticle fades in on the THROWER's head and holds: a red
 *              ~14 px circle + centre dot + 4 tick marks (N/E/S/W), pure red
 *              (168,12,30), no rotation - all of it player-generic spawn, no
 *              rig CSS of its own (see cake.tsx / bomb.tsx precedent)
 *   0-333      LAUNCH, straight flight, ~21 px/frame, no scale, no spin
 *   333        ARRIVES on the target's face - this is LANDING
 *   333-1633   LOCK-ON (1.3 s): the reticle stays ~14 px but WANDERS - centre
 *              x drifts 108->104->113->109 (roughly one slow left-right sweep
 *              per 833 ms), +-2 px in y. Colour constant red.
 *   1633-1700  LOCK: scales up ~2x
 *   1700-1833  keeps growing to ~3.5x and FADES. Gone at 1833.
 *   1833-2267  TARGET CLEAN: a deliberate 13-frame pause, nothing on screen
 *              (the missile whistle is already playing under it)
 *   2267       MISSILE appears at the very top edge of the rig box, tiny
 *              (~4 px), nose down, a small flame above it
 *   2267-2567  dives straight DOWN (x constant), growing with perspective to
 *              ~14 px body / ~22 px incl. the trailing exhaust flame. Red
 *              body, white stripe, dark nose.
 *   2567       HIT: nose at the avatar centre; a dull red glow blooms BEHIND
 *              the missile (missile still drawn on top)
 *   2633       missile gone; a small yellow flame (~20 px) at the base
 *   2633-2733  flame grows: 25 px then 35 px, pure yellow (247,243,74)
 *   2733-2867  FULL FIREBALL: 1.3x avatar width, extending well above the
 *              avatar, solid yellow with a wavy spiky top - avatar covered
 *   2867-3033  turns orange with a dark core, then orange-red with dark ember
 *              blotches, shrinking a little
 *   3033-3700  SMOKE: a khaki (110,85,60) mushroom cloud - cap above, stem
 *              over the avatar - slowly swells and drifts left then back
 *   3700       the smoke pops out in one frame (~40% alpha)
 *   3733       seat CLEAN, no residue
 *
 * Everything in the Payload is `animation-delay` from LANDING (333), so the
 * catalogue's "at" minus 333: lock 1300, reticle-gone 1500, missile 1934,
 * hit 2234, flame 2300, fireball 2400, orange 2534, smoke 2700, cut 3400.
 * The comments keep both numbers, and every keyframe stop is annotated with
 * the catalogue's ms-from-launch, not the delay.
 *
 * UNITS: 100 viewBox units = 1 avatar width, and video 2's target avatar was
 * ~40 px wide, so measured pixels x 2.5 = units (src/throwables/rig.ts,
 * docs/throwables/PHASE2-RIG-CONTRACT.md). The fireball's 53x75 px reads as
 * 132x187 units; the smoke's 48x65 px as 120x162; the reticle's 14 px as 35.
 *
 * TWO CHOSEN NUMBERS, flagged rather than quietly picked:
 *
 *   1. The wander table gives explicit waypoints only to f480 (1133 ms) and
 *      then says "roughly one slow left-right sweep per 25 frames" through
 *      1633. A static hold for the remaining 500 ms would read as the jitter
 *      stopping early, so ONE more waypoint is added at 1367 ms (a smaller
 *      continuation of the same sweep) rather than leaving that span flat.
 *      It is an interpolation of the doc's own description, not a new motion.
 *   2. The doc gives no RGB for the missile body ("red body, white stripe,
 *      dark nose") or for the fireball/ember/smoke beyond the two pure colours
 *      it does measure (yellow 247,243,74; khaki 110,85,60, both used
 *      verbatim below). The remaining hex values - the missile's red, the
 *      exhaust's orange, the fireball's gradient edge, the ember's blotches -
 *      are chosen to read clearly at reticle/missile/avatar scale, not
 *      measured.
 *
 * Sound (build sheet + the doc's own audio note): `lock_beep` at the three
 * measured beep frames (f463/f479/f495 = 567/1100/1633), `lock_confirm` at
 * the doubled confirmation pair (f497/f502 = 1700/1867), `missile_whistle`
 * at its own start (f509 = 2100, five frames before the missile is visible -
 * scheduled on ITS OWN visual cue, the whistle, not the missile's entrance),
 * `explosion_boom` at the start of the measured boom transient (f534 = 2933).
 */

import type { ThrowableSpec } from '../spec';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import { preloadThrowableCues } from '../cues';
import './rocket.css';

export const rocketSpec: ThrowableSpec = {
  id: 'rocket',
  name: 'Rocket',
  tier: 'premium',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 300,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'none',
  payload: { sizeU: 1.3, anchor: 'face', coversAvatar: true, ms: 3400 },
  beats: [
    { at: 333, marker: 'land' },
    { at: 333, marker: 'lock-on' },
    { at: 1633, marker: 'lock' },
    { at: 1833, marker: 'reticle-gone' },
    { at: 2267, marker: 'missile' },
    { at: 2567, marker: 'hit' },
    { at: 2633, marker: 'flame' },
    { at: 2733, marker: 'fireball' },
    { at: 2867, marker: 'orange' },
    { at: 3033, marker: 'smoke' },
    { at: 3733, marker: 'cut' },
  ],
  audio: [
    { at: 567, sample: 'lock_beep' },
    { at: 1100, sample: 'lock_beep' },
    { at: 1633, sample: 'lock_beep' },
    { at: 1700, sample: 'lock_confirm' },
    { at: 1867, sample: 'lock_confirm' },
    { at: 2100, sample: 'missile_whistle' },
    { at: 2933, sample: 'explosion_boom' },
  ],
  reference: { video: 2, launchFrame: 446, throw: 'Throw 3' },
};

preloadThrowableCues(rocketSpec.audio.map((c) => c.sample));

/** The reticle's pure measured red (168,12,30). */
const RETICLE_RED = '#a80c1e';
/** The missile: not measured as RGB by the reference ("red body, white
 *  stripe, dark nose"), so these are chosen to read clearly at 30-50 units. */
const MISSILE_RED = '#cf2432';
const MISSILE_RED_DARK = '#8f0f1c';
const MISSILE_WHITE = '#f5f2ea';
const MISSILE_NOSE = '#26262b';
const MISSILE_FIN = '#3c3c42';
const EXHAUST_OUTER = '#ff8a1f';
const EXHAUST_INNER = '#fff2b0';
/** The dull red hit glow, "behind the missile". */
const HIT_GLOW = '#c81e2a';
/** The flame's and fireball's pure measured yellow (247,243,74). */
const PURE_YELLOW = '#f7f34a';
/** A deeper gold, chosen for shading and gradient edges - not measured. */
const GOLD_DEEP = '#ffb703';
const FIREBALL_CORE = '#fffbe0';
const EMBER_ORANGE = '#ff8a1f';
const EMBER_ORANGE_DEEP = '#c1440e';
const EMBER_DARK = '#4a2008';
/** The smoke's pure measured khaki (110,85,60). */
const SMOKE_KHAKI = '#6e553c';
const SMOKE_KHAKI_LIGHT = '#8f7154';

/**
 * ONE flame-tongue silhouette, tip pointing up from its own base at (0, 0-5).
 * Reused at small scale (3 copies) for the growing flame and at large scale
 * (7 copies) for the fireball's spiky crown - the same technique fireworks.tsx
 * uses one PARTICLES table for six different bursts.
 */
const FLAME_TONGUE_PATH =
  'M -6 2 Q -9 -8 -4 -20 Q -1 -26 0 -30 Q 1 -26 4 -20 Q 9 -8 6 2 Q 3 5 0 5 Q -3 5 -6 2 Z';

/**
 * The reticle: an outline ring, a centre dot and four N/E/S/W tick marks,
 * pure red, with a faint glow behind it. Shared by the flying projectile
 * (`k="p"`) and the payload's lock-on copy (`k="a"`) - `k` keeps their glow
 * gradients apart since a multi-table view can mount several throws at once.
 */
function Reticle({ uid, k }: { uid: string; k: string }) {
  const g = (n: string) => `thr-rocket-${n}-${uid}-${k}`;
  return (
    <g>
      <defs>
        <radialGradient id={g('glow')} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor={RETICLE_RED} stopOpacity="0.35" />
          <stop offset="100%" stopColor={RETICLE_RED} stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* a faint glow behind the ring */}
      <circle cx="0" cy="0" r="26" fill={`url(#${g('glow')})`} />
      {/* the outer ring, ~35 units (14 px) across */}
      <circle cx="0" cy="0" r="17" fill="none" stroke={RETICLE_RED} strokeWidth="2.4" />
      {/* the centre dot */}
      <circle cx="0" cy="0" r="2.6" fill={RETICLE_RED} />
      {/* four tick marks, N / E / S / W */}
      <line
        x1="0"
        y1="-17"
        x2="0"
        y2="-25"
        stroke={RETICLE_RED}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <line
        x1="17"
        y1="0"
        x2="25"
        y2="0"
        stroke={RETICLE_RED}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <line
        x1="0"
        y1="17"
        x2="0"
        y2="25"
        stroke={RETICLE_RED}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <line
        x1="-17"
        y1="0"
        x2="-25"
        y2="0"
        stroke={RETICLE_RED}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </g>
  );
}

/**
 * The missile: nose cone at the local origin (0, 0) so the CSS translateY
 * that drives its dive can double as "where the nose is", body extending
 * upward with a white stripe and two fins, and a trailing exhaust flame
 * above the tail. Drawn only in the Payload (the reference shows nothing at
 * the thrower resembling it), so it needs no `k` - one instance per throw.
 */
function Missile({ uid }: { uid: string }) {
  const g = (n: string) => `thr-rocket-${n}-${uid}`;
  return (
    <g>
      <defs>
        <linearGradient id={g('missilebody')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={MISSILE_RED_DARK} />
          <stop offset="24%" stopColor={MISSILE_RED} />
          <stop offset="38%" stopColor="#ffaba6" />
          <stop offset="49%" stopColor={MISSILE_RED} />
          <stop offset="80%" stopColor="#a91022" />
          <stop offset="100%" stopColor={MISSILE_RED_DARK} />
        </linearGradient>
        <linearGradient id={g('exhaust')} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor={EXHAUST_INNER} />
          <stop offset="45%" stopColor={EXHAUST_OUTER} />
          <stop offset="100%" stopColor={EXHAUST_OUTER} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* the exhaust flame, trailing UP from the tail */}
      <path
        d="M -3.5 -28 Q -6.5 -38 -2 -52 Q 0 -46 2 -52 Q 6.5 -38 3.5 -28 Z"
        fill={`url(#${g('exhaust')})`}
      />
      {/* the body */}
      <path
        d="M -5 -11 L -5 -25 Q -5 -29 -1.5 -29 L 1.5 -29 Q 5 -29 5 -25 L 5 -11 Z"
        fill={`url(#${g('missilebody')})`}
      />
      {/* a thin highlight down the left edge, painted under the stripe */}
      <rect x="-4.2" y="-26" width="1" height="12" rx="0.5" fill="#ffffff" opacity="0.3" />
      {/* the white stripe */}
      <rect x="-5" y="-20.5" width="10" height="3" fill={MISSILE_WHITE} />
      {/* two tail fins */}
      <path d="M -5 -24 L -10.5 -30 L -5 -27.5 Z" fill={MISSILE_FIN} />
      <path d="M 5 -24 L 10.5 -30 L 5 -27.5 Z" fill={MISSILE_FIN} />
      {/* the dark nose cone, tip at the local origin */}
      <path d="M -5 -11 L 0 0 L 5 -11 Z" fill={MISSILE_NOSE} />
      <path d="M -3.7 -10 L 0 -1.8 L -1.1 -10 Z" fill="#7d8894" opacity="0.7" />
      <path d="M -4.5 -23.5 L 4.5 -23.5 M -4.5 -13 L 4.5 -13" stroke="#700f1b" strokeWidth="0.7" />
      <path d="M -5.5 -25 L -9.2 -29 M 5.5 -25 L 9.2 -29" stroke="#a6afb7" strokeWidth="0.7" />
    </g>
  );
}

function Projectile({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Reticle uid={uid} k="p" />
    </svg>
  );
}

function Payload({ uid }: RigProps) {
  const g = (n: string) => `thr-rocket-${n}-${uid}`;
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      {/* 333-1833 (+0..+1500): the reticle - on screen from LANDING, wanders
          through lock-on, then scales up and fades at the lock. One
          continuous life so the wander, the lock and the fade cannot drift
          apart into three separate delays. */}
      <g className="thr-rocket__reticle">
        <Reticle uid={uid} k="a" />
      </g>

      {/* 2567 (+2234): the dull red hit glow, BEHIND the missile - placed
          before it in document order so paint order puts the missile on top
          for as long as both are visible, exactly as the reference shows. */}
      <g className="thr-rocket__hitglow">
        <defs>
          <radialGradient id={g('hitglow')} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor={HIT_GLOW} stopOpacity="0.75" />
            <stop offset="60%" stopColor={HIT_GLOW} stopOpacity="0.35" />
            <stop offset="100%" stopColor={HIT_GLOW} stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="0" cy="0" r="56" fill={`url(#${g('hitglow')})`} />
      </g>

      {/* 2267-2633 (+1934..+2300): the missile, diving from the top edge of
          the box to the avatar centre, growing with perspective. Gone the
          instant the flame appears. */}
      <g className="thr-rocket__missile">
        <Missile uid={uid} />
      </g>

      {/* 2633-2733 (+2300..+2400): the small flame, three tongues over a
          soft core glow, growing from ~20 px to ~35 px before the fireball
          takes over. */}
      <g className="thr-rocket__flame">
        <defs>
          <radialGradient id={g('flameglow')} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor={PURE_YELLOW} stopOpacity="0.55" />
            <stop offset="100%" stopColor={PURE_YELLOW} stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx="0" cy="6" rx="16" ry="7" fill={`url(#${g('flameglow')})`} />
        <g transform="translate(-6 3) rotate(-14) scale(0.75)">
          <path d={FLAME_TONGUE_PATH} fill={PURE_YELLOW} />
        </g>
        <g transform="translate(6 3) rotate(14) scale(0.75)">
          <path d={FLAME_TONGUE_PATH} fill={PURE_YELLOW} />
        </g>
        <g transform="translate(0 4) scale(0.95)">
          <path d={FLAME_TONGUE_PATH} fill={GOLD_DEEP} />
        </g>
      </g>

      {/* 2733-2900 (+2400..+2567): a continuous, asymmetric flame crown
          surrounds the solid core and completely covers the avatar. */}
      <g className="thr-rocket__fireball">
        <defs>
          <radialGradient id={g('fireball')} cx="0.5" cy="0.4" r="0.65">
            <stop offset="0%" stopColor={FIREBALL_CORE} />
            <stop offset="45%" stopColor={PURE_YELLOW} />
            <stop offset="100%" stopColor={GOLD_DEEP} />
          </radialGradient>
        </defs>
        <path
          d="M -47 52 C -67 36 -61 19 -69 4 C -58 11 -55 5 -58 -11 C -64 -31 -57 -40 -62 -51 C -46 -43 -47 -27 -35 -26 C -43 -52 -27 -65 -33 -79 C -17 -70 -26 -48 -12 -42 C -13 -64 4 -75 0 -96 C 22 -80 7 -65 22 -50 C 31 -43 32 -63 39 -70 C 35 -42 54 -43 46 -19 C 53 -24 57 -35 59 -39 C 65 -23 53 -9 61 3 C 66 11 71 6 75 3 C 66 20 68 33 55 43 C 43 62 24 65 2 67 C -17 66 -34 66 -47 52 Z"
          fill={`url(#${g('fireball')})`}
        />
        <path
          d="M -32 40 C -48 17 -24 3 -31 -16 C -19 -11 -21 3 -11 8 C -20 -16 1 -25 -4 -43 C 15 -25 4 -13 19 -1 C 24 -14 33 -17 34 -27 C 44 -5 28 5 38 19 C 44 36 24 52 4 53 C -12 55 -24 50 -32 40 Z"
          fill={FIREBALL_CORE}
          opacity="0.8"
        />
      </g>

      {/* 2867-3033 (+2534..+2700): the orange/ember stage - a darker gradient
          core with dark ember blotches, handing off to the yellow fireball
          above it exactly as fireworks.tsx hands a burst to its own ember
          cloud (a colour shift without animating `fill`). */}
      <g className="thr-rocket__ember">
        <defs>
          <radialGradient id={g('ember')} cx="0.5" cy="0.4" r="0.65">
            <stop offset="0%" stopColor={EMBER_ORANGE} />
            <stop offset="55%" stopColor={EMBER_ORANGE_DEEP} />
            <stop offset="100%" stopColor={EMBER_DARK} />
          </radialGradient>
        </defs>
        <ellipse cx="0" cy="14" rx="56" ry="50" fill={`url(#${g('ember')})`} />
        <ellipse cx="-18" cy="0" rx="12" ry="9" fill={EMBER_DARK} opacity="0.55" />
        <ellipse cx="16" cy="-10" rx="10" ry="8" fill={EMBER_DARK} opacity="0.5" />
        <ellipse cx="6" cy="26" rx="11" ry="8" fill={EMBER_DARK} opacity="0.5" />
        <ellipse cx="-10" cy="-24" rx="9" ry="7" fill={EMBER_DARK} opacity="0.45" />
      </g>

      {/* 3033-3733 (+2700..+3400): the mushroom cloud - cap above the
          avatar, stem over it - swelling and drifting until it pops out in
          one frame at 3700 and the seat is clean by 3733. */}
      <g className="thr-rocket__smoke">
        <defs>
          <radialGradient id={g('smoke')} cx="0.36" cy="0.25" r="0.8">
            <stop offset="0%" stopColor="#b39a77" />
            <stop offset="32%" stopColor={SMOKE_KHAKI_LIGHT} />
            <stop offset="68%" stopColor={SMOKE_KHAKI} />
            <stop offset="100%" stopColor="#392d25" />
          </radialGradient>
          <radialGradient id={g('smoke-lit')} cx="0.5" cy="0.9" r="0.9">
            <stop offset="0%" stopColor="#c58b47" />
            <stop offset="38%" stopColor={SMOKE_KHAKI} />
            <stop offset="100%" stopColor="#43352b" />
          </radialGradient>
        </defs>
        {/* the stem, over the avatar */}
        <ellipse cx="0" cy="34" rx="34" ry="40" fill={`url(#${g('smoke')})`} />
        <circle cx="-16" cy="26" r="22" fill={`url(#${g('smoke')})`} />
        <circle cx="16" cy="26" r="22" fill={`url(#${g('smoke')})`} />
        {/* the cap, above the avatar */}
        <ellipse cx="0" cy="-32" rx="64" ry="40" fill={`url(#${g('smoke')})`} />
        <circle cx="-42" cy="-20" r="28" fill={`url(#${g('smoke')})`} />
        <circle cx="42" cy="-20" r="28" fill={`url(#${g('smoke')})`} />
        <circle cx="-18" cy="-52" r="26" fill={`url(#${g('smoke')})`} />
        <circle cx="20" cy="-52" r="26" fill={`url(#${g('smoke')})`} />
        <circle cx="0" cy="-58" r="24" fill={`url(#${g('smoke')})`} />
        {/* Overlapping billows and a lit underside give the cloud volume;
            all follow the measured parent swell and hard cut. */}
        <path
          d="M -51 -8 C -40 -19 -29 -9 -23 -14 C -12 -24 0 -9 8 -16 C 20 -24 33 -11 46 -12 C 34 6 18 11 2 5 C -13 13 -37 6 -51 -8 Z"
          fill={`url(#${g('smoke-lit')})`}
        />
        <path
          d="M -17 53 C -28 32 -17 14 -10 4 C -7 -4 5 -5 9 4 C 24 23 11 37 18 53 C 7 62 -6 63 -17 53 Z"
          fill={`url(#${g('smoke')})`}
        />
        <path
          d="M -57 -28 C -56 -41 -42 -46 -34 -41 M -30 -58 C -24 -70 -12 -72 -4 -65 M 17 -67 C 29 -72 40 -61 39 -51 M 47 -40 C 60 -37 63 -26 57 -18"
          fill="none"
          stroke="#c2ad8d"
          strokeWidth="2.2"
          strokeLinecap="round"
          opacity="0.45"
        />
      </g>
    </svg>
  );
}

export const rocketRig: ThrowableRig = { Projectile, Payload };
