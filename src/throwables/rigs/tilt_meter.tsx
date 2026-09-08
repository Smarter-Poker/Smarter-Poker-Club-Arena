import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './tilt_meter.css';
export const spec: ThrowableSpec = {
  id: 'tilt_meter',
  name: 'Tilt Meter',
  tier: 'premium',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'land',
  payload: { sizeU: 1.5, anchor: 'face', coversAvatar: false, ms: 3667 },
  beats: [
    { at: 333, marker: 'arrival' },
    { at: 500, marker: 'meter-appears' },
    { at: 1000, marker: 'pressure-climbs' },
    { at: 1800, marker: 'redline' },
    { at: 2100, marker: 'burst-and-stamp' },
    { at: 4000, marker: 'cut' },
  ],
  audio: [
    { at: 600, sample: 'pressure_rise', gain: 0.3 },
    { at: 1900, sample: 'steam_hiss', gain: 0.35 },
    { at: 2100, sample: 'thump_soft', gain: 0.5 },
  ],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
const RECTS: [number, number, number, number][] = [
  [225, 23, 223, 573],
  [849, 64, 160, 502],
  [133, 675, 377, 546],
  [658, 808, 558, 257],
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
      src="tilt_meter"
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
      <g className="thr-tilt_meter__frame">
        <Tile tile={0} x={-30} y={-95} width={60} height={190} />
      </g>
      <g className="thr-tilt_meter__mercury">
        <Tile tile={1} x={-18} y={-83} width={36} height={170} />
      </g>
      <g className="thr-tilt_meter__steam">
        <Tile tile={2} x={-90} y={-115} width={180} height={125} />
      </g>
      <g className="thr-tilt_meter__stamp">
        <Tile tile={3} x={-75} y={-25} width={150} height={70} />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
