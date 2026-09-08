/** Bespoke Diamond payload. All CSS times are relative to landing at 300 ms. */
import type { CSSProperties } from 'react';
import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './diamond.css';
export const spec: ThrowableSpec = {
  id: 'diamond',
  name: 'Diamond',
  tier: 'vip',
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
    ms: 2900,
  },
  beats: [
    {
      at: 300,
      marker: 'land',
    },
    {
      at: 400,
      marker: 'spin',
    },
    {
      at: 1600,
      marker: 'shatter',
    },
    {
      at: 2300,
      marker: 'shard-rain',
    },
    {
      at: 3000,
      marker: 'clear',
    },
    {
      at: 3200,
      marker: 'cut',
    },
  ],
  audio: [
    {
      at: 400,
      sample: 'chime_shimmer',
    },
    {
      at: 1600,
      sample: 'glass_clink_rattle',
    },
    {
      at: 1750,
      sample: 'glass_clink_rattle',
    },
    {
      at: 2100,
      sample: 'harp_sparkle',
    },
  ],
};
preloadThrowableCues(spec.audio.map((c) => c.sample));
function Gem() {
  return (
    <AtlasSprite src="diamond" rect={[5, 55, 615, 535]} x={-60} y={-55} width={120} height={105} />
  );
}
const SHARDS = [
  [-65, 110, -160, 14],
  [-52, 95, 120, 10],
  [-40, 140, 210, 17],
  [-28, 105, -230, 12],
  [-15, 125, 160, 14],
  [-5, 95, -170, 9],
  [10, 130, 260, 16],
  [23, 110, -140, 11],
  [37, 145, 200, 15],
  [49, 100, -210, 13],
  [61, 125, 160, 10],
  [72, 145, -250, 12],
] as const;
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Gem />
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-diamond__gem">
        <Gem />
      </g>
      <g className="thr-diamond__flare">
        <AtlasSprite
          src="diamond"
          rect={[645, 620, 600, 585]}
          x={-85}
          y={-80}
          width={170}
          height={165}
        />
      </g>
      {SHARDS.map(([dx, dy, spin, size], i) => (
        <g
          className="thr-diamond__shard"
          key={i}
          style={
            {
              '--dx': `${dx}px`,
              '--lift': `${-10 - ((i * 13) % 55)}px`,
              '--dy': `${dy}px`,
              '--spin': `${spin}deg`,
            } as CSSProperties
          }
        >
          <AtlasSprite
            src="diamond"
            rect={[303, 682, 120, 248]}
            x={-size / 2}
            y={-size}
            width={size}
            height={size * 2}
          />
        </g>
      ))}
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
