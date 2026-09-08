import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './heart_arrow.css';
export const spec: ThrowableSpec = {
  id: 'heart_arrow',
  name: 'Heart Arrow',
  tier: 'premium',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'land',
  payload: { sizeU: 1.5, anchor: 'face', coversAvatar: false, ms: 3667 },
  beats: [
    { at: 333, marker: 'arrival' },
    { at: 650, marker: 'heart-appears' },
    { at: 1150, marker: 'arrow-pierces' },
    { at: 1500, marker: 'arrow-quivers' },
    { at: 2400, marker: 'hearts-rise' },
    { at: 4000, marker: 'cut' },
  ],
  audio: [
    { at: 950, sample: 'whoosh_low', gain: 0.3 },
    { at: 1150, sample: 'tick_land', gain: 0.3 },
    { at: 1400, sample: 'harp_sparkle', gain: 0.3 },
  ],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
const RECTS: [number, number, number, number][] = [
  [65, 267, 535, 128],
  [735, 141, 443, 377],
  [100, 759, 451, 353],
  [789, 757, 312, 329],
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
      src="heart_arrow"
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
      <g className="thr-heart_arrow__heart">
        <Tile tile={1} x={-75} y={-70} width={150} height={140} />
      </g>
      <g className="thr-heart_arrow__arrow">
        <Tile tile={0} x={-95} y={-25} width={190} height={50} />
      </g>
      <g className="thr-heart_arrow__mini0">
        <Tile tile={1} x={-15} y={-15} width={30} height={30} />
      </g>
      <g className="thr-heart_arrow__mini1">
        <Tile tile={1} x={-15} y={-15} width={30} height={30} />
      </g>
      <g className="thr-heart_arrow__mini2">
        <Tile tile={1} x={-15} y={-15} width={30} height={30} />
      </g>
      <g className="thr-heart_arrow__mini3">
        <Tile tile={1} x={-15} y={-15} width={30} height={30} />
      </g>
      <g className="thr-heart_arrow__mini4">
        <Tile tile={1} x={-15} y={-15} width={30} height={30} />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
