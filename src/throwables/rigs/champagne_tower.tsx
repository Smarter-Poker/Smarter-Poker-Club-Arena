import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './champagne_tower.css';
export const spec: ThrowableSpec = {
  id: 'champagne_tower',
  name: 'Champagne Tower',
  tier: 'vip',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'land',
  payload: { sizeU: 1.5, anchor: 'face', coversAvatar: false, ms: 4167 },
  beats: [
    { at: 333, marker: 'arrival' },
    { at: 900, marker: 'pyramid-grown' },
    { at: 1100, marker: 'pour-start' },
    { at: 1500, marker: 'top-filled' },
    { at: 2100, marker: 'middle-filled' },
    { at: 2700, marker: 'bottom-filled' },
    { at: 4500, marker: 'cut' },
  ],
  audio: [
    { at: 1000, sample: 'cork_pop', gain: 0.3 },
    { at: 1300, sample: 'fizz_loop', gain: 0.2 },
    { at: 1900, sample: 'fizz_loop', gain: 0.2 },
    { at: 2500, sample: 'fizz_loop', gain: 0.2 },
  ],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
const RECTS: [number, number, number, number][] = [
  [145, 103, 396, 465],
  [723, 102, 396, 466],
  [137, 680, 480, 374],
  [773, 687, 291, 479],
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
      src="champagne_tower"
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
      <g className="thr-champagne_tower__glass0">
        <Tile tile={0} x={-18} y={-100} width={40} height={60} />
      </g>
      <g className="thr-champagne_tower__filled0">
        <Tile tile={1} x={-18} y={-100} width={40} height={60} />
      </g>
      <g className="thr-champagne_tower__glass1">
        <Tile tile={0} x={-36} y={-60} width={40} height={60} />
      </g>
      <g className="thr-champagne_tower__filled1">
        <Tile tile={1} x={-36} y={-60} width={40} height={60} />
      </g>
      <g className="thr-champagne_tower__glass2">
        <Tile tile={0} x={0} y={-60} width={40} height={60} />
      </g>
      <g className="thr-champagne_tower__filled2">
        <Tile tile={1} x={0} y={-60} width={40} height={60} />
      </g>
      <g className="thr-champagne_tower__glass3">
        <Tile tile={0} x={-54} y={-20} width={40} height={60} />
      </g>
      <g className="thr-champagne_tower__filled3">
        <Tile tile={1} x={-54} y={-20} width={40} height={60} />
      </g>
      <g className="thr-champagne_tower__glass4">
        <Tile tile={0} x={-18} y={-20} width={40} height={60} />
      </g>
      <g className="thr-champagne_tower__filled4">
        <Tile tile={1} x={-18} y={-20} width={40} height={60} />
      </g>
      <g className="thr-champagne_tower__glass5">
        <Tile tile={0} x={18} y={-20} width={40} height={60} />
      </g>
      <g className="thr-champagne_tower__filled5">
        <Tile tile={1} x={18} y={-20} width={40} height={60} />
      </g>
      <g className="thr-champagne_tower__bottle">
        <Tile tile={2} x={15} y={-144} width={85} height={75} />
      </g>
      <g className="thr-champagne_tower__pour">
        <Tile tile={3} x={-13} y={-113} width={25} height={70} />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
