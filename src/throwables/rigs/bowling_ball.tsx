import type { CSSProperties } from 'react';
/** Bespoke Bowling Ball payload. All CSS times are relative to landing at 300 ms. */
import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './bowling_ball.css';
export const spec: ThrowableSpec = {
  id: 'bowling_ball',
  name: 'Bowling Ball',
  tier: 'vip',
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
      marker: 'ten-pins',
    },
    {
      at: 900,
      marker: 'strike',
    },
    {
      at: 1400,
      marker: 'scatter',
    },
    {
      at: 3500,
      marker: 'cut',
    },
  ],
  audio: [
    {
      at: 300,
      sample: 'roll_rumble',
    },
    {
      at: 900,
      sample: 'pins_crash',
    },
  ],
};
preloadThrowableCues(spec.audio.map((c) => c.sample));
function Ball() {
  return (
    <AtlasSprite
      src="bowling_ball"
      rect={[70, 80, 540, 540]}
      x={-30}
      y={-30}
      width={60}
      height={60}
    />
  );
}
const PINS = [
  [-45, -28, -100, -30, -100],
  [-15, -28, -75, -60, -140],
  [15, -28, 75, -55, 150],
  [45, -28, 110, -25, 120],
  [-30, -12, -90, 35, -160],
  [0, -12, 5, -90, 170],
  [30, -12, 80, 30, 130],
  [-15, 5, -60, 65, -110],
  [15, 5, 60, 70, 110],
  [0, 23, 20, 100, 180],
] as const;
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g transform="translate(-110 45)">
        <Ball />
      </g>
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      {PINS.map(([x, y, dx, dy, spin], i) => (
        <g key={i} transform={`translate(${x} ${y})`}>
          <g
            className="thr-bowling_ball__pin"
            style={
              { '--dx': `${dx}px`, '--dy': `${dy}px`, '--spin': `${spin}deg` } as CSSProperties
            }
          >
            <AtlasSprite
              src="bowling_ball"
              rect={[820, 25, 265, 635]}
              x={-11}
              y={-42}
              width={22}
              height={53}
            />
          </g>
        </g>
      ))}
      <g className="thr-bowling_ball__ball">
        <Ball />
      </g>
      <g className="thr-bowling_ball__dust">
        <AtlasSprite
          src="bowling_ball"
          rect={[640, 730, 600, 485]}
          x={-85}
          y={-48}
          width={170}
          height={136}
        />
      </g>
      <g className="thr-bowling_ball__caption">
        <text
          x="0"
          y="-85"
          textAnchor="middle"
          fill="#ffe4a1"
          stroke="#442a0b"
          strokeWidth=".8"
          paintOrder="stroke"
          fontFamily="system-ui, sans-serif"
          fontSize="25"
          fontWeight="900"
        >
          STRIKE!
        </text>
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
