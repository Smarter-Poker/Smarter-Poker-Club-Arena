/** Bespoke Coffee payload. All CSS times are relative to landing at 300 ms. */
import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './coffee.css';
export const spec: ThrowableSpec = {
  id: 'coffee',
  name: 'Coffee',
  tier: 'free',
  category: 'cheers',
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
    ms: 3700,
  },
  beats: [
    {
      at: 300,
      marker: 'cup',
    },
    {
      at: 400,
      marker: 'steam',
    },
    {
      at: 1200,
      marker: 'wide-eyes',
    },
    {
      at: 2400,
      marker: 'hot-spill',
    },
    {
      at: 3000,
      marker: 'mouth-smear',
    },
    {
      at: 4000,
      marker: 'cut',
    },
  ],
  audio: [
    {
      at: 400,
      sample: 'steam_hiss',
    },
    {
      at: 1200,
      sample: 'water_lap',
    },
    {
      at: 2400,
      sample: 'splat_wet_small',
    },
  ],
};
preloadThrowableCues(spec.audio.map((c) => c.sample));
function Cup() {
  return (
    <AtlasSprite src="coffee" rect={[15, 195, 440, 350]} x={-48} y={-20} width={96} height={77} />
  );
}
function Steam() {
  return (
    <AtlasSprite src="coffee" rect={[945, 90, 285, 545]} x={-20} y={-100} width={40} height={76} />
  );
}
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Cup />
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <AtlasSprite
        src="coffee"
        rect={[450, 290, 435, 280]}
        x={-55}
        y={40}
        width={110}
        height={71}
      />
      <g className="thr-coffee__steam">
        <Steam />
      </g>
      <g className="thr-coffee__cup">
        <Cup />
      </g>
      <g className="thr-coffee__eyes">
        <AtlasSprite
          src="coffee"
          rect={[850, 810, 385, 310]}
          x={-53}
          y={-62}
          width={106}
          height={85}
        />
      </g>
      <g className="thr-coffee__splash">
        <AtlasSprite
          src="coffee"
          rect={[435, 775, 405, 335]}
          x={-62}
          y={10}
          width={124}
          height={102}
        />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
