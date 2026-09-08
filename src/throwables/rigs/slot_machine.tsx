import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './slot_machine.css';
export const spec: ThrowableSpec = {
  id: 'slot_machine',
  name: 'Slot Machine',
  tier: 'premium',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'land',
  payload: { sizeU: 1.5, anchor: 'face', coversAvatar: false, ms: 4167 },
  beats: [
    { at: 333, marker: 'arrival' },
    { at: 650, marker: 'cabinet-arrives' },
    { at: 900, marker: 'lever-pulled' },
    { at: 1500, marker: 'reels-spin' },
    { at: 2700, marker: 'jackpot' },
    { at: 3200, marker: 'coins-spill' },
    { at: 4500, marker: 'cut' },
  ],
  audio: [
    { at: 900, sample: 'reel_spin_loop', gain: 0.55 },
    { at: 900, sample: 'lid_clank', gain: 0.3 },
    { at: 2700, sample: 'fanfare_short', gain: 0.4 },
    { at: 3100, sample: 'chip_clatter', gain: 0.4 },
  ],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
const RECTS: [number, number, number, number][] = [
  [92, 42, 510, 575],
  [812, 130, 233, 145],
  [126, 741, 387, 400],
  [694, 672, 493, 495],
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
      src="slot_machine"
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
      <g className="thr-slot_machine__cabinet">
        <Tile tile={0} x={-90} y={-105} width={180} height={210} />
      </g>
      <g className="thr-slot_machine__reel0">
        <Tile tile={1} x={-52} y={-25} width={32} height={50} />
      </g>
      <g className="thr-slot_machine__reel1">
        <Tile tile={1} x={-18} y={-25} width={32} height={50} />
      </g>
      <g className="thr-slot_machine__reel2">
        <Tile tile={1} x={16} y={-25} width={32} height={50} />
      </g>
      <g className="thr-slot_machine__coins0">
        <Tile tile={2} x={-18} y={10} width={36} height={36} />
      </g>
      <g className="thr-slot_machine__coins1">
        <Tile tile={2} x={-18} y={10} width={36} height={36} />
      </g>
      <g className="thr-slot_machine__coins2">
        <Tile tile={2} x={-18} y={10} width={36} height={36} />
      </g>
      <g className="thr-slot_machine__coins3">
        <Tile tile={2} x={-18} y={10} width={36} height={36} />
      </g>
      <g className="thr-slot_machine__coins4">
        <Tile tile={2} x={-18} y={10} width={36} height={36} />
      </g>
      <g className="thr-slot_machine__coins5">
        <Tile tile={2} x={-18} y={10} width={36} height={36} />
      </g>
      <g className="thr-slot_machine__coins6">
        <Tile tile={2} x={-18} y={10} width={36} height={36} />
      </g>
      <g className="thr-slot_machine__coins7">
        <Tile tile={2} x={-18} y={10} width={36} height={36} />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
