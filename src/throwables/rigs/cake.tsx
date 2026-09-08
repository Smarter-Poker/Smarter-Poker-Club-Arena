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
 *              top edge; a cherry sits at the crown from this frame on
 *   300-500    the plate holds
 *   500-967    the plate SLIDES DOWN the face at ~1 px/frame
 *   1000       the plate fades (~50% alpha)
 *   1033       the plate is gone: residue = a cream smear over the upper 60%
 *              of the face, the cherry still at the crown
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
import { AtlasSprite } from '../AtlasSprite';

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

/** The measured pinks, the plate white and the cherry red. */

/**
 * The intact cake: a two-tier pink/white cake on a plate, 44 units across
 * and 62 tall, drawn with the plate's centre at (0, 20). Used for the flying
 * projectile and the payload's press-and-squash group.
 */
function Cake(_: { uid: string; k: string }) {
  return <AtlasSprite src="cake" rect={[9, 82, 410, 525]} x={-28} y={-44} width={56} height={72} />;
}

/** The cherry that stays at the crown once the plate reveals, apart from
 *  the cake sprite so it can persist after the cake and the plate are gone. */
function Cherry(_: { uid: string }) {
  return (
    <AtlasSprite src="cake" rect={[485, 730, 300, 435]} x={-9} y={-15} width={18} height={26} />
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
        <AtlasSprite
          src="cake"
          rect={[428, 188, 401, 401]}
          x={-28}
          y={-33}
          width={56}
          height={56}
        />
      </g>

      {/* 1033 (+900): the residue - a cream smear over the upper face. */}
      <g className="thr-cake__residue">
        <AtlasSprite src="cake" rect={[8, 693, 440, 502]} x={-35} y={-47} width={70} height={70} />
      </g>

      {/* 300 (+167): the cherry at the crown - stays through the slide
          and into the residue, so it is drawn AFTER the smear rather than
          under it. The measured position lives on a PLAIN WRAPPER: a CSS
          keyframe that writes `transform` REPLACES an SVG transform attribute
          on the same element, so a class that animates scale here would drop
          the translate and put the berry in the middle of the face. */}
      <g transform="translate(2 -46)">
        <g className="thr-cake__berry">
          <Cherry uid={uid} />
        </g>
      </g>
    </svg>
  );
}

export const cakeRig: ThrowableRig = { Projectile, Payload };
