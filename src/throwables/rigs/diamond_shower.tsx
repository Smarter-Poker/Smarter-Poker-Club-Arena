import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './diamond_shower.css';
export const spec: ThrowableSpec = {
  id: 'diamond_shower',
  name: 'Diamond Shower',
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
    { at: 650, sample: 'chime_shimmer', gain: 0.25 },
    { at: 1300, sample: 'chime_shimmer', gain: 0.25 },
    { at: 1950, sample: 'chime_shimmer', gain: 0.25 },
    { at: 2600, sample: 'chime_shimmer', gain: 0.25 },
  ],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
const RECTS: [number, number, number, number][] = [
  [107, 138, 429, 364],
  [747, 140, 420, 365],
  [80, 791, 483, 333],
  [698, 720, 494, 370],
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
      src="diamond_shower"
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
      <g className="thr-diamond_shower__fall0">
        <Tile tile={0} x={-65} y={-130} width={30} height={30} />
      </g>
      <g className="thr-diamond_shower__fall1">
        <Tile tile={1} x={-28} y={-130} width={30} height={30} />
      </g>
      <g className="thr-diamond_shower__fall2">
        <Tile tile={0} x={9} y={-130} width={30} height={30} />
      </g>
      <g className="thr-diamond_shower__fall3">
        <Tile tile={1} x={46} y={-130} width={30} height={30} />
      </g>
      <g className="thr-diamond_shower__fall4">
        <Tile tile={0} x={-47} y={-130} width={30} height={30} />
      </g>
      <g className="thr-diamond_shower__fall5">
        <Tile tile={1} x={-10} y={-130} width={30} height={30} />
      </g>
      <g className="thr-diamond_shower__fall6">
        <Tile tile={0} x={27} y={-130} width={30} height={30} />
      </g>
      <g className="thr-diamond_shower__fall7">
        <Tile tile={1} x={64} y={-130} width={30} height={30} />
      </g>
      <g className="thr-diamond_shower__fall8">
        <Tile tile={0} x={-29} y={-130} width={30} height={30} />
      </g>
      <g className="thr-diamond_shower__fall9">
        <Tile tile={1} x={8} y={-130} width={30} height={30} />
      </g>
      <g className="thr-diamond_shower__fall10">
        <Tile tile={0} x={45} y={-130} width={30} height={30} />
      </g>
      <g className="thr-diamond_shower__fall11">
        <Tile tile={1} x={-48} y={-130} width={30} height={30} />
      </g>
      <g className="thr-diamond_shower__fall12">
        <Tile tile={0} x={-11} y={-130} width={30} height={30} />
      </g>
      <g className="thr-diamond_shower__fall13">
        <Tile tile={1} x={26} y={-130} width={30} height={30} />
      </g>
      <g className="thr-diamond_shower__fall14">
        <Tile tile={0} x={63} y={-130} width={30} height={30} />
      </g>
      <g className="thr-diamond_shower__fall15">
        <Tile tile={1} x={-30} y={-130} width={30} height={30} />
      </g>
      <g className="thr-diamond_shower__fall16">
        <Tile tile={0} x={7} y={-130} width={30} height={30} />
      </g>
      <g className="thr-diamond_shower__fall17">
        <Tile tile={1} x={44} y={-130} width={30} height={30} />
      </g>
      <g className="thr-diamond_shower__fall18">
        <Tile tile={0} x={-49} y={-130} width={30} height={30} />
      </g>
      <g className="thr-diamond_shower__fall19">
        <Tile tile={1} x={-12} y={-130} width={30} height={30} />
      </g>
      <g className="thr-diamond_shower__pile0">
        <Tile tile={2} x={-65} y={36} width={65} height={55} />
      </g>
      <g className="thr-diamond_shower__pile1">
        <Tile tile={2} x={-30} y={36} width={65} height={55} />
      </g>
      <g className="thr-diamond_shower__pile2">
        <Tile tile={2} x={5} y={36} width={65} height={55} />
      </g>
      <g className="thr-diamond_shower__tiara">
        <Tile tile={3} x={-60} y={-76} width={120} height={70} />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
