import type { CSSProperties } from 'react';
/** Bespoke Magnet payload. All CSS times are relative to landing at 300 ms. */
import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './magnet.css';
export const spec: ThrowableSpec = {
  id: 'magnet',
  name: 'Magnet',
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
      marker: 'magnet',
    },
    {
      at: 800,
      marker: 'attract',
    },
    {
      at: 1600,
      marker: 'chips-attached',
    },
    {
      at: 2400,
      marker: 'return-to-thrower',
    },
    {
      at: 3200,
      marker: 'clear',
    },
    {
      at: 3500,
      marker: 'cut',
    },
  ],
  audio: [
    {
      at: 800,
      sample: 'magnet_hum',
    },
    {
      at: 1100,
      sample: 'chip_clatter',
    },
    {
      at: 2400,
      sample: 'whoosh_low',
    },
  ],
};
preloadThrowableCues(spec.audio.map((c) => c.sample));
function Magnet() {
  return (
    <AtlasSprite src="magnet" rect={[55, 60, 560, 560]} x={-60} y={-110} width={120} height={120} />
  );
}
const CHIPS = [
  [-50, 50, -25, -10],
  [-15, 65, -5, -6],
  [25, 60, 15, 4],
  [55, 42, 30, 8],
] as const;
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Magnet />
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-magnet__return">
        <Magnet />
        {CHIPS.map(([x, y, dx, dy], i) => (
          <g
            key={i}
            className="thr-magnet__chip"
            style={
              {
                '--x': `${x}px`,
                '--y': `${y}px`,
                '--dx': `${dx}px`,
                '--dy': `${dy}px`,
                '--delay': `${0.5 + i * 0.1}s`,
              } as CSSProperties
            }
          >
            <AtlasSprite
              src="magnet"
              rect={[115, 695, 455, 465]}
              x={-14}
              y={-14}
              width={28}
              height={29}
            />
          </g>
        ))}
        <g className="thr-magnet__field">
          <AtlasSprite
            src="magnet"
            rect={[650, 645, 565, 555]}
            x={-50}
            y={-32}
            width={100}
            height={98}
          />
        </g>
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
