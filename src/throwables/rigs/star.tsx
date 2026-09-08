/** Bespoke Star payload. All CSS times are relative to landing at 300 ms. */
import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './star.css';
export const spec: ThrowableSpec = {
  id: 'star',
  name: 'Star',
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
      marker: 'forehead',
    },
    {
      at: 700,
      marker: 'gold-pulse',
    },
    {
      at: 1100,
      marker: 'sparkle-orbit',
    },
    {
      at: 2300,
      marker: 'second-pulse',
    },
    {
      at: 3500,
      marker: 'cut',
    },
  ],
  audio: [
    {
      at: 700,
      sample: 'chime_shimmer',
    },
    {
      at: 1100,
      sample: 'harp_sparkle',
    },
    {
      at: 2300,
      sample: 'chime_shimmer',
    },
  ],
};
preloadThrowableCues(spec.audio.map((c) => c.sample));
function Star() {
  return (
    <AtlasSprite src="star" rect={[60, 65, 505, 515]} x={-45} y={-75} width={90} height={92} />
  );
}
const SPARKLES = [
  [54, -40],
  [-56, -20],
  [0, 33],
] as const;
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Star />
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-star__pulse">
        <Star />
      </g>
      <g className="thr-star__orbit">
        {SPARKLES.map(([x, y], i) => (
          <g key={i} transform={`translate(${x} ${y})`}>
            <AtlasSprite
              src="star"
              rect={[755, 685, 355, 435]}
              x={-12}
              y={-15}
              width={24}
              height={30}
            />
          </g>
        ))}
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
