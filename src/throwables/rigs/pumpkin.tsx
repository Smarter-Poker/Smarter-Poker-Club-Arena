import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './pumpkin.css';
export const spec: ThrowableSpec = {
  id: 'pumpkin',
  name: 'Pumpkin',
  tier: 'premium',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'land',
  payload: { sizeU: 1.5, anchor: 'face', coversAvatar: false, ms: 3667 },
  beats: [
    { at: 333, marker: 'arrival' },
    { at: 650, marker: 'pumpkin-lands' },
    { at: 1200, marker: 'lid-lifts' },
    { at: 1600, marker: 'face-ignites' },
    { at: 2700, marker: 'candle-flickers' },
    { at: 4000, marker: 'cut' },
  ],
  audio: [
    { at: 650, sample: 'thump_soft', gain: 0.4 },
    { at: 1200, sample: 'steam_hiss', gain: 0.25 },
    { at: 1600, sample: 'chime_shimmer', gain: 0.3 },
  ],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
const RECTS: [number, number, number, number][] = [
  [50, 159, 528, 442],
  [676, 159, 529, 442],
  [112, 785, 427, 323],
  [823, 826, 227, 246],
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
      src="pumpkin"
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
      <g className="thr-pumpkin__shell">
        <Tile tile={0} x={-80} y={-75} width={160} height={150} />
      </g>
      <g className="thr-pumpkin__lit">
        <Tile tile={1} x={-80} y={-75} width={160} height={150} />
      </g>
      <g className="thr-pumpkin__lid">
        <Tile tile={2} x={-55} y={-110} width={110} height={60} />
      </g>
      <g className="thr-pumpkin__spark">
        <Tile tile={3} x={-20} y={-25} width={40} height={40} />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
