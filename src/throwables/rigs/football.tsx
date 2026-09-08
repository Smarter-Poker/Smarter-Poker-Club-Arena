/** Bespoke Football payload. All CSS times are relative to landing at 300 ms. */
import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './football.css';
export const spec: ThrowableSpec = {
  id: 'football',
  name: 'Football',
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
      marker: 'goalposts',
    },
    {
      at: 900,
      marker: 'goal',
    },
    {
      at: 1200,
      marker: 'its-good',
    },
    {
      at: 3500,
      marker: 'cut',
    },
  ],
  audio: [
    {
      at: 300,
      sample: 'whoosh_low',
    },
    {
      at: 900,
      sample: 'chime_shimmer',
    },
    {
      at: 1200,
      sample: 'fanfare_short',
    },
  ],
};
preloadThrowableCues(spec.audio.map((c) => c.sample));
function Ball() {
  return (
    <AtlasSprite src="football" rect={[35, 65, 575, 545]} x={-34} y={-32} width={68} height={64} />
  );
}
function Posts() {
  return (
    <AtlasSprite
      src="football"
      rect={[730, 35, 420, 585]}
      x={-70}
      y={-105}
      width={140}
      height={195}
    />
  );
}
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g transform="translate(-90 35)">
        <Ball />
      </g>
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-football__posts">
        <Posts />
      </g>
      <g className="thr-football__ball">
        <Ball />
      </g>
      <g className="thr-football__flash">
        <AtlasSprite
          src="football"
          rect={[675, 645, 520, 540]}
          x={-45}
          y={-85}
          width={90}
          height={93}
        />
      </g>
      <g className="thr-football__caption">
        <text
          x="0"
          y="-110"
          textAnchor="middle"
          fill="#ffe4a1"
          stroke="#442a0b"
          strokeWidth=".8"
          paintOrder="stroke"
          fontFamily="system-ui, sans-serif"
          fontSize="20"
          fontWeight="900"
        >
          IT’S GOOD!
        </text>
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
