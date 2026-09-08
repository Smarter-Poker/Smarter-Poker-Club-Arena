// Missile uses the approved airstrike choreography and atlas.
import type { ThrowableSpec } from '../spec';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import { preloadThrowableCues } from '../cues';
import './missile.css';
import { AtlasSprite } from '../AtlasSprite';

export const spec: ThrowableSpec = {
  id: 'missile',
  name: 'Missile',
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

preloadThrowableCues(spec.audio.map((c) => c.sample));

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
      <g className="thr-missile__reticle">
        <Reticle />
      </g>
      <g className="thr-missile__hitglow">
        <AtlasSprite
          src="rocket"
          rect={[25, 802, 355, 337]}
          x={-56}
          y={-56}
          width={112}
          height={112}
        />
      </g>
      <g className="thr-missile__missile">
        <Missile />
      </g>
      <g className="thr-missile__flame">
        <AtlasSprite
          src="rocket"
          rect={[25, 802, 355, 337]}
          x={-24}
          y={-35}
          width={48}
          height={48}
        />
      </g>
      <g className="thr-missile__fireball">
        <AtlasSprite
          src="rocket"
          rect={[390, 685, 462, 490]}
          x={-76}
          y={-96}
          width={152}
          height={164}
        />
      </g>
      <g className="thr-missile__ember">
        <AtlasSprite
          src="rocket"
          rect={[842, 681, 398, 491]}
          x={-59}
          y={-50}
          width={118}
          height={131}
        />
      </g>
      <g className="thr-missile__smoke">
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
export const rig: ThrowableRig = { Projectile, Payload };
