import { AvatarCopy } from '../AvatarCopy';
import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './bubble_boy.css';
export const spec: ThrowableSpec = {
  id: 'bubble_boy',
  name: 'Bubble Boy',
  tier: 'premium',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'land',
  payload: { sizeU: 1.5, anchor: 'face', coversAvatar: false, ms: 3667 },
  beats: [
    { at: 333, marker: 'arrival' },
    { at: 750, marker: 'bubble-seals' },
    { at: 2550, marker: 'avatar-floats' },
    { at: 3300, marker: 'bubble-pops' },
    { at: 3850, marker: 'avatar-settles' },
    { at: 4000, marker: 'cut' },
  ],
  audio: [
    { at: 750, sample: 'water_lap', gain: 0.25 },
    { at: 3300, sample: 'cork_pop', gain: 0.4 },
  ],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
const RECTS: [number, number, number, number][] = [
  [94, 85, 464, 458],
  [721, 139, 472, 381],
  [73, 679, 497, 501],
  [802, 791, 285, 289],
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
      src="bubble_boy"
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
function Payload({ targetAvatar }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-bubble_boy__avatar">
        <AvatarCopy snapshot={targetAvatar} />
      </g>
      <g className="thr-bubble_boy__bubble">
        <Tile tile={0} x={-85} y={-85} width={170} height={170} />
      </g>
      <g className="thr-bubble_boy__burst">
        <Tile tile={2} x={-105} y={-145} width={210} height={210} />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload, needsTargetAvatar: true };
