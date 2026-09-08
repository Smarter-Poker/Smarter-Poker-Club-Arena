import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './to_the_moon.css';
export const spec: ThrowableSpec = {
  id: 'to_the_moon',
  name: 'To The Moon',
  tier: 'vip',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'land',
  payload: { sizeU: 1.5, anchor: 'face', coversAvatar: false, ms: 3667 },
  beats: [
    { at: 333, marker: 'arrival' },
    { at: 800, marker: 'moon-rises' },
    { at: 1200, marker: 'rocket-lands' },
    { at: 1550, marker: 'flag-planted' },
    { at: 3000, marker: 'flag-wave' },
    { at: 4000, marker: 'cut' },
  ],
  audio: [
    { at: 1200, sample: 'tick_land', gain: 0.35 },
    { at: 1550, sample: 'lock_confirm', gain: 0.3 },
  ],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
const RECTS: [number, number, number, number][] = [
  [110, 105, 449, 445],
  [735, 67, 356, 502],
  [157, 650, 432, 523],
  [830, 730, 237, 421],
];
function Tile({
  tile,
  x,
  y,
  width,
  height,
}: {
  tile: number;
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  return (
    <AtlasSprite
      src="to_the_moon"
      rect={RECTS[tile]}
      sheetSize={[1254, 1254]}
      x={x}
      y={y}
      width={width}
      height={height}
    />
  );
}
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Tile tile={0} x={-55} y={-55} width={110} height={110} />
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-to_the_moon__moon">
        <Tile tile={0} x={-75} y={-90} width={150} height={150} />
      </g>
      <g className="thr-to_the_moon__rocket">
        <Tile tile={1} x={-15} y={-80} width={55} height={85} />
      </g>
      <g className="thr-to_the_moon__flag">
        <Tile tile={2} x={-48} y={-105} width={55} height={70} />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
