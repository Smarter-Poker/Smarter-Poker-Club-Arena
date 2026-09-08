/** Premium dice hand: hold, three cupped-hand shake bursts, and a hard cut.
 * The spec is authoritative; all payload timing is relative to its 200 ms
 * landing. Held/cupped artwork changes independently of wrist motion.
 * Rattle groups retain their existing scheduled cues. No JS rig timers.
 */

import type { ThrowableSpec } from '../spec';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import { preloadThrowableCues } from '../cues';
import './dice.css';
import { AtlasSprite } from '../AtlasSprite';

export const diceSpec: ThrowableSpec = {
  id: 'dice',
  name: 'Dice',
  tier: 'free',
  category: 'objects',
  spawn: 'avatar-face',
  spawnMs: 100,
  flight: { ms: 200, mode: 'straight', tumble: true },
  arrival: 'land',
  payload: { sizeU: 1.3, anchor: 'left', coversAvatar: true, ms: 5300 },
  beats: [
    { at: 200, marker: 'land' },
    { at: 267, marker: 'hand-in' },
    { at: 1200, marker: 'shake-1' },
    { at: 2700, marker: 'shake-2' },
    { at: 4900, marker: 'shake-3' },
    { at: 5500, marker: 'cut' },
  ],
  audio: [
    { at: 1200, sample: 'dice_rattle' },
    { at: 1333, sample: 'dice_rattle' },
    { at: 1467, sample: 'dice_rattle' },
    { at: 1600, sample: 'dice_rattle' },
    { at: 1733, sample: 'dice_rattle' },
    { at: 1933, sample: 'dice_rattle' },
    { at: 2667, sample: 'dice_rattle' },
    { at: 2800, sample: 'dice_rattle' },
    { at: 4867, sample: 'dice_rattle' },
    { at: 5033, sample: 'dice_rattle' },
    { at: 5267, sample: 'dice_rattle' },
    { at: 5400, sample: 'dice_rattle' },
  ],
  reference: { video: 1, launchFrame: 1716, throw: 'THROW 8' },
};

preloadThrowableCues(diceSpec.audio.map((c) => c.sample));

/** Premium cupped-hand poses, with dice geometry authored into each pose. */
function DicePair() {
  return (
    <AtlasSprite src="dice" rect={[125, 750, 430, 365]} x={-24} y={-20} width={48} height={40} />
  );
}
function Hand() {
  return (
    <g>
      <g className="thr-dice__hold-pose">
        <AtlasSprite
          src="dice"
          rect={[693, 645, 503, 575]}
          x={-49}
          y={-77}
          width={98}
          height={119}
        />
      </g>
      <g className="thr-dice__cup-pose">
        <AtlasSprite src="dice" rect={[58, 171, 560, 419]} x={-49} y={-57} width={98} height={99} />
      </g>
    </g>
  );
}

function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <DicePair />
    </svg>
  );
}

function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      {/* 367 (+134): the hand, already cupping the dice. The player's own
          `thr__payload--land` class supplies the pop-in; this group owns
          only the repeating shake. */}
      <g transform="translate(0 12)">
        <g className="thr-dice__hand">
          <Hand />
        </g>
      </g>
    </svg>
  );
}

export const diceRig: ThrowableRig = { Projectile, Payload };
