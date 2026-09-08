import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './crown.css';
export const spec: ThrowableSpec = {
  id: 'crown',
  name: 'Crown Me',
  tier: 'vip',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'land',
  payload: { sizeU: 1.5, anchor: 'face', coversAvatar: false, ms: 4167 },
  beats: [
    { at: 333, marker: 'arrival' },
    { at: 800, marker: 'crown-lands' },
    { at: 1000, marker: 'gem-flash' },
    { at: 1750, marker: 'ribbon-open' },
    { at: 2600, marker: 'sparkle-orbit' },
    { at: 4500, marker: 'cut' },
  ],
  audio: [
    { at: 800, sample: 'fanfare_short', gain: 0.4 },
    { at: 1000, sample: 'chime_shimmer', gain: 0.3 },
  ],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
const RECTS: [number, number, number, number][] = [
  [43, 104, 582, 497],
  [669, 130, 543, 472],
  [130, 708, 497, 391],
  [498, 776, 733, 314],
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
      src="crown"
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
      <g className="thr-crown__crown">
        <Tile tile={0} x={-70} y={-130} width={140} height={100} />
      </g>
      <g className="thr-crown__ribbon">
        <Tile tile={3} x={-72} y={28} width={144} height={60} />
        <text x={0} y={66} textAnchor="middle" fill="#ffe5a0" fontSize={17} fontWeight={800}>
          KING
        </text>
      </g>
      <g className="thr-crown__sparkle0">
        <Tile tile={2} x={-12} y={-12} width={24} height={24} />
      </g>
      <g className="thr-crown__sparkle1">
        <Tile tile={2} x={-12} y={-12} width={24} height={24} />
      </g>
      <g className="thr-crown__sparkle2">
        <Tile tile={2} x={-12} y={-12} width={24} height={24} />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
