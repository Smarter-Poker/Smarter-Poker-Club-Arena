import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './velvet_rope.css';
export const spec: ThrowableSpec = {
  id: 'velvet_rope',
  name: 'Velvet Rope',
  tier: 'vip',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'land',
  payload: { sizeU: 1.5, anchor: 'face', coversAvatar: false, ms: 3667 },
  beats: [
    { at: 333, marker: 'arrival' },
    { at: 550, marker: 'posts-rise' },
    { at: 850, marker: 'rope-drops' },
    { at: 1250, marker: 'sign-swings' },
    { at: 3400, marker: 'rope-lifts' },
    { at: 4000, marker: 'cut' },
  ],
  audio: [
    { at: 850, sample: 'lid_clank', gain: 0.25 },
    { at: 1000, sample: 'tick_settle', gain: 0.3 },
  ],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
const RECTS: [number, number, number, number][] = [
  [198, 37, 225, 547],
  [685, 158, 512, 306],
  [81, 705, 468, 462],
  [767, 762, 364, 366],
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
      src="velvet_rope"
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
      <g className="thr-velvet_rope__post0">
        <Tile tile={0} x={-90} y={-80} width={35} height={165} />
      </g>
      <g className="thr-velvet_rope__post1">
        <Tile tile={0} x={55} y={-80} width={35} height={165} />
      </g>
      <g className="thr-velvet_rope__rope">
        <Tile tile={1} x={-77} y={-15} width={154} height={75} />
      </g>
      <g className="thr-velvet_rope__sign">
        <Tile tile={2} x={-52} y={4} width={104} height={75} />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
