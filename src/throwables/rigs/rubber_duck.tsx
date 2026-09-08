/** Three squeaky bounces, a puddle, a camera turn and a final squeeze. */
import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './rubber_duck.css';
export const rubberDuckSpec: ThrowableSpec = {
  id: 'rubber_duck',
  name: 'Rubber Duck',
  tier: 'free',
  category: 'characters',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'none',
  payload: { sizeU: 1.2, anchor: 'face', coversAvatar: true, ms: 3267 },
  beats: [
    { at: 333, marker: 'land' },
    { at: 600, marker: 'squeak-1' },
    { at: 1000, marker: 'squeak-2' },
    { at: 1300, marker: 'squeak-3' },
    { at: 2000, marker: 'face-camera' },
    { at: 3000, marker: 'final-squeak' },
    { at: 3600, marker: 'cut' },
  ],
  audio: [
    { at: 600, sample: 'duck_squeak' },
    { at: 1000, sample: 'duck_squeak' },
    { at: 1300, sample: 'duck_squeak' },
    { at: 3000, sample: 'duck_squeak' },
    { at: 700, sample: 'water_lap' },
  ],
};
preloadThrowableCues(rubberDuckSpec.audio.map((c) => c.sample));
function Duck({ front = false }: { front?: boolean }) {
  return (
    <AtlasSprite
      src="rubber_duck"
      rect={front ? [45, 665, 545, 550] : [80, 40, 550, 615]}
      x={-65}
      y={-64}
      width={130}
      height={130}
    />
  );
}
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Duck />
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-rubber_duck__puddle">
        <AtlasSprite
          src="rubber_duck"
          rect={[655, 810, 550, 350]}
          x={-80}
          y={35}
          width={160}
          height={50}
        />
      </g>
      <g className="thr-rubber_duck__bounce">
        <g className="thr-rubber_duck__side">
          <Duck />
        </g>
        <g className="thr-rubber_duck__front">
          <Duck front />
        </g>
      </g>
    </svg>
  );
}
export const rubberDuckRig: ThrowableRig = { Projectile, Payload };
