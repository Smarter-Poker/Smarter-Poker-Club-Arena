import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './party_popper.css';
export const spec: ThrowableSpec = {
  id: 'party_popper',
  name: 'Party Popper',
  tier: 'premium',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'land',
  payload: { sizeU: 1.5, anchor: 'face', coversAvatar: false, ms: 3667 },
  beats: [
    { at: 333, marker: 'arrival' },
    { at: 700, marker: 'pop' },
    { at: 1100, marker: 'confetti-burst' },
    { at: 2200, marker: 'ribbons-fall' },
    { at: 3500, marker: 'confetti-clears' },
    { at: 4000, marker: 'cut' },
  ],
  audio: [
    { at: 700, sample: 'cork_pop', gain: 0.45 },
    { at: 900, sample: 'chime_shimmer', gain: 0.3 },
  ],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
const RECTS: [number, number, number, number][] = [
  [127, 84, 459, 486],
  [759, 145, 397, 388],
  [185, 674, 367, 495],
  [734, 689, 418, 443],
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
      src="party_popper"
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
      <g className="thr-party_popper__cone">
        <Tile tile={0} x={-65} y={-20} width={130} height={130} />
      </g>
      <g className="thr-party_popper__flash">
        <Tile tile={3} x={-80} y={-110} width={160} height={160} />
      </g>
      <g className="thr-party_popper__confetti0">
        <Tile tile={1} x={-20} y={-20} width={40} height={40} />
      </g>
      <g className="thr-party_popper__confetti1">
        <Tile tile={2} x={-20} y={-20} width={40} height={40} />
      </g>
      <g className="thr-party_popper__confetti2">
        <Tile tile={1} x={-20} y={-20} width={40} height={40} />
      </g>
      <g className="thr-party_popper__confetti3">
        <Tile tile={2} x={-20} y={-20} width={40} height={40} />
      </g>
      <g className="thr-party_popper__confetti4">
        <Tile tile={1} x={-20} y={-20} width={40} height={40} />
      </g>
      <g className="thr-party_popper__confetti5">
        <Tile tile={2} x={-20} y={-20} width={40} height={40} />
      </g>
      <g className="thr-party_popper__confetti6">
        <Tile tile={1} x={-20} y={-20} width={40} height={40} />
      </g>
      <g className="thr-party_popper__confetti7">
        <Tile tile={2} x={-20} y={-20} width={40} height={40} />
      </g>
      <g className="thr-party_popper__confetti8">
        <Tile tile={1} x={-20} y={-20} width={40} height={40} />
      </g>
      <g className="thr-party_popper__confetti9">
        <Tile tile={2} x={-20} y={-20} width={40} height={40} />
      </g>
      <g className="thr-party_popper__confetti10">
        <Tile tile={1} x={-20} y={-20} width={40} height={40} />
      </g>
      <g className="thr-party_popper__confetti11">
        <Tile tile={2} x={-20} y={-20} width={40} height={40} />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
