import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './standing_ovation.css';
export const spec: ThrowableSpec = {
  id: 'standing_ovation',
  name: 'Standing Ovation',
  tier: 'vip',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'land',
  payload: { sizeU: 1.5, anchor: 'face', coversAvatar: false, ms: 4167 },
  beats: [
    { at: 333, marker: 'arrival' },
    { at: 550, marker: 'hands-appear' },
    { at: 1070, marker: 'clap' },
    { at: 1800, marker: 'first-rose' },
    { at: 2400, marker: 'second-rose' },
    { at: 4500, marker: 'cut' },
  ],
  audio: [
    { at: 550, sample: 'applause_bed', gain: 0.65 },
    { at: 550, sample: 'fanfare_short', gain: 0.3 },
    { at: 1800, sample: 'harp_sparkle', gain: 0.25 },
  ],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
const RECTS: [number, number, number, number][] = [
  [108, 59, 451, 527],
  [696, 63, 480, 512],
  [112, 659, 470, 548],
  [734, 657, 409, 537],
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
      src="standing_ovation"
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
      <g className="thr-standing_ovation__rose0">
        <Tile tile={2} x={-57} y={5} width={50} height={80} />
      </g>
      <g className="thr-standing_ovation__rose1">
        <Tile tile={2} x={15} y={5} width={50} height={80} />
      </g>
      <g className="thr-standing_ovation__spotlight">
        <Tile tile={3} x={-125} y={-145} width={250} height={280} />
      </g>
      <g className="thr-standing_ovation__open0">
        <Tile tile={1} x={73} y={-25} width={44} height={55} />
      </g>
      <g className="thr-standing_ovation__closed0">
        <Tile tile={0} x={73} y={-25} width={44} height={55} />
      </g>
      <g className="thr-standing_ovation__open1">
        <Tile tile={1} x={45} y={35} width={44} height={55} />
      </g>
      <g className="thr-standing_ovation__closed1">
        <Tile tile={0} x={45} y={35} width={44} height={55} />
      </g>
      <g className="thr-standing_ovation__open2">
        <Tile tile={1} x={-22} y={60} width={44} height={55} />
      </g>
      <g className="thr-standing_ovation__closed2">
        <Tile tile={0} x={-22} y={60} width={44} height={55} />
      </g>
      <g className="thr-standing_ovation__open3">
        <Tile tile={1} x={-89} y={35} width={44} height={55} />
      </g>
      <g className="thr-standing_ovation__closed3">
        <Tile tile={0} x={-89} y={35} width={44} height={55} />
      </g>
      <g className="thr-standing_ovation__open4">
        <Tile tile={1} x={-117} y={-25} width={44} height={55} />
      </g>
      <g className="thr-standing_ovation__closed4">
        <Tile tile={0} x={-117} y={-25} width={44} height={55} />
      </g>
      <g className="thr-standing_ovation__open5">
        <Tile tile={1} x={-89} y={-85} width={44} height={55} />
      </g>
      <g className="thr-standing_ovation__closed5">
        <Tile tile={0} x={-89} y={-85} width={44} height={55} />
      </g>
      <g className="thr-standing_ovation__open6">
        <Tile tile={1} x={-22} y={-110} width={44} height={55} />
      </g>
      <g className="thr-standing_ovation__closed6">
        <Tile tile={0} x={-22} y={-110} width={44} height={55} />
      </g>
      <g className="thr-standing_ovation__open7">
        <Tile tile={1} x={45} y={-85} width={44} height={55} />
      </g>
      <g className="thr-standing_ovation__closed7">
        <Tile tile={0} x={45} y={-85} width={44} height={55} />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
