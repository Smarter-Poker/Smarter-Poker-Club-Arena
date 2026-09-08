import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './screaming.css';
// Dedicated recorded cues still pending: scream_short, scream_long.
export const spec: ThrowableSpec = {
  id: 'screaming',
  name: 'Screaming',
  tier: 'free',
  category: 'emoticons',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 1.05, anchor: 'face', coversAvatar: true, ms: 3667 },
  beats: [
    { at: 433, marker: 'pop' },
    { at: 600, marker: 'eyes-grow' },
    { at: 900, marker: 'scream' },
    { at: 1200, marker: 'sweat' },
    { at: 2000, marker: 'shake' },
    { at: 3000, marker: 'sweat-stops' },
    { at: 3400, marker: 'jaw-drop' },
    { at: 3550, marker: 'jaw-extended' },
    { at: 4000, marker: 'cut' },
  ],
  audio: [{ at: 433, sample: 'pop_soft', gain: 0.3 }],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
const RECTS: [number, number, number, number][] = [
  [0, 0, 627, 627],
  [627, 0, 627, 627],
  [0, 627, 627, 627],
  [627, 627, 627, 627],
];
function Tile({
  tile,
  x = -65,
  y = -65,
  width = 130,
  height = 130,
}: {
  tile: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}) {
  return (
    <AtlasSprite
      src="screaming"
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
      <Tile tile={0} />
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-screaming__pop">
        <g className="thr-screaming__shake">
          <g className="thr-screaming__base">
            <Tile tile={0} x={-65} y={-65} width={130} height={130} />
          </g>
          <g className="thr-screaming__scream-end">
            <g className="thr-screaming__scream">
              <Tile tile={1} x={-65} y={-65} width={130} height={130} />
            </g>
          </g>
          <g className="thr-screaming__jaw">
            <g className="thr-screaming__jaw-fall">
              <Tile tile={2} x={-65} y={-65} width={130} height={160} />
            </g>
          </g>
        </g>
        <g className="thr-screaming__sweat">
          <Tile tile={3} x={32} y={-45} width={40} height={40} />
        </g>
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
