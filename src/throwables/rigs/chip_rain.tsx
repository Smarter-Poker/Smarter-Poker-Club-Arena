import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './chip_rain.css';
export const spec: ThrowableSpec = {
  id: 'chip_rain',
  name: 'Chip Rain',
  tier: 'vip',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'land',
  payload: { sizeU: 1.5, anchor: 'face', coversAvatar: false, ms: 3667 },
  beats: [
    { at: 333, marker: 'arrival' },
    { at: 500, marker: 'rain-start' },
    { at: 1400, marker: 'first-pile' },
    { at: 2400, marker: 'last-fall' },
    { at: 3200, marker: 'final-pose' },
    { at: 4000, marker: 'cut' },
  ],
  audio: [
    { at: 650, sample: 'chip_clatter', gain: 0.25 },
    { at: 1300, sample: 'chip_clatter', gain: 0.25 },
    { at: 1950, sample: 'chip_clatter', gain: 0.25 },
    { at: 2600, sample: 'chip_clatter', gain: 0.25 },
  ],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
const RECTS: [number, number, number, number][] = [
  [118, 94, 427, 423],
  [762, 107, 371, 410],
  [163, 737, 350, 381],
  [828, 811, 236, 260],
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
      src="chip_rain"
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
      <g className="thr-chip_rain__fall0">
        <Tile tile={0} x={-65} y={-130} width={30} height={30} />
      </g>
      <g className="thr-chip_rain__fall1">
        <Tile tile={1} x={-28} y={-130} width={30} height={30} />
      </g>
      <g className="thr-chip_rain__fall2">
        <Tile tile={0} x={9} y={-130} width={30} height={30} />
      </g>
      <g className="thr-chip_rain__fall3">
        <Tile tile={1} x={46} y={-130} width={30} height={30} />
      </g>
      <g className="thr-chip_rain__fall4">
        <Tile tile={0} x={-47} y={-130} width={30} height={30} />
      </g>
      <g className="thr-chip_rain__fall5">
        <Tile tile={1} x={-10} y={-130} width={30} height={30} />
      </g>
      <g className="thr-chip_rain__fall6">
        <Tile tile={0} x={27} y={-130} width={30} height={30} />
      </g>
      <g className="thr-chip_rain__fall7">
        <Tile tile={1} x={64} y={-130} width={30} height={30} />
      </g>
      <g className="thr-chip_rain__fall8">
        <Tile tile={0} x={-29} y={-130} width={30} height={30} />
      </g>
      <g className="thr-chip_rain__fall9">
        <Tile tile={1} x={8} y={-130} width={30} height={30} />
      </g>
      <g className="thr-chip_rain__fall10">
        <Tile tile={0} x={45} y={-130} width={30} height={30} />
      </g>
      <g className="thr-chip_rain__fall11">
        <Tile tile={1} x={-48} y={-130} width={30} height={30} />
      </g>
      <g className="thr-chip_rain__fall12">
        <Tile tile={0} x={-11} y={-130} width={30} height={30} />
      </g>
      <g className="thr-chip_rain__fall13">
        <Tile tile={1} x={26} y={-130} width={30} height={30} />
      </g>
      <g className="thr-chip_rain__fall14">
        <Tile tile={0} x={63} y={-130} width={30} height={30} />
      </g>
      <g className="thr-chip_rain__fall15">
        <Tile tile={1} x={-30} y={-130} width={30} height={30} />
      </g>
      <g className="thr-chip_rain__fall16">
        <Tile tile={0} x={7} y={-130} width={30} height={30} />
      </g>
      <g className="thr-chip_rain__fall17">
        <Tile tile={1} x={44} y={-130} width={30} height={30} />
      </g>
      <g className="thr-chip_rain__fall18">
        <Tile tile={0} x={-49} y={-130} width={30} height={30} />
      </g>
      <g className="thr-chip_rain__fall19">
        <Tile tile={1} x={-12} y={-130} width={30} height={30} />
      </g>
      <g className="thr-chip_rain__pile0">
        <Tile tile={2} x={-65} y={36} width={65} height={55} />
      </g>
      <g className="thr-chip_rain__pile1">
        <Tile tile={2} x={-30} y={36} width={65} height={55} />
      </g>
      <g className="thr-chip_rain__pile2">
        <Tile tile={2} x={5} y={36} width={65} height={55} />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
