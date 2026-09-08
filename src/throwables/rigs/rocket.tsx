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
import { AtlasSprite } from '../AtlasSprite';

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
function Reticle() {
  return (
    <AtlasSprite src="rocket" rect={[815, 105, 430, 435]} x={-33} y={-33} width={66} height={66} />
  );
}
function Missile() {
  return (
    <g>
      <AtlasSprite src="rocket" rect={[540, 90, 224, 510]} x={-5} y={-54} width={10} height={28} />
      <g transform="translate(0 -17) rotate(140)">
        <AtlasSprite src="rocket" rect={[5, 85, 450, 515]} x={-18} y={-20} width={36} height={40} />
      </g>
    </g>
  );
}
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Reticle />
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-rocket__reticle">
        <Reticle />
      </g>
      <g className="thr-rocket__hitglow">
        <AtlasSprite
          src="rocket"
          rect={[25, 802, 355, 337]}
          x={-56}
          y={-56}
          width={112}
          height={112}
        />
      </g>
      <g className="thr-rocket__missile">
        <Missile />
      </g>
      <g className="thr-rocket__flame">
        <AtlasSprite
          src="rocket"
          rect={[25, 802, 355, 337]}
          x={-24}
          y={-35}
          width={48}
          height={48}
        />
      </g>
      <g className="thr-rocket__fireball">
        <AtlasSprite
          src="rocket"
          rect={[390, 685, 462, 490]}
          x={-76}
          y={-96}
          width={152}
          height={164}
        />
      </g>
      <g className="thr-rocket__ember">
        <AtlasSprite
          src="rocket"
          rect={[842, 681, 398, 491]}
          x={-59}
          y={-50}
          width={118}
          height={131}
        />
      </g>
      <g className="thr-rocket__smoke">
        <AtlasSprite
          src="rocket"
          rect={[842, 681, 398, 491]}
          x={-72}
          y={-85}
          width={144}
          height={157}
        />
      </g>
    </svg>
  );
}
export const rocketRig: ThrowableRig = { Projectile, Payload };
