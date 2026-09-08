import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './donkey.css';
export const spec: ThrowableSpec = {
  id: 'donkey',
  name: 'Donkey',
  tier: 'premium',
  category: 'characters',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 1.5, anchor: 'face', coversAvatar: false, ms: 4034 },
  beats: [
    { at: 333, marker: 'arrival' },
    { at: 433, marker: 'pop' },
    { at: 1534, marker: 'inhale' },
    { at: 2001, marker: 'bray' },
    { at: 3134, marker: 'relax' },
    { at: 4367, marker: 'cut' },
  ],
  audio: [
    { at: 433, sample: 'thump_soft', gain: 0.3 },
    { at: 1533, sample: 'donkey_bray', gain: 0.65 },
  ],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
const RECTS: [number, number, number, number][] = [
  [182, 10, 264, 459],
  [809, 10, 264, 470],
  [182, 637, 264, 501],
  [813, 636, 256, 462],
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
      src="donkey"
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
      <g className="thr-donkey__idle">
        <Tile tile={0} x={-75} y={-100} width={150} height={200} />
      </g>
      <g className="thr-donkey__inhale">
        <Tile tile={1} x={-75} y={-100} width={150} height={200} />
      </g>
      <g className="thr-donkey__bray">
        <Tile tile={2} x={-75} y={-100} width={150} height={200} />
      </g>
      <g className="thr-donkey__relax">
        <Tile tile={3} x={-75} y={-100} width={150} height={200} />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
