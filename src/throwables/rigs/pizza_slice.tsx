import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './pizza_slice.css';

export const spec: ThrowableSpec = {
  id: 'pizza_slice',
  name: 'Pizza Slice',
  tier: 'free',
  category: 'objects',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 1.4, anchor: 'face', coversAvatar: true, ms: 3667 },
  beats: [
    { at: 333, marker: 'face-down' },
    { at: 1000, marker: 'slide-smear' },
    { at: 1800, marker: 'cheese-stretch' },
    { at: 2200, marker: 'peel' },
    { at: 2900, marker: 'drop' },
    { at: 3500, marker: 'pepperoni-stays' },
    { at: 4000, marker: 'cut' },
  ],
  // Bespoke cheese/peel recordings remain pending; use the existing wet impact cue.
  audio: [{ at: 333, sample: 'splat_wet_small' }],
};
preloadThrowableCues(spec.audio.map((c) => c.sample));
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <AtlasSprite
        src="pizza_slice"
        rect={[0, 35, 507, 701]}
        x={-42}
        y={-58}
        width={84}
        height={116}
      />
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-pizza_slice__smear">
        <AtlasSprite
          src="pizza_slice"
          rect={[0, 764, 535, 478]}
          x={-39}
          y={-25}
          width={78}
          height={70}
        />
      </g>
      <g className="thr-pizza_slice__pepperoni">
        <AtlasSprite
          src="pizza_slice"
          rect={[541, 810, 390, 390]}
          x={-16}
          y={-40}
          width={32}
          height={32}
        />
      </g>
      <g className="thr-pizza_slice__tether">
        <AtlasSprite
          src="pizza_slice"
          rect={[978, 0, 276, 807]}
          x={-17}
          y={-16}
          width={34}
          height={95}
        />
      </g>
      <g className="thr-pizza_slice__slice">
        <AtlasSprite
          src="pizza_slice"
          rect={[507, 45, 471, 675]}
          x={-45}
          y={-64}
          width={90}
          height={129}
        />
      </g>
      <g className="thr-pizza_slice__drip">
        <AtlasSprite
          src="pizza_slice"
          rect={[976, 818, 250, 423]}
          x={8}
          y={12}
          width={16}
          height={27}
        />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
