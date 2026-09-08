import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './whale.css';
export const spec: ThrowableSpec = {
  id: 'whale',
  name: 'Whale',
  tier: 'vip',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'land',
  payload: { sizeU: 1.5, anchor: 'face', coversAvatar: false, ms: 3667 },
  beats: [
    { at: 333, marker: 'arrival' },
    { at: 600, marker: 'water-forms' },
    { at: 800, marker: 'whale-surfaces' },
    { at: 1450, marker: 'fountain' },
    { at: 2400, marker: 'spray-ends' },
    { at: 3000, marker: 'dive' },
    { at: 4000, marker: 'cut' },
  ],
  audio: [
    { at: 600, sample: 'water_lap', gain: 0.3 },
    { at: 800, sample: 'whale_call', gain: 0.5 },
    { at: 1200, sample: 'squirt_start', gain: 0.35 },
    { at: 2800, sample: 'splat_wet_small', gain: 0.4 },
  ],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
const RECTS: [number, number, number, number][] = [
  [40, 181, 649, 400],
  [853, 36, 327, 582],
  [58, 705, 523, 508],
  [694, 1011, 495, 149],
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
      src="whale"
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
      <g className="thr-whale__water">
        <Tile tile={3} x={-100} y={40} width={200} height={45} />
      </g>
      <g className="thr-whale__surface">
        <Tile tile={0} x={-80} y={-10} width={160} height={100} />
      </g>
      <g className="thr-whale__dive">
        <Tile tile={1} x={-80} y={-10} width={160} height={100} />
      </g>
      <g className="thr-whale__spray">
        <Tile tile={2} x={-75} y={-90} width={150} height={135} />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
