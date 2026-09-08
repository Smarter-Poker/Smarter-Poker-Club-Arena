/** Bespoke Basketball payload. All CSS times are relative to landing at 300 ms. */
import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './basketball.css';
export const spec: ThrowableSpec = {
  id: 'basketball',
  name: 'Basketball',
  tier: 'free',
  category: 'objects',
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
      marker: 'hoop',
    },
    {
      at: 700,
      marker: 'swish',
    },
    {
      at: 1100,
      marker: 'bounce-one',
    },
    {
      at: 1550,
      marker: 'bounce-two',
    },
    {
      at: 2300,
      marker: 'roll-out',
    },
    {
      at: 3500,
      marker: 'cut',
    },
  ],
  audio: [
    {
      at: 700,
      sample: 'basket_swish',
    },
    {
      at: 1100,
      sample: 'basket_bounce',
    },
    {
      at: 1550,
      sample: 'basket_bounce',
    },
  ],
};
preloadThrowableCues(spec.audio.map((c) => c.sample));
function Ball() {
  return (
    <AtlasSprite
      src="basketball"
      rect={[50, 45, 550, 555]}
      x={-28}
      y={-28}
      width={56}
      height={56}
    />
  );
}
function Hoop() {
  return (
    <g className="thr-basketball__hoop">
      <AtlasSprite
        src="basketball"
        rect={[660, 65, 580, 140]}
        x={-55}
        y={-115}
        width={110}
        height={26.55}
      />
      <g className="thr-basketball__net">
        <AtlasSprite
          src="basketball"
          rect={[690, 205, 460, 355]}
          x={-49.31}
          y={-88.45}
          width={87.24}
          height={67.33}
        />
      </g>
    </g>
  );
}
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g transform="translate(-95 0)">
        <Ball />
      </g>
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Hoop />
      <g className="thr-basketball__ball">
        <Ball />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
