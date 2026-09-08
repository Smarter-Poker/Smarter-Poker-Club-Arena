/** Bespoke Thumbs Up payload. All CSS times are relative to landing at 300 ms. */
import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './thumbs_up.css';
export const spec: ThrowableSpec = {
  id: 'thumbs_up',
  name: 'Thumbs Up',
  tier: 'free',
  category: 'emoticons',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: {
    ms: 300,
    mode: 'straight',
    upright: true,
  },
  arrival: 'blink-pop',
  payload: {
    sizeU: 1.2,
    anchor: 'face',
    coversAvatar: true,
    ms: 3200,
  },
  beats: [
    {
      at: 300,
      marker: 'fist',
    },
    {
      at: 600,
      marker: 'thumb-up',
    },
    {
      at: 800,
      marker: 'gold-glint',
    },
    {
      at: 1300,
      marker: 'nod-one',
    },
    {
      at: 2100,
      marker: 'nod-two',
    },
    {
      at: 3500,
      marker: 'cut',
    },
  ],
  audio: [
    {
      at: 600,
      sample: 'pop_soft',
    },
    {
      at: 800,
      sample: 'chime_shimmer',
    },
    {
      at: 1300,
      sample: 'tick_settle',
    },
    {
      at: 2100,
      sample: 'tick_settle',
    },
  ],
};
preloadThrowableCues(spec.audio.map((c) => c.sample));
function Hand({ open = false }: { open?: boolean }) {
  return (
    <AtlasSprite
      src="thumbs_up"
      rect={open ? [680, 40, 510, 550] : [105, 140, 505, 460]}
      x={-70}
      y={-75}
      width={140}
      height={150}
    />
  );
}
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Hand />
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-thumbs_up__nod">
        <g className="thr-thumbs_up__closed">
          <Hand />
        </g>
        <g className="thr-thumbs_up__open">
          <Hand open />
        </g>
      </g>
      <g className="thr-thumbs_up__glint">
        <AtlasSprite
          src="star"
          rect={[755, 685, 355, 435]}
          x={-30}
          y={-90}
          width={40}
          height={49}
        />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
