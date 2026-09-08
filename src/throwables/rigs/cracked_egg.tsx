/**
 * ===============================================================================
 *  CRACKED EGG - an egg, one clean crack, a yolk cap and whites down the face
 *  (phase 1, 2026-09-06)
 * ===============================================================================
 *
 * Measured off PB THROWABLE 2.MOV, THROW 1 (launch f130, 30 fps, target avatar
 * 40 px wide, so 1 px = 2.5 units), see
 * docs/throwables/pokerbros-reference-video-2.md. ms from LAUNCH:
 *
 *   -300..-170  egg pops in at the thrower's upper-left (scale 0 -> 1, a
 *               slight fade-in) over 130 ms
 *   -170..0     HOLD at full size, no motion. The egg is 12x15 px =
 *               0.3 x 0.375 u, brown/beige shell, tilted ~30 deg with its
 *               long axis up-right. The tilt never changes.
 *   0-367       straight flight, 11 frames at ~20.5 px/frame. No spin, no
 *               scale change, no trail. The player moves the box; the egg is
 *               drawn at rest.
 *   367         LANDING: the egg is INTACT at the top of the head, centre
 *               x 0, y -0.35 u. It stays intact for exactly one frame.
 *   400         CRACK, in ONE frame: the egg is replaced by a yolk blob on
 *               top of the head (~26 x 14 px = 0.65 x 0.35 u at y -0.42 u),
 *               two or three cracked shell halves in and around it, and
 *               translucent white egg-white drips running DOWN over the face
 *               to about the chin (bottom at y +0.4 u). No burst, no flash,
 *               no particles, no shake, no tint of the avatar.
 *   433-3500    RESIDUE, STATIC: identical every frame, the avatar fully
 *               visible through the whites. No fade.
 *   3500        CUT, one frame (the reference's residue life was 1.9-4.6 s;
 *               3500 total from launch is used).
 *
 * Everything in the Payload is `animation-delay` from LANDING (367), so the
 * catalogue's "at" minus 367: the crack is at +33, the drips have run their
 * length by about +250, the cut is at +3133. The comments keep both numbers.
 *
 * Sound (plan 4A): `egg_crack` at 400 (a placeholder cue that falls back to
 * the legacy recipe until the library supplies a file) and `drip_tick` at 700
 * at gain 0.6 (a real file).
 */

import type { ThrowableSpec } from '../spec';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import { preloadThrowableCues } from '../cues';
import './cracked_egg.css';
import { AtlasSprite } from '../AtlasSprite';

export const crackedEggSpec: ThrowableSpec = {
  id: 'cracked_egg',
  name: 'Egg',
  tier: 'free',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 300,
  flight: { ms: 367, mode: 'straight', upright: true },
  arrival: 'none',
  payload: { sizeU: 1.0, anchor: 'face', coversAvatar: false, ms: 3133 },
  beats: [
    { at: 367, marker: 'land' },
    { at: 400, marker: 'crack' },
    { at: 433, marker: 'drips' },
    { at: 3500, marker: 'cut' },
  ],
  audio: [
    { at: 400, sample: 'egg_crack' },
    { at: 700, sample: 'drip_tick', gain: 0.6 },
  ],
  reference: { video: 2, launchFrame: 130, throw: 'THROW 1' },
};

preloadThrowableCues(crackedEggSpec.audio.map((c) => c.sample));

function Egg() {
  return (
    <g transform="rotate(30)">
      <AtlasSprite
        src="cracked_egg"
        rect={[40, 122, 365, 450]}
        x={-15}
        y={-19}
        width={30}
        height={38}
      />
    </g>
  );
}
function Projectile(_: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Egg />
    </svg>
  );
}
function Payload(_: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g transform="translate(0 -35)">
        <g className="thr-cracked_egg__egg">
          <Egg />
        </g>
      </g>
      <g className="thr-cracked_egg__splat">
        <g opacity={0.65}>
          <g className="thr-cracked_egg__drip thr-cracked_egg__drip--a">
            <AtlasSprite
              src="cracked_egg"
              rect={[540, 674, 221, 487]}
              fit="none"
              x={-23}
              y={-26}
              width={14}
              height={56}
            />
          </g>
          <g className="thr-cracked_egg__drip thr-cracked_egg__drip--b">
            <AtlasSprite
              src="cracked_egg"
              rect={[540, 674, 221, 487]}
              fit="none"
              x={-2}
              y={-26}
              width={16}
              height={66}
            />
          </g>
          <g className="thr-cracked_egg__drip thr-cracked_egg__drip--c">
            <AtlasSprite
              src="cracked_egg"
              rect={[540, 674, 221, 487]}
              fit="none"
              x={19}
              y={-26}
              width={10}
              height={36}
            />
          </g>
        </g>
        <g className="thr-cracked_egg__yolk">
          <AtlasSprite
            src="cracked_egg"
            rect={[875, 269, 356, 271]}
            x={-33}
            y={-61}
            width={66}
            height={38}
          />
        </g>
        <g transform="rotate(20 26 -50)">
          <AtlasSprite
            src="cracked_egg"
            rect={[427, 106, 418, 477]}
            x={13}
            y={-72}
            width={36}
            height={42}
          />
        </g>
      </g>
    </svg>
  );
}
export const crackedEggRig: ThrowableRig = { Projectile, Payload };
